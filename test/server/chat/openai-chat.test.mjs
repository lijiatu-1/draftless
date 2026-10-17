import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { classifyError, createClient } from "../../../src/server/chat/openai-chat.mjs";
import { toModelError } from "../../../src/server/providers/errors.mjs";

const zh = createTranslator("zh-CN");

/** 假的 fetch：记下请求，按给定的状态码和内容回话（内容是字符串时原样回，比如网关的 HTML） */
function fakeFetch(status, body) {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch, requests };
}

/** DeepSeek 实测的用量（2026-10-16，关掉思考）：命中缓存的单列，prompt_tokens 是两者之和 */
const DEEPSEEK_USAGE = {
  prompt_tokens: 1043,
  completion_tokens: 14,
  total_tokens: 1057,
  prompt_tokens_details: { cached_tokens: 1000 },
  prompt_cache_hit_tokens: 1000,
  prompt_cache_miss_tokens: 43,
};

const completion = (content, finish_reason = "stop", { usage = DEEPSEEK_USAGE, ...message } = {}) => ({
  model: "deepseek-flash",
  choices: [{ index: 0, finish_reason, message: { role: "assistant", content, ...message } }],
  usage,
});

const BASE = "https://api.deepseek.com";
const AT = new Date("2026-10-17T12:00:00Z");

test("润色：系统提示词和原文分两条发，带上这一家要的参数；回的是原文、用量和花费", async () => {
  const { fetch, requests } = fakeFetch(200, completion("我们后天下午开会。"));
  const costOf = (model, tokens, at) => {
    assert.equal(model, "deepseek-flash");
    assert.deepEqual(tokens, { input: 43, cached: 1000, output: 14 });
    assert.equal(at, AT);
    return 0.0001;
  };
  const client = createClient({
    baseUrl: BASE,
    apiKey: "sk-test",
    model: "deepseek-flash",
    request: { thinking: { type: "disabled" } },
    costOf,
    now: () => AT,
    fetch,
  });
  const signal = new AbortController().signal;
  const reply = await client.complete({ system: "系统提示词", user: "原文", signal });
  assert.deepEqual(reply, {
    text: "我们后天下午开会。",
    problem: null,
    usage: {
      model: "deepseek-flash",
      inputTokens: 1043,
      audioTokens: 0,
      cachedTokens: 1000,
      outputTokens: 14,
      thinkingTokens: 0,
      costUsd: 0.0001,
    },
  });
  const [{ url, init, body }] = requests;
  assert.equal(url, "https://api.deepseek.com/chat/completions");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, "Bearer sk-test");
  assert.equal(init.signal, signal);
  assert.deepEqual(body, {
    model: "deepseek-flash",
    thinking: { type: "disabled" },
    messages: [
      { role: "system", content: "系统提示词" },
      { role: "user", content: "原文" },
    ],
  });
});

test("别家只报 prompt_tokens_details.cached_tokens 时也认得出命中缓存的；不知道价时花费是空", async () => {
  const usage = { prompt_tokens: 500, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 128 } };
  const { fetch } = fakeFetch(200, completion("好的", "stop", { usage }));
  const client = createClient({ baseUrl: "https://x.example/v1", apiKey: "k", model: "m", fetch });
  const { usage: billed } = await client.complete({ system: "s", user: "u" });
  assert.equal(billed.cachedTokens, 128);
  assert.equal(billed.inputTokens, 500);
  assert.equal(billed.costUsd, null);
});

test("思考的 token 记下来；思考的内容不当成品", async () => {
  const usage = { ...DEEPSEEK_USAGE, completion_tokens: 348, completion_tokens_details: { reasoning_tokens: 334 } };
  const { fetch } = fakeFetch(200, completion("成品", "stop", { usage, reasoning_content: "想了很多" }));
  const client = createClient({ baseUrl: BASE, apiKey: "k", model: "deepseek-flash", fetch });
  const reply = await client.complete({ system: "s", user: "u" });
  assert.equal(reply.text, "成品");
  assert.equal(reply.usage.thinkingTokens, 334);
  assert.equal(reply.usage.outputTokens, 348);
});

