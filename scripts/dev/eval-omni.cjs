// 同一段真实录音，把账号里所有能听音频的 omni 模型都跑一遍，看整理效果和耗时。
// 用法：node_modules\electron\dist\electron.exe scripts\dev\eval-omni.cjs [录音]
//
// 起因：一直用 qwen3.8-omni-flash（flash 档，最小最快），整理效果差。账号里其实还有
// qwen3.5-omni-plus（plus 档）等几个，值得直接比，而不是继续调思考参数。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const RECORDING = process.argv[2] || join(HOME, "data", "Recordings", "98623181-55a4-4913-b8a3-37bf9f539355.webm");

/** 要试的模型：账号里所有非 realtime、能收音频的 omni */
const MODELS = ["qwen3.5-omni-plus", "qwen3.8-omni-flash"];

/** 每种预算各跑一次：不设（看原生行为）和 1024（现在代码给的） */
const BUDGETS = [null];

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { toWav } = await import("../../src/server/audio/transcode.mjs");
    const { wavSeconds } = await import("../../src/server/audio/pcm.mjs");
    const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");
    const { createClient } = await import("../../src/server/providers/openai-audio.mjs");

    const webm = readFileSync(RECORDING);
    const { audio, mimeType } = await toWav(webm, "audio/webm");
    const seconds = wavSeconds(audio);
    console.log(`录音：${(webm.length / 1024).toFixed(0)} KB → ${seconds.toFixed(1)} 秒`);
    console.log(`原话（从线上那条 191 字的成品能看出大意，口头禅很多）\n`);

    for (const model of MODELS) {
      for (const budget of BUDGETS) {
        const client = createClient({
          endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
          name: "Qwen",
          apiKey,
          model,
          audioEncoding: "data-uri",
          extraBody: budget === null ? {} : { thinking_budget: budget },
          costOf: null,
        });
        const startedAt = Date.now();
        try {
          const reply = await client.generate({
            audio,
            mimeType,
            systemPrompt: SYSTEM_PROMPT,
            reminder: TASK_REMINDER,
            signal: AbortSignal.timeout(90_000),
          });
          const text = String(reply.text ?? "");
          const usage = reply.usage ?? {};
          console.log(`── ${model}  ·  ${budget === null ? "不设预算" : `预算 ${budget}`}`);
          console.log(
            `   ${Date.now() - startedAt} ms · 输入 ${usage.inputTokens}（音频 ${usage.audioTokens}）/ 输出 ${usage.outputTokens}（思考 ${usage.thinkingTokens}）· ${text.length} 字`,
          );
          console.log(`   ${text.replace(/\n+/g, " ⏎ ").slice(0, 200)}`);
          console.log("");
        } catch (error) {
          console.log(`── ${model}  ·  ${budget === null ? "不设预算" : `预算 ${budget}`}`);
          console.log(`   失败（${Date.now() - startedAt} ms）：${error.message}\n`);
        }
      }
    }
    app.exit(0);
  } catch (error) {
    console.log(`出错：${error.message}`);
    app.exit(1);
  }
});
