const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

// 用户刚说的原话，以及几个同类的"顺序流水账"
const CASES = [
  "明天我要先吃饭，然后再去打球，打完球再回来洗澡，洗完澡之后再睡觉",
  "我先去超市买点菜，然后回家做饭，做完饭吃完之后呢，再去看会儿电视，看完电视就睡觉",
  "这个流程是这样的，先登录后台，然后找到那个设置页面，进去之后改一下时区，改完保存就行",
];

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { createClient } = await import("../../src/server/chat/openai-chat.mjs");
    const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");
    const client = createClient({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey,
      model: "qwen-plus",
      name: "Qwen",
    });
    for (const transcript of CASES) {
      const startedAt = Date.now();
      const reply = await client.complete({
        system: SYSTEM_PROMPT,
        user: "这是一段语音转写的逐字稿（没整理过）：\n\n" + transcript + "\n\n" + TASK_REMINDER,
        signal: AbortSignal.timeout(60_000),
      });
      console.log("\n===== " + (Date.now() - startedAt) + " ms =====");
      console.log("原文：" + transcript);
      console.log("成品：" + String(reply.text ?? ""));
    }
    app.exit(0);
  } catch (error) {
    console.log("出错：" + error.message);
    app.exit(1);
  }
});
