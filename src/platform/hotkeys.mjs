// 热键：设置里能选哪几个、旧名字怎么认、面板上写成什么。
//
// 这是整个仓库里唯一写死"用哪几个键"的地方：原生小帮手（native-win/Hooks.cs 的 Hotkeys 表）
// 认的是同一组名字，两边对不上时小帮手会在启动报"不认识的热键"并退出，界面上看得见。
//
// macOS 版是右 Option（默认）、右 Command、右 Control、fn。Windows 上没有 fn，右 Command 换成右 Win。
// 默认仍是"最不碍事的那一个"：右 Alt，也就是 macOS 的右 Option 在这里最接近的对应。

/** 设置里存的名字。顺序就是设置页里列出来的顺序 */
export const HOTKEY_IDS = Object.freeze(["right_alt", "right_ctrl", "right_shift", "right_win"]);

/**
 * 旧名字（macOS 版的）也认，省得从别处抄来的设置写一半就崩。存下来的统一是新名字。
 * - right_option → right_alt（同一个位置，都叫 Alt/Option）
 * - right_command → right_win（那个位置上的键，macOS 叫 Command、Windows 叫 Win）
 * - right_control → right_ctrl
 * - fn → right_shift（Windows 没有 fn，退到同一个习惯的"右手小指"）
 */
export const HOTKEY_ALIASES = Object.freeze({
  right_option: "right_alt",
  right_command: "right_win",
  right_control: "right_ctrl",
  fn: "right_shift",
});

/**
 * 把设置里写的名字规整成新名字；不认识时返回 null。
 * @param {string} value
 * @returns {string | null}
 */
export function normalizeHotkey(value) {
  const name = String(value).trim().toLowerCase();
  if (HOTKEY_IDS.includes(name)) return name;
  return HOTKEY_ALIASES[name] ?? null;
}

/**
 * 这个热键在 Windows 上好不好用。右 Win 单独按会被系统当成开始菜单，
 * 右 Alt 单独按在带菜单栏的程序里会去聚焦菜单——两条都是 Windows 的行为，不是缺陷，
 * 但用户按下去发现"没反应"之前该说一句。设置页和首次引导用它显示提示。
 * @returns {"ok" | "startMenu" | "menuBar"}
 */
export function hotkeyCaveat(id) {
  if (id === "right_win") return "startMenu";
  if (id === "right_alt") return "menuBar";
  return "ok";
}
