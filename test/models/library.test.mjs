import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { downloadSize, findModel } from "../../src/models/catalog.mjs";
import { createLocalModels } from "../../src/models/library.mjs";

const zh = createTranslator("zh-CN");
const quiet = { info() {}, warn() {}, error() {} };
const QWEN = findModel("qwen3-asr-0.6b-q8");
const SENSE = findModel("sensevoice-small-q8");
const GB = 1_000_000_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * 假的模型仓：installed 是装好了的 id；install 不真下，由 control 手动报进度、下完、出错。
 * 每次 createStore 记下用的哪个源
 */
function setUp({ installed = [], free = 100 * GB, partial = {} } = {}) {
  const control = { installed: new Set(installed), sources: [], jobs: new Map(), removed: [] };
  const createStore = ({ source }) => {
    control.sources.push(source);
    return {
      isInstalled: (model) => control.installed.has(model.id),
      missingBytes: (model) => (control.installed.has(model.id) ? 0 : downloadSize(model) - (partial[model.id] ?? 0)),
      remove: (model) => {
        control.removed.push(model.id);
        control.installed.delete(model.id);
      },
      install: (model, { signal, onProgress }) =>
        new Promise((resolve, reject) => {
          const job = {
            progress: (received) => onProgress({ received, total: downloadSize(model) }),
            finish: () => {
              control.installed.add(model.id);
              resolve();
            },
            fail: (error) => reject(error),
          };
          control.jobs.set(model.id, job);
          signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")));
        }),
    };
  };
  const changed = [];
  const models = createLocalModels({
    dir: "/models",
    source: "cn",
    log: quiet,
    onChange: (id) => changed.push(id),
    createStore,
    freeBytes: () => free,
  });
  return { control, models, changed };
}

test("列表：每个模型下好了没有、正在下到哪、上次为什么没下下来；只是看，不下载", () => {
  const { models, control } = setUp({ installed: [SENSE.id] });
  const list = models.list();
  assert.equal(list.length >= 4, true);
  assert.deepEqual(
    list.find(({ id }) => id === SENSE.id),
    {
      id: SENSE.id,
      installed: true,
      download: null,
      partial: 0,
      problem: null,
    },
  );
  assert.equal(list.find(({ id }) => id === QWEN.id).installed, false);
  assert.equal(control.jobs.size, 0);
});

test("下载：用户点了才下；进度报给页面；下完算装好、通知一声", async () => {
  const { models, control, changed } = setUp();
  assert.deepEqual(await models.download(QWEN.id), { ok: true });
  assert.deepEqual(models.status(QWEN.id).download, { received: 0, total: downloadSize(QWEN) });
  control.jobs.get(QWEN.id).progress(downloadSize(QWEN));
  control.jobs.get(QWEN.id).finish();
  await tick();
  assert.equal(models.isInstalled(QWEN.id), true);
  assert.equal(models.status(QWEN.id).download, null);
  assert.ok(changed.filter((id) => id === QWEN.id).length >= 2);
});

test("下载前查磁盘：剩的不够还差的那么多（加一点余量）就不下，说清要多少、剩多少", async () => {
  const { models, control } = setUp({ free: 500_000_000 });
  const result = await models.download(QWEN.id);
  assert.equal(result.ok, false);
  assert.match(zh.text(result.problem), /磁盘空间不够.*Qwen3-ASR.*850 MB.*500 MB/);
  assert.equal(control.jobs.size, 0);
  // 小一点的照样能下
  assert.deepEqual(await models.download(SENSE.id), { ok: true });
});

test("下过一半的：只算还差的那部分；列表里报已经下了多少", async () => {
  const half = Math.round(downloadSize(QWEN) / 2);
  const { models } = setUp({ free: downloadSize(QWEN) - half + 300_000_000, partial: { [QWEN.id]: half } });
  assert.equal(models.status(QWEN.id).partial, half);
  assert.deepEqual(await models.download(QWEN.id), { ok: true });
});

test("已经下好、正在下的再点一次：什么都不做；清单里没有的说清楚", async () => {
  const { models, control } = setUp({ installed: [SENSE.id] });
  assert.deepEqual(await models.download(SENSE.id), { ok: true });
  await models.download(QWEN.id);
  await models.download(QWEN.id);
  assert.equal(control.sources.length, 1);
  const unknown = await models.download("nope");
  assert.equal(unknown.ok, false);
  assert.match(zh.text(unknown.problem), /nope/);
});

test("取消：停下来，不算失败；已经下好的文件留着，下次接着下", async () => {
  const { models, control } = setUp();
  await models.download(QWEN.id);
  models.cancel(QWEN.id);
  await tick();
  assert.equal(models.status(QWEN.id).download, null);
  assert.equal(models.status(QWEN.id).problem, null);
  assert.deepEqual(control.removed, []);
  // 没在下的取消一下也不出错
  models.cancel(SENSE.id);
});

test("没下下来：记下原因，列表里能看到；再点下载就清掉原因重来", async () => {
  const { models, control } = setUp();
  await models.download(QWEN.id);
  control.jobs.get(QWEN.id).fail(new Error("哪个地址都没下下来"));
  await tick();
  assert.match(zh.text(models.status(QWEN.id).problem), /没下下来.*哪个地址都没下下来/);
  await models.download(QWEN.id);
  assert.equal(models.status(QWEN.id).problem, null);
});

test("删除：整个删掉；正在下的先停下再删", async () => {
  const { models, control } = setUp({ installed: [SENSE.id] });
  assert.deepEqual(models.remove(SENSE.id), { ok: true });
  assert.equal(models.isInstalled(SENSE.id), false);
  await models.download(QWEN.id);
  models.remove(QWEN.id);
  await tick();
  assert.deepEqual(control.removed, [SENSE.id, QWEN.id]);
  assert.equal(models.status(QWEN.id).download, null);
  assert.equal(models.status(QWEN.id).problem, null);
});

test("换下载源：正在下的从新的源接着下，不算失败；以后的下载也用新的源", async () => {
  const { models, control } = setUp();
  await models.download(QWEN.id);
  models.setSource("original");
  await tick();
  assert.deepEqual(control.sources, ["cn", "original"]);
  assert.equal(models.status(QWEN.id).problem, null);
  assert.notEqual(models.status(QWEN.id).download, null);
  await models.download(SENSE.id);
  assert.equal(control.sources.at(-1), "original");
});

test("关掉时停下所有正在下的", async () => {
  const { models } = setUp();
  await models.download(QWEN.id);
  await models.download(SENSE.id);
  models.close();
  await tick();
  assert.equal(models.status(QWEN.id).download, null);
  assert.equal(models.status(SENSE.id).download, null);
});
