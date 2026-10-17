import { GoogleGenAI } from "@google/genai";
import { msg } from "../../i18n/index.mjs";
import { quote } from "./errors.mjs";
import { cacheMissing, createPromptCache } from "./gemini-cache.mjs";
import { costOf } from "./prices/gemini.mjs";

// Gemini 的适配器：一次请求同时完成识别和整理，录音原样交过去。
// 原版服务端内部怎么做的看不到；选一步到位，是因为只需要一家服务、一次请求。

/**
 * 悬浮条录的 WebM、原版的 Ogg 都直接收。实测 7 块首尾相接的链式 Ogg 也能从头识别到尾。
 * WAV 也收：评测把各种来源的录音统一洗成 16 kHz 的 WAV（bench/），云端和本地模型吃的是同一份
 */
export const AUDIO_TYPES = ["audio/ogg", "audio/webm", "audio/wav"];

const QUIET = { info() {}, warn() {}, error() {} };

/**
 * @param {object} options
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} options.thinkingLevel
 * @param {{ info: Function, warn: Function, error: Function }} [options.log]
 * @param {() => Date} [options.now] 测试时换成固定的
 * @param {GoogleGenAI} [options.sdk] 测试时换成假的
 */
export function createClient({
  apiKey,
  model,
  thinkingLevel,
  log = QUIET,
  now = () => new Date(),
  sdk: client = new GoogleGenAI({ apiKey }),
}) {
  const promptCache = createPromptCache({ caches: client.caches, model, now, log });

  return {
    /** 开口说话时调：把提示词缓存建好或者往后续（gemini-cache.mjs）。返回这一次花的钱，没做什么时是 null */
    prepare({ systemPrompt }) {
      return promptCache.prepare(systemPrompt);
    },

    /**
     * 最小的请求：只要 1 个 token。key 无效、模型名或档位写错都会在这里暴露。
     * 只要 1 个 token 时它说"没有正常结束"（MAX_TOKENS），这不算失败
     */
    async ping({ signal }) {
      const response = await client.models.generateContent({
        model,
        contents: "1",
        config: { maxOutputTokens: 1, thinkingConfig: { thinkingLevel }, abortSignal: signal },
      });
      return { usage: replyOf(response, { model, at: now() }).usage };
    },

    /**
     * 有能用的提示词缓存就带上它（这时不能再写 systemInstruction，实测 400），没有就照原样发。
     * 缓存在那边已经没了的话，这一次照原样再发一遍
     * @returns {Promise<{ text: string | null | undefined, problem: object | null, usage: object }>} 见 replyOf
     */
    async generate({ audio, mimeType, systemPrompt, reminder, signal }) {
      // 不设 temperature。设成 0 时，60 条真实录音里有 10 条成品是坏的（开头多出一个不相干的外文词、
      // 只出了开头一小截、中间一长串下划线），去掉这个设置后同一批降到 5 条，截断和下划线没再出现。
      const send = (prompt) =>
        client.models.generateContent({
          model,
          contents: [
            { role: "user", parts: [{ inlineData: { mimeType, data: audio.toString("base64") } }, { text: reminder }] },
          ],
          config: { ...prompt, thinkingConfig: { thinkingLevel }, abortSignal: signal },
        });
      const cached = promptCache.nameFor(systemPrompt);
      let response;
      if (cached === null) {
        response = await send({ systemInstruction: systemPrompt });
      } else {
        try {
          response = await send({ cachedContent: cached });
        } catch (error) {
          if (!cacheMissing(error)) throw error;
          promptCache.forget(cached);
          response = await send({ systemInstruction: systemPrompt });
        }
      }
      return replyOf(response, { model, at: now() });
    },
  };
}

/** 用量里某一类输入（AUDIO、TEXT…）有多少 token */
const tokensOf = (details, modality) => details?.find((detail) => detail.modality === modality)?.tokenCount ?? 0;

/**
 * Gemini 的回话 → 模型的原文、用不了的原因、这一次的用量。
 * 用不了的回话（被拦下、被截断）也收了钱，所以不在这里抛错：用量照样带回去记账，由调用方报错。
 * 用量的字段对着实测的回话写的：promptTokenCount 含音频和命中缓存的，candidatesTokenCount 不含思考的，
 * 没有的项（不思考时没有 thoughtsTokenCount）就是 0。
 * @param {{ model: string, at: Date }} request 请求的型号、什么时候调的。按回话报的型号（modelVersion）算钱：
 *   停用的型号会被转给别的（实测请求 gemini-3.5-flash，回话的是 gemini-3.6-flash）。回话报的型号查不到价
 *   （比如带了后缀的变体名）时退回去按请求的型号算，总比说不知道强
 * @returns {{ text: string | null | undefined, problem: object | null, usage: object }} problem 是一句 msg
 */
export function replyOf(response, { model, at }) {
  const meta = response.usageMetadata ?? {};
  const audio = tokensOf(meta.promptTokensDetails, "AUDIO");
  const cachedAudio = tokensOf(meta.cacheTokensDetails, "AUDIO");
  const input = meta.promptTokenCount ?? 0;
  const cached = meta.cachedContentTokenCount ?? 0;
  const thinking = meta.thoughtsTokenCount ?? 0;
  const output = (meta.candidatesTokenCount ?? 0) + thinking;
  const billed = response.modelVersion ?? model;
  const tokens = { text: input - audio, audio, cachedText: cached - cachedAudio, cachedAudio, output };
  const usage = {
    model: billed,
    inputTokens: input,
    audioTokens: audio,
    cachedTokens: cached,
    outputTokens: output,
    thinkingTokens: thinking,
    costUsd: costOf(billed, tokens, at) ?? costOf(model, tokens, at),
  };

  const blockReason = response.promptFeedback?.blockReason;
  // 被截断或被拦下的半截文字不能当成品贴出去
  const finishReason = response.candidates?.[0]?.finishReason;
  const problem = blockReason
    ? msg("model.blocked", { provider: "Gemini", reason: blockReason })
    : finishReason && finishReason !== "STOP"
      ? msg("model.unfinished", { provider: "Gemini", reason: finishReason })
      : null;
  return { text: problem ? null : response.text, problem, usage };
}

/** Gemini 的报错是一整段 JSON：{"error":{"code":503,"message":"…","status":"UNAVAILABLE"}}。不是这种形状时是 null */
function geminiError(detail) {
  try {
    const { error } = JSON.parse(detail);
    return typeof error?.message === "string" ? error : null;
  } catch {
    return null;
  }
}

/**
 * 认 Gemini 自己的报错（都是实测到的：假 key、写错的模型名、它偶尔回的 503）。不认得的返回 null。
 * @param {unknown} _error
 * @param {string} detail 抹掉 key 之后的报错原文
 */
export function classifyError(_error, detail) {
  if (/API key not valid|API_KEY_INVALID/.test(detail)) {
    return { kind: "key", problem: msg("model.keyInvalid") };
  }
  const gemini = geminiError(detail);
  if (gemini === null) return null;
  const said = quote(gemini.message);
  if (gemini.code >= 500 || gemini.code === 429) {
    return { kind: "unavailable", problem: msg("model.unavailable", { provider: "Gemini", said }) };
  }
  return { kind: "other", problem: msg("model.rejected", { provider: "Gemini", said }) };
}
