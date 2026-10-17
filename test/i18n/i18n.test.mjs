import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createTranslator,
  DEFAULT_LOCALE,
  findLocale,
  LOCALES,
  LocalizedError,
  localesFromEnv,
  matchLocale,
  msg,
  problemOf,
  resolveLocale,
  SYSTEM_LOCALE,
} from "../../src/i18n/index.mjs";

const en = createTranslator("en");
const zh = createTranslator("zh-CN");

test("默认是英文；登记了英文和简体中文，名字用各自的语言写", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.deepEqual(
    LOCALES.map(({ id, name }) => [id, name]),
    [
      ["en", "English"],
      ["zh-CN", "简体中文"],
    ],
  );
});

test("按 id 找语言：大小写、_ 和 - 都不论；没有的是 null", () => {
  assert.equal(findLocale("zh_cn").id, "zh-CN");
  assert.equal(findLocale("EN").id, "en");
  assert.equal(findLocale("ja"), null);
  assert.equal(findLocale(undefined), null);
});

test("跟随系统：按偏好顺序找第一个有的，语言和文字都对上才算，都没有就用英文", () => {
  // 正：简体中文的几种写法都落到 zh-CN；英文不论哪个地区都是 en
  for (const tag of ["zh-Hans-CN", "zh-CN", "zh", "zh-SG", "zh_CN"]) assert.equal(matchLocale([tag]), "zh-CN", tag);
  for (const tag of ["en-US", "en-GB", "en"]) assert.equal(matchLocale([tag]), "en", tag);
  // 顺序：第一个有的赢
  assert.equal(matchLocale(["fr-FR", "zh-Hans-CN", "en-US"]), "zh-CN");
  assert.equal(matchLocale(["en-US", "zh-Hans-CN"]), "en");
  // 负：繁体不算简体，接着看下一个；都认不出就是英文
  assert.equal(matchLocale(["zh-TW", "zh-Hans-CN"]), "zh-CN");
  assert.equal(matchLocale(["zh-Hant-HK"]), "en");
  assert.equal(matchLocale(["ja-JP", "fr"]), "en");
  // 边界：空的、写法不对的
  assert.equal(matchLocale([]), "en");
  assert.equal(matchLocale(undefined), "en");
  assert.equal(matchLocale(["", "C", "not a tag!"]), "en");
});

test("终端的语言：LC_ALL 盖过 LC_MESSAGES 盖过 LANG；C 和 POSIX 是没说", () => {
  assert.deepEqual(localesFromEnv({ LANG: "zh_CN.UTF-8" }), ["zh-CN"]);
  assert.deepEqual(localesFromEnv({ LANG: "zh_CN.UTF-8", LC_MESSAGES: "en_US.UTF-8" }), ["en-US"]);
  assert.deepEqual(localesFromEnv({ LANG: "en_US.UTF-8", LC_ALL: "zh_CN.GB2312" }), ["zh-CN"]);
  assert.deepEqual(localesFromEnv({ LANG: "de_DE.UTF-8@euro" }), ["de-DE"]);
  assert.deepEqual(localesFromEnv({ LANG: "C" }), []);
  assert.deepEqual(localesFromEnv({ LC_ALL: "POSIX", LANG: "zh_CN.UTF-8" }), []);
  assert.deepEqual(localesFromEnv({ LANG: "  " }), []);
  assert.deepEqual(localesFromEnv({}), []);
});

test("设置里的语言：跟随系统时看系统，写了某种就用它，写了没有的退回英文", () => {
  assert.equal(SYSTEM_LOCALE, "system");
  assert.equal(resolveLocale("system", ["zh-Hans-CN"]), "zh-CN");
  assert.equal(resolveLocale("system", ["ja-JP"]), "en");
  assert.equal(resolveLocale("zh-CN", ["en-US"]), "zh-CN");
  assert.equal(resolveLocale("en", ["zh-Hans-CN"]), "en");
  assert.equal(resolveLocale("klingon", ["zh-Hans-CN"]), "en");
});

