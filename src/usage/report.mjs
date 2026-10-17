// 用量报表：今天、本月、累计各调了几次模型、多少 token、花了多少钱、模型一般多久回话，每一段再按型号分开。
// 命令行（draftless usage）和主窗口首页用的是同一份。数据是历史库里的账（src/storage/history.mjs 的 usage），
// 钱是按官方标准价估算的美元（src/server/providers/prices）。本机转写那一跳也有一笔（provider 是 local），不花钱。

import { findModel, makerOf } from "../models/catalog.mjs";
import { findVendor } from "../server/vendors.mjs";

/** 从快到慢排好的一串数里取第 p 分位（最近秩法：至少 p 那么多的数不比它大）。空的是 null */
export function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

/**
 * 一段时间的汇总 → 报表里的一项：加上 token 合计；每次听写等了多久，换成一般多久（中位数）、慢的时候多久
 * （九成都比它快）。还没听写过的是 null，不是 0 秒
 */
function summarize({ latenciesMs, models: _models, ...totals }) {
  return {
    ...totals,
    tokens: totals.inputTokens + totals.outputTokens,
    latency:
      latenciesMs.length === 0 ? null : { medianMs: percentile(latenciesMs, 0.5), p90Ms: percentile(latenciesMs, 0.9) },
  };
}

/**
 * 一个型号是谁：name 给人看的名字（云上的是那一家的名字，型号另在 model 里；本机的是模型的名字），
 * icon 按哪家取图标（renderer/shared/provider-icons.mjs），local 是不是本机转写的那一跳。
 * 清单里已经没有的本机模型、不认识的那家，照 id 说
 */
function whoIs({ provider, model }) {
  if (provider === "local") {
    const found = findModel(model);
    return { name: found?.name ?? model, icon: found ? makerOf(found) : null, local: true };
  }
  return { name: findVendor(provider)?.name ?? provider, icon: provider, local: false };
}

/** 一段时间 → 报表里的一项，连同按型号分开的几行（花得多的在前） */
function period(usage) {
  return {
    ...summarize(usage),
    models: usage.models.map((row) => ({ ...summarize(row), ...whoIs(row) })),
  };
}

/**
 * @param {{ usage(range?: { since?: string }): object }} history 打开着的历史库
 * @param {{ now: Date }} options 今天、本月按本机的时区算
 * @returns {{ today: object, month: object, total: object, models: object[] }} models 是累计的按型号分开（同 total.models）
 */
export function usageReport(history, { now }) {
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const firstOfMonth = new Date(midnight);
  firstOfMonth.setDate(1);
  const total = period(history.usage());
  return {
    today: period(history.usage({ since: midnight.toISOString() })),
    month: period(history.usage({ since: firstOfMonth.toISOString() })),
    total,
    models: total.models,
  };
}
