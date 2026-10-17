import assert from "node:assert/strict";
import { test } from "node:test";
import { percentile, usageReport } from "../../src/usage/report.mjs";

const totals = (overrides = {}) => ({
  calls: 0,
  checks: 0,
  dictations: 0,
  inputTokens: 0,
  audioTokens: 0,
  cachedTokens: 0,
  outputTokens: 0,
  thinkingTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
  latenciesMs: [],
  ...overrides,
});

/** 假的历史库：记下问的是哪个时刻之后的，按时刻给不同的汇总 */
function fakeHistory(bySince) {
  const asked = [];
  return {
    asked,
    usage({ since = "" } = {}) {
      asked.push(since);
      return bySince[since] ?? { ...totals(), models: [] };
    },
  };
}

test("分位数：从快到慢排好的一串里取，最近秩法；空的是 null", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1700], 0.9), 1700);
  assert.equal(percentile([1000, 2000, 3000, 4000], 0.5), 2000);
  const tenth = Array.from({ length: 10 }, (_, i) => (i + 1) * 100);
  assert.equal(percentile(tenth, 0.9), 900);
  assert.equal(percentile(tenth, 0.5), 500);
});

test("今天从本机时区的零点算，本月从 1 号零点算，累计不限", () => {
  const history = fakeHistory({});
  usageReport(history, { now: new Date(2026, 9, 14, 15, 30) });
  assert.deepEqual(
    history.asked.sort(),
    ["", new Date(2026, 9, 1).toISOString(), new Date(2026, 9, 14).toISOString()].sort(),
  );
});

test("每段给出 token 合计和模型一般多久回话（中位数）、慢的时候多久（九成都比它快）；最外面按型号分开的是累计的", () => {
  const all = {
    ...totals({
      calls: 12,
      checks: 2,
      dictations: 10,
      inputTokens: 15_000,
      audioTokens: 2_500,
      outputTokens: 400,
      costUsd: 0.012,
      latenciesMs: [1000, 1100, 1200, 1300, 1400, 1500, 1600, 1700, 1800, 5000],
    }),
    models: [
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        ...totals({ calls: 12, dictations: 10, costUsd: 0.012, latenciesMs: [1000, 5000] }),
      },
    ],
  };
  const report = usageReport(fakeHistory({ "": all }), { now: new Date(2026, 9, 14, 15, 30) });

  const { latenciesMs: _raw, models: _models, ...expectedTotals } = all;
  const { models: _totalModels, ...reportedTotals } = report.total;
  assert.deepEqual(reportedTotals, {
    ...expectedTotals,
    tokens: 15_400,
    latency: { medianMs: 1400, p90Ms: 1800 },
  });
  // 今天还没调过：等待时间说不出来是 null，不是 0 秒
  assert.equal(report.today.calls, 0);
  assert.equal(report.today.latency, null);
  assert.deepEqual(
    report.models.map(({ provider, model, latency, latenciesMs }) => ({ provider, model, latency, latenciesMs })),
    [
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        latency: { medianMs: 1000, p90Ms: 5000 },
        latenciesMs: undefined,
      },
    ],
  );
});

test("每一段都按型号分开，每个型号说清是谁家的、本机的还是云上的，图标按谁家取", () => {
  const now = new Date(2026, 9, 14, 15, 30);
  const month = {
    ...totals({ calls: 5, dictations: 2 }),
    models: [
      {
        provider: "deepseek",
        model: "deepseek-flash",
        ...totals({ calls: 2, dictations: 2, costUsd: 0.0002, latenciesMs: [900, 1200] }),
      },
      { provider: "local", model: "sensevoice-small-q8", ...totals({ calls: 2, dictations: 2, latenciesMs: [300] }) },
      { provider: "local", model: "gone-model", ...totals({ calls: 1, dictations: 1 }) },
      { provider: "someone", model: "x", ...totals({ calls: 1 }) },
    ],
  };
  const report = usageReport(fakeHistory({ [new Date(2026, 9, 1).toISOString()]: month }), { now });
  assert.deepEqual(
    report.month.models.map(({ name, icon, local, model, latency }) => ({ name, icon, local, model, latency })),
    [
      {
        name: "DeepSeek",
        icon: "deepseek",
        local: false,
        model: "deepseek-flash",
        latency: { medianMs: 900, p90Ms: 1200 },
      },
      {
        name: "SenseVoice Small (Q8_0)",
        icon: "funaudiollm",
        local: true,
        model: "sensevoice-small-q8",
        latency: { medianMs: 300, p90Ms: 300 },
      },
      // 清单里已经没有的本机模型：照 id 说
      { name: "gone-model", icon: null, local: true, model: "gone-model", latency: null },
      { name: "someone", icon: "someone", local: false, model: "x", latency: null },
    ],
  );
  assert.deepEqual(report.today.models, []);
  // 累计的那份照旧也放在最外面
  assert.equal(report.models, report.total.models);
});
