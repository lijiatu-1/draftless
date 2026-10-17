import { msg } from "../../i18n/index.mjs";
import { chipOf, downloadSize, findModel, MODELS, measuredOn, SOURCES } from "../../models/catalog.mjs";
import { sizeText } from "../../models/describe.mjs";
import { freeBytesAt } from "../../models/library.mjs";
import { createModelStore } from "../../models/store.mjs";
import { CHAT_VENDORS, findChatVendor, parseChatChoice } from "../../server/chat/vendors.mjs";
import { formatSeconds } from "../../usage/format.mjs";
import { currentSettings, ensureRunning, parse, renderOptions, UsageError } from "../common.mjs";
import { polishTitle, renderPolish, renderTranscribers } from "../render/modes.mjs";
import { keySourceFor } from "./key.mjs";
import { downloadAndWait, modelStatus, offerDownload } from "./local-models.mjs";
import { needUrl } from "./mode.mjs";
import { applyChange, checked, ensureKey, inMode, modeNow, routeWith } from "./route.mjs";

// local 模式的两跳，各一个命令，只在 local 模式里能换（不在就说先 draftless mode local）：
//   draftless transcriber   第一跳：本机转写模型。不用 key；要先下载好（download / cancel / delete 管下载和删除，
//                           check 念一句交给它转，看能不能正常出字）
//   draftless polish        第二跳：润色的厂商和模型；自定义服务（兼容 OpenAI 接口）连同地址
// 列出来看在哪种模式里都行，不在 local 时开头说一句现在用不上。下载、删除在哪种模式里都能做。

/** 检查要等后台应用问一次那一家，那边的超时是 30 秒 */
const CHECK_TIMEOUT_MS = 45_000;
/** 检查本机模型：没在用的要临时装一次（CPU 上装大的要十几秒），再转一句 */
const TRANSCRIBER_CHECK_TIMEOUT_MS = 90_000;

/** 管下载和删除的几个动作：draftless transcriber <动作> <模型> */
const MODEL_ACTIONS = { download, cancel, delete: remove };

export async function transcriber(args, io) {
  const { values, positionals } = parse(args, { yes: { type: "boolean", short: "y", default: false } });
  const [first, second, ...extra] = positionals;
  if (first === "check") {
    if (extra.length > 0 || values.yes) throw new UsageError(msg("cli.syntax.transcriber"));
    const id =
      second === undefined ? currentSettings(io).transcriber.value : checked(io, { transcriber: second }).transcriber;
    return checkTranscriber(io, id);
  }
  if (Object.hasOwn(MODEL_ACTIONS, first ?? "")) {
    if (second === undefined || extra.length > 0) throw new UsageError(msg("cli.syntax.transcriber"));
    const { transcriber: id } = checked(io, { transcriber: second });
    return MODEL_ACTIONS[first](io, id, values);
  }
  if (second !== undefined || values.yes) throw new UsageError(msg("cli.syntax.transcriber"));
  const status = await io.daemon.status();
  if (first === undefined) return listTranscribers(io, status);

  const { transcriber: id } = checked(io, { transcriber: first });
  if (!inMode(io, status, "local", "transcriber")) return 1;
  // 要用的没下载：先问要不要下，下好了再换
  if (!modelStatus(io, status, id).installed && !(await offerDownload(io, id))) return 1;
  return applyChange(io, {
    command: "set-transcriber",
    params: { transcriber: id },
    changes: { transcriber: id },
    done: msg("cli.local.transcriberSwitched", { model: id }),
  });
}

function listTranscribers(io, status) {
  const chip = chipOf();
  const models = MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    bytes: downloadSize(model),
    ...modelStatus(io, status, model.id),
    tags: model.tags,
    measured: measuredOn(model, chip),
  }));
  let freeBytes = null;
  try {
    freeBytes = freeBytesAt(io.paths.modelsDir);
  } catch {
    // 查不了磁盘就不说剩多少
  }
  const settings = currentSettings(io);
  const view = {
    models,
    chip,
    freeBytes,
    setting: settings.transcriber.value,
    source: settings.modelSource.value,
    sources: SOURCES.map(({ id }) => id),
    current: modeNow(io, status),
  };
  io.out(renderTranscribers(view, renderOptions(io)));
  return 0;
}

