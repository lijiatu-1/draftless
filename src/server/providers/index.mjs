// 模型厂商的清单。录音交给哪一家整理是一个策略：每家一个适配器（同目录下的 gemini.mjs、openai.mjs），
// 各自管请求怎么拼、收哪些录音格式、报错怎么认；整理流程本身（提示词、收尾、重试）在 ../refine，各家共用。
//
// 这里只放每家的说明，不加载它的 SDK：命令行看设置、列模型时也要用到这份清单，不该为此把各家的代码都读进来。
// 真要发请求时再 load()。加一家 = 写一个适配器、在下面登记一行，再给每种语言的文案添上去哪申请 key（providers.<id>.getKey）。

import { LocalizedError, msg } from "../../i18n/index.mjs";

export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "gemini",
    name: "Gemini",
    keyEnv: "GEMINI_API_KEY",
    keyPage: "https://aistudio.google.com/apikey",
    // 原来实测选的是 gemini-3.5-flash + MINIMAL：约 1.7 秒出结果，能处理改口；flash-lite 更快（约 1.2 秒）但会把改口的痕迹留下。
    // 3.5 Flash 后来停用了，发给它的请求被自动转给 3.6 Flash（官方弃用页；2026-10-14 实测回话报的就是 3.6），所以直接写 3.6
    defaultModel: "gemini-3.6-flash",
    // 有的型号不接受 MINIMAL，所以档位也要能换
    thinkingLevels: Object.freeze(["MINIMAL", "LOW", "MEDIUM", "HIGH"]),
    load: () => import("./gemini.mjs"),
  }),
  Object.freeze({
    id: "openai",
    name: "OpenAI",
    keyEnv: "OPENAI_API_KEY",
    keyPage: "https://platform.openai.com/api-keys",
    defaultModel: "gpt-audio-mini",
    // gpt-audio 系列没有思考档位
    thinkingLevels: null,
    load: () => import("./openai.mjs"),
  }),
  Object.freeze({
    // 阿里云百炼（DashScope）的 OpenAI 兼容模式。走兼容模式是因为请求形状和 OpenAI 一样，
    // 适配器能共用（见 qwen.mjs 顶上的说明）
    id: "qwen",
    name: "Qwen",
    // 百炼的 key 习惯叫这个；和润色那一跳的 qwen 共用一把（vendors.mjs 按 id 去重）
    keyEnv: "DASHSCOPE_API_KEY",
    keyPage: "https://bailian.console.aliyun.com/",
    // omni 系列里 plus 档，用它当听写默认。
    // **不是 flash**：同样是 omni，2026-10-17 拿真实录音比过（41/31/9.3/8 秒各一条），
    // qwen3.8-omni-flash 会思考失控——同一条 9.3 秒的录音烧掉 2991 个思考 token、跑了 36 秒，
    // 而 qwen3.5-omni-plus 是 1401 ms、0 个思考 token，识别和整理都更好
    // （flash 把 Logseq 听成"逻辑字母"、Logisim 听成"logic sim"）。
    // 版本号高不代表适合这件事，所以别按号大小挑。
    defaultModel: "qwen3.5-omni-plus",
    // omni 系列没有思考档位
    thinkingLevels: null,
    // **这一家走两跳**：omni 只负责听，整理交给下面这个纯文本型号。
    // 让它听写和整理一起干，实测只能做到"带标点的听写"——"换着说法说了两遍同一个意思"
    // 5 次里 0 次能合并（见 refine/prompt.mjs 的注释）。纯文本模型做第二跳就稳。
    // 走哪条路由 refine/refiner.mjs 的 createModelRefiner 决定；这里只声明"能拆"和"拆给谁"
    polishModel: "qwen-plus",
    load: () => import("./qwen.mjs"),
  }),
]);

export const DEFAULT_MODEL_CHOICE = Object.freeze({ provider: "gemini", model: PROVIDERS[0].defaultModel });
export const DEFAULT_THINKING_LEVEL = "MINIMAL";

/** @returns {(typeof PROVIDERS)[number] | null} 大小写不论；不认识的是 null */
export function findProvider(id) {
  const wanted = String(id).toLowerCase();
  return PROVIDERS.find((provider) => provider.id === wanted) ?? null;
}

/** 模型名里只出现这些字符（gpt-audio-1.5、gemini-3.5-flash、gpt-audio-mini-2025-12-15 这样的） */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
/** Gemini 的 SDK 还认带前缀的写法，0.3 时可能有人这么写在设置里 */
const GEMINI_PREFIXED = /^(models|tunedModels)\/[A-Za-z0-9][A-Za-z0-9._:-]*$/;

/**
 * 用户写的模型选择 → { provider, model }。写法：
 *   openai/gpt-audio-1.5   厂商/模型
 *   openai                 只写厂商，用它的默认模型
 *   gemini-3.5-flash       只写一个不是厂商名的模型名：当成 Gemini 的。0.3 以前设置里只有 Gemini 的模型名，照样认
 *   models/gemini-3.5-flash  0.3 时 Gemini 的 SDK 也认带 models/、tunedModels/ 前缀的写法，照样认成 Gemini 的
 * 写错了就抛 LocalizedError，说清哪里不对（一句接在"model 写的是 …，"后面的话）。
 */
export function parseModelChoice(value) {
  const text = String(value ?? "").trim();
  if (text === "") throw new LocalizedError(msg("models.empty"));
  if (GEMINI_PREFIXED.test(text)) return { provider: "gemini", model: text };
  const slash = text.indexOf("/");
  if (slash === -1) {
    const provider = findProvider(text);
    if (provider) return { provider: provider.id, model: provider.defaultModel };
    return { provider: "gemini", model: checkedModelName("gemini", text) };
  }
  const provider = findProvider(text.slice(0, slash));
  if (!provider) {
    throw new LocalizedError(
      msg("models.unknownProvider", {
        name: text.slice(0, slash),
        providers: PROVIDERS.map(({ id }) => id).join(" / "),
      }),
    );
  }
  return { provider: provider.id, model: checkedModelName(provider.id, text.slice(slash + 1)) };
}

function checkedModelName(provider, model) {
  if (MODEL_NAME.test(model) || (provider === "gemini" && GEMINI_PREFIXED.test(model))) return model;
  throw new LocalizedError(msg("models.badName", { model: JSON.stringify(model) }));
}

export const formatModelChoice = ({ provider, model }) => `${provider}/${model}`;

const MAX_KEY_LENGTH = 512;

/**
 * key 的样子对不对（不联网）。不对时返回一句说明（msg），句子里不带 key 本身。
 * 要在交给 SDK 之前拦下：带换行的 key 会让 Gemini 的 SDK 报"Headers.append: "…" is an invalid header value"，
 * 引号里是整段输入（实测），这句报错再进日志和终端，key 就漏了。各家的 key 都放在请求头里，所以规则通用。
 * @returns {{ key: string, params?: object } | null} 没问题时是 null
 */
export function apiKeyProblem(key) {
  if (key.length > MAX_KEY_LENGTH) return msg("key.tooLong", { length: key.length });
  if (/\s/.test(key)) return msg("key.whitespace");
  // 只该有看得见的英文字符：别的字符放不进请求头
  if (!/^[\x21-\x7e]+$/.test(key)) return msg("key.badCharacters");
  return null;
}
