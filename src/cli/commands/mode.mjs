import { msg } from "../../i18n/index.mjs";
import { downloadSize, findModel } from "../../models/catalog.mjs";
import { CHAT_VENDORS } from "../../server/chat/vendors.mjs";
import { keyVendorOf, MODES } from "../../server/modes.mjs";
import { PROVIDERS } from "../../server/providers/index.mjs";
import { routeOf } from "../../storage/settings.mjs";
import { Cancelled } from "../ask-secret.mjs";
import { currentSettings, parse, renderOptions, UsageError } from "../common.mjs";
import { renderModes, routeTitle } from "../render/modes.mjs";
import { storeSetting } from "./config.mjs";
import { currentProvider, keySource } from "./key.mjs";
import { modelStatus, offerDownload } from "./local-models.mjs";
import { applyChange, checked, ensureKey, modeNow, routeWith } from "./route.mjs";

// draftless mode：识别模式这一层。看两种模式各用什么、切到另一种。
// 模式里的模型各有各的命令：native 是 draftless model，local 的两跳是 draftless transcriber 和 draftless polish，
// 它们只在自己的模式里能用。第一次进 local 时第二跳还没法换，所以切过去时可以连带那种模式自己的设置。

/** 切到某种模式时能连带的设置，写成命令行参数：参数名 → 设置名（只能是那种模式自己的，storage/settings.mjs 的 MODE_SETTINGS） */
const MODE_FLAGS = {
  native: { model: "model" },
  local: { transcriber: "transcriber", polish: "polish", url: "customUrl" },
};
const FLAG_OPTIONS = {
  model: { type: "string" },
  transcriber: { type: "string" },
  polish: { type: "string" },
  url: { type: "string" },
};

/** 每种模式按现在的设置走哪条路线 */
const routesOf = (settings) => Object.fromEntries(MODES.map(({ id }) => [id, routeOf(settings, id)]));

export async function mode(args, io) {
  const { values, positionals } = parse(args, FLAG_OPTIONS);
  const [wanted, ...extra] = positionals;
  const flags = Object.keys(values);
  if (extra.length > 0 || (wanted === undefined && flags.length > 0)) throw new UsageError(msg("cli.syntax.mode"));

  const status = await io.daemon.status();
  if (wanted === undefined) {
    io.out(renderModes({ routes: routesOf(currentSettings(io)), current: modeNow(io, status) }, renderOptions(io)));
    return 0;
  }

  const target = checked(io, { mode: wanted }).mode;
  const foreign = flags.find((flag) => !Object.hasOwn(MODE_FLAGS[target], flag));
  if (foreign) {
    const allowed = Object.keys(MODE_FLAGS[target]).map((flag) => `--${flag}`);
    throw new UsageError(msg("cli.modes.flagsFor", { flag: `--${foreign}`, mode: target, flags: allowed.join(" / ") }));
  }
  const changes = checked(io, Object.fromEntries(flags.map((flag) => [MODE_FLAGS[target][flag], values[flag]])));
  const route = routeWith(io, target, changes);
  if (route.mode === "local") needUrl(route);

  if (modeNow(io, status) === target && flags.length === 0) {
    io.out(io.t("cli.modes.already", { mode: target, route: io.t.text(routeTitle(route)) }));
    return 0;
  }
  // local 要用的本机模型还没下载：先问要不要下（下几百兆要用户点头），下好了再问 key、再切
  if (route.mode === "local" && !modelStatus(io, status, route.transcriber).installed) {
    if (!(await offerDownload(io, route.transcriber))) return 1;
  }
  if (!(await ensureKey(io, keyVendorOf(route), { mode: target, ...changes }))) return 1;
  return applyChange(io, {
    command: "set-mode",
    params: { mode: target, changes },
    changes: { mode: target, ...changes },
    done: msg("cli.modes.switched", { mode: target, route: routeTitle(route) }),
  });
}

/** 润色交给自定义服务却没有地址：说要给 --url */
export function needUrl(route) {
  if (route.polish.vendor === "custom" && !route.customUrl) throw new UsageError(msg("cli.local.urlNeeded"));
}

const MAX_CHOICE_ATTEMPTS = 3;

/**
 * 第一次启动、还没有 key 时先问用哪种模式的哪一家：手里有哪家的 key，因人而异。
 * 按模式分组列出来，选的不是现在设置里那家就记进设置；已经有 key 的标出来，选它就不用再填。
 * 自定义服务要地址和模型名，不在这里问：说一句以后怎么切过去。
 * @returns {Promise<object | null>} 选定的那一家；按了 Ctrl-C、或者问够了次数还没选上时是 null（不纠缠）
 */
export async function chooseProvider(io) {
  const { t } = io;
  const current = currentProvider(io);
  const local = findModel(currentSettings(io).transcriber.value);
  const groups = [
    { mode: "native", vendors: PROVIDERS, title: t("cli.choose.native") },
    {
      mode: "local",
      vendors: CHAT_VENDORS.filter(({ defaultModel }) => defaultModel !== null),
      title: t("cli.choose.local", { size: `${Math.round(downloadSize(local) / 1_000_000)} MB` }),
    },
  ];
  const options = groups.flatMap(({ mode, vendors }) => vendors.map((vendor) => ({ mode, vendor })));
  const lines = ["", t("cli.choose.question")];
  for (const group of groups) {
    lines.push(`  ${group.title}`);
    for (const { vendor } of options.filter(({ mode }) => mode === group.mode)) {
      const number = options.findIndex((option) => option.vendor === vendor) + 1;
      const note = t(keySource(io, vendor) ? "cli.model.optionWithKey" : "cli.model.option", {
        model: vendor.defaultModel,
      });
      lines.push(`    ${number}  ${vendor.name.padEnd(9)}${note}`);
    }
  }
  const fallback = options.findIndex(({ vendor }) => vendor.id === current.id) + 1;
  lines.push(t("cli.choose.custom"), t("cli.model.choosePrompt", { fallback }));
  const question = lines.join("\n");
  for (let attempt = 0; attempt < MAX_CHOICE_ATTEMPTS; attempt++) {
    let answer;
    try {
      answer = (await io.ask(attempt === 0 ? question : t("cli.model.choosePromptAgain"))).trim();
    } catch (error) {
      if (error instanceof Cancelled) return null;
      throw error;
    }
    const chosen =
      answer === ""
        ? options[fallback - 1]
        : (options[Number(answer) - 1] ?? options.find(({ vendor }) => vendor.id === answer.toLowerCase()));
    if (chosen) {
      if (chosen.vendor.id !== current.id) {
        if (chosen.mode === "native") storeSetting(io, "model", chosen.vendor.id);
        else storeSetting(io, "polish", chosen.vendor.id);
        storeSetting(io, "mode", chosen.mode);
      }
      return chosen.vendor;
    }
    const choices = options.map(({ vendor }, index) =>
      t("cli.model.choiceItem", { number: index + 1, name: vendor.name }),
    );
    io.err(t("cli.model.noSuchChoice", { answer, choices: t.either(choices) }));
  }
  return null;
}
