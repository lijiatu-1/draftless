import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { controlPipeName, ensureHome, keyFile, resolvePaths } from "../../src/storage/paths.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

const HOME = "C:\\Users\\someone";
const UNDER_HOME = `${HOME}\\.draftless`;

test("所有东西都在家目录下的 .draftless 这一个目录里", () => {
  const paths = resolvePaths({}, HOME);
  assert.equal(paths.home, UNDER_HOME);
  // 控制通道不是文件，是命名管道，单独在下面测
  for (const [name, path] of Object.entries(paths)) {
    if (name === "controlPipe") continue;
    assert.ok(path === paths.home || path.startsWith(`${UNDER_HOME}\\`), `${name}: ${path}`);
  }
});

test("你的东西、运行时产生的，各在各的位置", () => {
  const paths = resolvePaths({}, HOME);
  const inHome = Object.fromEntries(
    Object.entries(paths)
      .filter(([name]) => name !== "controlPipe")
      .map(([name, path]) => [name, path.slice(paths.home.length + 1)]),
  );
  assert.deepEqual(inHome, {
    home: "",
    // 装好的程序自己（从源码跑时不存在）
    appDir: "app",
    // 你的东西
    settingsFile: "settings.json",
    historyDb: "data\\history.db",
    recordingsDir: "data\\Recordings",
    // 用到时自动下载的本地模型
    modelsDir: "models",
    // 运行时产生的，删了会自己再建
    logFile: "logs\\main.log",
    pidFile: "run\\daemon.pid",
    updateCheckFile: "run\\update-check.json",
    cacheDir: "cache",
  });
});

test("控制通道是命名管道：\\\\.\\pipe\\ 下、带一份数据目录的指纹，两份数据目录不会撞", () => {
  const a = resolvePaths({ DRAFTLESS_HOME: join(HOME, "a") }, HOME).controlPipe;
  const b = resolvePaths({ DRAFTLESS_HOME: join(HOME, "b") }, HOME).controlPipe;
  assert.match(a, /^\\\\\.\\pipe\\draftless-[0-9a-f]{16}$/);
  assert.notEqual(a, b);
  // 同一个目录算两次结果一样：命令行和后台要靠它找到彼此
  assert.equal(a, resolvePaths({ DRAFTLESS_HOME: join(HOME, "a") }, HOME).controlPipe);
  // 大小写不算两样东西：Windows 的路径本来就不区分
  assert.equal(controlPipeName(join(HOME, "A"), "someone"), controlPipeName(join(HOME, "a"), "someone"));
  // 不同用户的同一个目录，管道名不一样
  assert.notEqual(controlPipeName(join(HOME, "a"), "alice"), controlPipeName(join(HOME, "a"), "bob"));
});

test("每家模型一把 key，App 和命令行共用一个文件", () => {
  const paths = resolvePaths({}, HOME);
  assert.equal(keyFile(paths, "gemini"), `${UNDER_HOME}\\gemini-key.bin`);
  assert.equal(keyFile(paths, "openai"), `${UNDER_HOME}\\openai-key.bin`);
  // 润色那一跳的厂商也一样，自定义服务一把
  assert.equal(keyFile(paths, "deepseek"), `${UNDER_HOME}\\deepseek-key.bin`);
  assert.equal(keyFile(paths, "custom"), `${UNDER_HOME}\\custom-key.bin`);
  assert.throws(() => keyFile(paths, "../x"), /id/);
});

test("DRAFTLESS_HOME 把整个目录换到别处", () => {
  const paths = resolvePaths({ DRAFTLESS_HOME: "D:\\elsewhere" }, HOME);
  assert.equal(paths.home, "D:\\elsewhere");
  assert.ok(paths.historyDb.startsWith("D:\\elsewhere"));
});

test("DRAFTLESS_HOME 是空字符串时当作没设，不把文件写到当前目录", () => {
  assert.equal(resolvePaths({ DRAFTLESS_HOME: "" }, HOME).home, UNDER_HOME);
});

test("DRAFTLESS_HOME 要是绝对路径：相对路径会随着在哪个目录运行命令而变，找不到同一个后台应用", () => {
  for (const relative of ["data", ".\\data", "..\\data"]) {
    assert.throws(() => resolvePaths({ DRAFTLESS_HOME: relative }, HOME), said(/绝对路径/));
  }
});

test("ensureHome：把目录和 run 建出来（控制通道要用），再来一次不出错", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fs-paths-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = resolvePaths({ DRAFTLESS_HOME: join(dir, "home") });
  ensureHome(paths);
  assert.ok(statSync(paths.home).isDirectory());
  assert.ok(statSync(join(paths.home, "run")).isDirectory());
  ensureHome(paths);
});
