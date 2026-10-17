import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { createLocalRefiner } from "../../../src/server/refine/local.mjs";

const zh = createTranslator("zh-CN");

function recordingLog() {
  const events = [];
  const record = (level) => (event, fields) => events.push({ level, event, ...fields });
  return { events, info: record("info"), warn: record("warn"), error: record("error") };
}

const SAMPLES = new Float32Array(32_000);

/** 三样都是假的：解码回固定的 2 秒样本，转写回固定的原文，润色把原文加上前缀 */
function parts({ transcript = "原文", transcribeError = null, polishError = null } = {}) {
  const seen = { decoded: [], transcribed: [], polished: [] };
  return {
    seen,
    decode: async (audio, mimeType) => {
      seen.decoded.push({ audio, mimeType });
      return SAMPLES;
    },
    transcriber: {
      async transcribe(samples) {
        seen.transcribed.push(samples);
        if (transcribeError) throw transcribeError;
        return { text: transcript };
      },
    },
    polisher: {
      warmUps: 0,
      async warmUp() {
        this.warmUps++;
      },
      async polish(text, options) {
        seen.polished.push({ text, options });
        if (polishError) throw polishError;
        return `成品：${text}`;
      },
    },
  };
}

test("录音 → 统一格式 → 本地转写 → 润色；和原生链路一样的接口", async () => {
  const log = recordingLog();
  const { seen, decode, transcriber, polisher } = parts();
  const refiner = createLocalRefiner({ transcriber, polisher, log, decode });
  const audio = Buffer.from("webm");
  const signal = new AbortController().signal;
  assert.equal(await refiner.refine(audio, { mimeType: "audio/webm", signal, audioId: "a1" }), "成品：原文");
  assert.deepEqual(seen.decoded, [{ audio, mimeType: "audio/webm" }]);
  assert.equal(seen.transcribed[0], SAMPLES);
  assert.deepEqual(seen.polished, [{ text: "原文", options: { signal, audioId: "a1" } }]);
  await refiner.prepare();
  await refiner.warmUp();
  assert.equal(polisher.warmUps, 1);
});

test("每次记一条日志：两跳各花了多久、原文多长，不记原文和成品", async () => {
  const log = recordingLog();
  const { decode, transcriber, polisher } = parts({ transcript: "一二三" });
  await createLocalRefiner({ transcriber, polisher, log, decode }).refine(Buffer.from("x"), {
    mimeType: "audio/webm",
    audioId: "a2",
  });
  const entry = log.events.find((e) => e.event === "local_refined");
  assert.equal(entry.audio_id, "a2");
  assert.equal(entry.seconds, 2);
  assert.equal(entry.transcript_length, 3);
  for (const field of ["decode_ms", "transcribe_ms", "polish_ms"]) assert.ok(Number.isInteger(entry[field]), field);
  assert.ok(!JSON.stringify(log.events).includes("一二三"));
});

test("本地转写出错：报分好类的 ModelError，说是本地转写的事，原话进 detail", async () => {
  const { decode, transcriber, polisher } = parts({ transcribeError: new Error("转写进程退出了（code 3）") });
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  const error = await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(error.kind, "other");
  assert.match(zh.text(error.problem), /本地转写/);
  assert.match(error.detail, /code 3/);
});

test("润色出的错原样往上报（已经是分好类的）", async () => {
  const failure = new ModelError({ kind: "key", problem: { key: "model.keyInvalid" }, detail: "401" });
  const { decode, transcriber, polisher } = parts({ polishError: failure });
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  assert.equal(await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }).catch((e) => e), failure);
});

test("录音解不开：报 ModelError，不让解码的原始错误直接冒出去", async () => {
  const { transcriber, polisher } = parts();
  const decode = async () => {
    throw new Error("bad webm");
  };
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  const error = await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.match(error.detail, /bad webm/);
});

test("转写完时客户端已经断开：不再花润色的钱", async () => {
  const { seen, decode, transcriber, polisher } = parts();
  const abort = new AbortController();
  transcriber.transcribe = async () => {
    abort.abort();
    return { text: "原文" };
  };
  const refiner = createLocalRefiner({ transcriber, polisher, log: recordingLog(), decode });
  await assert.rejects(refiner.refine(Buffer.from("x"), { mimeType: "audio/webm", signal: abort.signal }));
  assert.equal(seen.polished.length, 0);
});

test("本机转写那一跳也记一笔账：是哪个模型、转了多久，不花钱；记不上不耽误这次听写", async () => {
  const { decode, transcriber, polisher } = parts();
  const calls = [];
  const refiner = createLocalRefiner({
    transcriber,
    polisher,
    log: recordingLog(),
    decode,
    model: "qwen3-asr-0.6b-q8",
    onCall: (call) => calls.push(call),
  });
  await refiner.refine(Buffer.from("webm"), { mimeType: "audio/webm", audioId: "a1" });
  assert.equal(calls.length, 1);
  const { latencyMs, createdAt, ...rest } = calls[0];
  assert.deepEqual(rest, {
    purpose: "dictation",
    audioId: "a1",
    provider: "local",
    model: "qwen3-asr-0.6b-q8",
    inputTokens: 0,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
  });
  assert.equal(typeof latencyMs, "number");
  assert.ok(Number.isFinite(Date.parse(createdAt)));

  const log = recordingLog();
  const broken = createLocalRefiner({
    transcriber,
    polisher,
    log,
    decode,
    model: "qwen3-asr-0.6b-q8",
    onCall: () => {
      throw new Error("库锁住了");
    },
  });
  assert.equal(await broken.refine(Buffer.from("webm"), { mimeType: "audio/webm", audioId: "a2" }), "成品：原文");
  assert.ok(log.events.some(({ event }) => event === "model_call_not_recorded"));
});