/** 检查一个本机模型：交给后台应用念一句、转一次（没在用的它会临时装上，查完卸掉）。后台没在运行先启动 */
async function checkTranscriber(io, id) {
  const model = findModel(id);
  await ensureRunning(io);
  // 没下载的不用去问后台：直接说怎么下
  if (!modelStatus(io, await io.daemon.status(), id).installed) {
    io.err(io.t("cli.local.notDownloadedHint", { model: model.name, id }));
    return 1;
  }
  io.out(io.t("cli.local.checking", { model: model.name }));
  let result;
  try {
    result = await io.daemon.request("check-transcriber", { id }, { timeoutMs: TRANSCRIBER_CHECK_TIMEOUT_MS });
  } catch (error) {
    // 正在运行的是升级之前启动的那一个，还不认识这条命令
    if (!/^不认识的命令/.test(error?.message ?? "")) throw error;
    io.err(io.t("cli.local.oldDaemonCheck"));
    return 1;
  }
  if (!result.ok) {
    io.err(io.t("common.sentence", { text: result.problem }));
    return 1;
  }
  io.out(
    io.t("cli.local.checkOk", {
      model: model.name,
      said: result.said,
      text: result.text,
      seconds: formatSeconds(result.transcribeMs, io.t),
    }),
  );
  if (result.loadMs !== null) io.out(io.t("cli.local.checkLoaded", { seconds: formatSeconds(result.loadMs, io.t) }));
  return 0;
}

async function download(io, id) {
  return (await downloadAndWait(io, id)) ? 0 : 1;
}

/** 停下正在下的：只有交给后台下的才停得了（在命令行这个进程里下的，按 Ctrl-C 就停了） */
async function cancel(io, id) {
  const status = await io.daemon.status();
  const model = findModel(id);
  if (!modelStatus(io, status, id).download) {
    io.out(io.t("cli.local.nothingToCancel", { model: model.name }));
    return 0;
  }
  await io.daemon.request("cancel-download", { id });
  io.out(io.t("cli.local.cancelled", { model: model.name }));
  return 0;
}

/**
 * 删一个本机模型，先确认（--yes 跳过）。正在用的删不了：后台在运行时由它判（内核的规矩），
 * 没在运行时看设置——设置里 local 模式用的就是它的话，下次启动就用不上了
 */
async function remove(io, id, { yes }) {
  const model = findModel(id);
  const status = await io.daemon.status();
  const { installed } = modelStatus(io, status, id);
  const store = createModelStore({ dir: io.paths.modelsDir });
  const onDisk = installed ? downloadSize(model) : downloadSize(model) - store.missingBytes(model);
  if (onDisk === 0) {
    io.out(io.t("cli.local.notOnDisk", { model: model.name }));
    return 0;
  }
  const settings = currentSettings(io);
  if (status === null && settings.mode.value === "local" && settings.transcriber.value === id) {
    io.err(io.t("common.sentence", { text: msg("localModels.inUse", { model: model.name }) }));
    return 1;
  }
  if (!yes) {
    if (!io.interactive) throw new UsageError(msg("cli.local.deleteNeedsConfirm", { id }));
    if (!(await io.confirm(io.t("cli.local.deleteConfirm", { model: model.name, size: sizeText(onDisk) })))) {
      io.out(io.t("cli.local.deleteAborted"));
      return 1;
    }
  }
  if (status === null) {
    io.localModels({ source: settings.modelSource.value }).remove(id);
  } else {
    let result;
    try {
      result = await io.daemon.request("delete-model", { id });
    } catch (error) {
      // 0.7.0 及以前的后台不认这条命令：它不知道哪些在用，不替它删
      if (!/^不认识的命令/.test(error?.message ?? "")) throw error;
      io.err(io.t("cli.local.oldDaemonDelete"));
      return 1;
    }
    if (!result.ok) {
      io.err(io.t("common.sentence", { text: result.problem }));
      return 1;
    }
  }
  io.out(io.t("cli.local.deleted", { model: model.name, size: sizeText(onDisk) }));
  return 0;
}

