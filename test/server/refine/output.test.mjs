import assert from "node:assert/strict";
import { test } from "node:test";
import { textFromModelOutput } from "../../../src/server/refine/output.mjs";
import { NO_SPEECH_MARK, SYSTEM_PROMPT } from "../../../src/server/refine/prompt.mjs";

test("提示词里写的无人声标记，和代码里判断的是同一个", () => {
  assert.ok(SYSTEM_PROMPT.includes(`只输出 ${NO_SPEECH_MARK}，`));
});

test("模型输出无人声标记或什么都没输出时，成品是空字符串", () => {
  assert.equal(textFromModelOutput(NO_SPEECH_MARK), "");
  assert.equal(textFromModelOutput(` ${NO_SPEECH_MARK}\n`), "");
  assert.equal(textFromModelOutput(undefined), "");
  assert.equal(textFromModelOutput("  "), "");
});

test("首尾空白去掉；用户真的说到了这个标记时不误删", () => {
  assert.equal(textFromModelOutput(" 我们后天开会吗？\n"), "我们后天开会吗？");
  assert.equal(textFromModelOutput(`标记是 ${NO_SPEECH_MARK} 这几个字`), `标记是 ${NO_SPEECH_MARK} 这几个字`);
});

test("整段成品最后的那个句号去掉；中间的句号、结尾的问号叹号省略号都留着", () => {
  assert.equal(textFromModelOutput("我们后天开会。"), "我们后天开会");
  assert.equal(textFromModelOutput("先这样。\n\n明天再对一下。\n"), "先这样。\n\n明天再对一下");
  assert.equal(textFromModelOutput("你觉得可以吗？"), "你觉得可以吗？");
  assert.equal(textFromModelOutput("开干吧！"), "开干吧！");
  assert.equal(textFromModelOutput("等等……"), "等等……");
});

test("模型偶尔写出的繁体字换成简体，本来就是简体的字词和英文数字不动", () => {
  assert.equal(textFromModelOutput("降低成本的這個事，後面再說"), "降低成本的这个事，后面再说");
  assert.equal(textFromModelOutput("著名的乾坤大挪移，用 workflow 1.5.0"), "著名的乾坤大挪移，用 workflow 1.5.0");
});

test("模型在成品前面多吐的一个外文词去掉：紧贴着汉字的，或者单独占一行的", () => {
  assert.equal(textFromModelOutput("me我有个疑惑"), "我有个疑惑");
  assert.equal(textFromModelOutput("the.要写一个教程"), "要写一个教程");
  assert.equal(textFromModelOutput("get_prompt\n对，开干！"), "对，开干！");
  assert.equal(textFromModelOutput("any\n\n还有一个事"), "还有一个事");
  assert.equal(textFromModelOutput("особен没问题"), "没问题");
});

test("他真的以英文开头的话不动：英文后面是空格或标点", () => {
  for (const text of ["UI 这块再调一下", "OK，那就这样", "Minecraft 里怎么把 PVP 打开？", "README", "LGTM!"]) {
    assert.equal(textFromModelOutput(text), text);
  }
});
