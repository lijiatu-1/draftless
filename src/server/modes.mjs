import { LocalizedError, msg } from "../i18n/index.mjs";
import { findChatVendor, formatChatChoice } from "./chat/vendors.mjs";
import { findProvider, formatModelChoice } from "./providers/index.mjs";
import { createLocalRefiner } from "./refine/local.mjs";
import { createChatPolisher } from "./refine/polisher.mjs";
import { createModelRefiner } from "./refine/refiner.mjs";

// 识别的两种模式，用户在设置里选一种（mode）。两种平级，谁也不是谁的退路：
//   native  原生，一跳：录音直接交给收音频的大模型，一次请求出成品（refine/refiner.mjs）
//   local   本地转写，两跳：本机的小模型先把录音转成原文，再交给任意纯文字大模型润色（refine/local.mjs）
// 两种模式要选的东西不一样：native 选一个收音频的模型；local 第一跳选本地模型、第二跳选润色的厂商和模型。
// 先定模式，再在模式里选模型，各管各的（app/modes.mjs）。
// 装出来的都是同一个接口（warmUp、prepare、refine），服务端只认这个接口。
//
// "路线"（route）写清这一条要用哪些东西，由设置或环境变量拼出来：
//   { mode: "native", model: { provider, model }, thinkingLevel }
//   { mode: "local", transcriber: 本地模型的 id, polish: { vendor, model }, customUrl }
// 本地转写链路的转写器（装着模型的子进程，asr/host.mjs）由调用方装好交进来：它的去留跟着模型走，
// 换一把 key、换一家润色都不该把模型重装一遍。

/** 设置里没写时润色交给谁 */
export const DEFAULT_POLISH = "deepseek";

export const MODES = Object.freeze([
  Object.freeze({
    id: "native",
    /** 要用谁家的 key */
    keyVendor: (route) => findProvider(route.model.provider),
    describe: (route) => formatModelChoice(route.model),
    create: ({ route, apiKey, log, onCall }) =>
      createModelRefiner({ choice: route.model, apiKey, thinkingLevel: route.thinkingLevel, log, onCall }),
  }),
  Object.freeze({
    id: "local",
    keyVendor: (route) => findChatVendor(route.polish.vendor),
    describe: (route) => `${route.transcriber} → ${formatChatChoice(route.polish)}`,
    async create({ route, apiKey, transcriber, log, onCall, decode, fetch }) {
      if (!transcriber) throw new Error(`本地转写链路要先装好转写器（${route.transcriber}）`);
      const polisher = await createChatPolisher({
        choice: route.polish,
        customUrl: route.customUrl,
        apiKey,
        log,
        onCall,
        fetch,
      });
      return createLocalRefiner({
        transcriber,
        polisher,
        log,
        model: route.transcriber,
        onCall,
        ...(decode ? { decode } : {}),
      });
    },
  }),
]);

export const DEFAULT_MODE = "native";

/** @returns {(typeof MODES)[number] | null} 大小写不论 */
export function findMode(id) {
  const wanted = String(id ?? "").toLowerCase();
  return MODES.find((mode) => mode.id === wanted) ?? null;
}

/** 用户写的链路 → 它的 id。写错了就抛 LocalizedError，说能填什么 */
export function parseMode(value) {
  const mode = findMode(String(value ?? "").trim());
  if (!mode) {
    throw new LocalizedError(msg("settings.oneOf", { choices: MODES.map(({ id }) => id).join(" / ") }));
  }
  return mode.id;
}

/** 这条路线要用谁家的 key：{ id, name, keyEnv, keyPage } */
export const keyVendorOf = (route) => findMode(route.mode).keyVendor(route);

/** 一句话说清这条路线，给日志和状态用 */
export const describeRoute = (route) => `${route.mode}: ${findMode(route.mode).describe(route)}`;

/**
 * 按路线装出一个 refiner。
 * @param {object} options
 * @param {object} options.route
 * @param {string} options.apiKey 这条路线要的那家的 key（keyVendorOf）
 * @param {object} [options.transcriber] 本地转写链路要的转写器（asr/host.mjs 的 spawnTranscriber）
 */
export function createModeRefiner(options) {
  return findMode(options.route.mode).create(options);
}
