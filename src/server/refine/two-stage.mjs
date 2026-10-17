import { LocalizedError } from "../../i18n/index.mjs";
import { toWav } from "../audio/transcode.mjs";
import { toModelError } from "../providers/errors.mjs";
import { createMeter } from "./meter.mjs";
import { textFromModelOutput } from "./output.mjs";
import { SYSTEM_PROMPT, TASK_REMINDER } from "./prompt.mjs";

// 分两跳的整理链路：一个模型只管听，另一个纯文本模型只管写。
//
// **为什么要拆**：听音频的模型（omni 这一档）本职是"听懂声音"，文字加工不是它的强项。
// 让它既听又整理，实测下来只能做到"带标点的听写"——口头禅能删几个，但"换着说法说了两遍
// 同一个意思"这种要理解语义的事，实测 5 次里 0 次能做到（prompt.mjs 的注释里有完整数据）。
// 换成纯文本模型做第二跳，"三句说同一件事合成一句"是能稳定做到的。
//
// 代价是多一次请求、总耗时从 1.4–2.4 秒涨到 4–5 秒。用流式抵消体感（见 voice-socket 那边）。

/**
 * 第一跳的提示词：**只让它听，不给它整理的活**。
 *
 * 特意要求"保留口头禅和重复"——如果这里就开始整理，第二跳拿到的稿子已经缺了东西，
 * 再也补不回来（整理是不可逆的）。让它老老实实逐字写，脏一点没关系。
 */
const TRANSCRIBE_PROMPT = [
  "你是语音转写引擎。把听到的话逐字写下来，只输出听到的字。",
  "",
  "保留：说话人的口头禅、重复、改口（后面会有人整理）。",
  "**不要保留听错的字**：人名、产品名、技术术语按最可能的写法写出来，不要写音译的近似字。",
  "比如听到 gemi nai / 吉米奈这类音，结合上下文判断他说的是 Gemini，就写 Gemini。",
  "拿不准的按最常见的那种写法写，不要自造音译。",
  "",
  "不要整理、不要删、不要合并句子。",
].join("\n");

/** 给第二跳的说明：它拿到的是一段脏稿子 */
const transcriptNote = (transcript, context) => {
  const parts = [`这是一段语音转写的逐字稿（没整理过，有口头禅、重复和可能的识别错误）：`, "", transcript];
  if (context && context.trim() !== "") {
    // 上下文只用来判断"他在写什么"，绝不能出现在成品里
    parts.push("", "他光标前面已经写好的内容（只用来判断语境，不要把它写进成品、不要接着它写）：", "", context.trim());
  }
  parts.push("", TASK_REMINDER);
  return parts.join("\n");
};

/**
 * @param {object} options
 * @param {{ id: string, name: string }} options.provider 听写那一家
 * @param {object} options.client 听写那一家能收音频的适配器
 * @param {string[]} options.audioTypes 它直接收的录音格式
 * @param {(error: unknown, detail: string) => object | null} [options.classify]
 * @param {string} [options.apiKey] 从报错里抹掉它用
 * @param {number} [options.timeoutMs] 每一跳各自的上限
 * @param {object} options.polish 第二跳的纯文本客户端（chat/openai-chat.mjs 的 createClient）
 * @param {{ id: string }} options.polishProvider 第二跳是哪一家（记账用）
 * @param {Function} [options.transcode]
 * @param {Function} [options.onCall] 记账
 */
export function createTwoStageRefiner({
  provider,
  client,
  audioTypes,
  classify,
  apiKey,
  timeoutMs = 30_000,
  polish,
  polishProvider,
  log,
  transcode = toWav,
  onCall = () => {},
}) {
  const described = (error) => toModelError(error, { provider, apiKey, classify });
  const withTimeout = (signal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  };

  const meterHear = createMeter({ provider, log, onCall });
  const meterPolish = createMeter({ provider: polishProvider, log, onCall });

  return {
    /** 两跳各自预热：听的那一跳靠 ping，写的那一跳也要（第一次调用会慢） */
    async warmUp() {
      try {
        await meterHear("check", null, () => client.ping({ signal: AbortSignal.timeout(timeoutMs) }));
      } catch (error) {
        throw described(error);
      }
      try {
        await meterPolish("check", null, () => polish.ping({ signal: AbortSignal.timeout(timeoutMs) }));
      } catch (error) {
        throw described(error);
      }
    },

    /** 缓存是给"一次调用"那条路省时间的，两跳这边第二跳是纯文本、量小，不用备 */
    async prepare() {},

    /**
     * @param {{ mimeType: string, signal?: AbortSignal, audioId?: string, context?: string }} options
     *   context：光标前已经写好的文字，只用来判断语境
     * @returns {Promise<string>} 整理好的文字；没有人声时是空字符串
     */
    async refine(audio, { mimeType, signal, audioId = null, context = "" }) {
      // 第一跳：听
      const input = audioTypes.includes(mimeType)
        ? { audio, mimeType }
        : await timed(log, () => transcode(audio, mimeType));
      let transcript;
      try {
        const reply = await meterHear("transcribe", audioId, () =>
          client.generate({
            ...input,
            systemPrompt: TRANSCRIBE_PROMPT,
            reminder: "逐字转写这段录音。",
            signal: withTimeout(signal),
          }),
        );
        if (reply.problem) throw new LocalizedError(reply.problem);
        transcript = textFromModelOutput(reply.text);
      } catch (error) {
        throw described(error);
      }
      // 没人说话：不用进第二跳，省一次请求
      if (transcript === "") return "";

      // 第二跳：写
      try {
        const polished = await meterPolish("polish", audioId, () =>
          polish.complete({
            system: SYSTEM_PROMPT,
            user: transcriptNote(transcript, context),
            signal: withTimeout(signal),
          }),
        );
        if (polished.problem) throw new LocalizedError(polished.problem);
        return textFromModelOutput(polished.text);
      } catch (error) {
        // 第二跳失败时**不要丢掉第一跳的转写稿**：它虽然脏，但那是用户说的话。
        // 宁可贴一段没整理的，也比一个字都不出强（用户说的"吞了"有一半是这种）
        log.warn("polish_failed_fallback_to_transcript", {
          audio_id: audioId,
          error: String(described(error).detail ?? "").slice(0, 300),
        });
        return transcript;
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
