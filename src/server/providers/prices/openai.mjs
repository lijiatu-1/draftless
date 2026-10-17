// OpenAI 的价目表和算钱的规矩。照官方价目表 https://developers.openai.com/api/docs/pricing 里
// "Realtime and audio generation models" 那一栏抄的（2026-10-14），只收我们用得上的 gpt-audio 系列。
// 规矩：文字和音频各一个价，输入输出分开；思考的 token 算在文字输出里。这几个型号的缓存价一栏是"-"，
// 命中缓存也照原价算。价格的单位是美元每百万 token。改价时照官方页改这里，并更新上面的日期。

const PER_MILLION = 1_000_000;

export const PRICES = Object.freeze({
  "gpt-audio-mini": { text: { input: 0.6, output: 2.4 }, audio: { input: 10, output: 20 } },
  "gpt-audio-1.5": { text: { input: 2.5, output: 10 }, audio: { input: 32, output: 64 } },
  "gpt-audio": { text: { input: 2.5, output: 10 }, audio: { input: 32, output: 64 } },
});

/** 响应里报的是带日期的快照名（实测 gpt-audio-mini 回 gpt-audio-mini-2025-12-15），去掉日期按型号查价 */
const SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;

/**
 * 一次调用花了多少美元。价目表里没有这个型号时是 null。
 * @param {string} model 实际回话的型号（响应里的 model）
 * @param {{ text: number, audio: number, textOutput: number, audioOutput: number }} tokens
 * @returns {number | null}
 */
export function costOf(model, tokens) {
  const price = PRICES[model] ?? PRICES[model.replace(SNAPSHOT, "")];
  if (!price) return null;
  return (
    (tokens.text * price.text.input +
      tokens.audio * price.audio.input +
      tokens.textOutput * price.text.output +
      tokens.audioOutput * price.audio.output) /
    PER_MILLION
  );
}
