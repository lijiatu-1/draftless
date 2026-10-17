import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";

// Draftless 的家：程序、设置、key、历史、录音、模型、日志，全在这一个目录里。
// 装的时候往里放，删的时候删掉它就干净了。命令行和后台应用是两个进程，靠这一份约定找到同一批文件。
//
//   %USERPROFILE%\.draftless\
//     settings.json <厂商>-key.bin data/    你的东西（每家模型一把 key：gemini-key.bin、openai-key.bin）
//     models/                      本地转写用的模型：用到时才下，删了下次用时再下
//     logs/ run/ cache/            运行时产生的，删了会自己再建
//
// 和原版的差别：
// - 家目录用 Windows 的同一个约定（%USERPROFILE% 下点开头的目录），不放进 Roaming/LocalAppData：
//   里面有录音和 key，装在一个能一眼找到、删掉就干净的地方，和原版取舍一致
// - 控制通道不再是 run/control.sock 这个文件，而是命名管道（名字见 controlPipeName）：
//   没有"路径太长"那条限制，也没有权限位可设——管道按同一个用户做访问控制，系统管
// - 2026-10-17 产品从 FastSpeak 改名 Draftless，数据目录跟着从 .fast-speak 改成 .draftless：
//   老目录里有着用户的 key、录音和历史，第一次跑新名字时整体搬过来（见 migrateLegacyHome）

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} userHome 用户的家目录，测试时换掉
 */
export function resolvePaths(env = process.env, userHome = homedir()) {
  // DRAFTLESS_HOME：把整个目录换到别处。测试用它指到临时目录，不碰真实的历史
  const home = env.DRAFTLESS_HOME || migrateLegacyHome(env, userHome);
  // 相对路径会随着"在哪个目录运行命令"而变：换个目录就找不到正在运行的那个，还会再起一个
  if (!isAbsolute(home)) {
    throw new LocalizedError(msg("paths.homeNotAbsolute", { home: JSON.stringify(home) }));
  }
  return {
    home,

    /** 装好的程序自己：安装脚本解压到这里（从源码跑时这个目录不存在）。update 靠它认出"装好的那一份" */
    appDir: join(home, "app"),
    settingsFile: join(home, "settings.json"),
    historyDb: join(home, "data", "history.db"),
    recordingsDir: join(home, "data", "Recordings"),
    /** 本地转写的模型，一个模型一个目录（models/store.mjs） */
    modelsDir: join(home, "models"),

    logFile: join(home, "logs", "main.log"),
    /** 命令行和后台应用之间的控制通道：命名管道的名字，不是文件 */
    controlPipe: controlPipeName(home),
    /** 正在运行的后台应用的进程号。只在它卡住不答话、要强行结束时才用得上 */
    pidFile: join(home, "run", "daemon.pid"),
    /** 上一次问下载地址最新版本的时间和结果。status 靠它一天只问一次 */
    updateCheckFile: join(home, "run", "update-check.json"),
    /** 运行环境（Chromium）自己的缓存和状态，和我们的数据分开放。停掉之后可以随时删 */
    cacheDir: join(home, "cache"),
  };
}

/** 改名前的数据目录名：2026-10-17 之前装的人，东西都在这个目录里 */
const LEGACY_HOME_DIR = ".fast-speak";

/** 改名前的环境变量名：老脚本和快捷方式里可能还设着它，认它当老目录的位置 */
const LEGACY_HOME_ENV = "FASTSPEAK_HOME";

/**
 * 把改名前的数据目录整体搬成新名字。key、录音、历史都在里面，丢了就是丢了，所以是 rename 不是复制。
 * 只在新目录还不存在、老目录在的时候搬；两边都在时不动——新目录可能是用户自己建的，不猜。
 * 显式设了 DRAFTLESS_HOME 的人不走这里：他自己选了位置，老目录留着他自己处理。
 */
function migrateLegacyHome(env, userHome) {
  const next = join(userHome, ".draftless");
  const prev = env[LEGACY_HOME_ENV] || join(userHome, LEGACY_HOME_DIR);
  if (!existsSync(next) && existsSync(prev)) renameSync(prev, next);
  return next;
}

/**
 * 控制通道的管道名。
 *
 * 为什么不用固定的名字：同一台机器上可能同时跑着从源码目录起的和装好的两份（数据目录不同），
 * 名字一样就串到一块去了。把用户名和家目录算进去，一份数据目录对应一个管道，
 * 和原版数据目录里那个 control.sock 一一对应。
 *
 * 为什么带 \\.\pipe\：Windows 的命名管道都在这一个命名空间下。同一个用户建、同一个用户连，
 * 系统按用户名做访问控制，不用自己设权限。
 *
 * @param {string} home 数据目录
 * @param {string} [user] 当前用户名，测试时换掉
 * @returns {string} 可以直接交给 node:net 的 connect / listen
 */
export function controlPipeName(home, user = currentUser()) {
  const digest = createHash("sha256").update(`${user}\0${home.toLowerCase()}`).digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\draftless-${digest}`;
}

/** 当前用户名：管道名里带上它，同一台机器上不同账户的两个数据目录不会撞 */
function currentUser() {
  try {
    const { username } = userInfo();
    return username || "user";
  } catch {
    return "user";
  }
}

/**
 * 某一家模型的 key 加密后存在哪。App 和命令行启动的后台共用这一个文件：
 * 加密用的是当前用户的 DPAPI，同一个用户下两边都解得开对方存的密文。
 * @param {ReturnType<typeof resolvePaths>} paths
 * @param {string} provider 厂商的 id（providers/index.mjs）
 */
export function keyFile(paths, provider) {
  return join(paths.home, `${checkedVendorId(provider)}-key.bin`);
}

/** id 来自我们自己的清单；还是防一手，免得拼出家目录以外的路径 */
function checkedVendorId(provider) {
  if (!/^[a-z0-9]+$/.test(provider)) throw new Error(`厂商的 id 不对：${JSON.stringify(provider)}`);
  return provider;
}

/**
 * 把家目录建出来。里面有录音和 key。
 * Windows 上不设权限位（没有 0o700 这回事）：%USERPROFILE% 下的目录默认只有本人和本机管理员进得去。
 * @param {ReturnType<typeof resolvePaths>} paths
 */
export function ensureHome(paths) {
  mkdirSync(paths.home, { recursive: true });
  mkdirSync(join(paths.home, "run"), { recursive: true });
}
