import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ALREADY_RUNNING_EXIT_CODE, NotRunningError, requestControl, TimeoutError } from "../control.mjs";
import { LocalizedError, msg } from "../i18n/index.mjs";
import { rotateIfLarge } from "../log.mjs";
import { ensureHome } from "../storage/paths.mjs";
import { ensureHelper as defaultEnsureHelper, helperBinary } from "./native-helper.mjs";

// 后台应用（src/app，跑在 Electron 里）的起停。它脱离终端运行：关掉终端窗口它还在，
// 要靠控制通道才知道它在不在、状态如何。途中要说的话和出错的原因都是还没定语言的（msg），由命令行按它的语言翻。
//
// 和原版的差别都在和系统打交道上：
// - 看一个进程跑的是什么：那边用 ps，这边用 CIM 的 Win32_Process（PowerShell 拿得到命令行）
// - 结束进程：Windows 没有 SIGTERM/SIGKILL 那两级，先请它自己 quit，不听话就 taskkill /T /F 整个进程树

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 后台应用用哪个 Electron 来跑。
 * 装好的 Draftless 自带一份，这条命令本身就是拿它当 Node 跑起来的，所以正在跑我们的这个可执行文件就是它。
 * 从源码仓库跑（开发时）用的是系统的 Node，这时去依赖里找：electron 这个包导出的就是可执行文件的路径，
 * 没下载过的话它会在这一步自己去下载。
 */
function resolveElectronBinary(packageDir, onProgress) {
  if (process.versions.electron) return process.execPath;
  const require = createRequire(join(packageDir, "package.json"));
  let electronDir;
  try {
    electronDir = dirname(require.resolve("electron/package.json"));
  } catch {
    throw new LocalizedError(msg("cli.daemon.noElectron", { dir: packageDir }));
  }
  if (!existsSync(join(electronDir, "dist"))) onProgress(msg("cli.daemon.downloading"));
  try {
    return require("electron");
  } catch (error) {
    throw new LocalizedError(msg("cli.daemon.downloadFailed", { reason: error.message }), { cause: error });
  }
}

