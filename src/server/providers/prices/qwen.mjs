// Qwen（阿里云百炼）的价目表和算钱的规矩。
//
// 数字来自百炼控制台的模型卡片（2026-10-17，用户截图给的），国内站标价是**人民币每百万 token**：
//
//   qwen3.8-omni-flash   输入 ¥0.8/M   输出 ¥2.7/M
//   qwen3.5-omni-plus    输入 ¥7/M     输出 ¥40/M
//
// 这里的单位跟着别家走（美元每百万 token），所以按 CNY_PER_USD 换算。
// 卡片上没细分"文字输入"和"音频输入"的价，两个都按同一个输入价算——如果百炼对音频另收高价，
// 这里算出来的会偏低，到时候照价目页补成 audio 那一半。
//
// 一个反直觉的结论，记在这里免得以后又按"单价便宜"去选型：
// **单价贵 9–15 倍的 plus，实际每次听写可能更便宜。** 因为 flash 会思考失控——
// 同一条 41.3 秒录音，flash 产出了 5530 个输出 token（其中 5459 是思考），plus 只有 69 个（不思考）。
// 算下来 flash ¥0.0162、plus ¥0.0139。思考 token 也算钱，而且是按输出价算的。

const PER_MILLION = 1_000_000;

/** 人民币换美元。百炼国内站标人民币，这份表跟别家一样用美元，改汇率时把日期一起改：2026-10-17 */
const CNY_PER_USD = 7.2;

const cny = (yuan) => yuan / CNY_PER_USD;

/**
 * 型号 → 价格（美元每百万 token）。结构照 openai 那份：
 *   { text: { input, output }, audio: { input, output } }
 * 这里两个 omni 型号的文字和音频同价，所以两半写一样的数。
 */
export const PRICES = Object.freeze({
  "qwen3.8-omni-flash": {
    text: { input: cny(0.8), output: cny(2.7) },
    audio: { input: cny(0.8), output: cny(2.7) },
  },
  "qwen3.5-omni-plus": {
    text: { input: cny(7), output: cny(40) },
    audio: { input: cny(7), output: cny(40) },
  },
});

/** 响应里报的是带日期的快照名时，去掉日期按型号查价 */
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/**
 * 一次调用花了多少美元。价目表里没有这个型号时是 null
 * （比如某个只见过名字、没抄价格的型号——那时宁可算不出，也不瞎报一个数）。
 * @param {string} model 实际回话的型号（响应里的 model）
 * @param {{ text: number, audio: number, textOutput: number, audioOutput: number }} tokens
 * @returns {number | null}
 */
export function costOf(model, tokens) {
  const price = PRICES[model] ?? PRICES[model.replace(SNAPSHOT, "")];
  if (!price) return null;
  const audio = price.audio ?? { input: 0, output: 0 };
  return (
    (tokens.text * price.text.input +
      tokens.audio * audio.input +
      tokens.textOutput * price.text.output +
      tokens.audioOutput * audio.output) /
    PER_MILLION
  );
}
