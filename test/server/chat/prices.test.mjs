import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf, isPeak } from "../../../src/server/chat/prices/deepseek.mjs";
import { PRICES as QWEN_PRICES, costOf as qwenCost } from "../../../src/server/chat/prices/qwen.mjs";

const TOKENS = { input: 1_000_000, cached: 1_000_000, output: 1_000_000 };
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("高峰：周一到周五 UTC 01:00–04:00、06:00–10:00；其余时间和周末是低谷", () => {
  // 2026-10-16 是周五
  assert.equal(isPeak(new Date("2026-10-16T01:00:00Z")), true);
  assert.equal(isPeak(new Date("2026-10-16T03:59:59Z")), true);
  assert.equal(isPeak(new Date("2026-10-16T04:00:00Z")), false);
  assert.equal(isPeak(new Date("2026-10-16T05:30:00Z")), false);
  assert.equal(isPeak(new Date("2026-10-16T09:59:00Z")), true);
  assert.equal(isPeak(new Date("2026-10-16T10:00:00Z")), false);
  assert.equal(isPeak(new Date("2026-10-17T02:00:00Z")), false, "周六");
  assert.equal(isPeak(new Date("2026-10-18T02:00:00Z")), false, "周日");
});

test("按官方价目表算：未命中、命中缓存、输出各一个价，低谷是高峰的一半", () => {
  close(costOf("deepseek-flash", TOKENS, new Date("2026-10-16T02:00:00Z")), 0.3 + 0.006 + 1.2);
  close(costOf("deepseek-flash", TOKENS, new Date("2026-10-17T02:00:00Z")), 0.15 + 0.003 + 0.6);
  close(costOf("deepseek-v4-pro", TOKENS, new Date("2026-10-16T02:00:00Z")), 1.32 + 0.044 + 3.96);
});

test("旧名字按 Flash 的价算（官方说这些请求由 V4.1-Flash 处理、按 Flash 收费）；不认识的型号是空", () => {
  const at = new Date("2026-10-16T02:00:00Z");
  assert.equal(costOf("deepseek-v4-flash", TOKENS, at), costOf("deepseek-flash", TOKENS, at));
  assert.equal(costOf("deepseek-nope", TOKENS, at), null);
});

// Qwen 润色那一跳的价目表也还没抄（官方页在 chat/prices/qwen.mjs 顶上的注释里）。
test("Qwen 润色的价目表还是空的：算不出钱就返回空，不瞎报一个数", () => {
  assert.deepEqual(QWEN_PRICES, {}, "补价格时同时改掉这条断言和 docs/verification.md");
  assert.equal(qwenCost("qwen-plus", TOKENS), null);
  assert.equal(qwenCost("qwen-max", TOKENS), null);
});
