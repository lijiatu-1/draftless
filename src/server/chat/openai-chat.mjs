import { msg } from "../../i18n/index.mjs";
import { quote } from "../providers/errors.mjs";

// OpenAI Chat Completions 这一种协议的适配器：POST {地址}/chat/completions，GET {地址}/models。
// DeepSeek 和大多数别家都支持它，差别（地址、模型、要多带的参数、价）由厂商清单（vendors.mjs）给。
// 不用官方 SDK，理由同 providers/openai.mjs：只用到两个接口。
// 请求和回话的字段对着 DeepSeek 的官方文档写，2026-10-16 拿真的 key 实测过。

/** 对面回了一个错误。status 是 HTTP 状态码，said 是它说的原话（认不出时是空的），json 表示回的是不是 JSON */
class ChatError extends Error {
  constructor(name, status, said, json) {
    super(`${name} 回了 ${status}：${said || "（没有说明）"}`);
    this.name = "ChatError";
    this.status = status;
    this.said = said;
    this.json = json;
    this.code = null;
  }
}

/**
 * 报错的原话。OpenAI 的写法是 {"error":{"message":"…","code":"…"}}，
 * 有的服务写成 {"error":"…"}（Ollama）、{"message":"…"} 或 {"detail":"…"}
 */
function saidIn(payload) {
  const error = payload?.error;
  if (typeof error?.message === "string") return error.message;
  if (typeof error === "string") return error;
  if (typeof payload?.message === "string") return payload.message;
  if (typeof payload?.detail === "string") return payload.detail;
  return "";
}

/**
 * @param {object} options
 * @param {string} options.baseUrl 规整过的地址（vendors.mjs 的 chatEndpoint），不带结尾的斜杠
 * @param {string} options.apiKey
 * @param {string} options.model
 * @param {string} [options.name] 报错时怎么称呼对面
 * @param {object} [options.request] 这一家要多带的参数（比如 DeepSeek 关掉思考）
 * @param {((model: string, tokens: { input: number, cached: number, output: number }, at: Date) => number | null) | null} [options.costOf]
 *   这一家怎么算钱；不知道价时是 null，花费记成空
 * @param {() => Date} [options.now]
 * @param {typeof fetch} [options.fetch] 测试时换成假的
 */
export function createClient({
  baseUrl,
  apiKey,
  model,
  name = baseUrl,
  request = {},
  costOf = null,
  now = () => new Date(),
  fetch = globalThis.fetch,
}) {
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

  async function call(path, init) {
    const response = await fetch(`${baseUrl}${path}`, { ...init, headers });
    // 读完整个回话再算：DeepSeek 先回头、过一会儿才回正文（实测头 60–170 ms 就到了）
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // 网关、地址写错时回的常是一页 HTML：按状态码说，正文不要
    }
    if (!response.ok) {
      const error = new ChatError(name, response.status, saidIn(payload), payload !== null);
      error.code = payload?.error?.code ?? null;
      throw error;
    }
    return payload;
  }

  const complete = (body, signal) =>
    call("/chat/completions", { method: "POST", body: JSON.stringify({ model, ...request, ...body }), signal });

  const usageOf = (payload) => {
    const usage = payload?.usage ?? {};
    const input = usage.prompt_tokens ?? 0;
    // DeepSeek 单列命中缓存的（prompt_cache_hit_tokens），别家写在 prompt_tokens_details 里
    const cached = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const billed = payload?.model ?? model;
    return {
      model: billed,
      inputTokens: input,
      audioTokens: 0,
      cachedTokens: cached,
      outputTokens: output,
      thinkingTokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      costUsd: costOf?.(billed, { input: input - cached, cached, output }, now()) ?? null,
    };
  };

  return {
    /** 最小的请求：只要 1 个 token（这时回 finish_reason length，不算失败）。key、地址、模型名不对都会在这里暴露 */
    async ping({ signal }) {
      const payload = await complete({ max_tokens: 1, messages: [{ role: "user", content: "1" }] }, signal);
      return { usage: usageOf(payload) };
    },

    /**
     * @returns {Promise<{ text: string | null, problem: object | null, usage: object }>} 模型的原文（收尾交给调用方）、
     *   用不了的原因、这一次的用量。用不了的回话（被截断、被拦下）也收了钱，所以不在这里抛错，由调用方记完账再报错
     */
    async complete({ system, user, signal }) {
      const payload = await complete(
        {
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        },
        signal,
      );
      const choice = payload?.choices?.[0];
      const finish = choice?.finish_reason;
      // 被截断或被拦下的半截文字不能当成品贴出去
      const problem = choice?.message?.refusal
        ? msg("model.blocked", { provider: name, reason: quote(choice.message.refusal) })
        : finish === "content_filter"
          ? msg("model.blocked", { provider: name, reason: finish })
          : finish !== "stop"
            ? msg("model.unfinished", { provider: name, reason: String(finish) })
            : null;
      return { text: problem ? null : (choice.message.content ?? ""), problem, usage: usageOf(payload) };
    },

    /** 这个地址上有哪些模型（GET /models）。给人挑模型用：大多数服务都有这个接口，没有的会抛错 */
    async listModels({ signal }) {
      const payload = await call("/models", { method: "GET", signal });
      return (payload?.data ?? []).map((entry) => entry.id).filter((id) => typeof id === "string");
    },
  };
}

/**
 * 认这个适配器抛的报错。状态码照 DeepSeek 的错误码文档（401、402、422、429、500、503）和 OpenAI 的惯例；
 * 不认得的返回 null。
 * @param {unknown} error
 * @param {{ name: string }} endpoint 报错时怎么称呼对面
 */
export function classifyError(error, { name }) {
  if (!(error instanceof ChatError)) return null;
  // 回的不是 JSON 时没有原话，至少带上状态码
  const said = quote(error.said) || `HTTP ${error.status}`;
  if (error.status === 401) return { kind: "key", problem: msg("model.keyInvalid") };
  // DeepSeek 没余额是 402；OpenAI 的写法是 insufficient_quota
  if (error.status === 402 || error.code === "insufficient_quota")
    return { kind: "key", problem: msg("model.noQuota") };
  if (error.status === 403) return { kind: "key", problem: msg("model.forbidden", { said }) };
  if (error.status === 429 || error.status >= 500) {
    return { kind: "unavailable", problem: msg("model.unavailable", { provider: name, said }) };
  }
  if (error.status === 404) {
    // 回的是 JSON 才是那个服务自己说找不到（多半是模型）；回一页 HTML 是地址根本没对上接口
    return error.json
      ? { kind: "other", problem: msg("model.notFound", { provider: name, said }) }
      : { kind: "other", problem: msg("chat.endpointNotFound", { provider: name }) };
  }
  return { kind: "other", problem: msg("model.rejected", { provider: name, said }) };
}
