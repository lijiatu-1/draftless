// 专测"换着说法重复"能不能被合并掉。
// 判据很硬：成品里 不达标 / 为什么会这样 是不是只剩一句。
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

// 09:09 那条：里面有「为什么会不达标」+「为什么会这样」两遍
const RECORDING = "2ac076d4-d488-4422-876c-4262731acc45";

const _DUP_EXAMPLE = [
  "例九",
  "口述：这个数据为什么会不对呢？为什么会这样呢？你说呢？",
  "输出：",
  "这个数据为什么会不对？你说呢？",
].join("\n");

const _RULE =
  "同一个意思他问了两遍、只是换了措辞的（「为什么会不达标」和「为什么会这样」是同一句），只留说得更具体的那一句，另一句删掉。";

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { toWav } = await import("../../src/server/audio/transcode.mjs");
    const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");
    const { createClient } = await import("../../src/server/providers/qwen.mjs");

    const webm = readFileSync(join(HOME, "data", "Recordings", `${RECORDING}.webm`));
    const { audio, mimeType } = await toWav(webm, "audio/webm");

    // 同一份提示词、同一条录音，跑 5 次数命中率：语义去重到底稳不稳定
    let merged = 0;
    let both = 0;
    for (let i = 1; i <= 5; i += 1) {
      const client = createClient({ apiKey, model: "qwen3.5-omni-plus" });
      const reply = await client.generate({
        audio,
        mimeType,
        systemPrompt: SYSTEM_PROMPT,
        reminder: TASK_REMINDER,
        signal: AbortSignal.timeout(60_000),
      });
      const text = String(reply.text ?? "");
      const hasA = text.includes("不达标");
      const hasB = text.includes("为什么会这样");
      if (hasA && hasB) both += 1;
      if (hasA && !hasB) merged += 1;
      console.log(
        "第 " +
          i +
          " 次：" +
          (hasA && hasB ? "两句都在" : hasA && !hasB ? "合并成一句" : "删过头") +
          "  " +
          text.slice(-32),
      );
    }
    console.log("");
    console.log(`合并成功 ${merged}/5，两句都留 ${both}/5`);
    app.exit(0);
  } catch (error) {
    console.log(`出错：${error.message}`);
    app.exit(1);
  }
});
