import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { CN_BASE } from "../../src/models/catalog.mjs";
import { createModelStore } from "../../src/models/store.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const BYTES = { "a.onnx": Buffer.from("weights ".repeat(1000)), "tokenizer/vocab.json": Buffer.from('{"a":1}') };
const fileOf = (path) => ({ path, size: BYTES[path].length, sha256: sha256(BYTES[path]) });
const MODEL = {
  id: "fake-asr",
  origin: { repo: "someone/fake-asr", revision: "a".repeat(40) },
  files: { model: fileOf("a.onnx"), vocab: fileOf("tokenizer/vocab.json") },
};

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CN_HOST = new URL(CN_BASE).host;
/** 地址里那次提交后面的就是文件的路径：国内源和原始地址都这么排 */
const pathOf = (url) => url.split(`/${MODEL.origin.revision}/`)[1];

/** 一个临时的仓，下载走假的 fetch：按地址最后的路径给内容，记下下了哪些 */
function setUp({ serve = (path) => new Response(BYTES[path]) } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "draftless-models-"));
  dirs.push(dir);
  const fetched = [];
  const fetch = async (url) => {
    const path = pathOf(url);
    fetched.push(path);
    return serve(path);
  };
  return { dir, fetched, store: createModelStore({ dir, fetch }) };
}

test("默认先走国内源：它连不上、回错误码就换原始地址接着下，都不行才报错，报错里列出每个地址的原因", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draftless-models-"));
  dirs.push(dir);
  const hosts = [];
  const fetch = async (url) => {
    const { host, pathname } = new URL(url);
    hosts.push(host);
    if (host === CN_HOST) return new Response("", { status: 404 });
    if (host === "huggingface.co") throw new TypeError("fetch failed");
    return new Response(BYTES[pathOf(pathname)]);
  };
  const store = createModelStore({ dir, fetch });
  await store.install(MODEL);
  assert.equal(store.isInstalled(MODEL), true);
  const tried = [CN_HOST, "huggingface.co", "hf-mirror.com"];
  assert.deepEqual(hosts, [...tried, ...tried]);

  const failing = createModelStore({
    dir: mkdtempSync(join(tmpdir(), "draftless-models-")),
    fetch: async (url) =>
      new URL(url).host === "huggingface.co"
        ? Promise.reject(new TypeError("fetch failed"))
        : new Response("", { status: 503 }),
  });
  await assert.rejects(
    failing.install(MODEL),
    (error) =>
      new RegExp(`${CN_HOST}.*HTTP 503`, "s").test(error.message) &&
      /huggingface\.co.*fetch failed/s.test(error.message) &&
      /hf-mirror\.com.*HTTP 503/s.test(error.message),
  );
});

test("选了原始地址：先从 Hugging Face 下，国内源垫在最后", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draftless-models-"));
  dirs.push(dir);
  const hosts = [];
  const fetch = async (url) => {
    const { host, pathname } = new URL(url);
    hosts.push(host);
    return host === CN_HOST ? new Response(BYTES[pathOf(pathname)]) : new Response("", { status: 503 });
  };
  await createModelStore({ dir, fetch, source: "original" }).install(MODEL);
  assert.deepEqual(hosts.slice(0, 3), ["huggingface.co", "hf-mirror.com", CN_HOST]);
});

test("连上了但迟迟不给数据：到时候放弃这个地址，换下一个", async () => {
  const dir = mkdtempSync(join(tmpdir(), "draftless-models-"));
  dirs.push(dir);
  const fetch = async (url, { signal }) => {
    const { host, pathname } = new URL(url);
    if (host === CN_HOST) {
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    }
    return new Response(BYTES[pathOf(pathname)]);
  };
  const store = createModelStore({ dir, fetch, stallMs: 50 });
  await store.install(MODEL);
  assert.equal(store.isInstalled(MODEL), true);
});