test("被截断、被内容审核拦下、明说拒绝的：不给半截文字，说原因，用量照样带回去记账", async () => {
  for (const [finish, extra, pattern] of [
    ["length", {}, /没有正常结束：length/],
    ["content_filter", {}, /没有处理.*content_filter/],
    ["insufficient_system_resource", {}, /没有正常结束：insufficient_system_resource/],
    ["stop", { refusal: "不能做" }, /没有处理.*不能做/],
  ]) {
    const { fetch } = fakeFetch(200, completion("半截", finish, extra));
    const client = createClient({ baseUrl: BASE, apiKey: "k", model: "deepseek-flash", name: "DeepSeek", fetch });
    const reply = await client.complete({ system: "s", user: "u" });
    assert.equal(reply.text, null, finish);
    assert.match(zh.text(reply.problem), pattern);
    assert.match(zh.text(reply.problem), /DeepSeek/);
    assert.equal(reply.usage.inputTokens, 1043);
  }
});

test("验证：只要 1 个 token，回 length 不算失败", async () => {
  const { fetch, requests } = fakeFetch(200, completion("你", "length"));
  const client = createClient({
    baseUrl: BASE,
    apiKey: "k",
    model: "deepseek-flash",
    request: { thinking: { type: "disabled" } },
    fetch,
  });
  const { usage } = await client.ping({});
  assert.equal(usage.model, "deepseek-flash");
  assert.equal(requests[0].body.max_tokens, 1);
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
});

test("列模型：GET /models，回 id 的列表", async () => {
  const { fetch, requests } = fakeFetch(200, {
    object: "list",
    data: [
      { id: "deepseek-flash", object: "model" },
      { id: "deepseek-v4-pro", object: "model" },
    ],
  });
  const client = createClient({ baseUrl: BASE, apiKey: "k", model: "deepseek-flash", fetch });
  assert.deepEqual(await client.listModels({}), ["deepseek-flash", "deepseek-v4-pro"]);
  assert.equal(requests[0].url, "https://api.deepseek.com/models");
  assert.equal(requests[0].init.method, "GET");
  assert.equal(requests[0].init.headers.Authorization, "Bearer k");
});

/** 让适配器真去请求一次，拿到它抛的错，再按 errors.mjs 的规矩分类 */
async function failure(status, body, name = "DeepSeek") {
  const { fetch } = fakeFetch(status, body);
  const client = createClient({ baseUrl: BASE, apiKey: "sk-secret", model: "deepseek-flash", name, fetch });
  try {
    await client.complete({ system: "s", user: "u" });
  } catch (error) {
    const modelError = toModelError(error, {
      provider: { name },
      apiKey: "sk-secret",
      classify: (e) => classifyError(e, { name }),
    });
    return { kind: modelError.kind, problem: zh.text(modelError.problem) };
  }
  assert.fail("应该抛错");
}

const said = (message, code = "invalid_request_error") => ({ error: { message, type: code, code } });

test("报错按 DeepSeek 文档的状态码分类：401 key 不对、402 没余额、429 和 5xx 是暂时够不着", async () => {
  assert.deepEqual(await failure(401, said("Authentication Fails")), {
    kind: "key",
    problem: "这把 key 无效，检查有没有复制完整",
  });
  assert.equal((await failure(402, said("Insufficient Balance"))).kind, "key");
  assert.match((await failure(402, said("Insufficient Balance"))).problem, /额度/);
  for (const status of [429, 500, 503]) {
    const { kind, problem } = await failure(status, said("Server Overloaded"));
    assert.equal(kind, "unavailable", String(status));
    assert.match(problem, /DeepSeek 暂时用不了（Server Overloaded）/);
  }
});

test("模型名写错（实测 DeepSeek 回 400 并列出能用的名字）：原话照给", async () => {
  const { kind, problem } = await failure(
    400,
    said("The supported API model names are deepseek-flash, deepseek-v4-pro, but you passed deepseek-nope."),
  );
  assert.equal(kind, "other");
  assert.match(problem, /DeepSeek 拒绝了请求：The supported API model names are/);
});

test("404 回的不是 JSON：多半是地址写错了，叫人查地址，不说是模型的事", async () => {
  const { kind, problem } = await failure(404, "<html>Not Found</html>", "api.example.com");
  assert.equal(kind, "other");
  assert.match(problem, /api\.example\.com/);
  assert.match(problem, /地址/);
});

test("404 说的是模型：照模型找不到说", async () => {
  const { problem } = await failure(404, said("The model `x` does not exist", "model_not_found"));
  assert.match(problem, /没有这个模型/);
});

test("别家把报错写成一句字符串（Ollama 那样）也认得出原话", async () => {
  const { problem } = await failure(400, { error: "model 'qwen3' not found" }, "127.0.0.1:11434");
  assert.match(problem, /model 'qwen3' not found/);
});

test("不是这个适配器抛的错不认", () => {
  assert.equal(classifyError(new Error("别的"), { name: "DeepSeek" }), null);
});
