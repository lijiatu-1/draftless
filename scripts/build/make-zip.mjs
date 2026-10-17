// npm run dist:zip：把打好的程序目录压成一个 zip，给发布用（一行安装就是从它解压）。
//
// 用法：
//   node scripts/build/make-zip.mjs              压 dist/Draftless-win32-x64
//   node scripts/build/make-zip.mjs --arch arm64
//
// 为什么不用系统自带的 Compress-Archive：它压 737 MB 要几分钟，而且对大量小文件的内存占用很凶。
// 这里用 .NET 的 ZipFile，一次流式写完。
//
// 压出来的 zip 里**根目录就是程序目录的内容**（Draftless.exe 在 zip 的最外层），
// 所以解压到一个目录之后，那个目录就是 install.ps1 眼里的"程序目录"。

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const packageDir = resolve(import.meta.dirname, "..", "..");

function archFrom(argv) {
  const at = argv.indexOf("--arch");
  const wanted = at >= 0 ? argv[at + 1] : process.arch;
  if (wanted !== "x64" && wanted !== "arm64") throw new Error(`不认识的芯片：${wanted}（只认 x64 和 arm64）`);
  return wanted;
}

const arch = archFrom(process.argv.slice(2));
const source = join(packageDir, "dist", `Draftless-win32-${arch}`);
const target = join(packageDir, "dist", `Draftless-win32-${arch}.zip`);

if (!existsSync(join(source, "Draftless.exe"))) {
  throw new Error(`找不到打好的程序：${source}\n先跑一次 npm run dist`);
}
const installer = join(source, "install.ps1");
if (!existsSync(installer)) {
  throw new Error(`${source} 里没有 install.ps1——一行安装要靠它，检查一下 npm run dist 有没有正常跑完`);
}
// install.ps1 必须是带 BOM 的 UTF-8：PowerShell 5.1 按 ANSI 读无 BOM 的文件，
// 里面的中文注释会变成乱码，乱码字节还能把引号配对搞坏，脚本跑不起来（踩过，报的是
// "Unexpected token '}'" 这种莫名其妙的错）。这条断言放在这里，编译期就拦住。
{
  const head = readFileSync(installer).subarray(0, 3);
  if (!(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)) {
    throw new Error(
      `${installer} 没有 UTF-8 BOM，PowerShell 5.1 会把中文按 ANSI 读、脚本会坏。先把它存成带 BOM 的 UTF-8`,
    );
  }
}
// 删掉上次的（ZipFile 是"创建"模式，同名文件会报错）
rmSync(target, { force: true });

const startedAt = Date.now();
// 用 PowerShell 里的 .NET：ZipFile::CreateFromDirectory 会流式把整个目录写进一个 zip
execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    [
      "Add-Type -AssemblyName System.IO.Compression.FileSystem",
      `[System.IO.Compression.ZipFile]::CreateFromDirectory('${source}', '${target}', [System.IO.Compression.CompressionLevel]::Optimal, $false)`,
    ].join("; "),
  ],
  { stdio: "inherit", windowsHide: true },
);

if (!existsSync(target)) throw new Error("zip 没生成出来");
const mb = (n) => (n / 1024 / 1024).toFixed(1);
console.log(
  `打好了：${target}（${mb(statSync(target).size)} MB，用了 ${Math.round((Date.now() - startedAt) / 1000)} 秒）`,
);
console.log(`原始目录 ${mb(dirSize(source))} MB → 压缩后 ${mb(statSync(target).size)} MB`);

/** 目录一共多大 */
function dirSize(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(child) : statSync(child).size;
  }
  return total;
}
