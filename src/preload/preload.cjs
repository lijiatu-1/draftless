// 页面能调用的全部主进程能力都列在这里。页面本身拿不到 Node 和 Electron 的接口。
// 沙箱里的预加载脚本只能用 CommonJS。
const { contextBridge, ipcRenderer, webFrame } = require("electron");

// 主题：页面的样式只用 var(--…) 引用颜色，值由主进程按现在的主题给（src/themes）。
// 同步取、马上注入，赶在页面画出第一帧之前。之后换主题时主进程会再发一份过来：先放上新的再撤掉旧的，
// 中间不会有哪一帧是没有颜色的。
let themeKey = webFrame.insertCSS(ipcRenderer.sendSync("theme:get"));
ipcRenderer.on("theme:changed", (_event, css) => {
  const previous = themeKey;
  themeKey = webFrame.insertCSS(css);
  webFrame.removeInsertedCSS(previous);
});

// 界面语言：同样同步取，页面一加载就按它写字（src/renderer/shared/i18n.mjs）。设置里换了语言，
// 主窗口和首次引导整页重新加载；悬浮条不重新加载（可能正在听写），收到新的语言换掉翻译
const locale = ipcRenderer.sendSync("locale:get");

contextBridge.exposeInMainWorld("draftless", {
  locale,
  onLocaleChanged: (callback) => ipcRenderer.on("locale:changed", (_event, next) => callback(next)),
  config: () => ipcRenderer.invoke("config:get"),

  // 悬浮条
  onInput: (callback) => ipcRenderer.on("input", (_event, payload) => callback(payload)),
  onNotice: (callback) => ipcRenderer.on("notice", (_event, message) => callback(message)),
  onBarControls: (callback) => ipcRenderer.on("bar:controls", (_event, enabled) => callback(enabled)),
  setBarVisible: (visible) => ipcRenderer.send("bar:set-visible", visible),
  captureBarInput: (regions) => ipcRenderer.send("bar:capture", regions),
  setSystemMute: (on) => ipcRenderer.send("audio:mute", on === true),
  deliver: (payload) => ipcRenderer.invoke("dictation:deliver", payload),
  reportFailure: (payload) => ipcRenderer.invoke("dictation:failed", payload),

  onHotkeyChanged: (callback) => ipcRenderer.on("bar:hotkey", (_event, hotkey) => callback(hotkey)),

  // 主窗口：首页、历史记录
  appInfo: () => ipcRenderer.invoke("app:info"),
  listHistory: () => ipcRenderer.invoke("history:list"),
  usageReport: () => ipcRenderer.invoke("usage:report"),
  insights: () => ipcRenderer.invoke("insights:get"),
  copyText: (text) => ipcRenderer.invoke("clipboard:write", text),
  onHistoryChanged: (callback) => ipcRenderer.on("history:changed", () => callback()),
  onNavigate: (callback) => ipcRenderer.on("hub:navigate", (_event, target) => callback(target)),
  openHomepage: () => ipcRenderer.invoke("app:open-homepage"),

  // 主窗口：设置
  getSetup: () => ipcRenderer.invoke("setup:get"),
  onSetupChanged: (callback) => ipcRenderer.on("setup:changed", () => callback()),
  // provider 不写是正在用的那家；给别家存时 changes 是要一起换成的设置，拿它们验证
  saveKey: (key, provider, changes) => ipcRenderer.invoke("setup:save-key", key, provider, changes),
  forgetKey: (provider) => ipcRenderer.invoke("setup:forget-key", provider),
  // 某种模式按改后的设置能不能用：拿那家的 key 发一个最小的请求，不换掉正在用的
  checkModel: (mode, changes) => ipcRenderer.invoke("setup:check-model", mode, changes),
  // 模式这一层，和各模式里的模型（src/app/modes.mjs）
  setMode: (mode, changes) => ipcRenderer.invoke("setup:set-mode", mode, changes),
  setModel: (model) => ipcRenderer.invoke("setup:set-model", model),
  setTranscriber: (id) => ipcRenderer.invoke("setup:set-transcriber", id),
  setPolish: (polish, customUrl) => ipcRenderer.invoke("setup:set-polish", polish, customUrl),
  setModelSource: (id) => ipcRenderer.invoke("setup:set-model-source", id),
  // 本机模型：用户点了才下载；取消、删除（正在用的删不了）
  downloadModel: (id) => ipcRenderer.invoke("setup:download-model", id),
  cancelDownload: (id) => ipcRenderer.invoke("setup:cancel-download", id),
  deleteModel: (id) => ipcRenderer.invoke("setup:delete-model", id),
  // 检查本机模型：念一句交给它转，看能不能正常出字
  checkTranscriber: (id) => ipcRenderer.invoke("setup:check-transcriber", id),
  readClipboard: () => ipcRenderer.invoke("setup:read-clipboard"),
  openKeyPage: (provider) => ipcRenderer.invoke("setup:open-key-page", provider),
  openPrivacySettings: (permission) => ipcRenderer.invoke("setup:open-privacy", permission),
  recheckPermissions: () => ipcRenderer.invoke("setup:recheck"),
  setOpenAtLogin: (enabled) => ipcRenderer.invoke("setup:set-open-at-login", enabled),
  setHotkey: (hotkey) => ipcRenderer.invoke("setup:set-hotkey", hotkey),

  // 首次引导
  captureHotkey: (capturing) => ipcRenderer.send("onboarding:capture-hotkey", capturing),
  onOnboardingHotkey: (callback) => ipcRenderer.on("onboarding:hotkey", (_event, key) => callback(key)),
  finishOnboarding: () => ipcRenderer.invoke("onboarding:finish"),
  setTheme: (theme) => ipcRenderer.invoke("setup:set-theme", theme),
  setLanguage: (language) => ipcRenderer.invoke("setup:set-language", language),
});
