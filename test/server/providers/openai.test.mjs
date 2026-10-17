import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { AUDIO_TYPES, classifyError, createClient } from "../../../src/server/providers/openai.mjs";

const zh = createTranslator("zh-CN");

/** 假的 fetch：记下请求，按给定的状态码和内容回话 */
function fakeFetch(status, body) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, requests };
}

/** 实测的用量（gpt-audio-mini，1 秒录音加系统提示词） */
const USAGE = {
  prompt_tokens: 1532,
  completion_tokens: 4,
  total_tokens: 1536,
  prompt_tokens_details: { cached_tokens: 0, audio_tokens: 10, text_tokens: 1522, image_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0, text_tokens: 4 },
};

const completion = (content, finish_reason = "stop", extra = {}) => ({
  model: "gpt-audio-mini-2025-12-15",
  choices: [{ finish_reason, message: { role: "assistant", content, refusal: null, ...extra } }],
  usage: USAGE,
});

/** 上面那份用量记账后的样子 */
const BILLED = {
  model: "gpt-audio-mini-2025-12-15",
  inputTokens: 1532,
  audioTokens: 10,
  cachedTokens: 0,
  outputTokens: 4,
  thinkingTokens: 0,
  costUsd: (1522 * 0.6 + 10 * 10 + 4 * 2.4) / 1e6,
};

const WAV = Buffer.from("RIFF fake wav");

test("OpenAI 只收 wav（实测 webm、ogg 都回 400），录音要先换格式", () => {
  assert.deepEqual(AUDIO_TYPES, ["audio/wav"]);
});

test("整理：系统提示词、录音、跟在录音后面的那句话一起发；只要文字，不要它说话", async () => {
  const { fetch, requests } = fakeFetch(200, completion("整理好的文字"));
  const client = createClient({ apiKey: "sk-test", model: "gpt-audio-1.5", fetch });
  const signal = new AbortController().signal;
  const reply = await client.generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "系统提示词",
    reminder: "只输出成品。",
    signal,
  });
  assert.deepEqual(reply, { text: "整理好的文字", problem: null, usage: BILLED });

  const [{ url, init, body }] = requests;
  assert.equal(url, "https://api.openai.com/v1/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer sk-test");
  assert.equal(init.signal, signal);
  assert.deepEqual(body, {
    model: "gpt-audio-1.5",
    modalities: ["text"],
    messages: [
      { role: "system", content: "系统提示词" },
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: WAV.toString("base64"), format: "wav" } },
          { type: "text", text: "只输出成品。" },
        ],
      },
    ],
  });
});

test("被截断、被拦下的半截文字不能当成品：说清为什么用不了；这一次收了钱，用量照样带回来", async () => {
  for (const [completed, problem] of [
    [completion("说到一半", "length"), "OpenAI 没有正常结束：length"],
    [completion("", "content_filter"), "OpenAI 没有正常结束：content_filter"],
    [
      completion(null, "stop", { refusal: "I can't help with that." }),
      "OpenAI 没有处理这段录音：I can't help with that",
    ],
  ]) {
    const { fetch } = fakeFetch(200, completed);
    const client = createClient({ apiKey: "k", model: "m", fetch });
    const reply = await client.generate({ audio: WAV, mimeType: "audio/wav", systemPrompt: "", reminder: "" });
    assert.deepEqual({ ...reply, problem: zh.text(reply.problem) }, { text: null, problem, usage: BILLED });
  }
});

test("用量按回话报的型号算钱；没报型号按请求的；价目表里没有的算不出钱，token 照记", async () => {
  const { model: _reported, ...unnamed } = completion("好");
  const { fetch } = fakeFetch(200, unnamed);
  const { usage } = await createClient({ apiKey: "k", model: "gpt-audio-1.5", fetch }).generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "",
    reminder: "",
  });
  assert.equal(usage.model, "gpt-audio-1.5");
  assert.ok(Math.abs(usage.costUsd - (1522 * 2.5 + 10 * 32 + 4 * 10) / 1e6) < 1e-12);

  const { fetch: unknown } = fakeFetch(200, { ...completion("好"), model: "gpt-9-audio" });
  const priced = await createClient({ apiKey: "k", model: "gpt-9-audio", fetch: unknown }).ping({});
  assert.equal(priced.usage.costUsd, null);
  assert.equal(priced.usage.inputTokens, 1532);
});

test("音频输出、思考的 token 各按各的价；用量缺项时按 0 算", async () => {
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 30,
    prompt_tokens_details: { audio_tokens: 40 },
    completion_tokens_details: { reasoning_tokens: 8, audio_tokens: 10 },
  };
  const { fetch } = fakeFetch(200, { ...completion("好"), usage });
  const reply = await createClient({ apiKey: "k", model: "gpt-audio-mini", fetch }).generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "",
    reminder: "",
  });
  assert.equal(reply.usage.cachedTokens, 0);
  assert.equal(reply.usage.thinkingTokens, 8);
  assert.ok(Math.abs(reply.usage.costUsd - (60 * 0.6 + 40 * 10 + 20 * 2.4 + 10 * 20) / 1e6) < 1e-12);
});

