import { createTranslator } from "../../i18n/index.mjs";

// 页面上的字：按主进程给的界面语言翻（预加载脚本同步取来的 window.draftless.locale）。
// HTML 里写死的字不写字，只写名字：data-i18n 填进文字，data-i18n-<属性> 填进那个属性（title、aria-label、placeholder）。

/**
 * 这个页面现在用的翻译。悬浮条换语言时会换掉它（setLocale），所以别处用的时候每次都从这里取。
 * 页面以外（单元测试在 Node 里加载这些模块）没有 window，按默认语言
 */
export let t = createTranslator(globalThis.window?.draftless?.locale);

/** 换一种语言（悬浮条用：它不重新加载） */
export function setLocale(locale) {
  t = createTranslator(locale);
  document.documentElement.lang = t.locale;
}

/** 把 root 里标了 data-i18n 的地方按现在的语言填上。<template> 里的也填：照它克隆出来的（历史的每一行）就带着字了 */
export function localize(root = document) {
  document.documentElement.lang = t.locale;
  for (const node of root.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of root.querySelectorAll("*")) {
    for (const { name, value } of node.attributes) {
      if (name.startsWith("data-i18n-")) node.setAttribute(name.slice("data-i18n-".length), t(value));
    }
  }
  for (const template of root.querySelectorAll("template")) localize(template.content);
}

/** 一个热键在提示、键帽上写成什么 */
export const keycapOf = (hotkey) => t(`hotkeys.${hotkey}.keycap`);
