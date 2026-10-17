// DeepSeek 的价目表和算钱的规矩。照官方价目页 https://api-docs.deepseek.com/quick_start/pricing 抄的（2026-10-16）。
// 规矩（都是价目页上写的）：
//   - 输入分命中缓存和未命中两个价，输出一个价；思考的 token 算在输出里
//   - 分高峰和低谷：周一到周五 UTC 01:00–04:00、06:00–10:00 是高峰，其余时间是低谷，低谷价是高峰的一半
//   - 中国的法定节假日全天按低谷算。哪天放假这里不知道，节假日的高峰时段会按高峰价算，多算一点
// 价格的单位是美元每百万 token。改价时照官方页改这里，并更新上面的日期。

const PER_MILLION = 1_000_000;

/** 高峰价。低谷是它的一半 */
const FLASH = { input: 0.3, cached: 0.006, output: 1.2 };
export const PRICES = Object.freeze({
  "deepseek-flash": FLASH,
  "deepseek-v4-pro": { input: 1.32, cached: 0.044, output: 3.96 },
  // 旧名字还收，官方说由 V4.1-Flash 处理、按 Flash 的价收
  "deepseek-v4-flash": FLASH,
  "deepseek-v4-flash-vision-exp": FLASH,
});

/** 高峰的几段（UTC 的小时，左闭右开） */
const PEAK_HOURS = [
  [1, 4],
  [6, 10],
];

/** 这一刻是不是高峰（不知道节假日，见上面） */
export function isPeak(at) {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return PEAK_HOURS.some(([from, to]) => hour >= from && hour < to);
}

/**
 * 一次调用花了多少美元。价目表里没有这个型号时是 null。
 * @param {{ input: number, cached: number, output: number }} tokens input 是没命中缓存的那部分
 * @param {Date} at 什么时候调的
 */
export function costOf(model, tokens, at) {
  const price = PRICES[model];
  if (!price) return null;
  const rate = isPeak(at) ? 1 : 0.5;
  return (
    ((tokens.input * price.input + tokens.cached * price.cached + tokens.output * price.output) * rate) / PER_MILLION
  );
}
