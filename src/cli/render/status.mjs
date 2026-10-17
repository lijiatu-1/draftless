import { findLocale, msg, SYSTEM_LOCALE } from "../../i18n/index.mjs";
import { backendText } from "../../models/describe.mjs";
import { parseChatChoice } from "../../server/chat/vendors.mjs";
import { findProvider, parseModelChoice } from "../../server/providers/index.mjs";
import { findVendor } from "../../server/vendors.mjs";
import { HOTKEY_IDS, SETTINGS } from "../../storage/settings.mjs";
import { formatUsd } from "../../usage/format.mjs";
import { routeTitle } from "./modes.mjs";
import { themeTitle } from "./settings.mjs";
import { duration, INDENT, paint, rows } from "./text.mjs";

// 状态面板（draftless、draftless status）。和别的画面一样是"数据进、一段文字出"，不碰终端也不读文件。

/**
 * 后台应用正在用的模型。0.3 的后台应用报的是不带厂商的 Gemini 模型名，也不报 provider，照样认；
 * 连着单独启动的服务端时报 null，返回 null
 */
function modelInUse(status, settings) {
  if (status.model === null) return null;
  // 更旧的版本连 model 都不报
  return parseModelChoice(status.model ?? settings.model.value);
}

function keyLine(key, provider, t) {
  // 启动时够不着的话先用着，如实说还没验证
  const unverified = key.verified === false;
  const named = { variable: provider.keyEnv, provider: provider.name, problem: key.problem };
  switch (key.state) {
    case "ready":
      if (key.source === "env") return t(unverified ? "cli.status.keyEnvUnverified" : "cli.status.keyEnv", named);
      if (key.source === "external") return t("cli.status.keyExternal");
      return t(unverified ? "cli.status.keySavedUnverified" : "cli.status.keySaved", named);
    case "checking":
      return t("cli.status.keyChecking");
    case "rejected":
      // 三种情况要做的事不一样，不能都说成"换一把"
      if (key.cause === "other") {
        const what = msg(provider.thinkingLevels ? "cli.status.modelAndLevel" : "cli.status.modelOnly");
        return t("cli.status.keyCheckFailed", { ...named, what });
      }
      if (key.source === "env") return t("cli.status.keyEnvRejected", named);
      return t("cli.status.keyRejected", named);
    case "unreadable":
      return t("cli.status.keyUnreadable", named);
    default:
      return t("cli.status.keyMissing");
  }
}

/** 下到哪了：用户正在下的（0.7.1 起是 missing 带着进度），或者 0.7.0 的后台自己在下的（downloading） */
const downloadingLine = (localModel, t) =>
  t("cli.status.localDownloading", {
    percent: Math.floor((localModel.received / localModel.total) * 100),
    received: Math.round(localModel.received / 1_000_000),
    total: Math.round(localModel.total / 1_000_000),
  });

/** 本地模型（local 模式的第一跳）现在怎样 */
function localModelLine(localModel, t) {
  switch (localModel?.state) {
    case "ready":
      return t("cli.status.localReady", { backend: backendText(localModel.backend) });
    case "missing":
      return localModel.total ? downloadingLine(localModel, t) : t("cli.status.localMissing", { id: localModel.model });
    case "downloading":
      return downloadingLine(localModel, t);
    case "loading":
      return t("cli.status.localLoading");
    case "failed":
      return t.text(localModel.problem);
    default:
      return null;
  }
}

/** 热键叫什么。比这个命令新的版本里才有的热键叫不出名字，用后台报的说法 hotkeyLabel */
const hotkeyTitle = (status, t) =>
  HOTKEY_IDS.includes(status.hotkey) ? t(`hotkeys.${status.hotkey}.name`) : (status.hotkeyLabel ?? status.hotkey);

/** 界面语言：跟随系统时带上实际用的那种（"System · English"） */
function languageTitle({ language, locale }, t) {
  const name = (id) => findLocale(id)?.name ?? id;
  return language === SYSTEM_LOCALE ? `${t("language.system")} · ${name(locale)}` : name(language);
}

