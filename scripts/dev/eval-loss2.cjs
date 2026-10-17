// 用【三条不同内容】的录音拼成一条长音频，看整理后会不会丢内容。
// 上一版把同一段重复三遍，整理时被正确地合并了（那是提示词要求的），测不出"吞"。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

// 三条内容完全不同的真实录音
const PARTS = [
  ["afe3391d-b65e-479a-809f-11203d98ecf6", "62.2 秒 · 仓库介绍和思考模式"],
  ["229d32b0-6272-4178-aaf4-90768d7b3e0c", "44.8 秒 · 不要遵从我的想法"],
  ["77b8d233-8177-44e2-896f-3dc7ab383323", "44.2 秒 · 识图和上下文"],
];

/** 从 wav 里取出 fmt 和 data */
function chunks(wav) {
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= wav.length) {
    const id = wav.toString("ascii", offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    if (id === "fmt ") fmt = Buffer.from(wav.subarray(offset, offset + 8 + size));
    if (id === "data") data = wav.subarray(offset + 8, offset + 8 + size);
    offset += 8 + size + (size % 2);
  }
  return { fmt, data };
}

/** 用第一个 wav 的头部做骨架，把所有 data 接起来 */
function joinWavs(wavs) {
  const first = chunks(wavs[0]);
  const body = Buffer.concat(wavs.map((w) => chunks(w).data));
  const head = Buffer.alloc(12 + first.fmt.length + 8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(head.length + body.length - 8, 4);
  head.write("WAVE", 8, "ascii");
  first.fmt.copy(head, 12);
  head.write("data", 12 + first.fmt.length, "ascii");
  head.writeUInt32LE(body.length, 12 + first.fmt.length + 4);
  return Buffer.concat([head, body]);
}

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { toWav } = await import("../../src/server/audio/transcode.mjs");
    const { wavSeconds } = await import("../../src/server/audio/pcm.mjs");
    const { createClient } = await import("../../src/server/providers/qwen.mjs");
    const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");

    const wavs = [];
    for (const [id, label] of PARTS) {
      const { audio } = await toWav(readFileSync(join(HOME, "data", "Recordings", `${id}.webm`)), "audio/webm");
      console.log(`  ${label} → ${wavSeconds(audio).toFixed(1)} 秒`);
      wavs.push(audio);
    }
    // 格式要一致才能直接拼
    const sig = (w) => JSON.stringify([...chunks(w).fmt.subarray(8, 20)]);
    const same = wavs.every((w) => sig(w) === sig(wavs[0]));
    console.log(`  三条格式一致: ${same}`);

    const long = joinWavs(wavs);
    const total = wavSeconds(long);
    console.log(`\n拼成 ${total.toFixed(1)} 秒，三段内容完全不同\n`);

    const TRANSCRIBE = "你是语音转写引擎。把听到的话逐字写下来，不要整理、不要删、不要合并。只输出听到的字。";
    for (const [label, prompt, reminder] of [
      ["只转写", TRANSCRIBE, "逐字转写这段录音。"],
      ["整理（产品提示词）", SYSTEM_PROMPT, TASK_REMINDER],
    ]) {
      const client = createClient({ apiKey, model: "qwen3.5-omni-plus" });
      const startedAt = Date.now();
      const reply = await client.generate({
        audio: long,
        mimeType: "audio/wav",
        systemPrompt: prompt,
        reminder,
        signal: AbortSignal.timeout(180_000),
      });
      const text = String(reply.text ?? "");
      const chars = text.replace(/\s/g, "").length;
      console.log(
        "-- " +
          label +
          "  " +
          Math.round(Date.now() - startedAt) +
          " ms  " +
          chars +
          " 字  (" +
          (chars / total).toFixed(2) +
          " 字/秒)",
      );
      console.log(text);
      console.log("");
    }
    app.exit(0);
  } catch (error) {
    console.log(`出错：${error.message}`);
    app.exit(1);
  }
});
