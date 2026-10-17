import { LocalizedError, msg } from "../../i18n/index.mjs";

// 润色这一跳（本地转写出的原文 → 成品文字）用的纯文字大模型，一家一项。每家写清：走哪种接口协议、默认地址、
// 默认模型、为了快要多带哪些参数、怎么算钱。
//
// 协议是策略（PROTOCOLS）。现在只有 OpenAI 的 Chat Completions 一种：DeepSeek、通义、Kimi、智谱、OpenRouter、
// Ollama、LM Studio 都支持它。要接只支持别的协议的服务（比如 Anthropic Messages），就写一个协议适配器、在 PROTOCOLS 登记。
// 清单里没有的服务不用等我们登记：选 custom，自己填地址、模型和 key（GitHub issue #2 要的就是这个）。
//
// key 按厂商存，和原生链路共用一套存放处（storage/paths.mjs 的 keyFile）。以后这里加上 openai、gemini，
// 用的就是用户已经存好的那把。
// 这个文件只放说明，不加载协议的代码：命令行列模型时也要读这份清单。加一家 = 在 CHAT_VENDORS 里登记一项。

export const PROTOCOLS = Object.freeze({
  "openai-chat": Object.freeze({ name: "OpenAI Chat Completions", load: () => import("./openai-chat.mjs") }),
});

export const CHAT_VENDORS = Object.freeze([
  Object.freeze({
    id: "deepseek",
    name: "DeepSeek",
    keyEnv: "DEEPSEEK_API_KEY",
    keyPage: "https://platform.deepseek.com/api_keys",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
    // deepseek-flash 就是 DeepSeek-V4.1-Flash（官方 GET /models 和价目页，2026-10-16）
    defaultModel: "deepseek-flash",
    /** 官方 GET /models 列出的（2026-10-16）。只用来给人挑：别的名字也照样发，由它判断有没有 */
    models: Object.freeze(["deepseek-flash", "deepseek-v4-pro"]),
    // 它默认开着思考（档位 high）。2026-10-16 实测同一句话：开着要 1.5 秒、多出 185 个 token，关掉 0.7 秒，
    // 成品一样。润色用不着思考，所以关掉
    request: Object.freeze({ thinking: Object.freeze({ type: "disabled" }) }),
    prices: () => import("./prices/deepseek.mjs"),
  }),
  Object.freeze({
    id: "qwen",
    name: "Qwen",
    // 和听写那一跳的 qwen 共用一把 key（vendors.mjs 按 id 去重）
    keyEnv: "DASHSCOPE_API_KEY",
    keyPage: "https://bailian.console.aliyun.com/",
    protocol: "openai-chat",
    // 百炼的 OpenAI 兼容模式；国际站是 dashscope-intl（用下面那个环境变量换）
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    baseUrlEnv: "DRAFTLESS_QWEN_BASE_URL",
    // 润色是纯文本任务，用 plus 就够，也便宜；omni 也能润色，但它是多模态的计价，留给想两边统一的人选
    defaultModel: "qwen-plus",
    models: Object.freeze(["qwen-plus", "qwen-max", "qwen3.8-omni-flash"]),
    // 不多带参数：百炼对不认识的字段是直接报错的（实测过别家也这样）
    request: Object.freeze({}),
    prices: () => import("./prices/qwen.mjs"),
  }),
  Object.freeze({
    id: "custom",
    // 报错时说的是用户填的那个地址的主机名（chatEndpoint），这里的名字只在列清单时用
    name: "Custom",
    keyEnv: "DRAFTLESS_CUSTOM_API_KEY",
    keyPage: null,
    protocol: "openai-chat",
    /** 用户填（设置里的 customUrl） */
    baseUrl: null,
    /** 用户填，没有默认的 */
    defaultModel: null,
    models: Object.freeze([]),
    // 不知道对面是谁，不多带任何参数：多带了不认识的参数，有的服务会回 400
    request: Object.freeze({}),
    // 不知道价，花费记成空
    prices: null,
  }),
]);

