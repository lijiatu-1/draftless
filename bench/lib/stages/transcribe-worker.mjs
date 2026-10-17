// 一个候选在自己的子进程里跑：加载耗时、内存峰值只算它自己的；运行库崩了也只崩这一个，不拖垮整轮评测。
// 父进程（transcribe.mjs）发来 { model, dir, options, clips: [{ id, file }] }，这里一条条转写、一条条回报：
//   { type: "loaded", loadMs, backend }
//   { type: "result", clip, text, ms } 或 { type: "error", clip, message }
//   { type: "done", coldMs, maxRssMb }

import { readFileSync } from "node:fs";
import { loadTranscriber } from "../../../src/server/asr/engines/index.mjs";
import { decodeWav, SPEECH_SAMPLE_RATE } from "../../../src/server/audio/pcm.mjs";

/** 暖机用的 3 秒声音：固定种子的白噪声，每次一模一样；够响，不会被当成静音跳过 */
const WARM_UP = (() => {
  const samples = new Float32Array(3 * SPEECH_SAMPLE_RATE);
  let seed = 1;
  for (let i = 0; i < samples.length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
    samples[i] = (seed / 2_147_483_648 - 0.5) * 0.2;
  }
  return samples;
})();

process.once("message", async ({ model, dir, options, clips }) => {
  const read = (clip) => {
    const { samples, sampleRate } = decodeWav(readFileSync(clip.file));
    if (sampleRate !== SPEECH_SAMPLE_RATE) throw new Error(`${clip.id} 是 ${sampleRate} Hz，不是统一格式`);
    return samples;
  };

  let startedAt = performance.now();
  const transcriber = await loadTranscriber({ model, dir, options });
  process.send({ type: "loaded", loadMs: Math.round(performance.now() - startedAt), backend: transcriber.backend });

  // 第一次调用要分配缓冲、准备 GPU 程序，比之后慢得多。单独记下来，不算进各条样本的耗时：
  // App 里模型会常驻，用户说话时碰到的是之后的速度。暖机用一段固定的声音，不用这一轮的第一条录音：
  // 不然只补跑一条长录音的那一轮，"首次"就成了那条录音的耗时，和别的轮比不了
  startedAt = performance.now();
  await transcriber.transcribe(WARM_UP);
  const coldMs = Math.round(performance.now() - startedAt);

  for (const clip of clips) {
    // 读文件、解 WAV 不算：App 里录音已经在内存里了
    const samples = read(clip);
    startedAt = performance.now();
    try {
      const { text } = await transcriber.transcribe(samples);
      process.send({ type: "result", clip: clip.id, text, ms: Math.round(performance.now() - startedAt) });
    } catch (error) {
      process.send({ type: "error", clip: clip.id, message: String(error?.message ?? error) });
    }
  }
  transcriber.dispose();
  // maxRSS 的单位是 KB（libuv 在各个系统上统一过）
  process.send({ type: "done", coldMs, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
  process.disconnect();
});
