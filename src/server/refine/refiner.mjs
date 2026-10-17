import { LocalizedError, msg } from "../../i18n/index.mjs";
import { toWav } from "../audio/transcode.mjs";
import { toModelError } from "../providers/errors.mjs";
import { findProvider } from "../providers/index.mjs";
import { createMeter } from "./meter.mjs";
import { textFromModelOutput } from "./output.mjs";
import { SYSTEM_PROMPT, TASK_REMINDER } from "./prompt.mjs";
import { createTwoStageRefiner } from "./two-stage.mjs";

// 原生链路：录音直接交给收音频的大模型，一次请求出成品。
// 数字来自 scripts/dev/eval-prompt.mjs：同一批 60 条真实录音跑了 12 遍，共 720 条成品。

/** 模型听音频时自带"几分几秒"的定位，偶尔会写进正文（720 条里 10 条，像"全面开干、 00:30 全面迁移"） */
const STRAY_TIMESTAMP = /(?<!\d)\d{1,2}:\d{2}(?!\d)/;

/** 一次请求最多等多久。Gemini 一两秒、OpenAI 一分半的录音七八秒，留足余量 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * "音频进、成品文字出"的那一步。各家共用这一个流程：录音的格式这家不收就先换好，交给适配器拿原文，
 * 再统一收尾；适配器只管"这一家的请求怎么拼、报错怎么认"。
 *
 * 每一次回了话的调用都记一笔账（onCall，规矩见 meter.mjs）。
 *
 * @param {object} options
 * @param {{ id: string, name: string }} options.provider 厂商清单里的那一项（providers/index.mjs）
 * @param {{ ping(o: { signal: AbortSignal }): Promise<{ usage: object }>, generate(request: object): Promise<{ text: string | null | undefined, problem: object | null, usage: object }> }} options.client
 *   这一家的适配器（providers/*.mjs 的 createClient）
 * @param {string[]} options.audioTypes 这一家直接收的录音格式
 * @param {(error: unknown, detail: string) => object | null} [options.classify] 这一家的报错怎么认
 * @param {string} [options.apiKey] 只用来从报错里抹掉它
 * @param {(audio: Buffer, mimeType: string) => Promise<{ audio: Buffer, mimeType: string }>} [options.transcode]
 * @param {(record: object) => void} [options.onCall] 记账，见 meter.mjs
 * @returns {{ warmUp(): Promise<void>, prepare(): Promise<void>, refine(audio: Buffer, o: { mimeType: string, signal?: AbortSignal, audioId?: string }): Promise<string> }}
 *   出错时抛的都是 ModelError
 */
