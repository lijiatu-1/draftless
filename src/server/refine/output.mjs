import { Converter } from "opencc-js/t2cn";
import { NO_SPEECH_MARK } from "./prompt.mjs";

// 模型的原始输出 → 要贴出去的文字。两条链路的最后一步都是它：不管成品是听录音写的（原生），
// 还是拿转写出的原文润色的（本地转写），收尾的规矩一样。
// 下面几样都是模型偶尔写坏的地方，提示词里说了也压不住，所以在代码里兜底。
// 数字来自 scripts/dev/eval-prompt.mjs：同一批 60 条真实录音跑了 12 遍，共 720 条成品。

const toSimplified = Converter({ from: "t", to: "cn" });
/**
 * 成品前面多出来的一个外文词（720 条里 14 条，像 "me""thought""get_prompt""особен"）。
 * 它们要么紧贴着后面的汉字，要么单独占一行；他真以英文开头时后面是空格或标点（原版 2853 条成品里只有 1 条例外）。
 */
const LEAKED_PREFIX = /^[A-Za-z_Ѐ-ӿ]+(?:\.?(?=[一-鿿])|[ \t]*\n\s*)/;

/**
 * 没有人声（标记）或没有输出时是空字符串。
 * - 繁转简：提示词里写了"一律写简体字"，模型仍会在一长段话中间冒出"這個"，同一条录音 6 遍里出现 5 遍。
 * - 去掉最后的句号：原版近两个月的成品里，以陈述句收尾的有八成多不带句号，中间各段的句号都在。
 */
export function textFromModelOutput(output) {
  const text = (output ?? "").trim();
  if (text === NO_SPEECH_MARK) return "";
  return toSimplified(text.replace(LEAKED_PREFIX, "")).replace(/。$/, "");
}
