// 客户端的通信模块直接对着真的服务端模块跑（模型那一步换成假的），
// 这样两端对协议的理解有出入时，这里会先红。
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createTranslator, LocalizedError, msg } from "../../../src/i18n/index.mjs";
import { VoiceSocket } from "../../../src/renderer/bar/voice-socket.mjs";
import { startServer, WS_PATH } from "../../../src/server/server.mjs";

const zh = createTranslator("zh-CN");
const en = createTranslator("en");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

const silentLog = { info() {}, warn() {}, error() {} };
const webm = (payload) => new Blob([Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), payload]);

let server;
let voice;
afterEach(async () => {
  voice?.close();
  await server?.close();
  server = undefined;
});

async function start(refine) {
  server = await startServer({ port: 0, refiner: { refine }, log: silentLog });
  voice = new VoiceSocket(`ws://127.0.0.1:${server.port}${WS_PATH}`);
  return voice;
}

test("开始、按序发块、结束，拿到成品；服务端收到的是各块首尾相接", async () => {
  let received;
  const socket = await start(async (audio, { mimeType }) => {
    received = { text: audio.toString("latin1"), mimeType };
    return "成品";
  });
  await socket.begin("a1");
  // 第一块故意大一些：取字节数更慢，不排队的话第二块会抢到前面
  socket.sendChunk(webm("A".repeat(200_000)));
  socket.sendChunk(new Blob(["BBB"]));
  assert.equal(await socket.finish({ durationSeconds: 4.2 }), "成品");
  assert.equal(received.mimeType, "audio/webm");
  assert.ok(received.text.endsWith(`${"A".repeat(10)}BBB`));
});

test("同一条连接上连着做两次", async () => {
  const socket = await start(async (audio) => `${audio.length}`);
  for (const audioId of ["a1", "a2"]) {
    await socket.begin(audioId);
    socket.sendChunk(webm("xy"));
    assert.equal(await socket.finish({ durationSeconds: 1 }), "6");
  }
});

test("服务端整理失败时，finish 抛出带原因的错误", async () => {
  const socket = await start(async () => {
    throw new Error("上游 503");
  });
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  await assert.rejects(socket.finish({ durationSeconds: 1 }), said(/refine_failed.*上游 503/));
});

test("模型那边说得清的原因（problem）原样带过来，悬浮条按界面语言翻", async () => {
  const socket = await start(async () => {
    throw new LocalizedError(msg("model.unreachable", { provider: "Gemini" }));
  });
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const error = await socket.finish({ durationSeconds: 1 }).catch((thrown) => thrown);
  assert.equal(en.text(error.problem), "Can't reach Gemini. Check your network");
  assert.equal(zh.text(error.problem), "连不上 Gemini，检查网络后再试");
});

test("服务端不认的录音格式，在 finish 时报出来", async () => {
  const socket = await start(async () => "不该走到这里");
  await socket.begin("a1");
  socket.sendChunk(new Blob(["RIFF...."]));
  await assert.rejects(socket.finish({ durationSeconds: 1 }), said(/unsupported_audio/));
});

test("等成品超时", async () => {
  const socket = await start(() => new Promise(() => {}));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  await assert.rejects(socket.finish({ durationSeconds: 1, timeoutMs: 50 }), said(/没有等到成品/));
});

test("等成品时连接断了", async () => {
  const socket = await start(() => new Promise(() => {}));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const pending = socket.finish({ durationSeconds: 1 });
  const running = server;
  server = undefined; // 这里自己关，收尾时不要再关一次
  setTimeout(() => running.close(), 20);
  await assert.rejects(pending, said(/连接断了/));
});

test("服务端没开时，begin 直接报连不上", async () => {
  const socket = await start(async () => "");
  await server.close();
  server = undefined;
  await assert.rejects(socket.begin("a1"), said(/连不上服务端/));
});

test("放弃一次录音后，它迟到的成品不会算到下一次头上", async () => {
  const releases = [];
  const socket = await start((audio) => new Promise((resolve) => releases.push(() => resolve(`${audio.length}`))));
  await socket.begin("a1");
  socket.sendChunk(webm("x"));
  const first = socket.finish({ durationSeconds: 1, timeoutMs: 60 });
  await assert.rejects(first, said(/没有等到成品/));

  await socket.begin("a2");
  socket.sendChunk(webm("xyz"));
  const second = socket.finish({ durationSeconds: 1 });
  // 等两次整理都进到服务端，再先放行第一次（迟到的那个）
  while (releases.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  releases[0]();
  await new Promise((resolve) => setTimeout(resolve, 20));
  releases[1]();
  assert.equal(await second, "7");
});
