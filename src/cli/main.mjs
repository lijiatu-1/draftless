import { createReadStream, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ControlError, TimeoutError } from "../control.mjs";
import {
  createTranslator,
  LocalizedError,
  localesFromEnv,
  msg,
  problemOf,
  resolveLocale,
  SYSTEM_LOCALE,
} from "../i18n/index.mjs";
import { log } from "../log.mjs";
import { createLocalModels } from "../models/library.mjs";
import { CHAT_VENDORS } from "../server/chat/vendors.mjs";
import { PROVIDERS } from "../server/providers/index.mjs";
import { adoptAppKeys } from "../storage/app-keys.mjs";
import { openHistory } from "../storage/history.mjs";
import { migrateLegacyData } from "../storage/legacy.mjs";
import { resolvePaths } from "../storage/paths.mjs";
import { migrateSettings, resolveSettings } from "../storage/settings.mjs";
import { THEMES } from "../themes/index.mjs";
import { askSecret, Cancelled } from "./ask-secret.mjs";
import { config, settings, theme } from "./commands/config.mjs";
import { DEFAULT_HISTORY_LIMIT, history } from "./commands/history.mjs";
import { key } from "./commands/key.mjs";
import { restart, start, status, stop } from "./commands/lifecycle.mjs";
import { polish, transcriber } from "./commands/local.mjs";
import { logs } from "./commands/logs.mjs";
import { mode } from "./commands/mode.mjs";
import { model } from "./commands/model.mjs";
import { uninstall } from "./commands/uninstall.mjs";
import { update } from "./commands/update.mjs";
import { usage } from "./commands/usage.mjs";
import { ConfigError, UsageError } from "./common.mjs";
import { createDaemon } from "./daemon.mjs";
import { createUpdater } from "./updater.mjs";

// draftless 命令：把"装好依赖、编小帮手、起后台应用、填 key、看历史、改设置"收成几个子命令。
// 真正干活的是后台应用（src/app），这里通过控制通道指挥它；历史和设置文件则直接读写。
// 每个子命令在 commands/ 里一个文件，这里只管分发、收拾错误，以及真实运行时的 io。
// 说什么语言：设置里的 language，跟随系统时照命令行的惯例看 LC_ALL、LC_MESSAGES、LANG（src/i18n）。

/** draftless help 的那段说明，按这一次的语言写 */
const help = (t) =>
  t("cli.help", {
    limit: DEFAULT_HISTORY_LIMIT,
    providers: PROVIDERS.map(({ id }) => id).join(" / "),
    polishers: CHAT_VENDORS.map(({ id }) => id).join(" / "),
    themes: THEMES.map(({ id }) => `${id} ${t(`themes.${id}.name`)}`).join(" / "),
  });

const COMMANDS = {
  start,
  stop,
  restart,
  status,
  update,
  key,
  mode,
  model,
  transcriber,
  polish,
  config,
  theme,
  history,
  usage,
  logs,
  settings,
  uninstall,
};

/**
 * 执行一条命令。
 * @param {string[]} argv 命令名和它的参数（不含 node 和脚本路径）
 * @param {object} io 和外界打交道的全部途径，测试时整个换掉。真实的见 createIo
 * @returns {Promise<number>} 退出码：0 成功，1 没成，2 命令或设置写错了
 */
export async function run(argv, io) {
  try {
    if (argv.some((arg) => arg === "--help" || arg === "-h") || argv[0] === "help") {
      io.out(help(io.t));
      return 0;
    }
    if (argv[0] === "--version" || argv[0] === "-v") {
      io.out(io.version);
      return 0;
    }
    const [name = "start", ...rest] = argv;
    if (!Object.hasOwn(COMMANDS, name)) throw new UsageError(msg("cli.unknownCommand", { name }));
    return await COMMANDS[name](rest, io);
  } catch (error) {
    const said = () => io.err(io.t.text(problemOf(error)));
    if (error instanceof UsageError) {
      said();
      io.err(io.t("cli.seeHelp"));
      return 2;
    }
    if (error instanceof ConfigError) {
      said();
      return 2;
    }
    if (error instanceof ControlError) {
      said();
      if (error instanceof TimeoutError) io.err(io.t("cli.stuck"));
      return 1;
    }
    // 自己抛出来的、带着一句人话的错误照直说；其余的是程序本身的毛病，连调用栈一起留给排查的人
    if (!(error instanceof LocalizedError) && error?.constructor !== Error) throw error;
    said();
    return 1;
  }
}

/** 删掉加密 key 用的那一份。Windows 上没有钥匙串里的一条可删（密文由 DPAPI 按用户加密），照实说没有 */
function removeKeychainKey() {
  return false;
}

/** 问一句普通的话（会回显，比如选用哪一家）。按 Ctrl-C 和问 key 时一样抛 Cancelled */
async function ask(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise((resolve, reject) => {
      // ^C 之后光标还停在提问那一行，换个行，后面的话不接在它后面
      prompt.once("SIGINT", () => {
        process.stderr.write("\n");
        reject(new Cancelled());
      });
      prompt.question(question).then(resolve, reject);
    });
  } finally {
    prompt.close();
  }
}

async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim());
  } finally {
    prompt.close();
  }
}

/**
 * 这一次命令行说什么语言：设置里写了就用它，跟随系统时看终端的语言。
 * 设置文件坏了的话先按终端的语言说：要读设置的命令接着会把坏在哪照实报出来
 */
