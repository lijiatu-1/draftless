import { downloadSize } from "../../src/models/catalog.mjs";
import { formatChatChoice } from "../../src/server/chat/vendors.mjs";
import { durationBucket } from "./dataset.mjs";
import { judgeKey, KINDS } from "./stages/judge.mjs";
import { polishKey } from "./stages/polish.mjs";
import { REFERENCE, referenceKey } from "./stages/reference.mjs";
import { runConfig, transcribeKey } from "./stages/transcribe.mjs";
import { similarity } from "./text.mjs";

// 报告：按这次选中的样本和候选、按现在的配置算出每一格的指纹，到结果库里取数。
// 配置变过的格子取不到，算"缺"，不拿旧配置的结果凑数。
// 汇总只有数字；说的话只写进细节文件（_work 里，不进仓库），给人核对判官判得对不对。

export const quantile = (numbers, q) =>
  numbers.length === 0
    ? null
    : [...numbers].sort((a, b) => a - b)[Math.min(numbers.length - 1, Math.floor(numbers.length * q))];
export const mean = (numbers) => (numbers.length === 0 ? null : numbers.reduce((a, b) => a + b, 0) / numbers.length);
/**
 * 一个配置跑过的几轮合成一份：加载、首次取中位数（一轮偶尔慢不算数），内存取最大（峰值就是最坏的那次），跑在哪取最近一轮。
 * 几轮跑的样本不一样多，内存跟着最长的那条录音走，所以只取最大不取平均
 */
export function summarizeRuns(runs) {
  return {
    loadMs: quantile(
      runs.map((run) => run.loadMs),
      0.5,
    ),
    coldMs: quantile(
      runs.map((run) => run.coldMs),
      0.5,
    ),
    maxRssMb: runs.length === 0 ? null : Math.max(...runs.map((run) => run.maxRssMb)),
    backend: runs.at(-1)?.backend ?? null,
  };
}

const share = (rows, test) => (rows.length === 0 ? null : rows.filter(test).length / rows.length);

