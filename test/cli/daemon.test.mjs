import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDaemon } from "../../src/cli/daemon.mjs";
import { ALREADY_RUNNING_EXIT_CODE, startControlServer, TimeoutError } from "../../src/control.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";
import { ensureHome, resolvePaths } from "../../src/storage/paths.mjs";

// 后台应用的起停。和 macOS 版的测试守的是同一批行为：什么时候算启动好、等太久怎么报、
// 停的时候先礼后兵。换掉的只有和系统打交道的部分：
// - 控制通道是命名管道，不是套接字文件
// - 结束进程是一次 taskkill（Windows 没有 SIGTERM/SIGKILL 两级），所以只断言"结束了一次"
// - 看一个进程跑的是什么走 CIM，认的是 electron.exe / Draftless.exe 这样的路径

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

const quietLog = { info() {}, warn() {}, error() {} };
const PID = process.pid;
const RUNNING = { pid: PID, starting: false, permissions: { microphone: "granted" }, key: { state: "ready" } };
/** 命令启动的那一份和装成应用的那一份，各自的命令行长什么样 */
const ELECTRON_COMMAND = '"C:\\pkg\\node_modules\\electron\\dist\\electron.exe" "C:\\pkg"';
const APP_COMMAND = '"C:\\Users\\someone\\.draftless\\app\\Draftless.exe"';

