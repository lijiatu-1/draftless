import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { helperBinary } from "../cli/native-helper.mjs";
import { ALREADY_RUNNING_EXIT_CODE, startControlServer } from "../control.mjs";
import { createTranslator, LocalizedError, msg, problemOf, resolveLocale } from "../i18n/index.mjs";
import { alsoLogTo, log } from "../log.mjs";
import { chipOf, downloadSize, MODELS, makerOf, measuredOn, SOURCES } from "../models/catalog.mjs";
import { createLocalModels, freeBytesAt } from "../models/library.mjs";
import { CHAT_VENDORS, formatChatChoice } from "../server/chat/vendors.mjs";
import { describeRoute, keyVendorOf, MODES } from "../server/modes.mjs";
import { formatModelChoice, PROVIDERS } from "../server/providers/index.mjs";
import { findVendor, VENDORS } from "../server/vendors.mjs";
import { openHistory } from "../storage/history.mjs";
import { ensureHome, keyFile, resolvePaths } from "../storage/paths.mjs";
import {
  HOTKEY_IDS,
  hotkeyName,
  migrateSettings,
  overridingEnv,
  resolveSettings,
  routeOf,
  saveSetting,
} from "../storage/settings.mjs";
import { toHex } from "../themes/color.mjs";
import { themeCss } from "../themes/contract.mjs";
import { findTheme, THEMES } from "../themes/index.mjs";
import { insights } from "../usage/insights.mjs";
import { usageReport } from "../usage/report.mjs";
import { createDelivery } from "./delivery.mjs";
// 不直接 `from "electron"`：打出来的程序从 exe 启动时那条路会报具名导出不存在，
// 取法见 ./electron.mjs 里的说明。这里照样拿到 app、BrowserWindow 这些名字
import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} from "./electron.mjs";
import { startHelper } from "./helper.mjs";
import { createKeyManager } from "./keys/key-manager.mjs";
import { createKeyStore } from "./keys/key-store.mjs";
import { createModeSwitch } from "./modes.mjs";
import { startService } from "./service.mjs";
import { summarizeSetup, summaryAsText } from "./setup-state.mjs";

// 后台应用的主进程：两个窗口（悬浮条、主窗口）、菜单栏图标、原生小帮手、内置的听写服务，
// 以及页面和命令行要它代办的事。窗口用什么颜色由主题定（src/themes），这里负责把它交给每个窗口。
// 平时由 draftless 命令启动（src/cli），也可以打成应用双击启动。
// 结构对应原版的"主进程 + 悬浮条 + 主窗口（hub）+ 键盘子进程"（targets/typeless/docs/03-process-architecture.md）。

/** 调试用：设了就连这个地址上单独启动的服务端，不启动内置的那个 */
const EXTERNAL_SERVER_URL = process.env.DRAFTLESS_SERVER_URL ?? null;
/** 是 draftless 命令启动的：日志由它接到文件里，缺什么也由它在终端里说，这边不自己弹主窗口 */
const LAUNCHED_BY_CLI = process.env.DRAFTLESS_CLI === "1";

/** 读多少字的光标前文字当上下文。原版 cursor_state 的上限是 5000，我们用 500：一段话够判断场景了 */
const CONTEXT_MAX_CHARS = 500;

let PATHS;
let SETTINGS;
/** 启动时走哪条路线（server/modes.mjs）。之后可以在设置里改用别家（keys.use），正在走的以 service.route 为准 */
let ROUTE;
try {
  PATHS = resolvePaths(process.env);
  // 厂商换过默认模型的话，这里把设置文件里那个旧名字直接改掉（只改一次，之后文件里就是对的）。
  // 放在读设置之前：改完再读，读的路径上不用留任何兼容判断
  if (migrateSettings(PATHS.settingsFile)) {
    console.log(`设置里的旧默认模型已换成现在的默认值（${PATHS.settingsFile}）`);
  }
  SETTINGS = resolveSettings({ file: PATHS.settingsFile, env: process.env });
  ROUTE = routeOf(SETTINGS);
} catch (error) {
  // 路径或设置写错是使用上的问题，说一句人话就退出，不留一个按了热键没反应的进程
  console.error(error.message);
  process.exit(2);
}
/** 现在用哪个键。设置里可以当场换（setup:set-hotkey），换的时候重启小帮手 */
let hotkey = SETTINGS.hotkey.value;
/** 启动时用谁家的 key：原生链路是收音频的那家，本地转写链路是润色的那家。正在用的以 keys.provider 为准 */
const PROVIDER = keyVendorOf(ROUTE);
/** 思考档位只有 Gemini 有；别家用不上时是 null，状态里也不报 */
const thinkingFor = (provider) => (provider.thinkingLevels ? SETTINGS.thinking.value : null);
/**
 * 托盘图标：印章上的五道声波，多尺寸的 .ico 由 scripts/build/make-icon.mjs 从 assets/tray.svg 生成。
 * Windows 的托盘不会替我们把图标反色（那是 macOS 的 Template 图片才有的），所以这张图标自带浅深两套的对比度，
 * 任务栏是浅色还是深色都看得见。
 */
const TRAY_ICON = join(import.meta.dirname, "../../assets/tray.ico");
/** 关于里"在 GitHub 上看"打开的地方 */
const HOMEPAGE = "https://github.com/zephyr4123/draftless";
/** 这台机器是哪类芯片：本地模型的实测按它挑（models/catalog.mjs 的 CHIPS） */
const CHIP = chipOf();
/** 主窗口的大小，照原版（targets/typeless 的 hub 窗口：1080×750，最小 988×685） */
const HUB_SIZE = { width: 1080, height: 750, minWidth: 988, minHeight: 685 };
/** 悬浮条的窗口。比条本身大一圈：上面要放一行提示，四周要留出阴影，报错时条会变宽变高 */
const BAR_SIZE = { width: 380, height: 124 };
/**
 * 系统设置里要打开的页面。Windows 上只有麦克风这一项要用户自己去开：
 * 键盘和鼠标钩子不要授权（装不上就是安全软件拦了）；贴字被 UIPI 挡住时该看的是权限说明，不是某个开关。
 */
const PRIVACY_PANES = {
  microphone: "ms-settings:privacy-microphone",
};

/** 帮助里"贴不进去怎么办"指向的页面：讲清楚为什么管理员程序收不到模拟的按键 */
const UIPI_HELP = "https://learn.microsoft.com/windows/win32/winmsg/window-features";

