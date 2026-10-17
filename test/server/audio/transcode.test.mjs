import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { audioTypeOf, DECODERS, toSpeech, toWav } from "../../../src/server/audio/transcode.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

// 测试用的录音是 ffmpeg 生成的纯音调（Opus，单声道），不是谁的说话声
const fixture = (name) => readFileSync(join(import.meta.dirname, "../../fixtures/audio", name));

function describeWav(wav) {
  return {
    format: wav.toString("ascii", 8, 12),
    channels: wav.readUInt16LE(22),
    sampleRate: wav.readUInt32LE(24),
    seconds: wav.readUInt32LE(40) / 2 / wav.readUInt32LE(24),
  };
}

test("悬浮条录的 WebM 换成 16 kHz 单声道 WAV，时长不变", async () => {
  const converted = await toWav(fixture("tone-1s.webm"), "audio/webm");
  assert.equal(converted.mimeType, "audio/wav");
  const wav = describeWav(converted.audio);
  assert.equal(wav.format, "WAVE");
  assert.equal(wav.channels, 1);
  assert.equal(wav.sampleRate, 16_000);
  assert.ok(Math.abs(wav.seconds - 1) < 0.05, `${wav.seconds} 秒`);
});

test("不转的格式直接报错，说清是哪一种：原版 Typeless 的 Ogg 也不转", async () => {
  await assert.rejects(toWav(Buffer.from("RIFF"), "audio/aac"), /audio\/aac/);
  await assert.rejects(toWav(fixture("tone-1s.ogg"), "audio/ogg"), /audio\/ogg.*只认 audio\/webm/);
});

test("内容坏了解不出声音时报错，不交出一段空的 WAV", async () => {
  await assert.rejects(
    toWav(Buffer.from("\x1aE\xdf\xa3 but not really audio", "latin1"), "audio/webm"),
    said(/解不出/),
  );
});

test("解码器可以换：传进来的认得 Ogg 就解 Ogg，多声道、48 kHz 照样合成 16 kHz 单声道", async () => {
  const fake = async () => ({
    default: async () => ({ sampleRate: 48_000, channelData: [new Float32Array(48_000), new Float32Array(48_000)] }),
  });
  const samples = await toSpeech(Buffer.from("OggS"), "audio/ogg", new Map([["audio/ogg", fake]]));
  assert.equal(samples.length, 16_000);
  // 程序自己用的那份只认 WebM：拆 Ogg 的库是 LGPL，不随程序分发
  assert.deepEqual([...DECODERS.keys()], ["audio/webm"]);
});

test("靠文件头认容器：Ogg、WebM 认得出，别的是 null", () => {
  assert.equal(audioTypeOf(fixture("tone-1s.ogg")), "audio/ogg");
  assert.equal(audioTypeOf(fixture("tone-1s.webm")), "audio/webm");
  assert.equal(audioTypeOf(Buffer.from("RIFF....WAVE")), null);
  assert.equal(audioTypeOf(Buffer.alloc(0)), null);
});
