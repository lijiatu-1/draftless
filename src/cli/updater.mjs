import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalizedError, msg } from "../i18n/index.mjs";

// 和下载地址打交道：问最新的是哪个版本，把结果记在家目录里，供 status 提醒和 update 说清楚。
//
// 和原版最大的差别是这一版**只问版本，不自动替换程序**。
// 那边靠在终端里再跑一次 install.sh、或者换掉"应用程序"里的 .app 来升级；Windows 上没有一个同样可靠的
// 等价物（正在运行的 exe 自己替换自己、杀毒软件拦写入、UAC 提权），第一版先把"知道有新版本"做到位，
// 换程序留给用户按提示重跑安装脚本。
//
// 下载地址从哪来：用 DRAFTLESS_INSTALL_BASE 指一个网址前缀或本机目录，那里放一个 latest.txt，
// 一行一个版本号。没配的话 update 会明说"这一版没有配置更新源"，而不是让人以为已经是最新的。

/** 版本号的写法：v0.6.0、0.6.0-rc.1、0.6.0+abc */
const VERSION = /^v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.-]+)?)$/;

/** 下载地址上放版本号的文件名 */
const LATEST_FILE = "latest.txt";

/**
 * 下载地址的前缀。没配时是 null——调用方据此说"这一版没有配置更新源"。
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function installBase(env) {
  const base = (env.DRAFTLESS_INSTALL_BASE ?? "").trim();
  return base === "" ? null : base.replace(/[\\/]+$/, "");
}

/**
 * 一个前缀加上文件名，变成能取的东西。
 * 本机目录（D:\dist\release）转成 file://，网址原样用。这里不靠"开头是不是斜杠"判断：
 * Windows 的盘符、UNC 路径、带空格的目录都长得不一样，交给 URL 得结论更稳。
 * @param {string} base
 * @param {string} file
 */
export function resolveUrl(base, file) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(base)) return `${base}/${file}`;
  // 反斜杠换成正斜杠，盘符后面补一个斜杠：D:\dist\release → file:///D:/dist/release/latest.txt
  const normalized = base.replaceAll("\\", "/").replace(/^\/+/, "");
  return new URL(file, `file:///${normalized}/`).href;
}

/**
 * 取一个地址的内容。
 * - 网址：用 Node 自己的 fetch（终端里设的代理它也认，少一个外部命令）
 * - 本机的目录（file://）：Node 的 fetch 不认 file://，直接读文件
 */
async function fetchText(url, timeoutMs) {
  if (url.startsWith("file://")) {
    try {
      return await readFile(fileURLToPath(url), "utf8");
    } catch (error) {
      throw new LocalizedError(msg("cli.update.unreachable", { url, reason: String(error?.message ?? error) }), {
        cause: error,
      });
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    throw new LocalizedError(msg("cli.update.unreachable", { url, reason: String(error?.message ?? error) }), {
      cause: error,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {object} options
 * @param {Record<string, string | undefined>} options.env
 * @param {string} options.home 数据目录
 */
export function createUpdater({ env, home }) {
  const base = installBase(env);
  return {
    /** 这一版有没有配置更新源 */
    get configured() {
      return base !== null;
    },

    /**
     * 下载地址上标着最新的是哪个版本（去掉开头的 v）。
     * @param {number} [timeoutSeconds]
     * @returns {Promise<string>}
     */
    async latest(timeoutSeconds = 20) {
      if (base === null) throw new LocalizedError(msg("cli.update.notConfigured"));
      const url = resolveUrl(base, LATEST_FILE);
      const said = (await fetchText(url, timeoutSeconds * 1000)).trim().split(/\r?\n/)[0]?.trim() ?? "";
      const match = VERSION.exec(said);
      if (!match) throw new LocalizedError(msg("cli.update.badVersion", { value: JSON.stringify(said) }));
      return match[1];
    },

    /**
     * 上一次问的结果。status 靠它一天只问一次，不让看状态因为没网而变慢。
     * @param {string} file
     * @returns {{ checkedAt: string, latest: string | null } | null}
     */
    lastCheck(file) {
      try {
        const record = JSON.parse(readFileSync(file, "utf8"));
        return Number.isFinite(Date.parse(record?.checkedAt)) ? record : null;
      } catch (error) {
        if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
        throw error;
      }
    },

    /** 把这一次问到的记下来（问不到时 latest 是 null） */
    rememberCheck(file, latest) {
      mkdirSync(join(home, "run"), { recursive: true });
      writeFileSync(file, JSON.stringify({ checkedAt: new Date().toISOString(), latest }));
    },

    /**
     * 按版本号下载对应的安装脚本并跑一遍——这一版还没做。
     * 留着这个位置，是为了让 update 命令说清楚"下一步要人做什么"，不是静默什么都不做。
     */
    async install() {
      throw new LocalizedError(msg("cli.update.manual"));
    },
  };
}

/** 这个目录在不在，是不是"装好了的那一份"（家目录里 app 那层） */
export function isInstalledCopy(packageDir, appDir) {
  try {
    return realpathSync(packageDir) === realpathSync(appDir);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/** 发布包里有没有版本号文件（测试和排查时用） */
export const latestFileExists = (dir) => existsSync(join(dir, LATEST_FILE));
