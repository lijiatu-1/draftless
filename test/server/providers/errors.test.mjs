import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { ModelError, toModelError } from "../../../src/server/providers/errors.mjs";

const zh = createTranslator("zh-CN");

const OpenAI = { name: "OpenAI" };

test("够不着厂商（没网、被取消）算暂时用不了，话里点名是哪一家", () => {
  for (const error of [new TypeError("fetch failed"), new DOMException("This operation was aborted", "AbortError")]) {
    const described = toModelError(error, { provider: OpenAI });
    assert.ok(described instanceof ModelError);
    assert.equal(described.kind, "unavailable");
    assert.equal(zh.text(described.problem), "连不上 OpenAI，检查网络后再试");
  }
});

test("各家自己认得的报错交给它分类；它不认得的，原话截短了给人看", () => {
  const classify = (error) => (error.status === 401 ? { kind: "key", problem: "这把 key 无效" } : null);
  const rejected = toModelError(Object.assign(new Error("401 nope"), { status: 401 }), { provider: OpenAI, classify });
  assert.deepEqual([rejected.kind, zh.text(rejected.problem), rejected.detail], ["key", "这把 key 无效", "401 nope"]);

  const unknown = toModelError(new Error("x".repeat(500)), { provider: OpenAI, classify });
  assert.equal(unknown.kind, "other");
  assert.ok(zh.text(unknown.problem).length <= 200);
  assert.equal(unknown.detail.length, 500);
});

test("报错里带着 key 本身时先抹掉：给用户看的话和留给日志的原文里都没有它", () => {
  // 实测：带换行的 key 交给 Gemini 的 SDK，报的就是这一句，引号里是整段输入
  const key = "line-one-SECRET\nline-two-SECRET";
  const leaked = new TypeError(`Headers.append: "${key}" is an invalid header value.`);
  const described = toModelError(leaked, { provider: OpenAI, apiKey: key });
  assert.doesNotMatch(zh.text(described.problem) + described.message + described.detail, /SECRET/);
  assert.match(described.detail, /invalid header value/);
});

test("已经分好类的原样交回，不再包一层", () => {
  const error = new ModelError({ kind: "key", problem: "这把 key 无效", detail: "401" });
  assert.equal(toModelError(error, { provider: OpenAI }), error);
});

test("超时单独说：是它太久没回话，不是网没通", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const described = toModelError(timeout, { provider: OpenAI });
  assert.equal(described.kind, "unavailable");
  assert.equal(zh.text(described.problem), "OpenAI 太久没回话，过一会儿再试");
});

test("连接中途被重置（响应读到一半断了、对方重置连接）也算暂时够不着，不说成请求被拒", () => {
  for (const error of [
    new TypeError("terminated"),
    Object.assign(new TypeError("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } }),
    Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    Object.assign(new Error("other side closed"), { cause: { code: "UND_ERR_SOCKET" } }),
  ]) {
    const described = toModelError(error, { provider: OpenAI });
    assert.equal(described.kind, "unavailable", error.message);
  }
});

test("留着原始报错的调用栈（抹掉 key）给日志：适配器自己出 bug 时找得到出处", () => {
  const key = "sk-SECRET";
  let original;
  try {
    null.content;
  } catch (error) {
    original = Object.assign(error, { message: `${error.message} ${key}` });
  }
  const described = toModelError(original, { provider: OpenAI, apiKey: key });
  assert.match(described.origin, /TypeError/);
  assert.match(described.origin, /errors\.test\.mjs/);
  assert.doesNotMatch(described.origin, /SECRET/);
});