/** 设置里现在写的，和后台应用启动时带着的不一样的那几项 */
function pendingSettings(status, settings) {
  // 后台应用没报的项（连着单独启动的服务端时的模型、用不上思考档位的模型）不比；
  // 两边按同一个规矩写过再比，0.3 的后台应用报的旧写法（不带厂商的模型名）不算不一样
  const same = (name, reported) => {
    try {
      return SETTINGS[name].parse(String(reported)) === settings[name].value;
    } catch {
      return false;
    }
  };
  return Object.keys(SETTINGS).filter((name) => status[name] != null && !same(name, status[name]));
}

/** native 模式：key、模型 */
function nativeEntries(status, settings, t) {
  const inUse = modelInUse(status, settings);
  const provider = findProvider(inUse?.provider ?? parseModelChoice(settings.model.value).provider);
  // 旧版本的后台应用不报思考档位；用不上档位的模型（报 null）就不写
  const thinking = provider.thinkingLevels ? (status.thinking ?? settings.thinking.value) : null;
  const model =
    inUse === null
      ? t("cli.status.modelExternal")
      : t(thinking ? "cli.status.modelWithThinking" : "cli.status.modelInUse", {
          provider: provider.name,
          model: inUse.model,
          thinking,
        });
  const entries = [
    [t("cli.status.key"), keyLine(status.key, provider, t)],
    [t("cli.status.model"), model],
  ];
  // 报了模式的版本才写这一行
  if (status.mode) entries.splice(1, 0, [t("cli.status.mode"), t("modes.native")]);
  return entries;
}

/** local 模式：key（润色那家的）、两跳各用什么、本地模型下好了没有 */
function localEntries(status, settings, t) {
  const provider = findVendor(status.provider);
  // 后台没报的项照设置里的写
  const route = {
    mode: "local",
    transcriber: status.transcriber ?? settings.transcriber.value,
    polish: parseChatChoice(status.polish ?? settings.polish.value),
    customUrl: settings.customUrl.value || null,
  };
  const entries = [
    [t("cli.status.key"), keyLine(status.key, provider, t)],
    [t("cli.status.mode"), t("modes.local")],
    [t("cli.status.model"), t.text(routeTitle(route))],
  ];
  const localModel = localModelLine(status.localModel, t);
  if (localModel) entries.push([t("cli.status.localModel"), localModel]);
  return entries;
}

function statsLine({ dictations, characters, seconds, costUsd, unpricedCalls }, { withPace, t }) {
  const parts = [
    t("cli.status.dictations", { count: dictations }),
    t("cli.status.characters", { count: characters }),
    duration(seconds, t),
  ];
  // 每分钟多少字只在累计里给：一天里说得少时这个数跳得厉害，没有参考价值
  if (withPace && seconds >= 60) parts.push(t("cli.status.pace", { count: Math.round(characters / (seconds / 60)) }));
  // 有几笔不知道价时钱只加得上一部分，说"至少"；记账之前的版本没有账，不写 $0 让人以为没花钱
  if (unpricedCalls > 0) {
    parts.push(costUsd > 0 ? t("cli.status.atLeast", { cost: formatUsd(costUsd) }) : t("cli.status.costUnknown"));
  } else if (costUsd > 0) parts.push(formatUsd(costUsd));
  return parts.join(" · ");
}

/**
 * @param {object} view
 * @param {object | null} view.status 后台应用报的状态（src/app/main.mjs 的 describeStatus）；没有在运行时是 null
 * @param {string} view.version 这个命令自己的版本，没有在运行时用它
 * @param {Record<string, { value: string }>} view.settings 现在的设置。面板上写的是后台应用正在用的，
 *   这一份只用来看两边一不一样
 * @param {{ today: object | null, total: object | null }} view.stats 没有历史库时两项都是 null
 * @param {{ color: boolean, t: Function }} options t：界面语言的翻译函数。后台报上来的话（msg）也按它翻
 */
