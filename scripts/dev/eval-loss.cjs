// 测"说得长了会不会吞内容"：把一条 62 秒的真实录音的 PCM 段重复 1/2/3 次，
// 得到 62/124/186 秒的音频，逐段跑"只转写"，看输出字数是不是线性增长。
//
// 判据很硬：内容是完全重复的，所以 186 秒那条的转写稿应该接近 62 秒那条的 3 倍。
// 明显不足就是模型在中途截断了。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const RECORDING = "afe3391d-b65e-479a-809f-11203d98ecf6"; // 62.2 秒那条

/** 把 wav 的 data 段重复 times 次，顺手改掉两个长度字段 */
function repeatWav(wav, times) {
  let offset = 12;
  let dataStart = -1;
  let dataSize = 0;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "data") {
      dataStart = offset + 8;
      dataSize = size;
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error("这个 wav 里没有 data 段");
  const pcm = wav.subarray(dataStart, dataStart + dataSize);
  const body = Buffer.concat(Array.from({ length: times }, () => pcm));
  const head = Buffer.from(wav.subarray(0, dataStart));
  head.writeUInt32LE(body.length, dataStart - 4); // data 段长度
  head.writeUInt32LE(head.length + body.length - 8, 4); // RIFF 总长度 - 8
  return Buffer.concat([head, body]);
}

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { toWav } = await import("../../src/server/audio/transcode.mjs");
    const { wavSeconds } = await import("../../src/server/audio/pcm.mjs");
    const { createClient } = await import("../../src/server/providers/qwen.mjs");

    const webm = readFileSync(join(HOME, "data", "Recordings", `${RECORDING}.webm`));
    const { audio } = await toWav(webm, "audio/webm");
    const base = wavSeconds(audio);
    console.log(`原始录音 ${base.toFixed(1)} 秒\n`);

    const TRANSCRIBE = "你是语音转写引擎。把听到的话逐字写下来，不要整理、不要删、不要合并。只输出听到的字。";
    const { SYSTEM_PROMPT: REFINE, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");

    for (const times of [1, 2, 3]) {
      const wav = repeatWav(audio, times);
      const seconds = wavSeconds(wav);
      console.log(`\n===== ${seconds.toFixed(1)} 秒 =====`);
      for (const [label, prompt, reminder] of [
        ["只转写", TRANSCRIBE, "逐字转写这段录音。"],
        ["整理（产品提示词）", REFINE, TASK_REMINDER],
      ]) {
        const client = createClient({ apiKey, model: "qwen3.5-omni-plus" });
        const startedAt = Date.now();
        try {
          const reply = await client.generate({
            audio: wav,
            mimeType: "audio/wav",
            systemPrompt: prompt,
            reminder,
            signal: AbortSignal.timeout(180_000),
          });
          const text = String(reply.text ?? "");
          const chars = text.replace(/\s/g, "").length;
          console.log(`  ${label.padEnd(20)}${Math.round(Date.now() - startedAt)} ms  ${chars} 字`);
          console.log(`     开头：${text.replace(/\n/g, " ").slice(0, 50)}`);
          console.log(`     结尾：${text.replace(/\n/g, " ").slice(-50)}`);
        } catch (error) {
          console.log(`  ${label} 失败：${error.message}`);
        }
      }
    }
    app.exit(0);
  } catch (error) {
    console.log(`出错：${error.message}`);
    app.exit(1);
  }
});