const fmt = {
  ms: (value) =>
    value === null ? "–" : value >= 10_000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`,
  x: (value) => (value === null ? "–" : `${value.toFixed(1)}×`),
  score: (value) => (value === null ? "–" : value.toFixed(2)),
  pct: (value) => (value === null ? "–" : `${Math.round(value * 100)}%`),
  num: (value, digits = 2) => (value === null ? "–" : value.toFixed(digits)),
};

const table = (head, rows) =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => " --- ").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");

/**
 * 每个候选在每条样本上的那一格：转写、参照、判分、字面相似度、耗时、实时倍数。
 * 给了润色的模型（polisher）时，每一格还带上润色出的成品（final）、它的判分（finalJudged）和端到端的耗时（转写 + 润色）。
 * @param {Record<string, string>} engineVersions 运行库 id → 版本（算转写的指纹要用）
 * @param {{ vendor: string, model: string } | null} [polisher]
 */
export function collect({ clips, candidates, results, engineVersions, datasetDir, polisher = null }) {
  const references = new Map(clips.map((clip) => [clip.id, results.get("reference", referenceKey(clip))]));
  const cells = candidates.flatMap((candidate) =>
    clips.map((clip) => {
      const transcript = results.get(
        "transcribe",
        transcribeKey(clip, candidate, engineVersions[candidate.model.engine], datasetDir),
      );
      const reference = references.get(clip.id);
      const judged =
        transcript && reference?.text ? results.get("judge", judgeKey(reference.text, transcript.text)) : null;
      const final = polisher && transcript ? results.get("polish", polishKey(transcript.text, polisher)) : null;
      const finalJudged =
        final && reference?.text ? results.get("judge", KINDS.final.key(reference.text, final.text)) : null;
      return {
        clip,
        candidate,
        transcript,
        reference,
        judged,
        similarity: transcript && reference?.text ? similarity(reference.text, transcript.text) : null,
        realtime: transcript ? (clip.durationSec * 1000) / Math.max(transcript.ms, 1) : null,
        final,
        finalJudged,
        endToEndMs: final ? transcript.ms + final.ms : null,
      };
    }),
  );
  return { references, cells };
}

/**
 * 能交给判官的格子（有参照、参照不是空的、有要判的文字），整理成 pendingJudgements 要的样子。
 * @param {keyof typeof KINDS} kind transcript 判转写，final 判润色后的成品
 */
export function judgeable(cells, kind, polisher = null) {
  return cells
    .filter((cell) => cell.reference?.text && (kind === "final" ? cell.final : cell.transcript))
    .map((cell) => ({
      clip: cell.clip,
      subject: kind === "final" ? `${cell.candidate.id} → ${formatChatChoice(polisher)}` : cell.candidate.id,
      reference: cell.reference,
      text: kind === "final" ? cell.final.text : cell.transcript.text,
    }));
}

/** 一组格子的汇总：准确（判官、字面）和速度 */
function summarize(cells) {
  const done = cells.filter((cell) => cell.transcript);
  const judged = cells.filter((cell) => cell.judged);
  const scores = judged.map((cell) => cell.judged.score);
  return {
    done: done.length,
    judged: judged.length,
    score: mean(scores),
    good: share(scores, (score) => score >= 4),
    lost: share(scores, (score) => score <= 1),
    similarity: quantile(
      cells.filter((cell) => cell.similarity !== null).map((cell) => cell.similarity),
      0.5,
    ),
    p50: quantile(
      done.map((cell) => cell.transcript.ms),
      0.5,
    ),
    p90: quantile(
      done.map((cell) => cell.transcript.ms),
      0.9,
    ),
    realtime: quantile(
      done.map((cell) => cell.realtime),
      0.5,
    ),
  };
}

export function buildReport({ clips, candidates, results, engineVersions, dataset, datasetDir, polisher = null }) {
  const { references, cells } = collect({ clips, candidates, results, engineVersions, datasetDir, polisher });
  const refRows = [...references.values()].filter(Boolean);
  const emptyRefs = refRows.filter((ref) => ref.text === "").length;
  const minutes = clips.reduce((sum, clip) => sum + clip.durationSec, 0) / 60;
  const langs = [...new Set(clips.map((clip) => clip.lang))].sort();
  const buckets = ["0-5s", "5-15s", "15-40s", "40s+"].filter((bucket) =>
    clips.some((clip) => durationBucket(clip.durationSec) === bucket),
  );
  const forCandidate = (candidate) => cells.filter((cell) => cell.candidate === candidate);

  const overview = candidates.map((candidate) => {
    const s = summarize(forCandidate(candidate));
    const run = summarizeRuns(results.runsOf(runConfig(candidate, engineVersions[candidate.model.engine])));
    return [
      candidate.id,
      run.backend ?? "–",
      `${Math.round(downloadSize(candidate.model) / 1e6)} MB`,
      `${s.done}/${clips.length}`,
      fmt.score(s.score),
      fmt.pct(s.good),
      fmt.pct(s.lost),
      fmt.num(s.similarity),
      fmt.ms(s.p50),
      fmt.ms(s.p90),
      fmt.x(s.realtime),
      fmt.ms(run.loadMs),
      fmt.ms(run.coldMs),
      run.maxRssMb ? `${run.maxRssMb} MB` : "–",
    ];
  });
  const refMs = refRows.map((ref) => ref.ms);
  const sections = [
    `# 本地转写评测`,
    `数据集 ${dataset}：${clips.length} 条，共 ${minutes.toFixed(1)} 分钟。参照（原生链路）：${refRows.length}/${clips.length} 条，` +
      `${REFERENCE.provider}/${REFERENCE.model}（${REFERENCE.thinkingLevel}），整条耗时 p50 ${fmt.ms(quantile(refMs, 0.5))}、p90 ${fmt.ms(quantile(refMs, 0.9))}` +
      (emptyRefs > 0 ? `；其中 ${emptyRefs} 条参照是空的（判成没有人声），不判分` : ""),
    "判官均分 0–5；≥4 是基本无损，≤1 是认不出。字面相似度和耗时取中位数；实时倍数 = 录音时长 ÷ 转写耗时，越大越快。",
    table(
      [
        "候选",
        "跑在",
        "体积",
        "转写",
        "判官均分",
        "≥4",
        "≤1",
        "字面相似",
        "耗时 p50",
        "耗时 p90",
        "实时倍数",
        "加载",
        "首次",
        "内存峰值",
      ],
      overview,
    ),
    "## 按语言",
    table(
      ["候选", ...langs.map((lang) => `${lang}（${clips.filter((clip) => clip.lang === lang).length} 条）均分 / p50`)],
      candidates.map((candidate) => [
        candidate.id,
        ...langs.map((lang) => {
          const s = summarize(forCandidate(candidate).filter((cell) => cell.clip.lang === lang));
          return `${fmt.score(s.score)} / ${fmt.ms(s.p50)}`;
        }),
      ]),
    ),
    "## 按录音时长",
    table(
      [
        "候选",
        ...buckets.map(
          (bucket) =>
            `${bucket}（${clips.filter((clip) => durationBucket(clip.durationSec) === bucket).length} 条）p50 / 均分`,
        ),
      ],
      candidates.map((candidate) => [
        candidate.id,
        ...buckets.map((bucket) => {
          const s = summarize(
            forCandidate(candidate).filter((cell) => durationBucket(cell.clip.durationSec) === bucket),
          );
          return `${fmt.ms(s.p50)} / ${fmt.score(s.score)}`;
        }),
      ]),
    ),
    "## 扣分的原因（出现的条数）",
    table(
      ["候选", "判了", "问题"],
      candidates.map((candidate) => {
        const judged = forCandidate(candidate).filter((cell) => cell.judged);
        const counts = new Map();
        for (const cell of judged)
          for (const problem of cell.judged.problems) counts.set(problem, (counts.get(problem) ?? 0) + 1);
        const listed = [...counts].sort((a, b) => b[1] - a[1]).map(([problem, n]) => `${problem} ${n}`);
        return [candidate.id, String(judged.length), listed.join("、") || "–"];
      }),
    ),
  ];
  if (polisher) sections.push(...endToEndSections({ cells, candidates, clips, langs, refMs, polisher }));
  return { markdown: `${sections.join("\n\n")}\n`, details: detailsOf(cells) };
}

