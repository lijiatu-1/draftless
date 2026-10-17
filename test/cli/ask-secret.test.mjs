import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { askSecret, Cancelled } from "../../src/cli/ask-secret.mjs";

function fakeTerminal() {
  const input = new PassThrough();
  input.isTTY = true;
  input.rawModes = [];
  input.setRawMode = (on) => input.rawModes.push(on);
  const output = new PassThrough();
  let shown = "";
  output.on("data", (chunk) => {
    shown += chunk;
  });
  return { input, output, shown: () => shown };
}

test("在终端里输入时不回显，回车结束，前后的空白去掉", async () => {
  const { input, output, shown } = fakeTerminal();
  const answer = askSecret("粘贴 key：", { input, output });
  input.write("  AIza-secret_123 ");
  input.write("\r");
  assert.equal(await answer, "AIza-secret_123");
  assert.ok(shown().startsWith("粘贴 key："));
  assert.ok(!shown().includes("secret"));
  // 用完把终端恢复原样
  assert.deepEqual(input.rawModes, [true, false]);
});

test("退格能改，方向键这类按键不会混进去", async () => {
  const { input, output } = fakeTerminal();
  const answer = askSecret("", { input, output });
  input.write("abcX\x7f");
  input.write("\x1b[D\x1b[C");
  input.write("d\n");
  assert.equal(await answer, "abcd");
});

test("按 Ctrl-C 是取消，终端同样恢复原样", async () => {
  const { input, output } = fakeTerminal();
  const answer = askSecret("", { input, output });
  input.write("abc\x03");
  await assert.rejects(answer, Cancelled);
  assert.deepEqual(input.rawModes, [true, false]);
});

test("不是终端时（管道喂进来）读到结束为止", async () => {
  const input = new PassThrough();
  const answer = askSecret("粘贴 key：", { input, output: new PassThrough() });
  input.end("AIza-from-pipe\n");
  assert.equal(await answer, "AIza-from-pipe");
});
