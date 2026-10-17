import { msg } from "../../i18n/index.mjs";
import { encodeWav } from "../audio/pcm.mjs";
import { quote } from "./errors.mjs";

// "Chat Completions 里直接塞音频"这一套的通用实现：OpenAI 的 gpt-audio 系列和阿里云百炼的
// Qwen-Omni 是同一个形状（messages 里放 input_audio、一次请求完成识别和整理）。
// 两家各写一份的话，请求体、用量映射、报错认法会慢慢走偏，所以放这里，
// 各家的适配器只填地址、叫什么、怎么算钱、要不要带 modalities。
//
// 不用官方 SDK：只用到这一个接口，SDK 装上有 21 MB，会让一行命令安装的包变大。
// 请求格式对着 OpenAI 的文档写、拿真的 key 实测过（见 openai.test.mjs）。

/** 验证 key 用的 0.1 秒静音。这几个模型不接受纯文字的请求（实测 400："either input content or output modality contain audio"） */
const SILENCE = encodeWav(new Float32Array(1_600), 16_000);

/**
 * 音频数据怎么放进请求里。两家不一样（2026-10-17 各拿真 key 试过）：
 *
 * - `"base64"` 纯 base64。**OpenAI 要这个**：给成 data URI 会回 400。
 * - `"data-uri"` `data:audio/wav;base64,…`。**百炼要这个**：它把 `input_audio.data` 当 URL 解析，
 *   纯 base64 过不了校验，回 400 `InternalError.Algo.InvalidParameter: The provided URL does not appear
 *   to be valid`（实测四种形状：纯 base64 带不带 format 都是这个错，换成 data URI 就通了）。
 */
const ENCODINGS = {
  base64: (audio) => audio.toString("base64"),
  "data-uri": (audio, mimeType) => `data:${mimeType};base64,${audio.toString("base64")}`,
};

/** 对面回了一个错误。status 是 HTTP 状态码，code 是它给的错误码（invalid_api_key、model_not_found…） */
export class OpenAIAudioError extends Error {
  /**
   * @param {string} name 报错时怎么称呼对面
   * @param {number} status HTTP 状态码
   * @param {{ code?: string, message?: string } | null} error 回话里的 error 对象
   */
  constructor(name, status, error) {
    super(`${name} 回了 ${status}${error?.code ? ` ${error.code}` : ""}：${error?.message ?? "（没有说明）"}`);
    this.name = "OpenAIAudioError";
    this.provider = name;
    this.status = status;
    this.code = error?.code ?? null;
    this.said = error?.message ?? "";
  }
}

/**
 * @param {object} options
 * @param {string} options.endpoint 完整的 chat/completions 地址
 * @param {string} options.name 报错时怎么称呼对面（"OpenAI"、"Qwen"）
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string[] | null} [options.modalities] 要它输出什么模态。默认 `["text"]`；
 *   传 null 就不带这个字段——不是每一家的兼容实现都认它，认不认由各家的适配器决定
 * @param {"base64" | "data-uri"} [options.audioEncoding] 音频数据怎么写进请求，见上面 ENCODINGS。
 *   默认 `"base64"`（OpenAI 的形状）
 * @param {object | ((audio: { audio: Buffer, mimeType: string }) => object)} [options.extraBody]
 *   这一家特有的请求参数，摊进请求体顶层（百炼的 thinking_budget 就是）。可以是函数，按这一次的录音算——
 *   ping 那种没有录音的请求会拿到 `{ audio: null }`，函数要能处理。
 *   放在 messages 那几项之前，所以不会盖掉这次请求本身要发的东西
 * @param {((model: string, tokens: object) => number | null) | null} [options.costOf] 这一家怎么算钱
 * @param {typeof fetch} [options.fetch] 测试时换成假的
 */
