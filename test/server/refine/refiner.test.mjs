import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, msg } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { SYSTEM_PROMPT, TASK_REMINDER } from "../../../src/server/refine/prompt.mjs";
import { createModelRefiner, createRefiner, generateClean } from "../../../src/server/refine/refiner.mjs";

const zh = createTranslator("zh-CN");

function fakeGenerate(outputs) {
  const calls = { count: 0, warnings: [] };
  const generateOnce = async () => outputs[calls.count++];
  const log = { warn: (event, fields) => calls.warnings.push({ event, ...fields }) };
  return { calls, generateOnce, log };
}

test("成品里夹着时间戳时重来一次，用第二次的结果，并记一条日志", async () => {
  const { calls, generateOnce, log } = fakeGenerate(["全面开干、 00:30 全面迁移", "全面开干、全面迁移"]);
  assert.equal(await generateClean(generateOnce, log), "全面开干、全面迁移");
  assert.equal(calls.count, 2);
  assert.deepEqual(calls.warnings, [{ event: "refine_retry", reason: "成品里夹着时间戳" }]);
});

test("成品正常时只调一次；版本号和比例不算时间戳", async () => {
  const { calls, generateOnce, log } = fakeGenerate(["版本 1.5.0，比例 3:1，一共 12 条"]);
  assert.equal(await generateClean(generateOnce, log), "版本 1.5.0，比例 3:1，一共 12 条");
  assert.equal(calls.count, 1);
  assert.deepEqual(calls.warnings, []);
});

test("重来一次还有钟点，就当是他真说了，不再重试", async () => {
  const { calls, generateOnce, log } = fakeGenerate(["明天 09:30 开会", "明天 09:30 开会"]);
  assert.equal(await generateClean(generateOnce, log), "明天 09:30 开会");
  assert.equal(calls.count, 2);
});

// ---------- 共用的整理流程：各家的适配器只管"发请求、拿原文"，其余在这里 ----------

/** 适配器带回来的用量（openai.mjs 的 usageOf 那个样子） */
const USAGE = {
  model: "gpt-audio-mini-2025-12-15",
  inputTokens: 1532,
  audioTokens: 10,
  cachedTokens: 0,
  outputTokens: 4,
  thinkingTokens: 0,
  costUsd: 0.001,
};

/** 假的适配器：记下每次 generate 收到了什么，按顺序吐出给定的原文（字符串）或整个回话（对象） */
function fakeClient(outputs, { ping = async () => ({ usage: USAGE }) } = {}) {
  const calls = [];
  return {
    calls,
    ping,
    async generate(request) {
      calls.push(request);
      const next = outputs[calls.length - 1];
      if (next instanceof Error) throw next;
      return typeof next === "string" ? { text: next, problem: null, usage: USAGE } : next;
    },
  };
}

const quietLog = { info() {}, warn() {}, error() {} };
const OpenAI = { id: "openai", name: "OpenAI" };

function refinerWith(client, options = {}) {
  const transcoded = [];
  const refiner = createRefiner({
    provider: OpenAI,
    client,
    audioTypes: ["audio/wav"],
    log: quietLog,
    timeoutMs: 1_000,
    transcode: async (audio, mimeType) => {
      transcoded.push(mimeType);
      return { audio: Buffer.from(`wav:${audio}`), mimeType: "audio/wav" };
    },
    ...options,
  });
  return { refiner, transcoded };
}

test("交给模型的是同一份提示词和同一句提醒，成品照样经过收尾（繁转简、去句末句号）", async () => {
  const client = fakeClient(["我們後天開會。"]);
  const { refiner } = refinerWith(client, { audioTypes: ["audio/webm"] });
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }), "我们后天开会");
  const [request] = client.calls;
  assert.equal(request.systemPrompt, SYSTEM_PROMPT);
  assert.equal(request.reminder, TASK_REMINDER);
  assert.equal(request.mimeType, "audio/webm");
  assert.equal(String(request.audio), "rec");
});

test("这家不收录音的格式时先换好再交过去；夹着时间戳要重来时也只换一次", async () => {
  const client = fakeClient(["全面开干、 00:30 全面迁移", "全面开干、全面迁移"]);
  const { refiner, transcoded } = refinerWith(client);
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }), "全面开干、全面迁移");
  assert.deepEqual(transcoded, ["audio/webm"]);
  assert.deepEqual(
    client.calls.map(({ audio, mimeType }) => [String(audio), mimeType]),
    [
      ["wav:rec", "audio/wav"],
      ["wav:rec", "audio/wav"],
    ],
  );
});

test("客户端断开时取消请求：交给适配器的 signal 跟着断", async () => {
  let seen;
  const client = fakeClient([]);
  client.generate = (request) => {
    seen = request.signal;
    return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)));
  };
  const { refiner } = refinerWith(client, { audioTypes: ["audio/webm"] });
  const abort = new AbortController();
  const pending = refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", signal: abort.signal });
  abort.abort();
  await assert.rejects(pending);
  assert.equal(seen.aborted, true);
});

