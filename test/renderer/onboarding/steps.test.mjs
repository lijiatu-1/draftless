import assert from "node:assert/strict";
import { test } from "node:test";
import { canContinue, groupStates, STEPS, startStep } from "../../../src/renderer/onboarding/steps.mjs";

const setup = (key, permissions = {}) => ({
  key: { state: key },
  permissions: { microphone: "granted", listen: true, trusted: true, ...permissions },
});

test("引导的顺序：模型、权限、测麦克风、测快捷键、体验一下、完成", () => {
  assert.deepEqual(STEPS, ["key", "permissions", "microphone", "hotkey", "try", "done"]);
});

test("从哪一步开始：缺 key 从模型开始；key 已经能用就直接到权限", () => {
  assert.equal(startStep(setup("missing")), "key");
  assert.equal(startStep(setup("rejected")), "key");
  assert.equal(startStep(setup("ready", { listen: false })), "permissions");
  // 正在验证的不让人再填一遍
  assert.equal(startStep(setup("checking")), "permissions");
});

test("key 验证通过才能继续；正在验证的也要等", () => {
  assert.equal(canContinue("key", setup("missing")), false);
  assert.equal(canContinue("key", setup("checking")), false);
  assert.equal(canContinue("key", setup("ready")), true);
});

test("权限：麦克风和输入监控给了就能继续，辅助功能可以以后再给", () => {
  assert.equal(canContinue("permissions", setup("ready", { microphone: "not-determined" })), false);
  assert.equal(canContinue("permissions", setup("ready", { listen: false })), false);
  assert.equal(canContinue("permissions", setup("ready", { listen: null })), false);
  assert.equal(canContinue("permissions", setup("ready", { trusted: false })), true);
});

test('测麦克风、测快捷键靠那一步自己的"是的，继续"；体验一下随时可以跳过', () => {
  assert.equal(canContinue("microphone", setup("ready")), false);
  assert.equal(canContinue("hotkey", setup("ready")), false);
  assert.equal(canContinue("try", setup("ready")), true);
  assert.equal(canContinue("done", setup("ready")), false);
});

test("顶上三段的进度：做完的、正在做的、还没到的", () => {
  assert.deepEqual(groupStates("key"), { key: "current", setup: "todo", try: "todo" });
  assert.deepEqual(groupStates("hotkey"), { key: "done", setup: "current", try: "todo" });
  assert.deepEqual(groupStates("done"), { key: "done", setup: "done", try: "current" });
});
