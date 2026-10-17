// 拿真实录音做实验：同一段话，换不同配置看整理效果到底差在哪。
//
// 用法（仓库根目录，用 electron 因为它能解 safeStorage 的 key）：
//   node_modules\electron\dist\electron.exe scripts\dev\eval-real.cjs [录音文件]
//
// 默认用 07:23 那条 41 秒的（成品 181 字，口头禅全留着的那次）。
//
// 为什么要有这个脚本：合成语音（SAPI）干净、没有犹豫和口吃，Qwen 整理得挺好；
// 真人口语一上就只做转写了。所以得拿真录音当尺子。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const RECORDING = process.argv[2] || join(HOME, "data", "Recordings", "98623181-55a4-4913-b8a3-37bf9f539355.webm");

/** 口头禅 / 重复 / 真实口吃的痕迹：还在就说明只做了转写 */
const UNTIDY = /那个的那个|然后我们|然后我|有没有什么|就是说我|嗯，|呃，|那个图标，然后|没有什么，然后/;

app.whenReady().then(async () => {
  const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
  const { toWav } = await import("../../src/server/audio/transcode.mjs");
  const { wavSeconds } = await import("../../src/server/audio/pcm.mjs");
  const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");
  const { createClient } = await import("../../src/server/providers/qwen.mjs");

  const webm = readFileSync(RECORDING);
  const { audio, mimeType } = await toWav(webm, "audio/webm");
  const seconds = wavSeconds(audio);
  console.log(`录音：${(webm.length / 1024).toFixed(0)} KB → ${seconds.toFixed(1)} 秒 wav`);
  console.log(`（线上那条的成品：${(process.env.EXPECT ?? "181 字，口头禅全留").slice(0, 40)}\n`);

  /** 一次尝试：走产品自己的 qwen 适配器，预算由它按音频时长算（这样测的才是线上行为） */
  async function attempt(label, { model }) {
    const client = createClient({ apiKey, model });
    const startedAt = Date.now();
    try {
      const reply = await client.generate({
        audio,
        mimeType,
        systemPrompt: SYSTEM_PROMPT,
        reminder: TASK_REMINDER,
        signal: AbortSignal.timeout(90_000),
      });
      const ms = Date.now() - startedAt;
      const usage = reply.usage ?? {};
      const text = String(reply.text ?? "");
      console.log(`── ${label}`);
      console.log(
        `   ${ms} ms · 思考 ${usage.thinkingTokens ?? "?"} · 输出 ${usage.outputTokens ?? "?"} · 音频 ${usage.audioTokens ?? "?"}`,
      );
      console.log(`   成品（${text.length} 字）：`);
      for (const line of text.split("\n")) console.log(`     ${line}`);
      console.log(`   判断：${UNTIDY.test(text) ? "❌ 还有口头禅/重复（只转写了）" : "✅ 整理过"}\n`);
      return { ms, thinking: usage.thinkingTokens ?? 0 };
    } catch (error) {
      console.log(`── ${label}`);
      console.log(`   失败（${Date.now() - startedAt} ms）：${error.message}\n`);
      return null;
    }
  }

  const results = [];
  // 模型从产品清单里取，不写死：写死过一次，测的其实是旧型号，结论全歪
  const { findProvider } = await import("../../src/server/providers/index.mjs");
  const model = findProvider("qwen").defaultModel;
  results.push(await attempt(`产品默认（${model}）`, { model }));

  console.log("===== 小结（耗时 / 思考） =====");
  for (const [index, result] of results.entries()) {
    console.log(`  第 ${index + 1} 个：${result ? `${result.ms} ms / ${result.thinking}` : "失败"}`);
  }
  app.exit(0);
});