/** @returns {(typeof CHAT_VENDORS)[number] | null} 大小写不论；不认识的是 null */
export function findChatVendor(id) {
  const wanted = String(id).toLowerCase();
  return CHAT_VENDORS.find((vendor) => vendor.id === wanted) ?? null;
}

/**
 * 模型名。比原生链路的宽：别家的模型名常带斜杠（OpenRouter 的 deepseek/deepseek-chat、
 * SiliconFlow 的 Qwen/Qwen3-8B）、冒号（Ollama 的 qwen3:8b）、@（Workers AI 的 @cf/…）
 */
const MODEL_NAME = /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,199}$/;

/**
 * 用户写的润色模型 → { vendor, model }。写法：
 *   deepseek                  只写厂商，用它的默认模型
 *   deepseek/deepseek-v4-pro  厂商/模型。只按第一个斜杠分，后面整段都是模型名
 *   custom/Qwen/Qwen3-8B      自定义的必须写模型名
 * 写错了就抛 LocalizedError，说清哪里不对。
 */
export function parseChatChoice(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("models.empty"));
  const slash = text.indexOf("/");
  const name = slash === -1 ? text : text.slice(0, slash);
  const vendor = findChatVendor(name);
  if (!vendor) {
    throw new LocalizedError(
      msg("models.unknownProvider", { name, providers: CHAT_VENDORS.map(({ id }) => id).join(" / ") }),
    );
  }
  const model = slash === -1 ? vendor.defaultModel : text.slice(slash + 1);
  if (model === null) throw new LocalizedError(msg("chat.modelRequired", { vendor: vendor.id }));
  if (!MODEL_NAME.test(model)) throw new LocalizedError(msg("chat.badModelName", { model: JSON.stringify(model) }));
  return { vendor: vendor.id, model };
}

export const formatChatChoice = ({ vendor, model }) => `${vendor}/${model}`;

/**
 * 用户填的接口地址 → 规整后的样子（不带结尾的斜杠）。贴的是完整的 …/chat/completions 也认，去掉那一截。
 * 不许在地址里带账号密码：地址会进日志和设置文件。
 */
export function normalizeBaseUrl(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("chat.urlEmpty"));
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new LocalizedError(msg("chat.urlNotHttp", { url: JSON.stringify(text) }));
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new LocalizedError(msg("chat.urlNotHttp", { url: JSON.stringify(text) }));
  }
  if (url.username || url.password) throw new LocalizedError(msg("chat.urlCredentials"));
  if (url.search || url.hash) throw new LocalizedError(msg("chat.urlQuery"));
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
}

/**
 * 这一家实际要连的地址，和报错时怎么称呼它。
 *
 * - 有默认地址的那几家：默认用 `vendor.baseUrl`；带 `baseUrlEnv` 的（比如百炼的国际站）环境变量设了就用它
 * - 自定义的用用户填的地址，称呼是它的主机名：报"api.siliconflow.cn 拒绝了请求"比报"Custom 拒绝了请求"有用
 * @param {{ customUrl?: string | null }} settings
 * @param {Record<string, string | undefined>} [options.env] 读环境变量；测试时换成假的
 * @returns {{ baseUrl: string, name: string }}
 */
export function chatEndpoint(vendor, { customUrl = null, env = process.env } = {}) {
  if (vendor.baseUrl !== null) {
    const override = vendor.baseUrlEnv ? (env[vendor.baseUrlEnv] ?? "").trim() : "";
    if (override === "") return { baseUrl: vendor.baseUrl, name: vendor.name };
    // 环境变量里写的地址也走一遍规整和校验：写错了要在这里说清，而不是发一个奇怪的请求出去
    return { baseUrl: normalizeBaseUrl(override), name: vendor.name };
  }
  if (!customUrl) throw new LocalizedError(msg("chat.urlMissing"));
  const baseUrl = normalizeBaseUrl(customUrl);
  return { baseUrl, name: new URL(baseUrl).host };
}
