// 用产品代码验证两跳：omni 只转写 → qwen-plus 整理。
// 判据：09:09 那条里的「为什么会不达标」和「为什么会这样」是同一件事，看能不能合成一句。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { app, safeStorage } from "electron";

const HOME = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
app.setPath("userData", join(HOME, "cache"));
app.disableHardwareAcceleration();

const RECORDINGS = [
  ["2ac076d4-d488-4422-876c-4262731acc45", "33.4 秒（有「为什么会不达标」+「为什么会这样」两遍）"],
  ["72bbb09c-8805-4f8f-bfcf-b37c0c2e6111", "19.4 秒"],
  ["07ccf89c-64d9-4255-96ec-e20f5838d2b4", "14.2 秒"],
];

app.whenReady().then(async () => {
  try {
    const apiKey = safeStorage.decryptString(readFileSync(join(HOME, "qwen-key.bin")));
    const { createModelRefiner } = await import("../../src/server/refine/refiner.mjs");
    const log = {
      info() {},
      warn: (event, fields) => console.log(`   [warn] ${event} ${JSON.stringify(fields ?? {}).slice(0, 120)}`),
      error: (event, fields) => console.log(`   [err] ${event} ${JSON.stringify(fields ?? {}).slice(0, 120)}`),
    };
    const calls = [];
    const refiner = await createModelRefiner({
      choice: { provider: "qwen", model: "qwen3.5-omni-plus" },
      apiKey,
      log,
      onCall: (record) => calls.push(record),
    });

    for (const [id, label] of RECORDINGS) {
      const webm = readFileSync(join(HOME, "data", "Recordings", `${id}.webm`));
      const startedAt = Date.now();
      try {
        const text = await refiner.refine(webm, { mimeType: "audio/webm", audioId: id });
        const ms = Date.now() - startedAt;
        const hasA = text.includes("不达标");
        const hasB = text.includes("为什么会这样");
        console.log(`\n===== ${label}  ${ms} ms  ${text.length} 字 =====`);
        if (id.startsWith("2ac0")) {
          console.log(
            "   语义重复：不达标=" +
              hasA +
              "  为什么会这样=" +
              hasB +
              "  => " +
              (hasA && hasB ? "两句都留（失败）" : hasA || hasB ? "只留了一句" : "都删了"),
          );
        }
        console.log(text);
      } catch (error) {
        console.log(`\n===== ${label} 失败：${error.message}`);
      }
    }
    console.log("\n=== 记账（两跳应该各有两条） ===");
    for (const c of calls) {
      console.log(
        "   " +
          c.purpose +
          "  " +
          c.model +
          "  in=" +
          c.inputTokens +
          " out=" +
          c.outputTokens +
          "  " +
          c.latencyMs +
          "ms  cost=" +
          c.costUsd,
      );
    }
    app.exit(0);
  } catch (error) {
    console.log(`出错：${error.message}`);
    app.exit(1);
  }
});
