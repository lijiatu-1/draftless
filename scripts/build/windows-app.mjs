import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packager } from "@electron/packager";
import { ensureHelper, helperBinary } from "../../src/cli/native-helper.mjs";
import { APP_ENTRIES, KEPT_LOCALES, stageApp } from "./stage-app.mjs";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/**
 * 把 Draftless 打成一个 Windows 应用目录（dist/Draftless-win32-x64/Draftless.exe）。
 *
 * 和原版是同一件事：先摆出一个只含运行时依赖的暂存目录，
 * 再交给 @electron/packager 打包。那边还要签名、公证、做 dmg；这边没有那几步（代码签名要证书，
 * 第一版不做），打出来的是一个能直接双击运行、也能连目录一起拷走的文件夹。
 *
 * @param {{ packageDir: string, arch?: "x64" | "arm64", out: string, electronVersion?: string, reuseNodeModules?: boolean }} options
 *   packageDir：仓库根目录；out：打到哪个目录下（里面是 Draftless-win32-<芯片>/）；
 *   reuseNodeModules：不重新装依赖，直接拷本机已经装好的 node_modules（网络不通或只在本机试时用）
 * @returns {Promise<string>} 打包出来的目录
 */
export async function packageWindowsApp({ packageDir, arch = "x64", out, electronVersion, reuseNodeModules = false }) {
  const manifest = readJson(join(packageDir, "package.json"));
  const appName = manifest.productName;

  // 小帮手要先编好：打出来的包里带的是这一份编好的可执行文件
  ensureHelper(packageDir, { onBuild: () => console.log("正在编译原生小帮手…") });
  if (!existsSync(helperBinary(packageDir))) throw new Error("原生小帮手没有编出来");

  // 先在一个临时目录里摆出"应用里该有的东西"，只装运行时依赖，再从那里打包
  const staging = mkdtempSync(join(tmpdir(), "draftless-package-"));
  let bundleDir;
  try {
    stageApp(packageDir, staging, { arch, reuseNodeModules });
    [bundleDir] = await packager({
      dir: staging,
      out,
      overwrite: true,
      name: appName,
      platform: "win32",
      arch,
      electronVersion: electronVersion ?? readJson(join(packageDir, "node_modules/electron/package.json")).version,
      // 不打成 asar：原生小帮手要能直接执行，页面和主进程的路径也和开发时保持一致
      asar: false,
      // 依赖在上面已经只装了运行时的那部分
      prune: false,
      ignore: [/^\/package-lock\.json$/, /^\/native-win$/],
      icon: join(packageDir, "assets", "app.ico"),
      win32metadata: {
        CompanyName: "Draftless",
        FileDescription: "Draftless",
        ProductName: appName,
        InternalName: appName,
        OriginalFilename: `${appName}.exe`,
      },
      // 打出来的目录名带上芯片，两种芯片各自的包不会互相覆盖
      appVersion: manifest.version,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  pruneLocales(bundleDir);
  // 安装脚本放到产物根上（和 Draftless.exe 同级）：发布包解压出来就能直接双击/命令行跑它，
  // 它自己能认出"脚本所在目录就是程序目录"（见 install.ps1 里那段）。
  // 注意不能放在 stageApp 里——staging 的内容会被 packager 塞进 resources/app，位置就不对了。
  const installer = join(packageDir, "scripts", "build", "install.ps1");
  if (existsSync(installer)) cpSync(installer, join(bundleDir, "install.ps1"));
  return bundleDir;
}

/**
 * 只留英文和简体中文的语言包。
 *
 * Electron 带着 55 个语言包（48 MB），而这个程序的界面只有中英两种语言——其余的从来不加载，
 * 白白让发布包变大。发布包要给人用一行命令下载，这个体积值得省。
 * @param {string} bundleDir 打出来的应用目录
 */
export function pruneLocales(bundleDir) {
  const dir = join(bundleDir, "locales");
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    if (KEPT_LOCALES.includes(entry)) continue;
    rmSync(join(dir, entry), { force: true });
  }
}

/** 打出来的目录里，可执行文件叫什么 */
export function executableIn(bundleDir, packageDir = join(import.meta.dirname, "..", "..")) {
  const { productName } = readJson(join(packageDir, "package.json"));
  return join(bundleDir, `${productName}.exe`);
}

export { APP_ENTRIES };
