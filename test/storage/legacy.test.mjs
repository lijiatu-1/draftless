import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { migrateLegacyData } from "../../src/storage/legacy.mjs";
import { resolvePaths } from "../../src/storage/paths.mjs";

// Windows 版是第一个版本，没有别处的旧数据要搬。这个测试守着"那个函数还在、还是什么都不做"：
// 上层的启动流程（src/cli/main.mjs、src/app/main.mjs）会调它，返回空数组就是"没搬任何东西"。

let dir;
let paths;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fs-legacy-"));
  paths = resolvePaths({ DRAFTLESS_HOME: join(dir, "new") });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("没有旧数据可搬：返回空数组，不建目录", async () => {
  const moved = await migrateLegacyData({ paths });
  assert.deepEqual(moved, []);
});

test("就算家目录里已经有东西，也还是什么都不做", async () => {
  const moved = await migrateLegacyData({ paths, legacyDir: join(dir, "old") });
  assert.deepEqual(moved, []);
});