test("出错时报的是分好类的 ModelError：说得出是哪一家、该怎么办", async () => {
  const offline = new TypeError("fetch failed");
  const { refiner } = refinerWith(fakeClient([offline]), { audioTypes: ["audio/webm"] });
  const error = await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }).catch((thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.equal(error.kind, "unavailable");
  assert.equal(zh.text(error.problem), "连不上 OpenAI，检查网络后再试");
});

test("录音换不了格式时也报 ModelError，不让原始的解码错误直接冒出去", async () => {
  const { refiner } = refinerWith(fakeClient([]), {
    transcode: async () => {
      throw new Error("录音解不出声音（audio/webm）：坏了");
    },
  });
  const error = await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm" }).catch((thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.match(zh.text(error.problem), /解不出声音/);
});

test("warmUp 发适配器的最小请求；失败时同样分好类", async () => {
  let pinged = 0;
  const { refiner } = refinerWith(
    fakeClient([], {
      ping: async () => {
        pinged++;
        return { usage: USAGE };
      },
    }),
  );
  await refiner.warmUp();
  assert.equal(pinged, 1);

  const invalid = Object.assign(new Error("401"), { status: 401 });
  const { refiner: failing } = refinerWith(
    fakeClient([], {
      ping: async () => {
        throw invalid;
      },
    }),
    { classify: (error) => (error.status === 401 ? { kind: "key", problem: "这把 key 无效" } : null) },
  );
  const error = await failing.warmUp().catch((thrown) => thrown);
  assert.deepEqual([error.kind, zh.text(error.problem)], ["key", "这把 key 无效"]);
});

test("createModelRefiner：按选的厂商装上对应的适配器；不认识的厂商直接报错", async () => {
  const refiner = await createModelRefiner({
    choice: { provider: "openai", model: "gpt-audio-mini" },
    apiKey: "k",
    log: quietLog,
  });
  assert.equal(typeof refiner.refine, "function");
  assert.equal(typeof refiner.warmUp, "function");
  await assert.rejects(
    createModelRefiner({ choice: { provider: "deepseek", model: "x" }, apiKey: "k", log: quietLog }),
    /deepseek/,
  );
});

// ---------- 记账：每一次回了话的调用都记一笔，花了多少、多久 ----------

function recorder() {
  const records = [];
  const events = [];
  const log = {
    info: (event, fields) => events.push({ level: "info", event, ...fields }),
    warn: (event, fields) => events.push({ level: "warn", event, ...fields }),
    error: (event, fields) => events.push({ level: "error", event, ...fields }),
  };
  return { records, events, log, onCall: (record) => records.push(record) };
}

test("每次调用记一笔：哪次听写、哪家、按哪个型号、多少 token、多少钱、多久", async () => {
  const { records, events, log, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient(["好的"]), { audioTypes: ["audio/webm"], log, onCall });
  const before = Date.now();
  await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a1" });

  assert.equal(records.length, 1);
  const [{ latencyMs, createdAt, ...record }] = records;
  assert.deepEqual(record, { purpose: "dictation", audioId: "a1", provider: "openai", ...USAGE });
  assert.ok(Number.isInteger(latencyMs) && latencyMs >= 0);
  assert.ok(Date.parse(createdAt) >= before - 1);
  // 日志里也有一条，排查时看得到；不带成品文字
  const logged = events.find(({ event }) => event === "model_call");
  assert.deepEqual(
    [logged.purpose, logged.audio_id, logged.model, logged.input_tokens, logged.cost_usd],
    ["dictation", "a1", USAGE.model, 1532, 0.001],
  );
  assert.ok(!JSON.stringify(events).includes("好的"));
});

test("夹着时间戳重来的那一次也记上，两笔是同一次听写的", async () => {
  const { records, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient(["全面开干、 00:30 全面迁移", "全面开干、全面迁移"]), { onCall });
  await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a2" });
  assert.deepEqual(
    records.map(({ purpose, audioId }) => [purpose, audioId]),
    [
      ["dictation", "a2"],
      ["dictation", "a2"],
    ],
  );
});

test("验证 key 的最小请求也记一笔，不算哪次听写", async () => {
  const { records, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient([]), { onCall });
  await refiner.warmUp();
  assert.deepEqual(
    records.map(({ purpose, audioId, model }) => [purpose, audioId, model]),
    [["check", null, USAGE.model]],
  );
});

