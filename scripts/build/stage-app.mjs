import { execFileSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// 在一个临时目录里摆出"装到别人机器上的程序该有的东西"：代码、编好的小帮手、图标、运行时要的依赖。
//
// 这一层的职责，脚本本身换成了 Node 的写法：
// 那边靠 `npm ci --os=darwin --cpu=…` 和 `find -delete`，这两样在 Windows 上要么不适用、要么是另一个
// 同名的程序（Windows 自带的 find.exe 是文本搜索工具，不是找文件的）。这里改用 npm 的 --os/--cpu
// 和 Node 自己的递归删除，行为不依赖系统里装了什么。

/** 打出来的程序要带的目录和文件：代码、编好的小帮手、图标、入口 */
export const APP_ENTRIES = ["src", "build", "assets", "native-win", "main.cjs", "package.json"];

/**
 * 发布包里只带这两种界面语言的语言包。
 * Electron 自带的 locales 有 55 个、48 MB，而这个程序的界面只有英文和简体中文。
 */
export const KEPT_LOCALES = ["en-US.pak", "zh-CN.pak"];

/**
 * 装上了、但程序从来不加载的包，不随程序分发。
 * @audio/decode-webm 声明依赖了另外几种解码器（AAC、AC-3、DTS、E-AC-3、FLAC、MP3、Opus、Vorbis），
 * 其中 AAC、AC-3、DTS 是 GPL，E-AC-3 是 LGPL，和本项目的 MIT 不兼容；而它打包好的代码只用自带的 Opus 解码。
 * codec-parser（LGPL）是拆 Ogg 用的，程序不转 Ogg（见 src/server/audio/transcode.mjs）。
 */
export const UNUSED_PACKAGES = [
  "@audio/decode-aac",
  "@audio/decode-ac3",
  "@audio/decode-dts",
  "@audio/decode-eac3",
  "@audio/decode-flac",
  "@audio/decode-mp3",
  "@audio/decode-opus",
  "@audio/decode-vorbis",
  "codec-parser",
];

const NPM_FLAGS = ["--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"];

export function pruneUnused(stagingDir) {
  for (const name of UNUSED_PACKAGES) rmSync(join(stagingDir, "node_modules", name), { recursive: true, force: true });
}

/**
 * 一个 SPDX 许可证表达式是不是**只能**按 GPL 一类（GPL、LGPL、AGPL）来用。
 *
 * 判定规则就一条：表达式里有任何一段不是 GPL 一类，这个包就没有被 GPL 卡住。
 * - "MIT OR GPL-3.0"：可以选 MIT，不算
 * - "Apache-2.0 AND LGPL-3.0-or-later"：Apache 那段不是 GPL，整体不构成"只能用 GPL 一类"（sharp 的预编译包就是这样）
 * - "GPL-3.0-or-later"、"MIT AND GPL-3.0"：所有段落都是 GPL 一类或跟着 GPL 走，算
 * 这里要拦的是"这个项目不能按 MIT 分发"的情况，宁可漏一个也别把作者自己的 MIT 包拦下来：
 * 真有问题的那几个（AAC、AC-3、DTS 那些解码器）已经在 UNUSED_PACKAGES 里剔掉了。
 */
function copyleftOnly(license) {
  const parts = license.replace(/[()]/g, "").split(/\s+(?:OR|AND)\s+/i);
  return parts.every((part) => /GPL/i.test(part));
}

/** package.json 里的许可证。老写法是一个对象或者一组对象 */
function licenseOf(manifest) {
  const { license, licenses } = manifest;
  if (typeof license === "string") return license;
  if (license?.type) return license.type;
  if (Array.isArray(licenses)) return licenses.map((entry) => entry.type ?? entry).join(" OR ");
  return null;
}

/**
 * 找出 node_modules 里（连嵌套的一起）只能按 GPL 一类许可证用、或者根本没写许可证的包。
 * 机器查得了的就别等人来查：加依赖时不小心带进来的，打包这一步就拦下。
 * @returns {{ name: string, license: string }[]}
 */
export function findCopyleft(nodeModulesDir) {
  const found = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.name.startsWith("@")) {
        visit(path);
        continue;
      }
      const manifestFile = join(path, "package.json");
      if (existsSync(manifestFile)) {
        const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
        const license = licenseOf(manifest);
        if (license === null || copyleftOnly(license))
          found.push({ name: manifest.name, license: license ?? "（没写）" });
      }
      if (existsSync(join(path, "node_modules"))) visit(join(path, "node_modules"));
    }
  };
  visit(nodeModulesDir);
  return found;
}