export function createClient({
  endpoint,
  name,
  apiKey,
  model,
  modalities = ["text"],
  audioEncoding = "base64",
  extraBody = {},
  costOf = null,
  fetch = globalThis.fetch,
}) {
  const encodeAudio = ENCODINGS[audioEncoding];
  if (!encodeAudio) throw new Error(`不认识的音频编码：${audioEncoding}`);

  /** 这一次的额外参数：给函数就按这次的录音算，给对象就照用 */
  const extrasFor = (audio) =>
    typeof extraBody === "function"
      ? extraBody({ audio: audio?.audio ?? null, mimeType: audio?.mimeType ?? null })
      : extraBody;

  async function complete(body, signal, extras) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...(modalities === null ? {} : { modalities }), ...extras, ...body }),
      signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // 中间的网关偶尔会回一页 HTML：按状态码说，正文不要
    }
    if (!response.ok) throw new OpenAIAudioError(name, response.status, payload?.error);
    return payload;
  }

  return {
    /** 最小的请求：0.1 秒静音、只要 1 个 token（这时它回的 finish_reason 是 length，不算失败）。实测 OpenAI 约 0.7 秒 */
    async ping({ signal }) {
      const payload = await complete(
        {
          max_completion_tokens: 1,
          messages: [
            {
              role: "user",
              content: [
                { type: "input_audio", input_audio: { data: encodeAudio(SILENCE, "audio/wav"), format: "wav" } },
              ],
            },
          ],
        },
        signal,
        extrasFor(null),
      );
      return { usage: usageOf(payload, model, costOf) };
    },

    /**
     * @returns {Promise<{ text: string | null, problem: object | null, usage: object }>} 模型的原文（收尾交给调用方）、
     *   用不了的原因、这一次的用量。用不了的回话（被截断、被拒绝）也收了钱，所以不在这里抛错，由调用方记完账再报错
     */
    async generate({ audio, mimeType, systemPrompt, reminder, signal }) {
      const payload = await complete(
        {
          messages: [
            { role: "system", content: systemPrompt },
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: { data: encodeAudio(audio, mimeType), format: formatOf(mimeType) },
                },
                { type: "text", text: reminder },
              ],
            },
          ],
        },
        signal,
        extrasFor({ audio, mimeType }),
      );
      const choice = payload?.choices?.[0];
      // 被截断或被拦下的半截文字不能当成品贴出去
      const problem = choice?.message?.refusal
        ? msg("model.blocked", { provider: name, reason: quote(choice.message.refusal) })
        : choice?.finish_reason !== "stop"
          ? msg("model.unfinished", { provider: name, reason: String(choice?.finish_reason) })
          : null;
      return { text: problem ? null : choice.message.content, problem, usage: usageOf(payload, model, costOf) };
    },
  };
}

/** 录音的 MIME 类型 → 请求里写的那几个字（`input_audio.format`）。现在两边都只收 wav */
export function formatOf(mimeType) {
  if (mimeType === "audio/wav") return "wav";
  throw new Error(`这一家的适配器不收 ${mimeType}`);
}

/**
 * 回话里的用量 → 记账用的样子。字段对着实测的回话写的：prompt_tokens 含音频和命中缓存的，
 * completion_tokens 含思考的和音频的；没有的项是 0。按回话报的型号算钱，没报就按请求的。
 */
function usageOf(payload, model, costOf) {
  const usage = payload?.usage ?? {};
  const input = usage.prompt_tokens ?? 0;
  const output = usage.completion_tokens ?? 0;
  const audio = usage.prompt_tokens_details?.audio_tokens ?? 0;
  const audioOutput = usage.completion_tokens_details?.audio_tokens ?? 0;
  const billed = payload?.model ?? model;
  return {
    model: billed,
    inputTokens: input,
    audioTokens: audio,
    cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
    outputTokens: output,
    thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
    costUsd: costOf?.(billed, { text: input - audio, audio, textOutput: output - audioOutput, audioOutput }) ?? null,
  };
}

/**
 * 认这一家回的报错（假 key 的 401 和模型名写错的 404 都实测过；没额度的 429 照官方文档写的错误码）。
 * 不认得的返回 null。
 *
 * 这个形状的接口能说得清的几种情况两边一样，所以共用一份，只有称呼不同。各家的适配器把它包成
 * `(error) => classifyError(error, "OpenAI")` 再导出，签名和 toModelError 要的 `classify(error, detail)` 兼容。
 *
 * @param {unknown} error
 * @param {string} name 报错时怎么称呼对面
 */
export function classifyError(error, name) {
  if (!(error instanceof OpenAIAudioError)) return null;
  // 回的不是 JSON（前面的网关回了一页 HTML）时没有原话，至少带上状态码
  const said = quote(error.said) || `HTTP ${error.status}`;
  if (error.status === 401) return { kind: "key", problem: msg("model.keyInvalid") };
  // 按网络出口所在地区拒的（官方文档写的错误码）：key 没问题，开着代理或换个网络就好，不能叫人换 key
  if (error.code === "unsupported_country_region_territory") {
    return { kind: "unavailable", problem: msg("model.regionBlocked", { provider: name, said }) };
  }
  if (error.code === "insufficient_quota") return { kind: "key", problem: msg("model.noQuota") };
  if (error.status === 403) return { kind: "key", problem: msg("model.forbidden", { said }) };
  if (error.status === 429 || error.status >= 500) {
    return { kind: "unavailable", problem: msg("model.unavailable", { provider: name, said }) };
  }
  if (error.status === 404 || error.code === "model_not_found") {
    return { kind: "other", problem: msg("model.notFound", { provider: name, said }) };
  }
  return { kind: "other", problem: msg("model.rejected", { provider: name, said }) };
}
