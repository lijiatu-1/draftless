// 拿三条真实录音试不同的系统提示词，看哪个能把口头禅真的删掉。
//
// 用法：node_modules\electron\dist\electron.exe scripts\dev\eval-prompt-qwen.cjs
//
// 为什么要有这个：prompt.mjs 那份是**对着 Gemini 调的**（当初用 60 条真实录音跑 12 遍调的），
// 换到 Qwen 上就该重调一遍——这正是当初调提示词的做法，只是对象换了。
//
// 变体的设计依据（都是看真实数据得出的，不是拍的）：
//   1. 原版的 7 个例子全是 10-30 字的短句，而用户每次要说 20-40 秒 -> 试"补一个长段例子"
//   2. 原版"保持是他的话"那 3 条比"删"的 4 条更具体（带例子），可能让模型偏保守 -> 试"把删提到第一动作"
const { app, safeStorage } = require("electron");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

/** 三条真实录音：都是用户自己说的话，30 秒上下、口头禅密集 */
const RECORDINGS = [
  ["09:09（33 秒，质问式，废话最密）", "2ac076d4-d488-4422-876c-4262731acc45"],
  ["09:00（19 秒）", "72bbb09c-8805-4f8f-bfcf-b37c0c2e6111"],
  ["08:57（14 秒）", "07ccf89c-64d9-4255-96ec-e20f5838d2b4"],
];

/** 明显是废话的词：成品里剩得越少越好 */
const FILLERS = ["嗯", "呃", "啊", "那个", "就是说", "知道不", "还是啥", "反正", "所以说", "然后"];
const countFillers = (text) => FILLERS.reduce((sum, word) => sum + text.split(word).length - 1, 0);

/** 补的那个长段例子：模仿用户的说话风格——连续追问、废话密集、带改口 */
const _LONG_EXAMPLE = [
  "例",
  "口述：那你现在是在做什么呢？我没说你要用那个 key 啊，就是说你用千问的，然后你给千问设计提示词呀，你不是说了吗，有很多是通用的，你只需要改那个提示词不就行了吗",
  "输出：",
  "你现在是在做什么？我没说要用那个 key。你用千问的，就给千问设计提示词。你不是说了很多是通用的吗？只需要改那个提示词不就行了？",
].join("\n");

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { toWav } = await import("../../src/server/audio/transcode.mjs");
    const { wavSeconds } = await import("../../src/server/audio/pcm.mjs");
    const { SYSTEM_PROMPT, TASK_REMINDER } = await import("../../src/server/refine/prompt.mjs");
    const { createClient } = await import("../../src/server/providers/qwen.mjs");
    const { findProvider } = await import("../../src/server/providers/index.mjs");

    const _LEAD =
      "你的第一动作是删：每句话先删掉填充词（嗯、呃、啊、那个、这个、就是、就是说、然后、反正、所以说、你知道吧、还是啥、对吧）、重复、改口的痕迹，删完再把剩下的字连起来。删不干净就是没完成。";

    const VARIANTS = [{ name: "现在的产品提示词（含例八）", prompt: SYSTEM_PROMPT }];

    const model = findProvider("qwen").defaultModel;
    console.log(`模型：${model}\n`);

    for (const [label, id] of RECORDINGS) {
      const webm = readFileSync(join(HOME, "data", "Recordings", `${id}.webm`));
      const { audio, mimeType } = await toWav(webm, "audio/webm");
      console.log("\n========================================");
      console.log(`=== ${label} · ${wavSeconds(audio).toFixed(1)} 秒 ===`);
      console.log("========================================");

      for (const variant of VARIANTS) {
        const client = createClient({ apiKey, model });
        const startedAt = Date.now();
        try {
          const reply = await client.generate({
            audio,
            mimeType,
            systemPrompt: variant.prompt,
            reminder: TASK_REMINDER,
            signal: AbortSignal.timeout(60_000),
          });
          const text = String(reply.text ?? "");
          console.log(
            "\n-- " +
              variant.name +
              "（" +
              (Date.now() - startedAt) +
              " ms · " +
              text.length +
              " 字 · 填充词 " +
              countFillers(text) +
              "）",
          );
          for (const line of text.split("\n")) console.log(`   ${line}`);
        } catch (error) {
          console.log(`\n-- ${variant.name}\n   失败：${error.message}`);
        }
      }
    }
    app.exit(0);
  } catch (error) {
    console.log(`出错：${error.message}`);
    app.exit(1);
  }
});