test("翻译：参数填进模板；不认识的语言按英文；找不到的名字原样返回", () => {
  assert.equal(en("tray.version", { version: "0.6.0" }), "Version 0.6.0");
  assert.equal(zh("tray.version", { version: "0.6.0" }), "版本 0.6.0");
  assert.equal(createTranslator("ja")("tray.version", { version: "1" }), "Version 1");
  assert.equal(createTranslator("ja").locale, "en");
  assert.equal(zh.locale, "zh-CN");
  assert.equal(en("no.such.key"), "no.such.key");
  // 没给的参数原样留着，看得出漏了
  assert.equal(en("tray.version"), "Version {version}");
});

test("单复数按 count 挑：英文分 one 和 other，中文只有一种", () => {
  assert.equal(en("units.days", { count: 1 }), "day");
  assert.equal(en("units.days", { count: 3 }), "days");
  assert.equal(en("units.days", { count: 0 }), "days");
  assert.equal(zh("units.days", { count: 1 }), "天");
});

test("参数可以又是一句话；t.text 认 msg、认现成的字、认 null", () => {
  const problem = msg("model.unreachable", { provider: "Gemini" });
  assert.equal(
    en("setup.blocker.keyRejected", { problem }),
    "API key not working: Can't reach Gemini. Check your network",
  );
  assert.equal(zh.text(problem), "连不上 Gemini，检查网络后再试");
  // 模型回的原话、旧版本后台报上来的中文：照原样
  assert.equal(en.text("models/x is not found"), "models/x is not found");
  assert.equal(en.text(null), "");
  assert.equal(en.text(undefined), "");
});

test("count 是个数：按语言写成 1,234 并据此挑单复数；别的参数里的数原样写（命令里的数不能加逗号）", () => {
  assert.equal(en("cli.status.dictations", { count: 1 }), "1 dictation");
  assert.equal(en("cli.status.dictations", { count: 12345 }), "12,345 dictations");
  assert.equal(zh("cli.status.dictations", { count: 12345 }), "12,345 次");
  assert.equal(en("cli.history.more", { shown: 20, total: 1234 }).includes("-n 1234"), true);
});

test("并列和数字按语言写；中文一律用顿号隔开（和原来的中文界面一样，英文字母不挨着“和”“或”）", () => {
  assert.equal(en.list(["A", "B", "C"]), "A, B, and C");
  assert.equal(zh.list(["Gemini API key", "按键监听"]), "Gemini API key、按键监听");
  assert.equal(zh.list(["A", "B", "C"]), "A、B、C");
  assert.equal(zh.either(["1（Gemini）", "2（OpenAI）"]), "1（Gemini）、2（OpenAI）");
  assert.equal(zh.list(["A"]), "A");
  assert.equal(zh.list([]), "");
  assert.equal(en.list([msg("setup.missing.microphone")]), "microphone access");
  assert.equal(en.either(["1 (Gemini)", "2 (OpenAI)"]), "1 (Gemini) or 2 (OpenAI)");
  assert.equal(en.number(12345), "12,345");
});

test("t.parts 不拼起来：参数留在原位，调用方可以把它画成键帽", () => {
  const keycap = { key: "Right ⌥" };
  assert.deepEqual(en.parts("bar.recording", { key: keycap, esc: { key: "esc" } }), [
    "Press ",
    keycap,
    " to finish · ",
    { key: "esc" },
    " to cancel",
  ]);
  assert.deepEqual(zh.parts("bar.recording", { key: keycap, esc: { key: "esc" } }), [
    "再按一下 ",
    keycap,
    " 完成 · ",
    { key: "esc" },
    " 取消",
  ]);
});

test("LocalizedError：problem 留着给显示的那端翻，message 是英文的进日志", () => {
  const error = new LocalizedError(msg("key.empty"));
  assert.ok(error instanceof Error);
  assert.equal(error.message, "No key entered");
  assert.deepEqual(error.problem, { key: "key.empty" });
  assert.equal(zh.text(problemOf(error)), "还没有填 key");
  // 别的错误用它自己的 message
  assert.equal(problemOf(new Error("磁盘满了")), "磁盘满了");
  assert.equal(problemOf("一句话"), "一句话");
});
