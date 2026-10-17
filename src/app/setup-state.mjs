// 把"能不能用、还差什么"归成一个结论。菜单栏、主窗口、按热键时的提示、命令行都用这一个，免得几处各说各的。
// 说的话都是还没定语言的（msg），由显示它的那一端按自己的语言翻。

import { msg } from "../i18n/index.mjs";
import { findModel } from "../models/catalog.mjs";

const OPEN_SETTINGS = msg("setup.openSettings");

/**
 * @param {object} setup
 * @param {{ state: "missing" | "unreadable" | "checking" | "rejected" | "ready", problem: object | string | null, cause?: string }} setup.key
 *   见 key-manager.mjs
 * @param {{ microphone: string, listen: boolean | null, trusted: boolean | null }} setup.permissions
 *   microphone 是系统给的状态（granted / denied / not-determined…）；listen、trusted 为 null 表示按键监听还没报上来
 * @param {"starting" | "running" | "stopped"} [setup.helper] 按键监听的小程序。stopped：退出了或者根本没起来
 * @param {string} [setup.providerName] 正在用哪一家的模型，缺 key 时点名
 * @param {{ state: string, model?: string, received?: number, total?: number, problem?: object } | null} [setup.localModel]
 *   本地转写链路的模型（service.mjs 的 localModel）；没走这条链路时是 off 或 null。还没下载（missing）、
 *   而用户正在下它时带着 received、total
 * @returns {{ ready: boolean, missing: object[], blocker: object | null, degraded: object | null }}
 *   ready：现在按热键能不能听写；missing：确定缺的东西；blocker：按了热键却不能用时提示的那句话；
 *   degraded：能用但打了折扣时的说明
 */
export function summarizeSetup({ key, permissions, helper, providerName = "Gemini", localModel = null }) {
  const missing = [];
  let blocker = null;

  const provider = providerName;
  if (key.state === "missing" || key.state === "unreadable") {
    missing.push(msg("setup.missing.key", { provider }));
    blocker = msg("setup.blocker.noKey", { provider, where: OPEN_SETTINGS });
  } else if (key.state === "rejected" && key.cause === "other") {
    // 那一家拒绝了请求，多半是模型名或思考档位写错：key 本身未必有问题，不能让人以为要换 key
    missing.push(msg("setup.missing.check", { provider }));
    blocker = msg("setup.blocker.checkFailed", { provider, problem: key.problem });
  } else if (key.state === "rejected") {
    missing.push(msg("setup.missing.key", { provider }));
    blocker = msg("setup.blocker.keyRejected", { problem: key.problem });
  } else if (key.state === "checking") {
    blocker = msg("setup.blocker.checking");
  }

  // 还没下载、没装上都要人去处理（下载由用户点；装不上多半是文件坏了），算缺；装载会自己做完，不算
  if (localModel?.state === "failed") {
    missing.push(msg("setup.missing.localModel"));
    blocker ??= localModel.problem;
  } else if (localModel?.state === "missing") {
    missing.push(msg("setup.missing.localModel"));
    blocker ??= localModel.total
      ? msg("local.modelDownloading", { percent: Math.floor((localModel.received / localModel.total) * 100) })
      : msg("local.modelMissing", {
          model: findModel(localModel.model)?.name ?? localModel.model,
          id: localModel.model,
        });
  } else if (localModel?.state === "loading") {
    blocker ??= msg("local.modelLoading");
  }

  if (permissions.microphone !== "granted") {
    missing.push(msg("setup.missing.microphone"));
    blocker ??= msg("setup.blocker.noMicrophone", { where: OPEN_SETTINGS });
  }
  // 没有输入监控权限时热键根本传不过来，所以它不会成为"按了热键之后"的那句提示
  if (permissions.listen === false) missing.push(msg("setup.missing.listen"));
  // 小程序不在了，两项权限就一直报不上来：不明说的话看起来永远是"正在准备"
  if (helper === "stopped") missing.push(msg("setup.missing.helper"));

  return {
    ready: blocker === null && permissions.listen === true,
    missing,
    blocker,
    degraded: permissions.trusted === false ? msg("setup.degraded") : null,
  };
}

/**
 * 交给命令行的样子：结论里的每句话按 t 的语言翻成字。0.5 及以前的命令行、status --json 的读者
 * 都把这几项当字来读（那时后台报的就是中文的字），交 msg 过去它们会显示成 [object Object]
 */
export function summaryAsText({ ready, missing, blocker, degraded }, t) {
  return {
    ready,
    missing: missing.map(t.text),
    blocker: blocker === null ? null : t.text(blocker),
    degraded: degraded === null ? null : t.text(degraded),
  };
}
