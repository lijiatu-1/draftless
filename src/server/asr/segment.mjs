// 长录音分段。每个模型一次能吃的音频有上限，写在清单里的 maxSeconds。超过上限的录音先切成几段，逐段转写，
// 再按顺序把文字接起来（engines/index.mjs 的 loadTranscriber 统一做这件事，适配器只管一段）。
// 切点放在两句话之间最安静的地方：在"上限的一半到上限"这一截里，找平均音量最低的一小段，从它中间切开。
// 只看音量，不另用语音检测模型，所以和用哪个模型、哪个运行库都无关。
// 全是静音的段不交给模型：实测 Qwen3-ASR 拿到 7.9 秒的纯静音会吐出一个 "None"，有的模型还会编出字来。

/** 每 20 ms 算一次音量 */
const FRAME_SECONDS = 0.02;
/** 按 300 ms 的平均音量找停顿：比这短的静音只是字和字之间的空隙 */
const QUIET_SECONDS = 0.3;
/** 切点从上限的一半往后找，段不至于切得太碎 */
const SEARCH_FROM = 0.5;
/** 整段最响的一下都不到这个数就是静音：16 位录音里约 160，说话再轻也远高于它 */
const SILENT_PEAK = 0.005;

/** 这一段是不是静音（空的也算） */
export function isSilent(samples) {
  for (const value of samples) if (Math.abs(value) >= SILENT_PEAK) return false;
  return true;
}

/**
 * 真正要交给模型的几段：有上限的先切开（splitPoints），再去掉全是静音的段。整段静音的录音一段都不交。
 * @param {number | null | undefined} maxSeconds 没有上限时整段交
 * @returns {[number, number][]}
 */
export function planWindows(samples, sampleRate, maxSeconds) {
  const windows = maxSeconds ? splitPoints(samples, sampleRate, maxSeconds) : [[0, samples.length]];
  return windows.filter(([start, end]) => !isSilent(samples.subarray(start, end)));
}

/**
 * @param {Float32Array} samples
 * @param {number} sampleRate
 * @param {number} maxSeconds 一段最长多少秒
 * @returns {[number, number][]} 各段的 [起, 止) 样本下标，首尾相接、覆盖整段录音
 */
export function splitPoints(samples, sampleRate, maxSeconds) {
  const limit = Math.floor(maxSeconds * sampleRate);
  if (samples.length <= limit) return [[0, samples.length]];

  const frame = Math.round(FRAME_SECONDS * sampleRate);
  const frames = Math.ceil(samples.length / frame);
  // 音量的前缀和：任意一截的平均音量都能一步算出来
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    const end = Math.min(samples.length, (f + 1) * frame);
    for (let i = f * frame; i < end; i++) sum += samples[i] * samples[i];
    prefix[f + 1] = prefix[f] + sum;
  }
  const window = Math.round(QUIET_SECONDS / FRAME_SECONDS);

  const segments = [];
  let start = 0;
  while (samples.length - start > limit) {
    const from = start + Math.floor(limit * SEARCH_FROM);
    const to = start + limit;
    let quietest = null;
    let lowest = Number.POSITIVE_INFINITY;
    for (let f = Math.ceil(from / frame); (f + window) * frame <= to; f++) {
      const energy = prefix[f + window] - prefix[f];
      if (energy < lowest) {
        lowest = energy;
        quietest = f;
      }
    }
    const cut = quietest === null ? to : Math.min(to, (quietest + Math.floor(window / 2)) * frame);
    segments.push([start, cut]);
    start = cut;
  }
  segments.push([start, samples.length]);
  return segments;
}

/** 各段的文字按顺序接起来：中文直接接；接口两边都是英文字母或数字时加一个空格，免得两个词粘在一起 */
export function joinTexts(parts) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((joined, part) => {
      if (joined === "") return part;
      const spaced = /[A-Za-z0-9]$/.test(joined) && /^[A-Za-z0-9]/.test(part);
      return `${joined}${spaced ? " " : ""}${part}`;
    }, "");
}
