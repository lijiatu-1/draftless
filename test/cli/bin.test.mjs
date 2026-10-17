import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { openHistory } from "../../src/storage/history.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

const BIN = resolve(import.meta.dirname, "..", "..", "bin", "draftless.mjs");

test("输出接到 head 这类只读开头就关掉的程序上：安静地结束，不甩一屏报错", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // 历史要多到一次写不完：管道那头关掉时这边还在写
  const history = openHistory(resolvePaths({ DRAFTLESS_HOME: dir }).historyDb);
  for (let index = 0; index < 400; index++) {
    history.add({
      id: `id-${index}`,
      status: "completed",
      refinedText: "一句不短的话。".repeat(60),
      error: null,
      duration: 3,
      audioLocalPath: null,
      createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
    });
  }
  history.close();

  // Windows 上没有 head：自己来当那个"读够就关掉"的读者。这边读到头一段就把管道关掉，
  // 效果和 `| head -c 10 >/dev/null` 一样：写的那头还在写，会收到 EPIPE
  const child = spawn(process.execPath, [BIN, "history", "-n", "400", "--json"], {
    env: { ...process.env, DRAFTLESS_HOME: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  // 关掉管道这一下本身也会在这边报一个错，不是被测的行为
  child.stdout.on("error", () => {});
  const exited = new Promise((resolveExit) => child.once("close", resolveExit));
  child.stdout.once("data", () => child.stdout.destroy());

  assert.equal(await exited, 0);
  assert.equal(stderr, "");
});

test("说什么语言：设置里写了就用它；跟随系统时看终端的 LC_ALL、LC_MESSAGES、LANG；认不出来是英文", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { LC_ALL: _all, LC_MESSAGES: _messages, LANG: _lang, ...base } = process.env;
  const helpIn = (env) =>
    spawnSync(process.execPath, [BIN, "help"], {
      encoding: "utf8",
      env: { ...base, DRAFTLESS_HOME: dir, ...env },
    }).stdout.split("\n")[0];

  assert.equal(helpIn({ LANG: "zh_CN.UTF-8" }), "draftless：按一下热键说话，整理好的文字贴进当前输入框。");
  assert.match(helpIn({ LANG: "en_US.UTF-8" }), /^draftless: press a hotkey/);
  assert.match(helpIn({ LANG: "zh_CN.UTF-8", LC_ALL: "en_GB.UTF-8" }), /^draftless: press a hotkey/);
  // 繁体、日文、C：我们没有，用英文
  for (const LANG of ["zh_TW.UTF-8", "ja_JP.UTF-8", "C"]) assert.match(helpIn({ LANG }), /^draftless: press/, LANG);
  assert.match(helpIn({}), /^draftless: press/);

  // 设置里定了的话盖过终端的语言；环境变量 DRAFTLESS_LANGUAGE 又盖过设置
  writeFileSync(resolvePaths({ DRAFTLESS_HOME: dir }).settingsFile, JSON.stringify({ language: "zh-CN" }));
  assert.match(helpIn({ LANG: "en_US.UTF-8" }), /^draftless：/);
  assert.match(helpIn({ LANG: "zh_CN.UTF-8", DRAFTLESS_LANGUAGE: "en" }), /^draftless: press/);
  // 设置文件坏了：先按终端的语言说，坏在哪由读设置的命令报
  writeFileSync(resolvePaths({ DRAFTLESS_HOME: dir }).settingsFile, "{ 坏了");
  assert.match(helpIn({ LANG: "zh_CN.UTF-8" }), /^draftless：/);
});

test("Node 太旧：按终端的语言说要哪个版本；旧到连文案那一层都加载不了时用英文说，不甩调用栈", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "sm-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  /** 装成某个版本的 Node；ancient 时再拿掉 16.9 以前没有的写法 */
  const runAs = (version, { ancient = false, LANG = "zh_CN.UTF-8" } = {}) => {
    const preload = join(dir, `${version}.mjs`);
    writeFileSync(
      preload,
      `Object.defineProperty(process.versions, "node", { value: ${JSON.stringify(version)} });\n` +
        (ancient ? "delete String.prototype.replaceAll;\ndelete Object.hasOwn;\n" : ""),
    );
    const { LC_ALL: _all, LC_MESSAGES: _messages, ...base } = process.env;
    // --import 要的是一个 URL：Windows 上直接把 D:\... 交给它会报 ERR_UNSUPPORTED_ESM_URL_SCHEME
    return spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, BIN, "help"], {
      encoding: "utf8",
      env: { ...base, DRAFTLESS_HOME: dir, LANG },
    });
  };

  const zhTerminal = runAs("20.18.1");
  assert.equal(zhTerminal.status, 1);
  assert.equal(zhTerminal.stderr, "draftless 需要 Node 22.13 或更新的版本（23 系列要 23.4 以上），现在是 20.18.1。\n");

  const ancient = runAs("14.21.3", { ancient: true });
  assert.equal(ancient.status, 1);
  assert.equal(
    ancient.stderr,
    "draftless needs Node 22.13 or newer (23.4 or newer on the 23 line); this is 14.21.3.\n",
  );
});
