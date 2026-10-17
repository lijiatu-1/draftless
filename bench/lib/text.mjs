import { Converter } from "opencc-js/t2cn";

// 评测里比文字用的几样小工具。

const toSimplified = Converter({ from: "t", to: "cn" });

/**
 * 一段话是哪种语言：zh 只有中文，en 只有英文，mixed 是中文夹着英文词。两个字母以上才算英文词，
 * "B 站""A 股"这种单个字母不算。既没有汉字也没有字母（只有数字、标点）的是 null。
 */
export function languageOf(text) {
  const han = /\p{Script=Han}/u.test(text);
  if (han) return /[A-Za-z]{2,}/.test(text) ? "mixed" : "zh";
  return /[A-Za-z]/.test(text) ? "en" : null;
}

/** 比字面之前先抹平不影响意思的差别：繁简、大小写、标点、空白 */
const normalize = (text) =>
  toSimplified(text)
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, "");

/**
 * 两段话字面上有多像：1 是一字不差，0 是完全不同（按字算的编辑距离）。
 * 参照是整理过的成品（删了口头禅、改口），本地模型给的是原样转写，所以就算全对也到不了 1；
 * 它只用来在候选之间横着比，也用来给判官的打分做个旁证。
 */
export function similarity(a, b) {
  const [x, y] = [[...normalize(a)], [...normalize(b)]];
  if (x.length === 0 && y.length === 0) return 1;
  let previous = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const current = [i];
    for (let j = 1; j <= y.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return 1 - previous[y.length] / Math.max(x.length, y.length);
}
