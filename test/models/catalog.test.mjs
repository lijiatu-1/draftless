import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import {
  CHIPS,
  CN_BASE,
  chipOf,
  DEFAULT_SOURCE,
  DEFAULT_TRANSCRIBER,
  downloadSize,
  downloadUrls,
  findModel,
  findSource,
  MODELS,
  measuredOn,
  mirrorKey,
  SOURCES,
  TAGS,
} from "../../src/models/catalog.mjs";
import { measuredText, tagTexts } from "../../src/models/describe.mjs";
import { findEngine } from "../../src/server/asr/engines/index.mjs";

const ROOT = join(import.meta.dirname, "../..");
const CHIP_IDS = CHIPS.map(({ id }) => id);

test("配置表：id 不重复，只用小写字母、数字、点和横线（它也是模型的目录名、国内源上的前缀）", () => {
  const ids = MODELS.map((model) => model.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) assert.match(id, /^[a-z0-9][a-z0-9.-]*$/);
  assert.equal(findModel(ids[0]), MODELS[0]);
  assert.equal(findModel("nope"), null);
  assert.ok(findModel(DEFAULT_TRANSCRIBER), "默认的转写模型在配置表里");
});

test("配置表：每个文件是仓库里的相对路径，带大小和 sha256；原始地址钉在某一次提交上", () => {
  for (const model of MODELS) {
    assert.match(model.origin.repo, /^[\w.-]+\/[\w.-]+$/, model.id);
    assert.match(model.origin.revision, /^[0-9a-f]{40}$/, model.id);
    if ("maxSeconds" in model) assert.ok(model.maxSeconds > 0, `${model.id} 的 maxSeconds`);
    for (const file of Object.values(model.files)) {
      assert.match(file.path, /^[\w.-]+(\/[\w.-]+)*$/, `${model.id} ${file.path}`);
      assert.ok(!file.path.split("/").includes(".."), `${model.id} ${file.path}`);
      assert.match(file.sha256, /^[0-9a-f]{64}$/, `${model.id} ${file.path}`);
      assert.ok(Number.isInteger(file.size) && file.size > 0, `${model.id} ${file.path}`);
    }
  }
  const sizes = Object.values(MODELS[0].files).map((file) => file.size);
  assert.equal(
    downloadSize(MODELS[0]),
    sizes.reduce((a, b) => a + b, 0),
  );
});