test("验证 key 发一个最小的请求：0.1 秒静音、只要 1 个 token。文字请求不行，这几个模型要求带音频（实测 400）", async () => {
  // 只要 1 个 token，它回的 finish_reason 就是 length：这不算失败
  const { fetch, requests } = fakeFetch(200, completion("", "length"));
  const { usage } = await createClient({ apiKey: "k", model: "gpt-audio-mini", fetch }).ping({});
  assert.deepEqual(usage, BILLED);
  const [{ body }] = requests;
  assert.equal(body.model, "gpt-audio-mini");
  assert.equal(body.max_completion_tokens, 1);
  const [part] = body.messages[0].content;
  assert.equal(part.type, "input_audio");
  assert.equal(part.input_audio.format, "wav");
  const wav = Buffer.from(part.input_audio.data, "base64");
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.ok(wav.length < 10_000);
});

/** 实测到的 OpenAI 报错：HTTP 状态码 + { error: { message, type, code } } */
async function failWith(status, error) {
  const { fetch } = fakeFetch(status, { error });
  const client = createClient({ apiKey: "k", model: "m", fetch });
  try {
    await client.ping({});
  } catch (thrown) {
    const classified = classifyError(thrown);
    // 说法按中文翻出来比
    return { thrown, classified: classified && { ...classified, problem: zh.text(classified.problem) } };
  }
  throw new Error("应该失败");
}

test("key 不对（401）或者账号没额度：都是换一把 key 能解决的", async () => {
  const invalid = await failWith(401, {
    message:
      "Incorrect API key provided: sk-proj-***0000. You can find your API key at https://platform.openai.com/account/api-keys.",
    type: "invalid_request_error",
    code: "invalid_api_key",
  });
  assert.deepEqual(invalid.classified, { kind: "key", problem: "这把 key 无效，检查有没有复制完整" });

  const broke = await failWith(429, {
    message: "You exceeded your current quota, please check your plan and billing details.",
    type: "insufficient_quota",
    code: "insufficient_quota",
  });
  assert.equal(broke.classified.kind, "key");
  assert.match(broke.classified.problem, /额度/);
});

test("限流和它那边出状况：暂时用不了，过一会儿再试", async () => {
  const limited = await failWith(429, { message: "Rate limit reached for requests.", code: "rate_limit_exceeded" });
  assert.deepEqual(limited.classified, {
    kind: "unavailable",
    problem: "OpenAI 暂时用不了（Rate limit reached for requests），过一会儿再试",
  });
  assert.equal((await failWith(503, { message: "Service unavailable." })).classified.kind, "unavailable");
});

test("模型名写错（404）和别的请求问题：说清是 OpenAI 拒绝的、它怎么说的", async () => {
  const missing = await failWith(404, {
    message: "The model `gpt-audio-9` does not exist or you do not have access to it.",
    type: "invalid_request_error",
    code: "model_not_found",
  });
  assert.equal(missing.classified.kind, "other");
  assert.match(missing.classified.problem, /^OpenAI 没有这个模型，或者这把 key 用不了它：The model `gpt-audio-9`/);

  const bad = await failWith(400, {
    message: "This model does not support the format you provided.",
    code: "unsupported_format",
  });
  assert.deepEqual(bad.classified, {
    kind: "other",
    problem: "OpenAI 拒绝了请求：This model does not support the format you provided",
  });
});

test("回的不是 JSON（比如中间的网关回了一页 HTML）也能说清状态码", async () => {
  const fetch = async () => new Response("<html>Bad Gateway</html>", { status: 502 });
  const client = createClient({ apiKey: "k", model: "m", fetch });
  const error = await client.ping({}).catch((thrown) => thrown);
  assert.match(error.message, /502/);
  assert.equal(classifyError(error).kind, "unavailable");
});

test("不是 OpenAI 回的报错不认，交给通用的分类", () => {
  assert.equal(classifyError(new TypeError("fetch failed")), null);
});

test("所在地区不支持（403 unsupported_country_region_territory）：是网络出口的问题，不叫人换 key", async () => {
  const region = await failWith(403, {
    message: "Country, region, or territory not supported",
    type: "request_forbidden",
    code: "unsupported_country_region_territory",
  });
  assert.equal(region.classified.kind, "unavailable");
  assert.match(region.classified.problem, /地区/);
  assert.match(region.classified.problem, /代理/);
});

test("回的不是 JSON 的 4xx（比如网关回 413）：说明里至少有状态码，不是一句空话", async () => {
  for (const status of [400, 413]) {
    const fetch = async () => new Response("<html>nope</html>", { status });
    const error = await createClient({ apiKey: "k", model: "m", fetch })
      .ping({})
      .catch((thrown) => thrown);
    assert.match(zh.text(classifyError(error).problem), new RegExp(`HTTP ${status}$`));
  }
});
