import { msg, problemOf } from "../i18n/index.mjs";
import { downloadSize, findModel } from "../models/catalog.mjs";
import { sizeText } from "../models/describe.mjs";
import { speechSample } from "../server/asr/probe.mjs";
import { findChatVendor } from "../server/chat/vendors.mjs";
import { describeRoute } from "../server/modes.mjs";
import { findProvider } from "../server/providers/index.mjs";
import {
  MODE_SETTINGS,
  overridingEnv,
  patchSettings,
  resolveSettings,
  routeOf,
  saveSetting,
} from "../storage/settings.mjs";

// 识别模式的状态机。状态是"正在用哪种模式"（service.route.mode），和那种模式里选的模型：
//
//   native ──switchMode("local", 第二跳等)──▶ local
//     │  ◀──switchMode("native", 模型等)──     │
//     └ setModel        换收音频的模型         ├ setTranscriber  第一跳：本机转写模型，不用 key，要下载好了的
//                                              └ setPolish       第二跳：润色的厂商和模型（自定义服务连同地址）
//
// 两种模式要换的东西不一样，各走各的路：模型只能在它那种模式里换，不在那种模式时换是错的（没法选），
// 直接说出来，不悄悄存下。第一次进 local 时还没法换第二跳，所以切模式时可以连带那种模式自己的设置
// （storage/settings.mjs 的 MODE_SETTINGS），比如没有 DeepSeek 的 key、要直接用自定义服务的人。
// 每一步都先按改后的设置拼出路线（routeOf），要的那家的 key 验证过（keys/key-manager.mjs 的 use）才换、才写设置；
// 没通过就什么都不变，还是原来能用的那个。local 要的本机模型也一样：没下载好就不换（下载由用户点，models/library.mjs），
// 正在用的本机模型不能删。

/**
 * @param {object} options
 * @param {{ route: object, switchTranscriber(model: string): void, checkTranscriber: Function }} options.service
 *   内置的听写服务（service.mjs）
 * @param {{ use: Function, check: Function }} options.keys key 管理（keys/key-manager.mjs）
 * @param {{ isInstalled(id: string): boolean, remove(id: string): object }} options.models 本机的模型库（models/library.mjs）
 * @param {string} options.settingsFile
 * @param {Record<string, string | undefined>} options.env
 * @param {{ info: Function, warn: Function }} options.log
 * @param {typeof speechSample} [options.speech] 检查本机模型时念的那句（asr/probe.mjs）；测试时换成假的
 */
