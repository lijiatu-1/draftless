import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { startHelper } from "../../src/app/helper.mjs";

// 用一小段 Node 脚本冒充原生小帮手：启动时报 ready 和一次热键按下，收到 paste 就按文字内容决定怎么回；
// 收到 capture 就当作用户点了划出来的第一块，收到 release 就把收到的命令原样报回来
const FAKE_HELPER = `
const emit = (o) => console.log(JSON.stringify(o));
emit({ event: "ready", listen: true, trusted: true });
emit({ event: "hotkey", down: true });
console.log("这一行不是 JSON");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const command = JSON.parse(line);
  if (command.cmd === "capture") return emit({ event: "click", id: command.regions[0]?.id ?? null, regions: command.regions });
  if (command.cmd === "release") return emit({ event: "escape", got: command });
  const { id, text } = command;
  if (text === "不回") return;
  if (text === "退出") process.exit(3);
  emit({ event: "pasted", id, ok: text !== "没权限", ...(text === "没权限" ? { reason: "not_trusted" } : {}) });
}).on("close", () => process.exit(0));
`;

function start() {
  const events = new EventEmitter();
  const seen = [];
  const warnings = [];
  const helper = startHelper(process.execPath, {
    args: ["-e", FAKE_HELPER],
    onEvent: (event) => {
      seen.push(event);
      events.emit(event.event, event);
    },
    log: { warn: (name) => warnings.push(name), error: (name) => warnings.push(name) },
  });
  return { helper, events, seen, warnings };
}

test("转发按键事件；不是 JSON 的行记一条警告，不影响后面", async () => {
  const { helper, events, seen, warnings } = start();
  await once(events, "hotkey");
  assert.deepEqual(seen, [
    { event: "ready", listen: true, trusted: true },
    { event: "hotkey", down: true },
  ]);
  assert.deepEqual(await helper.paste("你好"), { ok: true, reason: null });
  assert.deepEqual(warnings, ["helper_bad_line"]);
  helper.stop();
  const [exit] = await once(events, "exit");
  assert.equal(exit.code, 0);
});

test("没有辅助功能权限时，paste 返回 ok 为 false 和原因", async () => {
  const { helper } = start();
  assert.deepEqual(await helper.paste("没权限"), { ok: false, reason: "not_trusted" });
  helper.stop();
});

test("两次粘贴各回各的", async () => {
  const { helper } = start();
  const results = await Promise.all([helper.paste("甲"), helper.paste("没权限")]);
  assert.deepEqual(
    results.map((result) => result.ok),
    [true, false],
  );
  helper.stop();
});

test("开始截和不截了：命令原样送到，截到的点击和 esc 往上转", async () => {
  const { helper, events } = start();
  const regions = [
    { id: "cancel", x: 700, y: 900, width: 28, height: 28 },
    { id: "confirm", x: 812, y: 900, width: 28, height: 28 },
  ];
  const clicked = once(events, "click");
  helper.capture(regions);
  assert.deepEqual((await clicked)[0], { event: "click", id: "cancel", regions });
  const escaped = once(events, "escape");
  helper.release();
  assert.deepEqual((await escaped)[0], { event: "escape", got: { cmd: "release" } });
  helper.stop();
});

test("小帮手不在了之后再说开始截、不截了：什么也不做，不报错", async () => {
  const { helper, events } = start();
  const exited = once(events, "exit");
  helper.stop();
  await exited;
  helper.capture([]);
  helper.release();
});

test("小帮手中途退出：等着的粘贴失败，之后的粘贴直接失败", async () => {
  const { helper, events } = start();
  const exited = once(events, "exit");
  await assert.rejects(helper.paste("退出"), /退出了/);
  const [exit] = await exited;
  assert.equal(exit.code, 3);
  await assert.rejects(helper.paste("再来"), /没有在运行/);
});

test("可执行文件不存在时，粘贴失败而不是一直等；并且照样报一次“退出了”，上面才知道它没在", async () => {
  const errors = [];
  const seen = [];
  const helper = startHelper("/不存在/的/程序", {
    onEvent: (event) => seen.push(event),
    log: { warn() {}, error: (name) => errors.push(name) },
  });
  await assert.rejects(helper.paste("x"));
  assert.ok(errors.includes("helper_spawn_failed"));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(
    seen.map((event) => event.event),
    ["exit"],
  );
  await assert.rejects(helper.paste("再来"), /没有在运行/);
});
