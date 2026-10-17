import { costOf, storageCostOf } from "./prices/gemini.mjs";

// Gemini 的提示词缓存（显式缓存）。每次整理都要带上同一份 1350 个 token 的提示词，它占了一次听写八成多的钱；
// 缓存起来以后，提示词那部分只收一成的价，代价是建的时候按标准输入价收一次、存着按小时收存储费。
// 隐式缓存用不上：3.6 Flash 要提示词前缀至少 4096 个 token 才会命中（官方缓存文档），我们的不到一半。
//
// 用法跟着人说话的节奏走：开口说话时建好（已经有了就往后续），说完整理时带上它；30 分钟没人说话它自己过期，
// 不再收存储费。缓存只是省钱，任何一步出岔子都退回不带缓存的请求，不耽误这一句话。

/**
 * 缓存放多久：每次开口都从那时起往后续这么久。拿作者在原版上 126 天、3169 次听写的时间间隔模拟过
 * （提示词那部分的钱）：5 分钟省 45%，15 分钟省 57%，30 分钟省 61%，60 分钟省 62%。再长省不了多少，
 * 空存着的时间倒是更长
 */
export const CACHE_TTL_SECONDS = 30 * 60;
/** 离过期不到这么久就不用了：一次请求最多等 30 秒，用到一半过期会报错 */
const MARGIN_MS = 60_000;
/** 建、续最多等多久（实测 0.4–0.7 秒）。卡住不回的话"正在建"一直占着，以后就再也建不了 */
const REQUEST_TIMEOUT_MS = 15_000;
const HOUR_MS = 3_600_000;

/** 缓存在 Google 那边已经没了（过期得比算的早、被删了）。实测回 403 "CachedContent not found (or permission denied)" */
export const cacheMissing = (error) => /CachedContent not found/i.test(String(error?.message ?? ""));

/**
 * @param {object} options
 * @param {{ create(params: object): Promise<object>, update(params: object): Promise<object> }} options.caches SDK 的 caches
 * @param {string} options.model
 * @param {() => Date} options.now
 * @param {{ info: Function, warn: Function }} options.log
 */
export function createPromptCache({ caches, model, now, log }) {
  /** 建好的那个：{ name, systemPrompt, model, tokens, expiresAt }；没有是 null */
  let cache = null;
  /** 这个型号建不了显式缓存（比如 4 Argon 起只有隐式的）：不再试 */
  let unsupported = false;
  /** 正在建或者正在续：同时开口两次只建一个 */
  let preparing = null;

  const usable = (systemPrompt) =>
    cache !== null && cache.systemPrompt === systemPrompt && cache.expiresAt - now().getTime() > MARGIN_MS;

  /** 回话里的过期时间；读不出来就按本地算 */
  const expiryOf = (reply, at) => {
    const parsed = Date.parse(reply?.expireTime ?? "");
    return Number.isNaN(parsed) ? at.getTime() + CACHE_TTL_SECONDS * 1000 : parsed;
  };

  /** 只有钱、没有 token 用量的一笔 */
  const charge = (billed, inputTokens, costUsd) => ({
    model: billed,
    inputTokens,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    costUsd,
  });

  async function create(systemPrompt) {
    let created;
    try {
      created = await caches.create({
        model,
        config: {
          systemInstruction: systemPrompt,
          ttl: `${CACHE_TTL_SECONDS}s`,
          abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      });
    } catch (error) {
      // 4xx（限流除外）：这个型号建不了，或者它不收这份提示词，再试也一样。没网、它那边出状况的，下次开口再试
      if (error?.status >= 400 && error.status < 500 && error.status !== 429) {
        unsupported = true;
        log.warn("prompt_cache_unsupported", { model, status: error.status });
      }
      throw error;
    }
    const at = now();
    const billed = created.model?.replace(/^models\//, "") || model;
    const tokens = created.usageMetadata?.totalTokenCount ?? 0;
    cache = { name: created.name, systemPrompt, model: billed, tokens, expiresAt: expiryOf(created, at) };
    log.info("prompt_cache_created", { model: billed, tokens, expires_at: new Date(cache.expiresAt).toISOString() });
    // 建的时候按标准输入价收一次（Vertex AI 的缓存文档这么写；Gemini API 的文档没说，按同样的算），
    // 再加上这次买下的存储时长。存储按设的时长收（删早了也不退，社区里这么说，没验证），所以记的是买下的那一段
    const input = costOf(billed, { text: tokens, audio: 0, cachedText: 0, cachedAudio: 0, output: 0 }, at);
    const storage = storageCostOf(billed, tokens, (cache.expiresAt - at.getTime()) / HOUR_MS, at);
    return { usage: charge(billed, tokens, input === null || storage === null ? null : input + storage) };
  }

  async function extend(systemPrompt) {
    const current = cache;
    let updated;
    try {
      updated = await caches.update({
        name: current.name,
        config: { ttl: `${CACHE_TTL_SECONDS}s`, abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
      });
    } catch (error) {
      if (!cacheMissing(error)) throw error;
      log.warn("prompt_cache_missing", { when: "extend" });
      cache = null;
      return create(systemPrompt);
    }
    const at = now();
    const expiresAt = expiryOf(updated, at);
    // 记的是多买的那一段：从原来的过期时间续到新的过期时间
    const hours = Math.max(0, expiresAt - current.expiresAt) / HOUR_MS;
    current.expiresAt = expiresAt;
    return { usage: charge(current.model, 0, storageCostOf(current.model, current.tokens, hours, at)) };
  }

  return {
    /**
     * 开口说话时调：没有就建，有就往后续。
     * @returns {Promise<{ usage: object } | null>} 这一次花的钱（建缓存或者多存的那一段）；没做什么时是 null
     *   （这个型号建不了，或者正在建）。出错就抛，调用方记一笔警告，不耽误听写
     */
    prepare(systemPrompt) {
      if (unsupported || preparing) return Promise.resolve(null);
      preparing = (usable(systemPrompt) ? extend(systemPrompt) : create(systemPrompt)).finally(() => {
        preparing = null;
      });
      return preparing;
    },

    /** 整理时能用的缓存名字；提示词不一样、快过期了、还没建好的，是 null */
    nameFor(systemPrompt) {
      return usable(systemPrompt) ? cache.name : null;
    },

    /** 用的时候发现它已经没了：丢掉，下次开口重新建 */
    forget(name) {
      if (cache?.name === name) cache = null;
      log.warn("prompt_cache_missing", { when: "generate" });
    },
  };
}
