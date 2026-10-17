import assert from "node:assert/strict";
import { test } from "node:test";
import {
  envelope,
  MAX_CHUNK_BYTES,
  ProtocolError,
  parseClientMessage,
} from "../../../src/server/protocol/protocol.mjs";

const rejects = (text, code) =>
  assert.throws(
    () => parseClientMessage(text),
    (error) => error instanceof ProtocolError && error.code === code,
  );

test("服务端消息的外壳是 K/V/T/M/S 五个字段", () => {
  assert.deepEqual(envelope("audio_session_started", { audio_id: "a" }), {
    K: "audio_session_started",
    V: { audio_id: "a" },
    T: "json",
    M: false,
    S: "done",
  });
});

test("start_audio：只取用得到的字段，多余的字段不报错", () => {
  const message = parseClientMessage(
    JSON.stringify({ type: "start_audio", audio_id: "abc", audio_chunk_time: 3, mode: "voice_transcript" }),
  );
  assert.deepEqual(message, { type: "start_audio", audioId: "abc" });
});

test("set_audio_chunk_info：序号和字节数必须是正整数", () => {
  const ok = { type: "set_audio_chunk_info", audio_id: "abc", index: 1, size: 14000, duration: 3 };
  assert.deepEqual(parseClientMessage(JSON.stringify(ok)), {
    type: "set_audio_chunk_info",
    audioId: "abc",
    index: 1,
    size: 14000,
  });
  rejects(JSON.stringify({ ...ok, index: 0 }), "invalid_field");
  rejects(JSON.stringify({ ...ok, index: 1.5 }), "invalid_field");
  rejects(JSON.stringify({ ...ok, size: 0 }), "invalid_field");
  rejects(JSON.stringify({ ...ok, size: "14000" }), "invalid_field");
  rejects(JSON.stringify({ ...ok, size: MAX_CHUNK_BYTES + 1 }), "invalid_field");
});

test("end_audio：要有 audio_id", () => {
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: "end_audio", audio_id: "abc", total_duration: 12.8 })), {
    type: "end_audio",
    audioId: "abc",
  });
  rejects(JSON.stringify({ type: "end_audio" }), "invalid_field");
  rejects(JSON.stringify({ type: "end_audio", audio_id: "" }), "invalid_field");
  rejects(JSON.stringify({ type: "end_audio", audio_id: "x".repeat(129) }), "invalid_field");
});

test("不是 JSON、不是对象、类型不认识，分别报不同的错", () => {
  rejects("{not json", "invalid_json");
  rejects("[]", "invalid_message");
  rejects("null", "invalid_message");
  rejects(JSON.stringify({ audio_id: "abc" }), "unknown_type");
  rejects(JSON.stringify({ type: "ping" }), "unknown_type");
  // 对象原型上的属性名不能被当成消息类型
  rejects(JSON.stringify({ type: "constructor", audio_id: "abc" }), "unknown_type");
});
