import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

// 评测的结果库。评测是一张"样本 × 候选"的表，每个格子分几个环节（参照、转写、判分），
// 每个环节的结果按"输入的指纹"存：指纹里是一切会影响这一步结果的东西（录音、模型文件、运行库版本、参数、提示词…）。
// 跑的时候先算出这次要的格子的指纹，库里有的跳过，没有的才跑——全量、增量、只跑一部分都是这一个办法；
// 哪样输入变了，只有受它影响的格子指纹会变，自然就重跑了，不用手动记哪些作废。

/** 键排好序再序列化，同样的内容不论写的顺序都得到同一个指纹 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const fingerprint = (value) => createHash("sha256").update(canonical(value)).digest("hex");

export function openResults(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS results (
      stage      TEXT NOT NULL,   -- reference / transcribe / judge
      key        TEXT NOT NULL,   -- 输入的指纹
      clip       TEXT NOT NULL,   -- 哪条样本，方便人查
      subject    TEXT NOT NULL,   -- 哪个候选（或参照用的模型），方便人查
      output     TEXT NOT NULL,   -- JSON
      created_at TEXT NOT NULL,
      PRIMARY KEY (stage, key)
    );
    CREATE TABLE IF NOT EXISTS runs (
      id         INTEGER PRIMARY KEY,
      candidate  TEXT NOT NULL,
      info       TEXT NOT NULL,   -- JSON：加载耗时、第一次的耗时、内存峰值、跑在哪…
      created_at TEXT NOT NULL
    );`);
  // 每一轮记的是哪个配置（模型文件、运行库版本、参数的指纹）：配置变了，旧的几轮不该算进新配置的数字里。
  // 早先建的库没有这一列，补上；那时记的几轮没有配置，不算进任何配置
  if (
    !db
      .prepare("PRAGMA table_info(runs)")
      .all()
      .some((column) => column.name === "config")
  ) {
    db.exec("ALTER TABLE runs ADD COLUMN config TEXT");
  }
  const getOne = db.prepare("SELECT output FROM results WHERE stage = ? AND key = ?");
  const putOne = db.prepare(
    "INSERT OR REPLACE INTO results (stage, key, clip, subject, output, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const addOne = db.prepare("INSERT INTO runs (candidate, config, info, created_at) VALUES (?, ?, ?, ?)");
  const ofConfig = db.prepare("SELECT info FROM runs WHERE config = ? ORDER BY id");

  return {
    /** @returns {object | null} */
    get(stage, key) {
      const row = getOne.get(stage, key);
      return row ? JSON.parse(row.output) : null;
    },
    put(stage, key, { clip, subject, output }) {
      putOne.run(stage, key, clip, subject, JSON.stringify(output), new Date().toISOString());
    },
    addRun(candidate, config, info) {
      addOne.run(candidate, config, JSON.stringify(info), new Date().toISOString());
    },
    /** 这个配置跑过的各轮，从早到晚 */
    runsOf(config) {
      return ofConfig.all(config).map((row) => JSON.parse(row.info));
    },
    close() {
      db.close();
    },
  };
}
