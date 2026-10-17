import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { AUDIO_TYPES, classifyError, createClient, replyOf } from "../../../src/server/providers/gemini.mjs";

const zh = createTranslator("zh-CN");

/** 和 SDK 抛的一样：message 是 Gemini 回的整段 JSON，status 是 HTTP 状态码 */
function apiError(code, message, status) {
  return Object.assign(new Error(JSON.stringify({ error: { code, message, status } })), {
    name: "ApiError",
    status: code,
  });
}
/** 分类的结果，说法按中文翻出来 */
const classify = (error) => {
  const classified = classifyError(error, String(error.message));
  return classified && { ...classified, problem: zh.text(classified.problem) };
};

test("Gemini 直接收悬浮条录的 WebM、原版的 Ogg 和评测用的统一格式 WAV，不用转格式", () => {
  assert.deepEqual(AUDIO_TYPES, ["audio/ogg", "audio/webm", "audio/wav"]);
});

test("key 不对：说这把 key 无效", () => {
  // 实测到的假 key 报错
  const invalid = new Error(
    '{"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
  );
  assert.deepEqual(classify(invalid), { kind: "key", problem: "这把 key 无效，检查有没有复制完整" });
});

test("Gemini 自己出了状况或者限流：和 key、和设置都没关系，过一会儿就好", () => {
  assert.deepEqual(classify(apiError(503, "The service is currently unavailable.", "UNAVAILABLE")), {
    kind: "unavailable",
    problem: "Gemini 暂时用不了（The service is currently unavailable），过一会儿再试",
  });
  assert.equal(classify(apiError(500, "Internal error.", "INTERNAL")).kind, "unavailable");
  assert.equal(classify(apiError(429, "Resource exhausted.", "RESOURCE_EXHAUSTED")).kind, "unavailable");
});

test("Gemini 拒绝了请求（多半是模型名或档位）：只带它说的那句话，不带整段 JSON", () => {
  const other = classify(
    apiError(
      404,
      "models/gemini-no-such-model is not found for API version v1beta, or is not supported for generateContent.",
      "NOT_FOUND",
    ),
  );
  assert.equal(other.kind, "other");
  // 句尾的句号去掉，后面还要接别的话
  assert.match(other.problem, /^Gemini 拒绝了请求：models\/gemini-no-such-model is not found.*generateContent$/);
  assert.doesNotMatch(other.problem, /"code"/);
});

test("不是 Gemini 回的报错不认，交给通用的分类", () => {
  assert.equal(classify(new TypeError("fetch failed")), null);
  assert.equal(classify(new Error("Gemini 没有正常结束：MAX_TOKENS")), null);
});

// ---------- 回话里的用量：多少 token、按哪个型号、花了多少钱 ----------

const OCT = new Date("2026-10-14T08:00:00Z");

/** 一次真实的听写回话（2026-10-14 实测，请求的是 gemini-3.5-flash，被转给了 3.6 Flash） */
const dictation = (overrides = {}) => ({
  text: "<无人声>",
  modelVersion: "gemini-3.6-flash",
  candidates: [{ finishReason: "STOP" }],
  usageMetadata: {
    promptTokenCount: 1390,
    candidatesTokenCount: 4,
    totalTokenCount: 1394,
    promptTokensDetails: [
      { modality: "AUDIO", tokenCount: 25 },
      { modality: "TEXT", tokenCount: 1365 },
    ],
    serviceTier: "standard",
  },
  ...overrides,
});

test("回话里带着用量：按实际回话的型号算钱（请求 3.5 Flash，回话的是 3.6 Flash）", () => {
  assert.deepEqual(replyOf(dictation(), { model: "gemini-3.5-flash", at: OCT }), {
    text: "<无人声>",
    problem: null,
    usage: {
      model: "gemini-3.6-flash",
      inputTokens: 1390,
      audioTokens: 25,
      cachedTokens: 0,
      outputTokens: 4,
      thinkingTokens: 0,
      costUsd: (1390 * 0.75 + 4 * 3.75) / 1e6,
    },
  });
});