// 所有东西都放在 paths.mjs 定的那一个目录里，命令行和这里用同一处。Electron 默认会按应用名在
// ~/Library/Application Support 下另开一个目录放 Chromium 的缓存和状态，把它也收进来，和我们的数据分开放
app.setPath("userData", PATHS.cacheDir);

// 打成应用后没有终端，日志自己写文件。由命令启动时标准输出已经被接到同一个文件里了
if (app.isPackaged) alsoLogTo(PATHS.logFile);

// 同一个家目录只跑一个。这里给的数据会随 second-instance 事件送到已经在运行的那一个手里
const isOnlyInstance = app.requestSingleInstanceLock({ byCli: LAUNCHED_BY_CLI });
if (!isOnlyInstance) {
  console.error("已经有一个在运行了");
  // 约定的退出码：启动它的 draftless 命令据此知道"不是没起来，是有别的先起来了"，接着等那一个
  app.exit(ALREADY_RUNNING_EXIT_CODE);
}

const sourceDir = join(app.getAppPath(), "src");
const webPreferences = { preload: join(sourceDir, "preload", "preload.cjs"), sandbox: true, contextIsolation: true };
// 窗口里只放我们自己的页面。几个窗口共用一份预加载脚本：拖进窗口的文件、页面里的链接要是把窗口带走了，
// 那个页面也能调到存 key、读历史、读剪贴板这些接口。开新窗口同理
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-navigate", (event, url) => {
    event.preventDefault();
    log.warn("navigation_blocked", { url: url.slice(0, 200) });
  });
  contents.setWindowOpenHandler(({ url }) => {
    log.warn("window_open_blocked", { url: url.slice(0, 200) });
    return { action: "deny" };
  });
});

// 不能写成顶层的 await app.whenReady()：Electron 要等主模块加载完才会就绪，
// 而顶层 await 让模块一直加载不完，两边互相等（Electron 44.7 实测如此）。
// 没抢到锁的那个正在退出，不往下走：家目录里的东西（进程号、控制通道）都是先到的那个的
if (isOnlyInstance) {
  app
    .whenReady()
    .then(main)
    .catch((error) => {
      // 启动失败时没有窗口可以报错，记下来并以非零码退出，不留一个什么都不干的进程
      log.error("startup_failed", { error: String(error?.stack ?? error) });
      app.exit(1);
    });
}

