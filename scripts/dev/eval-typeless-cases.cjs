// 直接测第二跳的整理能力：给它一段模拟的逐字稿，看能不能做到 Typeless 演示的那四件事。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

// 照着 Typeless 引导页那四个例子写的逐字稿（故意保留口头禅、模糊指代、事后补充）
const CASES = [
  ["改口 + 只留最终版", "那个咱们晨会能不能，呃，改到九点？就是……啊不对，九点我其实不太行，那个，还是改到九点半吧。"],
  [
    "事后补充修正前面的名字",
    "你好小明，跟你说一下我换新手机号码了，是13812345678。谢谢，Jack。哦对，小明是黄晓明的晓明。",
  ],
  [
    "利用知识补全模糊指代",
    "我的读书列表是，额，一个是，《活着》，还有一个是第一部哈利波特，叫什么来着，还有一个是《三体》。",
  ],
  [
    "按重要性重排 + 括号备注",
    "周五出门前还有几件事，先提前网上值个机，然后收拾个大的托运行李箱，再把机场停车位订了。哦对，停车位得先订，那个便宜的车位老是一下就没了。哎，行李箱不用那么大，就去两晚，带个登机箱就够了。",
  ],
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
    for (const [label, transcript] of CASES) {
      const startedAt = Date.now();
      const reply = await client.complete({
        system: SYSTEM_PROMPT,
        user: "这是一段语音转写的逐字稿（没整理过）：\n\n" + transcript + "\n\n" + TASK_REMINDER,
        signal: AbortSignal.timeout(60_000),
      });
      console.log("\n===== " + label + "（" + (Date.now() - startedAt) + " ms） =====");
      console.log("原文：" + transcript);
      console.log("成品：");
      for (const line of String(reply.text ?? "").split("\n")) console.log("  " + line);
    }
    app.exit(0);
  } catch (error) {
    console.log("出错：" + error.message);
    app.exit(1);
  }
});