test("思考的 token 算进输出；命中缓存的照报，价按缓存价", () => {
  const { usage } = replyOf(
    dictation({
      modelVersion: "gemini-2.5-flash",
      usageMetadata: {
        promptTokenCount: 1390,
        cachedContentTokenCount: 1024,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 30,
        promptTokensDetails: [
          { modality: "TEXT", tokenCount: 1365 },
          { modality: "AUDIO", tokenCount: 25 },
        ],
        cacheTokensDetails: [{ modality: "TEXT", tokenCount: 1024 }],
      },
    }),
    { model: "gemini-2.5-flash", at: OCT },
  );
  assert.equal(usage.outputTokens, 80);
  assert.equal(usage.thinkingTokens, 30);
  assert.equal(usage.cachedTokens, 1024);
  assert.ok(Math.abs(usage.costUsd - (341 * 0.3 + 1024 * 0.03 + 25 * 1 + 80 * 2.5) / 1e6) < 1e-12);
});

test("回话没报型号就按请求的型号算；价目表里没有的型号算不出钱，token 照记", () => {
  assert.equal(
    replyOf(dictation({ modelVersion: undefined }), { model: "gemini-2.5-flash", at: OCT }).usage.model,
    "gemini-2.5-flash",
  );
  const { usage } = replyOf(dictation({ modelVersion: "gemini-9-ultra" }), { model: "gemini-9-ultra", at: OCT });
  assert.equal(usage.costUsd, null);
  assert.equal(usage.inputTokens, 1390);
});

test("回话报的型号查不到价（比如带了后缀的变体名）时，退回去按请求的型号算", () => {
  const { usage } = replyOf(dictation({ modelVersion: "gemini-3.6-flash-preview-0915" }), {
    model: "gemini-3.6-flash",
    at: OCT,
  });
  assert.equal(usage.model, "gemini-3.6-flash-preview-0915");
  assert.equal(usage.costUsd, (1390 * 0.75 + 4 * 3.75) / 1e6);
});

test("被拦下、没正常结束的回话不能当成品，但用量照样带回来：这一次是收了钱的", () => {
  const blocked = replyOf(dictation({ promptFeedback: { blockReason: "PROHIBITED_CONTENT" }, candidates: [] }), {
    model: "gemini-3.6-flash",
    at: OCT,
  });
  assert.equal(zh.text(blocked.problem), "Gemini 没有处理这段录音：PROHIBITED_CONTENT");
  assert.equal(blocked.text, null);
  assert.equal(blocked.usage.inputTokens, 1390);

  const cut = replyOf(dictation({ candidates: [{ finishReason: "MAX_TOKENS" }] }), {
    model: "gemini-3.6-flash",
    at: OCT,
  });
  assert.equal(zh.text(cut.problem), "Gemini 没有正常结束：MAX_TOKENS");
  assert.equal(cut.text, null);
});

test("用量缺项时按 0 算（实测验证 key 的最小请求只报了输入）", () => {
  const ping = { modelVersion: "gemini-3.6-flash", usageMetadata: { promptTokenCount: 2, totalTokenCount: 2 } };
  assert.deepEqual(replyOf(ping, { model: "gemini-3.6-flash", at: OCT }).usage, {
    model: "gemini-3.6-flash",
    inputTokens: 2,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: (2 * 0.75) / 1e6,
  });
});

// ---------- 提示词缓存：开口说话时建好（或续上），整理时带上它，提示词那部分只收一成的价 ----------

const MINUTE = 60_000;
const SYSTEM = "系统提示词";

/**
 * 假的 SDK：缓存建、续、用都照真的回话的样子（2026-10-14 实测：建好的缓存报 totalTokenCount，
 * 带缓存的请求报 cachedContentTokenCount，缓存没了回 403 "CachedContent not found"）
 */