function cliLocale(paths, env) {
  let setting = SYSTEM_LOCALE;
  try {
    setting = resolveSettings({ file: paths.settingsFile, env }).language.value;
  } catch {
    setting = SYSTEM_LOCALE;
  }
  return resolveLocale(setting, localesFromEnv(env));
}

/** 真实运行时的 io：标准输入输出、真的后台应用、真的历史库 */
export function createIo({ packageDir, env = process.env }) {
  const paths = resolvePaths(env);
  const t = createTranslator(cliLocale(paths, env));
  const write = (stream) => (text) => stream.write(text.endsWith("\n") ? text : `${text}\n`);
  const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  return {
    out: write(process.stdout),
    err: write(process.stderr),
    env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    // NO_COLOR 是通行的约定：设了就不上色
    color: Boolean(process.stdout.isTTY) && !env.NO_COLOR,
    // 终端说自己支持 24 位色时，才画得出主题本来的颜色
    truecolor: Boolean(process.stdout.isTTY) && !env.NO_COLOR && /^(truecolor|24bit)$/.test(env.COLORTERM ?? ""),
    version: manifest.version,
    t,
    packageDir,
    paths,
    daemon: createDaemon({ paths, packageDir, env, locale: t.locale }),
    updater: createUpdater({ env, home: paths.home, progress: Boolean(process.stderr.isTTY) }),
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    // 后台没在运行时在这个进程里下载、删除本机模型
    localModels: ({ source, onChange }) =>
      createLocalModels({
        dir: paths.modelsDir,
        source,
        log: { info() {}, warn: log.warn, error: log.error },
        onChange,
      }),
    timeZone: undefined,
    openHistory,
    askSecret,
    ask,
    confirm,
    // Windows 上密文由 DPAPI 按用户加密，没有一条单独的"钥匙串记录"要删
    removeKeychainKey,
    // 装好的程序自己的偏好记在这里（Electron 的应用名）。卸载时只提一句，不删：别的程序也在用
    sharedPreferencesFile: join(homedir(), "AppData", "Roaming", manifest.name ?? "fast-speak"),
    tail: (args) => tailLog(paths.logFile, args),
  };
}

/**
 * `draftless logs` 的那一步：把日志的最后几行打出来，`-f` 时一直跟着新的走。
 * 原版直接 spawn 系统的 tail；Windows 上没有 tail，
 * 这里用 Node 自己读 + 看着文件变长，参数的含义（-n 行数、-f 跟着）保持不变。
 */
function tailLog(file, args) {
  const follow = args.includes("-f");
  const at = args.indexOf("-n");
  const wanted = at >= 0 ? Number(args[at + 1]) : 40;
  const lines = Number.isFinite(wanted) && wanted > 0 ? wanted : 40;
  return new Promise((resolveExit) => {
    const show = () => {
      let text = "";
      try {
        text = readFileSync(file, "utf8");
      } catch {
        return 0;
      }
      const tail = text.trimEnd().split(/\r?\n/).slice(-lines);
      process.stdout.write(`${tail.join("\n")}\n`);
      return text.length;
    };
    let offset = show();
    if (!follow) {
      resolveExit(0);
      return;
    }
    // 跟着走：文件变大就读新增的那一段。日志按大小轮转过的话长度会变小，那就整篇重读
    const timer = setInterval(() => {
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        return;
      }
      if (size === offset) return;
      if (size < offset) {
        offset = show();
        return;
      }
      const stream = createReadStream(file, { start: offset, encoding: "utf8" });
      stream.on("data", (chunk) => process.stdout.write(chunk));
      stream.on("end", () => {
        offset = size;
      });
    }, 500);
    // Ctrl-C 时安静地结束，不留一个还在转的定时器
    process.once("SIGINT", () => {
      clearInterval(timer);
      resolveExit(0);
    });
  });
}

/** bin/draftless.mjs 调的入口 */
export async function main(argv) {
  let io;
  try {
    io = createIo({ packageDir: resolve(import.meta.dirname, "../..") });
  } catch (error) {
    // 数据目录的路径不合用：还没有 io 可用，按终端的语言直接说
    const t = createTranslator(resolveLocale(SYSTEM_LOCALE, localesFromEnv(process.env)));
    console.error(t.text(problemOf(error)));
    return 2;
  }
  // 0.1 版的数据在别处，有的话先搬过来。只是问版本和帮助时不动
  if (!argv.some((arg) => ["--help", "-h", "help", "--version", "-v"].includes(arg))) {
    try {
      const moved = await migrateLegacyData({ paths: io.paths, log: { info() {}, warn: log.warn } });
      // 0.7.0 及以前 App 另存的那份 key 搬进共用的文件：没启动后台时命令行也看得到
      adoptAppKeys({ paths: io.paths, log: { info() {}, warn: log.warn } });
      if (moved.length > 0) io.out(io.t("cli.migrated", { home: io.paths.home, items: moved.join(", ") }));
    } catch (error) {
      io.err(io.t.text(problemOf(error)));
      return 1;
    }
    // 厂商换过默认模型的话，把设置文件里那个旧名字直接改掉。和 app 启动时那一处是同一件事：
    // 谁先跑谁改，改完文件里就是对的，读设置的路径上不用留兼容判断。
    // 放进这个 if 里是有意的：只是问帮助或版本时不该去碰设置文件（那儿的坏文件也不该挡住 --help）
    migrateSettings(io.paths.settingsFile);
  }
  return run(argv, io);
}