test("配置表：许可有名字和原文地址，注明原作者的仓库（往国内源上传时一起带上）", () => {
  for (const model of MODELS) {
    assert.ok(model.license.name, model.id);
    assert.match(model.license.url, /^https:\/\//, model.id);
    assert.match(model.author, /^[\w.-]+\/[\w.-]+$/, model.id);
    if (model.origin.notice !== undefined) assert.match(model.origin.notice, /^[\w.-]+$/, model.id);
  }
});

test("配置表：用的运行库登记过，它认得这一族，填配置时要的文件配置表里都有", async () => {
  for (const model of MODELS) {
    const engine = findEngine(model.engine);
    assert.ok(engine, `${model.id} 的运行库 ${model.engine}`);
    const { FAMILIES } = await engine.load();
    assert.ok(FAMILIES[model.family], `${engine.name} 认不认 ${model.family}`);
    const asked = [];
    FAMILIES[model.family].config((role) => {
      assert.ok(model.files[role], `${model.id} 缺 ${role}`);
      asked.push(role);
      return `/models/${model.id}/${model.files[role].path}`;
    });
    assert.ok(asked.length > 0);
  }
});

test("标签按实测打：适合哪类芯片、能用什么跑，measured 里都要有对应的那一条", () => {
  for (const model of MODELS) {
    for (const tag of model.tags) {
      assert.ok(Object.hasOwn(TAGS, tag), `${model.id} 的标签 ${tag} 没登记`);
      if (TAGS[tag] === "chip") {
        assert.ok(CHIP_IDS.includes(tag), `${tag} 不在 CHIPS 里`);
        assert.ok(
          model.measured.some(({ chip }) => chip === tag),
          `${model.id} 标了 ${tag} 却没在上面测过`,
        );
      }
      if (TAGS[tag] === "backend") {
        assert.ok(
          model.measured.some(({ backend }) => backend === tag),
          `${model.id} 标了 ${tag} 却没用它跑过`,
        );
      }
    }
    for (const entry of model.measured) {
      assert.ok(CHIP_IDS.includes(entry.chip), `${model.id} 测的芯片 ${entry.chip}`);
      assert.equal(TAGS[entry.backend], "backend", `${model.id} 的 ${entry.backend} 要登记成 backend`);
      assert.ok(entry.score >= 0 && entry.score <= 5, `${model.id} 均分`);
      for (const name of ["p50Ms", "realtime", "peakMB"]) assert.ok(entry[name] > 0, `${model.id} ${name}`);
      assert.ok(existsSync(join(ROOT, "bench/results", `${entry.run}.md`)), `${model.id} 的 ${entry.run} 没有报告`);
    }
  }
});

test("每个标签、芯片、加速后端在两种界面语言里都有说法", () => {
  for (const locale of ["zh-CN", "en"]) {
    const t = createTranslator(locale);
    for (const tag of Object.keys(TAGS)) assert.notEqual(t(`localModels.tags.${tag}`), `localModels.tags.${tag}`);
    for (const chip of CHIP_IDS) assert.notEqual(t(`localModels.chips.${chip}`), `localModels.chips.${chip}`);
    for (const [backend, kind] of Object.entries(TAGS)) {
      if (kind === "backend") assert.notEqual(t(`localModels.backends.${backend}`), `localModels.backends.${backend}`);
    }
    for (const { id } of SOURCES) assert.notEqual(t(`modelSources.${id}`), `modelSources.${id}`);
  }
});

test("认芯片：Apple 芯片、Intel Mac、Windows 两种；别的是 null", () => {
  assert.equal(chipOf("darwin", "arm64"), "apple-silicon");
  assert.equal(chipOf("darwin", "x64"), "intel-mac");
  assert.equal(chipOf("win32", "x64"), "windows-x64");
  assert.equal(chipOf("win32", "arm64"), "windows-arm64");
  assert.equal(chipOf("linux", "x64"), null);
});

test("某类芯片上的实测：跑得快的在前，写成一句话；没测过、认不出的芯片都如实说", () => {
  const zh = createTranslator("zh-CN");
  const q8 = findModel("qwen3-asr-0.6b-q8");
  const measured = measuredOn(q8, "apple-silicon");
  assert.deepEqual(
    measured.map(({ backend }) => backend),
    ["metal", "cpu"],
  );
  assert.equal(
    zh.text(measuredText(measured, "apple-silicon")),
    "Apple 芯片上实测（Metal）：均分 4.14/5 · 68 倍实时 · 内存 2.0 GB",
  );
  assert.deepEqual(measuredOn(q8, "windows-x64"), []);
  assert.equal(zh.text(measuredText([], "windows-x64")), "Windows（x64）上还没实测");
  assert.equal(zh.text(measuredText([], null)), "这类机器上还没实测");
  assert.deepEqual(
    tagTexts(["metal", "zh-en"]).map((text) => zh.text(text)),
    ["Metal 加速", "中英夹杂准"],
  );
});

test("下载源：默认国内源在前，原始地址垫后；选了原始地址就倒过来。都按 sha256 校验，从哪下的都一样", () => {
  assert.ok(findSource(DEFAULT_SOURCE));
  assert.equal(new Set(SOURCES.map(({ id }) => id)).size, SOURCES.length);
  const model = findModel("sensevoice-small-q8");
  const file = model.files.gguf;
  const { revision, repo } = model.origin;
  const cn = `${CN_BASE}/sensevoice-small-q8/${revision}/SenseVoiceSmall-Q8_0.gguf`;
  const hf = `https://huggingface.co/${repo}/resolve/${revision}/SenseVoiceSmall-Q8_0.gguf`;
  const mirror = `https://hf-mirror.com/${repo}/resolve/${revision}/SenseVoiceSmall-Q8_0.gguf`;
  assert.equal(mirrorKey(model, file.path), `sensevoice-small-q8/${revision}/SenseVoiceSmall-Q8_0.gguf`);
  assert.deepEqual(downloadUrls(model, file), [cn, hf, mirror]);
  assert.deepEqual(downloadUrls(model, file, "original"), [hf, mirror, cn]);
  assert.throws(() => downloadUrls(model, file, "ftp"), /ftp.*cn \/ original/);
});
