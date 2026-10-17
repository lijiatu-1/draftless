import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, test } from "node:test";
import { createTranslator } from "../../src/i18n/index.mjs";
import { openHistory } from "../../src/storage/history.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draftless-history-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (overrides = {}) => ({
  id: "a1",
  status: "completed",
  refinedText: "我们后天开会。",
  error: null,
  duration: 4.2,
  audioLocalPath: "/tmp/a1.webm",
  createdAt: "2026-10-13T08:00:00.000Z",
  ...overrides,
});

test("存进去的记录能原样读出来，新的在前；目录不存在会自己建", () => {
  const history = openHistory(join(dir, "nested", "history.db"));
  history.add(entry());
  history.add(
    entry({
      id: "a2",
      status: "failed",
      refinedText: "",
      error: "服务端没有回应",
      createdAt: "2026-10-13T09:00:00.000Z",
    }),
  );
  // 没记过账的（还没调到模型就失败了，或者是记账之前的版本存的）用量是 null
  assert.deepEqual(history.list(), [
    {
      ...entry({
        id: "a2",
        status: "failed",
        refinedText: "",
        error: "服务端没有回应",
        createdAt: "2026-10-13T09:00:00.000Z",
      }),
      usage: null,
    },
    { ...entry(), usage: null },
  ]);
  assert.equal(history.list({ limit: 1 }).length, 1);
  history.close();
});

test("关掉再打开，记录还在，不会重复建表", () => {
  const path = join(dir, "history.db");
  const first = openHistory(path);
  first.add(entry());
  first.close();
  const second = openHistory(path);
  assert.equal(second.list().length, 1);
  second.close();
});

test("同一个录音不能存两次；状态只能是完成或失败", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry());
  assert.throws(() => history.add(entry()), /UNIQUE|constraint/i);
  assert.throws(() => history.add(entry({ id: "a3", status: "pending" })), /CHECK|constraint/i);
  history.close();
});

test("库的版本比程序新时拒绝打开，不去动它", () => {
  const path = join(dir, "history.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openHistory(path), said(/版本是 99/));
});

test("统计：只数完成的听写，可以只看某个时刻之后的", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry({ id: "a", createdAt: "2026-10-12T08:00:00.000Z", refinedText: "昨天说的话", duration: 6 }));
  history.add(entry({ id: "b", createdAt: "2026-10-13T08:00:00.000Z", refinedText: "今天第一句", duration: 4 }));
  history.add(entry({ id: "c", createdAt: "2026-10-13T09:00:00.000Z", refinedText: "今天第二句话", duration: 5.5 }));
  history.add(
    entry({
      id: "d",
      createdAt: "2026-10-13T10:00:00.000Z",
      status: "failed",
      refinedText: "",
      error: "连不上",
      duration: 9,
    }),
  );

  assert.deepEqual(history.stats(), {
    dictations: 3,
    characters: 16,
    seconds: 15.5,
    failed: 1,
    costUsd: 0,
    unpricedCalls: 0,
  });
  assert.deepEqual(history.stats({ since: "2026-10-13T00:00:00.000Z" }), {
    dictations: 2,
    characters: 11,
    seconds: 9.5,
    failed: 1,
    costUsd: 0,
    unpricedCalls: 0,
  });
  history.close();
});

test("首页统计要的：所有完成了的听写，只带时间、文字、时长，老的在前；失败的、没听到声音的不算", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry({ id: "b", createdAt: "2026-10-13T09:00:00.000Z", refinedText: "第二句", duration: 2 }));
  history.add(entry({ id: "a", createdAt: "2026-10-12T09:00:00.000Z", refinedText: "第一句", duration: 1 }));
  history.add(entry({ id: "c", status: "failed", refinedText: "", error: "超时" }));
  // 误按了一下、没说话：模型回了空文字，也记成完成了，但不算说过话
  history.add(entry({ id: "d", createdAt: "2026-10-14T09:00:00.000Z", refinedText: "", duration: 3 }));
  assert.deepEqual(history.dictations(), [
    { createdAt: "2026-10-12T09:00:00.000Z", text: "第一句", duration: 1 },
    { createdAt: "2026-10-13T09:00:00.000Z", text: "第二句", duration: 2 },
  ]);
  history.close();
});

test("空的历史库统计出来全是 0", () => {
  const history = openHistory(join(dir, "history.db"));
  assert.deepEqual(history.stats(), {
    dictations: 0,
    characters: 0,
    seconds: 0,
    failed: 0,
    costUsd: 0,
    unpricedCalls: 0,
  });
  history.close();
});

test("只读打开：能看不能写，库不存在时不会凭空建一个", () => {
  const dbPath = join(dir, "history.db");
  assert.equal(openHistory(dbPath, { readOnly: true }), null);
  assert.equal(existsSync(dbPath), false);

  const writable = openHistory(dbPath);
  writable.add(entry());
  writable.close();

  const readOnly = openHistory(dbPath, { readOnly: true });
  assert.equal(readOnly.list().length, 1);
  assert.throws(() => readOnly.add(entry({ id: "b" })), /readonly/);
  readOnly.close();
});

