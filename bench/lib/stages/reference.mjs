import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MODEL_CHOICE,
  DEFAULT_THINKING_LEVEL,
  formatModelChoice,
} from "../../../src/server/providers/index.mjs";
import { SYSTEM_PROMPT, TASK_REMINDER } from "../../../src/server/refine/prompt.mjs";
import { createModelRefiner } from "../../../src/server/refine/refiner.mjs";
import { mapWithLimit } from "../concurrency.mjs";
import { fingerprint } from "../results.mjs";
import { findSource } from "../sources.mjs";

// 参照：App 现在的原生链路——录音直接交给 Gemini 3.6 Flash（思考档位 MINIMAL），用 App 的提示词和收尾出成品。
// 作者 2026-10-16 定的：本地模型转出来的字拿去和它比。它也是原生链路的耗时基线。

export const REFERENCE = Object.freeze({ ...DEFAULT_MODEL_CHOICE, thinkingLevel: DEFAULT_THINKING_LEVEL });
const PROMPT = fingerprint([SYSTEM_PROMPT, TASK_REMINDER]);

/** 录音、模型、档位、提示词，哪样变了参照就要重跑 */
export const referenceKey = (clip) => fingerprint({ clip: clip.sha256, ...REFERENCE, prompt: PROMPT });

/**
 * @returns {Promise<{ ran: number, failed: { clip: string, error: string }[] }>}
 */
export async function runReference({ clips, results, datasetDir, apiKey, concurrency, force }) {
  const todo = clips.filter((clip) => force || results.get("reference", referenceKey(clip)) === null);
  if (todo.length === 0) return { ran: 0, failed: [] };
  for (const clip of todo) {
    const { audioTo } = findSource(clip.source);
    if (!audioTo.includes(REFERENCE.provider)) {
      throw new Error(`${clip.source} 的录音不能发给 ${REFERENCE.provider}（只能发给 ${audioTo.join("、")}）`);
    }
  }
  const log = { info() {}, warn: report, error: report };
  const refiner = await createModelRefiner({
    choice: REFERENCE,
    apiKey,
    thinkingLevel: REFERENCE.thinkingLevel,
    log,
  });
  // 进程里的第一次请求要多花一两秒建连接，先发掉，免得算进第一条样本的耗时
  await refiner.warmUp();
  const subject = formatModelChoice(REFERENCE);
  const failed = [];
  await mapWithLimit(todo, concurrency, async (clip) => {
    const audio = readFileSync(join(datasetDir, clip.file));
    const startedAt = performance.now();
    try {
      const text = await refiner.refine(audio, { mimeType: "audio/wav" });
      const ms = Math.round(performance.now() - startedAt);
      results.put("reference", referenceKey(clip), { clip: clip.id, subject, output: { text, ms } });
    } catch (error) {
      failed.push({ clip: clip.id, error: String(error?.message ?? error) });
    }
  });
  return { ran: todo.length, failed };
}

/** refiner 的警告和错误只带数字和原因，不带说的话，照打 */
function report(event, fields) {
  console.error(`  [参照] ${event} ${JSON.stringify(fields)}`);
}
