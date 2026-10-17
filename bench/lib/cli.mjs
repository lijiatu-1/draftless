import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CANDIDATES, findCandidate } from "./candidates.mjs";
import { datasetDir, readManifest, select, WORK_DIR } from "./dataset.mjs";
import { DEFAULT_POLISHER, parsePolisher } from "./stages/polish.mjs";
import { engineVersionOf } from "./stages/transcribe.mjs";

// run.mjs、judge.mjs 和 report.mjs 共用的选择参数：评哪个数据集、哪些样本、哪些候选，润色交给谁。

export const SELECTION_OPTIONS = {
  dataset: { type: "string", default: "default" },
  candidates: { type: "string" },
  lang: { type: "string" },
  limit: { type: "string" },
  clips: { type: "string" },
  polisher: { type: "string", default: DEFAULT_POLISHER },
};

const list = (value) =>
  value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);

export function selectionFrom(args) {
  if (!existsSync(join(datasetDir(args.dataset), "manifest.jsonl"))) {
    fail(`没有数据集 ${args.dataset}：先跑 node bench/prepare.mjs --dataset ${args.dataset}`);
  }
  const limit = args.limit === undefined ? undefined : Number(args.limit);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) fail(`--limit 要是正整数，现在是 ${args.limit}`);
  const clips = select(readManifest(args.dataset), { ids: list(args.clips), langs: list(args.lang), limit });
  const candidates =
    list(args.candidates)?.map(
      (id) => findCandidate(id) ?? fail(`不认识的候选：${id}（有 ${CANDIDATES.map((c) => c.id).join("、")}）`),
    ) ?? CANDIDATES;
  if (clips.length === 0) fail("按这些条件选不出样本");
  let polisher;
  try {
    polisher = parsePolisher(args.polisher);
  } catch (error) {
    fail(`--polisher 写的是 ${args.polisher}：${error.message}`);
  }
  return { dataset: args.dataset, datasetDir: datasetDir(args.dataset), clips, candidates, polisher };
}

/** 各个候选用到的运行库的版本：转写的指纹里有它 */
export async function engineVersionsOf(candidates) {
  const versions = {};
  for (const { model } of candidates) versions[model.engine] ??= await engineVersionOf(model);
  return versions;
}

/** 报告写进 _work/reports/，汇总一份、细节一份，返回汇总的路径 */
export function saveReport({ markdown, details }) {
  const dir = join(WORK_DIR, "reports");
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(join(dir, `${stamp}.md`), markdown);
  writeFileSync(join(dir, `${stamp}-details.md`), details);
  return join(dir, `${stamp}.md`);
}

export function fail(message) {
  console.error(message);
  process.exit(2);
}
