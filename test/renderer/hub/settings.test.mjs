import assert from "node:assert/strict";
import { test } from "node:test";
import { paneFor } from "../../../src/renderer/hub/settings.mjs";

const setup = (key, permissions = {}, helper = "running") => ({
  key: { state: key },
  helper,
  permissions: { microphone: "granted", listen: true, trusted: true, ...permissions },
});

test("还差 key：去模型那一页", () => {
  assert.equal(paneFor(setup("missing")), "model");
  assert.equal(paneFor(setup("rejected", { listen: false })), "model");
  assert.equal(paneFor(setup("unreadable")), "model");
});

test("key 没问题、正在验证时，差的是权限就去权限那一页", () => {
  assert.equal(paneFor(setup("ready", { microphone: "denied" })), "permissions");
  assert.equal(paneFor(setup("checking", { listen: false })), "permissions");
  // 只缺辅助功能也算：能用但打了折扣，补上它的地方也在权限页
  assert.equal(paneFor(setup("ready", { trusted: false })), "permissions");
});

test("什么都不缺、权限还没报上来：去设置的第一页", () => {
  assert.equal(paneFor(setup("ready")), "general");
  assert.equal(paneFor(setup("ready", { listen: null, trusted: null })), "general");
});

test("按键监听的小程序停了：去权限那一页，重新检查在那里", () => {
  assert.equal(paneFor(setup("ready", { listen: null, trusted: null }, "stopped")), "permissions");
});
