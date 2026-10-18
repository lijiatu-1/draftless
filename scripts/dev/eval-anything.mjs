// 核心承诺的验收："无论什么都能整理"。
//
// 两层：
//   --text   整理那一跳直接吃 20 种极端逐字稿（空废话、代码、英文、中英混、电话改口、清单、
//            emoji、标点风暴、3000 字长稿、繁体、URL、重复四遍、粗口、名字事后补充……），
//            每个用例带客观断言（包含/不包含/次数/非空），不靠人眼打分
//   --audio  数据目录里**全部**真实录音走产品链路（createModelRefiner 两跳），
//            断言不抛、不超时、返回字符串；静音录音允许空成品
// 默认两层都跑。退出码 1 = 有任何一条断言失败。
//
// 为什么文本层直接喂逐字稿：整理那一跳的输入就是逐字稿，极端输入不必也不该靠合成语音造
// （合成语音没有犹豫和口吃，按它估的东西系统性偏小，这条踩过，见 prompt.mjs 注释）。
// 跑法：node_modules\electron\dist\electron.exe scripts\dev\eval-anything.mjs [--text|--audio]

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const wantText = process.argv.includes("--text") || !process.argv.includes("--audio");
const wantAudio = process.argv.includes("--audio") || !process.argv.includes("--text");

/** 每个用例：名字、逐字稿、断言（成品 → 真/假）、以及断言在人话里的说法 */
const CASES = [
  ["一个字", "好。", (out) => out.includes("好"), "留着这个字"],
  [
    "全废话",
    "嗯。呃。那个。就是。啊。",
    (out) => out === "" || !/嗯|呃|那个|就是|啊/.test(out),
    "全废话整理完是空的才对；若非空则不许留口头禅",
  ],
  [
    "废话连成句",
    "嗯呃啊那个就是这个然后对吧嗯呃",
    (out) => out === "" || !/嗯|呃|那个|就是|然后|对吧/.test(out),
    "同上",
  ],
  [
    "代码",
    "呃帮我记一下，function debounce(fn, delay) { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); }; } 就这样",
    (out) => out.includes("debounce") && out.includes("setTimeout"),
    "代码里的标识符一个都不能丢",
  ],
  [
    "英文",
    "um so please move the standup to nine thirty, no wait, ten",
    (out) => /ten|10/.test(out) && !/nine thirty|9:30/.test(out),
    "改口后的 ten 留下，被否掉的 nine thirty 删掉",
  ],
  [
    "中英混",
    "这个 workflow 里面那个 agent 呃太多了，删掉一个吧",
    (out) => out.includes("workflow") && out.includes("agent"),
    "英文普通词保持原样",
  ],
  [
    "电话改口",
    "呃我的电话是13812345678，哦不对，是13812345679",
    (out) => out.includes("13812345679") && !out.includes("13812345678"),
    "只留改口后的号码",
  ],
  [
    "清单",
    "第一件事吃饭第二件事睡觉第三件事打豆豆",
    (out) => out.includes("1.") && out.includes("3."),
    "并列三件事写成编号列表",
  ],
  [
    "emoji 加又取消",
    "这个按钮加个 🎉 吧，呃不对，不加了",
    (out) => out.includes("不加"),
    "改口被听懂：取消了的决定要留下",
  ],
  ["标点风暴", "？？？！！，，、；；", () => true, "不崩就行"],
  [
    "3000 字长稿尾巴不能丢",
    "呃就是说我们这个项目啊，一开始的时候人很少，后来慢慢多起来了，然后呢，事情也越来越多，就是那种，你知道吧，每天都开会，开完会还要改东西，改完东西还要测，测完还要发，发了还要看日志，看了日志还要改，就是这样循环，然后呢，大家都挺累的，但是也没办法，因为客户那边催得紧，对吧，就是那种催法，一天三个邮件，两个电话，还有一个微信，你说能不累吗，我觉得是不能的，所以说呢，我们就想啊，能不能把一些东西自动化掉，比如说是那个发版的事情，点一下就发出去了，不用一个人盯着，盯着也没用，对吧，就是看着它转圈，转完了一圈又一圈，也不知道成没成，还要自己去查，查完了还要告诉别人，告诉完了还要记下来，记在一个表格里，那个表格呢，又旧又难用，打开还要等半天，等的时候还不能关，关了就要重开，重开又要等，就是这样，所以说呢，自动化是很有必要的，我觉得是吧，大家也都这么觉得，开会的时候说了好几次了，每次都说要做，每次都没做，为什么呢，因为大家都忙嘛，忙起来就忘了，忘了就又拖，拖了就又催，催了就又忙，就是个圈，转啊转的，转到最后呢，谁也不记得最开始是要干什么了，我只记得一件事，就是最后别忘了把钥匙还给门卫老张".repeat(
      3,
    ),
    (out) => out.includes("老张"),
    "长稿的尾巴不能省略",
  ],
  [
    "隔句改口",
    "周二开会。对了不是周二是下周三。",
    (out) => out.includes("下周三") && !out.includes("周二开会"),
    "被否掉的那句不留",
  ],
  [
    "问句不许答",
    "你觉得这个方案行吗？呃我是说你觉得风险大吗",
    (out) => out.trim().endsWith("？") && !/我认为|我建议|首先/.test(out),
    "只写他的问话，不替他答",
  ],
  ["繁体", "這個方案我覺得可以，呃就這樣吧", (out) => out.includes("这个方案我觉得可以"), "一律简体"],
  [
    "URL",
    "把那个地址改成 https://example.com/a/b 呃后面加个参数 c=1",
    (out) => out.includes("https://example.com/a/b"),
    "地址原样保留",
  ],
  [
    "同一句四遍",
    "把灯关掉。把灯关掉。把灯关掉。把灯关掉。",
    (out) => (out.match(/把灯关掉/g) ?? []).length === 1,
    "说四遍也只写一遍",
  ],
  ["粗口照留", "这破玩意儿真他妈难用，呃改一下", (out) => out.includes("他妈"), "不替他改文雅"],
  [
    "名字事后补充",
    "给小明发消息。哦对小明是黄晓明的晓明。",
    (out) => out.includes("晓明") && !out.includes("给小明发"),
    "回去改前面那个名字",
  ],
  [
    "换行和多余空格",
    "第一行\n\n第二行   多余空格",
    (out) => out.includes("第一行") && out.includes("第二行"),
    "内容不丢",
  ],
  [
    "数字日期版本",
    "呃1.5.0 版本 8 月 21 号发，转化率 60%，4 张图",
    (out) => out.includes("1.5.0") && out.includes("60%"),
    "数字写阿拉伯数字",
  ],
];

