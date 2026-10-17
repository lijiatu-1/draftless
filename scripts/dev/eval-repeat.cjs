// 同一条录音、同一份提示词跑三次：看输出波动有多大。
//
// 为什么要做这个：前面比较不同提示词时，每条只跑了一次。如果同一条记录三次能差 2-3 个填充词，
// 那"变体 A 比 B 好"这种结论就站不住——差异可能全在噪声里。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const RECORDING = "2ac076d4-d488-4422-876c-4262731acc45"; // 09:09 那条，33 秒
const FILLERS = ["嗯", "呃", "啊", "那个", "就是说", "知道不", "还是啥", "反正", "所以说", "然后"];
const count = (t) => FILLERS.reduce((s, w) => s + t.split(w).length - 1, 0);

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { toWav } = await import("../../src/server/audio/transcode.mjs");
    const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");
    const { createClient } = await import("../../src/server/providers/qwen.mjs");
    const webm = readFileSync(join(HOME, "data", "Recordings", `${RECORDING}.webm`));
    const { audio, mimeType } = await toWav(webm, "audio/webm");

    const counts = [];
    for (let i = 1; i <= 3; i += 1) {
      const client = createClient({ apiKey, model: "qwen3.5-omni-plus" });
      const reply = await client.generate({
        audio,
        mimeType,
        systemPrompt: SYSTEM_PROMPT,
        reminder: TASK_REMINDER,
        signal: AbortSignal.timeout(60_000),
      });
      const text = String(reply.text ?? "");
      const n = count(text);
      counts.push(n);
      console.log(`--- 第 ${i} 次：${n} 个填充词，${text.length} 字`);
      console.log(`    ${text.replace(/\n+/g, " / ")}`);
    }
    console.log("");
    console.log(`填充词次数：${counts.join(", ")}  极差 ${Math.max(...counts) - Math.min(...counts)}`);
    app.exit(0);
  } catch (error) {
    console.log(`出错：${error.message}`);
    app.exit(1);
  }
});
