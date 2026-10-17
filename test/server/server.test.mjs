import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import WebSocket from "ws";
import { LocalizedError, msg } from "../../src/i18n/index.mjs";
import { startServer, WS_PATH } from "../../src/server/server.mjs";

const ogg = (payload) => Buffer.concat([Buffer.from("OggS"), Buffer.from(payload)]);
const silentLog = { info() {}, warn() {}, error() {} };

let server;
const sockets = [];
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await server?.close();
  server = undefined;
});

async function start(refiner) {
  server = await startServer({ port: 0, refiner, log: silentLog });
  return server.port;
}

/** 连上服务端，返回一个能"发一条、等一条"的小客户端 */
async function connect(port, { path = WS_PATH, origin } = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, origin ? { origin } : {});
  sockets.push(socket);
  const inbox = [];
  const waiters = [];
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString("utf8"));
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  await once(socket, "open");
  return {
    sendJson: (value) => socket.send(JSON.stringify(value)),
    sendBinary: (buffer) => socket.send(buffer),
    next: () => (inbox.length ? Promise.resolve(inbox.shift()) : new Promise((resolve) => waiters.push(resolve))),
  };
}

async function sendChunk(client, audioId, index, buffer) {
  client.sendJson({ type: "set_audio_chunk_info", audio_id: audioId, index, size: buffer.length, duration: 3 });
  client.sendBinary(buffer);
  return client.next();
}

test("一次完整的听写：消息顺序和成品字段与抓包一致；整理时带上是哪一次录音，记账要用", async () => {
  const received = [];
  const port = await start({
    async refine(audio, { mimeType, audioId }) {
      received.push({ audio, mimeType, audioId });
      return "整理好的文字";
    },
  });
  const client = await connect(port, { path: `${WS_PATH}?v=clone_0.1.0&m=0` });
  const chunks = [ogg("first-chunk"), ogg("second")];

  client.sendJson({ type: "start_audio", audio_id: "a1", audio_chunk_time: 3, mode: "voice_transcript" });
  const started = await client.next();
  assert.equal(started.K, "audio_session_started");
  assert.equal(started.V.audio_id, "a1");
  assert.equal(typeof started.V.start_time, "number");

  for (const [i, chunk] of chunks.entries()) {
    const ack = await sendChunk(client, "a1", i + 1, chunk);
    assert.equal(ack.K, "received_audio_chunk_count");
    assert.equal(ack.V.index, i + 1);
    assert.equal(ack.V.size, chunk.length);
    assert.equal(typeof ack.V.server_t, "number");
  }

  client.sendJson({ type: "end_audio", audio_id: "a1", total_duration: 5.1 });
  const ending = await client.next();
  assert.deepEqual(ending, {
    K: "audio_session_ending",
    V: { audio_id: "a1", total_chunks: 2, completed_chunks: 2, failed_chunks: 0 },
    T: "json",
    M: false,
    S: "done",
  });
  const completed = await client.next();
  assert.deepEqual(completed.V, {
    audio_id: "a1",
    refined_text: "整理好的文字",
    status: true,
    run_index: 1,
    web_metadata: null,
    delivery: null,
    action: null,
    user_prompt: null,
    external_action: null,
  });
  assert.equal(completed.K, "audio_processing_completed");

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], { audio: Buffer.concat(chunks), mimeType: "audio/ogg", audioId: "a1" });
});

test("同一条连接上可以接着做第二次听写", async () => {
  const port = await start({ refine: async (audio) => `共 ${audio.length} 字节` });
  const client = await connect(port);
  for (const audioId of ["a1", "a2"]) {
    client.sendJson({ type: "start_audio", audio_id: audioId });
    await client.next();
    await sendChunk(client, audioId, 1, ogg(audioId));
    client.sendJson({ type: "end_audio", audio_id: audioId });
    await client.next();
    const completed = await client.next();
    assert.equal(completed.V.audio_id, audioId);
    assert.equal(completed.V.refined_text, "共 6 字节");
  }
});