app.whenReady().then(async () => {
  const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
  const failures = [];

  if (wantText) {
    const { createClient } = await import("../../src/server/chat/openai-chat.mjs");
    const { SYSTEM_PROMPT, TASK_REMINDER, NO_SPEECH_MARK } = await import("../../src/server/refine/prompt.mjs");
    const { transcriptNote } = await import("../../src/server/refine/two-stage.mjs");
    const polish = createClient({
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      apiKey,
      model: "qwen-plus",
      name: "Qwen",
    });
    console.log(`=== 文本层：${CASES.length} 种极端逐字稿 ===`);
    for (const [name, transcript, assert, why] of CASES) {
      const startedAt = Date.now();
      try {
        const reply = await polish.complete({
          system: SYSTEM_PROMPT,
          user: transcriptNote(transcript, ""),
          signal: AbortSignal.timeout(30_000),
        });
        const out = String(reply.text ?? "")
          .replace(NO_SPEECH_MARK, "")
          .trim();
        const ms = Date.now() - startedAt;
        const ok = assert(out);
        console.log(`${ok ? "PASS" : "FAIL"}  ${name}  ${ms} ms  → ${out.slice(0, 60).replace(/\n/g, " ")}`);
        if (!ok) failures.push(`${name}：${why}（成品：${out.slice(0, 80)}）`);
      } catch (error) {
        failures.push(`${name}：抛了 ${error.message}`);
        console.log(`FAIL  ${name}  抛了 ${error.message}`);
      }
    }
    void TASK_REMINDER;
  }

  if (wantAudio) {
    const { createModelRefiner } = await import("../../src/server/refine/refiner.mjs");
    const refiner = await createModelRefiner({
      choice: { provider: "qwen", model: "qwen3.5-omni-plus" },
      apiKey,
      log: { info() {}, warn() {}, error() {} },
    });
    const dir = join(HOME, "data", "Recordings");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".webm"))
      .sort();
    console.log(`\n=== 音频层：${files.length} 条真实录音全量过链 ===`);
    let empty = 0;
    for (const file of files) {
      const webm = readFileSync(join(dir, file));
      const startedAt = Date.now();
      try {
        const text = await refiner.refine(webm, { mimeType: "audio/webm", audioId: file.slice(0, 8) });
        const ms = Date.now() - startedAt;
        if (text === "") empty += 1;
        const slow = ms > 30_000 ? "  ⚠超慢" : "";
        console.log(
          `PASS  ${file.slice(0, 8)}  ${(ms / 1000).toFixed(1)}s  ${text.length} 字${slow}  ${text.slice(0, 34).replace(/\n/g, " ")}`,
        );
        if (ms > 30_000) failures.push(`${file.slice(0, 8)}：${ms} ms 超过 30 秒`);
      } catch (error) {
        failures.push(`${file.slice(0, 8)}：抛了 ${error.message}`);
        console.log(`FAIL  ${file.slice(0, 8)}  抛了 ${error.message}`);
      }
    }
    console.log(`（其中 ${empty} 条成品为空：静音录音，属正确行为）`);
  }

  console.log(failures.length === 0 ? "\n全部通过。" : `\n${failures.length} 条失败：`);
  for (const f of failures) console.log("  - " + f);
  app.exit(failures.length === 0 ? 0 : 1);
});
