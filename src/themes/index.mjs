// 登记在册的主题。界面和命令行都从这里拿，不直接引用某一套。
// 主题叫什么、一句话介绍在文案里（themes.<id>.name / describe），按界面语言写。

import { LOCALES } from "../i18n/index.mjs";
import cinnabar from "./cinnabar.mjs";
import indigo from "./indigo.mjs";
import ink from "./ink.mjs";

/** 按这个顺序列给用户看。加一套：照着 ink.mjs 写一个文件，在这里加一行，再给每种语言的文案添上它的名字和介绍 */
export const THEMES = [ink, cinnabar, indigo];

/** 没选过时用哪一套 */
export const DEFAULT_THEME = ink.id;

/**
 * 按 id 或者名字找，名字认哪种语言的都行（"cinnabar"、"朱砂"、"Cinnabar"）。
 * @returns {(typeof THEMES)[number] | null} 没有这一套时是 null
 */
export function findTheme(idOrName) {
  const named = (theme) => LOCALES.some(({ messages }) => messages.themes[theme.id]?.name === idOrName);
  return THEMES.find((theme) => theme.id === idOrName || named(theme)) ?? null;
}