let dir;
let paths;
let app;
let spawned;
let progress;
let processes;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-daemon-"));
  paths = resolvePaths({ DRAFTLESS_HOME: dir });
  // 后台应用启动时自己会建；这里的假应用没有这一步
  ensureHome(paths);
  app = null;
  spawned = [];
  progress = [];
  processes = fakeProcesses();
});
afterEach(async () => {
  await app?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** 假的后台应用：一个真的控制通道，状态由测试给 */
async function startFakeApp(statusOf, extraHandlers = {}) {
  app = await startControlServer({
    pipeName: paths.controlPipe,
    log: quietLog,
    handlers: { status: () => statusOf(), ...extraHandlers },
  });
}

/** 假的"启动一个进程"：记下怎么启动的，再按测试的安排让应用出现或者退出 */
function fakeSpawn(behave) {
  return (command, args, options) => {
    const child = Object.assign(new EventEmitter(), { pid: PID, unref() {} });
    spawned.push({ command, args, options });
    behave(child, options);
    return child;
  };
}

/**
 * 假的进程表：alive 里有的进程号算活着；结束过的记在 killed 里，onKill 决定进程怎么反应。
 * 查"还在不在"用真的 process.kill(pid, 0) 那一条路，这里只接管结束。
 */
function fakeProcesses() {
  const table = {
    alive: new Set(),
    killed: [],
    onKill: () => {},
    isAlive(pid) {
      return table.alive.has(pid);
    },
    kill(pid) {
      table.killed.push(pid);
      table.onKill(pid);
    },
  };
  return table;
}

function daemonWith(overrides = {}) {
  return createDaemon({
    paths,
    packageDir: "C:\\pkg",
    env: { PATH: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1" },
    resolveElectron: () => "C:\\pkg\\node_modules\\electron\\dist\\electron.exe",
    ensureHelper: () => false,
    kill: processes.kill,
    alive: (pid) => processes.isAlive(pid),
    commandOf: () => ELECTRON_COMMAND,
    pollMs: 10,
    ...overrides,
  });
}

test("没有在运行时状态是 null", async () => {
  assert.equal(await daemonWith().status(), null);
});

test("每条命令都带上命令行用的语言：后台按它把话翻好回来", async () => {
  const seen = [];
  await startFakeApp(() => RUNNING, {
    status: (params) => {
      seen.push(["status", params]);
      return RUNNING;
    },
    "set-key": (params) => {
      seen.push(["set-key", params]);
      return { ok: true };
    },
  });
  const daemon = daemonWith({ locale: "zh-CN" });
  await daemon.status({ recheck: true });
  await daemon.request("set-key", { key: "k", provider: "gemini" });
  assert.deepEqual(seen, [
    ["status", { recheck: true, locale: "zh-CN" }],
    ["set-key", { key: "k", provider: "gemini", locale: "zh-CN" }],
  ]);
});

test("启动：用 Electron 跑这个包，脱离终端、不弹控制台窗口，输出接到日志文件，等它答话了才算启动好", async () => {
  const spawn = fakeSpawn((_child, options) => {
    // 应用自己的输出应当落进日志文件
    writeFileSync(options.stdio[1], '{"event":"started"}\n');
    setTimeout(() => startFakeApp(() => RUNNING), 30);
  });
  const status = await daemonWith({ spawn }).start({ onProgress: (message) => progress.push(zh.text(message)) });

  assert.equal(status.pid, PID);
  assert.equal(spawned.length, 1);
  const [{ command, args, options }] = spawned;
  assert.equal(command, "C:\\pkg\\node_modules\\electron\\dist\\electron.exe");
  assert.deepEqual(args, ["C:\\pkg"]);
  assert.equal(options.detached, true);
  // 不加这一条，Windows 上每启动一次后台就闪一个黑色的控制台窗口
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio[0], "ignore");
  assert.equal(options.env.DRAFTLESS_CLI, "1");
  assert.equal(options.env.PATH, "C:\\Windows");
  // 带着这个变量 Electron 会把自己当成普通的 Node，窗口和热键都不会有
  assert.equal("ELECTRON_RUN_AS_NODE" in options.env, false);
  assert.match(readFileSync(paths.logFile, "utf8"), /"started"/);
});

test("启动时把家目录和 run 建出来（控制通道要用）", async () => {
  rmSync(dir, { recursive: true });
  const spawn = fakeSpawn(() => startFakeApp(() => RUNNING));
  await daemonWith({ spawn }).start({ onProgress() {} });
  assert.ok(existsSync(paths.home));
  assert.ok(existsSync(join(paths.home, "run")));
});

test("启动前先确保小帮手编好了；编了的话说一声", async () => {
  const order = [];
  const spawn = fakeSpawn(() => {
    order.push("spawn");
    startFakeApp(() => RUNNING);
  });
  const ensureHelper = (packageDir, { onBuild }) => {
    order.push(`helper:${packageDir}`);
    onBuild();
    return true;
  };
  await daemonWith({ spawn, ensureHelper }).start({ onProgress: (message) => progress.push(zh.text(message)) });
  assert.deepEqual(order, ["helper:C:\\pkg", "spawn"]);
  assert.ok(progress.some((text) => /键盘钩子的小程序/.test(text)));
});

test("应用还在验证 key 时说明在等什么，等它准备好再返回", async () => {
  let status = { ...RUNNING, starting: true, key: { state: "checking" } };
  const spawn = fakeSpawn(() => {
    startFakeApp(() => status);
    setTimeout(() => {
      status = RUNNING;
    }, 60);
  });
  const result = await daemonWith({ spawn }).start({ onProgress: (message) => progress.push(zh.text(message)) });
  assert.equal(result.starting, false);
  assert.equal(progress.filter((text) => /验证/.test(text)).length, 1);
});

test("应用一直没准备好时不无限等，把当时的状态交回去", async () => {
  const spawn = fakeSpawn(() => startFakeApp(() => ({ ...RUNNING, starting: true })));
  const result = await daemonWith({ spawn, readyTimeoutMs: 80 }).start({ onProgress() {} });
  assert.equal(result.starting, true);
});

test("应用刚启动就退出时报错，并带上日志最后几行", async () => {
  const spawn = fakeSpawn((child, options) => {
    writeFileSync(options.stdio[1], "第一行\n设置文件写错了：hotkey\n");
    setTimeout(() => child.emit("exit", 2, null), 20);
  });
  await assert.rejects(
    daemonWith({ spawn }).start({ onProgress() {} }),
    (error) => /没能启动/.test(zh.text(error.problem)) && /设置文件写错了：hotkey/.test(zh.text(error.problem)),
  );
});

test("应用一直不答话时按时放弃，并说去哪看日志", async () => {
  const spawn = fakeSpawn(() => {});
  await assert.rejects(daemonWith({ spawn, connectTimeoutMs: 60 }).start({ onProgress() {} }), said(/main\.log/));
});

test("同时启动了两个：后到的发现已经有一个就退出，这不算失败，接着等先到的那个答话", async () => {
  const spawn = fakeSpawn((child) => {
    setTimeout(() => child.emit("exit", ALREADY_RUNNING_EXIT_CODE, null), 10);
    setTimeout(() => startFakeApp(() => RUNNING), 50);
  });
  const status = await daemonWith({ spawn }).start({ onProgress() {} });
  assert.equal(status.pid, PID);
});

test("停止：让它自己退出，等到进程真的不在了才算停掉，中途不结束它", async () => {
  processes.alive.add(PID);
  await startFakeApp(() => RUNNING, {
    quit: () => {
      // 控制通道先关，进程晚一些才退干净：这段时间里新的还起不来
      setTimeout(() => app.close(), 20);
      setTimeout(() => processes.alive.delete(PID), 90);
    },
  });
  assert.equal(await daemonWith().stop(), "quit");
  assert.equal(processes.alive.has(PID), false);
  assert.deepEqual(processes.killed, []);
});

test("本来就没有在运行时，停止什么都不做", async () => {
  assert.equal(await daemonWith().stop(), "not-running");
});

test("说了退出却一直不退：结束它（Windows 上没有先礼后兵的两级，一次 taskkill）", async () => {
  processes.alive.add(PID);
  await startFakeApp(() => RUNNING, { quit: () => {} });
  processes.onKill = (pid) => processes.alive.delete(pid);
  assert.equal(await daemonWith({ quitTimeoutMs: 40 }).stop(), "killed");
  assert.deepEqual(processes.killed, [PID]);
});

/** 一个卡住的后台应用：连得上，但问什么都不答 */
const startHungApp = () => startFakeApp(() => new Promise(() => {}));

test("卡住不答话时也停得掉：照它启动时记下的进程号结束它；命令启动的和装成应用的都认", async () => {
  for (const command of [ELECTRON_COMMAND, APP_COMMAND]) {
    processes = fakeProcesses();
    processes.alive.add(PID);
    processes.onKill = (pid) => processes.alive.delete(pid);
    writeFileSync(paths.pidFile, `${PID}\n`);
    await startHungApp();
    assert.equal(await daemonWith({ statusTimeoutMs: 60, commandOf: () => command }).stop(), "killed");
    assert.deepEqual(processes.killed, [PID]);
    await app.close();
  }
});

test("卡住不答话，进程号又对不上（没记下来，或者那个号现在是别的程序）：不乱结束别人的进程，说清楚怎么办", async () => {
  processes.alive.add(PID);
  await startHungApp();
  const stuck = (overrides) => daemonWith({ statusTimeoutMs: 60, ...overrides }).stop();

  await assert.rejects(stuck(), said(/任务管理器/));
  writeFileSync(paths.pidFile, `${PID}\n`);
  await assert.rejects(stuck({ commandOf: () => "C:\\Windows\\notepad.exe" }), said(/任务管理器/));
  // 别的 Electron 应用的辅助进程，路径里也带着 electron 字样，但不是主进程
  const otherApp = "C:\\Program Files\\Other\\resources\\electron_crashpad_handler.exe";
  await assert.rejects(stuck({ commandOf: () => otherApp }), said(/任务管理器/));
  await assert.rejects(stuck({ commandOf: () => null }), said(/任务管理器/));
  writeFileSync(paths.pidFile, "不是数字");
  await assert.rejects(stuck(), said(/任务管理器/));
  assert.deepEqual(processes.killed, []);
});

test("卡住不答话时查状态：报的是“不答话”，不当成没在运行", async () => {
  await startHungApp();
  await assert.rejects(daemonWith({ statusTimeoutMs: 60 }).status(), TimeoutError);
});