/**
 * 把"程序该有的东西"摆进一个空目录，并只装运行时依赖。
 * @param {string} packageDir 源码仓库
 * @param {string} stagingDir 摆到哪。要是一个空目录
 * @param {object} [options]
 * @param {"x64" | "arm64"} [options.arch] 给哪种 Windows 用
 * @param {boolean} [options.reuseNodeModules] 不重新装依赖，直接把这台机器上已经装好的 node_modules 拷过去。
 *   网络不通、或者只想在本机打个包自己用时走这条：跳过要从 registry 取东西的那一步
 */
export function stageApp(packageDir, stagingDir, { arch = "x64", reuseNodeModules = false } = {}) {
  for (const entry of APP_ENTRIES) {
    const from = join(packageDir, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(stagingDir, entry), { recursive: true });
  }

  if (reuseNodeModules) {
    // 本机已经装好的那份：省掉 npm install。给别的芯片打包时不能走这条（本机的那几种原生库不通用）
    if (arch !== process.arch) {
      throw new Error(`--reuse-node-modules 只能打本机这一种芯片（本机是 ${process.arch}，要打的是 ${arch}）`);
    }
    cpSync(join(packageDir, "node_modules"), join(stagingDir, "node_modules"), { recursive: true });
  } else {
    // 本地转写的运行库按系统和芯片各有一个带原生库的包（optionalDependencies），npm 默认只装本机这一种。
    // 给另一种芯片打包时要说清装哪种，不然装进去的是本机的、到那台机器上加载不了
    const target = ["--os=win32", `--cpu=${arch}`];
    const npm = (args) =>
      execFileSync("npm", [...args, ...target, ...NPM_FLAGS], {
        cwd: stagingDir,
        stdio: "inherit",
        // Windows 上 npm 是个 .cmd，spawn 时要用 shell 才找得到
        shell: process.platform === "win32",
      });
    npm(["install"]);
  }
  // electron 这个依赖是给从源码仓库跑的人找运行环境用的。装好的程序另有运行环境，不用带它
  const electron = join(stagingDir, "node_modules", "electron");
  if (existsSync(electron)) rmSync(electron, { recursive: true, force: true });
  pruneUnused(stagingDir);
  // 卸掉之后会剩下几个空目录（node_modules/@electron 之类）。Windows 上没有 find 命令可用，用 Node 自己删
  removeEmptyDirectories(join(stagingDir, "node_modules"));
  const copyleft = findCopyleft(join(stagingDir, "node_modules"));
  if (copyleft.length > 0) {
    const listed = copyleft.map(({ name, license }) => `${name}（${license}）`).join("、");
    throw new Error(`程序里有许可证和 MIT 不兼容、或者没写许可证的包，先确认再发：${listed}`);
  }
}

/** 从最里层往外删空目录。@returns {boolean} 这个目录最后是不是空的 */
export function removeEmptyDirectories(dir) {
  if (!existsSync(dir)) return true;
  let empty = true;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      empty = false;
      continue;
    }
    const child = join(dir, entry.name);
    if (removeEmptyDirectories(child)) rmSync(child, { recursive: true, force: true });
    else empty = false;
  }
  return empty;
}
