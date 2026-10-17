import { join } from "node:path";
import { SPEECH_SAMPLE_RATE } from "../../audio/pcm.mjs";
import { joinTexts, planWindows } from "../segment.mjs";

// 本地转写的运行库清单。每个运行库一个适配器（同目录下的 sherpa-onnx.mjs、transcribe-cpp.mjs），
// 把"一个下载好的模型目录"变成同一个接口，上面的人只认这个接口，换模型、换运行库都不用改：
//
//   const transcriber = await loadTranscriber({ model, dir, options });  // dir：模型下载到的目录
//   const { text } = await transcriber.transcribe(samples);   // samples：16 kHz 单声道的 Float32Array，多长都行
//   transcriber.backend                                       // 实际跑在哪：cpu、metal…
//   transcriber.dispose();
//
// 模型一次吃不下的长录音（清单里写了 maxSeconds）在这一层切开逐段转写，全是静音的段不交给模型，适配器只管一段。
// text 是识别出的原文：去掉运行库自带的标记、首尾空白，别的不动（不转简体、不改标点），那是后面润色的事。
// 适配器还导出 FAMILIES（认得哪几族模型：config 是文件怎么填进配置，clean 是这一族在这个运行库里吐出的标记怎么去掉）
// 和 version()（运行库的版本，评测记进指纹）。
// 运行库的包在 load() 里才加载：只用云端模型的人不必为它付启动开销。
//
// 以后各个系统要的运行库不一样（Mac 的 Metal、Windows 的 Vulkan/CUDA），差别都关在各自的适配器里。

export const ENGINES = Object.freeze([
  Object.freeze({ id: "sherpa-onnx", name: "sherpa-onnx", load: () => import("./sherpa-onnx.mjs") }),
  Object.freeze({ id: "transcribe-cpp", name: "transcribe.cpp", load: () => import("./transcribe-cpp.mjs") }),
]);

/** @returns {(typeof ENGINES)[number] | null} */
export function findEngine(id) {
  return ENGINES.find((engine) => engine.id === id) ?? null;
}

/**
 * 按清单里的一项装出一个转写器。
 * @param {{ model: object, dir: string, options?: object }} request dir 是模型下载到的目录（models/store.mjs 的 dirOf）
 */
export async function loadTranscriber({ model, dir, options = {} }) {
  const engine = findEngine(model.engine);
  if (!engine) throw new Error(`模型 ${model.id} 要用的运行库 ${model.engine} 没有登记`);
  const adapter = await engine.load();
  if (!adapter.FAMILIES[model.family]) {
    throw new Error(`${engine.name} 不认 ${model.family} 这一族的模型（${model.id}）`);
  }
  /** 清单里按用途起名的文件 → 它在模型目录里的完整路径 */
  const file = (role) => {
    const entry = model.files[role];
    if (!entry) throw new Error(`模型 ${model.id} 的清单里没有 ${role} 这个文件`);
    return join(dir, entry.path);
  };
  return windowed(await adapter.load({ model, file, options }), model.maxSeconds);
}

/**
 * 在适配器外面包一层：长录音按 maxSeconds 切开逐段转写再接起来，全是静音的段（或整段静音）不交给模型。
 * 上面的人照样只管交一整段录音。backend、dispose 照旧用适配器的
 * @param {{ transcribe(samples: Float32Array): Promise<{ text: string }> }} transcriber 适配器装出来的
 * @param {number | null | undefined} maxSeconds 一次最多吃多少秒，没有上限是空的
 */
export function windowed(transcriber, maxSeconds) {
  return {
    ...transcriber,
    async transcribe(samples) {
      const parts = [];
      for (const [start, end] of planWindows(samples, SPEECH_SAMPLE_RATE, maxSeconds)) {
        parts.push((await transcriber.transcribe(samples.subarray(start, end))).text);
      }
      return { text: joinTexts(parts) };
    },
  };
}
