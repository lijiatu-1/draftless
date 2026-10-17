import assert from "node:assert/strict";
import { test } from "node:test";
import { mean, quantile, summarizeRuns } from "../../bench/lib/report.mjs";

test("统计：分位数取排好序后的那一个，空的是 null；均值同理", () => {
  assert.equal(quantile([5, 1, 3], 0.5), 3);
  assert.equal(quantile([1, 2, 3, 4], 0.9), 4);
  assert.equal(quantile([], 0.5), null);
  assert.equal(mean([1, 2, 6]), 3);
  assert.equal(mean([]), null);
});

test("几轮的记录合成一份：加载和首次取中位数，内存取最大，跑在哪取最近一轮；没跑过是空的", () => {
  assert.deepEqual(
    summarizeRuns([
      { loadMs: 900, coldMs: 300, maxRssMb: 1200, backend: "cpu" },
      { loadMs: 300, coldMs: 100, maxRssMb: 3400, backend: "cpu" },
      { loadMs: 500, coldMs: 200, maxRssMb: 900, backend: "MTL0" },
    ]),
    { loadMs: 500, coldMs: 200, maxRssMb: 3400, backend: "MTL0" },
  );
  assert.deepEqual(summarizeRuns([]), { loadMs: null, coldMs: null, maxRssMb: null, backend: null });
});
