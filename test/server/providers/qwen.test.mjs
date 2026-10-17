import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { createClient as createAudioClient } from "../../../src/server/providers/openai-audio.mjs";
import { AUDIO_TYPES, baseUrl, classifyError, createClient } from "../../../src/server/providers/qwen.mjs";

// Qwen 走百炼的 OpenAI 兼容模式：请求形状和 OpenAI 一样，所以共用的那部分不再重复测
// （openai.test.mjs 管），这里只测 Qwen 自己的几件事：地址、默认型号、录音格式、报错怎么认。
// 没有真的百炼 key，所以全部用假 fetch；真 key 的端到端见 docs/verification.md。

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

const USAGE = {
  prompt_tokens: 1200,
  completion_tokens: 20,
  total_tokens: 1220,
  prompt_tokens_details: { cached_tokens: 0, audio_tokens: 350 },
  completion_tokens_details: { reasoning_tokens: 0, audio_tokens: 0 },
};

const completion = (content, finish_reason = "stop") => ({
  model: "qwen3.5-omni-plus",
  choices: [{ finish_reason, message: { role: "assistant", content, refusal: null } }],
  usage: USAGE,
});

const WAV = Buffer.from("RIFF fake wav");

/** 一次成功的整理：省得每条测试都写一遍 */
async function generateOnce({ env = {}, model = "qwen3.5-omni-plus", body = completion("整理好的文字") } = {}) {
  const previous = process.env.DRAFTLESS_QWEN_BASE_URL;
  if ("DRAFTLESS_QWEN_BASE_URL" in env) process.env.DRAFTLESS_QWEN_BASE_URL = env.DRAFTLESS_QWEN_BASE_URL;
  try {
    const { fetch, requests } = fakeFetch(200, body);
    const client = createClient({ apiKey: "sk-test", model, fetch });
    const reply = await client.generate({
      audio: WAV,
      mimeType: "audio/wav",
      systemPrompt: "你是整理助手",
      reminder: "整理上面这段",
      signal: new AbortController().signal,
    });
    return { request: requests[0], reply };
  } finally {
    if (previous === undefined) delete process.env.DRAFTLESS_QWEN_BASE_URL;
    else process.env.DRAFTLESS_QWEN_BASE_URL = previous;
  }
}

test("只收 wav：我们的录音是 webm/opus，refiner 会先转好再交过来", () => {
  assert.deepEqual(AUDIO_TYPES, ["audio/wav"]);
});

test("地址是百炼的 OpenAI 兼容模式；国际站用 DRAFTLESS_QWEN_BASE_URL 换", () => {
  assert.equal(baseUrl({}), "https://dashscope.aliyuncs.com/compatible-mode/v1");
  // 结尾多个斜杠不算错，别拼出 //chat/completions
  assert.equal(baseUrl({ DRAFTLESS_QWEN_BASE_URL: "https://x.example/v1/" }), "https://x.example/v1");
  assert.equal(
    baseUrl({ DRAFTLESS_QWEN_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" }),
    "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
  );
  // 空字符串当作没设
  assert.equal(baseUrl({ DRAFTLESS_QWEN_BASE_URL: "   " }), "https://dashscope.aliyuncs.com/compatible-mode/v1");
});

test("整理：请求打到 /chat/completions，带系统提示词、wav 的录音、跟在录音后面那句话", async () => {
  const { request } = await generateOnce();
  assert.equal(request.url, "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions");
  assert.equal(request.init.headers.Authorization, "Bearer sk-test");
  assert.equal(request.body.model, "qwen3.5-omni-plus");
  // 只要文字：omni 默认可能连语音一起出
  assert.deepEqual(request.body.modalities, ["text"]);
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(request.body.messages[0].content, "你是整理助手");
  const parts = request.body.messages[1].content;
  assert.deepEqual(
    parts.map((part) => part.type),
    ["input_audio", "text"],
  );
  assert.equal(parts[0].input_audio.format, "wav");
  assert.equal(parts[1].text, "整理上面这段");
});

test("录音要写成 data URI：百炼把 data 当 URL 解析，纯 base64 会回 400（实测）", async () => {
  const { request } = await generateOnce();
  const { data, format } = request.body.messages[1].content[0].input_audio;
  // 这就是 2026-10-17 那次真 key 诊断得出的结论：只有这个形状通
  assert.equal(data, `data:audio/wav;base64,${WAV.toString("base64")}`);
  assert.match(data, /^data:audio\/wav;base64,/);
  assert.equal(format, "wav");
});

test("不带任何思考预算：plus 档自己不思考，护栏是多余的", async () => {
  // 这一段推翻过好几轮实现：先按合成语音估 384，再调到 1024、按秒算，都是在拟合现象。
  // 真正的原因是模型选错了——qwen3.8-omni-flash 会思考失控（同一条录音 1304–3114 个 token、
  // 16–36 秒），换成 qwen3.5-omni-plus 是 0 个思考 token、1.4–2.4 秒，质量还更好。
  const { request } = await generateOnce();
  assert.equal("thinking_budget" in request.body, false);
});

test("验 key 那一步不带任何额外参数：ping 只要 1 个 token", async () => {
  // 曾经因为把 thinking_budget 摊进所有请求，ping 被百炼拒过：
  // <400> max_completion_tokens [1] must be greater than thinking_budget [384]
  const { fetch, requests } = fakeFetch(200, completion(""));
  const client = createClient({ apiKey: "sk-test", model: "qwen3.5-omni-plus", fetch });
  await client.ping({ signal: new AbortController().signal });
  assert.equal(requests[0].body.max_completion_tokens, 1);
  assert.equal("thinking_budget" in requests[0].body, false);
});

test("OpenAI 那条路不要带 thinking_budget：那是百炼的参数，别家不认", async () => {
  // 共用的适配器默认不加任何额外参数，只有 qwen.mjs 显式传了才有
  const { fetch, requests } = fakeFetch(200, completion("好"));
  const client = createAudioClient({
    endpoint: "https://api.openai.com/v1/chat/completions",
    name: "OpenAI",
    apiKey: "sk-test",
    model: "gpt-audio-mini",
    fetch,
  });
  await client.generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "s",
    reminder: "r",
    signal: new AbortController().signal,
  });
  assert.equal("thinking_budget" in requests[0].body, false);
  // 而且 OpenAI 还是纯 base64，不是 data URI
  assert.equal(requests[0].body.messages[1].content[0].input_audio.data, WAV.toString("base64"));
});