test("整理失败时回 audio_processing_error，连接不断", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      if (calls === 1) throw new Error("上游 503");
      return "第二次成功";
    },
  });
  const client = await connect(port);

  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  await sendChunk(client, "a1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  await client.next();
  const failed = await client.next();
  assert.equal(failed.K, "audio_processing_error");
  assert.equal(failed.V.audio_id, "a1");
  assert.equal(failed.V.code, "refine_failed");
  assert.match(failed.V.detail, /上游 503/);
  // 说不清的错误不带 problem，悬浮条就用 detail
  assert.equal(failed.V.problem, undefined);

  client.sendJson({ type: "start_audio", audio_id: "a2" });
  await client.next();
  await sendChunk(client, "a2", 1, ogg("y"));
  client.sendJson({ type: "end_audio", audio_id: "a2" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "第二次成功");
});

test("一块音频都没有就结束：不去调模型，回 no_audio", async () => {
  let calls = 0;
  const port = await start({
    async refine() {
      calls += 1;
      return "不该走到这里";
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  const failed = await client.next();
  assert.equal(failed.K, "audio_processing_error");
  assert.equal(failed.V.code, "no_audio");
  assert.deepEqual(failed.V.problem, msg("voice.noAudio"));
  assert.equal(calls, 0);
});

test("整理失败时带上给人看的那句话（problem），由悬浮条按界面语言翻；原话照旧在 detail 里", async () => {
  const problem = msg("model.unreachable", { provider: "Gemini" });
  const port = await start({
    async refine() {
      throw new LocalizedError(problem);
    },
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  await sendChunk(client, "a1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "a1" });
  await client.next();
  const failed = await client.next();
  assert.equal(failed.V.code, "refine_failed");
  assert.deepEqual(failed.V.problem, problem);
  assert.equal(failed.V.detail, "Can't reach Gemini. Check your network");
});

test("顺序不对的消息回 error，并说明原因", async () => {
  const port = await start({ refine: async () => "" });
  const client = await connect(port);

  client.sendBinary(ogg("x"));
  assert.deepEqual((await client.next()).V.code, "no_session");

  client.sendJson({ type: "end_audio", audio_id: "a1" });
  assert.equal((await client.next()).V.code, "no_session");

  client.sendJson({ type: "start_audio", audio_id: "a1" });
  await client.next();
  client.sendJson({ type: "set_audio_chunk_info", audio_id: "别的", index: 1, size: 5 });
  const mismatch = await client.next();
  assert.equal(mismatch.K, "error");
  assert.equal(mismatch.V.code, "audio_id_mismatch");

  client.sendJson({ type: "不存在的类型" });
  assert.equal((await client.next()).V.code, "unknown_type");
});

test("网页发起的连接和别的路径都拒绝", async () => {
  const port = await start({ refine: async () => "" });
  for (const options of [{ origin: "https://evil.example" }, { path: "/other" }]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}${options.path ?? WS_PATH}`, {
      origin: options.origin,
    });
    sockets.push(socket);
    const [error] = await once(socket, "error");
    assert.match(error.message, /Unexpected server response: 4\d\d/);
  }
  // Electron 渲染进程从本地文件发起连接时，Origin 是 file://
  await connect(port, { origin: "file://" });
});

test("一开始录音就让模型那边先备好（Gemini 建提示词缓存），不等它；备不好不影响这次听写", async () => {
  let prepared = 0;
  const port = await start({
    async prepare() {
      prepared++;
      throw new Error("建缓存失败");
    },
    refine: async () => "整理好的文字",
  });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "p1" });
  assert.equal((await client.next()).K, "audio_session_started");
  assert.equal(prepared, 1);
  await sendChunk(client, "p1", 1, ogg("x"));
  client.sendJson({ type: "end_audio", audio_id: "p1" });
  await client.next();
  assert.equal((await client.next()).V.refined_text, "整理好的文字");
});

test("整理的那一步不做准备（没有 prepare）也照常听写", async () => {
  const port = await start({ refine: async () => "文字" });
  const client = await connect(port);
  client.sendJson({ type: "start_audio", audio_id: "p2" });
  assert.equal((await client.next()).K, "audio_session_started");
});
