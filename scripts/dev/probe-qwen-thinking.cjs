// 诊断脚本 2（Electron 版，自己读 key）：找出让 Qwen 别思考的那个参数。
//
// 起因：真机跑了三次，同一个模型、同一段代码，思考量从 73 涨到 1709 个 token，
// 耗时从 2.3 秒涨到 29.6 秒，几次撞上 20 秒的界面超时。听写整理这个任务用不着思考。
//
// 用法（仓库根目录）：
//   node_modules\electron\dist\electron.exe scripts\dev\probe-qwen-thinking.cjs
//
// 为什么用 electron：key 是 Chromium 的 OSCrypt（DPAPI 包着 AES 密钥，密钥在 userData 的
// Local State 里）加密的，只有同一个 userData 的 Electron 进程能解开。

const { app, safeStorage } = require("electron");
const { existsSync, readFileSync } = require("node:fs");
const { execFileSync } = require("node:child_process");
const { homedir } = require("node:os");
const { join } = require("node:path");

// userData 要跟 draftless 一致，否则 safeStorage 找不到那把 AES 密钥（见 try-real-audio.cjs 的说明）
const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const BASE = process.env.DRAFTLESS_QWEN_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1";
const MODEL = process.env.PROBE_MODEL ?? "qwen3.8-omni-flash";
const WAV = process.env.PROBE_WAV ?? join(process.env.TEMP ?? "/tmp", "fs-real-speech.wav");
const SENTENCE = "嗯，我们这个项目呢，原定是下周三上线，不对，是下周四上线，然后测试那边还需要大概两天时间。";

/** 没有测试录音就用 Windows 自带的语音合成造一个 */
function ensureAudio() {
  if (existsSync(WAV)) return;
  const script = [
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    '$s.SelectVoice("Microsoft Huihui Desktop");',
    `$s.SetOutputToWaveFile("${WAV}");`,
    `$s.Speak("${SENTENCE}");`,
    "$s.Dispose()",
  ].join(" ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { windowsHide: true, stdio: "ignore" });
}

/** 几种写法。label 就是我在试的假设；strict 表示换成更强硬的提示词 */
const CASES = [
  { label: "A. 基线（开思考，不设上限）", extra: {} },
  { label: "B. thinking_budget: 128（给思考设上限）", extra: { thinking_budget: 128 } },
  { label: "C. thinking_budget: 256", extra: { thinking_budget: 256 } },
  { label: "D. enable_thinking: true + thinking_budget: 200", extra: { enable_thinking: true, thinking_budget: 200 } },
  {
    label: "E. enable_thinking: false + 强硬提示词（关思考，靠提示词逼它整理）",
    extra: { enable_thinking: false },
    strict: true,
  },
];

/** 平时的系统提示词（和 Draftless 自己那份口径一致） */
const PROMPT = "你是语音整理的助手，把录音整理成可以直接用的文字。";

/** 更强硬的一份：把"删掉什么"逐条说清，看关掉思考时能不能靠它补上整理 */
const STRICT_PROMPT =
  "你是语音整理的助手。把录音整理成可以直接用的文字，必须做到：" +
  "1) 删掉所有口头禅、语气词、犹豫和重复（嗯、呃、那个、就是说、然后）；" +
  "2) 说话人改口时只保留最后的说法（比如“周三，不对，周四”只写“周四”）；" +
  "3) 不要保留任何原话里的停顿或自我纠正；4) 只输出整理后的正文，不要解释。";

const REMINDER = "整理上面这段录音。";

/** 成品里还留着这些东西，就说明它只做了转写、没有整理 */
const FILLERS = /嗯|呃|那个|就是说|不对|我想想/;

async function once(key, item, audioB64) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: item.strict ? STRICT_PROMPT : PROMPT },
      {
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: audioB64, format: "wav" } },
          { type: "text", text: REMINDER },
        ],
      },
    ],
    ...item.extra,
  };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const ms = Date.now() - startedAt;
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      return { ok: false, ms, said: `回的不是 JSON：${text.slice(0, 150)}` };
    }
    if (!response.ok) {
      const code = payload?.error?.code ?? "";
      const message = payload?.error?.message ?? "";
      return { ok: false, ms, said: `${code} ${message}`.trim().slice(0, 200) };
    }
    const usage = payload.usage ?? {};
    return {
      ok: true,
      ms,
      thinking: usage.completion_tokens_details?.reasoning_tokens ?? 0,
      output: usage.completion_tokens ?? 0,
      audio: usage.prompt_tokens_details?.audio_tokens ?? 0,
      content: String(payload.choices?.[0]?.message?.content ?? "").trim(),
    };
  } catch (error) {
    return { ok: false, ms: Date.now() - startedAt, said: `连不上或超时：${error.message}` };
  } finally {
    clearTimeout(timer);
  }
}

app.whenReady().then(async () => {
  ensureAudio();
  const audio = readFileSync(WAV);
  const audioB64 = `data:audio/wav;base64,${audio.toString("base64")}`;

  let key;
  try {
    key = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
  } catch (error) {
    console.log(`读不到 key：${error.message}`);
    app.exit(1);
    return;
  }

  console.log(`\n模型：${MODEL}`);
  console.log(`录音：${(audio.length / 1024).toFixed(1)} KB（约 12 秒中文）`);
  console.log(`key：${key.length} 个字符\n`);
  console.log("每种各跑 2 遍，看稳不稳定：\n");

  for (const item of CASES) {
    console.log(`── ${item.label}`);
    for (let i = 1; i <= 2; i += 1) {
      const r = await once(key, item, audioB64);
      if (r.ok) {
        // 成品里还留着口头禅/改口，就是只做了转写：这一列比耗时更能说明有没有用
        const verdict = FILLERS.test(r.content) ? "❌ 只转写" : "✅ 整理过";
        console.log(
          `   第 ${i} 遍：${String(r.ms).padStart(6)} ms · 思考 ${String(r.thinking).padStart(4)} · 输出 ${String(r.output).padStart(4)} · ${verdict}`,
        );
        console.log(`           成品：${r.content.slice(0, 80)}${r.content.length > 80 ? "…" : ""}`);
      } else {
        console.log(`   第 ${i} 遍：${r.ms} ms ❌ ${r.said}`);
      }
    }
    console.log("");
  }

  console.log("===== 怎么读这张表 =====");
  console.log("要的是「✅ 整理过 + 耗时稳 + 思考少」那一行。只有 ✅ 没有快，或者只有快没有 ✅，都不算。");
  console.log("如果 B/C 都报 400（说不认识这个参数），说明兼容模式不让关，只能换型号或加大超时。");
  app.exit(0);
});
