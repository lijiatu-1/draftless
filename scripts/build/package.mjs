// npm run dist：打一个本机能直接用的应用目录（dist/Draftless-win32-x64/）。
// 和 macOS 版的 scripts/build/package.mjs 是一个角色：那边打 .app，这边打一个装了就能跑的文件夹。
//
// 用法：
//   node scripts/build/package.mjs            打包
//   node scripts/build/package.mjs --arch arm64
// 打完之后可以用 scripts/build/install.ps1 把它装进 %USERPROFILE%\.draftless。

import { join, resolve } from "node:path";
import { packageWindowsApp } from "./windows-app.mjs";

/** `--arch x64|arm64`，不给就是本机这一种 */
function archFrom(argv) {
  const at = argv.indexOf("--arch");
  const wanted = at >= 0 ? argv[at + 1] : process.arch;
  if (wanted !== "x64" && wanted !== "arm64") throw new Error(`不认识的芯片：${wanted}（只认 x64 和 arm64）`);
  return wanted;
}

const packageDir = resolve(import.meta.dirname, "..", "..");
const arch = archFrom(process.argv.slice(2));
const out = join(packageDir, "dist");

const bundleDir = await packageWindowsApp({
  packageDir,
  arch,
  out,
  // 只在本机打包时跳过 npm install（这台机器上有些地址的证书校验过不去）；
  // 发版或给别的机器打的时候不要开这个开关
  reuseNodeModules: process.argv.includes("--reuse-node-modules"),
});
console.log(`打好了：${bundleDir}`);
console.log(`可以这样直接跑：${join(bundleDir, "Draftless.exe")}`);
