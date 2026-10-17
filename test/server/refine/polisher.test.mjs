import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator, msg } from "../../../src/i18n/index.mjs";
import { ModelError } from "../../../src/server/providers/errors.mjs";
import { POLISH_PROMPT, polishInput } from "../../../src/server/refine/polish-prompt.mjs";
import { createChatPolisher, createPolisher } from "../../../src/server/refine/polisher.mjs";
import { NO_SPEECH_MARK } from "../../../src/server/refine/prompt.mjs";

const zh = createTranslator("zh-CN");
const quiet = { info() {}, warn() {}, error() {} };
const USAGE = {
  model: "deepseek-flash",
  inputTokens: 1043,
  audioTokens: 0,
  cachedTokens: 1000,
  outputTokens: 14,
  thinkingTokens: 0,
  costUsd: 0.0001,
};

/** 假的协议客户端：记下收到的请求，按顺序回给定的回话（是 Error 就抛） */
function fakeClient(...replies) {
  const requests = [];
  const client = {
    async ping(request) {
      requests.push({ ping: request });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply ?? { usage: USAGE };
    },
    async complete(request) {
      requests.push(request);
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  return { client, requests };
}

const polisherWith = (client, extra = {}) =>
  createPolisher({ endpoint: { id: "deepseek", name: "DeepSeek" }, client, log: quiet, ...extra });

test("提示词里写的无人声标记，和收尾判断的是同一个；原文放在标签里交过去", () => {
  assert.ok(POLISH_PROMPT.includes(`只输出 ${NO_SPEECH_MARK}，`));
  assert.ok(polishInput("原文").includes("<原文>\n原文\n</原文>"));
});

test("原文交给模型，成品照样经过收尾（繁转简、去句末句号）", async () => {
  const { client, requests } = fakeClient({ text: "這個 bug 我看了一下。", problem: null, usage: USAGE });
  const polisher = polisherWith(client);
  assert.equal(await polisher.polish("这个 bug 我我看了一下", { audioId: "a1" }), "这个 bug 我看了一下");
  assert.equal(requests[0].system, POLISH_PROMPT);
  assert.equal(requests[0].user, polishInput("这个 bug 我我看了一下"));
});

test("原文是空的（没转出字）：不调模型，成品是空的", async () => {
  const { client, requests } = fakeClient();
  const polisher = polisherWith(client);
  assert.equal(await polisher.polish("  \n", {}), "");
  assert.equal(requests.length, 0);
});

test("模型判断没有要输入的内容（输出标记）：成品是空的", async () => {
  const { client } = fakeClient({ text: NO_SPEECH_MARK, problem: null, usage: USAGE });
  assert.equal(await polisherWith(client).polish("嗯。", {}), "");
});

test("客户端断开时取消请求：交给协议客户端的 signal 跟着断", async () => {
  const { client, requests } = fakeClient({ text: "好", problem: null, usage: USAGE });
  const abort = new AbortController();
  await polisherWith(client).polish("好", { signal: abort.signal });
  assert.equal(requests[0].signal.aborted, false);
  abort.abort();
  assert.equal(requests[0].signal.aborted, true);
});

test("回了话但用不了（被截断）：先记账再报分好类的错", async () => {
  const calls = [];
  const problem = msg("model.unfinished", { provider: "DeepSeek", reason: "length" });
  const { client } = fakeClient({ text: null, problem, usage: USAGE });
  const polisher = polisherWith(client, { onCall: (call) => calls.push(call) });
  const error = await polisher.polish("原文", { audioId: "a1" }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(zh.text(error.problem), "DeepSeek 没有正常结束：length");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].purpose, "dictation");
  assert.equal(calls[0].audioId, "a1");
  assert.equal(calls[0].provider, "deepseek");
});

test("每次润色记一笔：哪次听写、哪家、多少 token、多少钱、多久", async () => {
  const calls = [];
  const { client } = fakeClient({ text: "好的", problem: null, usage: USAGE });
  await polisherWith(client, { onCall: (call) => calls.push(call) }).polish("好的", { audioId: "a9" });
  assert.equal(calls.length, 1);
  const { latencyMs, createdAt, ...call } = calls[0];
  assert.ok(Number.isInteger(latencyMs));
  assert.ok(!Number.isNaN(Date.parse(createdAt)));
  assert.deepEqual(call, { purpose: "dictation", audioId: "a9", provider: "deepseek", ...USAGE });
});

test("warmUp 发协议客户端的最小请求，记一笔验证；失败时同样分好类，报错里不带 key", async () => {
  const calls = [];
  const { client } = fakeClient({ usage: USAGE });
  await polisherWith(client, { onCall: (call) => calls.push(call) }).warmUp();
  assert.equal(calls[0].purpose, "check");

  const failing = fakeClient(new Error("connect ECONNREFUSED sk-secret"));
  failing.client.ping = async () => {
    const error = new Error("fetch failed");
    error.cause = { code: "ECONNREFUSED" };
    throw error;
  };
  const error = await polisherWith(failing.client, { apiKey: "sk-secret" })
    .warmUp()
    .catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(error.kind, "unavailable");
  assert.match(zh.text(error.problem), /连不上 DeepSeek/);
});

test("createChatPolisher：按选的厂商装上它的协议、地址、参数和价；请求真的发到那一家的地址", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "好的。" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 0 },
    });
  };
  const polisher = await createChatPolisher({
    choice: { vendor: "deepseek", model: "deepseek-flash" },
    apiKey: "sk-test",
    log: quiet,
    fetch,
  });
  assert.equal(await polisher.polish("好的", {}), "好的");
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
});

test("createChatPolisher：自定义的用设置里的地址，报错时称呼它的主机名；没填地址直接报错", async () => {
  const fetch = async () => new Response("<html>nope</html>", { status: 404 });
  const polisher = await createChatPolisher({
    choice: { vendor: "custom", model: "qwen3:8b" },
    customUrl: "http://127.0.0.1:11434/v1/",
    apiKey: "ollama",
    log: quiet,
    fetch,
  });
  const error = await polisher.polish("好的", {}).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.match(zh.text(error.problem), /127\.0\.0\.1:11434 的这个地址上没有对话接口/);

  await assert.rejects(createChatPolisher({ choice: { vendor: "custom", model: "m" }, apiKey: "k", log: quiet }), (e) =>
    /地址/.test(zh.text(e.problem)),
  );
});
