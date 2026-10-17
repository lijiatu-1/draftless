import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LocalizedError, msg } from "../i18n/index.mjs";

// 历史记录和记账。history 表取原版 history_v2 里听写用得到的那几列（docs/08-local-data.md），
// 列名保持一致；model_calls 表是每次调模型的账（原版没有，它是包月的）。
// 用 Node 自带的 SQLite，不用原版的 better-sqlite3：少一个要随 Electron 重新编译的原生模块。
// 后台应用负责写，命令行只读着看，两边用的是这同一份代码。

/**
 * 表结构的版本号，存在 PRAGMA user_version 里。以后改表时在 MIGRATIONS 末尾加一步，不改已有的。
 * 退回旧版本前要先把库降回去，旧版本见到比自己新的库不敢动、启动不了。从 2（记账）退回 1（0.4.2 及以前）：
 *   sqlite3 ~/.draftless/data/history.db "DROP TABLE model_calls; PRAGMA user_version = 1;"
 * 只丢掉账，说过的话都在。
 */
const MIGRATIONS = [
  `CREATE TABLE history (
     id               TEXT PRIMARY KEY,   -- audio_id
     status           TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
     refined_text     TEXT NOT NULL,      -- 失败时是空字符串
     error            TEXT,               -- 失败原因，成功时为空
     duration         REAL NOT NULL,      -- 录音时长，秒
     audio_local_path TEXT,               -- 录音文件；失败的记录留着它，话不会白说
     created_at       TEXT NOT NULL       -- ISO 8601
   );
   CREATE INDEX history_created_at ON history (created_at DESC);`,
  // 账和历史各记各的，不设外键：账在模型回话时就记了，历史要等成品贴出去才存；验证 key、提示词缓存
  // （建缓存、续存储，见 src/server/providers/gemini-cache.mjs）的那几笔不属于哪次听写
  `CREATE TABLE model_calls (
     id              INTEGER PRIMARY KEY,
     audio_id        TEXT,               -- 哪一次听写（history.id）；验证 key、提示词缓存的为空
     purpose         TEXT NOT NULL CHECK (purpose IN ('dictation', 'check', 'cache')),
     provider        TEXT NOT NULL,      -- gemini / openai / deepseek…；本机转写那一跳是 local
     model           TEXT NOT NULL,      -- 实际回话、按它算钱的型号
     input_tokens    INTEGER NOT NULL,   -- 输入，含音频和命中缓存的
     audio_tokens    INTEGER NOT NULL,   -- 其中音频
     cached_tokens   INTEGER NOT NULL,   -- 其中命中缓存
     output_tokens   INTEGER NOT NULL,   -- 输出，含思考的
     thinking_tokens INTEGER NOT NULL,   -- 其中思考
     cost_usd        REAL,               -- 按当时官方标准价算的美元；价目表里没有这个型号时为空
     latency_ms      INTEGER NOT NULL,   -- 发出请求到收齐回话
     created_at      TEXT NOT NULL       -- ISO 8601
   );
   CREATE INDEX model_calls_created_at ON model_calls (created_at);
   CREATE INDEX model_calls_audio_id ON model_calls (audio_id);`,
];

