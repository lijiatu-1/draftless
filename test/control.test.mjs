import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { ControlError, NotRunningError, requestControl, startControlServer, TimeoutError } from "../src/control.mjs";
import { createTranslator } from "../src/i18n/index.mjs";
import { controlPipeName } from "../src/storage/paths.mjs";

// 控制通道的传输层从 Unix 套接字换成了命名管道（src/control.mjs），协议那一层一行没改。
// 所以这些测试守着的是同一批行为：一问一答、出错说得清、没人在听时报 NotRunning、卡住时按时放弃、
// 一条连接只办一件事。只有"套接字文件的权限和残留"那几条不再适用：管道不是文件，进程没了它就没了。

const zh = createTranslator("zh-CN");

let dir;
let pipeName;
let server;
let logged;
const log = {
  info: (event, fields) => logged.push({ level: "info", event, ...fields }),
  warn: (event, fields) => logged.push({ level: "warn", event, ...fields }),
  error: (event, fields) => logged.push({ level: "error", event, ...fields }),
};

beforeEach(() => {
  // 一份数据目录一条管道：测试各用各的临时目录，不会串到别的测试上
  dir = mkdtempSync(join(tmpdir(), "fs-control-"));
  pipeName = controlPipeName(dir);
  server = null;
  logged = [];
});
afterEach(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("问一句答一句，参数原样交给处理函数", async () => {
  server = await startControlServer({
    pipeName,
    log,
    handlers: { greet: async ({ name }) => ({ text: `你好，${name}` }), ping: () => "pong" },
  });
  assert.deepEqual(await requestControl(pipeName, "greet", { name: "世界" }), { text: "你好，世界" });
  assert.equal(await requestControl(pipeName, "ping"), "pong");
});

test("处理函数抛错时，对方收到那句错误说明", async () => {
  server = await startControlServer({
    pipeName,
    log,
    handlers: {
      fail: () => {
        throw new Error("这把 key 无效");
      },
    },
  });
  await assert.rejects(requestControl(pipeName, "fail"), /这把 key 无效/);
});

test("不认识的命令被拒绝", async () => {
  server = await startControlServer({ pipeName, log, handlers: {} });
  await assert.rejects(requestControl(pipeName, "dance"), /dance/);
});

test("出错时日志里只记命令名，不记参数（参数里可能是 key）", async () => {
  server = await startControlServer({
    pipeName,
    log,
    handlers: {
      "set-key": () => {
        throw new Error("不行");
      },
    },
  });
  await assert.rejects(requestControl(pipeName, "set-key", { key: "SECRET-VALUE" }));
  assert.ok(logged.some((entry) => entry.cmd === "set-key"));
  assert.ok(!JSON.stringify(logged).includes("SECRET-VALUE"));
});

test("没有在运行时抛 NotRunningError：没人监听这个管道名时连不上", async () => {
  await assert.rejects(requestControl(pipeName, "ping"), NotRunningError);
});

test("已经有一个在听时拒绝再启动，也不去动它", async () => {
  server = await startControlServer({ pipeName, log, handlers: { ping: () => "first" } });
  await assert.rejects(startControlServer({ pipeName, log, handlers: { ping: () => "second" } }), /已经有一个在运行/);
  assert.equal(await requestControl(pipeName, "ping"), "first");
});

test("关闭之后没人再听：再连就是 NotRunning。管道不是文件，没有要删的东西", async () => {
  server = await startControlServer({ pipeName, log, handlers: { ping: () => "pong" } });
  assert.equal(await requestControl(pipeName, "ping"), "pong");
  await server.close();
  server = null;
  await assert.rejects(requestControl(pipeName, "ping"), NotRunningError);
  // 同一个名字还能再起一个：没有残留文件挡路，也不需要清
  server = await startControlServer({ pipeName, log, handlers: { ping: () => "again" } });
  assert.equal(await requestControl(pipeName, "ping"), "again");
});

test("对方一直不回话时按时放弃", async () => {
  server = await startControlServer({ pipeName, log, handlers: { hang: () => new Promise(() => {}) } });
  await assert.rejects(
    requestControl(pipeName, "hang", {}, { timeoutMs: 100 }),
    (error) => error instanceof TimeoutError && /没有在 0\.1 秒内回话/.test(zh.text(error.problem)),
  );
});

test("没在运行和不答话都是 ControlError，调用方可以一并当成说得清的失败来处理", () => {
  assert.ok(new NotRunningError() instanceof ControlError);
  assert.ok(new TimeoutError("status", 5000) instanceof ControlError);
});

test("一条连接只处理一条命令：处理途中又来数据，不会把同一条命令再执行一遍", async () => {
  let calls = 0;
  let finish;
  server = await startControlServer({
    pipeName,
    log,
    handlers: {
      slow: () => {
        calls++;
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const { connect } = await import("node:net");
  const socket = connect(pipeName);
  const closed = new Promise((resolve) => socket.on("close", resolve));
  socket.on("data", () => {});
  socket.write('{"cmd":"slow"}\n');
  await new Promise((resolve) => setTimeout(resolve, 30));
  socket.write("\n");
  socket.write("\n");
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish("done");
  await closed;
  assert.equal(calls, 1);
});

test("收到的不是一行 JSON 时回一句错误，不让服务挂掉", async () => {
  server = await startControlServer({ pipeName, log, handlers: { ping: () => "pong" } });
  const { connect } = await import("node:net");
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(pipeName);
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk;
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write("这不是 JSON\n");
  });
  assert.equal(JSON.parse(reply).ok, false);
  assert.equal(await requestControl(pipeName, "ping"), "pong");
});

test("对方接了连接却一句没回就断开（正在退出），算作没有在运行", async () => {
  // 两种断法都会遇到：客气地收尾，或者直接掐掉
  const ways = [(socket) => socket.resume().end(), (socket) => socket.destroy()];
  for (const hangUp of ways) {
    const quitting = createServer(hangUp);
    const name = controlPipeName(`${dir}-${ways.indexOf(hangUp)}`);
    await new Promise((resolve) => quitting.listen(name, resolve));
    try {
      await assert.rejects(requestControl(name, "status"), NotRunningError);
    } finally {
      await new Promise((resolve) => quitting.close(resolve));
    }
  }
});
