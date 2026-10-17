import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { findLocale, LOCALES, LocalizedError, msg, problemOf, SYSTEM_LOCALE } from "../i18n/index.mjs";
import { DEFAULT_SOURCE, DEFAULT_TRANSCRIBER, MODELS, SOURCES } from "../models/catalog.mjs";
import { formatChatChoice, normalizeBaseUrl, parseChatChoice } from "../server/chat/vendors.mjs";
import { DEFAULT_MODE, DEFAULT_POLISH, MODES, parseMode } from "../server/modes.mjs";
import {
  DEFAULT_MODEL_CHOICE,
  DEFAULT_THINKING_LEVEL,
  findProvider,
  formatModelChoice,
  parseModelChoice,
} from "../server/providers/index.mjs";
import { DEFAULT_THEME, findTheme, THEMES } from "../themes/index.mjs";

// 用户能改的几项设置，存在数据目录的 settings.json 里。
// 取值的顺序：环境变量（只管这一次运行）优先于文件，文件优先于默认值。key 不在这里，它单独加密保存。

import { HOTKEY_IDS, hotkeyCaveat, normalizeHotkey } from "../platform/hotkeys.mjs";

/**
 * 热键是单独一个修饰键。Windows 上没有 fn，右 Command 换成右 Win；默认右 Alt
 * （也就是 macOS 版那个右 Option 在这里最接近的对应），这样和别的语音输入同时开着也不冲突。
 * 叫什么、在悬浮条上写成什么（hotkeys.<id>.name / keycap）在文案里，按界面语言写。
 */
export { HOTKEY_IDS, hotkeyCaveat };

/** 热键叫什么：一句还没定语言的话 */
export const hotkeyName = (id) => msg(`hotkeys.${id}.name`);
/** 热键写在悬浮条提示里的短名字（那里地方小） */
export const hotkeyKeycap = (id) => msg(`hotkeys.${id}.keycap`);

const THEME_IDS = THEMES.map((theme) => theme.id);
const MODE_IDS = MODES.map((mode) => mode.id);
const TRANSCRIBER_IDS = MODELS.map((model) => model.id);
const SOURCE_IDS = SOURCES.map((source) => source.id);
const THINKING_LEVELS = findProvider("gemini").thinkingLevels;
const LANGUAGES = [SYSTEM_LOCALE, ...LOCALES.map(({ id }) => id)];

const oneOf = (choices) => new LocalizedError(msg("settings.oneOf", { choices: choices.join(" / ") }));

/**
 * 厂商换掉默认模型时，旧的名字 → 现在的名字。
 * 只在启动时用一次（见 migrateSettings），读取设置的路径上没有任何兼容代码。
 */
const MODEL_RENAMES = Object.freeze({
  "qwen/qwen3.8-omni-flash": "qwen/qwen3.5-omni-plus",
});

/**
 * 启动时跑一次：把设置文件里那个旧默认模型换成新默认，**直接写回文件**。
 *
 * 为什么要在启动时改文件、而不是在读设置时判断：`resolveSettings` 是纯函数、一次启动要调十几次，
 * 在那儿塞"这是不是退休的默认值"等于让每次读都背一段历史包袱；而且文件里会永远留着旧值，
 * 用户打开 settings.json 看到的和实际用的不一样。改掉就干净了——之后没有任何兼容代码。
 *
 * 只认**当初确实是默认值**的那几个。用户自己选过的型号（哪怕它慢）不在这儿，不会被悄悄改掉。
 * 幂等：改过一次之后文件里就是新值，再跑什么都不做。
 *
 * @param {string} file 设置文件
 * @returns {boolean} 这次是不是改了
 */
export function migrateSettings(file) {
  let stored;
  try {
    stored = readFile(file);
  } catch {
    // 文件坏了（不是合法 JSON）：留给正常读设置的那一处去报——它知道是哪个键、哪个文件。
    // 迁移只负责"换个名字"，不该改变一个坏文件的报错行为
    return false;
  }
  if (stored.model === undefined) return false;
  let current;
  try {
    current = SETTINGS.model.parse(stored.model);
  } catch {
    // 存的值本身不合法：留给正常的读取去报错，不在这里吞掉
    return false;
  }
  const next = MODEL_RENAMES[current];
  if (next === undefined) return false;
  writeFile(file, { ...stored, model: next });
  return true;
}
/**
 * 每一项：对应的环境变量、默认值、能填的值（不限时为 null）、把写法规整并校验的函数。
 * 这一项是做什么的写在文案里（settings.describe.<名字>），按界面语言写。
 * label 可有可无：值本身不好懂时（right_option、cinnabar）给出它叫什么，是一句话（msg）或者一个名字。
 * legacyEnv 可有可无：改名之前的环境变量，env 没设时照样认（README 里写过，用的人可能还在用）。
 * store 可有可无：规整后的值写进文件时换成什么样子（默认原样）。
 * ofMode 可有可无：这一项属于哪种识别模式（server/modes.mjs），只在那种模式里能换（app/modes.mjs）。
 *   local 的两跳各有各的：transcriber 是第一跳，polish 和 customUrl 是第二跳。
 */
