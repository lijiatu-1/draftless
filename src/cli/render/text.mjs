// 命令行各个画面共用的排版：上色、按终端里占几格对齐、数字和时长的写法（按界面语言写）。

export const INDENT = "  ";

/** @param {boolean} color 输出的是不是一个支持颜色的终端 */
export function paint(color) {
  const wrap = (code) => (text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  return { bold: wrap(1), dim: wrap(2), green: wrap(32), red: wrap(31), yellow: wrap(33) };
}

/** 一个汉字或全角标点在终端里占两格 */
export function displayWidth(text) {
  let width = 0;
  for (const char of text) width += char.codePointAt(0) >= 0x2e80 ? 2 : 1;
  return width;
}

export const padEnd = (text, width) => text + " ".repeat(Math.max(0, width - displayWidth(text)));

/**
 * 左边一列名字、右边一列值的几行，名字按最宽的那个对齐（不同语言的名字长短不一）
 * @param {Array<[label: string, value: string]>} entries
 */
export function rows(entries) {
  const width = Math.max(10, ...entries.map(([label]) => displayWidth(label) + 2));
  return entries.map(([label, value]) => `${INDENT}${padEnd(label, width)}${value}`);
}

/** @param {Function} t 界面语言的翻译函数 */
export function duration(seconds, t) {
  const total = Math.round(seconds);
  if (total < 60) return t("units.seconds", { value: total });
  const minutes = Math.floor(total / 60);
  if (total < 3600) {
    return total % 60 === 0
      ? t("units.minutes", { minutes })
      : t("units.minutesSeconds", { minutes, seconds: total % 60 });
  }
  return t("units.hoursMinutes", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}
