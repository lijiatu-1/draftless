// 验证"分工"这条路：让 omni 只负责听（关思考、快），把转写稿交给 qwen-plus 整理。
//
// 用法：node_modules\electron\dist\electron.exe scripts\dev\eval-two-stage.cjs [录音]
//
// 为什么这么试：一直让 qwen3.8-omni-flash（小型多模态模型）既听又整理，然后靠调 thinking_budget
// 逼它整理好——那是在拟合现象。原版的 local 模式早给了分工的答案：
// 一个模型负责听、一个文本模型负责整理。这里把第一步也从本机换成云端，看看纯 Qwen 能不能做到。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const RECORDING = process.argv[2] || join(HOME, "data", "Recordings", "98623181-55a4-4913-b8a3-37bf9f539355.webm");

app.whenReady().then(async () => {
  const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
  const { toWav } = await import("../../src/server/audio/transcode.mjs");
  const { wavSeconds } = await import("../../src/server/audio/pcm.mjs");
  const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");
  const { createClient: createAudioClient } = await import("../../src/server/providers/openai-audio.mjs");
  const { createClient: createChatClient } = await import("../../src/server/chat/openai-chat.mjs");

  const webm = readFileSync(RECORDING);
  const { audio, mimeType } = await toWav(webm, "audio/webm");
  console.log(`录音：${(webm.length / 1024).toFixed(0)} KB → ${wavSeconds(audio).toFixed(1)} 秒\n`);

  // 第一步：只让它听。关掉思考，这样它不会一边听一边纠结怎么整理
  const transcriber = createAudioClient({
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    name: "Qwen",
    apiKey,
    model: "qwen3.8-omni-flash",
    audioEncoding: "data-uri",
    extraBody: { enable_thinking: false },
    costOf: null,
  });
  const t1 = Date.now();
  const heard = await transcriber.generate({
    audio,
    mimeType,
    systemPrompt: "你是语音转写引擎。把听到的话逐字写下来，不要整理、不要改口、不要删口头禅。只输出听到的字。",
    reminder: "逐字转写上面这段录音。",
    signal: AbortSignal.timeout(60_000),
  });
  const raw = String(heard.text ?? "");
  console.log(`── 第一步：qwen3.8-omni-flash 只转写（关思考）`);
  console.log(`   ${Date.now() - t1} ms · 思考 ${heard.usage?.thinkingTokens ?? "?"} · ${raw.length} 字`);
  console.log(`   ${raw}\n`);

  // 第二步：纯文本模型整理。它没有"听"的负担，只有文字改写的活
  for (const model of ["qwen-plus", "qwen-max"]) {
    const polisher = createChatClient({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey,
      model,
      name: "Qwen",
    });
    const t2 = Date.now();
    try {
      const reply = await polisher.complete({
        system: SYSTEM_PROMPT,
        user: `这是语音转写的原文（没有整理过，带口头禅和改口）：\n\n${raw}\n\n${TASK_REMINDER}`,
        signal: AbortSignal.timeout(60_000),
      });
      const text = String(reply.text ?? "");
      console.log(`── 第二步：${model} 整理`);
      console.log(`   ${Date.now() - t2} ms · ${text.length} 字`);
      console.log(`   成品：`);
      for (const line of text.split("\n")) console.log(`     ${line}`);
      console.log("");
    } catch (error) {
      console.log(`── 第二步：${model} 失败：${error.message}\n`);
    }
  }
  app.exit(0);
});