test("回了话但用不了（被截断）：先记账再报错，这一次是收了钱的", async () => {
  const { records, onCall } = recorder();
  const cut = { text: null, problem: msg("model.unfinished", { provider: "OpenAI", reason: "length" }), usage: USAGE };
  const { refiner } = refinerWith(fakeClient([cut]), { audioTypes: ["audio/webm"], onCall });
  const error = await refiner
    .refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a3" })
    .catch((thrown) => thrown);
  assert.ok(error instanceof ModelError);
  assert.equal(zh.text(error.problem), "OpenAI 没有正常结束：length");
  assert.equal(records.length, 1);
});

test("没回话的调用记不了账：拿不到用量", async () => {
  const { records, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient([new TypeError("fetch failed")]), { audioTypes: ["audio/webm"], onCall });
  await assert.rejects(refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a4" }));
  assert.deepEqual(records, []);
});

test("发出去了但等不到回话就断开的（超时、连接断了）：对方可能照样收了钱，记一条警告，账上会少这一笔", async () => {
  const { records, events, log, onCall } = recorder();
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const { refiner } = refinerWith(fakeClient([timeout]), { audioTypes: ["audio/webm"], log, onCall });
  await assert.rejects(refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a7" }));
  assert.deepEqual(records, []);
  const unmetered = events.find(({ event }) => event === "model_call_unmetered");
  assert.equal(unmetered?.level, "warn");
  assert.deepEqual([unmetered.purpose, unmetered.audio_id, unmetered.reason], ["dictation", "a7", "TimeoutError"]);
  assert.ok(Number.isInteger(unmetered.latency_ms));

  // 连不上这种根本没发出去的，不用警告
  const offline = recorder();
  const { refiner: unreachable } = refinerWith(fakeClient([new TypeError("fetch failed")]), {
    audioTypes: ["audio/webm"],
    log: offline.log,
  });
  await assert.rejects(unreachable.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a8" }));
  assert.equal(
    offline.events.find(({ event }) => event === "model_call_unmetered"),
    undefined,
  );
});

test("记账出错不连累这次听写：成品照常给，错误记进日志", async () => {
  const { events, log } = recorder();
  const onCall = () => {
    throw new Error("database is locked");
  };
  const { refiner } = refinerWith(fakeClient(["好的"]), { audioTypes: ["audio/webm"], log, onCall });
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a5" }), "好的");
  const failed = events.find(({ event }) => event === "model_call_not_recorded");
  assert.equal(failed.level, "error");
  assert.equal(failed.audio_id, "a5");
  assert.match(failed.error, /database is locked/);
});

test("适配器没带回用量（它自己的毛病）：成品照常给，记一条警告，不瞎记一笔 0", async () => {
  const { records, events, log, onCall } = recorder();
  const { refiner } = refinerWith(fakeClient([{ text: "好的", problem: null }]), {
    audioTypes: ["audio/webm"],
    log,
    onCall,
  });
  assert.equal(await refiner.refine(Buffer.from("rec"), { mimeType: "audio/webm", audioId: "a6" }), "好的");
  assert.deepEqual(records, []);
  assert.equal(events.find(({ event }) => event === "usage_missing")?.level, "warn");
});

// ---------- 开口说话时先备好：Gemini 建提示词缓存，花的钱单记一笔 ----------

test("prepare：让适配器备好提示词缓存，花的钱记一笔，用途是缓存、不算哪次听写", async () => {
  const { records, onCall } = recorder();
  const prepared = [];
  const client = fakeClient([]);
  client.prepare = async (request) => {
    prepared.push(request);
    return { usage: { ...USAGE, model: "gemini-3.6-flash", inputTokens: 1350, outputTokens: 0, costUsd: 0.0012 } };
  };
  const { refiner } = refinerWith(client, { onCall });
  await refiner.prepare();
  assert.deepEqual(prepared, [{ systemPrompt: SYSTEM_PROMPT }]);
  assert.deepEqual(
    records.map(({ purpose, audioId, inputTokens, costUsd }) => [purpose, audioId, inputTokens, costUsd]),
    [["cache", null, 1350, 0.0012]],
  );
});

test("prepare：这一次没花钱（已经在建、型号不支持）就不记；适配器不做这件事（OpenAI）就什么都不干", async () => {
  const { records, onCall } = recorder();
  const client = fakeClient([]);
  client.prepare = async () => null;
  await refinerWith(client, { onCall }).refiner.prepare();
  await refinerWith(fakeClient([]), { onCall }).refiner.prepare();
  assert.deepEqual(records, []);
});

test("prepare：建不好只记一条警告，不往外抛，也不带出 key", async () => {
  const { events, log } = recorder();
  const client = fakeClient([]);
  client.prepare = async () => {
    throw new Error("fetch failed for key sk-secret");
  };
  await refinerWith(client, { log, apiKey: "sk-secret" }).refiner.prepare();
  const failed = events.find(({ event }) => event === "prompt_cache_failed");
  assert.equal(failed.level, "warn");
  assert.doesNotMatch(JSON.stringify(failed), /sk-secret/);
});
