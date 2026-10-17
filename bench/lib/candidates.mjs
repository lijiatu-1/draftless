import { findModel } from "../../src/models/catalog.mjs";

// 本地转写的候选：清单（src/models/catalog.mjs）里的一个模型，加上跑它的参数。
// id 默认就是模型的 id；同一个模型换参数另起一个 id（比如强制只用 CPU，看没有 GPU 的机器上多慢）。

const candidate = (id, modelId, options = {}) => {
  const model = findModel(modelId);
  if (!model) throw new Error(`候选 ${id} 用的模型 ${modelId} 不在清单里`);
  return Object.freeze({ id, model, options: Object.freeze(options) });
};

export const CANDIDATES = Object.freeze([
  candidate("sensevoice-small-int8", "sensevoice-small-int8", { threads: 4 }),
  candidate("qwen3-asr-0.6b-int8", "qwen3-asr-0.6b-int8", { threads: 4 }),
  candidate("sensevoice-small-q8", "sensevoice-small-q8"),
  candidate("qwen3-asr-0.6b-q8", "qwen3-asr-0.6b-q8"),
  // Intel Mac 和没有独显的 Windows 只有 CPU：同一个文件强制走 CPU，看差多少
  candidate("qwen3-asr-0.6b-q8@cpu", "qwen3-asr-0.6b-q8", { backend: "cpu" }),
]);

/** @returns {(typeof CANDIDATES)[number] | null} */
export function findCandidate(id) {
  return CANDIDATES.find((c) => c.id === id) ?? null;
}