export const SETTINGS = {
  hotkey: {
    env: "DRAFTLESS_HOTKEY",
    default: "right_alt",
    choices: HOTKEY_IDS,
    parse(value) {
      // 旧名字（macOS 版的 right_option、fn 这些）也认，存下来的统一是新名字
      const name = normalizeHotkey(value);
      if (name === null) throw oneOf(HOTKEY_IDS);
      return name;
    },
    // 写错的名字先规整一遍：界面上给一个旧名字时也得说出它是哪个键，不能直接拼出 hotkeys.fn.name
    label: (value) => hotkeyName(normalizeHotkey(value) ?? value),
  },
  mode: {
    env: "DRAFTLESS_MODE",
    // 两条链路平级（server/modes.mjs）。原生是 0.6 以前唯一的一条，没选过的人照旧
    default: DEFAULT_MODE,
    choices: MODE_IDS,
    parse: parseMode,
    label: (value) => msg(`modes.${value}`),
  },
  model: {
    ofMode: "native",
    env: "DRAFTLESS_MODEL",
    // 0.3 以前只有 Gemini，这个环境变量只写模型名
    legacyEnv: "GEMINI_MODEL",
    default: formatModelChoice(DEFAULT_MODEL_CHOICE),
    choices: null,
    parse(value) {
      // 存下来的统一是 厂商/模型。0.3 以前文件里只写 Gemini 的模型名，读的时候照样认（见 parseModelChoice）
      return formatModelChoice(parseModelChoice(value));
    },
    label: (value) => findProvider(parseModelChoice(value).provider).name,
    // Gemini 的照 0.3 的写法只存模型名：退回 0.3 时它把整个值当 Gemini 的模型名用，gemini/… 会让每次请求都失败
    store(value) {
      const { provider, model } = parseModelChoice(value);
      return provider === "gemini" ? model : value;
    },
  },
  thinking: {
    ofMode: "native",
    env: "GEMINI_THINKING_LEVEL",
    default: DEFAULT_THINKING_LEVEL,
    choices: THINKING_LEVELS,
    parse(value) {
      const level = value.toUpperCase();
      if (!THINKING_LEVELS.includes(level)) throw oneOf(THINKING_LEVELS);
      return level;
    },
  },
  transcriber: {
    ofMode: "local",
    env: "DRAFTLESS_TRANSCRIBER",
    default: DEFAULT_TRANSCRIBER,
    choices: TRANSCRIBER_IDS,
    parse(value) {
      const id = value.trim();
      if (!TRANSCRIBER_IDS.includes(id)) throw oneOf(TRANSCRIBER_IDS);
      return id;
    },
  },
  polish: {
    ofMode: "local",
    env: "DRAFTLESS_POLISH",
    default: formatChatChoice(parseChatChoice(DEFAULT_POLISH)),
    choices: null,
    // 存下来的统一是 厂商/模型
    parse: (value) => formatChatChoice(parseChatChoice(value)),
  },
  customUrl: {
    ofMode: "local",
    env: "DRAFTLESS_CUSTOM_URL",
    // 空的是没填：只有润色交给自定义服务时才要
    default: "",
    choices: null,
    parse: (value) => (value.trim() === "" ? "" : normalizeBaseUrl(value)),
  },
  modelSource: {
    // 本地模型没下载过时先从哪下，哪种模式里都能改（切到 local 之前先选好）。选的那个下不动会换另一个，只影响快慢
    env: "DRAFTLESS_MODEL_SOURCE",
    default: DEFAULT_SOURCE,
    choices: SOURCE_IDS,
    parse(value) {
      const id = value.trim().toLowerCase();
      if (!SOURCE_IDS.includes(id)) throw oneOf(SOURCE_IDS);
      return id;
    },
    label: (value) => msg(`modelSources.${value}`),
  },
  theme: {
    env: "DRAFTLESS_THEME",
    default: DEFAULT_THEME,
    choices: THEME_IDS,
    parse(value) {
      // 写 id 或写名字都认（cinnabar、朱砂、Cinnabar），存下来的统一是 id
      const theme = findTheme(value.trim());
      if (theme === null) throw oneOf(THEME_IDS);
      return theme.id;
    },
    label: (value) => msg(`themes.${value}.name`),
  },
  language: {
    env: "DRAFTLESS_LANGUAGE",
    // 跟随系统，认不出系统的语言时用英文（src/i18n）
    default: SYSTEM_LOCALE,
    choices: LANGUAGES,
    parse(value) {
      const wanted = value.trim();
      if (wanted.toLowerCase() === SYSTEM_LOCALE) return SYSTEM_LOCALE;
      const locale = findLocale(wanted);
      if (locale === null) throw oneOf(LANGUAGES);
      return locale.id;
    },
    // 语言的名字用它自己的语言写（English、简体中文），不翻
    label: (value) => (value === SYSTEM_LOCALE ? msg("language.system") : findLocale(value).name),
  },
};

