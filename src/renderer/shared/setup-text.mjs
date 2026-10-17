// 主窗口的设置和首次引导都要说的几句话：权限是什么状态、还差不差 key、主进程报的错怎么给人看。
// 纯函数，不碰页面。要说的话按调用方给的翻译函数写（src/i18n）。

/** 主进程抛的错经过 IPC 会带上一截"Error invoking remote method 'xx': Error: "，给人看时去掉 */
export const describeError = (error) =>
  (error instanceof Error ? error.message : String(error)).replace(
    /^Error invoking remote method '[^']*': (?:\w*Error: )?/,
    "",
  );

/** key 还不能用（没有、读不出来、被拒了）。正在验证的不算 */
export const keyMissing = ({ key }) => key.state !== "ready" && key.state !== "checking";

/** 麦克风没给、或者两把钩子里有没装上的（还没报上来的不算） */
export const permissionDenied = ({ permissions }) =>
  permissions.microphone !== "granted" || permissions.listen === false || permissions.trusted === false;

/** 这一项好了没有：麦克风看系统给的状态，钩子看小帮手报的 true/false。true 好了、false 没有、null 还在查 */
export function permissionGranted(name, value) {
  if (name === "microphone") return value === "granted";
  return value;
}

/**
 * 一项权限的状态写成什么、什么语气、按钮上写什么。
 * @param {Function} t 界面语言的翻译函数
 * @returns {[label: string, tone: "ok" | "problem" | "pending", action: string]}
 */
export function permissionText(name, value, t) {
  const granted = [t("permissions.granted"), "ok", t("permissions.openSettings")];
  const denied = [t("permissions.denied"), "problem", t("permissions.openSettings")];
  if (name === "microphone") {
    if (value === "granted") return granted;
    // 从没问过时 Windows 设置的列表里还没有这个应用，要先让系统弹一次授权框
    if (value === "not-determined") return [t("permissions.denied"), "problem", t("permissions.request")];
    return denied;
  }
  if (value === null) return [t("permissions.checking"), "pending", t("permissions.openSettings")];
  // 两把钩子不是"授权"：小帮手装上就有，装不上多半是安全软件拦了
  return value
    ? [t("permissions.installed"), "ok", t("permissions.openSettings")]
    : [t("permissions.notInstalled"), "problem", t("permissions.openSettings")];
}