export function renderStatus({ status, version, settings, stats }, { color, t }) {
  const c = paint(color);
  if (status === null) {
    return [
      `${c.bold(`draftless ${version}`)} · ${t("cli.status.notRunning")}`,
      "",
      `${INDENT}${t("cli.status.runToStart", { command: c.bold("draftless") })}`,
      "",
    ].join("\n");
  }

  const { summary, permissions } = status;
  const state = status.starting
    ? t("cli.status.starting")
    : summary.ready
      ? c.green(t("cli.status.running"))
      : summary.missing.length > 0
        ? c.yellow(t("cli.status.missingCount", { count: summary.missing.length }))
        : t("cli.status.preparing");
  const lines = [`${c.bold(`draftless ${status.version}`)} · ${state}`, ""];

  if (summary.ready) {
    lines.push(`${INDENT}${t("cli.status.ready", { hotkey: hotkeyTitle(status, t) })}`, "");
  } else if (!status.starting && summary.missing.length > 0) {
    lines.push(`${INDENT}${t("cli.status.missing", { items: t.list(summary.missing) })}`, "");
  }

  const mark = (granted) => (granted === null ? c.dim("…") : granted ? c.green("✓") : c.red("✗"));
  const cells = [
    `${t("permissions.microphone")} ${mark(permissions.microphone === "granted")}`,
    `${t("permissions.listen")} ${mark(permissions.listen)}`,
    `${t("permissions.trusted")} ${mark(permissions.trusted)}`,
  ];
  // 写后台应用正在用的，不是现在设置里的：设置改了还没重启、或者启动它的那条命令上带着环境变量时，两者不一样。
  // 0.6 及以前的不报模式，那时只有 native
  const local = status.mode === "local";
  const entries = local ? localEntries(status, settings, t) : nativeEntries(status, settings, t);
  entries.splice(
    1,
    0,
    [t("cli.status.permissions"), cells.join("   ")],
    [t("cli.status.hotkey"), hotkeyTitle(status, t)],
  );
  // 旧版本的后台应用不报这两项
  if (status.theme != null) entries.push([t("cli.status.theme"), themeTitle(t, status.theme)]);
  if (status.language != null) entries.push([t("cli.status.language"), languageTitle(status, t)]);
  if (stats.total && stats.total.dictations > 0) {
    entries.push(
      [t("cli.status.today"), statsLine(stats.today, { withPace: false, t })],
      [t("cli.status.total"), statsLine(stats.total, { withPace: true, t })],
    );
  }
  lines.push(...rows(entries));

  const relaunch = msg(status.packaged ? "cli.packagedRelaunch" : "cli.runRestart");
  const notes = [];
  const pending = pendingSettings(status, settings);
  // 设置的名字是英文的标识，用斜线隔开，不按语言并列
  if (pending.length > 0) notes.push(t("cli.status.pending", { names: pending.join(" / "), relaunch }));
  if (status.helper === "stopped") notes.push(t("cli.status.helperStopped", { relaunch }));
  if (notes.length > 0) lines.push("", ...notes.map((note) => `${INDENT}${note}`));

  const permissionMissing =
    permissions.microphone !== "granted" || permissions.listen === false || permissions.trusted === false;
  if (permissionMissing) {
    lines.push("");
    if (summary.degraded) lines.push(`${INDENT}${t("common.sentence", { text: summary.degraded })}`);
    lines.push(
      `${INDENT}${t("cli.status.openSettings", { command: c.bold("draftless settings") })}`,
      c.dim(`${INDENT}${t(status.packaged ? "cli.status.ownerApp" : "cli.status.ownerTerminal")}`),
    );
  }

  lines.push(
    "",
    ...t("cli.status.footer")
      .split("\n")
      .map((line) => c.dim(`${INDENT}${line}`)),
    "",
  );
  return lines.join("\n");
}
