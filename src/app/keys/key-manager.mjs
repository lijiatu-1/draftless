import { LocalizedError, msg, problemOf } from "../../i18n/index.mjs";
import { keyVendorOf } from "../../server/modes.mjs";
import { toModelError } from "../../server/providers/errors.mjs";
import { apiKeyProblem, DEFAULT_THINKING_LEVEL, findProvider } from "../../server/providers/index.mjs";
import { findVendor } from "../../server/vendors.mjs";

const MISSING = { state: "missing", source: null, problem: null };

/**
 * 每家模型各有一把 key。这次运行用的是哪一家（provider）由正在走的路线定：native 模式是收音频的那家，
 * local 模式是润色的那家（server/modes.mjs 的 keyVendorOf）。它的那把 key 现在是什么状态、
 * 启动时去哪找、怎么换、怎么删，都走这里；别家的 key 也在这里存、删、拿去检查，但不影响正在用的。
 * 换路线（切模式、换模型）也走这里的 use：新路线要的那家的 key 验证过才换，这是唯一的一处。
 *
 * 状态（current，只说正在用的那一家）里的几项：
 *   state     missing（没有）/ unreadable（存着但解不开）/ checking / rejected / ready
 *   source    env（环境变量，比如 GEMINI_API_KEY）/ stored（加密存着的）/ external（key 在单独启动的服务端那边）
 *   problem   给用户看的一句原因：一句还没定语言的话（msg），模型回的原话是一段字，由显示它的那一端翻
 *   cause     只在 rejected 时有：key（这把 key 不对）/ other（那一家拒绝了请求，多半是模型名或思考档位）
 *   verified  只在 ready 时有：false 表示启动时够不着那一家（没网，或者它一时不可用），先用着，还没验证
 *
 * @param {object} options
 * @param {{ useKey: Function, verify: Function, forgetKey: Function, probe: Function } | null} options.service
 *   内置的听写服务；连的是单独启动的服务端时为 null，key 归那边管
 * @param {{ id: string, name: string, keyEnv: string }} options.provider 一开始用的那一家（server/vendors.mjs）。
 *   之后可以改用别家（use），不写厂商的存、删、检查说的都是正在用的那家
 * @param {(id: string) => object} [options.routeFor] 给不是正在用的那一家存 key 时，拿哪条路线验证。
 *   不写就是那家（收音频的）的默认模型走 native 模式
 * @param {Record<string, { load(): string | null, save(key: string): void, clear(): void }>} options.keyStores
 *   每家一个，按 id 找
 * @param {Record<string, string | undefined>} options.env
 * @param {{ info: Function, error: Function }} options.log
 * @param {() => void} options.onChange 状态每变一次调一次
 */
