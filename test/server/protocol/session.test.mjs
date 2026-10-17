import assert from "node:assert/strict";
import { test } from "node:test";
import { ProtocolError } from "../../../src/server/protocol/protocol.mjs";
import { RecordingSession } from "../../../src/server/protocol/session.mjs";

const ogg = (payload) => Buffer.concat([Buffer.from("OggS"), Buffer.from(payload)]);
const newSession = (maxTotalBytes = 1024) => new RecordingSession("audio-1", { maxTotalBytes });
const fails = (action, code) => assert.throws(action, (error) => error instanceof ProtocolError && error.code === code);

test("按序收块，合并结果是各块首尾相接", () => {
  const session = newSession();
  const first = ogg("aaaa");
  const second = ogg("bb");
  session.announceChunk({ index: 1, size: first.length });
  assert.deepEqual(session.addChunk(first), { index: 1, size: first.length });
  session.announceChunk({ index: 2, size: second.length });
  session.addChunk(second);

  assert.equal(session.chunkCount, 2);
  assert.equal(session.totalBytes, first.length + second.length);
  assert.deepEqual(session.merge(), Buffer.concat([first, second]));
});

test("没有声明就来了音频帧", () => {
  fails(() => newSession().addChunk(ogg("a")), "chunk_without_info");
});

test("序号从 1 开始，不能跳、不能重复", () => {
  fails(() => newSession().announceChunk({ index: 0, size: 5 }), "chunk_out_of_order");
  fails(() => newSession().announceChunk({ index: 2, size: 5 }), "chunk_out_of_order");

  const session = newSession();
  session.announceChunk({ index: 1, size: 5 });
  session.addChunk(ogg("a"));
  fails(() => session.announceChunk({ index: 1, size: 5 }), "chunk_out_of_order");
});

test("连着两条声明，中间没有音频帧", () => {
  const session = newSession();
  session.announceChunk({ index: 1, size: 5 });
  fails(() => session.announceChunk({ index: 2, size: 5 }), "chunk_missing");
});

test("实际字节数和声明的不一样", () => {
  const session = newSession();
  session.announceChunk({ index: 1, size: 99 });
  fails(() => session.addChunk(ogg("a")), "chunk_size_mismatch");
  // 这一帧已经被消费掉了，同一个序号要重新声明才能再发
  fails(() => session.addChunk(ogg("a")), "chunk_without_info");
  assert.equal(session.chunkCount, 0);
});

test("第一块决定容器格式：Ogg 或 WebM，别的不收", () => {
  const oggSession = newSession();
  oggSession.announceChunk({ index: 1, size: 5 });
  oggSession.addChunk(ogg("a"));
  assert.equal(oggSession.mimeType, "audio/ogg");

  const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f]);
  const webmSession = newSession();
  webmSession.announceChunk({ index: 1, size: webm.length });
  webmSession.addChunk(webm);
  assert.equal(webmSession.mimeType, "audio/webm");
  // 浏览器录的 WebM 只有第一块带文件头，后面的块是接着往下写的数据
  webmSession.announceChunk({ index: 2, size: 3 });
  webmSession.addChunk(Buffer.from([1, 2, 3]));
  assert.equal(webmSession.chunkCount, 2);

  const wavSession = newSession();
  wavSession.announceChunk({ index: 1, size: 5 });
  fails(() => wavSession.addChunk(Buffer.from("RIFFx")), "unsupported_audio");
  assert.equal(wavSession.mimeType, null);
});

test("总量超过上限", () => {
  const session = newSession(8);
  session.announceChunk({ index: 1, size: 5 });
  session.addChunk(ogg("a"));
  session.announceChunk({ index: 2, size: 5 });
  fails(() => session.addChunk(ogg("b")), "audio_too_large");
  assert.equal(session.totalBytes, 5);
});
