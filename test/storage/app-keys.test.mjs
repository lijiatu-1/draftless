import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { adoptAppKeys } from "../../src/storage/app-keys.mjs";
import { keyFile, resolvePaths } from "../../src/storage/paths.mjs";

// Windows 上 App 和命令行共用同一份 key：密文由当前用户的 DPAPI 加密，同一个用户下两边都解得开。
// 所以 macOS 版那个"把 App 另存的一份并进共用文件"在这里没有对应的事要做。
// 这个测试守着"它还是什么都不做、不删也不改任何文件"——两个启动入口都会调它。

let dir;
let paths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-appkeys-"));
  paths = resolvePaths({ DRAFTLESS_HOME: join(dir, "home") });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("家目录还不存在时什么也不做，也不把目录建出来", () => {
  adoptAppKeys({ paths, log: { info() {} } });
  assert.equal(existsSync(paths.home), false);
});

test("家目录里就算有旧名字的文件，也不动它、不另抄一份", () => {
  mkdirSync(paths.home, { recursive: true });
  const old = join(paths.home, "gemini-key.app.bin");
  writeFileSync(old, "旧密文");
  adoptAppKeys({ paths, log: { info() {} } });
  // 旧文件原样在（那是用户自己的东西，删不删由 uninstall 决定）
  assert.equal(existsSync(old), true);
  // 也不会因此多出一份共用的
  assert.equal(existsSync(keyFile(paths, "gemini")), false);
});