export function createKeyManager({
  service,
  provider: initialProvider,
  keyStores,
  env,
  log,
  onChange,
  routeFor = nativeRouteFor,
}) {
  /** 正在用的那一家 */
  let provider = initialProvider;
  let current = MISSING;
  /** 正在用的那家这次运行实际在用的那把 key（检查它时要用同一把）；没有时是 null */
  let inUse = null;
  /** 排在最后的那件事做完的时候。只用来排队，不带结果也不带错误 */
  let queue = Promise.resolve();
  let reverifying = false;

  /**
   * 换 key、删 key 一件一件来。验证一把 key 要等那一家回话，这期间又来一件的话排在后面：
   * 否则先来的后到，会把后来的盖掉（比如验证途中点了删除，验证回来又把它启用了）。
   */
  function enqueue(task) {
    const result = queue.then(task);
    // 一件事出了错由它自己的调用方处理，不连累排在后面的
    queue = result.catch(() => {});
    return result;
  }

  function become(next) {
    current = next;
    onChange();
    return current;
  }

  /** 服务报上来的错。不是模型层分好类的（多半是 bug）也照样能说，key 先抹掉 */
  const described = (error, apiKey, who = provider) => {
    const modelError = toModelError(error, { provider: who, apiKey });
    return { cause: modelError.kind, problem: modelError.problem, detail: modelError.detail };
  };

  function reject(source, cause, problem, detail) {
    // detail 是抹掉 key 之后的报错原文
    log.error("key_rejected", { provider: provider.id, source, cause, error: detail.slice(0, 300) });
    return become({ state: "rejected", source, problem, cause });
  }

  /** 按 id 找到那一家和它的 key 存放处。不认识就抛错 */
  function lookup(id) {
    const found = findVendor(id);
    if (!found || !keyStores[found.id]) throw new LocalizedError(msg("key.unknownProvider", { id }));
    return { found, store: keyStores[found.id] };
  }

  /**
   * 拿一把 key 去验证，通过了才开始用。不抛错。
   * @param {{ atStartup: boolean, allowUnverified?: boolean, target?: object, route?: object }} options
   *   atStartup：启动时只是够不着的话照样启用，没通过就是不能用；换一把时没通过的话服务里原来那把还在用，
   *   状态也回到原来的。allowUnverified：够不着时照样启用，默认同 atStartup（换用存着的那把时也要）。
   *   route：连路线一起换，target 是它要的那一家；通过了才换
   * @returns {Promise<null | { cause: string, problem: object | string }>} 通过了是 null，没通过是原因
   */
  function adopt(apiKey, source, { atStartup, allowUnverified = atStartup, target = null, route = null }) {
    return enqueue(async () => {
      // 排到自己了再记"原来的状态"：排队期间前一把可能刚验完、或者已经换过一家
      const previous = current;
      const switching = target !== null && target.id !== provider.id;
      const who = switching ? target : provider;
      become({ state: "checking", source, problem: null });
      try {
        const { verified } = await service.useKey(apiKey, { allowUnverified, ...(route ? { route } : {}) });
        if (switching) {
          log.info("provider_switched", { from: provider.id, to: target.id });
          provider = target;
        }
        inUse = { apiKey, source };
        log.info("key_ready", { provider: provider.id, source, verified });
        become({ state: "ready", source, problem: null, verified });
        return null;
      } catch (error) {
        const { cause, problem, detail } = described(error, apiKey, who);
        if (atStartup) reject(source, cause, problem, detail);
        else {
          log.error("key_rejected", { provider: who.id, source, cause, error: detail.slice(0, 300) });
          become(previous);
        }
        return { cause, problem };
      }
    });
  }

  /** 给不是正在用的那一家存 key：走给定的路线（没给就是 routeFor 给的）验证一次，通过了再存。不碰正在用的 */
  function saveForOther(found, store, apiKey, route) {
    return enqueue(async () => {
      try {
        await service.probe({ route: route ?? routeFor(found.id), apiKey });
      } catch (error) {
        const { cause, problem, detail } = described(error, apiKey);
        log.error("key_rejected", { provider: found.id, source: "stored", cause, error: detail.slice(0, 300) });
        return { ok: false, problem };
      }
      return storeKey(store, apiKey);
    });
  }

  function storeKey(store, apiKey) {
    try {
      store.save(apiKey);
    } catch (error) {
      // 验证过了但存不下来：正在用的话这次运行照样能用，下次启动要重填，如实告诉用户
      log.error("key_save_failed", { error: String(error?.message ?? error) });
      return { ok: false, problem: msg("key.notSaved", { reason: problemOf(error) }) };
    }
    return { ok: true };
  }

  /** 那一家这次该用哪把 key：环境变量优先（从终端临时给一把时用），其次是存着的。读不出来会抛错 */
  function keyFor(found, store) {
    const fromEnv = env[found.keyEnv]?.trim();
    if (fromEnv) return { apiKey: fromEnv, source: "env" };
    const stored = store.load();
    return stored ? { apiKey: stored, source: "stored" } : null;
  }

  /** 一把刚填的 key：去掉首尾空白；空的、样子不对的直接说原因（不交给服务） */
  function typed(value) {
    if (typeof value !== "string" || value.trim() === "") return { problem: msg("key.empty") };
    const apiKey = value.trim();
    const shape = apiKeyProblem(apiKey);
    return shape ? { problem: shape } : { apiKey };
  }

  return {
    get current() {
      return current;
    },

    /** 正在用的那一家 */
    get provider() {
      return provider;
    },

    /**
     * 启动时给正在用的那一家找 key。
     * 只是够不着的话照样启用：存着的那把当初验证过才存的，不该因为开机时没网就让人重新填。
     */
    async loadAtStartup() {
      if (!service) return become({ state: "ready", source: "external", problem: null });

      let found;
      try {
        found = keyFor(provider, keyStores[provider.id]);
      } catch (error) {
        // 密文是别的用户、别的机器加的（DPAPI 按用户加密）时会这样，只能请用户重新填
        log.error("key_unreadable", { provider: provider.id, error: String(error?.message ?? error) });
        return become({ state: "unreadable", source: "stored", problem: msg("key.unreadable") });
      }
      if (!found) return current;
      const { apiKey, source } = found;
      const shape = apiKeyProblem(apiKey);
      if (shape) return reject(source, "key", shape, "样子不对，没有拿去验证");
      await adopt(apiKey, source, { atStartup: true });
      return current;
    },

    /**
     * 验证并保存一把新的 key。没通过时原因在返回值里，原来的状态不变。
     * @param {unknown} value
     * @param {{ provider?: string, route?: object }} [options] provider：给哪一家存，默认是正在用的那一家。
     *   route：给别家存时拿哪条路线验证，不写就是 routeFor 给的（要换成某家的某个模型、先存它的 key 时用）
     * @returns {Promise<{ ok: true } | { ok: false, problem: object | string }>}
     */
    async save(value, { provider: id = provider.id, route } = {}) {
      if (typeof value !== "string" || value.trim() === "") return { ok: false, problem: msg("key.empty") };
      if (!service) return { ok: false, problem: msg("key.external") };
      let target;
      try {
        target = lookup(id);
      } catch (error) {
        return { ok: false, problem: problemOf(error) };
      }
      const { apiKey, problem } = typed(value);
      if (problem) return { ok: false, problem };

      if (target.found.id !== provider.id) return saveForOther(target.found, target.store, apiKey, route);
      const failure = await adopt(apiKey, "stored", { atStartup: false });
      if (failure) return { ok: false, problem: failure.problem };
      return storeKey(target.store, apiKey);
    },

    /**
     * 换一条路线（切模式、换模型都是它）：拿新路线要的那家的 key 验证过才换。没通过就什么都不变。
     * 路线由调用方按各自那一层拼好（app/modes.mjs），设置也由调用方去改：这里只管这次运行走哪条、用哪把。
     * @param {{ route: object, key?: string }} options key：顺带填的一把新的，验证过才存；
     *   不写就用那一家现有的：还是正在用的那家就是手里这把，否则环境变量优先、其次存着的。
     *   存着的那把当初验证过，换用时只是够不着也照样换
     * @returns {Promise<{ ok: true } | { ok: false, problem: object | string }>}
     */
    async use({ route, key: value } = {}) {
      if (!service) return { ok: false, problem: msg("key.externalModel") };
      let target;
      try {
        target = lookup(keyVendorOf(route).id);
      } catch (error) {
        return { ok: false, problem: problemOf(error) };
      }
      const { found, store } = target;
      if (value !== undefined) {
        const { apiKey, problem } = typed(value);
        if (problem) return { ok: false, problem };
        const failure = await adopt(apiKey, "stored", { atStartup: false, target: found, route });
        return failure ? { ok: false, problem: failure.problem } : storeKey(store, apiKey);
      }
      let key;
      try {
        key = found.id === provider.id && inUse ? inUse : keyFor(found, store);
      } catch (error) {
        log.error("key_unreadable", { provider: found.id, error: String(error?.message ?? error) });
        return { ok: false, problem: msg("key.unreadableFor", { provider: found.name }) };
      }
      if (!key) return { ok: false, problem: msg("key.noKeyFor", { provider: found.name }) };
      const shape = apiKeyProblem(key.apiKey);
      if (shape) return { ok: false, problem: shape };
      const failure = await adopt(key.apiKey, key.source, {
        atStartup: false,
        allowUnverified: true,
        target: found,
        route,
      });
      return failure ? { ok: false, problem: failure.problem } : { ok: true };
    },

    /** @param {{ provider?: string }} [options] 删哪一家的，默认是正在用的那一家 */
    forget({ provider: id = provider.id } = {}) {
      return enqueue(() => {
        const { found, store } = lookup(id);
        store.clear();
        log.info("key_forgotten", { provider: found.id });
        if (!service || found.id !== provider.id) return;
        service.forgetKey();
        inUse = null;
        become(MISSING);
      });
    },

    /**
     * 某条路线现在能不能用：拿它要的那家的 key 发一个最小的请求。不抛错，不改变正在用的。
     * @param {object} route server/modes.mjs 说的路线
     * @returns {Promise<{ ok: true, source: string, ms: number } | { ok: false, cause: string, problem: object | string }>}
     *   cause：missing（没有这家的 key）/ unreadable / key / unavailable / other
     */
    async check(route) {
      if (!service) return { ok: false, cause: "other", problem: msg("key.externalModel") };
      let target;
      try {
        target = lookup(keyVendorOf(route).id);
      } catch (error) {
        return { ok: false, cause: "other", problem: problemOf(error) };
      }
      const { found, store } = target;
      let key;
      try {
        // 正在用的那家：查这次运行实际在用的那把（中途存过新的，就不是环境变量里那把了）
        key = found.id === provider.id && inUse ? inUse : keyFor(found, store);
      } catch (error) {
        log.error("key_unreadable", { provider: found.id, error: String(error?.message ?? error) });
        return { ok: false, cause: "unreadable", problem: msg("key.unreadableFor", { provider: found.name }) };
      }
      if (!key) {
        return { ok: false, cause: "missing", problem: msg("key.noKeyForCli", { provider: found.name, id: found.id }) };
      }
      const shape = apiKeyProblem(key.apiKey);
      if (shape) return { ok: false, cause: "key", problem: shape };
      const startedAt = performance.now();
      try {
        await service.probe({ route, apiKey: key.apiKey });
      } catch (error) {
        const { cause, problem, detail } = described(error, key.apiKey);
        log.warn("model_check_failed", { provider: found.id, cause, error: detail.slice(0, 300) });
        return { ok: false, cause, problem };
      }
      const ms = Math.round(performance.now() - startedAt);
      log.info("model_checked", { provider: found.id, source: key.source, ms });
      return { ok: true, source: key.source, ms };
    },

    /**
     * 每家的 key 在哪：env（环境变量）/ stored（存着的）/ null（没有）。不解密，给命令行列模型用：
     * 装成应用的那个各存各的，命令行从文件看不到它的
     * @returns {Record<string, "env" | "stored" | null>}
     */
    sources() {
      return Object.fromEntries(
        Object.entries(keyStores).map(([id, store]) => {
          const { keyEnv } = findVendor(id);
          return [id, env[keyEnv]?.trim() ? "env" : store.exists() ? "stored" : null];
        }),
      );
    },

    /** 启动时够不着那一家、还没验证的那把，再验一次。别的情况什么都不做 */
    async reverify() {
      const checked = current;
      if (reverifying || checked.state !== "ready" || checked.verified !== false) return;
      reverifying = true;
      try {
        await service.verify();
        if (current !== checked) return;
        log.info("key_ready", { provider: provider.id, source: checked.source, verified: true });
        become({ ...checked, verified: true });
      } catch (error) {
        const { cause, problem, detail } = described(error);
        // 还是够不着就继续先用着；期间状态被别处换过（比如存了一把新的）也不再插手
        if (cause === "unavailable" || current !== checked) return;
        service.forgetKey();
        inUse = null;
        reject(checked.source, cause, problem, detail);
      } finally {
        reverifying = false;
      }
    },
  };
}

/** 不说走哪条路线时：那家（收音频的）的默认模型走原生链路 */
function nativeRouteFor(id) {
  const provider = findProvider(id);
  if (!provider) throw new LocalizedError(msg("key.unknownProvider", { id }));
  return {
    mode: "native",
    model: { provider: provider.id, model: provider.defaultModel },
    thinkingLevel: provider.thinkingLevels ? DEFAULT_THINKING_LEVEL : null,
  };
}