test("验证 key 时那 0.1 秒静音也要写成 data URI，还要一次最小的音频请求（omni 不收纯文字）", async () => {
  const { fetch, requests } = fakeFetch(200, completion(""));
  const client = createClient({ apiKey: "sk-test", model: "qwen3.5-omni-plus", fetch });
  const result = await client.ping({ signal: new AbortController().signal });
  // 只要 1 个 token：这一步是验 key，不是要它说话
  assert.equal(requests[0].body.max_completion_tokens, 1);
  const [part] = requests[0].body.messages[0].content;
  assert.equal(part.type, "input_audio");
  // key 检查这一步也得是 data URI，否则第一关就过不了，用户连保存都保存不下来
  assert.match(part.input_audio.data, /^data:audio\/wav;base64,/);
  assert.equal(part.input_audio.format, "wav");
  assert.equal(result.usage.inputTokens, 1200);
});

test("DRAFTLESS_QWEN_BASE_URL 换掉地址时，请求真的打到那儿", async () => {
  const { request } = await generateOnce({ env: { DRAFTLESS_QWEN_BASE_URL: "https://gateway.example/v1" } });
  assert.equal(request.url, "https://gateway.example/v1/chat/completions");
});

test("回话里的文字和用量都带回来；没报型号按请求的；花费按百炼的价算", async () => {
  const { reply } = await generateOnce();
  assert.equal(reply.text, "整理好的文字");
  assert.equal(reply.problem, null);
  // 花费单独用容差比：它是几个除法叠出来的，末位差 1e-18 不该算失败（deepEqual 会算）
  const { costUsd, ...rest } = reply.usage;
  assert.deepEqual(rest, {
    model: "qwen3.5-omni-plus",
    inputTokens: 1200,
    audioTokens: 350,
    cachedTokens: 0,
    outputTokens: 20,
    thinkingTokens: 0,
  });
  // 按 prices/qwen.mjs 里那条（¥7 输入 / ¥40 输出，换算成美元）算出来的
  const expected = (850 + 350) * (7 / 7.2 / 1e6) + 20 * (40 / 7.2 / 1e6);
  assert.ok(Math.abs(costUsd - expected) < 1e-12, `${costUsd} ≠ ${expected}`);
});

test("被截断的回话不能当成品：说清是 Qwen 没说完", async () => {
  const { reply } = await generateOnce({ body: completion("说到一半", "length") });
  assert.equal(reply.text, null);
  assert.match(zh.text(reply.problem), /^Qwen 没有正常结束/);
  assert.match(zh.text(reply.problem), /length/);
});

test("modalities 关得掉：百炼若不认这个字段，改 qwen.mjs 那一行就行", async () => {
  const { fetch, requests } = fakeFetch(200, completion("好"));
  const client = createAudioClient({
    endpoint: "https://x.example/v1/chat/completions",
    name: "Qwen",
    apiKey: "sk-test",
    model: "qwen3.5-omni-plus",
    modalities: null,
    fetch,
  });
  await client.generate({
    audio: WAV,
    mimeType: "audio/wav",
    systemPrompt: "s",
    reminder: "r",
    signal: new AbortController().signal,
  });
  assert.equal("modalities" in requests[0].body, false);
});

test("key 不对、模型没有、限流、别的问题：都说成 Qwen 的名字", async () => {
  const cases = [
    { status: 401, body: { error: { code: "invalid_api_key", message: "Incorrect API key" } }, kind: "key" },
    { status: 404, body: { error: { code: "model_not_found", message: "Model not exist" } }, kind: "other" },
    { status: 429, body: { error: { message: "Requests rate limit exceeded" } }, kind: "unavailable" },
    { status: 500, body: { error: { message: "internal" } }, kind: "unavailable" },
    { status: 400, body: { error: { message: "bad request" } }, kind: "other" },
  ];
  for (const { status, body, kind } of cases) {
    const { fetch } = fakeFetch(status, body);
    const client = createClient({ apiKey: "sk-test", model: "qwen3.5-omni-plus", fetch });
    // 两个参数的 then：成功时判失败，失败时把那个错接住
    const error = await client.ping({ signal: new AbortController().signal }).then(
      () => assert.fail(`${status} 该报错`),
      (thrown) => thrown,
    );
    const classified = classifyError(error);
    assert.equal(classified.kind, kind, `${status} 应该是 ${kind}`);
    assert.match(zh.text(classified.problem), /Qwen|这把 key/, `${status} 的说法里要能看出是哪一家`);
  }
});

test("不是 Qwen 回的报错不认，交给通用的分类", () => {
  assert.equal(classifyError(new TypeError("fetch failed")), null);
});
