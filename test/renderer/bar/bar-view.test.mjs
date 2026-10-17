import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import { controlsIn, hintFor, LINGER_MS, View, viewOf } from "../../../src/renderer/bar/bar-view.mjs";

const zh = createTranslator("zh-CN");
const en = createTranslator("en");

import { Phase } from "../../../src/renderer/bar/machine.mjs";

const at = (phase, message = null) => ({ phase, held: false, message });

test("说话的三个阶段各有各的样子", () => {
  assert.equal(viewOf(at(Phase.STARTING), Phase.IDLE), View.STARTING);
  assert.equal(viewOf(at(Phase.RECORDING), Phase.STARTING), View.RECORDING);
  assert.equal(viewOf(at(Phase.FINISHING), Phase.RECORDING), View.FINISHING);
});

test("回到空闲：刚拿到成品就打个勾；取消了的直接消失；有话要说就显示那句话", () => {
  assert.equal(viewOf(at(Phase.IDLE), Phase.FINISHING), View.DONE);
  assert.equal(viewOf(at(Phase.IDLE), Phase.RECORDING), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE), Phase.STARTING), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE), Phase.IDLE), View.HIDDEN);
  assert.equal(viewOf(at(Phase.IDLE, "没有听到声音"), Phase.FINISHING), View.NOTICE);
  assert.equal(viewOf(at(Phase.IDLE, "还没有填 Gemini API key"), Phase.IDLE), View.NOTICE);
  assert.equal(viewOf(at(Phase.ERROR, "连不上 Gemini"), Phase.FINISHING), View.ERROR);
});

test("收尾的样子自己会消失，说话时的样子一直留着", () => {
  assert.equal(LINGER_MS[View.DONE] < LINGER_MS[View.NOTICE], true);
  assert.equal(LINGER_MS[View.NOTICE], LINGER_MS[View.ERROR]);
  for (const view of [View.STARTING, View.RECORDING, View.FINISHING, View.HIDDEN]) {
    assert.equal(LINGER_MS[view], undefined, view);
  }
});

test("上方的那行提示：告诉人现在在干什么、按哪个键；键名单独标出来", () => {
  const options = { keycap: "右⌥", cancellable: true };
  assert.deepEqual(hintFor(View.STARTING, options, zh), ["打开麦克风…"]);
  assert.deepEqual(hintFor(View.RECORDING, options, zh), [
    "再按一下 ",
    { key: "右⌥" },
    " 完成 · ",
    { key: "esc" },
    " 取消",
  ]);
  assert.deepEqual(hintFor(View.FINISHING, options, zh), ["整理中"]);
  for (const view of [View.DONE, View.NOTICE, View.ERROR, View.HIDDEN])
    assert.deepEqual(hintFor(view, options, zh), []);
});

test("英文的提示：键在句子里的位置照英文的说法", () => {
  assert.deepEqual(hintFor(View.RECORDING, { keycap: "Right ⌥", cancellable: true }, en), [
    "Press ",
    { key: "Right ⌥" },
    " to finish · ",
    { key: "esc" },
    " to cancel",
  ]);
  assert.deepEqual(hintFor(View.STARTING, { keycap: "fn", cancellable: true }, en), ["Opening microphone…"]);
});

test("取消不了的时候（没有辅助功能权限，截不住 esc）提示里不提 esc", () => {
  assert.deepEqual(hintFor(View.RECORDING, { keycap: "fn", cancellable: false }, zh), [
    "再按一下 ",
    { key: "fn" },
    " 完成",
  ]);
});

test("哪个样子下哪个按钮点得动：打开麦克风时只能取消，正在听时取消和完成都行，别的时候都点不动", () => {
  assert.deepEqual(controlsIn(View.STARTING), ["cancel"]);
  assert.deepEqual(controlsIn(View.RECORDING), ["cancel", "confirm"]);
  for (const view of [View.FINISHING, View.DONE, View.NOTICE, View.ERROR, View.HIDDEN]) {
    assert.deepEqual(controlsIn(view), [], view);
  }
});
