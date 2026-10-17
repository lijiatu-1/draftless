import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, test } from "node:test";

// 安装脚本（scripts/build/install.ps1）的测试：拿一个假的"打好的程序目录"真的跑一遍 PowerShell 脚本，
// 装进临时家目录。全程不联网、不碰真的 %USERPROFILE%\.draftless、不建快捷方式、不改 PATH。
//
// 和 macOS 版那套的区别：那边测的是 install.sh（预检查、下载、校验、解压、建符号链接、钥匙串），
// 这里换来的是 PowerShell 脚本 —— 它只做"拷贝 + 可选快捷方式 + 可选 PATH"。下载、校验这些在
// fetch-electron.mjs 和发布那一层，不在这条路上。
//
// 每条要真的起一次 PowerShell（每次 0.5–1 秒），所以这一组单独跑（npm run test:install）。

const INSTALLER = resolve(import.meta.dirname, "..", "..", "scripts", "build", "install.ps1");

let root;
/** 假的"打好的程序目录"，当安装源 */
let source;
/** 装到哪 */
let home;

/**
 * 跑安装脚本。输出按系统代码页解（中文 Windows 上是 GBK）。
 *
 * 为什么要专门解：PowerShell 5.1 把输出写进管道时用的是控制台的 OEM 代码页，不是 UTF-8。
 * Node 默认按 UTF-8 读，中文就成了乱码——这不是脚本的问题，是两层之间的编码约定，
 * 所以在这里按它对上，而不是让断言去将就乱码。
 */
const decode = (bytes) => {
  if (bytes == null) return "";
  if (typeof bytes === "string") return bytes;
  try {
    return new TextDecoder("gbk").decode(bytes);
  } catch {
    // 没有 GBK 解码器（精简过的 Node）时退回 UTF-8，中文可能不对，英文部分照样能断
    return bytes.toString("utf8");
  }
};

const pwsh = (args) =>
  execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", INSTALLER, ...args],
    {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

/**
 * 跑安装脚本，把失败时它说的话拿出来。
 * execFileSync 抛出来的 error 上只有 "Command failed: …" 这一句，真正的原因在 stderr 里
 */
const pwshFails = (args) => {
  try {
    pwsh(args);
    return null;
  } catch (error) {
    return `${decode(error.stderr)}${decode(error.stdout)}${error.message}`;
  }
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "fs-install-"));
  source = join(root, "release", "Draftless-win32-x64");
  home = join(root, "home");
  // 摆一个最小的"程序目录"：有 exe，有几个跟它一起的东西
  mkdirSync(join(source, "resources", "app", "build"), { recursive: true });
  mkdirSync(join(source, "locales"), { recursive: true });
  writeFileSync(join(source, "Draftless.exe"), "不是真的 exe，安装脚本只看它在不在");
  writeFileSync(join(source, "resources", "app", "package.json"), "{}\n");
  writeFileSync(join(source, "resources", "app", "build", "draftless-helper.exe"), "小帮手");
  writeFileSync(join(source, "locales", "zh-CN.pak"), "语言包");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("装进 <家>\\app：程序、resources、小帮手都在，并记下装的是什么版本、从哪来", () => {
  pwsh(["-Source", source, "-InstallHome", home, "-NoPath", "-NoShortcut"]);
  const app = join(home, "app");
  assert.ok(existsSync(join(app, "Draftless.exe")));
  assert.ok(existsSync(join(app, "resources", "app", "build", "draftless-helper.exe")));
  assert.ok(existsSync(join(app, "locales", "zh-CN.pak")));
  // 安装脚本要说明白这一份是怎么装上的，排障时用得上
  const stamp = readFileSync(join(app, "installed.txt"), "utf8");
  assert.match(stamp, /installed_at=/);
  assert.match(stamp, /source=/);
});

test("再来一次（升级）：替换掉旧的 app，旧文件不留，数据目录里的东西不碰", () => {
  pwsh(["-Source", source, "-InstallHome", home, "-NoPath", "-NoShortcut"]);
  // 装好之后用户有了设置和历史
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), '{"hotkey":"right_ctrl"}\n');
  // 程序目录里多了个只有旧版才有的文件
  writeFileSync(join(home, "app", "只有旧版有.txt"), "旧东西");
  // 新的一份里换了个文件
  writeFileSync(join(source, "locales", "en-US.pak"), "语言包");

  pwsh(["-Source", source, "-InstallHome", home, "-NoPath", "-NoShortcut"]);
  assert.equal(existsSync(join(home, "app", "只有旧版有.txt")), false);
  assert.ok(existsSync(join(home, "app", "locales", "en-US.pak")));
  // 设置原样
  assert.equal(readFileSync(join(home, "settings.json"), "utf8"), '{"hotkey":"right_ctrl"}\n');
  // 只留一个 app，没有安装过程中转用的半截目录
  assert.deepEqual(
    readdirSync(home)
      .filter((name) => name.startsWith("app"))
      .sort(),
    ["app"],
  );
});

test("源目录里没有 Draftless.exe：报错、不建 app", () => {
  rmSync(join(source, "Draftless.exe"));
  const said = pwshFails(["-Source", source, "-InstallHome", home, "-NoPath", "-NoShortcut"]);
  // 断言的是脚本自己说的那句，不是 execFileSync 的 "Command failed"
  assert.match(said ?? "", /没有 Draftless\.exe/);
  assert.equal(existsSync(join(home, "app")), false);
});

test("源目录根本不存在：报错，并说先跑一次 npm run dist", () => {
  const said = pwshFails(["-Source", join(root, "nowhere"), "-InstallHome", home, "-NoPath", "-NoShortcut"]);
  assert.match(said ?? "", /找不到要装的目录/);
});

test("不给快捷方式、不给 PATH 时，家目录以外什么都不动", () => {
  pwsh(["-Source", source, "-InstallHome", home, "-NoPath", "-NoShortcut"]);
  // 这个家里只有 app（程序）和 bin（命令行的入口）两样
  assert.deepEqual(readdirSync(home).sort(), ["app", "bin"]);
});

test("命令行的入口：一个不带中文的 .cmd，用环境变量把子命令交给 exe", () => {
  pwsh(["-Source", source, "-InstallHome", home, "-NoPath", "-NoShortcut"]);
  const cmd = join(home, "bin", "draftless.cmd");
  assert.ok(existsSync(cmd));
  const bytes = readFileSync(cmd);
  // 注释里不能有中文：.cmd 按控制台的代码页解，非 ASCII 的注释在 cmd 里会被当成命令去执行
  assert.ok(
    bytes.every((byte) => byte < 0x80),
    "draftless.cmd 里出现了非 ASCII 字节",
  );
  const text = bytes.toString("ascii");
  // 子命令靠环境变量告诉 exe：Electron 会把不认识的 --xxx 当自己的开关拒掉
  assert.match(text, /DRAFTLESS_ARGV_MODE=cli/);
  assert.match(text, /Draftless\.exe/);
});
