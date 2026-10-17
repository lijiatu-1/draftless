// 一次性端到端脚本（不进产品）：拿一段真的中文语音，走 Draftless 自己的 refiner，
// 看 Qwen 到底整理成什么、花多久、多少 token。key 用 safeStorage 解开，只在这个进程里用。
//
// 用法（仓库根目录）：
//   node_modules\electron\dist\electron.exe scripts\dev\try-real-audio.mjs
//
// 为什么用 electron 而不给 node：key 是 DPAPI 加密的，只有 Electron 主进程能解开。

const { app, safeStorage } = require("electron");
const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

// 必须在 app ready 之前设：Electron 的 safeStorage 在 Windows 上走 Chromium 的 OSCrypt，
// AES 密钥放在 userData 的 Local State 里（再用 DPAPI 包一层）。用默认的 userData 就找不到那把密钥，
// 解出来会报 "Error while decrypting the ciphertext"。draftless 自己设的就是 <家>\cache，
// 所以这里跟上（见 src/app/main.mjs 的 app.setPath）。
const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const WAV = process.env.PROBE_WAV ?? join(process.env.TEMP ?? "/tmp", "fs-real-speech.wav");

app.whenReady().then(async () => {
  const keyPath = join(HOME, "qwen-key.bin");
  let apiKey;
  try {
    apiKey = safeStorage.decryptString(readFileSync(keyPath));
  } catch (error) {
    console.log(`读不到 key（${keyPath}）：${error.message}`);
    app.exit(1);
    return;
  }

  if (!existsSync(WAV)) {
    console.log("找不到录音：");
    console.log(WAV);
    console.log("先生成一段：跑 scriptsdevprobe-qwen-thinking.cjs 会把默认那段造出来，");
    console.log("或者用 FASTSPEAK 的 PROBE_WAV 指到别的 wav");
    app.exit(1);
    return;
  }
  const audio = readFileSync(WAV);
  console.log(`录音：${WAV}，${(audio.length / 1024).toFixed(1)} KB`);
  console.log(`key：${apiKey.length} 个字符（不打印）\n`);

  // 动态 import：这段代码是 ESM，Electron 主进程这边是 CJS
  const { createModelRefiner } = await import("../../src/server/refine/refiner.mjs");

  const calls = [];
  const log = {
    info: (event, fields) => console.log(`  [info] ${event} ${JSON.stringify(fields ?? {})}`),
    warn: (event, fields) => console.log(`  [warn] ${event} ${JSON.stringify(fields ?? {})}`),
    error: (event, fields) => console.log(`  [error] ${event} ${JSON.stringify(fields ?? {})}`),
  };

  const refiner = await createModelRefiner({
    choice: { provider: "qwen", model: process.env.PROBE_MODEL ?? "qwen3.8-omni-flash" },
    apiKey,
    log,
    onCall: (record) => calls.push(record),
  });

  // PROBE_REPEAT：同一段录音连着跑几次，看稳不稳定（这是这次要验的重点：
  // 不设思考上限时，同一段录音耗时能从 2.3 秒蹦到 29.6 秒）
  const repeat = Number(process.env.PROBE_REPEAT ?? 1);
  for (let i = 1; i <= repeat; i += 1) {
    calls.length = 0;
    const startedAt = Date.now();
    try {
      const text = await refiner.refine(audio, { mimeType: "audio/wav", audioId: `probe-real-audio-${i}` });
      const ms = Date.now() - startedAt;
      const call = calls.at(-1) ?? {};
      console.log(`\n===== 第 ${i} 遍（${ms} ms，思考 ${call.thinkingTokens ?? "?"} token）=====`);
      console.log(text === "" ? "（空字符串：它没听出人声）" : text);
    } catch (error) {
      console.log(`\n===== 第 ${i} 遍 失败（${Date.now() - startedAt} ms）=====`);
      console.log(error.message);
      if (error.kind) console.log(`kind=${error.kind} problem=${JSON.stringify(error.problem)}`);
    }
  }
  if (repeat > 1) {
    console.log("\n===== 记账（最后一次）=====");
    console.log(JSON.stringify(calls.at(-1) ?? null));
  }
  app.exit(0);
});
