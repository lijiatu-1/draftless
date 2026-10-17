import assert from "node:assert/strict";
import { test } from "node:test";
import { languageOf, similarity } from "../../bench/lib/text.mjs";

test("语言：只有中文是 zh，只有英文是 en，中文夹英文词是 mixed；单个字母（B 站）不算英文词", () => {
  assert.equal(languageOf("今天天气怎么样？"), "zh");
  assert.equal(languageOf("Let me check the logs."), "en");
  assert.equal(languageOf("把这个 bug 修了，再推到 GitHub"), "mixed");
  assert.equal(languageOf("我在 B 站上看到的"), "zh");
  assert.equal(languageOf("123。"), null);
});

test("字面相似度：标点、空白、大小写、繁简的差别不算", () => {
  assert.equal(similarity("這個 Bug，我看了。", "这个bug我看了"), 1);
  assert.equal(similarity("", ""), 1);
  assert.equal(similarity("有字", ""), 0);
  assert.ok(similarity("今天下午开会", "明天上午开会") < 0.7);
  assert.equal(similarity("abcd", "abce"), 0.75);
});
