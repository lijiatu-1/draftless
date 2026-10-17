import assert from "node:assert/strict";
import { test } from "node:test";
import { MODELS, makerOf } from "../../../src/models/catalog.mjs";
import { PROVIDER_ICON_PATHS } from "../../../src/renderer/shared/provider-icons.mjs";
import { CHAT_VENDORS } from "../../../src/server/chat/vendors.mjs";
import { PROVIDERS } from "../../../src/server/providers/index.mjs";

const PATH = /^M[\d.\s,a-zA-Z-]+z?$/;

test("每一家模型都有图标：接了新的一家，设置和首次引导里不会只剩个名字", () => {
  for (const { id } of PROVIDERS) assert.match(PROVIDER_ICON_PATHS[id] ?? "", PATH, id);
});

test("润色的每一家也有图标，自定义服务用一个通用的", () => {
  for (const { id } of CHAT_VENDORS) assert.match(PROVIDER_ICON_PATHS[id] ?? "", PATH, id);
});

test("本机模型按出自哪家配图标：作者仓库的组织名", () => {
  assert.equal(makerOf(MODELS.find(({ id }) => id === "qwen3-asr-0.6b-q8")), "qwen");
  assert.equal(makerOf(MODELS.find(({ id }) => id === "sensevoice-small-q8")), "funaudiollm");
  for (const model of MODELS) assert.match(PROVIDER_ICON_PATHS[makerOf(model)] ?? "", PATH, model.id);
});
