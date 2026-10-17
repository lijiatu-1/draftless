import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { LocalizedError, msg } from "../i18n/index.mjs";

// 原生小帮手（native-win/*.cs：听热键、贴字、听写中截住 esc 和悬浮条上的点击）的可执行文件从哪来。
//
// 这一层的职责：装好的程序里带着编好的，
// 从源码仓库跑的话第一次启动和改过源码之后在本机现编。
// 差别只有一处：Windows 上编译不用另装东西——.NET Framework 4 是系统自带的，csc.exe 路径是固定的。

/** Windows 自带的 .NET Framework 编译器。装在别处的话用 DRAFTLESS_CSC 指过去 */
const DEFAULT_CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";

export function helperPaths(packageDir) {
  const binary = join(packageDir, "build", "draftless-helper.exe");
  return {
    sourceDir: join(packageDir, "native-win"),
    binary,
    /** 可执行文件是从哪份源码编出来的：那几份源码合起来的 SHA-256 */
    stamp: `${binary}.source-sha256`,
  };
}

/** native-win 下的那几个 .cs，按名字排好：编译命令的输出稳定，出了错也好对照 */
export function sourceFiles(sourceDir) {
  return readdirSync(sourceDir)
    .filter((name) => name.endsWith(".cs"))
    .sort()
    .map((name) => join(sourceDir, name));
}

/** 这几份源码合起来的指纹。多一个文件、少一个文件、改一个字符都会变 */
export function fingerprint(files) {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update(readFileSync(file));
  }
  return hash.digest("hex");
}

function readOrNull(file) {
  try {
    return readFileSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 要不要（重新）编译：没有可执行文件，或者它不是从现在这份源码编出来的。
 * 不比修改时间：解包、git 检出都会把时间改成当时，那时源码反而比可执行文件"新"，会白编一次。
 * @param {{ sourceDir: string, binary: string, stamp: string }} paths
 * @param {{ read?: Function, list?: Function }} [tools] 测试时换成假的
 */
export function helperNeedsBuild(paths, { read = readOrNull, list = sourceFiles } = {}) {
  if (read(paths.binary) === null) return true;
  if (read(paths.stamp) === null) return true;
  const files = list(paths.sourceDir);
  if (files.length === 0) return false;
  return read(paths.stamp).toString().trim() !== fingerprint(files);
}

/**
 * 编译小帮手，并记下它是从哪份源码来的。
 * @param {string} packageDir
 * @param {object} [options]
 * @param {(command: string, args: string[]) => void} [options.run] 测试时换成假的
 * @param {string} [options.csc] 编译器路径
 */
export function buildHelper(
  packageDir,
  {
    run = (command, args) => execFileSync(command, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }),
    csc = process.env.DRAFTLESS_CSC || DEFAULT_CSC,
  } = {},
) {
  const paths = helperPaths(packageDir);
  const files = sourceFiles(paths.sourceDir);
  if (files.length === 0) throw new Error(`${paths.sourceDir} 里没有 .cs，编不出小帮手`);
  mkdirSync(dirname(paths.binary), { recursive: true });
  // 先删掉旧的：编不过时不能让上次那一份留着冒充这次的结果
  rmSync(paths.binary, { force: true });
  // UI Automation 的程序集在 WPF 目录里，csc 不会自己去那儿找，必须给全路径。
  // 缺了这几个引用，Context.cs 里读光标前文字的代码编不过（CS0006）
  const wpf = dirname(csc).replace(/\\$/u, "") + "\\WPF";
  const references = ["UIAutomationClient.dll", "UIAutomationTypes.dll", "WindowsBase.dll"].map(
    (name) => `/r:${join(wpf, name)}`,
  );
  run(csc, ["/nologo", "/optimize", "/target:exe", `/out:${paths.binary}`, ...references, ...files]);
  if (!existsSync(paths.binary)) throw new Error(`编译没有报错，但 ${paths.binary} 没生成`);
  writeFileSync(paths.stamp, `${fingerprint(files)}\n`);
}

/**
 * 需要的话编译一次。编译要一两秒，所以动手之前先调 onBuild，让调用方有机会说一声。
 * @returns {boolean} 这次有没有编
 */
export function ensureHelper(packageDir, { onBuild = () => {}, ...options } = {}) {
  const paths = helperPaths(packageDir);
  if (!helperNeedsBuild(paths, options)) return false;
  onBuild();
  try {
    buildHelper(packageDir, options);
  } catch (error) {
    if (error.code === "ENOENT") throw new LocalizedError(msg("cli.daemon.noCompiler"), { cause: error });
    const detail = String(error.stderr ?? "").trim() || error.message;
    throw new LocalizedError(msg("cli.daemon.buildFailed", { detail }), { cause: error });
  }
  return true;
}

/**
 * 小帮手的可执行文件在哪。
 * 装好的程序里是随包带着的那一份；从源码仓库跑的话是 build/ 下现编的那一份。
 * @param {string} packageDir
 */
export function helperBinary(packageDir) {
  return helperPaths(packageDir).binary;
}

/** 日志里用的短路径：家目录换成 ~，日志搬去别的机器看也不至于全是绝对路径 */
export function shortPath(path, home) {
  return home && path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}