export function createModeSwitch({ service, keys, models, settingsFile, env, log, speech = speechSample }) {
  /** 一件一件来：前一件还在验证时又来一件，后一件要看到前一件换好的模式和存好的设置 */
  let queue = Promise.resolve();
  const serial = (task) => {
    const run = queue.then(task);
    queue = run.catch(() => {});
    return run;
  };

  const read = () => resolveSettings({ file: settingsFile, env });

  /**
   * 写进设置文件。写不下去时这次运行照样换了，如实说下次启动不会记得；
   * 被环境变量盖着时说下次启动会被盖掉
   * @returns {{ note?: object }}
   */
  function save(changes) {
    for (const [name, value] of Object.entries(changes)) {
      try {
        saveSetting(settingsFile, name, value);
      } catch (error) {
        return { note: msg("notes.settingNotSaved", { name, reason: problemOf(error) }) };
      }
    }
    const variable = Object.keys(changes)
      .map((name) => overridingEnv(name, env))
      .find((found) => found !== null);
    return variable ? { note: msg("notes.envNextLaunch", { variable }) } : {};
  }

  /**
   * 在某种模式里换它的模型：不在那种模式时不换，说要先切过去；在的话按改后的设置换路线（apply 去换）。
   * @param {string} mode
   * @param {string} what 换的是什么（modes.what.*），报错时说
   * @param {Record<string, string>} changes
   * @param {(route: object) => Promise<{ ok: boolean, problem?: object }>} apply
   */
  function within(mode, what, changes, apply) {
    return serial(async () => {
      const current = service.route.mode;
      if (current !== mode) {
        return { ok: false, problem: msg("modes.notIn", { current, mode, what: msg(`modes.what.${what}`) }) };
      }
      let route;
      try {
        route = routeOf(patchSettings(read(), changes), mode);
      } catch (error) {
        return { ok: false, problem: problemOf(error) };
      }
      const result = await apply(route);
      if (!result.ok) return result;
      log.info("route_changed", { route: describeRoute(route), settings: Object.keys(changes) });
      return { ok: true, ...save(changes) };
    });
  }

  /** 换成这条路线，要的那家的 key 验证过才换 */
  const useRoute = (route) => keys.use({ route });

  /** local 的路线要的本机模型下载好了没有：没有就说先下载哪个、多大 */
  function notDownloaded(route) {
    if (route.mode !== "local" || models.isInstalled(route.transcriber)) return null;
    const model = findModel(route.transcriber);
    return {
      ok: false,
      problem: msg("modes.notDownloaded", { model: model.name, size: sizeText(downloadSize(model)) }),
    };
  }

  return {
    /**
     * 换模式。可以连带那种模式自己的设置一起换（只能是 MODE_SETTINGS[mode] 里的几项），一起验证、一起存
     * @param {string} mode
     * @param {Record<string, string>} [changes]
     */
    switchMode(mode, changes = {}) {
      return serial(async () => {
        let wanted;
        let route;
        try {
          wanted = patchSettings(read(), { mode }).mode.value;
          const foreign = Object.keys(changes).find((name) => !MODE_SETTINGS[wanted].includes(name));
          if (foreign) {
            return {
              ok: false,
              problem: msg("modes.notOfMode", {
                name: foreign,
                mode: wanted,
                names: MODE_SETTINGS[wanted].join(" / "),
              }),
            };
          }
          route = routeOf(patchSettings(read(), { mode: wanted, ...changes }), wanted);
        } catch (error) {
          return { ok: false, problem: problemOf(error) };
        }
        const from = service.route.mode;
        // 已经是这条路线（切到正在用的模式、没带别的）：不用再验证
        if (JSON.stringify(route) !== JSON.stringify(service.route)) {
          const missing = notDownloaded(route);
          if (missing) return missing;
          const result = await useRoute(route);
          if (!result.ok) return result;
        }
        if (from !== wanted) log.info("mode_switched", { from, to: wanted, route: describeRoute(route) });
        return { ok: true, ...save({ mode: wanted, ...changes }) };
      });
    },

    /** native 里换收音频的厂商和模型，写法同设置里的 model（厂商、厂商/模型） */
    setModel(model) {
      return within("native", "model", { model }, useRoute);
    },

    /** local 第一跳：本机的转写模型，要下载好了的。不用 key：润色那一跳照旧，服务只换模型（没装好的话重新装） */
    setTranscriber(transcriber) {
      return within("local", "transcriber", { transcriber }, async (route) => {
        const missing = notDownloaded(route);
        if (missing) return missing;
        service.switchTranscriber(route.transcriber);
        return { ok: true };
      });
    },

    /** 删一个本机模型：正在用的（local 模式的第一跳）不让删，说先换一个或切回 native */
    removeModel(id) {
      return serial(async () => {
        const model = findModel(id);
        if (!model) return { ok: false, problem: msg("localModels.unknown", { id }) };
        if (service.route.mode === "local" && service.route.transcriber === id) {
          return { ok: false, problem: msg("localModels.inUse", { model: model.name }) };
        }
        return models.remove(id);
      });
    },

    /**
     * local 第二跳：润色的厂商和模型，写法同设置里的 polish（厂商、厂商/模型、custom/模型名）
     * @param {string} polish
     * @param {{ customUrl?: string }} [options] 自定义服务的地址，和模型一起验证、一起存
     */
    setPolish(polish, { customUrl } = {}) {
      const changes = customUrl === undefined ? { polish } : { polish, customUrl };
      return within("local", "polish", changes, useRoute);
    },

    /**
     * 检查一个本机模型能不能正常转写：用系统朗读念一句，交给它转。哪种模式里都能查，不换掉正在用的。
     * 不排队：它不改设置，也不换路线
     * @param {string} id
     * @param {{ locale: string }} options 按界面语言念
     * @returns {Promise<{ ok: true, said: string, text: string, transcribeMs: number, loadMs: number | null, backend: string }
     *   | { ok: false, problem: object }>}
     */
    async checkTranscriber(id, { locale }) {
      const model = findModel(id);
      if (!model) return { ok: false, problem: msg("localModels.unknown", { id }) };
      if (!models.isInstalled(id)) {
        return {
          ok: false,
          problem: msg("modes.notDownloaded", { model: model.name, size: sizeText(downloadSize(model)) }),
        };
      }
      let sample;
      try {
        sample = await speech(locale);
      } catch (error) {
        log.warn("probe_speech_failed", { error: String(error?.message ?? error) });
        return { ok: false, problem: msg("localModels.checkNoSpeech", { reason: problemOf(error) }) };
      }
      let result;
      try {
        result = await service.checkTranscriber(id, sample.samples);
      } catch (error) {
        log.warn("transcriber_check_failed", { model: id, error: String(error?.message ?? error) });
        return { ok: false, problem: msg("localModels.checkFailed", { model: model.name, reason: problemOf(error) }) };
      }
      if (result.text.trim() === "") {
        return { ok: false, problem: msg("localModels.checkEmpty", { model: model.name }) };
      }
      return { ok: true, said: sample.said, ...result };
    },

    /**
     * 某一种模式按改后的设置能不能用：拼出路线交给 key 管理去试，不换掉正在用的。
     * 只是试一下，在哪种模式里都能查（切过去之前先看看）
     * @returns {Promise<object>} 同 key-manager 的 check
     */
    async check(mode, changes) {
      let route;
      try {
        route = routeOf(patchSettings(read(), changes), mode);
      } catch (error) {
        return { ok: false, cause: "other", problem: problemOf(error) };
      }
      return keys.check(route);
    },

    /**
     * 给某一家存 key 前拿哪条路线验证：收音频的那家走 native、润色的那家走 local（key-manager 的 routeFor）。
     * 设置里已经选了这家就用设置里的模型，否则用它的默认模型；changes 是要一起换成的（还没存的）设置。
     * 自定义服务没有默认模型：没选过它、changes 里也没给时抛错，说要写成 custom/模型名
     */
    routeForVendor(id, changes = {}) {
      const settings = read();
      if (findProvider(id)) {
        const chosen = routeOf(settings, "native").model.provider === id;
        return routeOf(patchSettings(settings, { model: chosen ? settings.model.value : id, ...changes }), "native");
      }
      if (!findChatVendor(id)) throw new Error(`不认识的厂商：${id}`);
      const chosen = routeOf(settings, "local").polish.vendor === id;
      return routeOf(patchSettings(settings, { polish: chosen ? settings.polish.value : id, ...changes }), "local");
    },
  };
}
