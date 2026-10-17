// 听写的状态机，纯函数：给当前状态和一个事件，得到新状态和要执行的动作。
// 照原版 2.8.1 的单击流程做（docs/10-interaction-state-machine.md）：
// 按一下热键开始，再按一下结束；按住超过 600 ms 取消（这一版不支持按住说话）。
// 说话的时候可以取消（按 esc 或点悬浮条上的 ✕），点 ✓ 等于再按一下热键。
// 原版的热键是 fn，这里是哪个键由主进程决定，状态机不关心。

import { msg } from "../../i18n/index.mjs";

export const LONG_PRESS_MS = 600;

export const Phase = Object.freeze({
  IDLE: "idle",
  STARTING: "starting", // 已按下，麦克风还没就绪
  RECORDING: "recording",
  FINISHING: "finishing", // 已结束录音，等成品
  ERROR: "error",
});

export const Action = Object.freeze({
  START: "start", // 打开麦克风、连服务端
  CANCEL: "cancel", // 丢弃这次录音
  STOP: "stop", // 结束录音并要成品
  ARM_HOLD_TIMER: "arm_hold_timer",
  CLEAR_HOLD_TIMER: "clear_hold_timer",
});

/**
 * held：热键从"开始这次录音的那一下"起一直没松开。松开之前还不确定是单击，
 * 可能是长按，也可能是热键加别的键的组合键。
 * message：出错原因或给用户的提示，只在 error 和带提示回到 idle 时有。
 */
export const initialState = Object.freeze({ phase: Phase.IDLE, held: false, message: null });

const idle = (message = null) => ({ phase: Phase.IDLE, held: false, message });
const unchanged = (state) => ({ state, actions: [] });

export function transition(state, event) {
  const { phase, held } = state;
  switch (event.type) {
    case "KEY_DOWN":
      if (phase === Phase.IDLE || phase === Phase.ERROR) {
        return {
          state: { phase: Phase.STARTING, held: true, message: null },
          actions: [Action.START, Action.ARM_HOLD_TIMER],
        };
      }
      // 不看 held：万一上一次松开的事件丢了，再按一下也要能结束，不能卡在录音里
      if (phase === Phase.RECORDING) {
        return { state: { phase: Phase.FINISHING, held: false, message: null }, actions: [Action.STOP] };
      }
      // 麦克风还没就绪就按了第二下：什么都没录到，直接作罢
      if (phase === Phase.STARTING && !held) return { state: idle(), actions: [Action.CANCEL] };
      return unchanged(state);

    case "KEY_UP":
      if (!held) return unchanged(state);
      return { state: { ...state, held: false }, actions: [Action.CLEAR_HOLD_TIMER] };

    case "OTHER_KEY":
      // 热键还按着就来了别的键，说明用户按的是组合键（比如 Alt+字母），不是听写
      if (!held) return unchanged(state);
      return { state: idle(), actions: [Action.CANCEL, Action.CLEAR_HOLD_TIMER] };

    case "LONG_HOLD":
      if (!held) return unchanged(state);
      return { state: idle(msg("bar.noHold")), actions: [Action.CANCEL] };

    case "USER_CANCEL":
      // 用户不要这一次了。等成品时已经取消不了：录音已经交出去了
      if (phase !== Phase.STARTING && phase !== Phase.RECORDING) return unchanged(state);
      return { state: idle(), actions: [Action.CANCEL, Action.CLEAR_HOLD_TIMER] };

    case "USER_CONFIRM":
      if (phase !== Phase.RECORDING) return unchanged(state);
      return { state: { phase: Phase.FINISHING, held: false, message: null }, actions: [Action.STOP] };

    case "MIC_READY":
      return phase === Phase.STARTING ? unchanged({ ...state, phase: Phase.RECORDING }) : unchanged(state);

    case "MAX_DURATION":
      if (phase !== Phase.RECORDING) return unchanged(state);
      return { state: { phase: Phase.FINISHING, held: false, message: null }, actions: [Action.STOP] };

    case "RESULT":
      // message 在这里是给用户的提示，比如"没有听到声音""已复制，请按 Ctrl+V"
      return phase === Phase.FINISHING ? unchanged(idle(event.message ?? null)) : unchanged(state);

    case "FAILED": {
      if (phase === Phase.IDLE || phase === Phase.ERROR) return unchanged(state);
      const next = { phase: Phase.ERROR, held: false, message: event.message };
      // 等成品时出错，录音已经停了；其余阶段要把麦克风和定时器收掉
      const actions = phase === Phase.FINISHING ? [] : [Action.CANCEL, Action.CLEAR_HOLD_TIMER];
      return { state: next, actions };
    }

    default:
      throw new Error(`状态机不认识的事件：${event.type}`);
  }
}
