import { msg, problemOf } from "../../i18n/index.mjs";
import { SPEECH_SAMPLE_RATE } from "../audio/pcm.mjs";
import { toSpeech } from "../audio/transcode.mjs";
import { ModelError } from "../providers/errors.mjs";

// 本地转写链路：录音 → 统一成 16 kHz 单声道 → 本地模型转写（第一跳）→ 纯文字模型润色（第二跳）→ 成品。
// 和原生链路（refiner.mjs）平级，对外的接口一样（warmUp、prepare、refine），服务端不用知道走的是哪一条。
// 两跳各是一个策略：转写器是哪个模型由模型清单和转写进程管（asr/），润色交给哪一家由润色器管（polisher.mjs），
// 这里只管把它们按顺序接起来。
// 记账两跳各记一笔：润色那一笔由润色器记（花钱、有 token），本机转写这一笔在这里记（provider 是 local，不花钱），
// 这样用量里能看出每次听写的时间花在哪一跳、钱花在谁身上。

/**
 * @param {object} options
 * @param {{ transcribe(samples: Float32Array): Promise<{ text: string }> }} options.transcriber 第一跳（asr/host.mjs）
 * @param {{ warmUp(): Promise<void>, polish(text: string, o: object): Promise<string> }} options.polisher 第二跳（polisher.mjs）
 * @param {{ info: Function, error: Function }} options.log
 * @param {string} [options.model] 第一跳是哪个本机模型（models/catalog.mjs 的 id），记账用
 * @param {(record: object) => void} [options.onCall] 记账，样子同 meter.mjs 的 onCall
 * @param {typeof toSpeech} [options.decode] 测试时换成假的
 */
export function createLocalRefiner({ transcriber, polisher, log, model, onCall = () => {}, decode = toSpeech }) {
  /** 两跳之外的失败（解不开录音、本地转写出错）也报成 ModelError，服务端按同一套规矩告诉用户 */
  const failed = (problem, error) =>
    new ModelError({ kind: "other", problem, detail: String(error?.message ?? error), origin: error?.stack });

  /** 本机转写这一跳记一笔：没有 token、不花钱，只有转了多久。账没记上只是少一笔统计，不耽误这次听写 */
  function record(audioId, latencyMs) {
    try {
      onCall({
        purpose: "dictation",
        audioId,
        provider: "local",
        model,
        inputTokens: 0,
        audioTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        costUsd: 0,
        latencyMs,
        createdAt: new Date().toISOString(),
      });
    } catch (error) {
      log.error("model_call_not_recorded", { audio_id: audioId, error: String(error?.stack ?? error) });
    }
  }

  return {
    /** 验证润色那一家的 key、地址和模型名，也让第一次润色不慢。转写器在装上的时候已经验过了 */
    warmUp: () => polisher.warmUp(),

    /** 开口时没什么要先备的：模型一直装在转写进程里 */
    async prepare() {},

    async refine(audio, { mimeType, signal, audioId = null }) {
      const startedAt = performance.now();
      let samples;
      try {
        samples = await decode(audio, mimeType);
      } catch (error) {
        throw failed(error?.problem ?? msg("local.undecodable", { reason: problemOf(error) }), error);
      }
      const decodedAt = performance.now();
      let transcript;
      try {
        ({ text: transcript } = await transcriber.transcribe(samples));
      } catch (error) {
        // 自己说得清的（模型还在下载、没装上）照它说的；别的是转写进程或运行库出的错
        const problem =
          error?.problem ?? msg("local.transcribeFailed", { reason: String(error?.message ?? error).slice(0, 200) });
        throw failed(problem, error);
      }
      const transcribedAt = performance.now();
      record(audioId, Math.round(transcribedAt - decodedAt));
      // 转写的这段时间里用户已经断开了：润色要花钱，不必再发
      signal?.throwIfAborted();
      const refined = await polisher.polish(transcript, { signal, audioId });
      // 只记长度和耗时：原文和成品都是用户说的话
      log.info("local_refined", {
        audio_id: audioId,
        seconds: Math.round((samples.length / SPEECH_SAMPLE_RATE) * 10) / 10,
        decode_ms: Math.round(decodedAt - startedAt),
        transcribe_ms: Math.round(transcribedAt - decodedAt),
        polish_ms: Math.round(performance.now() - transcribedAt),
        transcript_length: transcript.length,
      });
      return refined;
    },
  };
}