function settingNamed(name) {
  if (!Object.hasOwn(SETTINGS, name)) {
    throw new LocalizedError(
      msg("settings.unknown", { name: JSON.stringify(name), names: Object.keys(SETTINGS).join(" / ") }),
    );
  }
  return SETTINGS[name];
}

/** @param {string | object} where 哪里写的：设置的名字，或者一句话（msg） */
function parseValue(name, value, where) {
  try {
    if (typeof value !== "string") throw new LocalizedError(msg("settings.notText"));
    return SETTINGS[name].parse(value);
  } catch (error) {
    throw new LocalizedError(
      msg("settings.invalid", { where, value: JSON.stringify(value), reason: problemOf(error) }),
      {
        cause: error,
      },
    );
  }
}

function readFile(file) {
  if (!existsSync(file)) return {};
  let stored;
  try {
    stored = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new LocalizedError(msg("settings.unreadable", { file, reason: error.message }), { cause: error });
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    throw new LocalizedError(msg("settings.notObject", { file }));
  }
  return stored;
}

function writeFile(file, stored) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
}

/** 这一项现在被哪个环境变量盖着（新名字优先于改名前的）；没有就是 null */
export function overridingEnv(name, env) {
  const setting = settingNamed(name);
  for (const variable of [setting.env, setting.legacyEnv]) {
    if (variable && env[variable] !== undefined) return variable;
  }
  return null;
}

/**
 * 现在生效的设置，以及每一项是从哪来的。
 * @returns {Record<keyof typeof SETTINGS, { value: string, source: "env" | "file" | "default", env?: string }>}
 *   来自改名前的环境变量时，env 写着是哪一个
 */
export function resolveSettings({ file, env }) {
  const stored = readFile(file);
  const resolved = {};
  for (const [name, setting] of Object.entries(SETTINGS)) {
    const variable = overridingEnv(name, env);
    if (variable !== null) {
      const value = parseValue(name, env[variable], msg("settings.whereEnv", { variable }));
      resolved[name] = variable === setting.env ? { value, source: "env" } : { value, source: "env", env: variable };
    } else if (stored[name] !== undefined) {
      resolved[name] = {
        value: parseValue(name, stored[name], msg("settings.whereFile", { file, name })),
        source: "file",
      };
    } else {
      resolved[name] = { value: setting.default, source: "default" };
    }
  }
  return resolved;
}

/** 校验并保存一项设置。返回规整后的值 */
export function saveSetting(file, name, value) {
  settingNamed(name);
  const parsed = parseValue(name, value, name);
  writeFile(file, { ...readFile(file), [name]: SETTINGS[name].store?.(parsed) ?? parsed });
  return parsed;
}

/** 取消一项设置，让它回到默认值 */
export function unsetSetting(file, name) {
  settingNamed(name);
  const { [name]: _removed, ...rest } = readFile(file);
  writeFile(file, rest);
}

/**
 * 按要改的几项拼出改后的设置，不写文件：先看改了之后走哪条路线、验证过了再存的时候用。
 * 写错了照 saveSetting 的规矩报错
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {Record<string, string>} changes
 */
export function patchSettings(settings, changes) {
  const patched = { ...settings };
  for (const [name, value] of Object.entries(changes)) {
    settingNamed(name);
    patched[name] = { value: parseValue(name, value, name), source: "file" };
  }
  return patched;
}

/** 每种模式自己的那几项设置（ofMode） */
export const MODE_SETTINGS = Object.freeze(
  Object.fromEntries(
    MODE_IDS.map((mode) => [mode, Object.keys(SETTINGS).filter((name) => SETTINGS[name].ofMode === mode)]),
  ),
);

/**
 * 每种模式由哪几项设置拼成路线（server/modes.mjs）。各看各的：改了 local 的润色，native 的路线不变
 */
const ROUTES = {
  native: (settings) => ({
    mode: "native",
    model: parseModelChoice(settings.model.value),
    thinkingLevel: settings.thinking.value,
  }),
  local: (settings) => ({
    mode: "local",
    transcriber: settings.transcriber.value,
    polish: parseChatChoice(settings.polish.value),
    customUrl: settings.customUrl.value || null,
  }),
};

/**
 * 某种模式按现在的设置走哪条路线，不写就是设置里选的那种模式
 * @param {ReturnType<typeof resolveSettings>} settings
 * @param {string} [mode]
 */
export function routeOf(settings, mode = settings.mode.value) {
  return ROUTES[mode](settings);
}