function fakeSdk({ createError, updateError, cachedError } = {}) {
  let clock = Date.parse("2026-10-14T08:00:00Z");
  const calls = { create: [], update: [], generate: [] };
  const expiry = (ttl) => new Date(clock + Number.parseInt(ttl, 10) * 1000).toISOString();
  const response = (cachedContent) => ({
    text: "好的",
    modelVersion: "gemini-3.6-flash",
    candidates: [{ finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 1484,
      candidatesTokenCount: 18,
      promptTokensDetails: [
        { modality: "TEXT", tokenCount: 1365 },
        { modality: "AUDIO", tokenCount: 119 },
      ],
      ...(cachedContent
        ? { cachedContentTokenCount: 1350, cacheTokensDetails: [{ modality: "TEXT", tokenCount: 1350 }] }
        : {}),
    },
  });
  const sdk = {
    caches: {
      async create(params) {
        calls.create.push(params);
        if (createError) throw createError();
        return {
          name: `cachedContents/c${calls.create.length}`,
          model: "models/gemini-3.6-flash",
          expireTime: expiry(params.config.ttl),
          usageMetadata: { totalTokenCount: 1350 },
        };
      },
      async update(params) {
        calls.update.push(params);
        if (updateError) throw updateError();
        return { name: params.name, expireTime: expiry(params.config.ttl) };
      },
    },
    models: {
      async generateContent(params) {
        calls.generate.push(params);
        if (params.config.cachedContent && cachedError) throw cachedError();
        return response(params.config.cachedContent);
      },
    },
  };
  return {
    sdk,
    calls,
    now: () => new Date(clock),
    advance: (ms) => {
      clock += ms;
    },
  };
}

const NOT_FOUND = () =>
  Object.assign(
    new Error(
      '{"error":{"code":403,"message":"CachedContent not found (or permission denied)","status":"PERMISSION_DENIED"}}',
    ),
    { status: 403 },
  );

function cachingClient(options = {}) {
  const fake = fakeSdk(options);
  const client = createClient({
    apiKey: "k",
    model: "gemini-3.6-flash",
    thinkingLevel: "MINIMAL",
    now: fake.now,
    sdk: fake.sdk,
    log: quietLog,
  });
  const dictate = () =>
    client.generate({
      audio: Buffer.from("rec"),
      mimeType: "audio/webm",
      systemPrompt: SYSTEM,
      reminder: "只输出成品。",
    });
  return { ...fake, client, dictate };
}

const quietLog = { info() {}, warn() {}, error() {} };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

test("开口说话时建一个提示词缓存，放 30 分钟：建的时候按标准输入价收一次，再加存 30 分钟的存储费", async () => {
  const { client, calls } = cachingClient();
  const { usage } = await client.prepare({ systemPrompt: SYSTEM });
  const [{ model, config }] = calls.create;
  assert.deepEqual([model, config.systemInstruction, config.ttl], ["gemini-3.6-flash", SYSTEM, "1800s"]);
  // 建缓存也有时限：卡住不回的话"正在建"一直占着，以后就再也建不了
  assert.ok(config.abortSignal instanceof AbortSignal);
  assert.deepEqual(
    { ...usage, costUsd: 0 },
    {
      model: "gemini-3.6-flash",
      inputTokens: 1350,
      audioTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      thinkingTokens: 0,
      costUsd: 0,
    },
  );
  close(usage.costUsd, (1350 * 0.75 + 1350 * 0.5 * 0.5) / 1e6);
});

test("整理时带上缓存，不再发提示词；提示词那部分按缓存价算", async () => {
  const { client, calls, dictate } = cachingClient();
  await client.prepare({ systemPrompt: SYSTEM });
  const reply = await dictate();
  const [request] = calls.generate;
  assert.equal(request.config.cachedContent, "cachedContents/c1");
  // 带着缓存时不能再写 systemInstruction（实测 400）
  assert.equal(request.config.systemInstruction, undefined);
  assert.deepEqual(request.config.thinkingConfig, { thinkingLevel: "MINIMAL" });
  assert.equal(reply.text, "好的");
  assert.equal(reply.usage.cachedTokens, 1350);
  close(reply.usage.costUsd, (15 * 0.75 + 1350 * 0.075 + 119 * 0.75 + 18 * 3.75) / 1e6);
});

test("没有缓存时照原样发：提示词放在 systemInstruction 里", async () => {
  const { calls, dictate } = cachingClient();
  await dictate();
  assert.equal(calls.generate[0].config.systemInstruction, SYSTEM);
  assert.equal(calls.generate[0].config.cachedContent, undefined);
});

test("缓存还在时再开口：只把它往后续 30 分钟，记的是多存的那一段的存储费", async () => {
  const { client, calls, advance } = cachingClient();
  await client.prepare({ systemPrompt: SYSTEM });
  advance(10 * MINUTE);
  const { usage } = await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 1);
  assert.deepEqual(
    calls.update.map(({ name, config }) => [name, config.ttl, config.abortSignal instanceof AbortSignal]),
    [["cachedContents/c1", "1800s", true]],
  );
  assert.equal(usage.inputTokens, 0);
  // 原来 08:30 过期，续到 08:40：多存了 10 分钟
  close(usage.costUsd, (1350 * 0.5 * (10 / 60)) / 1e6);
});