async function main() {
  // 装成应用时不要任务栏按钮：它平时待在托盘里，窗口开了才需要出场（而那时窗口自己会占到任务栏）
  if (app.isPackaged) app.setAppUserModelId("com.draftless.app");

  ensureHome(PATHS);
  // 记下进程号：万一卡住了不答话，draftless stop 靠它找到这个进程。要赶在控制通道开始听之前写好，
  // 这样只要通道连得上，文件里记的就一定是通道那头的进程
  writeFileSync(PATHS.pidFile, `${process.pid}\n`);

  const startedAt = new Date().toISOString();
  const history = openHistory(PATHS.historyDb);
  // 每家一把 key，各存一个文件。正在用的那家之外的也要在：draftless key openai、model check 要用
  const keyStores = Object.fromEntries(
    VENDORS.map(({ id }) => [id, createKeyStore({ file: keyFile(PATHS, id), safeStorage })]),
  );
  /** 本地模型的状态一变，菜单栏和主窗口跟着更新。菜单栏建好之前变的不用管：建的时候读的就是最新的 */
  let localModelChanged = () => {};
  // 本机的模型库：下载、取消、删除都由用户点。下好了、删了，服务按路线装上或卸掉
  const localModels = createLocalModels({
    dir: PATHS.modelsDir,
    source: SETTINGS.modelSource.value,
    log,
    // 只在用户点了下载、取消、删除之后才会来，那时服务早就建好了
    onChange: () => {
      service?.modelsChanged();
      localModelChanged();
    },
  });
  // 每次调模型记一笔账，开着的历史窗口跟着更新花费（记账出错由整理流程写日志，不连累听写）
  const service = EXTERNAL_SERVER_URL
    ? null
    : await startService({
        log,
        route: ROUTE,
        modelsDir: PATHS.modelsDir,
        models: localModels,
        onModelCall: (call) => {
          history.addCall(call);
          historyChanged();
        },
        onLocalModel: () => localModelChanged(),
        // 光标前的文字：模型靠它判断"在写代码还是写邮件"，从而决定整理力度。
        // 包一层函数是必须的——`helper` 要到下面才声明，直接写 helper ? … : … 会当场求值、
        // 撞上暂时性死区；包起来之后就是真正听写时才看它还在不在
        readContext: () => (helper ? helper.readContext(CONTEXT_MAX_CHARS) : Promise.resolve("")),
      });
  const serverUrl = EXTERNAL_SERVER_URL ?? service.url;
  const e2e = process.env.DRAFTLESS_E2E_OUT ? await import("./e2e.mjs") : null;

  const keys = createKeyManager({
    service,
    provider: PROVIDER,
    keyStores,
    env: process.env,
    log,
    onChange: () => setupChanged(),
    // 给不是正在用的那一家存 key 时拿哪条路线验证，由模式那一层说
    routeFor: (id) => modes.routeForVendor(id),
  });
  /** 切模式、换各模式里的模型（app/modes.mjs）。连着单独启动的服务端时这些都归那边，是 null */
  const modes = service
    ? createModeSwitch({ service, keys, models: localModels, settingsFile: PATHS.settingsFile, env: process.env, log })
    : null;
  /** 按键监听的小帮手：starting（还没报上来）/ running / stopped（退出了，或者根本没起来） */
  let helperState = "starting";
  /** 小帮手报上来的两项权限；它没在 running 时是 null */
  let helperPermissions = null;
  /** 控制通道，启动到后面才开；端到端测试时一直是 null */
  let control = null;
  /** 启动时对麦克风和 key 的检查做完了没有 */
  let startupChecked = false;
  let hubWindow = null;
  let onboardingWindow = null;
  /** 首次引导正在测快捷键：热键送到引导窗口，不去开悬浮条 */
  let hotkeyToOnboarding = false;

  // ---------- 界面语言 ----------

  /** 设置里的语言（system 是跟随系统）和这次实际用的那种。设置里改了当场换，不用重启 */
  let languageSetting = SETTINGS.language.value;
  let locale = resolveLocale(languageSetting, app.getPreferredSystemLanguages());
  /** 菜单栏用它；窗口里的页面各自按 locale 翻（预加载脚本一上来就同步来取） */
  let t = createTranslator(locale);
  ipcMain.on("locale:get", (event) => {
    event.returnValue = locale;
  });

  log.info("started", {
    version: app.getVersion(),
    hotkey,
    route: describeRoute(ROUTE),
    thinking: ROUTE.mode === "native" ? thinkingFor(PROVIDER) : null,
    theme: SETTINGS.theme.value,
    language: languageSetting,
    locale,
    system_languages: app.getPreferredSystemLanguages(),
    home: PATHS.home,
    server_url: serverUrl,
    packaged: app.isPackaged,
    by_cli: LAUNCHED_BY_CLI,
    e2e: Boolean(e2e),
  });

  // ---------- 能不能用、还差什么 ----------

  /** 正在用的那一家：连着单独启动的服务端时是设置里那家（用哪个由那边定，这里只是个名字） */
  const provider = () => (service ? keys.provider : PROVIDER);

  const currentSetup = () => ({
    providerName: provider().name,
    key: keys.current,
    localModel: service?.localModel ?? null,
    helper: helperState,
    // 三样东西的名字照旧（microphone / listen / trusted），这样设置的页面和文案不用分平台。
    // Windows 上后两样说的不是"系统给没给权限"，而是"小帮手那两把钩子装上没有"：
    //   listen  键盘钩子——装不上就听不到热键
    //   trusted 鼠标钩子——装不上就截不住 esc 和悬浮条上的点击
    permissions: {
      microphone: microphoneStatus(),
      listen: helperPermissions?.listen ?? null,
      trusted: helperPermissions?.trusted ?? null,
    },
  });

  /** 麦克风现在的状态。Windows 上只有"开着/关了"两种：系统在第一次要麦克风时问一次，之后按设置走 */
  function microphoneStatus() {
    try {
      return systemPreferences.getMediaAccessStatus("microphone");
    } catch {
      // 这个接口在个别系统版本上会抛错。查不了就当"没拦着"：真录不到音时悬浮条那边会说清楚
      return "granted";
    }
  }

  let offeredSettings = LAUNCHED_BY_CLI;
  /**
   * 还缺东西就打开首次引导，第一次启动的人不用猜下一步该干什么。只主动弹一次。
   * 由命令启动时不弹：那个人正看着终端，突然冒出一个窗口还会把他正要粘贴 key 的焦点抢走。
   * 几样检查是先后到的（key 要验证、小帮手要启动），都有了结论才判断，免得刚启动就误报。
   */
  function offerSettingsIfIncomplete() {
    const setup = currentSetup();
    if (offeredSettings || !startupChecked || setup.key.state === "checking" || setup.permissions.listen === null)
      return;
    const summary = summarizeSetup(setup);
    if (summary.missing.length === 0 && summary.degraded === null) return;
    offeredSettings = true;
    log.info("settings_offered", { missing: summary.missing, degraded: summary.degraded !== null });
    showOnboarding();
  }

  /** 上面任何一样变了都调一次：菜单栏和主窗口跟着更新 */
  function setupChanged() {
    refreshTrayMenu();
    hubWindow?.webContents.send("setup:changed");
    onboardingWindow?.webContents.send("setup:changed");
  }

  // ---------- 主题 ----------

  let theme = findTheme(SETTINGS.theme.value);
  // 每个窗口的预加载脚本一上来就同步来取，赶在页面画出第一帧之前
  ipcMain.on("theme:get", (event) => {
    event.returnValue = themeCss(theme);
  });
  /** 重新读一遍设置里的主题，开着的窗口当场换。别的设置要重启才生效，主题不用 */
  function reloadTheme() {
    theme = findTheme(resolveSettings({ file: PATHS.settingsFile, env: process.env }).theme.value);
    const css = themeCss(theme);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send("theme:changed", css);
    log.info("theme_changed", { theme: theme.id });
    return { theme: theme.id };
  }
  /** 窗口还没画出页面时的底色：和页面的底一样，免得深色模式下先闪一下白 */
  const windowBackground = () => toHex(theme.window[nativeTheme.shouldUseDarkColors ? "dark" : "light"].bg);

  // ---------- 悬浮条 ----------

  function createBar() {
    const { workArea } = screen.getPrimaryDisplay();
    const bar = new BrowserWindow({
      ...BAR_SIZE,
      x: Math.round(workArea.x + (workArea.width - BAR_SIZE.width) / 2),
      // 贴着屏幕可用区域的底边。条离底边多远由 bar.css 定
      y: workArea.y + workArea.height - BAR_SIZE.height,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // 不能抢焦点：焦点一旦离开用户正在用的输入框，文字就贴不进去了
      focusable: false,
      webPreferences,
    });
    // 整个窗口都点不到，鼠标事件原样落到它下面的应用上。条上的两个按钮不靠这个窗口收点击：
    // 点击一旦落在我们的窗口上，Windows 会把我们的窗口切到前面（和 macOS 一样），输入框照样丢焦点。
    // 所以点击是原生小帮手在事件到达任何窗口之前截下来的，见下面的 bar:capture
    bar.setIgnoreMouseEvents(true);
    // "连全屏程序也盖住"在 Windows 上是把窗口提到 screen-saver 这一级置顶
    // （macOS 那边的 setVisibleOnAllWorkspaces 在 Windows 上是空操作）
    bar.setAlwaysOnTop(true, "screen-saver");
    bar.loadFile(join(sourceDir, "renderer", "bar", "bar.html"));
    return bar;
  }

  const bar = createBar();
  /** 给悬浮条的页面发消息。退出途中窗口已经销毁，这时再发会抛错 */
  const tellBar = (channel, payload) => {
    if (!bar.isDestroyed()) bar.webContents.send(channel, payload);
  };
  const notify = (message) => tellBar("notice", message);
  ipcMain.on("bar:set-visible", (_event, visible) => {
    if (visible) {
      bar.showInactive();
      return;
    }
    bar.hide();
    // 条不在屏幕上时什么都不该截着。页面自己会说"不截了"，这里再说一遍是保险：
    // 万一它漏说了，esc 会一直被吞掉，在哪个应用里都按不出来
    helper.release();
  });
  // 页面崩了就更没人说"不截了"
  bar.webContents.on("render-process-gone", (_event, details) => {
    log.error("bar_gone", { reason: details.reason });
    helper.release();
  });
  // 录音期间静音系统输出：悬浮条说开始/结束，主进程转给小帮手（CoreAudio 在它那一侧）
  ipcMain.on("audio:mute", (_event, on) => {
    // helper 要到下面才声明（暂时性死区，踩过），在回调里到调用时才取就没事
    if (helper) helper.setSystemMute(on === true);
  });
  // 听写进行中，页面让小帮手把 esc 和条上两个按钮的点击截下来（null 是不截了）。
  // 页面给的是按钮在窗口里的位置，小帮手要的是在屏幕上的位置
  ipcMain.on("bar:capture", (_event, regions) => {
    if (regions === null) {
      helper.release();
      return;
    }
    if (!Array.isArray(regions)) {
      log.error("bar_capture_invalid", { type: typeof regions });
      return;
    }
    const origin = bar.getBounds();
    const onScreen = regions.map(({ id, x, y, width, height }) => ({
      id,
      x: origin.x + x,
      y: origin.y + y,
      width,
      height,
    }));
    // "点了按钮没反应"时先看这条：位置对不对得上屏幕上画的那两个圆
    log.info("bar_capture", { regions: onScreen });
    helper.capture(onScreen);
  });

  // ---------- 按键和贴字 ----------

  let helper = null;
  /** 每启动一个小帮手加一；旧的那个退出时发来的事件靠它认出来并丢掉 */
  let helperGeneration = 0;
  /** 小帮手截不截得住 esc 和点击（要辅助功能权限）。截不住时悬浮条不画那两个按钮 */
  let barControls = false;
  function setBarControls(enabled) {
    barControls = enabled;
    tellBar("bar:controls", enabled);
  }

  /**
   * @param {{ prompt: boolean }} options prompt：这项留着是为了和 macOS 版保持同一个调用形状。
   *   Windows 上没有"没给权限、要不要弹系统授权框"这回事：小帮手的钩子要么装上、要么被安全软件拦了，
   *   拦了就只能照实报，等用户自己去看。所以这里不再分两次启动。
   */
  function launchHelper({ prompt }) {
    const generation = ++helperGeneration;
    helperPermissions = null;
    helperState = "starting";
    setBarControls(false);
    helper = startHelper(helperBinary(app.getAppPath()), {
      args: ["--key", hotkey],
      onEvent: (event) => {
        if (generation === helperGeneration) onHelperEvent(event);
      },
      log,
    });
    log.info("helper_launched", { hotkey, prompt });
  }

  function onHelperEvent(event) {
    switch (event.event) {
      case "ready":
        helperState = "running";
        helperPermissions = { listen: event.listen, trusted: event.trusted };
        log.info("helper_ready", { ...helperPermissions, capture: event.capture });
        setBarControls(event.capture === true);
        setupChanged();
        offerSettingsIfIncomplete();
        break;
      case "hotkey":
      case "other_key": {
        // 首次引导正在测快捷键、人也正看着它：热键只送到引导窗口。
        // 切到别的应用了就照常听写，不然热键在哪都按不出来，还没有任何提示；
        // 悬浮条在屏幕上（切出去开了一段听写又切回来）时也给条，不然这一段停不下来
        if (event.event === "hotkey" && hotkeyToOnboarding && onboardingWindow?.isFocused() && !bar.isVisible()) {
          log.info("key_event", { event: event.event, down: event.down, to: "onboarding" });
          onboardingWindow.webContents.send("onboarding:hotkey", { down: event.down });
          break;
        }
        // 热键不灵时先看这条日志有没有：没有就是小帮手没收到按键（权限或键选错了）
        log.info("key_event", { event: event.event, down: event.down });
        const { blocker } = summarizeSetup(currentSetup());
        if (blocker === null) tellBar("input", event);
        else if (event.event === "hotkey" && event.down) notify(blocker);
        break;
      }
      case "escape":
      case "click":
        // 只在听写进行中才会有：那时页面让小帮手把它们截下来了
        // 字段不能叫 event：日志这一条的名字就记在 event 里，会被盖掉
        log.info("bar_input", { input: event.event, id: event.id });
        tellBar("input", event);
        break;
      case "exit":
        helperState = "stopped";
        helperPermissions = null;
        setBarControls(false);
        log.error("helper_exited", { code: event.code, signal: event.signal });
        setupChanged();
        notify(msg("bar.helperStopped", { hotkey: hotkeyName(hotkey) }));
        break;
      default:
        log.warn("helper_unknown_event", { event: event.event });
    }
  }

  // 端到端测试时不启动小帮手：不听真键盘，也绝不往用户当前的窗口里贴字
  if (e2e) helper = e2e.fakeHelper;
  else launchHelper({ prompt: true });

  // ---------- 页面要主进程代办的事 ----------

  const delivery = createDelivery({
    recordingsDir: PATHS.recordingsDir,
    history,
    paste: (text) => helper.paste(text),
    writeClipboard: (text) => clipboard.writeText(text),
    log,
  });
  function historyChanged() {
    hubWindow?.webContents.send("history:changed");
  }

  /**
   * 页面调用主进程。出错时 Electron 只把 message 带给页面，problem 丢了，而 LocalizedError 的 message 是英文：
   * 这种错在这边按界面语言翻好再抛（比如设置文件坏了时改热键，中文界面要说中文）
   */
  function handle(channel, listener) {
    ipcMain.handle(channel, async (...args) => {
      try {
        return await listener(...args);
      } catch (error) {
        if (error instanceof LocalizedError) throw new Error(t.text(error.problem), { cause: error });
        throw error;
      }
    });
  }

  handle("config:get", () => ({ serverUrl, hotkey, barControls }));
  handle("dictation:deliver", async (_event, payload) => {
    const result = await delivery.completed(payload);
    // 只记长度：成品是用户说的话，不进日志
    log.info("delivered", { audio_id: payload.audioId, text_length: payload.text.length, notice: result.notice });
    historyChanged();
    e2e?.onFinished({ delivered: payload.text, notice: result.notice });
    return result;
  });
  handle("dictation:failed", (_event, payload) => {
    delivery.failed(payload);
    log.warn("dictation_failed", { audio_id: payload.audioId, error: payload.error });
    historyChanged();
    e2e?.onFinished({ failed: payload.error });
  });
  handle("history:list", () => history.list());
  handle("usage:report", () => usageReport(history, { now: new Date() }));
  handle("insights:get", () => insights(history.dictations(), { now: new Date() }));
  handle("app:info", () => ({ version: app.getVersion(), hotkey }));
  handle("app:open-homepage", () => shell.openExternal(HOMEPAGE));
  // 贴不进管理员程序的窗口时（Windows 的 UIPI 会拦下模拟按键），悬浮条上说一句，并给一个"为什么"
  handle("app:open-uipi-help", () => shell.openExternal(UIPI_HELP));
  handle("clipboard:write", (_event, text) => {
    if (typeof text !== "string") throw new TypeError("要复制的不是文字");
    clipboard.writeText(text);
  });

  // ---------- 主窗口的设置要主进程代办的事 ----------

  handle("setup:get", () => {
    const setup = currentSetup();
    return {
      ...setup,
      summary: summarizeSetup(setup),
      // 叫什么由页面按界面语言写，这里只给 id
      hotkey: { value: hotkey, choices: HOTKEY_IDS },
      theme: { value: theme.id, choices: THEMES.map(({ id }) => id) },
      language: { value: languageSetting, locale },
      // 开机启动登记的是"这个应用"；从终端启动时登记上去的会是 Electron 本身，所以只在装成应用后开放
      openAtLogin: { supported: app.isPackaged, enabled: app.getLoginItemSettings().openAtLogin },
      home: PATHS.home,
      version: app.getVersion(),
      // 正在用 key 的那一家
      provider: describeVendor(provider()),
      ...describeModes(),
      // 连着单独启动的服务端时用哪种模式、哪家由那边定，这里换不了
      switchable: Boolean(service),
    };
  });

  /** 设置里要的一家的说明，带着它的 key 在哪（env / stored / null，不解密） */
  function describeVendor(found) {
    const sources = service ? keys.sources() : {};
    return {
      id: found.id,
      name: found.name,
      keyEnv: found.keyEnv,
      key: sources[found.id] ?? null,
      hasKeyPage: Boolean(found.keyPage),
      defaultModel: found.defaultModel ?? null,
      // 润色的那几家给出能挑的模型；收音频的那几家只有默认模型
      models: found.models ?? [],
    };
  }

  /**
   * 两种模式各自的设置：正在用的是哪种，native 选了哪个模型，local 两跳各选了什么。
   * 没在用的那种模式也要列：设置里可以先改好它，切过去时就用上
   */
  function describeModes() {
    const settings = resolveSettings({ file: PATHS.settingsFile, env: process.env });
    let freeBytes = null;
    try {
      freeBytes = freeBytesAt(PATHS.modelsDir);
    } catch (error) {
      log.warn("disk_space_unknown", { error: String(error) });
    }
    return {
      mode: { value: service?.route.mode ?? ROUTE.mode, choices: MODES.map(({ id }) => id) },
      native: { model: settings.model.value, providers: PROVIDERS.map(describeVendor) },
      local: {
        transcriber: settings.transcriber.value,
        transcribers: MODELS.map((model) => ({
          id: model.id,
          name: model.name,
          // 出自哪家，界面按它配图标
          maker: makerOf(model),
          license: model.license.name,
          bytes: downloadSize(model),
          // 下好了没有、正在下到哪、下过一半的有多少、上次为什么没下下来
          ...localModels.status(model.id),
          tags: model.tags,
          // 在这类芯片上的实测，跑得快的在前；没测过是空的
          measured: measuredOn(model, CHIP),
        })),
        chip: CHIP,
        // 模型目录那块磁盘还剩多少，查不了是 null
        freeBytes,
        // 本地模型从哪下：哪种模式里都能换
        source: { value: settings.modelSource.value, choices: SOURCES.map(({ id }) => id) },
        polish: settings.polish.value,
        customUrl: settings.customUrl.value,
        vendors: CHAT_VENDORS.map(describeVendor),
      },
    };
  }

  /** 这几件事归模式那一层管；连着单独启动的服务端时做不了 */
  const viaModes = (action) => (modes ? action(modes) : { ok: false, problem: msg("key.externalModel") });

  // 设置里和 draftless key 存 key、删 key，走的是同一处。
  // 给别家存 key 时可以带上要一起换成的设置（changes），拿它们验证：自定义服务没有默认模型，要连模型名一起给
  handle("setup:save-key", (_event, value, id, changes) =>
    keys.save(value, {
      provider: id ?? keys.provider.id,
      ...(id && changes && modes ? { route: modes.routeForVendor(id, changes) } : {}),
    }),
  );
  handle("setup:forget-key", (_event, id) => keys.forget({ provider: id ?? keys.provider.id }));
  // 设置里的"检查"：哪种模式里都能查，按页面上选的（还没换过去的）设置查
  handle("setup:check-model", (_event, mode, changes) => viaModes((m) => m.check(mode, changes ?? {})));
  // 模式这一层，和各模式里的模型：分开的几件事
  // 切模式时可以连带那种模式自己的设置（changes），比如第一次进 local 就用自定义服务
  handle("setup:set-mode", (_event, mode, changes) => viaModes((m) => m.switchMode(mode, changes ?? {})));
  handle("setup:set-model", (_event, model) => viaModes((m) => m.setModel(model)));
  handle("setup:set-transcriber", (_event, id) => viaModes((m) => m.setTranscriber(id)));
  handle("setup:set-polish", (_event, polish, customUrl) =>
    viaModes((m) => m.setPolish(polish, customUrl === undefined ? {} : { customUrl })),
  );
  // 本机模型：下载、取消、删除都由用户点；正在用的不能删（模式那一层管）
  handle("setup:download-model", (_event, id) => localModels.download(id));
  handle("setup:cancel-download", (_event, id) => {
    localModels.cancel(id);
    return { ok: true };
  });
  handle("setup:delete-model", (_event, id) => viaModes((m) => m.removeModel(id)));
  // 检查本机模型：按界面语言念一句交给它转
  handle("setup:check-transcriber", (_event, id) => viaModes((m) => m.checkTranscriber(id, { locale })));
  handle("setup:read-clipboard", () => clipboard.readText());
  handle("setup:open-key-page", (_event, id) => {
    // 自定义服务没有申请 key 的页面
    const { keyPage } = findVendor(id) ?? provider();
    if (!keyPage) throw new TypeError(`${id} 没有申请 key 的页面`);
    return shell.openExternal(keyPage);
  });

  handle("setup:open-privacy", async (_event, permission) => {
    if (!Object.hasOwn(PRIVACY_PANES, permission)) throw new TypeError(`不认识的权限：${permission}`);
    // 麦克风：Windows 没有 askForMediaAccess（那是 macOS/Linux 的接口）。直接开隐私设置那一页，
    // 用户在那一页把开关打开之后，页面下一次 getUserMedia 就能拿到麦克风
    await shell.openExternal(PRIVACY_PANES[permission]);
  });
  /**
   * 两把钩子是小帮手启动时装上的，装不上（安全软件拦了、系统刚更新过安全策略）之后要重启它才重试。
   * 它停了的话，这也是把它重新拉起来的办法。
   */
  function recheckPermissions() {
    if (!e2e) {
      helper.stop();
      launchHelper({ prompt: false });
    }
    setupChanged();
  }
  /** 启动时没连上网、先用着的 key，在后台再验一次。不等结果：没网时一等就是几十秒 */
  function reverifyKeyInBackground() {
    keys.reverify().catch((error) => log.error("key_reverify_failed", { error: String(error?.stack ?? error) }));
  }
  handle("setup:recheck", () => {
    recheckPermissions();
    reverifyKeyInBackground();
  });
  handle("setup:set-open-at-login", (_event, enabled) => {
    if (!app.isPackaged) throw new Error("从终端启动时不能设置开机启动");
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    log.info("open_at_login", { enabled: Boolean(enabled) });
    setupChanged();
  });
  handle("setup:set-hotkey", (_event, wanted) => setHotkey(wanted));
  handle("setup:set-theme", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "theme", wanted);
    reloadTheme();
    setupChanged();
    // 和热键一样：被环境变量盖着时，存是存下了，眼前不会变，要交代一句
    const variable = overridingEnv("theme", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-model-source", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "modelSource", wanted);
    reloadModelSource();
    const variable = overridingEnv("modelSource", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });
  handle("setup:set-language", (_event, wanted) => {
    saveSetting(PATHS.settingsFile, "language", wanted);
    // 是在设置的"通用"那一页换的：主窗口换好语言后回到这一页
    reloadLanguage({ hubTarget: { pane: "general" } });
    const variable = overridingEnv("language", process.env);
    return variable === null ? {} : { note: msg("notes.envRemove", { variable }) };
  });

  /**
   * 重新读一遍设置里的下载源，交给模型库：正在下的从新的源接着下，以后的下载也用它。不用重启
   * @returns {{ modelSource: string }} 实际用的那个（被环境变量盖着时是环境变量里的）
   */
  function reloadModelSource() {
    const { value } = resolveSettings({ file: PATHS.settingsFile, env: process.env }).modelSource;
    localModels.setSource(value);
    setupChanged();
    return { modelSource: value };
  }

  /**
   * 重新读一遍设置里的语言，变了就当场换：菜单栏重画，主窗口和首次引导重新加载（页面上的字都按新的语言写），
   * 悬浮条换掉翻译，下一句提示就是新的语言。不用重启
   * @param {{ hubTarget?: object }} [options] 主窗口重新加载后去哪一页；不给就留在原地
   */
  function reloadLanguage({ hubTarget } = {}) {
    languageSetting = resolveSettings({ file: PATHS.settingsFile, env: process.env }).language.value;
    const next = resolveLocale(languageSetting, app.getPreferredSystemLanguages());
    if (next !== locale) {
      locale = next;
      t = createTranslator(locale);
      refreshTrayMenu();
      tellBar("locale:changed", locale);
      if (hubWindow !== null) {
        if (hubTarget) hubWindow.loadFile(join(sourceDir, "renderer", "hub", "hub.html"), { query: hubTarget });
        else hubWindow.webContents.reload();
      }
      if (onboardingWindow) {
        // 重新加载后从头开始：正停在测快捷键那一步的话，热键别再交给它，到那一步时它会再要
        hotkeyToOnboarding = false;
        onboardingWindow.webContents.reload();
      }
      log.info("language_changed", { language: languageSetting, locale });
    }
    return { language: languageSetting, locale };
  }

  /**
   * 当场换热键：记进设置，重启小帮手让它听新的键，悬浮条的提示、菜单栏跟着换。不用重启整个应用
   * @returns {{ note?: object }} 有话要交代时（被环境变量盖着）带一句（msg）
   */
  function setHotkey(wanted) {
    if (!HOTKEY_IDS.includes(wanted)) throw new TypeError(`不认识的热键：${wanted}`);
    saveSetting(PATHS.settingsFile, "hotkey", wanted);
    if (wanted !== hotkey) {
      hotkey = wanted;
      log.info("hotkey_changed", { hotkey });
      // 和重新检查权限一样：先停旧的再起新的，旧的那个退出时的事件靠代数作废
      if (!e2e) {
        helper.stop();
        launchHelper({ prompt: false });
      }
      tellBar("bar:hotkey", hotkey);
      historyChanged();
      setupChanged();
    }
    const variable = overridingEnv("hotkey", process.env);
    return variable === null ? {} : { note: msg("notes.envNextLaunch", { variable }) };
  }

  // ---------- 菜单栏、主窗口和首次引导 ----------

  /**
   * Windows 的标题栏叠加要两个颜色：按钮符号和底。都跟主题走，
   * 深色主题下用白符号，浅色主题下用深符号，不然按钮会在深色标题栏上看不见。
   */
  function titleBarOverlay() {
    const colors = theme.window[nativeTheme.shouldUseDarkColors ? "dark" : "light"];
    return {
      color: toHex(colors.bg),
      symbolColor: toHex(colors.text ?? colors.bg),
      height: 40,
    };
  }

  /**
   * 把我们的窗口提到前面来。
   * macOS 上用 app.focus({ steal: true })，Windows 没有 steal 这个选项：先把自己这一摞提到最前，再要焦点。
   */
  function focusOurWindows() {
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed() || !window.isVisible()) continue;
      window.moveTop();
      window.focus();
    }
  }

  /**
   * 打开主窗口（已经开着就亮出来），可以顺带指定去哪一页。
   * @param {{ route?: "home" | "history", pane?: string }} [target] pane：设置里的哪一页，"auto" 是还差东西的那一页
   */
  function showHub(target = {}) {
    if (hubWindow === null) {
      hubWindow = createHub(target);
    } else if (target.route || target.pane) {
      hubWindow.webContents.send("hub:navigate", target);
    }
    hubWindow.show();
    // 这是个没有任务栏按钮的应用，不主动要一下焦点的话窗口会开在别的应用后面
    focusOurWindows();
  }

  function createHub(target) {
    const window = new BrowserWindow({
      ...HUB_SIZE,
      title: "Draftless",
      backgroundColor: windowBackground(),
      // 和原版一样把标题栏藏起来，红绿灯放进侧栏的左上角；Windows 上没有红绿灯，改用系统的标题栏叠加：
      // 最小化/关闭按钮照常在，颜色跟着主题走
      titleBarStyle: "hidden",
      titleBarOverlay: titleBarOverlay(),
      webPreferences,
    });
    // 第一次打开时去哪一页写在地址里：页面加载完之前发消息是收不到的
    const query = Object.fromEntries(Object.entries(target).filter(([, value]) => value));
    window.loadFile(join(sourceDir, "renderer", "hub", "hub.html"), { query });
    window.on("focus", () => {
      // 切回来时重读一遍：窗口开着过了夜，"今天"要换成新的一天；用户去系统设置里改完权限再切回来，状态跟着刷新
      window.webContents.send("history:changed");
      window.webContents.send("setup:changed");
    });
    window.on("closed", () => {
      hubWindow = null;
    });
    return window;
  }

  /** 首次引导（原版的 onboarding 窗口）：和主窗口一样大，标题栏的处理也一样 */
  function showOnboarding() {
    if (onboardingWindow === null) {
      onboardingWindow = new BrowserWindow({
        ...HUB_SIZE,
        title: "Draftless",
        backgroundColor: windowBackground(),
        titleBarStyle: "hidden",
        titleBarOverlay: titleBarOverlay(),
        webPreferences,
      });
      onboardingWindow.loadFile(join(sourceDir, "renderer", "onboarding", "onboarding.html"));
      onboardingWindow.on("focus", () => {
        // 用户多半是刚去安全软件里放行、或者刚插上麦克风再切回来：两把钩子要重启小帮手才看得到。
        // 都已经好了就不重启，免得测快捷键、说话时小帮手平白断一下
        const { listen, trusted } = helperPermissions ?? {};
        if (listen !== true || trusted !== true) recheckPermissions();
        else setupChanged();
      });
      onboardingWindow.on("closed", () => {
        onboardingWindow = null;
        hotkeyToOnboarding = false;
      });
      // 页面崩了就没人说"测完了"
      onboardingWindow.webContents.on("render-process-gone", (_event, details) => {
        log.error("onboarding_gone", { reason: details.reason });
        hotkeyToOnboarding = false;
      });
    }
    onboardingWindow.show();
    focusOurWindows();
  }

  ipcMain.on("onboarding:capture-hotkey", (_event, capturing) => {
    hotkeyToOnboarding = capturing === true;
  });
  handle("onboarding:finish", () => {
    log.info("onboarding_finished");
    onboardingWindow?.close();
    showHub({ route: "home" });
  });

  /** 菜单栏、双击图标要打开 draftless 时：引导还没走完就回到引导，走完了是主窗口 */
  const showMain = () => (onboardingWindow ? showOnboarding() : showHub());

  const trayIcon = nativeImage.createFromPath(TRAY_ICON);
  const tray = new Tray(trayIcon);
  // 图标读不出来时托盘上会是空的一格，找不到入口。记下来，并在工具提示里说一句
  if (trayIcon.isEmpty()) {
    log.error("tray_icon_missing", { path: TRAY_ICON });
  }
  // 双击托盘图标就是"打开"。macOS 上是点程序坞的图标（app.on("activate")），Windows 没有那回事
  tray.on("double-click", () => showMain());

  function refreshTrayMenu() {
    const summary = summarizeSetup(currentSetup());
    const headline = summary.ready
      ? t("tray.ready", { keycap: t(`hotkeys.${hotkey}.keycap`) })
      : summary.missing.length > 0
        ? t("tray.missing", { items: t.list(summary.missing) })
        : t("tray.preparing");
    // Windows 的托盘项没有"旁边写几个字"这回事（setTitle 只在 macOS 上有用），
    // 状态放进工具提示，鼠标停上去就能看到还差什么
    tray.setToolTip(`${t("tray.tooltip", { name: "Draftless" })}\n${headline}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: headline, enabled: false },
        ...(summary.degraded ? [{ label: t.text(summary.degraded), enabled: false }] : []),
        { type: "separator" },
        // 下面几项照原版菜单栏的菜单（tray_menu__*）
        { label: t("tray.open"), click: () => showHub({ route: "home" }) },
        { label: t("tray.history"), click: () => showHub({ route: "history" }) },
        { type: "separator" },
        { label: t("tray.settings"), accelerator: "Control+,", click: () => showHub({ pane: "general" }) },
        { type: "separator" },
        { label: t("tray.version", { version: app.getVersion() }), enabled: false },
        { label: t("tray.quit"), accelerator: "Control+Q", click: () => app.quit() },
      ]),
    );
  }
  refreshTrayMenu();
  localModelChanged = setupChanged;

  // 没有窗口时也继续待在托盘里
  app.on("window-all-closed", () => {});
  // 已经开着时又启动了一次。双击图标来的：把主窗口亮出来，让人知道它在哪。
  // draftless 命令来的（两条命令同时启动，后到的那个）：那个人正看着终端，不弹窗口
  app.on("second-instance", (_event, _argv, _cwd, additionalData) => {
    if (!additionalData?.byCli) showMain();
  });
  app.on("before-quit", () => {
    rmSync(PATHS.pidFile, { force: true });
    // 先让小帮手的事件作废：它接下来的退出是我们自己关的，不该再报"按键监听停了"
    helperGeneration++;
    helper.stop();
    history.close();
    localModels.close();
    // 应用正在退出，这两样关不干净也不拦着；记一笔方便排查
    service?.close().catch((error) => log.warn("service_close_failed", { error: String(error) }));
    control?.close().catch((error) => log.warn("control_close_failed", { error: String(error) }));
  });

  // ---------- 命令行要主进程代办的事 ----------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  /** 等小帮手把两项权限报上来，或者确定它起不来；最多等 3 秒 */
  async function helperReported() {
    for (let waited = 0; helperState === "starting" && waited < 3_000; waited += 50) await sleep(50);
  }

  /** 命令行说了它用哪种语言就按它的翻，没说（0.5 及以前的命令行）就按界面的 */
  const translatorFor = (wanted) => (wanted ? createTranslator(wanted) : t);
  /** 回给命令行的结果里那句 problem 翻成字：命令行（含旧版本的）和 --json 的读者都只认字 */
  const withProblemText = (result, say) => {
    if (!result) return result;
    const translated = { ...result };
    if (result.problem) translated.problem = say.text(result.problem);
    if (result.note) translated.note = say.text(result.note);
    return translated;
  };

  /** 交给命令行的状态。要给人看的话都按 say 的语言翻成字，原因见 summaryAsText */
  function describeStatus(say) {
    const setup = currentSetup();
    const route = service?.route ?? null;
    const native = route?.mode === "native";
    return {
      pid: process.pid,
      version: app.getVersion(),
      startedAt,
      // 启动时要等 key 验证完、麦克风的授权框有了回应，才算准备好
      starting: !startupChecked,
      hotkey,
      // 0.5 及以前的命令行靠它说热键叫什么
      hotkeyLabel: say(`hotkeys.${hotkey}.name`),
      // 连着单独启动的服务端时，用哪个模型由那边定
      provider: service ? keys.provider.id : null,
      // 每家的 key 在哪。装成应用的那个各存各的，命令行要靠这一项才知道
      keys: service ? keys.sources() : null,
      // 哪种模式、各用什么。model、thinking 只说 native 的：0.6 及以前的命令行把 model 当收音频的那家来读
      mode: route?.mode ?? null,
      model: native ? formatModelChoice(route.model) : null,
      thinking: native ? thinkingFor(keys.provider) : null,
      transcriber: route?.mode === "local" ? route.transcriber : null,
      polish: route?.mode === "local" ? formatChatChoice(route.polish) : null,
      theme: theme.id,
      // 设置里的语言（system 是跟随系统）和实际用的那种
      language: languageSetting,
      locale,
      // 装成应用的和命令启动的，权限和 key 各是一套：命令行据此决定该不该代它重启
      packaged: app.isPackaged,
      ...setup,
      key: withProblemText(setup.key, say),
      localModel: setup.localModel && withProblemText(setup.localModel, say),
      // 每个本机模型下好了没有、正在下到哪（命令行看下载进度用）
      localModels: localModels.list().map((model) => withProblemText(model, say)),
      summary: summaryAsText(summarizeSetup(setup), say),
    };
  }

  // 端到端测试不开控制通道：它自己驱动整个流程，没有命令行参与
  control = e2e
    ? null
    : await startControlServer({
        pipeName: PATHS.controlPipe,
        log,
        handlers: {
          /** recheck：把会自己变的几样重新看一遍再回答（用户刚去系统设置里改过、网刚连上时用） */
          async status({ recheck = false, locale: wanted }) {
            if (recheck) {
              const denied = Object.values(helperPermissions ?? {}).includes(false);
              if (denied || helperState === "stopped") recheckPermissions();
              reverifyKeyInBackground();
            }
            await helperReported();
            return describeStatus(translatorFor(wanted));
          },
          // provider 不给就是正在用的那一家（0.3 的命令行不给）。changes：要一起换成的设置（先存 key 再切模式、
          // 换模型时给），拿它们验证；自定义服务没有默认模型，不给就验证不了
          "set-key": async ({ key, provider, changes, locale: wanted }) => {
            const say = translatorFor(wanted);
            let route;
            try {
              route = provider && changes && modes ? modes.routeForVendor(provider, changes) : undefined;
            } catch (error) {
              return { ok: false, problem: say.text(problemOf(error)) };
            }
            return withProblemText(await keys.save(key, { provider, route }), say);
          },
          // 模式这一层，和各模式里的模型。都是当场换，不用重启
          "set-mode": async ({ mode, changes, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.switchMode(mode, changes ?? {})), translatorFor(wanted)),
          "set-model": async ({ model, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.setModel(model)), translatorFor(wanted)),
          "set-transcriber": async ({ transcriber, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.setTranscriber(transcriber)), translatorFor(wanted)),
          "set-polish": async ({ polish, customUrl, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.setPolish(polish, customUrl === undefined ? {} : { customUrl })),
              translatorFor(wanted),
            ),
          "forget-key": ({ provider } = {}) => keys.forget({ provider }),
          // native 的模型、local 第二跳的润色，各查各的
          "check-model": async ({ model, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.check("native", { model })), translatorFor(wanted)),
          "check-polish": async ({ polish, customUrl, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.check("local", customUrl === undefined ? { polish } : { polish, customUrl })),
              translatorFor(wanted),
            ),
          "reload-theme": reloadTheme,
          "reload-language": () => reloadLanguage(),
          "reload-model-source": () => reloadModelSource(),
          // 本机模型：下载在后台下，进度看 status 的 localModels
          "download-model": async ({ id, locale: wanted }) =>
            withProblemText(await localModels.download(id), translatorFor(wanted)),
          "cancel-download": ({ id }) => {
            localModels.cancel(id);
            return { ok: true };
          },
          "delete-model": async ({ id, locale: wanted }) =>
            withProblemText(await viaModes((m) => m.removeModel(id)), translatorFor(wanted)),
          // 念的那句跟着命令行的语言走
          "check-transcriber": async ({ id, locale: wanted }) =>
            withProblemText(
              await viaModes((m) => m.checkTranscriber(id, { locale: wanted ?? locale })),
              translatorFor(wanted),
            ),
          // 命令行的名字沿用窗口还分开时的叫法：show-settings 打开设置里还差东西的那一页，
          // 第一次启动时命令行会带上 onboarding，打开首次引导
          "show-settings": ({ onboarding = false }) => (onboarding ? showOnboarding() : showHub({ pane: "auto" })),
          "show-history": () => showHub({ route: "history" }),
          // 先把这次的回答发出去再退出
          quit: () => void setImmediate(() => app.quit()),
        },
      });

  // ---------- 启动时的检查 ----------

  const keyLoaded = keys.loadAtStartup();
  if (e2e) {
    const loaded = await keyLoaded;
    if (loaded.state !== "ready")
      throw new Error(`端到端测试需要能用的 key：${t.text(loaded.problem) || loaded.state}`);
    await e2e.run({
      bar,
      history,
      localModel: () => service?.localModel,
      downloadModel: (id) => localModels.download(id),
      quit: (code) => app.exit(code),
    });
    return;
  }

  // 麦克风的授权：Windows 上没有"启动时主动问一次"的接口（askForMediaAccess 只在 macOS/Linux 上有），
  // 系统是在页面第一次打开麦克风时弹框，之后按"设置 › 隐私和安全性 › 麦克风"走。
  // 所以这里只是把状态读一遍记进日志，真正的授权发生在录音器那边；录不到音时悬浮条会说清楚
  log.info("microphone_access", { granted: microphoneStatus() });
  await keyLoaded;
  startupChecked = true;
  setupChanged();
  offerSettingsIfIncomplete();
  // 已经开着时又去双击应用图标，系统不会再起一个，而是"重新打开"这一个：同样把主窗口亮出来。
  // 等启动检查做完才挂上，免得把启动本身也当成一次重新打开。macOS 上这个是 activate 事件，
  // Windows 上没有它；双击托盘图标那条在 refreshTrayMenu 之后已经挂了（tray.on("double-click")）
  if (process.platform === "darwin") app.on("activate", showMain);
}
