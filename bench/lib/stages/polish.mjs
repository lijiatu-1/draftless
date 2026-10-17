import { findChatVendor, formatChatChoice, parseChatChoice } from "../../../src/server/chat/vendors.mjs";
import { POLISH_PROMPT, polishInput } from "../../../src/server/refine/polish-prompt.mjs";
import { createChatPolisher } from "../../../src/server/refine/polisher.mjs";
import { mapWithLimit } from "../concurrency.mjs";
import { fingerprint } from "../results.mjs";

// 润色：本地转写链路的第二跳。拿各个候选转出的原文交给纯文字大模型，出成品，用的是 App 里同一个润色器
// （src/server/refine/polisher.mjs，提示词、参数、收尾都一样）。成品拿去和参照（原生链路的成品）比，
// 端到端的耗时 = 转写 + 润色，和原生链路一次请求的耗时比。

/** 不指定时润色交给谁 */
export const DEFAULT_POLISHER = "deepseek/deepseek-flash";

export const parsePolisher = (value) => parseChatChoice(value ?? DEFAULT_POLISHER);

/** 润色的配置：哪家哪个模型、提示词、多带的参数。哪样变了就要重跑 */
const configOf = (choice) => ({
  choice: formatChatChoice(choice),
  prompt: fingerprint([POLISH_PROMPT, polishInput("")]),
  request: findChatVendor(choice.vendor).request,
});

/** 原文和润色的配置定了，成品就定了：两个候选转出一模一样的原文，只润色一次 */
export const polishKey = (transcript, choice) =>
  fingerprint({ transcript: fingerprint(transcript), ...configOf(choice) });

/**
 * @param {object} options
 * @param {{ clip: object, transcript: { text: string } }[]} options.cells 有原文的格子
 * @param {{ vendor: string, model: string }} options.choice
 * @returns {Promise<{ ran: number, failed: { clip: string, error: string }[] }>}
 */
export async function runPolish({ cells, choice, results, apiKey, concurrency, force }) {
  const todo = new Map();
  for (const cell of cells) {
    const key = polishKey(cell.transcript.text, choice);
    if (!todo.has(key) && (force || results.get("polish", key) === null)) todo.set(key, cell);
  }
  if (todo.size === 0) return { ran: 0, failed: [] };

  /** 每次调用的用量，按 audioId（这里用格子的指纹）对回去 */
  const usage = new Map();
  const log = { info() {}, warn: report, error: report };
  const polisher = await createChatPolisher({
    choice,
    apiKey,
    log,
    onCall: (call) => {
      if (call.audioId) usage.set(call.audioId, call);
    },
  });
  // 进程里的第一次请求要多花时间建连接，先发掉，免得算进第一条样本的耗时
  await polisher.warmUp();
  const subject = formatChatChoice(choice);
  const failed = [];
  await mapWithLimit([...todo], concurrency, async ([key, cell]) => {
    const startedAt = performance.now();
    try {
      const text = await polisher.polish(cell.transcript.text, { audioId: key });
      const ms = Math.round(performance.now() - startedAt);
      const call = usage.get(key);
      results.put("polish", key, {
        clip: cell.clip.id,
        subject,
        output: {
          text,
          ms,
          inputTokens: call?.inputTokens ?? 0,
          cachedTokens: call?.cachedTokens ?? 0,
          outputTokens: call?.outputTokens ?? 0,
          // 原文是空的不调模型（polisher.mjs），这一条不花钱
          costUsd: call ? call.costUsd : cell.transcript.text.trim() === "" ? 0 : null,
        },
      });
    } catch (error) {
      failed.push({ clip: cell.clip.id, error: String(error?.message ?? error) });
    }
  });
  return { ran: todo.size, failed };
}

/** 润色器的警告和错误只带数字和原因，不带说的话，照打 */
function report(event, fields) {
  console.error(`  [润色] ${event} ${JSON.stringify(fields)}`);
}