/** 一组格子的成品汇总：判官、端到端和润色的耗时、花费 */
function summarizeFinals(cells) {
  const done = cells.filter((cell) => cell.final);
  const scores = cells.filter((cell) => cell.finalJudged).map((cell) => cell.finalJudged.score);
  const costs = done.map((cell) => cell.final.costUsd).filter((cost) => cost !== null);
  return {
    done: done.length,
    score: mean(scores),
    good: share(scores, (score) => score >= 4),
    lost: share(scores, (score) => score <= 1),
    p50: quantile(
      done.map((cell) => cell.endToEndMs),
      0.5,
    ),
    p90: quantile(
      done.map((cell) => cell.endToEndMs),
      0.9,
    ),
    polishP50: quantile(
      done.map((cell) => cell.final.ms),
      0.5,
    ),
    polishP90: quantile(
      done.map((cell) => cell.final.ms),
      0.9,
    ),
    cost: costs.length === done.length ? mean(costs) : null,
  };
}

/** 端到端：本地转写的原文交给润色模型之后的成品，和原生链路比准确和快慢 */
function endToEndSections({ cells, candidates, clips, langs, refMs, polisher }) {
  const name = formatChatChoice(polisher);
  const forCandidate = (candidate) => cells.filter((cell) => cell.candidate === candidate && cell.final);
  const withFinals = candidates.filter((candidate) => forCandidate(candidate).length > 0);
  if (withFinals.length === 0) return [];
  return [
    `## 端到端：本地转写 → 润色（${name}）`,
    `成品和参照（原生链路的成品）比，判官均分 0–5。端到端耗时 = 转写 + 润色，不含解码录音；原生链路整条耗时 p50 ${fmt.ms(quantile(refMs, 0.5))}、p90 ${fmt.ms(quantile(refMs, 0.9))}。花费是润色那一次请求的，按官方标准价估算。`,
    table(
      ["候选", "成品", "判官均分", "≥4", "≤1", "端到端 p50", "端到端 p90", "润色 p50", "润色 p90", "每条花费"],
      withFinals.map((candidate) => {
        const s = summarizeFinals(forCandidate(candidate));
        return [
          candidate.id,
          `${s.done}/${clips.length}`,
          fmt.score(s.score),
          fmt.pct(s.good),
          fmt.pct(s.lost),
          fmt.ms(s.p50),
          fmt.ms(s.p90),
          fmt.ms(s.polishP50),
          fmt.ms(s.polishP90),
          s.cost === null ? "–" : `$${s.cost.toFixed(5)}`,
        ];
      }),
    ),
    "### 成品按语言",
    table(
      [
        "候选",
        ...langs.map((lang) => `${lang}（${clips.filter((clip) => clip.lang === lang).length} 条）均分 / 端到端 p50`),
      ],
      withFinals.map((candidate) => [
        candidate.id,
        ...langs.map((lang) => {
          const s = summarizeFinals(forCandidate(candidate).filter((cell) => cell.clip.lang === lang));
          return `${fmt.score(s.score)} / ${fmt.ms(s.p50)}`;
        }),
      ]),
    ),
    "### 成品扣分的原因（出现的条数）",
    table(
      ["候选", "判了", "问题"],
      withFinals.map((candidate) => {
        const judged = forCandidate(candidate).filter((cell) => cell.finalJudged);
        const counts = new Map();
        for (const cell of judged)
          for (const problem of cell.finalJudged.problems) counts.set(problem, (counts.get(problem) ?? 0) + 1);
        const listed = [...counts].sort((a, b) => b[1] - a[1]).map(([problem, n]) => `${problem} ${n}`);
        return [candidate.id, String(judged.length), listed.join("、") || "–"];
      }),
    ),
  ];
}