test("缓存快过期或者已经过期：不用它，下次开口重新建", async () => {
  const { client, calls, advance, dictate } = cachingClient();
  await client.prepare({ systemPrompt: SYSTEM });
  // 离过期不到一分钟：请求可能用到一半它就没了
  advance(29.5 * MINUTE);
  await dictate();
  assert.equal(calls.generate[0].config.cachedContent, undefined);
  advance(MINUTE);
  await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 2);
  assert.equal(calls.update.length, 0);
});

test("Google 那边缓存已经没了（403 CachedContent not found）：这一次照原样再发一遍，下次开口重新建", async () => {
  const { client, calls, dictate } = cachingClient({ cachedError: NOT_FOUND });
  await client.prepare({ systemPrompt: SYSTEM });
  const reply = await dictate();
  assert.equal(reply.text, "好的");
  assert.deepEqual(
    calls.generate.map(({ config }) => [config.cachedContent, config.systemInstruction]),
    [
      ["cachedContents/c1", undefined],
      [undefined, SYSTEM],
    ],
  );
  await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 2);
});

test("续的时候发现缓存没了：重新建一个", async () => {
  const { client, calls } = cachingClient({ updateError: NOT_FOUND });
  await client.prepare({ systemPrompt: SYSTEM });
  const { usage } = await client.prepare({ systemPrompt: SYSTEM });
  assert.equal(calls.create.length, 2);
  assert.equal(usage.inputTokens, 1350);
});

test("带缓存的请求别的错照常报，不偷偷再发一遍", async () => {
  const unavailable = () => Object.assign(new Error('{"error":{"code":503,"message":"overloaded"}}'), { status: 503 });
  const { client, calls, dictate } = cachingClient({ cachedError: unavailable });
  await client.prepare({ systemPrompt: SYSTEM });
  await assert.rejects(dictate(), /overloaded/);
  assert.equal(calls.generate.length, 1);
});

test("这个型号建不了显式缓存（4xx）：以后不再试，照原样发", async () => {
  const unsupported = () =>
    Object.assign(new Error('{"error":{"code":400,"message":"Explicit caching is not supported"}}'), { status: 400 });
  const { client, calls, dictate } = cachingClient({ createError: unsupported });
  await assert.rejects(client.prepare({ systemPrompt: SYSTEM }), /not supported/);
  assert.equal(await client.prepare({ systemPrompt: SYSTEM }), null);
  assert.equal(calls.create.length, 1);
  await dictate();
  assert.equal(calls.generate[0].config.systemInstruction, SYSTEM);
});

test("一时建不了（没网、它那边 503）：下次开口再试", async () => {
  const offline = () => Object.assign(new TypeError("fetch failed"), {});
  const { client, calls } = cachingClient({ createError: offline });
  await assert.rejects(client.prepare({ systemPrompt: SYSTEM }));
  await assert.rejects(client.prepare({ systemPrompt: SYSTEM }));
  assert.equal(calls.create.length, 2);
});

test("同时开口两次只建一个；提示词变了的缓存不用", async () => {
  const { client, calls } = cachingClient();
  const [first, second] = await Promise.all([
    client.prepare({ systemPrompt: SYSTEM }),
    client.prepare({ systemPrompt: SYSTEM }),
  ]);
  assert.equal(calls.create.length, 1);
  assert.ok(first.usage);
  assert.equal(second, null);
  await client.generate({
    audio: Buffer.from("rec"),
    mimeType: "audio/webm",
    systemPrompt: "改过的提示词",
    reminder: "",
  });
  assert.equal(calls.generate[0].config.cachedContent, undefined);
});
