import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { formatCount, formatSeconds, formatSpan, formatTokens, formatUsd } from "../../src/usage/format.mjs";

const zh = createTranslator("zh-CN");
const en = createTranslator("en");

test("token 数按千、百万、十亿缩写成 K、M、B，留三位有效数字", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1394), "1.39K");
  assert.equal(formatTokens(21_300), "21.3K");
  assert.equal(formatTokens(350_400), "350K");
  // 进位到下一档时不写成 1000K
  assert.equal(formatTokens(999_600), "1M");
  assert.equal(formatTokens(6_020_000), "6.02M");
  assert.equal(formatTokens(1_250_000_000), "1.25B");
  assert.equal(formatTokens(3_000_000_000_000), "3000B");
});

test("钱：一次听写那种零点几分的留两位有效数字，一块钱以上到分；太小的说不到万分之一", () => {
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(0.0000015), "<$0.0001");
  assert.equal(formatUsd(0.0010575), "$0.0011");
  assert.equal(formatUsd(0.013), "$0.013");
  assert.equal(formatUsd(0.5), "$0.50");
  // 快到一块钱时不写成 $1.0
  assert.equal(formatUsd(0.998), "$1.00");
  assert.equal(formatUsd(12.346), "$12.35");
});

test("等待时间写成秒，一位小数，单位跟着界面语言", () => {
  assert.equal(formatSeconds(1700, zh), "1.7 秒");
  assert.equal(formatSeconds(640, zh), "0.6 秒");
  assert.equal(formatSeconds(12_000, zh), "12.0 秒");
  assert.equal(formatSeconds(1700, en), "1.7s");
});

test("个数和 token 一样缩写：首页的口述字数写成 194K", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(856), "856");
  assert.equal(formatCount(194_321), "194K");
  assert.equal(formatCount(1_250_000), "1.25M");
});

test("一段时长：一小时以内按分钟，以上按小时；十小时以内带一位小数。单位是文案里的名字（units.min / units.hr）", () => {
  assert.deepEqual(formatSpan(0), { value: "0", unit: "min" });
  assert.deepEqual(formatSpan(20), { value: "<1", unit: "min" });
  assert.deepEqual(formatSpan(90), { value: "2", unit: "min" });
  assert.deepEqual(formatSpan(59 * 60), { value: "59", unit: "min" });
  // 59 分 50 秒四舍五入是 60 分钟：写成 1 小时
  assert.deepEqual(formatSpan(59 * 60 + 50), { value: "1", unit: "hr" });
  assert.deepEqual(formatSpan(5400), { value: "1.5", unit: "hr" });
  assert.deepEqual(formatSpan(7200), { value: "2", unit: "hr" });
  assert.deepEqual(formatSpan(90 * 3600 + 1000), { value: "90", unit: "hr" });
  assert.deepEqual([zh("units.min"), en("units.hr")], ["分钟", "hr"]);
});
