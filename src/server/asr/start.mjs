import { findModel } from "../../models/catalog.mjs";
import { createModelStore } from "../../models/store.mjs";
import { spawnTranscriber } from "./host.mjs";

// 把一个下载好的本地模型装进转写进程。下载不在这里：下不下、什么时候下由用户点（models/library.mjs），
// 不能一切到 local 模式就悄悄下几百兆。

/**
 * @param {object} options
 * @param {string} options.modelId 配置表里的 id（models/catalog.mjs）
 * @param {string} options.modelsDir 模型放在哪（storage/paths.mjs 的 modelsDir）
 * @param {{ info: Function, warn: Function, error: Function }} options.log
 * @param {object} [options.options] 交给运行库的参数（backend、threads…）
 * @returns {Promise<Awaited<ReturnType<typeof spawnTranscriber>>>}
 */
export async function startTranscriber({
  modelId,
  modelsDir,
  log,
  options,
  store = createModelStore({ dir: modelsDir }),
  spawn = spawnTranscriber,
}) {
  const model = findModel(modelId);
  if (!model) throw new Error(`模型清单里没有 ${modelId}`);
  if (!store.isInstalled(model)) throw new Error(`${model.id} 还没下载`);
  return spawn({ model, dir: store.dirOf(model), options, log });
}