/** 细节：每一格的分数、问题和几份文字，分低的在前。给人核对判官，只写进 _work */
function detailsOf(cells) {
  const finals = cells.filter((cell) => cell.finalJudged).sort((a, b) => a.finalJudged.score - b.finalJudged.score);
  const finalPart = finals.map((cell) =>
    [
      `## 成品 · ${cell.clip.id} · ${cell.candidate.id} · ${cell.finalJudged.score} 分`,
      `${cell.clip.lang}，${cell.clip.durationSec} 秒，端到端 ${cell.endToEndMs} ms（润色 ${cell.final.ms} ms）；${cell.finalJudged.problems.join("、") || "无问题"}：${cell.finalJudged.note}`,
      `参照：${cell.reference.text}`,
      `转写：${cell.transcript.text}`,
      `成品：${cell.final.text}`,
    ].join("\n\n"),
  );
  const judged = cells.filter((cell) => cell.judged).sort((a, b) => a.judged.score - b.judged.score);
  return `${[
    ...finalPart,
    ...judged.map((cell) =>
      [
        `## ${cell.clip.id} · ${cell.candidate.id} · ${cell.judged.score} 分`,
        `${cell.clip.lang}，${cell.clip.durationSec} 秒，${cell.transcript.ms} ms，字面相似 ${fmt.num(cell.similarity)}；${cell.judged.problems.join("、") || "无问题"}：${cell.judged.note}`,
        `参照：${cell.reference.text}`,
        `转写：${cell.transcript.text}`,
      ].join("\n\n"),
    ),
  ].join("\n\n")}\n`;
}