function migrate(db) {
  const { user_version: current } = db.prepare("PRAGMA user_version").get();
  if (current > MIGRATIONS.length) {
    throw new LocalizedError(msg("storage.historyTooNew", { found: current, known: MIGRATIONS.length }));
  }
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

/** 只读着看的那一方不能替库升级，版本对不上时列可能不一样，所以不读 */
function openReadOnly(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const { user_version: version } = db.prepare("PRAGMA user_version").get();
  if (version !== MIGRATIONS.length) {
    db.close();
    throw new LocalizedError(msg("storage.historyTooOld", { found: version, known: MIGRATIONS.length }));
  }
  return db;
}

/**
 * 打开历史库。默认没有就新建，并把表结构升到最新。
 * @param {string} dbPath
 * @param {{ readOnly?: boolean }} [options] 只读时不新建也不升级；库还不存在就返回 null
 */
export function openHistory(dbPath, { readOnly = false } = {}) {
  let db;
  if (readOnly) {
    if (!existsSync(dbPath)) return null;
    db = openReadOnly(dbPath);
  } else {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    try {
      migrate(db);
    } catch (error) {
      // 打不开就别攥着这个文件：Windows 上还开着的文件连删都删不掉（退回旧版本时它也没法收拾）
      db.close();
      throw error;
    }
  }
  // 另一个进程正好在写的时候等一下，不立刻报"库被锁住"
  db.exec("PRAGMA busy_timeout = 2000");

  const insert = db.prepare(
    `INSERT INTO history (id, status, refined_text, error, duration, audio_local_path, created_at)
     VALUES (:id, :status, :refinedText, :error, :duration, :audioLocalPath, :createdAt)`,
  );
  const insertCall = db.prepare(
    `INSERT INTO model_calls (audio_id, purpose, provider, model, input_tokens, audio_tokens, cached_tokens,
                              output_tokens, thinking_tokens, cost_usd, latency_ms, created_at)
     VALUES (:audioId, :purpose, :provider, :model, :inputTokens, :audioTokens, :cachedTokens,
             :outputTokens, :thinkingTokens, :costUsd, :latencyMs, :createdAt)`,
  );
  // 先取最近的几条再去对账，账再多也只按 audio_id 的索引查这几条的。
  // 一条里有一笔不知道价，这一条的钱就是 null：拿一半当全部会少算
  const select = db.prepare(
    `WITH recent AS (
       SELECT * FROM history ORDER BY created_at DESC LIMIT :limit
     )
     SELECT recent.id, recent.status, recent.refined_text AS refinedText, recent.error, recent.duration,
            recent.audio_local_path AS audioLocalPath, recent.created_at AS createdAt,
            count(call.id) AS calls,
            sum(call.input_tokens) AS inputTokens,
            sum(call.output_tokens) AS outputTokens,
            CASE WHEN count(call.cost_usd) = count(call.id) THEN sum(call.cost_usd) END AS costUsd,
            sum(call.latency_ms) AS latencyMs
     FROM recent LEFT JOIN model_calls AS call ON call.audio_id = recent.id
     GROUP BY recent.id
     ORDER BY recent.created_at DESC`,
  );
  const summarize = db.prepare(
    `SELECT count(*) FILTER (WHERE status = 'completed') AS dictations,
            coalesce(sum(length(refined_text)) FILTER (WHERE status = 'completed'), 0) AS characters,
            coalesce(sum(duration) FILTER (WHERE status = 'completed'), 0) AS seconds,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            (SELECT coalesce(sum(cost_usd), 0) FROM model_calls WHERE created_at >= :since) AS costUsd,
            (SELECT count(*) - count(cost_usd) FROM model_calls WHERE created_at >= :since) AS unpricedCalls
     FROM history WHERE created_at >= :since`,
  );
  const completed = db.prepare(
    `SELECT created_at AS createdAt, refined_text AS text, duration FROM history
     WHERE status = 'completed' AND refined_text <> '' ORDER BY created_at`,
  );
  // 用量汇总的各列，总数和按型号分开的两处共用
  const USAGE_COLUMNS = `count(*) AS calls,
            count(*) FILTER (WHERE purpose = 'check') AS checks,
            count(DISTINCT audio_id) AS dictations,
            coalesce(sum(input_tokens), 0) AS inputTokens,
            coalesce(sum(audio_tokens), 0) AS audioTokens,
            coalesce(sum(cached_tokens), 0) AS cachedTokens,
            coalesce(sum(output_tokens), 0) AS outputTokens,
            coalesce(sum(thinking_tokens), 0) AS thinkingTokens,
            coalesce(sum(cost_usd), 0) AS costUsd,
            coalesce(sum(cost_usd) FILTER (WHERE purpose = 'cache'), 0) AS cacheCostUsd,
            count(*) - count(cost_usd) AS unpricedCalls`;
  const usageTotals = db.prepare(`SELECT ${USAGE_COLUMNS} FROM model_calls WHERE created_at >= :since`);
  const usageByModel = db.prepare(
    `SELECT provider, model, ${USAGE_COLUMNS} FROM model_calls WHERE created_at >= :since
     GROUP BY provider, model ORDER BY costUsd DESC, calls DESC`,
  );
  // 每次听写等了模型多久：夹着时间戳重来过的，几次加在一起才是用户等的；本机转写的两跳（local 那一笔加润色那一笔）
  // 也加在一起。按型号分开时各算各的
  const totalLatencies = db.prepare(
    `SELECT sum(latency_ms) AS ms FROM model_calls
     WHERE purpose = 'dictation' AND audio_id IS NOT NULL AND created_at >= :since
     GROUP BY audio_id ORDER BY ms`,
  );
  const dictationLatencies = db.prepare(
    `SELECT provider, model, sum(latency_ms) AS ms FROM model_calls
     WHERE purpose = 'dictation' AND audio_id IS NOT NULL AND created_at >= :since
     GROUP BY audio_id, provider, model ORDER BY ms`,
  );

  return {
    /** @param {{ id: string, status: "completed" | "failed", refinedText: string, error: string | null, duration: number, audioLocalPath: string | null, createdAt: string }} entry */
    add(entry) {
      insert.run(entry);
    },
    /**
     * 最近的记录，新的在前。每一条带上它的用量 usage：{ calls, inputTokens, outputTokens, costUsd, latencyMs }，
     * 夹着时间戳重来过的几次加在一起；没记过账的（没调到模型就失败了，或者记账之前的版本存的）是 null
     */
    list({ limit = 200 } = {}) {
      return select.all({ limit }).map(({ calls, inputTokens, outputTokens, costUsd, latencyMs, ...row }) => ({
        ...row,
        usage: calls === 0 ? null : { calls, inputTokens, outputTokens, costUsd, latencyMs },
      }));
    },
    /**
     * 说了多少次、多少字、多长时间（只数完成的），失败了几次，以及花了多少美元（验证 key 的也算）。
     * 钱只加得上知道价的那几笔，不知道价的有几笔另报（unpricedCalls），给人看时要说"至少"
     * @param {{ since?: string }} [range] 只数这个时刻（ISO 8601）之后的
     */
    stats({ since = "" } = {}) {
      return { ...summarize.get({ since }) };
    },
    /**
     * 所有完成了的听写，老的在前，只带首页统计要的几项（src/usage/insights.mjs）：字数、哪天说的要从文字和时间里数。
     * 没听到声音的（模型回了空文字）不算：误按一下不该算一天活跃，也不该拉低语速。
     * 一条百来个字，几千条也就几百 KB，不在库里预先汇总
     */
    dictations() {
      return completed.all().map((row) => ({ ...row }));
    },
    /**
     * 记一笔账：一次回了话的模型调用（src/server/refine/refiner.mjs 的 onCall 给的样子）。
     * @param {{ purpose: "dictation" | "check" | "cache", audioId: string | null, provider: string, model: string, inputTokens: number, audioTokens: number, cachedTokens: number, outputTokens: number, thinkingTokens: number, costUsd: number | null, latencyMs: number, createdAt: string }} call
     */
    addCall(call) {
      // 只取表里有的几项：多给一项的话 SQLite 会报"未知参数"，适配器多带一项用量不该让账记不上
      insertCall.run({
        audioId: call.audioId,
        purpose: call.purpose,
        provider: call.provider,
        model: call.model,
        inputTokens: call.inputTokens,
        audioTokens: call.audioTokens,
        cachedTokens: call.cachedTokens,
        outputTokens: call.outputTokens,
        thinkingTokens: call.thinkingTokens,
        costUsd: call.costUsd,
        latencyMs: call.latencyMs,
        createdAt: call.createdAt,
      });
    },
    /**
     * 用量汇总：调了几次（几次是验证 key）、几次听写、各项 token、多少美元（其中提示词缓存多少）、几次不知道价（没算进钱里），
     * latenciesMs 是每次听写等模型的毫秒数（从快到慢）；models 是按型号分开的同样几项，花得多的在前。
     * @param {{ since?: string }} [range] 只数这个时刻（ISO 8601）之后的
     */
    usage({ since = "" } = {}) {
      const latencies = dictationLatencies.all({ since });
      const latenciesOf = (provider, model) =>
        latencies.filter((row) => row.provider === provider && row.model === model).map(({ ms }) => ms);
      return {
        ...usageTotals.get({ since }),
        latenciesMs: totalLatencies.all({ since }).map(({ ms }) => ms),
        models: usageByModel
          .all({ since })
          .map((row) => ({ ...row, latenciesMs: latenciesOf(row.provider, row.model) })),
      };
    },
    close() {
      db.close();
    },
  };
}