export function createRefiner({
  provider,
  client,
  audioTypes,
  classify,
  apiKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  log,
  transcode = toWav,
  onCall = () => {},
}) {
  const described = (error) => toModelError(error, { provider, apiKey, classify });
  const withTimeout = (signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  const metered = createMeter({ provider, log, onCall });

  return {
    /**
     * 启动时发一个最小的请求。实测进程里第一次整理要 3.4–4.1 秒，之后稳定在 1.7–1.9 秒
     * （Gemini，闲置 3 分钟后也是）；先发这一个，慢的那一次就不会落在用户的第一句话上。
     * key 无效或模型名写错也会在这里暴露，不用等到第一次听写。
     */
    async warmUp() {
      try {
        await metered("check", null, () => client.ping({ signal: AbortSignal.timeout(timeoutMs) }));
      } catch (error) {
        throw described(error);
      }
    },

    /**
     * 用户开口说话了：让这一家先把要用的东西备好，说完整理时就用得上。现在只有 Gemini 有事做（建提示词缓存，
     * 见 providers/gemini-cache.mjs），花的钱记一笔"缓存"。备不好只是这一次贵一点，记一条警告，从不往外抛
     */
    async prepare() {
      if (!client.prepare) return;
      try {
        await metered("cache", null, () => client.prepare({ systemPrompt: SYSTEM_PROMPT }));
      } catch (error) {
        log.warn("prompt_cache_failed", { provider: provider.id, error: described(error).detail.slice(0, 300) });
      }
    },

    /**
     * @param {{ mimeType: string, signal?: AbortSignal, audioId?: string }} options audioId：这是哪一次听写，记账时用
     * @returns {Promise<string>} 整理好的文字；没有人声时是空字符串
     */
    async refine(audio, { mimeType, signal, audioId = null }) {
      try {
        // 只换一次：夹着时间戳要重来时用的是同一份
        const input = audioTypes.includes(mimeType)
          ? { audio, mimeType }
          : await timed(log, () => transcode(audio, mimeType));
        const generateOnce = async () => {
          const reply = await metered("dictation", audioId, () =>
            client.generate({
              ...input,
              systemPrompt: SYSTEM_PROMPT,
              reminder: TASK_REMINDER,
              signal: withTimeout(signal),
            }),
          );
          // 被拦下、被截断：适配器说了原因（一句 msg），照它说的报
          if (reply.problem) throw new LocalizedError(reply.problem);
          return textFromModelOutput(reply.text);
        };
        return await generateClean(generateOnce, log);
      } catch (error) {
        throw described(error);
      }
    },
  };
}

/** 换格式花了多久记一笔：它算在用户等成品的时间里 */
async function timed(log, transcode) {
  const startedAt = performance.now();
  const converted = await transcode();
  log.info("audio_transcoded", { to: converted.mimeType, ms: Math.round(performance.now() - startedAt) });
  return converted;
}

/**
 * 按用户选的厂商和模型装出一个 refiner：清单里找到那一家，加载它的适配器，交给上面的共用流程。
 *
 * 两家都走"一次调用"，只有 qwen 走两跳（`provider.polishModel` 有值就是两跳）：
 * omni 那一档听写准但整理弱，纯文本型号正好反过来。第二跳用同一把 key 走 chat 那一套。
 *
 * @param {object} options
 * @param {{ provider: string, model: string }} options.choice
 * @param {string} options.apiKey
 * @param {string} [options.thinkingLevel] 只有 Gemini 用得上
 * @param {(record: object) => void} [options.onCall] 记账，见 createRefiner
 */
export async function createModelRefiner({ choice, apiKey, thinkingLevel, timeoutMs, log, onCall }) {
  const provider = findProvider(choice.provider);
  if (!provider) throw new LocalizedError(msg("key.unknownProvider", { id: choice.provider }));
  const adapter = await provider.load();
  if (provider.polishModel) {
    const twoStage = await createTwoStage({ provider, adapter, choice, apiKey, timeoutMs, log, onCall });
    if (twoStage) return twoStage;
  }
  return createRefiner({
    provider,
    client: adapter.createClient({ apiKey, model: choice.model, thinkingLevel, log }),
    audioTypes: adapter.AUDIO_TYPES,
    classify: adapter.classifyError,
    apiKey,
    timeoutMs,
    log,
    onCall,
  });
}

/**
 * 拼一个两跳的 refiner：听写用这一家的音频适配器，整理用同一把 key 走 chat 那一套。
 *
 * 第二跳的厂商和地址从 vendors.mjs 里按 id 取（qwen 那项和听写那项共用同一把 key）。
 * 拿不到就给 null，让调用方退回"一次调用"——宁可少一层加工，也不能整个听写用不了。
 *
 * @returns {Promise<object | null>}
 */
async function createTwoStage({ provider, adapter, choice, apiKey, timeoutMs, log, onCall }) {
  const { findChatVendor, chatEndpoint } = await import("../chat/vendors.mjs");
  const { createClient } = await import("../chat/openai-chat.mjs");
  const vendor = findChatVendor(provider.id);
  if (!vendor) {
    log.warn("two_stage_unavailable", { provider: provider.id, reason: "chat 里没有这一家" });
    return null;
  }
  const polishProvider = { id: vendor.id, name: vendor.name };
  return createTwoStageRefiner({
    provider,
    client: adapter.createClient({ apiKey, model: choice.model, log }),
    audioTypes: adapter.AUDIO_TYPES,
    classify: adapter.classifyError,
    apiKey,
    timeoutMs,
    polish: createClient({
      // chatEndpoint 回的是 { baseUrl, name }，不是字符串（baseUrl 可能来自环境变量或自定义地址）
      ...chatEndpoint(vendor, { env: process.env }),
      apiKey,
      model: provider.polishModel,
    }),
    polishProvider,
    log,
    onCall,
  });
}
/**
 * 拿一次成品；里面夹着时间戳就重来一次，用第二次的结果。
 * 不直接把时间戳删掉，是因为他也可能真的说了钟点：重来一遍还有，就当是他说的。
 * 原版 2853 条成品里没有一条带这种写法，所以多出来的这一次请求几乎只落在写坏的成品上。
 *
 * @param {() => Promise<string>} generateOnce
 * @param {{ warn: (event: string, fields: object) => void }} log
 */
export async function generateClean(generateOnce, log) {
  const first = await generateOnce();
  if (!STRAY_TIMESTAMP.test(first)) return first;
  log.warn("refine_retry", { reason: "成品里夹着时间戳" });
  return generateOnce();
}
