import assert from "node:assert/strict";
import { test } from "node:test";
import { renderTranscribers } from "../../../src/cli/render/modes.mjs";
import { downloadSize, MODELS, measuredOn } from "../../../src/models/catalog.mjs";
import { english, plain } from "./fixtures.mjs";

const view = (chip, overrides = {}) => ({
  models: MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    bytes: downloadSize(model),
    installed: model.id === "qwen3-asr-0.6b-q8",
    tags: model.tags,
    measured: measuredOn(model, chip),
  })),
  chip,
  setting: "qwen3-asr-0.6b-q8",
  source: "cn",
  sources: ["cn", "original"],
  current: "local",
  ...overrides,
});

test("本机转写模型：一行一个，下面是标签和这类芯片上的实测；最后说下载源和怎么换", () => {
  const text = renderTranscribers(view("apple-silicon"), plain);
  assert.match(text, /● qwen3-asr-0\.6b-q8\s+Qwen3-ASR 0\.6B \(Q8_0\)\s+850 MB\s+已下载/);
  assert.match(text, /\n\s+适合 Apple 芯片 · Metal 加速 · 能只用 CPU · 中英夹杂准\n/);
  assert.match(text, /\n\s+Apple 芯片上实测（Metal）：均分 4\.14\/5 · 68 倍实时 · 内存 2\.0 GB\n/);
  assert.match(text, /sensevoice-small-q8\s+SenseVoice Small \(Q8_0\)\s+253 MB\s+还没下载/);
  assert.match(text, /下载源：国内源（draftless 的 CDN）/);
  assert.match(text, /draftless config set modelSource original/);
  assert.doesNotMatch(text, /用不上/);
});

test("没在这类芯片上测过的如实说；不在 local 模式时开头说用不上；英文照样排", () => {
  const windows = renderTranscribers(view("windows-x64", { current: "native", source: "original" }), plain);
  assert.match(windows, /现在是 native 模式，用不上这些/);
  assert.match(windows, /Windows（x64）上还没实测/);
  assert.match(windows, /下载源：原始地址（Hugging Face）/);
  assert.match(windows, /modelSource cn/);
  const en = renderTranscribers(view("apple-silicon"), english);
  assert.match(en, /Measured on Apple silicon \(Metal\): 4\.14\/5 · 68× real time · 2\.0 GB memory/);
  assert.match(en, /Downloads from: China mirror \(draftless CDN\)/);
});
