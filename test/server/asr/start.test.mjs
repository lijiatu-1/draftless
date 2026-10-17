import assert from "node:assert/strict";
import { test } from "node:test";
import { findModel } from "../../../src/models/catalog.mjs";
import { startTranscriber } from "../../../src/server/asr/start.mjs";

const quiet = { info() {}, warn() {}, error() {} };
const MODEL = findModel("qwen3-asr-0.6b-q8");

/** 假的模型仓：installed 决定装没装；有人让它下载就记下来（不该有） */
function fakeStore(installed) {
  const calls = [];
  return {
    calls,
    isInstalled: () => installed,
    dirOf: (model) => `/models/${model.id}`,
    async install(model) {
      calls.push(model.id);
    },
  };
}

const fakeSpawn = async (request) => ({ request });

test("下载好了的：在转写进程里装上", async () => {
  const store = fakeStore(true);
  const { request } = await startTranscriber({ modelId: MODEL.id, log: quiet, store, spawn: fakeSpawn });
  assert.equal(request.model, MODEL);
  assert.equal(request.dir, `/models/${MODEL.id}`);
  assert.deepEqual(store.calls, []);
});

test("没下载过的不自己去下：直接报错。下不下由用户点（models/library.mjs）", async () => {
  const store = fakeStore(false);
  await assert.rejects(startTranscriber({ modelId: MODEL.id, log: quiet, store, spawn: fakeSpawn }), /还没下载/);
  assert.deepEqual(store.calls, []);
});

test("清单里没有的模型直接报错", async () => {
  await assert.rejects(
    startTranscriber({ modelId: "nope", log: quiet, store: fakeStore(true), spawn: fakeSpawn }),
    /nope/,
  );
});
