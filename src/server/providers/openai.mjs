import { classifyError as classifyShared, createClient as createAudioClient } from "./openai-audio.mjs";
import { costOf } from "./prices/openai.mjs";

// OpenAI 的适配器：gpt-audio 系列在 Chat Completions 里收音频，一次请求完成识别和整理，和 Gemini 一样。
// 请求怎么拼、用量怎么拆、报错怎么认这些和 Qwen 共用一份（openai-audio.mjs），这里只填这一家的：
// 地址、报错时的称呼、算钱的规矩。

const ENDPOINT = "https://api.openai.com/v1/chat/completions";
const NAME = "OpenAI";

/** 只收 wav 和 mp3（实测传 webm、ogg 回 400 "Supported values are: 'wav' and 'mp3'"）。我们只换得出 wav */
export const AUDIO_TYPES = ["audio/wav"];

/**
 * @param {{ apiKey: string, model: string, fetch?: typeof fetch }} options fetch 在测试时换成假的
 */
export function createClient({ apiKey, model, thinkingLevel, log, fetch }) {
  void thinkingLevel;
  void log;
  return createAudioClient({ endpoint: ENDPOINT, name: NAME, apiKey, model, costOf, fetch });
}

/**
 * 认 OpenAI 回的报错。不认得的返回 null。
 * 第二个参数是 toModelError 传进来的原文，这里用不上（报错原话在 error 自己身上）
 */
export const classifyError = (error, detail) => classifyShared(error, NAME, detail);
