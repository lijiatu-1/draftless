import { fingerprint } from "../results.mjs";

// 判分：由 Claude（开发时协作的那个 agent，Claude Opus 5.5）当判官，看本地模型转出来的字和参照对不对得上。
// 作者 2026-10-16 定的：判官不用任何接进 App 的模型，Gemini 3.6 Flash 的成品只当参照。
// 所以这一环不调接口，分两步：pending 把还没判的格子按样本导出成文件，判官照下面的标准逐条打分写成 verdicts，
// record 校验后存进结果库（bench/judge.mjs）。判过的格子按指纹记着，换了标准或判官才会重判。
//
// 判两样东西（KINDS），各有各的标准：
//   transcript  本地转写出的原文。它只是中间一跳，判的不是"字字一样"，而是"交给润色之后能不能还原出参照的意思"
//   final       本地转写链路润色后的成品。判的是拿来直接用，和参照比好不好用

export const JUDGE = Object.freeze({ by: "claude-opus-5-5" });

/** 问题的类别：只能从这几样里挑，报告里按类数 */
export const PROBLEMS = Object.freeze(["漏内容", "多出内容", "字词错", "英文词错", "数字错", "语言不对", "认不出"]);

export const RUBRIC = `同一段口述录音有两份文字：
- 参照：App 的原生链路（Gemini 听录音直接整理）出的成品，已经删掉口头禅、重复和改口，补好了标点，当作"他想说的话"。
- 转写：本地小模型对同一段录音的原样转写，之后会交给大模型润色成成品。

判的是：把这份转写交给润色模型之后，能不能还原出参照的意思。

这些差别是润色会处理的，不扣分：
- 口头禅、填充词（嗯、那个、就是），重复和口吃，改口前说错的那半句
- 标点、空格、分段，繁体和简体，英文大小写，数字写成汉字还是阿拉伯数字
- 参照删掉了而转写里还留着的内容，只要那是口头禅、重复或者被改口否定的话

这些才扣分：
- 漏内容：参照里有的意思，转写里没有
- 多出内容：转写里有参照里没有的实际内容（不是口头禅、重复或改口）
- 字词错：同音字、近音字认错了
- 英文词错：英文单词、专有名词（产品名、技术词）认错，或者写成了中文音译
- 数字错：数量、日期、版本号等认错
- 语言不对：说的是中文却转成了别的语言，或者反过来
- 认不出：大段内容是乱的、空的，或者和参照毫不相干

分数（整数 0 到 5）：
5：意思完整，差别都在不扣分的那一类里
4：有一两处不影响理解的小错（个别同音字），润色时能猜出原意
3：有关键处出错（专有名词、英文词、数字、人名），或者漏了零星一句，但大意还在
2：漏了或错了相当一部分，只靠这份转写还原不出原意
1：只认出了零星片段
0：空的、乱码，或者和参照毫不相干

参照也是模型听出来的，可能听错。两份冲突、又看不出谁对时按参照判，note 里写上"参照存疑"。
problems 从 ${PROBLEMS.join("、")} 里挑出现了的，没有就是空列表；note 用一句话说主要问题，没有问题写"无"。`;

const RUBRIC_PRINT = fingerprint(RUBRIC);

/** 参照、转写、判官和评分标准，哪样变了就要重判。两个候选转出一模一样的字，判一次就够 */
export const judgeKey = (reference, transcript) =>
  fingerprint({
    reference: fingerprint(reference),
    transcript: fingerprint(transcript),
    judge: JUDGE,
    rubric: RUBRIC_PRINT,
  });

export const FINAL_PROBLEMS = Object.freeze([
  "漏内容",
  "多出内容",
  "字词错",
  "英文词错",
  "数字错",
  "没整理干净",
  "改了意思",
  "答非所问",
  "格式不对",
  "认不出",
]);

export const FINAL_RUBRIC = `同一段口述录音有两份成品文字：
- 参照：App 的原生链路（Gemini 听录音直接整理）出的成品。
- 成品：本地转写链路的成品。先由本地小模型把录音转成原文，再交给纯文字大模型润色；润色的模型听不到录音，只看得到原文。

判的是：这份成品拿来直接用（原样粘贴进输入框），和参照比好不好用。

这些差别不扣分：
- 措辞、语序略有不同，但意思和语气一样
- 标点、空格、分段、列表的排法不同，只要排得合理
- 口头禅、重复删得比参照多或少一两处，无关紧要

这些扣分：
- 漏内容：参照里有的意思，成品里没有
- 多出内容：成品里有参照里没有、他也没说的内容（编出来的、替他补的）
- 字词错：同音字、近音字错了，读起来别扭或意思不对
- 英文词错：英文单词、专有名词写错，或者写成了中文音译
- 数字错：数量、日期、版本号等错了
- 没整理干净：口头禅、重复、口吃、改口前说错的话留了不少
- 改了意思：润色时改走了样，把他的话改成了另一个意思
- 答非所问：把口述里的问题、指令当成在问它，回答了或者照做了
- 格式不对：该分段、该列表的没做，或者多了 Markdown 符号、引号、解释之类的东西
- 认不出：大段是乱的、空的，或者和参照毫不相干

分数（整数 0 到 5）：
5：可以直接用，和参照一样好或者更好
4：有一两处小毛病（一个字、一个词的写法、留了个口头禅），不改也不影响理解
3：有一处得手动改的错（关键词、专有名词、数字，或者漏了一句），大意还在
2：好几处要改，或者漏了、错了相当一部分
1：只有零星可用
0：空的、乱的、答非所问，或者和参照毫不相干

参照也是模型听出来的，可能听错。两份冲突时，看得出成品更像他说的（比如参照把专有名词听错了）就不扣分，note 里写"参照存疑"；看不出谁对时按参照判。
problems 从 ${FINAL_PROBLEMS.join("、")} 里挑出现了的，没有就是空列表；note 用一句话说主要问题，没有问题写"无"。`;

