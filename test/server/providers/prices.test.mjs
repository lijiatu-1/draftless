import assert from "node:assert/strict";
import { test } from "node:test";
import { costOf as geminiCost, storageCostOf } from "../../../src/server/providers/prices/gemini.mjs";
import { costOf as openaiCost } from "../../../src/server/providers/prices/openai.mjs";
import { costOf as qwenCost } from "../../../src/server/providers/prices/qwen.mjs";

const OCT = new Date("2026-10-14T08:00:00Z");
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

// 一次真实的听写请求（2026-10-14 实测）：系统提示词 1365 个文字 token，1 秒录音 25 个音频 token，回了 4 个 token
const DICTATION = { text: 1365, audio: 25, cachedText: 0, cachedAudio: 0, output: 4 };

test("Gemini 3.6 Flash：输入不分文字音频一个价，输出一个价；2027 年起翻倍", () => {
  close(geminiCost("gemini-3.6-flash", DICTATION, OCT), (1390 * 0.75 + 4 * 3.75) / 1e6);
  close(geminiCost("gemini-3.6-flash", DICTATION, new Date("2026-12-31T23:59:59Z")), (1390 * 0.75 + 4 * 3.75) / 1e6);
  close(geminiCost("gemini-3.6-flash", DICTATION, new Date("2027-01-01T00:00:00Z")), (1390 * 1.5 + 4 * 7.5) / 1e6);
});

test("Gemini 分开定价的型号：音频比文字贵；命中缓存的那部分按缓存价，音频文字也分开", () => {
  close(geminiCost("gemini-2.5-flash", DICTATION, OCT), (1365 * 0.3 + 25 * 1 + 4 * 2.5) / 1e6);
  const cached = { text: 1365, audio: 25, cachedText: 1024, cachedAudio: 25, output: 4 };
  close(geminiCost("gemini-2.5-flash", cached, OCT), (341 * 0.3 + 1024 * 0.03 + 25 * 0.1 + 4 * 2.5) / 1e6);
});

test("Gemini Pro：提示词超过 20 万 token 时整次按高的那档", () => {
  const short = { text: 200_000, audio: 0, cachedText: 0, cachedAudio: 0, output: 1000 };
  const long = { ...short, text: 200_001 };
  close(geminiCost("gemini-2.5-pro", short, OCT), (200_000 * 1.25 + 1000 * 10) / 1e6);
  close(geminiCost("gemini-2.5-pro", long, OCT), (200_001 * 2.5 + 1000 * 15) / 1e6);
});

test("Gemini 已停用、请求被转走的型号按转去的那个算；价目表里没有的是 null", () => {
  assert.equal(geminiCost("gemini-3.5-flash", DICTATION, OCT), geminiCost("gemini-3.6-flash", DICTATION, OCT));
  assert.equal(geminiCost("gemini-3.7-flash", DICTATION, OCT), geminiCost("gemini-3.8-flash", DICTATION, OCT));
  assert.equal(geminiCost("gemini-9-ultra", DICTATION, OCT), null);
});

test("Gemini 显式缓存的存储费：按缓存的 token 数和存多久算，每百万 token 每小时；2027 年起 Flash 的也翻倍", () => {
  // 1350 个 token 存半小时
  close(storageCostOf("gemini-3.6-flash", 1350, 0.5, OCT), (1350 * 0.5 * 0.5) / 1e6);
  close(storageCostOf("gemini-3.6-flash", 1350, 0.5, new Date("2027-01-01T00:00:00Z")), (1350 * 1 * 0.5) / 1e6);
  close(storageCostOf("gemini-2.5-pro", 1000, 2, OCT), (1000 * 4.5 * 2) / 1e6);
  // 不支持显式缓存的（4 Argon 只有隐式缓存）和价目表里没有的：算不出来
  assert.equal(storageCostOf("gemini-4-argon", 1350, 1, OCT), null);
  assert.equal(storageCostOf("gemini-9-ultra", 1350, 1, OCT), null);
});

test("OpenAI gpt-audio：文字和音频各一个价，输入输出分开；响应里带日期的快照名按型号查价", () => {
  // 实测：gpt-audio-mini 回的是 gpt-audio-mini-2025-12-15，1522 个文字 token、10 个音频 token，回了 4 个
  const tokens = { text: 1522, audio: 10, textOutput: 4, audioOutput: 0 };
  const expected = (1522 * 0.6 + 10 * 10 + 4 * 2.4) / 1e6;
  close(openaiCost("gpt-audio-mini-2025-12-15", tokens), expected);
  close(openaiCost("gpt-audio-mini", tokens), expected);
  close(
    openaiCost("gpt-audio-1.5", { text: 1000, audio: 100, textOutput: 10, audioOutput: 5 }),
    (1000 * 2.5 + 100 * 32 + 10 * 10 + 5 * 64) / 1e6,
  );
  assert.equal(openaiCost("gpt-9-audio", tokens), null);
});

// 百炼控制台的模型卡片标的是人民币每百万 token（2026-10-17，用户截图）：
//   qwen3.8-omni-flash  输入 ¥0.8 / 输出 ¥2.7
//   qwen3.5-omni-plus   输入 ¥7   / 输出 ¥40
// 表里按 7.2 的汇率换成美元（跟别家一样用美元）。卡片没细分文字和音频，两个都按输入价算。
const usdOf = (yuan) => yuan / 7.2 / 1e6;

test("Qwen omni 按百炼的人民币标价算钱（换算成美元）", () => {
  close(
    qwenCost("qwen3.5-omni-plus", { text: 1308, audio: 289, textOutput: 69, audioOutput: 0 }),
    (1308 + 289) * usdOf(7) + 69 * usdOf(40),
  );
  close(
    qwenCost("qwen3.8-omni-flash", { text: 1344, audio: 289, textOutput: 5530, audioOutput: 0 }),
    (1344 + 289) * usdOf(0.8) + 5530 * usdOf(2.7),
  );
  // 带日期的快照名按型号查价
  close(
    qwenCost("qwen3.5-omni-plus-2026-03-15", { text: 1000, audio: 0, textOutput: 100, audioOutput: 0 }),
    qwenCost("qwen3.5-omni-plus", { text: 1000, audio: 0, textOutput: 100, audioOutput: 0 }),
  );
  // 表里没有的型号宁可算不出，也不瞎报
  assert.equal(qwenCost("qwen-omni-turbo", { text: 1000, audio: 0, textOutput: 20, audioOutput: 0 }), null);
});

test("思考 token 按输出价算，所以单价贵 9–15 倍的 plus 实际更便宜", () => {
  // 同一条 41.3 秒录音的两次实测用量：flash 把 5530 个 token 花在输出上，其中 5459 是思考
  const plus = qwenCost("qwen3.5-omni-plus", { text: 1308, audio: 289, textOutput: 69, audioOutput: 0 });
  const flash = qwenCost("qwen3.8-omni-flash", { text: 1344, audio: 289, textOutput: 5530, audioOutput: 0 });
  assert.ok(plus < flash, `plus ${plus} 应该比 flash ${flash} 便宜`);
});