/** 日志的最后几行；还没有日志时是一句话（msg） */
function logTail(file, lines = 8) {
  try {
    return readFileSync(file, "utf8").trimEnd().split(/\r?\n/).slice(-lines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return msg("cli.daemon.emptyLog");
    throw error;
  }
}

/**
 * 这个进程号现在跑的是什么：命令行（含可执行文件全路径）。
 * 查不了、没有这个进程、或者这台机器不让查，都返回 null——宁可让用户自己去看任务管理器，
 * 也不结束一个说不清是谁的进程。
 */
function commandOfProcess(pid) {
  try {
    const script = `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`;
    const said = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return said || null;
  } catch {
    return null;
  }
}

/**
 * 强行结束一个进程，连同它起的子进程（转写进程、小帮手）。
 * Windows 上 process.kill 只能整个结束，没有"先礼后兵"的信号；所以要结束的时候一次到位。
 */
function killTree(pid) {
  try {
    execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch (error) {
    // 进程已经不在时 taskkill 以 128 退出；别的错误照实往上抛
    const said = String(error.stdout ?? error.message);
    if (/not found|没有找到|128/.test(said) || error.status === 128) return;
    throw error;
  }
}

/**
 * 这个进程号现在还在不在。
 * 信号 0 只是问"还在不在"，两种平台上都不真的发信号；结束进程走的是另外那条路（killTree）。
 */
function isAliveProcess(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // 进程在，只是不归我们管
    if (error.code === "EPERM") return true;
    throw error;
  }
}

/** 启动途中在等什么（文案里的名字）。只说用户看得见、需要他动手或等一下的那两种 */
function startingHint(status) {
  // Windows 的麦克风授权是一次系统弹框（有就过、没有说没有），没有 macOS 那个"待定"状态
  if (status.key?.state === "checking") return "cli.daemon.verifying";
  return null;
}

/**
 * @param {object} options
 * @param {ReturnType<import("../storage/paths.mjs").resolvePaths>} options.paths
 * @param {string} options.packageDir 这个包装在哪：Electron 以它为应用目录启动
 * @param {Record<string, string | undefined>} options.env 传给后台应用的环境
 * @param {string} [options.locale] 命令行用的语言。每条命令都带上它，后台按它把要给人看的话翻好再回
 */
export function createDaemon({
  paths,
  packageDir,
  env,
  locale,
  spawn = nodeSpawn,
  resolveElectron = (onProgress) => resolveElectronBinary(packageDir, onProgress),
  ensureHelper = defaultEnsureHelper,
  kill = killTree,
  alive = isAliveProcess,
  commandOf = commandOfProcess,
  pollMs = 150,
  statusTimeoutMs = 5_000,
  connectTimeoutMs = 30_000,
  // 第一次启动要等系统弹麦克风授权框，所以给得宽
  readyTimeoutMs = 90_000,
  quitTimeoutMs = 5_000,
}) {
  const request = (cmd, params, options) =>
    requestControl(paths.controlPipe, cmd, locale ? { ...params, locale } : params, options);

  /**
   * @returns {Promise<object | null>} 没有在运行时是 null
   * @throws {TimeoutError} 在运行，但卡住了不答话
   */
  async function status(params = {}) {
    try {
      return await request("status", params, { timeoutMs: statusTimeoutMs });
    } catch (error) {
      if (error instanceof NotRunningError) return null;
      throw error;
    }
  }

  const isAlive = (pid) => alive(pid);

  /**
   * 等到这个进程真的不在了为止。只看控制通道关没关是不够的：它先关通道、过一会儿才退干净，
   * 这段时间里单实例的锁还占着，紧接着起新的会被挡回来。
   * @returns {Promise<boolean>} 限时内有没有等到
   */
  async function exited(pid, timeoutMs) {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; await sleep(pollMs)) {
      if (!isAlive(pid)) return true;
    }
    return !isAlive(pid);
  }

  /** 后台应用启动时记在数据目录里的进程号。没记、记的不是数字、那个号现在不像是它，都是 null */
  function recordedPid() {
    let text;
    try {
      text = readFileSync(paths.pidFile, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const pid = Number(text.trim());
    if (!Number.isInteger(pid) || pid <= 1) return null;
    // 进程号会被系统分给别的程序，所以还要看它跑的是不是我们：命令启动的是 electron.exe，
    // 装成应用的是 Draftless.exe。只看有没有 "electron" 字样不够，别的应用的辅助进程路径里也有
    return /(electron|draftless)\.exe\b/i.test((commandOf(pid) ?? "").trim()) ? pid : null;
  }

  return {
    status,
    request,

    /**
     * 启动后台应用，等它准备好（key 验证完、麦克风的授权框有了回应）。调用前要确认它没有在运行。
     * @param {{ onProgress: (message: object) => void }} options 途中要让用户知道的事（msg）
     * @returns {Promise<object>} 启动后的状态；等得太久时 starting 仍是 true
     */
    async start({ onProgress }) {
      ensureHelper(packageDir, { onBuild: () => onProgress(msg("cli.daemon.building")) });
      const electron = resolveElectron(onProgress);
      // 小帮手要先编好：主进程启动时就要 spawn 它，编不出来的话热键和贴字都没有
      if (!existsSync(helperBinary(packageDir)) && !process.versions.electron) {
        onProgress(msg("cli.daemon.building"));
      }

      // 日志要写进家目录。先按规矩把它建出来
      ensureHome(paths);
      rotateIfLarge(paths.logFile);
      const logFd = openSync(paths.logFile, "a");
      // 带着 ELECTRON_RUN_AS_NODE 的话 Electron 会把自己当成普通的 Node，窗口和热键都不会有
      const { ELECTRON_RUN_AS_NODE: _dropped, ...childEnv } = env;
      /** 我们启动的那个进程是怎么结束的；还在运行时是 null */
      let ended = null;
      const child = spawn(electron, [packageDir], {
        detached: true,
        // Windows 上不隐藏的话会留一个黑色的控制台窗口在任务栏上
        windowsHide: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...childEnv, DRAFTLESS_CLI: "1" },
      });
      child.on("exit", (code, signal) => {
        ended = { code, reason: signal ? msg("cli.daemon.signal", { signal }) : msg("cli.daemon.exitCode", { code }) };
      });
      child.on("error", (error) => {
        ended = { code: null, reason: String(error.message) };
      });
      child.unref();
      closeSync(logFd);

      // 另一条 draftless 命令抢先启动了一个，我们这个发现后自己退出：不算失败，接着等抢先的那个
      const lostRace = () => ended?.code === ALREADY_RUNNING_EXIT_CODE;
      const failed = () =>
        new LocalizedError(
          msg("cli.daemon.failed", {
            reason: ended && !lostRace() ? ended.reason : msg("cli.daemon.exitedEarly"),
            file: paths.logFile,
            tail: logTail(paths.logFile),
          }),
        );

      let current = null;
      for (const deadline = Date.now() + connectTimeoutMs; current === null; await sleep(pollMs)) {
        current = await status();
        if (current !== null) break;
        if (ended && !lostRace()) throw failed();
        if (Date.now() > deadline) {
          throw new LocalizedError(
            msg("cli.daemon.noAnswer", { seconds: connectTimeoutMs / 1000, file: paths.logFile }),
          );
        }
      }

      const said = new Set();
      for (const deadline = Date.now() + readyTimeoutMs; current.starting && Date.now() < deadline; ) {
        const hint = startingHint(current);
        if (hint && !said.has(hint)) {
          said.add(hint);
          onProgress(msg(hint));
        }
        await sleep(pollMs);
        current = await status();
        if (current === null) throw failed();
      }
      return current;
    },

    /**
     * 停掉后台应用，等它的进程真的不在了才返回。先请它自己退出，不退再结束整个进程树；
     * 它卡住不答话时，照它启动时记下的进程号结束。
     * @returns {Promise<"not-running" | "quit" | "killed">} 本来就没在运行 / 它自己退出了 / 是被结束掉的
     */
    async stop() {
      let pid = null;
      let answering = true;
      try {
        const current = await status();
        if (current === null) return "not-running";
        pid = current.pid;
        await request("quit");
      } catch (error) {
        if (error instanceof TimeoutError) {
          answering = false;
          pid ??= recordedPid();
          if (pid === null) {
            throw new LocalizedError(msg("cli.daemon.stuckNoPid"));
          }
          // 答了"在运行"之后、收到退出命令之前它自己没了，不算错
        } else if (!(error instanceof NotRunningError)) throw error;
      }

      if (answering && (await exited(pid, quitTimeoutMs))) return "quit";
      try {
        kill(pid);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      if (await exited(pid, quitTimeoutMs)) return "killed";
      throw new LocalizedError(msg("cli.daemon.cantStop", { pid }));
    },
  };
}
