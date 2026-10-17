import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { DEFAULT_TRANSCRIBER, findModel } from "../../src/models/catalog.mjs";
import { createModeRefiner, describeRoute, findMode, keyVendorOf, MODES, parseMode } from "../../src/server/modes.mjs";

const zh = createTranslator("zh-CN");
const quiet = { info() {}, warn() {}, error() {} };
const NATIVE = { mode: "native", model: { provider: "openai", model: "gpt-audio-mini" }, thinkingLevel: "MINIMAL" };
const LOCAL = {
  mode: "local",
  transcriber: "qwen3-asr-0.6b-q8",
  polish: { vendor: "deepseek", model: "deepseek-flash" },
  customUrl: null,
};

test("两条链路平级登记，默认的转写模型在清单里", () => {
  assert.deepEqual(
    MODES.map(({ id }) => id),
    ["native", "local"],
  );
  assert.ok(findModel(DEFAULT_TRANSCRIBER));
  assert.equal(findMode("LOCAL").id, "local");
  assert.equal(findMode("nope"), null);
});

test("链路的写法：认 native / local，大小写不论；写错了说能填什么", () => {
  assert.equal(parseMode(" Local "), "local");
  assert.throws(
    () => parseMode("cloud"),
    (error) => /native/.test(zh.text(error.problem)) && /local/.test(zh.text(error.problem)),
  );
});

test("要用谁家的 key：原生链路是收音频的那家，本地转写链路是润色的那家", () => {
  assert.equal(keyVendorOf(NATIVE).id, "openai");
  assert.equal(keyVendorOf(LOCAL).id, "deepseek");
  assert.equal(keyVendorOf(LOCAL).keyEnv, "DEEPSEEK_API_KEY");
  assert.equal(keyVendorOf({ ...LOCAL, polish: { vendor: "custom", model: "m" } }).keyEnv, "DRAFTLESS_CUSTOM_API_KEY");
});

test("一句话说清这条路线（日志和状态里用）", () => {
  assert.equal(describeRoute(NATIVE), "native: openai/gpt-audio-mini");
  assert.equal(describeRoute(LOCAL), "local: qwen3-asr-0.6b-q8 → deepseek/deepseek-flash");
});

test("本地转写链路：拿交进来的转写器和按路线装的润色器接起来，润色发到选的那一家", async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, body: JSON.parse(init.body) });
    return Response.json({
      model: "deepseek-flash",
      choices: [{ finish_reason: "stop", message: { content: "好的。" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  };
  const transcriber = { transcribe: async () => ({ text: "好的" }) };
  const refiner = await createModeRefiner({
    route: LOCAL,
    apiKey: "sk-test",
    transcriber,
    log: quiet,
    decode: async () => new Float32Array(16_000),
    fetch,
  });
  assert.equal(await refiner.refine(Buffer.from("x"), { mimeType: "audio/webm" }), "好的");
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
});

test("本地转写链路没有转写器时直接报错（调用方要先装好模型）", async () => {
  await assert.rejects(createModeRefiner({ route: LOCAL, apiKey: "k", log: quiet }), /转写器/);
});
