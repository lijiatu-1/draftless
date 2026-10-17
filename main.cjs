// Electron 的入口（package.json 的 main 指这里）。
//
// 这个文件是 CommonJS，故意的：Electron 把 `electron` 当作内建模块提供，在 ESM 里
// `import { app, BrowserWindow } from "electron"` 只在"用 app 目录启动"时成立；
// 从打包好的 exe 双击启动时那条路不一定接得上（见 src/app/electron.mjs 的说明）。用 require 在这里
// 拿到那个对象，挂到 globalThis 上给主进程那份 ESM 代码当退路，两边写法都不用跟着变。
//
// 为什么不把 src/app/main.mjs 整个改成 CommonJS：那个文件下面还有一堆 ESM 模块（听写服务、存储、文案），
// 改一个得改一串。入口这一层换个写法是代价最小的。
//
// 这个文件还兼一件事：装好的那份没有单独的 `draftless.cmd` 时要能跑子命令。用 `--cli` 开头调用
// （安装脚本建的那个 .cmd 就是这么调的）就走命令行，不弹窗口。

const { app } = require("electron");

/**
 * 退出。
 * 正常情况下走 Electron 的 app.exit；环境里带着 ELECTRON_RUN_AS_NODE 时（这台机器上就见过）
 * 这个进程其实是普通的 Node，`require("electron")` 拿不到 app，这时退回 process.exit——
 * 否则错误处理那一条自己会再抛一次，把真正的错盖掉。
 */
function quit(code) {
  if (app?.exit) app.exit(code);
  else process.exit(code);
}

/** 启动早期出错时没有终端可看（双击启动的那种），所以除了标准错误，还往数据目录里写一份 */
function recordFailure(error) {
  const text = String(error?.stack ?? error);
  console.error(text);
  try {
    const { appendFileSync, mkdirSync } = require("node:fs");
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    const home = process.env.DRAFTLESS_HOME || join(homedir(), ".draftless");
    mkdirSync(join(home, "logs"), { recursive: true });
    appendFileSync(join(home, "logs", "startup-error.log"), `${new Date().toISOString()} ${text}\n\n`);
  } catch {
    // 连这个都写不下去时只能留在标准错误里
  }
}

// 主进程那边（src/app/electron.mjs）优先要的就是这一份：它带着完整的 API
try {
  globalThis.__draftlessElectron = require("electron");
} catch (error) {
  // 这条失败不致命：主进程会退回静态 import 那条路
  console.error(`入口拿不到 electron（会退回 ESM 导入）：${error.message}`);
}

/**
 * 是不是在跑子命令。
 *
 * 用环境变量而不是命令行开关，因为 Electron 会把不认识的 `--xxx` 当自己的开关直接拒掉
 * （实测 `--cli` 会报 "bad option: --cli"），轮不到这里的代码。安装脚本建的那个 `draftless.cmd`
 * 就是这么调的；`--help`／`--version` 这类也在子命令那一套里，所以同样走这条路。
 */
function isCliInvocation() {
  return process.env.DRAFTLESS_ARGV_MODE === "cli";
}

if (isCliInvocation()) {
  // 走命令行：纯 Node 的活，不用等 Electron 就绪，也不该起窗口。
  //
  // 但不设一下的话 Chromium 会先按应用名在 %APPDATA%\Draftless 下建 GPU 缓存，
  // 跑一条 `draftless status` 就在家目录里留一堆东西。两件事一起做：缓存挪进我们自己的目录，
  // 并且不初始化硬件加速（命令行用不上 GPU）。
  const { join } = require("node:path");
  const { homedir } = require("node:os");
  app.setPath("userData", join(process.env.DRAFTLESS_HOME || join(homedir(), ".draftless"), "cache"));
  app.disableHardwareAcceleration();
  // argv[0] 是可执行文件，从 1 开始就是子命令和它的参数
  import("./src/cli/main.mjs")
    .then(({ main }) => main(process.argv.slice(1)))
    .then((code) => quit(code ?? 0))
    .catch((error) => {
      recordFailure(error);
      quit(1);
    });
} else {
  // Electron 要等主模块加载完才会就绪；这里只负责把主进程那一段接起来
  import("./src/app/main.mjs").catch((error) => {
    // 主进程加载失败时没有窗口可以报错，记下来并以非零码退出，别留一个什么都不干的进程
    recordFailure(error);
    quit(1);
  });
}
