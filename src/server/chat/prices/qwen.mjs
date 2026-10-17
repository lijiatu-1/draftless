// Qwen（阿里云百炼）润色那一跳的价目表和算钱的规矩。
//
// **价格还没抄进来。** 官方价目页在 https://www.alibabacloud.com/help/en/model-studio/model-pricing
// （国内站 help.aliyun.com 的同名页）。抄的时候注意：国内站按人民币标价，这里是美元每百万 token；
// 有的型号分命中缓存和未命中两个输入价，有的只有一个。
//
// 没抄进来之前，PRICES 是空的：costOf 一律返回 null，首页的花费卡会把用过的型号列在"没定价"里
// （home.unpriced），token 照记。**不要先编一个数字填上** —— 记错的钱比记不出钱更糟。

const PER_MILLION = 1_000_000;

/**
 * 型号 → 价格，结构照 deepseek 那份：{ input, cached, output }。
 * 没有单独的缓存价时，cached 填和 input 一样的数。抄的日期写在这里：______
 */
export const PRICES = Object.freeze({});

/** 响应里报的是带日期的快照名时，去掉日期按型号查价 */
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/**
 * 一次调用花了多少美元。价目表里没有这个型号时是 null。
 * @param {string} model
 * @param {{ input: number, cached: number, output: number }} tokens input 是没命中缓存的那部分
 * @returns {number | null}
 */
export function costOf(model, tokens) {
  const price = PRICES[model] ?? PRICES[model.replace(SNAPSHOT, "")];
  if (!price) return null;
  return (tokens.input * price.input + tokens.cached * price.cached + tokens.output * price.output) / PER_MILLION;
}
