import { msg } from "../i18n/index.mjs";

// 把配置表（catalog.mjs）里的标签和实测数字写成话（msg），命令行和 App 的模型列表都用这一份，按界面语言翻。

/**
 * 转写进程报的后端名写成什么：运行库报的是设备名（transcribe.cpp 的 MTL0 是第一块 GPU 走 Metal），
 * 认得的按 localModels.backends 翻，不认得的照原样
 */
export function backendText(reported) {
  if (/^MTL/i.test(reported)) return msg("localModels.backends.metal");
  if (/^cpu/i.test(reported)) return msg("localModels.backends.cpu");
  return reported;
}

/** 多大，给人看：1 GB 以下按 MB，以上按 GB（十进制，和下载工具、访达一样） */
export function sizeText(bytes) {
  return bytes < 1_000_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

/** 一个模型的标签，一个标签一句 */
export const tagTexts = (tags) => tags.map((tag) => msg(`localModels.tags.${tag}`));

/**
 * 在这台机器这类芯片上实测得怎样：挑跑得最快的那一条（catalog.mjs 的 measuredOn 排好了）。没测过也如实说
 * @param {ReadonlyArray<{ backend: string, score: number, realtime: number, peakMB: number }>} measured
 * @param {string | null} chip catalog.mjs 的 chipOf
 */
export function measuredText(measured, chip) {
  if (chip === null) return msg("localModels.unknownChip");
  const name = msg(`localModels.chips.${chip}`);
  if (measured.length === 0) return msg("localModels.notMeasured", { chip: name });
  const [best] = measured;
  return msg("localModels.measured", {
    chip: name,
    backend: msg(`localModels.backends.${best.backend}`),
    score: best.score.toFixed(2),
    realtime: String(Math.round(best.realtime)),
    memory: `${(best.peakMB / 1000).toFixed(1)} GB`,
  });
}
