import { keyMissing, permissionGranted } from "../shared/setup-text.mjs";

// 首次引导有哪几步、从哪一步开始、什么时候能往下走。纯函数，不碰页面。
// 原版分"注册 · 设置 · 体验一下"三段（onboarding__steps__*）；我们没有账号，第一段换成接上一家模型。

export const STEPS = ["key", "permissions", "microphone", "hotkey", "try", "done"];

/** 每一步属于顶上三段里的哪一段 */
const GROUP_OF = { key: "key", permissions: "setup", microphone: "setup", hotkey: "setup", try: "try", done: "try" };
const GROUPS = ["key", "setup", "try"];

/** 打开引导时从哪一步开始：key 已经能用（或者正在验证）就不用再填一遍 */
export const startStep = (setup) => (keyMissing(setup) && setup.key.state !== "checking" ? "key" : "permissions");

/**
 * 底下的"继续"能不能点。测麦克风、测快捷键这两步不走它，靠那一步自己的"是的，继续"；完成那一步有自己的按钮
 */
export function canContinue(step, setup) {
  switch (step) {
    case "key":
      return setup.key.state === "ready";
    case "permissions":
      // 点击拦截那把钩子没装上也能用（只是 esc 和悬浮条上的按钮不灵），不拦着
      return (
        permissionGranted("microphone", setup.permissions.microphone) &&
        permissionGranted("listen", setup.permissions.listen) === true
      );
    case "try":
      return true;
    default:
      return false;
  }
}

/** 顶上三段各是什么状态：done 做完了、current 正在做、todo 还没到 */
export function groupStates(step) {
  const current = GROUPS.indexOf(GROUP_OF[step]);
  return Object.fromEntries(
    GROUPS.map((group, index) => [group, index < current ? "done" : index === current ? "current" : "todo"]),
  );
}
