import assert from "node:assert/strict";
import { test } from "node:test";
import { createTranslator } from "../../../src/i18n/index.mjs";
import {
  apiKeyProblem,
  DEFAULT_MODEL_CHOICE,
  findProvider,
  formatModelChoice,
  PROVIDERS,
  parseModelChoice,
} from "../../../src/server/providers/index.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

test("在册的厂商：Gemini、OpenAI、Qwen，各自说清 key 从哪个环境变量来、去哪申请、默认用哪个模型", () => {
  assert.deepEqual(
    PROVIDERS.map(({ id, name, keyEnv }) => ({ id, name, keyEnv })),
    [
      { id: "gemini", name: "Gemini", keyEnv: "GEMINI_API_KEY" },
      { id: "openai", name: "OpenAI", keyEnv: "OPENAI_API_KEY" },
      // 百炼的 key 习惯叫这个；和润色那一跳的 qwen 共用一把
      { id: "qwen", name: "Qwen", keyEnv: "DASHSCOPE_API_KEY" },
    ],
  );
  for (const provider of PROVIDERS) {
    assert.match(provider.keyPage, /^https:\/\//);
    assert.equal(typeof provider.defaultModel, "string");
    assert.equal(typeof provider.load, "function");
  }
  // 思考档位只有 Gemini 有
  assert.deepEqual(findProvider("gemini").thinkingLevels, ["MINIMAL", "LOW", "MEDIUM", "HIGH"]);
  assert.equal(findProvider("openai").thinkingLevels, null);
  assert.equal(findProvider("qwen").thinkingLevels, null);
  // 听写那边用 omni 的 plus 档，不是 flash：flash（哪怕版本号更高）会思考失控，
  // 同一段录音能烧掉几千个思考 token、跑 30–70 秒，实际算下来还更贵。见 qwen.mjs 的注释
  assert.equal(findProvider("qwen").defaultModel, "qwen3.5-omni-plus");
});

test("默认用 Gemini 3.6 Flash：3.5 Flash 已停用，发给它的请求本来就被转给 3.6，升级上来的人用的和原来一样", () => {
  assert.deepEqual(DEFAULT_MODEL_CHOICE, { provider: "gemini", model: "gemini-3.6-flash" });
});

test("findProvider：认 id，大小写不论；不认识的是 null，原型上的名字也查不到东西", () => {
  assert.equal(findProvider("openai").name, "OpenAI");
  assert.equal(findProvider("OpenAI").id, "openai");
  assert.equal(findProvider("deepseek"), null);
  assert.equal(findProvider("constructor"), null);
});

test("选模型的写法：厂商/模型；只写厂商就用它的默认模型", () => {
  assert.deepEqual(parseModelChoice("openai/gpt-audio-1.5"), { provider: "openai", model: "gpt-audio-1.5" });
  assert.deepEqual(parseModelChoice(" OpenAI/gpt-audio-1.5 "), { provider: "openai", model: "gpt-audio-1.5" });
  assert.deepEqual(parseModelChoice("openai"), { provider: "openai", model: findProvider("openai").defaultModel });
  assert.deepEqual(parseModelChoice("gemini"), { provider: "gemini", model: "gemini-3.6-flash" });
  assert.equal(formatModelChoice({ provider: "openai", model: "gpt-audio-1.5" }), "openai/gpt-audio-1.5");
});

test("旧写法：只写一个 Gemini 的模型名（0.3 以前的设置文件和 GEMINI_MODEL 都是这样）照样认", () => {
  assert.deepEqual(parseModelChoice("gemini-3.5-flash-lite"), { provider: "gemini", model: "gemini-3.5-flash-lite" });
});

test("写错时说清哪里不对、能填什么", () => {
  assert.throws(() => parseModelChoice("deepseek/deepseek-flash"), said(/不认识 deepseek.*gemini \/ openai/));
  assert.throws(() => parseModelChoice("openai/"), said(/模型名/));
  assert.throws(() => parseModelChoice(""), said(/空/));
  assert.throws(() => parseModelChoice("openai/gpt audio"), said(/模型名/));
  assert.throws(() => parseModelChoice("openai/a/b"), said(/模型名/));
});

test("key 的样子：只该有看得见的英文字符；不对时说哪里不对，句子里不带 key 本身", () => {
  assert.equal(apiKeyProblem("AIzaSy-not_a.real-key"), null);
  assert.equal(apiKeyProblem("sk-proj-Abc_123-xyz"), null);
  // 管道喂进多行内容、复制时带上了别的字，都是这一类
  for (const bad of [
    "line-one-SECRET\nline-two-SECRET",
    "has SECRET space",
    "tab\tSECRET",
    "钥匙SECRET",
    "x-SECRET\u0007",
  ]) {
    const problem = apiKeyProblem(bad);
    assert.equal(typeof problem.key, "string");
    assert.doesNotMatch(zh.text(problem), /SECRET/);
    assert.doesNotMatch(JSON.stringify(problem), /SECRET/);
  }
  assert.match(zh.text(apiKeyProblem("a b")), /空格或换行/);
  assert.match(zh.text(apiKeyProblem("k".repeat(600))), /太长/);
});

test("0.3 里 Gemini 的 SDK 认的带前缀写法（models/…、tunedModels/…）照样认成 Gemini 的", () => {
  assert.deepEqual(parseModelChoice("models/gemini-3.5-flash"), {
    provider: "gemini",
    model: "models/gemini-3.5-flash",
  });
  assert.deepEqual(parseModelChoice("tunedModels/my-model"), { provider: "gemini", model: "tunedModels/my-model" });
  assert.deepEqual(parseModelChoice("gemini/models/gemini-3.5-flash"), {
    provider: "gemini",
    model: "models/gemini-3.5-flash",
  });
  // 别家的模型名里不该有斜杠
  assert.throws(() => parseModelChoice("openai/models/x"), said(/模型名/));
});
