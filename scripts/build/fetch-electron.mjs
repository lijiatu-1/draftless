// Electron 的二进制在这台机器上下不下来（@electron/get 的 fetch 失败，但同样的地址用 PowerShell 能取）。
// 这个脚本用 PowerShell 下载、按 electron 包自带的 checksums.json 核对 SHA-256，再解到 electron 包该在的位置。
//
// 为什么要有这一步：node_modules/electron 只是几十 KB 的壳，二进制在 dist/ 里。npm install 之后那个
// postinstall 走的是 @electron/get，它在有的网络下会报 "fetch failed"；壳在、二进制不在，npm start 就会
// 停在"下载 Electron 运行环境"那一步。这里把那条路补上，并且校验和比对，宁可报错也不留一份坏的下下来。
//
// 用法：
//   node scripts/build/fetch-electron.mjs            已经装好就跳过
//   node scripts/build/fetch-electron.mjs --force    重下

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const packageDir = join(import.meta.dirname, "..", "..");
const electronDir = join(packageDir, "node_modules", "electron");
const force = process.argv.includes("--force");

function alreadyInstalled(manifest) {
  const version = existsSync(join(electronDir, "dist", "version"))
    ? readFileSync(join(electronDir, "dist", "version"), "utf8")
        .trim()
        .replace(/^v/, "")
    : null;
  const path = existsSync(join(electronDir, "path.txt")) ? readFileSync(join(electronDir, "path.txt"), "utf8") : null;
  return (
    version === manifest.version && path === "electron.exe" && existsSync(join(electronDir, "dist", "electron.exe"))
  );
}

if (!existsSync(join(electronDir, "package.json"))) {
  console.error(`没有 node_modules/electron：先在 ${packageDir} 里跑一次 npm install`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(join(electronDir, "package.json"), "utf8"));
if (!force && alreadyInstalled(manifest)) {
  console.log(`Electron ${manifest.version} 已经装好了：${join(electronDir, "dist", "electron.exe")}`);
  process.exit(0);
}

const file = `electron-v${manifest.version}-win32-x64.zip`;
const url = `https://github.com/electron/electron/releases/download/v${manifest.version}/${file}`;
const zip = join(packageDir, "node_modules", ".electron-download", file);
const expected = JSON.parse(readFileSync(join(electronDir, "checksums.json"), "utf8"))[file];
if (!expected) {
  console.error(`electron 的 checksums.json 里没有 ${file}，这个版本可能不支持 Windows x64`);
  process.exit(1);
}
mkdirSync(join(packageDir, "node_modules", ".electron-download"), { recursive: true });

/** 用 PowerShell 下载。绕开 Node 的 fetch：这条路在测过的环境里是通的 */
function download() {
  console.log(`正在下载 ${url}`);
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '${url}' -OutFile '${zip}' -UseBasicParsing -TimeoutSec 1800`,
    ],
    { stdio: "inherit", windowsHide: true },
  );
}

/** 按 electron 自带的 checksums.json 核对，不信任下到的东西 */
function verify() {
  const actual = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", `(Get-FileHash '${zip}' -Algorithm SHA256).Hash.ToLower()`],
    { encoding: "utf8", windowsHide: true },
  )
    .trim()
    .toLowerCase();
  if (actual !== expected) {
    rmSync(zip, { force: true });
    throw new Error(`下载的 ${file} 校验值对不上：\n  实际是 ${actual}\n  应该是 ${expected}`);
  }
  console.log(`校验值对上了：${actual}`);
}

if (!existsSync(zip)) download();
try {
  verify();
} catch (error) {
  // 下载坏了就再下一次，第二次还不对就照实报出去
  console.error(String(error.message ?? error));
  download();
  verify();
}

console.log("正在解压…");
rmSync(join(electronDir, "dist"), { recursive: true, force: true });
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `Expand-Archive -Path '${zip}' -DestinationPath '${join(electronDir, "dist")}' -Force`,
  ],
  { stdio: "inherit", windowsHide: true },
);
// 压缩包里可能带着 electron.d.ts，install.js 会把它挪到包根下
const typeDefs = join(electronDir, "dist", "electron.d.ts");
if (existsSync(typeDefs)) execFileSync("cmd", ["/c", "move", "/y", typeDefs, join(electronDir, "electron.d.ts")]);
// electron 包靠这个文件找可执行文件
writeFileSync(join(electronDir, "path.txt"), "electron.exe");

const installed = execFileSync(join(electronDir, "dist", "electron.exe"), ["--version"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();
console.log(`装好了：${installed}（${join(electronDir, "dist", "electron.exe")}）`);