test("装一个模型：文件照清单的路径放好，校验过，写上收据；再装一次不重新下载", async () => {
  const { dir, fetched, store } = setUp();
  const progress = [];
  assert.equal(store.isInstalled(MODEL), false);
  const modelDir = await store.install(MODEL, { onProgress: (p) => progress.push(p) });
  assert.equal(modelDir, join(dir, "fake-asr"));
  assert.deepEqual(readFileSync(join(modelDir, "tokenizer/vocab.json")), BYTES["tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(modelDir, "a.onnx")), BYTES["a.onnx"]);
  assert.equal(store.isInstalled(MODEL), true);
  assert.deepEqual(store.installed(), ["fake-asr"]);
  // 进度按整个模型算：下好的文件算满，正在下的算到哪
  const total = BYTES["a.onnx"].length + 7;
  assert.deepEqual(progress.at(-1), { received: total, total });
  assert.ok(progress.every((p) => p.total === total && p.received <= total));

  await store.install(MODEL);
  assert.deepEqual(fetched, ["a.onnx", "tokenizer/vocab.json"]);
});

test("内容和 sha256 对不上：报错说清是哪个文件，不留半截文件，也不算装好", async () => {
  const { dir, store } = setUp({ serve: (path) => new Response(path === "a.onnx" ? "tampered" : BYTES[path]) });
  await assert.rejects(store.install(MODEL), /a\.onnx 下载到 8 字节/);
  assert.equal(store.isInstalled(MODEL), false);
  assert.deepEqual(readdirSync(join(dir, "fake-asr")), []);
});

test("大小对但内容不对：报 sha256 对不上", async () => {
  const forged = Buffer.alloc(BYTES["a.onnx"].length, 1);
  const { store } = setUp({ serve: (path) => new Response(path === "a.onnx" ? forged : BYTES[path]) });
  await assert.rejects(store.install(MODEL), /a\.onnx 的 sha256 对不上/);
});

test("服务器回错误码：报出状态码，不当成下载成功", async () => {
  const { store } = setUp({ serve: () => new Response("nope", { status: 404 }) });
  await assert.rejects(store.install(MODEL), /HTTP 404/);
  assert.equal(store.isInstalled(MODEL), false);
});

test("断了重来：已经下好、内容也对的文件不再下载，只补缺的", async () => {
  const { dir, fetched, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  await store.install(MODEL);
  assert.deepEqual(fetched, ["tokenizer/vocab.json"]);
  assert.equal(store.isInstalled(MODEL), true);
});

test("已经在那儿的文件内容不对（下坏了、被改过）：重新下载，不拿来用", async () => {
  const { dir, fetched, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), "stale");
  await store.install(MODEL);
  assert.deepEqual(fetched, ["a.onnx", "tokenizer/vocab.json"]);
  assert.deepEqual(readFileSync(join(dir, "fake-asr", "a.onnx")), BYTES["a.onnx"]);
});

test("清单换了版本，旧收据就不算数：重新核对文件，内容没变的不重下", async () => {
  const { fetched, store } = setUp();
  await store.install(MODEL);
  const moved = { ...MODEL, origin: { ...MODEL.origin, revision: "b".repeat(40) } };
  assert.equal(store.isInstalled(moved), false);
  await createModelStore({
    // 同一个仓，换一张收据：Windows 的路径是反斜杠，目录要用 dirname 取
    dir: dirname(store.dirOf(MODEL)),
    fetch: () => assert.fail("不该下载"),
  }).install(moved);
  assert.equal(store.isInstalled(moved), true);
  assert.equal(fetched.length, 2);
});

test("还差多少字节：没下的文件按清单的大小算，已经在那儿的不算（下载前查磁盘空间用）", async () => {
  const { dir, store } = setUp();
  const total = BYTES["a.onnx"].length + 7;
  assert.equal(store.missingBytes(MODEL), total);
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  assert.equal(store.missingBytes(MODEL), 7);
  await store.install(MODEL);
  assert.equal(store.missingBytes(MODEL), 0);
});

test("断了重来时进度从已经下好的那部分算起，不从零开始", async () => {
  const { dir, store } = setUp();
  mkdirSync(join(dir, "fake-asr"), { recursive: true });
  writeFileSync(join(dir, "fake-asr", "a.onnx"), BYTES["a.onnx"]);
  const progress = [];
  await store.install(MODEL, { onProgress: (p) => progress.push(p) });
  assert.ok(progress[0].received >= BYTES["a.onnx"].length);
});

test("删掉：整个目录都不在了，列表里也没有；没装过的删了也不报错", async () => {
  const { store } = setUp();
  await store.install(MODEL);
  store.remove(MODEL);
  assert.equal(existsSync(store.dirOf(MODEL)), false);
  assert.deepEqual(store.installed(), []);
  store.remove(MODEL);
});