const FINAL_RUBRIC_PRINT = fingerprint(FINAL_RUBRIC);

/** 要判的两样东西：评分标准、能挑的问题、指纹怎么算 */
export const KINDS = Object.freeze({
  transcript: Object.freeze({ label: "转写", rubric: RUBRIC, problems: PROBLEMS, key: judgeKey }),
  final: Object.freeze({
    label: "成品",
    rubric: FINAL_RUBRIC,
    problems: FINAL_PROBLEMS,
    key: (reference, final) =>
      fingerprint({
        reference: fingerprint(reference),
        final: fingerprint(final),
        judge: JUDGE,
        rubric: FINAL_RUBRIC_PRINT,
      }),
  }),
});

/** 待判文件里给每一格的短编号：指纹的前 12 位，判官照抄起来不容易错 */
export const handleOf = (key) => key.slice(0, 12);

/**
 * 还没判的格子，按样本分组：一条样本一份参照，下面是各个候选的文字（一模一样的并成一项）。
 * 文字是空的不用判官看，直接记 0 分。
 * @param {{ clip: object, subject: string, reference: { text: string }, text: string }[]} cells
 *   有参照（且参照不是空的）、有文字的格子。subject 是哪个候选（成品是"候选 → 润色的模型"）
 * @param {{ force?: boolean, kind?: keyof typeof KINDS }} [options]
 * @returns {{ groups: object[], empty: { key: string, clip: string, candidates: string[] }[] }}
 */
export function pendingJudgements(cells, results, { force = false, kind = "transcript" } = {}) {
  const keyOf = KINDS[kind].key;
  const groups = new Map();
  const empty = new Map();
  for (const { clip, subject, reference, text } of cells) {
    const key = keyOf(reference.text, text);
    if (!force && results.get("judge", key) !== null) continue;
    if (text.trim() === "") {
      const entry = empty.get(key) ?? { key, clip: clip.id, candidates: [] };
      entry.candidates.push(subject);
      empty.set(key, entry);
      continue;
    }
    const group = groups.get(clip.id) ?? {
      clip: clip.id,
      lang: clip.lang,
      durationSec: clip.durationSec,
      reference: reference.text,
      items: [],
    };
    const same = group.items.find((item) => item.key === key);
    if (same) same.candidates.push(subject);
    else group.items.push({ id: handleOf(key), key, candidates: [subject], text });
    groups.set(clip.id, group);
  }
  return { groups: [...groups.values()], empty: [...empty.values()] };
}

/**
 * 校验判官写的一批结论，全部对得上才存（不存半批）：编号是这一批里的，分数是 0–5 的整数，问题在这一类能挑的里面。
 * @param {{ id: string, score: number, problems: string[], note: string }[]} verdicts
 * @param {object[]} groups pendingJudgements 导出的那一批
 * @param {keyof typeof KINDS} [kind] 这一批判的是什么
 * @returns {number} 存了几格
 */
export function recordJudgements(results, verdicts, groups, kind = "transcript") {
  const allowed = KINDS[kind].problems;
  const items = new Map(groups.flatMap((group) => group.items.map((item) => [item.id, { group, item }])));
  const seen = new Set();
  const problems = [];
  for (const [index, verdict] of verdicts.entries()) {
    const where = `第 ${index + 1} 条（${verdict?.id}）`;
    if (!items.has(verdict?.id)) problems.push(`${where}：这一批里没有这个编号`);
    else if (seen.has(verdict.id)) problems.push(`${where}：编号重复`);
    seen.add(verdict?.id);
    if (!Number.isInteger(verdict?.score) || verdict.score < 0 || verdict.score > 5)
      problems.push(`${where}：分数要是 0–5 的整数`);
    if (!Array.isArray(verdict?.problems) || verdict.problems.some((p) => !allowed.includes(p))) {
      problems.push(`${where}：problems 只能从 ${allowed.join("、")} 里挑`);
    }
    if (typeof verdict?.note !== "string" || verdict.note.trim() === "") problems.push(`${where}：note 不能是空的`);
  }
  if (problems.length > 0) throw new Error(`判分结论没有存，有 ${problems.length} 处不对：\n${problems.join("\n")}`);
  for (const verdict of verdicts) {
    const { group, item } = items.get(verdict.id);
    results.put("judge", item.key, {
      clip: group.clip,
      subject: item.candidates.join(","),
      output: { kind, score: verdict.score, problems: verdict.problems, note: verdict.note, by: JUDGE.by },
    });
  }
  return verdicts.length;
}

/** 空的转写、空的成品直接记 0 分，不用判官看 */
export function recordEmpty(results, empty, kind = "transcript") {
  for (const { key, clip, candidates } of empty) {
    results.put("judge", key, {
      clip,
      subject: candidates.join(","),
      output: { kind, score: 0, problems: ["认不出"], note: `${KINDS[kind].label}是空的`, by: "rule" },
    });
  }
  return empty.length;
}
