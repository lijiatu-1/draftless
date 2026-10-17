import assert from "node:assert/strict";
import { test } from "node:test";
import { windowed } from "../../../src/server/asr/engines/index.mjs";
import { FAMILIES as SHERPA } from "../../../src/server/asr/engines/sherpa-onnx.mjs";

const RATE = 16_000;
const tone = (seconds) => Float32Array.from({ length: seconds * RATE }, (_, i) => 0.3 * Math.sin(i / 5));
const concat = (...parts) => {
  const all = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    all.set(part, offset);
    offset += part.length;
  }
  return all;
};

/** 假的转写器：记下每次交来多长，按次序回 "一""二"… */
function fake() {
  const calls = [];
  return {
    calls,
    backend: "cpu",
    dispose() {},
    async transcribe(samples) {
      calls.push(samples.length / RATE);
      return { text: "一二三四五"[calls.length - 1] };
    },
  };
}

test("统一接口：长录音按上限切开逐段交，文字按顺序接起来；backend、dispose 照旧", async () => {
  const inner = fake();
  const outer = windowed(inner, 20);
  const { text } = await outer.transcribe(concat(tone(15), new Float32Array(RATE), tone(15)));
  assert.equal(text, "一二");
  assert.equal(inner.calls.length, 2);
  for (const seconds of inner.calls) assert.ok(seconds <= 20);
  assert.equal(outer.backend, "cpu");
  assert.equal(outer.dispose, inner.dispose);
});

test("统一接口：全是静音的录音不交给模型，直接是空的；没有上限的模型也一样", async () => {
  const inner = fake();
  assert.deepEqual(await windowed(inner, null).transcribe(new Float32Array(8 * RATE)), { text: "" });
  assert.deepEqual(inner.calls, []);
  assert.deepEqual(await windowed(inner, null).transcribe(tone(3)), { text: "一" });
});

test("sherpa-onnx 的 Qwen3：没有人声时吐出的 None 换成空的，正常的字原样", () => {
  const { clean } = SHERPA["qwen3-asr"];
  assert.equal(clean("None"), "");
  assert.equal(clean("好的，就这么干。"), "好的，就这么干。");
  assert.equal(SHERPA["sense-voice"].clean, undefined);
});