test("只读打开时发现库的版本和程序对不上，就不读", () => {
  const dbPath = join(dir, "history.db");
  openHistory(dbPath).close();
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openHistory(dbPath, { readOnly: true }), said(/版本/));
});

// ---------- 记账：每次调模型一笔（src/server/refine/refiner.mjs 的 onCall 给的那个样子） ----------

const call = (overrides = {}) => ({
  purpose: "dictation",
  audioId: "a1",
  provider: "gemini",
  model: "gemini-3.6-flash",
  inputTokens: 1390,
  audioTokens: 25,
  cachedTokens: 0,
  outputTokens: 4,
  thinkingTokens: 0,
  costUsd: 0.001,
  latencyMs: 1700,
  createdAt: "2026-10-13T08:00:00.000Z",
  ...overrides,
});

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} ≠ ${expected}`);

test("历史里每一条带上它的用量：重来过的几次调用加在一起", () => {
  const history = openHistory(join(dir, "history.db"));
  // 账先到：模型回了话就记，成品贴出去之后才存历史
  history.addCall(call({ latencyMs: 1500, costUsd: 0.001 }));
  history.addCall(call({ latencyMs: 1200, costUsd: 0.002, outputTokens: 6 }));
  history.add(entry());
  const [row] = history.list();
  assert.deepEqual(
    { ...row.usage, costUsd: 0 },
    {
      calls: 2,
      inputTokens: 2780,
      outputTokens: 10,
      costUsd: 0,
      latencyMs: 2700,
    },
  );
  close(row.usage.costUsd, 0.003);
  history.close();
});

test("一条里有一笔不知道价，这一条的钱就说不知道，不拿一半当全部", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall(call({ costUsd: 0.001 }));
  history.addCall(call({ model: "gemini-9-ultra", costUsd: null }));
  history.add(entry());
  assert.equal(history.list()[0].usage.costUsd, null);
  history.close();
});

test("用量汇总：几次听写、几次验证 key、token 分项、多少钱，可以只看某个时刻之后的", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall(call({ audioId: "old", createdAt: "2026-10-12T08:00:00.000Z", costUsd: 0.5 }));
  history.addCall(call({ audioId: "a", latencyMs: 1000 }));
  history.addCall(call({ audioId: "a", latencyMs: 900, cachedTokens: 1024, thinkingTokens: 3, outputTokens: 7 }));
  history.addCall(call({ audioId: "b", latencyMs: 3000, provider: "openai", model: "gpt-audio-mini-2025-12-15" }));
  history.addCall(
    call({ purpose: "check", audioId: null, inputTokens: 2, audioTokens: 0, outputTokens: 0, latencyMs: 600 }),
  );
  history.addCall(call({ audioId: "c", model: "gemini-9-ultra", costUsd: null, latencyMs: 2000 }));

  const today = history.usage({ since: "2026-10-13T00:00:00.000Z" });
  const { models, costUsd, ...totals } = today;
  assert.deepEqual(totals, {
    calls: 5,
    checks: 1,
    dictations: 3,
    inputTokens: 1390 * 4 + 2,
    audioTokens: 25 * 4,
    cachedTokens: 1024,
    outputTokens: 4 * 3 + 7,
    thinkingTokens: 3,
    cacheCostUsd: 0,
    unpricedCalls: 1,
    // 每次听写等模型的时间（重来的几次加在一起），从快到慢
    latenciesMs: [1900, 2000, 3000],
  });
  close(costUsd, 0.004);

  // 按型号分开，花得多的在前；每个型号自己的等待时间
  assert.deepEqual(
    models.map(({ provider, model, calls, checks, dictations, unpricedCalls, latenciesMs }) => ({
      provider,
      model,
      calls,
      checks,
      dictations,
      unpricedCalls,
      latenciesMs,
    })),
    [
      {
        provider: "gemini",
        model: "gemini-3.6-flash",
        calls: 3,
        checks: 1,
        dictations: 1,
        unpricedCalls: 0,
        latenciesMs: [1900],
      },
      {
        provider: "openai",
        model: "gpt-audio-mini-2025-12-15",
        calls: 1,
        checks: 0,
        dictations: 1,
        unpricedCalls: 0,
        latenciesMs: [3000],
      },
      {
        provider: "gemini",
        model: "gemini-9-ultra",
        calls: 1,
        checks: 0,
        dictations: 1,
        unpricedCalls: 1,
        latenciesMs: [2000],
      },
    ],
  );

  assert.equal(history.usage().calls, 6);
  close(history.usage().costUsd, 0.504);
  history.close();
});

test("本机转写那一跳也记账：一次听写不数两次；整次等了多久是两跳加起来，按型号分开时各算各的", () => {
  const history = openHistory(join(dir, "history.db"));
  const local = { provider: "local", model: "qwen3-asr-0.6b-q8", inputTokens: 0, audioTokens: 0, outputTokens: 0 };
  history.addCall(call({ audioId: "l1", ...local, costUsd: 0, latencyMs: 300 }));
  history.addCall(
    call({ audioId: "l1", provider: "deepseek", model: "deepseek-flash", costUsd: 0.0001, latencyMs: 1200 }),
  );
  history.addCall(call({ audioId: "l2", ...local, costUsd: 0, latencyMs: 250 }));
  history.addCall(
    call({ audioId: "l2", provider: "deepseek", model: "deepseek-flash", costUsd: 0.0001, latencyMs: 900 }),
  );
  const usage = history.usage();
  assert.equal(usage.dictations, 2);
  assert.equal(usage.unpricedCalls, 0);
  assert.deepEqual(usage.latenciesMs, [1150, 1500]);
  assert.deepEqual(
    usage.models.map(({ provider, dictations, latenciesMs }) => ({ provider, dictations, latenciesMs })),
    [
      { provider: "deepseek", dictations: 2, latenciesMs: [900, 1200] },
      { provider: "local", dictations: 2, latenciesMs: [250, 300] },
    ],
  );
  history.close();
});

test("今天花了多少钱也在统计里，验证 key 的那几次也算", () => {
  const history = openHistory(join(dir, "history.db"));
  history.add(entry({ id: "a", createdAt: "2026-10-13T08:00:00.000Z" }));
  history.addCall(call({ audioId: "a", costUsd: 0.002 }));
  history.addCall(call({ purpose: "check", audioId: null, costUsd: 0.0001 }));
  history.addCall(call({ audioId: "x", createdAt: "2026-10-12T08:00:00.000Z", costUsd: 1 }));
  const today = history.stats({ since: "2026-10-13T00:00:00.000Z" });
  close(today.costUsd, 0.0021);
  assert.equal(today.unpricedCalls, 0);
  // 有一笔不知道价：钱只加得上知道价的，另报几笔不知道
  history.addCall(call({ audioId: "a", model: "gemini-9-ultra", costUsd: null }));
  assert.equal(history.stats({ since: "2026-10-13T00:00:00.000Z" }).unpricedCalls, 1);
  history.close();
});

test("还没记过账时用量全是 0，等待时间是空的", () => {
  const history = openHistory(join(dir, "history.db"));
  assert.deepEqual(history.usage(), {
    calls: 0,
    checks: 0,
    dictations: 0,
    inputTokens: 0,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd: 0,
    cacheCostUsd: 0,
    unpricedCalls: 0,
    latenciesMs: [],
    models: [],
  });
  history.close();
});

test("记账只取表里有的那几项：适配器以后多带一项用量也记得进去", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall({ ...call(), reasoningSummary: "多出来的一项" });
  assert.equal(history.usage().calls, 1);
  history.close();
});

test("提示词缓存的钱（建缓存、存着）记成单独的一类，汇总里另报；不算哪次听写", () => {
  const history = openHistory(join(dir, "history.db"));
  history.addCall(call({ audioId: "a" }));
  history.addCall(call({ purpose: "cache", audioId: null, inputTokens: 1350, outputTokens: 0, costUsd: 0.0012 }));
  history.addCall(call({ purpose: "cache", audioId: null, inputTokens: 0, outputTokens: 0, costUsd: 0.0001 }));
  const usage = history.usage();
  assert.equal(usage.calls, 3);
  assert.equal(usage.dictations, 1);
  close(usage.cacheCostUsd, 0.0013);
  close(usage.costUsd, 0.0023);
  // 等待时间只算听写的
  assert.deepEqual(usage.latenciesMs, [1700]);
  history.close();
});

test("账的用途只能是听写、验证 key 或者提示词缓存", () => {
  const history = openHistory(join(dir, "history.db"));
  assert.throws(() => history.addCall(call({ purpose: "other" })), /CHECK|constraint/i);
  history.close();
});

test("记账之前的版本建的库（版本 1）打开时升上来：原来的记录都在，账从零开始", () => {
  const path = join(dir, "history.db");
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE history (
     id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
     refined_text TEXT NOT NULL, error TEXT, duration REAL NOT NULL, audio_local_path TEXT, created_at TEXT NOT NULL);
   CREATE INDEX history_created_at ON history (created_at DESC);
   PRAGMA user_version = 1;`);
  old
    .prepare(
      "INSERT INTO history VALUES ('a1', 'completed', '我们后天开会。', NULL, 4.2, '/tmp/a1.webm', '2026-10-13T08:00:00.000Z')",
    )
    .run();
  old.close();

  const history = openHistory(path);
  assert.deepEqual(history.list(), [{ ...entry(), usage: null }]);
  assert.equal(history.usage().calls, 0);
  history.addCall(call());
  assert.equal(history.list()[0].usage.calls, 1);
  history.close();
});
