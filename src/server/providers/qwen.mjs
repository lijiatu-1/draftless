import { classifyError as classifyShared, createClient as createAudioClient } from "./openai-audio.mjs";
import { costOf } from "./prices/qwen.mjs";

// Qwen（阿里云百炼 / DashScope）的适配器：qwen-omni 系列在 OpenAI 兼容模式下收音频，
// 一次请求就出成品，和 Gemini、OpenAI 一样。
//
// 地址是百炼的 **OpenAI 兼容模式**，不是它的原生 DashScope 接口：
//   https://dashscope.aliyuncs.com/compatible-mode/v1       国内站
//   https://dashscope-intl.aliyuncs.com/compatible-mode/v1  国际站
// 走兼容模式是因为请求形状和 OpenAI 基本一样（messages 里放 input_audio），
// 请求怎么拼、用量怎么拆、报错怎么认都能和 openai.mjs 共用一份（openai-audio.mjs）。
// 国际站或者自建网关的，用 DRAFTLESS_QWEN_BASE_URL 换掉这个前缀，润色那条链路也认同一个变量。
//
// **和 OpenAI 唯一不一样的地方：音频要写成 data URI**，不能是纯 base64。
// 百炼把 `input_audio.data` 当 URL 解析，纯 base64 过不了校验，回
// `<400> InternalError.Algo.InvalidParameter: The provided URL does not appear to be valid`。
// 2026-10-17 拿真 key 把几种形状都试了一遍（纯 base64 带/不带 format、data URI 带/不带 modalities）：
// 只有 data URI 通，829–1059 毫秒（静音录音回空字符串，属于正常）。所以这里是 audioEncoding: "data-uri"。
// 顺带记两件事：`modalities` 带不带都通（还是带上，意图明确，也省得它连语音一起出）；
// 原生接口 `/api/v1/services/aigc/multimodal-generation/generation` 也通，但要 10.5 秒，慢十倍，不用它。
//
// 只收 wav：录音本来是 webm/opus，refiner 会按 AUDIO_TYPES 先转成 wav（和 OpenAI 那条路一样）。

/** 默认的接口前缀。国际站换成 https://dashscope-intl.aliyuncs.com/compatible-mode/v1 */
const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
const NAME = "Qwen";

/** 只收 wav，理由见上面 */
export const AUDIO_TYPES = ["audio/wav"];

/**
 * 实际要连的地址。装好的程序里改这个变量要重启；设置里换模型不用。
 * @param {Record<string, string | undefined>} [env]
 */
export function baseUrl(env = process.env) {
  const given = (env.DRAFTLESS_QWEN_BASE_URL ?? "").trim();
  return (given === "" ? DEFAULT_BASE_URL : given).replace(/\/+$/, "");
}

/**
 * @param {{ apiKey: string, model: string, fetch?: typeof fetch }} options fetch 在测试时换成假的
 */
export function createClient({ apiKey, model, thinkingLevel, log, fetch }) {
  // 这两个是别家适配器的参数（Gemini 要思考档位、有的要看日志），Qwen 用不上
  void thinkingLevel;
  void log;
  return createAudioClient({
    endpoint: `${baseUrl()}/chat/completions`,
    name: NAME,
    apiKey,
    model,
    // 百炼要 data URI，不要纯 base64。这一行是这个适配器最要紧的一处，上面有来龙去脉
    audioEncoding: "data-uri",
    // 不带任何思考预算。这个决定推翻了我之前折腾好几轮的东西，值得留在这里：
    //
    // 一直用 qwen3.8-omni-flash 当听写模型，它整理得差，我就加 thinking_budget 去逼它，
    // 384 → 1024 → 按秒算，每次都能"让某一条录音变好"，换一条又崩——那是在拟合现象。
    //
    // 真正的原因是**模型选错了**。2026-10-17 拿账号里所有能听音频的 omni 模型比了一遍
    // （全部用真实录音，同一份提示词）：
    //
    //   模型                  预算      耗时       思考        成品
    //   qwen3.8-omni-flash    不设      16–36 s    1304–3114   慢到撞超时，还把 Logseq 听成"逻辑字母"
    //   qwen3.8-omni-flash    1024      8.6 s      549         中
    //   qwen3.5-omni-plus     不设      1.4–2.4 s  **0**       最好
    //   qwen3.5-omni-flash    不设      1.3 s      0           一般（"然后我们没有"留着）
    //   qwen3-omni-flash      不设      1.7 s      0           差（"speaker more"听错）
    //
    // **plus 档根本不产生思考 token**，所以没有预算要调——护栏在这个模型上是多余的。
    // 换模型比调参数有效得多，而且快 5–15 倍。教训：先穷举候选，再谈调参。
    //
    // 如果将来有人把模型换成 flash 系列（设置里可以改），它会自己失控到 30 秒以上；
    // 那时该做的是换回 plus，而不是把预算旋钮再加回来。
    costOf,
    fetch,
  });
}

/**
 * 认百炼回的报错。不认得的返回 null，交给通用分类。
 * 第二个参数是 toModelError 传进来的原文，这里用不上（报错原话在 error 自己身上）
 */
export const classifyError = (error, detail) => classifyShared(error, NAME, detail);
