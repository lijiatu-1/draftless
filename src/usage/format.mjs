// 用量的写法：钱、token、个数、时长、等待时间。命令行（src/cli/render/usage.mjs）和主窗口共用，两边写法一致。
// 纯函数，不碰 Node 也不碰页面：窗口的页面直接 import 这个文件。带单位的按界面语言写，翻译函数由调用方给（src/i18n）。

/** 个数从小到大的缩写：千、百万、十亿 */
const COUNT_UNITS = ["K", "M", "B"];

/** 个数：按千、百万、十亿缩写成 K、M、B，留三位有效数字（1.39K、21.3K、6.02M）。首页的口述字数也这么写（原版是 194K 字） */
export function formatCount(count) {
  let value = count;
  let unit = "";
  for (const next of COUNT_UNITS) {
    // 按缩写之后的样子判断，999,600 才会写成 1M 而不是 1000K
    if (Number(value.toPrecision(3)) < 1000) break;
    value /= 1000;
    unit = next;
  }
  return `${Number(value.toPrecision(3))}${unit}`;
}

/** token 数，写法同 formatCount */
export const formatTokens = formatCount;

/**
 * 一段时长写成数和单位分开的两半（页面上单位写得小一号）：一小时以内按分钟，以上按小时，十小时以内带一位小数。
 * 原版首页的"节省时间""总口述时间"只用这两个单位
 * @returns {{ value: string, unit: "min" | "hr" }} unit 是文案里的名字：units.min、units.hr
 */
export function formatSpan(seconds) {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return { value: seconds > 0 && minutes === 0 ? "<1" : String(minutes), unit: "min" };
  const hours = seconds / 3600;
  return { value: String(hours < 10 ? Number(hours.toFixed(1)) : Math.round(hours)), unit: "hr" };
}

/**
 * 美元。一次听写零点几分钱，留两位有效数字（$0.0011）；一块钱以上到分（$12.35）；不到万分之一的不细说。
 * 价格都是估算，多写几位也不更准
 */
export function formatUsd(usd) {
  if (usd === 0) return "$0";
  if (usd < 0.0001) return "<$0.0001";
  // 0.995 以上按两位有效数字会写成 1.0，改按到分写
  if (usd < 0.995) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * 等了多久：秒，一位小数
 * @param {(key: string, params: object) => string} t 界面语言的翻译函数
 */
export const formatSeconds = (ms, t) => t("units.seconds", { value: (ms / 1000).toFixed(1) });
