import assert from "node:assert/strict";
import { test } from "node:test";
import { renderConfig, renderThemes } from "../../../src/cli/render/settings.mjs";
import { THEMES } from "../../../src/themes/index.mjs";
import { plain, settings } from "./fixtures.mjs";

test("设置逐项列出现在的值、从哪来、能填什么，后面是文件在哪", () => {
  const text = renderConfig(
    {
      settings: {
        ...settings,
        hotkey: { value: "fn", source: "file" },
        model: { value: "gemini/gemini-3.8-flash", source: "env", env: "GEMINI_MODEL" },
      },
      paths: {
        home: "/home/.draftless",
        settingsFile: "/home/.draftless/settings.json",
        logFile: "/home/.draftless/logs/main.log",
      },
    },
    plain,
  );
  assert.match(text, /hotkey\s+fn\s+右 Shift 键/);
  // 能填的是 Windows 版的四个键；旧名字（fn、right_option 这些）只是读的时候认
  assert.match(text, /right_alt \/ right_ctrl \/ right_shift \/ right_win/);
  // 用的是改名前的环境变量：照实写它的名字
  assert.match(text, /model\s+gemini\/gemini-3\.8-flash\s+Gemini · 这次运行来自环境变量 GEMINI_MODEL/);
  assert.match(text, /thinking\s+MINIMAL\s+.*默认/);
  assert.match(text, /mode\s+native\s+原生：录音直接交给模型 · 默认/);
  assert.match(text, /native \/ local/);
  assert.match(text, /polish\s+deepseek\/deepseek-flash\s+默认/);
  assert.match(text, /customUrl\s+默认/);
  assert.match(text, /modelSource\s+cn\s+国内源（draftless 的 CDN） · 默认/);
  assert.match(text, /cn \/ original/);
  assert.match(text, /theme\s+ink\s+墨 · 默认/);
  assert.match(text, /ink \/ cinnabar \/ indigo/);
  assert.match(text, /draftless config set hotkey right_win/);
  assert.match(text, /目录\s+\/home\/\.draftless\n/);
  assert.match(text, /\/home\/\.draftless\/logs\/main\.log/);
  assert.match(text, /draftless uninstall/);
});

test("主题：一行一套，现在用的那套打一个点；终端支持 24 位色时画出那一套悬浮条的样子", () => {
  const view = { themes: THEMES, setting: { value: "cinnabar", source: "file" } };
  const text = renderThemes(view, plain);
  assert.match(text, /^主题\n/);
  assert.match(text, /\n {4}ink\s+墨\s+黑白/);
  assert.match(text, /\n {2}● cinnabar\s+朱砂\s+一种暖红/);
  assert.match(text, /现在用的是朱砂（cinnabar） · 存在设置文件里/);
  // 举的例子是另一套，不是已经在用的这套
  assert.match(text, /换一套：draftless theme ink/);
  assert.ok(!text.includes("\x1b["));

  const painted = renderThemes(view, { ...plain, color: true, truecolor: true });
  // 朱砂的声波是那种暖红：oklch(0.74 0.17 32)
  assert.ok(painted.includes("\x1b[38;2;255;124;99m"), JSON.stringify(painted));
  assert.equal(painted.split("\x1b[48;2;").length - 1 >= THEMES.length, true);
  // 只开了普通颜色、没有 24 位色时不画
  assert.ok(!renderThemes(view, { ...plain, color: true, truecolor: false }).includes("[48;2;"));
});
