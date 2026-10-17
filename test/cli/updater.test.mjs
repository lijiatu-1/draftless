import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { compareVersions } from "../../src/cli/commands/update.mjs";
import { createUpdater, installBase, isInstalledCopy, latestFileExists, resolveUrl } from "../../src/cli/updater.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

// 更新这一块在 Windows 版里是"只问版本，不替人换程序"：
// - 下载地址从 DRAFTLESS_INSTALL_BASE 来，没配就明说没有更新源
// - 拿到的是一个 latest.txt，一行一个版本号
// - 版本比较的那套规则和 macOS 版完全一样（0.10.0 > 0.9.0、预发版比正式版旧）
// macOS 版那些"下载安装脚本、换掉 .app"的测试没有对应物，随那条实现一起去掉了。

const zh = createTranslator("zh-CN");

let dir;
let home;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-update-"));
  home = join(dir, "home");
  mkdirSync(home, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 摆一个"下载地址"：目录里放一个 latest.txt */
function release(base, version) {
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "latest.txt"), `${version}\n`);
  return base;
}

test("版本号比大小：按数比，不按字比；同一个号的预发版比正式版旧", () => {
  assert.ok(compareVersions("0.10.0", "0.9.0") > 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  assert.ok(compareVersions("0.6.0", "0.6.0-rc.1") > 0);
  assert.ok(compareVersions("0.6.0-rc.10", "0.6.0-rc.9") > 0);
  assert.equal(compareVersions("0.6.0", "0.6.0"), 0);
  assert.ok(compareVersions("0.5.9", "0.6.0") < 0);
});

test("下载地址：没配时是 null；配了网址或本机目录都认，末尾的斜杠去掉", () => {
  assert.equal(installBase({}), null);
  assert.equal(installBase({ DRAFTLESS_INSTALL_BASE: "  " }), null);
  assert.equal(
    installBase({ DRAFTLESS_INSTALL_BASE: "https://dl.example.com/draftless" }),
    "https://dl.example.com/draftless",
  );
  assert.equal(
    installBase({ DRAFTLESS_INSTALL_BASE: "https://dl.example.com/draftless/" }),
    "https://dl.example.com/draftless",
  );
  // Windows 的盘符路径要去掉末尾的反斜杠，不能当成 relpath
  assert.equal(installBase({ DRAFTLESS_INSTALL_BASE: "D:\\dist\\release\\" }), "D:\\dist\\release");
});

test("拼出来要取的地址：网址原样拼，本机目录转成 file:// 再用 fetch 取", () => {
  assert.equal(
    resolveUrl("https://dl.example.com/draftless", "latest.txt"),
    "https://dl.example.com/draftless/latest.txt",
  );
  assert.equal(resolveUrl("D:\\dist\\release", "latest.txt"), "file:///D:/dist/release/latest.txt");
  // 带空格的目录也拼得出能取的 URL
  assert.equal(resolveUrl("C:\\my build\\release", "latest.txt"), "file:///C:/my%20build/release/latest.txt");
});

test("问最新版本：本机目录当下载地址，读到 latest.txt 里的那一行，开头的 v 去掉", async () => {
  const base = release(join(dir, "release"), "v9.9.9");
  const updater = createUpdater({ env: { DRAFTLESS_INSTALL_BASE: base }, home });
  assert.equal(updater.configured, true);
  assert.equal(await updater.latest(5), "9.9.9");
});

test("没配下载地址时问版本会明说，而不是回一个空的新版本号", async () => {
  const updater = createUpdater({ env: {}, home });
  assert.equal(updater.configured, false);
  await assert.rejects(updater.latest(1), (error) => /没有配置更新源/.test(zh.text(error.problem ?? error.message)));
  assert.match(zh.text((await updater.latest(1).catch((error) => error)).problem), /没有配置更新源/);
});

test("下载地址那儿写的东西不像版本号时拒绝往下用（问到的其实是一个报错网页）", async () => {
  const base = join(dir, "release");
  mkdirSync(base, { recursive: true });
  writeFileSync(join(base, "latest.txt"), "Not Found\n");
  const updater = createUpdater({ env: { DRAFTLESS_INSTALL_BASE: base }, home });
  await assert.rejects(updater.latest(5), (error) => /版本号不对/.test(zh.text(error.problem ?? error.message)));
});

test("下载地址连不上时说清是哪个地址、为什么", async () => {
  const updater = createUpdater({ env: { DRAFTLESS_INSTALL_BASE: join(dir, "nowhere") }, home });
  await assert.rejects(updater.latest(5), (error) => /连不上/.test(zh.text(error.problem ?? error.message)));
});

test("上一次问的结果记在家目录里；status 靠它一天只问一次", () => {
  const updater = createUpdater({ env: {}, home });
  const file = join(home, "run", "update-check.json");
  assert.equal(updater.lastCheck(file), null);
  updater.rememberCheck(file, "1.2.3");
  const record = updater.lastCheck(file);
  assert.equal(record.latest, "1.2.3");
  assert.ok(Number.isFinite(Date.parse(record.checkedAt)));
  // 记坏了当作没问过，不抛错
  writeFileSync(file, "{ 不是 JSON");
  assert.equal(updater.lastCheck(file), null);
});

test("这一版不替人换程序：install 会抛一句人话，而不是假装装好了", async () => {
  const updater = createUpdater({ env: { DRAFTLESS_INSTALL_BASE: release(join(dir, "release"), "1.0.0") }, home });
  await assert.rejects(updater.install("1.0.0"), (error) =>
    /下载发布包|安装脚本/.test(zh.text(error.problem ?? error.message)),
  );
});

test("从哪一份跑的：装到家目录 app 那一层算装好的，源码仓库不算", () => {
  const appDir = join(dir, "app");
  mkdirSync(appDir, { recursive: true });
  assert.equal(isInstalledCopy(appDir, appDir), true);
  assert.equal(isInstalledCopy(join(dir, "repo"), appDir), false);
});

test("latest.txt 在不在：发布包里应该有", () => {
  const base = release(join(dir, "release"), "1.0.0");
  assert.equal(latestFileExists(base), true);
  assert.equal(latestFileExists(join(dir, "nothing")), false);
});
