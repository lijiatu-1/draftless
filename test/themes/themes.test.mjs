import assert from "node:assert/strict";
import { test } from "node:test";
import { LOCALES } from "../../src/i18n/index.mjs";
import { contrast, toHex } from "../../src/themes/color.mjs";
import { BAR_TOKENS, themeCss, themeProblems, WINDOW_TOKENS } from "../../src/themes/contract.mjs";
import { DEFAULT_THEME, findTheme, THEMES } from "../../src/themes/index.mjs";

const clone = (theme) => structuredClone(theme);

test("颜色换算：黑、白、纯红都换得对，黑白之间的对比度是 21", () => {
  assert.equal(toHex("oklch(0 0 0)"), "#000000");
  assert.equal(toHex("oklch(1 0 0)"), "#ffffff");
  // sRGB 的纯红在 oklch 里的坐标
  assert.equal(toHex("oklch(0.62796 0.25768 29.234)"), "#ff0000");
  assert.equal(Math.round(contrast("oklch(0 0 0)", "oklch(1 0 0)")), 21);
  assert.equal(contrast("oklch(0.5 0.1 200)", "oklch(0.5 0.1 200)"), 1);
});

test("不是 oklch(亮度 彩度 色相) 的写法不认：算不了对比度的颜色不能进主题", () => {
  for (const value of ["#fff", "white", "oklch(0.5 0.1)", "oklch(1 0 0 / 0.16)", "oklch(1.2 0 0)", "", 3]) {
    assert.throws(() => toHex(value), /oklch/, String(value));
  }
});

test("登记在册的每套主题都合格：token 一个不缺，该读得清的地方都读得清", () => {
  assert.ok(THEMES.length >= 3);
  for (const theme of THEMES) assert.deepEqual(themeProblems(theme), [], theme.id);
});

test("id 和每种语言里的名字都不重复；默认的那一套在册；按 id 或按哪种语言的名字都找得到", () => {
  assert.equal(new Set(THEMES.map((theme) => theme.id)).size, THEMES.length);
  for (const { id, messages } of LOCALES) {
    assert.equal(new Set(THEMES.map((theme) => messages.themes[theme.id].name)).size, THEMES.length, id);
  }
  assert.deepEqual(
    THEMES.map((theme) => theme.id),
    ["ink", "cinnabar", "indigo"],
  );
  assert.equal(findTheme(DEFAULT_THEME).id, DEFAULT_THEME);
  assert.equal(findTheme("cinnabar").id, "cinnabar");
  assert.equal(findTheme("朱砂").id, "cinnabar");
  assert.equal(findTheme("Cinnabar").id, "cinnabar");
  assert.equal(findTheme("neon"), null);
  // 对象自带的属性名不是主题
  assert.equal(findTheme("constructor"), null);
});

test("朱砂：正在听和整理中是同一种红。整理中不能变回白色，那样看起来像主题没生效", () => {
  const { bar } = findTheme("cinnabar");
  assert.equal(bar.working, bar.live);
  assert.equal(bar.go, bar.live);
});

test("不合格的主题说得出毛病在哪：缺 token、多了不认识的、颜色写法不对、看不清", () => {
  const missing = clone(THEMES[0]);
  delete missing.bar.live;
  delete missing.window.dark.ink2;
  assert.deepEqual(themeProblems(missing), ["悬浮条少了 live", "窗口（深色）少了 ink2"]);

  const extra = clone(THEMES[0]);
  extra.bar.glow = "oklch(0.9 0.1 100)";
  assert.deepEqual(themeProblems(extra), ["悬浮条多了不认识的 glow"]);

  const malformed = clone(THEMES[0]);
  malformed.window.light.bg = "#ffffff";
  assert.match(themeProblems(malformed).join("\n"), /窗口（浅色）的 bg 要写成 oklch/);

  const faint = clone(THEMES[0]);
  faint.bar.muted = "oklch(0.3 0 0)";
  faint.window.light.ink2 = "oklch(0.8 0 0)";
  const problems = themeProblems(faint).join("\n");
  assert.match(problems, /悬浮条的 muted 叠在 surface 上看不清：对比度 [\d.]+，至少要 4\.5/);
  assert.match(problems, /窗口（浅色）的 ink2 叠在 bg 上看不清/);

  assert.match(themeProblems({ ...clone(THEMES[0]), id: "Ink 2" }).join("\n"), /id/);
  assert.deepEqual(themeProblems(null), ["主题要是一组数据"]);
});

test("窗口的渐变和光晕也要读得清：主按钮的字叠在渐变两头，正文和次要的字叠在两团光晕上", () => {
  for (const theme of THEMES) {
    for (const name of ["glow", "aura", "aura2"]) {
      assert.ok(Object.hasOwn(theme.window.light, name), `${theme.id} 浅色少了 ${name}`);
      assert.ok(Object.hasOwn(theme.window.dark, name), `${theme.id} 深色少了 ${name}`);
    }
  }
  const dim = clone(THEMES[0]);
  dim.window.light.glow = "oklch(0.9 0 0)";
  dim.window.light.aura2 = "oklch(0.4 0 0)";
  const problems = themeProblems(dim).join("\n");
  assert.match(problems, /窗口（浅色）的 onPrimary 叠在 glow 上看不清/);
  assert.match(problems, /窗口（浅色）的 ink 叠在 aura2 上看不清/);
  assert.match(problems, /窗口（浅色）的 ink2 叠在 aura2 上看不清/);
});

test("themeCss：悬浮条一组，窗口浅色一组，深色那组放在跟随系统的条件里；token 名按约定换成 CSS 变量名", () => {
  const theme = findTheme("ink");
  const css = themeCss(theme);
  const [base, dark] = css.split("@media (prefers-color-scheme: dark)");
  for (const name of Object.keys(BAR_TOKENS)) assert.ok(base.includes(`: ${theme.bar[name]};`), name);
  assert.match(base, new RegExp(`--bar-surface: ${theme.bar.surface.replace(/[()]/g, "\\$&")};`));
  assert.match(base, /--bar-on-go: /);
  assert.match(base, new RegExp(`--bg: ${theme.window.light.bg.replace(/[()]/g, "\\$&")};`));
  assert.match(base, /--ink-2: /);
  assert.match(base, /--on-primary: /);
  assert.doesNotMatch(dark, /--bar-/);
  for (const name of Object.keys(WINDOW_TOKENS)) assert.ok(dark.includes(`: ${theme.window.dark[name]};`), name);
  // 一共这么多条声明，不多不少
  const declarations = css.match(/--[a-z0-9-]+: /g);
  assert.equal(declarations.length, Object.keys(BAR_TOKENS).length + 2 * Object.keys(WINDOW_TOKENS).length);
});
