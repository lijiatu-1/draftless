import assert from "node:assert/strict";
import { test } from "node:test";
import { durationBucket, select, stratify } from "../../bench/lib/dataset.mjs";

const item = (sourceId, lang, durationSec) => ({ sourceId, lang, durationSec });

test("分层抽样：每一层按 id 排序取前几条，重跑抽到同一批；不在任何一层里的不要", () => {
  const items = [
    item("d", "zh", 3),
    item("a", "zh", 4),
    item("c", "zh", 2),
    item("b", "mixed", 30),
    item("e", "mixed", 50),
    item("f", "en", 8),
    item("g", "zh", 12),
  ];
  const plan = [
    { lang: "zh", minSec: 0, maxSec: 5, count: 2 },
    { lang: "mixed", minSec: 15, maxSec: 40, count: 5 },
  ];
  assert.deepEqual(
    stratify(items, plan).map((x) => x.sourceId),
    ["a", "c", "b"],
  );
  assert.deepEqual(
    stratify([...items].reverse(), plan).map((x) => x.sourceId),
    ["a", "c", "b"],
  );
  assert.equal(stratify(items, null).length, items.length, "没有计划就全要");
});

test("筛选：按语言、按条数；不给就是全部", () => {
  const clips = [
    { id: "1", lang: "zh" },
    { id: "2", lang: "en" },
    { id: "3", lang: "mixed" },
    { id: "4", lang: "zh" },
  ];
  assert.deepEqual(
    select(clips, {}).map((c) => c.id),
    ["1", "2", "3", "4"],
  );
  assert.deepEqual(
    select(clips, { langs: ["zh", "mixed"] }).map((c) => c.id),
    ["1", "3", "4"],
  );
  assert.deepEqual(
    select(clips, { langs: ["zh"], limit: 1 }).map((c) => c.id),
    ["1"],
  );
  assert.deepEqual(
    select(clips, { ids: ["4", "2"] }).map((c) => c.id),
    ["2", "4"],
  );
});

test("时长分段：报告按这几段看耗时", () => {
  assert.deepEqual([2, 5, 14.9, 15, 39, 40, 300].map(durationBucket), [
    "0-5s",
    "5-15s",
    "5-15s",
    "15-40s",
    "15-40s",
    "40s+",
    "40s+",
  ]);
});
