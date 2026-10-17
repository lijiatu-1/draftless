#!/usr/bin/env node
// 只出报告，不跑任何东西：按现在的配置到结果库里取数。选择参数和 run.mjs 一样。
//   node bench/report.mjs [--dataset default] [--candidates a,b] [--lang zh,mixed,en] [--limit 20] [--clips id1,id2]
//     [--polisher deepseek/deepseek-flash]   端到端那一节看哪个润色模型的成品

import { join } from "node:path";
import { parseArgs } from "node:util";
import { engineVersionsOf, SELECTION_OPTIONS, saveReport, selectionFrom } from "./lib/cli.mjs";
import { WORK_DIR } from "./lib/dataset.mjs";
import { buildReport } from "./lib/report.mjs";
import { openResults } from "./lib/results.mjs";

const { values: args } = parseArgs({ options: SELECTION_OPTIONS });
const selection = selectionFrom(args);
const results = openResults(join(WORK_DIR, "results.db"));
const report = buildReport({ ...selection, results, engineVersions: await engineVersionsOf(selection.candidates) });
console.log(`${report.markdown}\n报告：${saveReport(report)}（细节在同名的 -details.md）`);
results.close();
