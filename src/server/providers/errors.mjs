// 模型那边出的错，统一分成三类，调用方按类别决定怎么办，不用认识每家的报错长什么样：
//   key          这把 key 不对（无效、没额度、没权限）：换一把能解决
//   unavailable  暂时够不着（没网、超时、它那边出状况或限流）：和 key、设置都没关系，过一会儿再试
//   other        它拒绝了这个请求（多半是模型名、档位写错），或者录音有问题
// problem 是给用户看的一句话：一句还没定语言的话（msg，由显示它的那一端翻），认不得的报错就是截短了的原文；
// 句尾不带标点，后面常要接别的话。detail 是抹掉 key 之后的原文，留给日志，也是 message。

import { msg } from "../../i18n/index.mjs";

const PROBLEM_MAX_LENGTH = 200;

export class ModelError extends Error {
  /**
   * @param {{ kind: "key" | "unavailable" | "other", problem: object | string, detail: string, origin?: string }} fields
   *   origin：原始报错的调用栈（已抹掉 key），只进日志。适配器或解码自己出了 bug 时靠它找出处
   */
  constructor({ kind, problem, detail, origin }) {
    super(detail);
    this.name = "ModelError";
    this.kind = kind;
    this.problem = problem;
    this.detail = detail;
    this.origin = origin;
  }
}

/** 连接层面断掉的几种：没连上、连上了又被重置、响应读到一半断了（undici 报 "terminated"） */
const DROPPED = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETUNREACH|UND_ERR_)/;
const unreachable = (error, detail) =>
  error?.name === "AbortError" ||
  /fetch failed|^terminated$/.test(detail) ||
  DROPPED.test(error?.code ?? error?.cause?.code ?? "");

/**
 * 任意一个错误 → ModelError。先认够不着的情况（各家都一样），再交给那一家的适配器认它自己的报错，
 * 都不认得就把原话截短了给人看。
 * @param {unknown} error
 * @param {object} context
 * @param {{ name: string }} context.provider
 * @param {string} [context.apiKey] 当时用的那把：报错里带着它的话先抹掉
 * @param {(error: unknown, detail: string) => { kind: string, problem: object | string } | null} [context.classify]
 */
export function toModelError(error, { provider, apiKey, classify }) {
  if (error instanceof ModelError) return error;
  const scrub = (text) => (apiKey ? text.replaceAll(apiKey, "（key）") : text);
  const detail = scrub(String(error?.message ?? error));
  const origin = error?.stack ? scrub(String(error.stack)) : undefined;
  const make = (fields) => new ModelError({ ...fields, detail, origin });
  // 超时单独说：网是通的，是它太久没回话（长录音交给 OpenAI 时，上传加处理可能就这么久）
  if (error?.name === "TimeoutError") {
    return make({ kind: "unavailable", problem: msg("model.timeout", { provider: provider.name }) });
  }
  if (unreachable(error, detail)) {
    return make({ kind: "unavailable", problem: msg("model.unreachable", { provider: provider.name }) });
  }
  const specific = classify?.(error, detail);
  if (specific) return make(specific);
  // 我们自己说得清的（录音解不出声音这类），照它说的
  if (error?.problem) return make({ kind: "other", problem: error.problem });
  return make({ kind: "other", problem: detail.slice(0, PROBLEM_MAX_LENGTH) });
}

/** 把模型回的一句话收拾成能接在别的话后面的样子：去掉句尾的句号和空白，截短 */
export const quote = (said) =>
  String(said ?? "")
    .replace(/[.。\s]+$/, "")
    .slice(0, 160);