export async function polish(args, io) {
  const { values, positionals } = parse(args, { url: { type: "string" } });
  const [first, second, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError(msg("cli.syntax.polish"));
  if (first === "check") return check(io, second, values.url);
  if (second !== undefined) throw new UsageError(msg("cli.syntax.polish"));
  const status = await io.daemon.status();
  if (first === undefined) {
    if (values.url !== undefined) throw new UsageError(msg("cli.syntax.polish"));
    return list(io, status);
  }

  // 先查写得对不对（以 2 退出），再看是不是在 local 模式里（以 1 退出）
  const changes = choiceFrom(io, first, values.url);
  const route = routeWith(io, "local", changes);
  needUrl(route);
  if (!inMode(io, status, "local", "polish")) return 1;
  const vendor = findChatVendor(route.polish.vendor);
  if (!(await ensureKey(io, vendor, changes))) return 1;
  return applyChange(io, {
    command: "set-polish",
    params: changes,
    changes,
    done: msg("cli.local.polishSwitched", { model: polishTitle(route.polish, route.customUrl) }),
  });
}

/**
 * 用户写的润色模型（和地址）→ 查过的设置。写的是收音频的那家、写错了，以 2 退出说能填什么
 * @returns {{ polish: string, customUrl?: string }}
 */
function choiceFrom(io, value, url) {
  const changes = url === undefined ? { polish: value } : { polish: value, customUrl: url };
  return checked(io, changes);
}

function list(io, status) {
  const settings = currentSettings(io);
  const keys = Object.fromEntries(CHAT_VENDORS.map((vendor) => [vendor.id, keySourceFor(io, vendor, status)]));
  const view = {
    vendors: CHAT_VENDORS,
    polish: parseChatChoice(settings.polish.value),
    customUrl: settings.customUrl.value,
    keys,
    current: modeNow(io, status),
  };
  io.out(renderPolish(view, renderOptions(io)));
  return 0;
}

/** 第二跳的某个模型现在能不能用：交给后台应用，用那一家的 key 发一个最小的请求。在哪种模式里都能查 */
async function check(io, value, url) {
  const changes = value === undefined ? {} : choiceFrom(io, value, url);
  const route = routeWith(io, "local", changes);
  needUrl(route);
  await ensureRunning(io);
  const title = io.t.text(polishTitle(route.polish, route.customUrl));
  io.out(io.t("cli.model.checking", { model: title }));
  const params = { polish: `${route.polish.vendor}/${route.polish.model}` };
  if (changes.customUrl !== undefined) params.customUrl = changes.customUrl;
  let result;
  try {
    result = await io.daemon.request("check-polish", params, { timeoutMs: CHECK_TIMEOUT_MS });
  } catch (error) {
    // 正在运行的是升级之前启动的那一个，还不认识这条命令
    if (!/^不认识的命令/.test(error?.message ?? "")) throw error;
    io.err(io.t("cli.model.oldDaemonCheck"));
    return 1;
  }
  if (!result.ok) {
    io.err(io.t("cli.model.unusable", { problem: result.problem }));
    return 1;
  }
  const vendor = findChatVendor(route.polish.vendor);
  const from =
    result.source === "env" ? msg("cli.model.fromEnv", { variable: vendor.keyEnv }) : msg("cli.model.fromStored");
  io.out(io.t("cli.model.usable", { model: title, from, seconds: (result.ms / 1000).toFixed(1) }));
  return 0;
}
