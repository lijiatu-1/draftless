import { TimeoutError } from "../../control.mjs";
import { LocalizedError, msg } from "../../i18n/index.mjs";
import { noPositionals, parse } from "../common.mjs";
import { isInstalledCopy } from "../updater.mjs";

// draftless update：看下载地址上有没有更新的版本，有就说清楚怎么换。
//
// 和原版不同的是这一版不替人换程序：
// 那边直接再跑一次安装脚本、连 .app 一起换掉；Windows 上换正在运行的 exe 要绕过文件占用和杀毒软件，
// 第一版不碰这条线。命令照样在，行为是"查到就告诉你去哪拿新的"，查不到就说已经是新的。
//
// status 顺带提醒有没有新版本（newerVersion）：一天最多问一次下载地址。

/** 和安装那边的写法一样：v0.6.0、0.6.0-rc.1 */
const VERSION = /^v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)$/;
const STATUS_CHECK_SECONDS = 3;
const UPDATE_CHECK_SECONDS = 20;
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

/**
 * 两个版本号比大小：按数比（0.10.0 比 0.9.0 新）；同一个号的预发版比正式版旧，预发版之间按 rc.9 < rc.10 比。
 * @returns {number} a 新是正数，一样是 0，a 旧是负数
 */
export function compareVersions(a, b) {
  const split = (version) => {
    const [core, ...pre] = version.split("-");
    return { numbers: core.split(".").map(Number), pre: pre.join("-") };
  };
  const left = split(a);
  const right = split(b);
  for (let index = 0; index < 3; index++) {
    const difference = left.numbers[index] - right.numbers[index];
    if (difference !== 0) return difference;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === "") return 1;
  if (right.pre === "") return -1;
  return left.pre.localeCompare(right.pre, "en", { numeric: true });
}

/** 是不是装到家目录里那一份（从源码仓库跑的是 false：那种用 git pull） */
function installedCopy(io) {
  return isInstalledCopy(io.packageDir, io.paths.appDir);
}

/** 下载地址说的最新版本，去掉开头的 v。不像版本号的（比如问到的其实是一个报错的网页）不往下用 */
async function latestVersion(io, timeoutSeconds) {
  const answer = await io.updater.latest(timeoutSeconds);
  const match = VERSION.exec(answer);
  if (!match) throw new LocalizedError(msg("cli.update.badVersion", { value: JSON.stringify(answer) }));
  return match[1];
}

/**
 * 有没有比这一份新的版本（status 用）。一天最多问一次，结果记在家目录里。
 * 问不到就当没有：这只是顺带的提醒，不能让看状态因为没网而报错。
 * 那次没问到也记下来，一天之后再问，免得没网时每看一次状态都等上几秒。
 * @returns {Promise<string | null>} 新版本的版本号，没有是 null
 */
export async function newerVersion(io) {
  if (!installedCopy(io)) return null;
  if (!io.updater.configured) return null;
  let latest;
  const last = io.updater.lastCheck(io.paths.updateCheckFile);
  if (last !== null && io.now() - Date.parse(last.checkedAt) < CHECK_EVERY_MS) {
    latest = last.latest;
  } else {
    try {
      latest = await latestVersion(io, STATUS_CHECK_SECONDS);
    } catch {
      latest = null;
    }
    io.updater.rememberCheck(io.paths.updateCheckFile, latest);
  }
  return latest !== null && compareVersions(latest, io.version) > 0 ? latest : null;
}

/** 现在跑着的是哪一个：后台报的状态，没在跑是 null。卡住不答话时也当不知道 */
async function runningNow(io) {
  try {
    return await io.daemon.status();
  } catch (error) {
    if (error instanceof TimeoutError) return null;
    throw error;
  }
}

export async function update(args, io) {
  noPositionals(parse(args).positionals, "update");
  const { t } = io;
  if (!installedCopy(io)) {
    io.err(t("cli.update.fromSource", { dir: io.packageDir }));
    return 1;
  }
  // 这一版没有配置更新源：明说，别让人以为已经是最新的
  if (!io.updater.configured) {
    io.err(t("cli.update.notConfigured"));
    return 1;
  }
  const latest = await latestVersion(io, UPDATE_CHECK_SECONDS);
  io.updater.rememberCheck(io.paths.updateCheckFile, latest);
  const running = await runningNow(io);
  if (compareVersions(latest, io.version) <= 0) {
    io.out(t("cli.update.upToDate", { version: io.version }));
    return 0;
  }
  io.out(t("cli.update.available", { current: io.version, latest }));
  // 换程序要人自己来：下载新的发布包、解到同一个地方，或者重跑安装脚本。说清楚下一步
  io.out(t("cli.update.howto", { base: io.env.DRAFTLESS_INSTALL_BASE ?? "" }));
  if (running?.packaged) io.out(t("cli.update.quitFirst"));
  return 0;
}
