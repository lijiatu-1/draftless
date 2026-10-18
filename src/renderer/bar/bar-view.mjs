// 悬浮条该是什么样子：由状态机的状态算出来，纯函数，不碰页面。
// 真正把它画出来的是 bar-ui.mjs。

import { Phase } from "./machine.mjs";

export const View = Object.freeze({
  HIDDEN: "hidden",
  STARTING: "starting", // 打开麦克风：声波伏着，一明一暗
  RECORDING: "recording", // 正在听：声波跟着声音动
  FINISHING: "finishing", // 整理中：一道匀速滚过的波
  DONE: "done", // 文字贴出去了：打个勾
  NOTICE: "notice", // 一句提示
  ERROR: "error", // 出错：图标加原因
});

/** 收尾的样子在屏幕上留多久再消失。说话时的样子不在这里：它们一直留到阶段变了为止 */
export const LINGER_MS = Object.freeze({
  [View.DONE]: 900,
  [View.NOTICE]: 4_000,
  [View.ERROR]: 4_000,
});

/**
 * @param {{ phase: string, message: object | string | null }} state 状态机现在的状态（message 是一句 msg 或现成的字）
 * @param {string} previousPhase 变成现在这样之前的阶段
 */
export function viewOf(state, previousPhase) {
  switch (state.phase) {
    case Phase.STARTING:
      return View.STARTING;
    case Phase.RECORDING:
      return View.RECORDING;
    case Phase.FINISHING:
      return View.FINISHING;
    case Phase.ERROR:
      return View.ERROR;
    default:
      if (state.message !== null) return View.NOTICE;
      // 刚拿到成品、没有别的话要说：打个勾再走。取消的、提示放完了的，直接消失
      return previousPhase === Phase.FINISHING ? View.DONE : View.HIDDEN;
  }
}

/**
 * 条上方的那行提示。
 * @param {string} view
 * @param {{ keycap: string, cancellable: boolean }} options keycap：热键的短名字；cancellable：esc 截不截得住
 * @param {Function} t 界面语言的翻译函数（src/i18n）。键在句子里的位置由各语言自己定
 * @returns {Array<string | { key: string }>} 一段一段的：文字，或者一个要标成键名的键
 */
export function hintFor(view, { keycap, cancellable, secondsLeft = null }, t) {
  switch (view) {
    case View.STARTING:
      return [t("bar.opening")];
    case View.RECORDING:
      // 最后 1 分钟：剩下的秒数比"再按一下"更该被看见
      if (secondsLeft !== null) return [t("bar.countdown", { seconds: secondsLeft })];
      return t.parts(cancellable ? "bar.recording" : "bar.recordingNoEsc", {
        key: { key: keycap },
        esc: { key: "esc" },
      });
    case View.FINISHING:
      return [t("bar.finishing")];
    default:
      return [];
  }
}

/** 这个样子下，条上哪几个按钮点得动 */
export function controlsIn(view) {
  if (view === View.STARTING) return ["cancel"];
  if (view === View.RECORDING) return ["cancel", "confirm"];
  return [];
}
