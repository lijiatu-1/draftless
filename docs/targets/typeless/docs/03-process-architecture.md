# 03 进程与窗口架构

来源：REA 对可读树的分析图（`ev_675220c1…`）给出窗口、IPC、预加载接口的位置，再到对应行读代码。

## 进程

| 进程 | 职责 |
| --- | --- |
| 主进程 | 窗口管理、HTTP 请求与签名、加密、数据库、调原生库、调度同步与更新 |
| 渲染进程 ×N | 每个窗口一个；悬浮条那个负责录音、听写状态机和 WebSocket |
| worker 线程 | Opus 编码：`chunkSessionWorker`（分块）、`opusWorker`（整段） |
| 键盘子进程 | `fork` 出来的 Node 进程，加载 `libKeyboardHelper` 跑全局按键监听（readable:main/index.js:12038） |
| 权限检查小程序 | `child-process-helper/bin/macos/macosCheckAccessibility`，单独进程里查辅助功能权限（readable:main/index.js:19145） |

按键监听放进子进程，推断是为了隔离：事件监听回调卡住会拖慢全系统的键盘输入，放在子进程里崩了也能重启（代码里有 `handleUnexpectedExit`、`restoreState`）。

## 窗口

六个页面（`dist/renderer/*.html`），对应六类窗口：

| 页面 | 用途 |
| --- | --- |
| `floating-bar.html` | 悬浮条。常驻，录音和听写状态机在这里 |
| `hub.html` | 主界面：历史、词典、设置、账号 |
| `login.html` | 登录 |
| `onboarding.html` | 首次引导 |
| `sidebar.html` | 侧边栏 |
| `interactive-card.html` | 结果卡片（"问任何事"模式的回答等） |

窗口共用一个命名会话 `persist:no-proxy-session`，创建时设了 `setProxy({ mode: "direct" })`（readable:main/index.js:4578）。也就是说**渲染进程的网络请求不走系统代理**，开着 Clash 之类也是直连。这是系统代理抓不到它 WebSocket 的原因。

REA 记录到的窗口选项里，显式设置的有 `contextIsolation: true`、`nodeIntegration: false`（19375 行那个窗口另有 `offscreen: true`）。

## 预加载暴露的接口

`dist/preload/index.mjs` 用 contextBridge 暴露三样东西（REA 图节点 `context-bridge-api` ×3）：

- `window.ipcRenderer`：`on` / `off` / `send` / `invoke` / `addKeyListener` / `removeKeyListener` / `platform`
- `window.typelessAppearance`：取当前深浅色
- `window.__SENTRY_IPC__`：Sentry 用

`ipcRenderer.invoke(通道, …参数)` 是**原样透传**，没有通道白名单。渲染层能调用主进程注册的任何通道。对逆向来说这是好事：挂上渲染进程的调试端口后，可以直接调主进程接口做探测。

## IPC 通道

主进程注册了 146 个 handler，其中 112 个通道名是字面量。按前缀归类：

| 前缀 | 数量 | 做什么 |
| --- | --- | --- |
| `page:` | 29 | 开关各窗口、悬浮条位置、开发者工具、打开链接 |
| `db:` | 16 | 历史记录增删查、保存音频、清理、旧表迁移 |
| `audio:` | 13 | 语音主接口、Opus 编码会话、静音、设备列表 |
| `sync-engine:transcription-history:` | 8 | 历史云同步的开关、状态、清空 |
| `file:` | 8 | 日志、录音目录、导出音频、导入词典 CSV |
| `auth:` | 6 | 登录、登出、取令牌 |
| `permission:` | 6 | 权限申请与诊断、开机自启、Dock 图标 |
| `rsa:` | 5 | 上下文加密：设公钥、加密 |
| `keyboard:` | 4 | 启停按键监听、把文字打进目标应用 |
| `updater:` | 4 | 检查、下载、安装更新 |
| 其余 | 13 | `i18n:`、`clipboard:`、`device:`、`release-notes:`、`test:`、`store:use`、`mixpanel:track-event`、`app:restart`、`context:get-app-icon`、`troubleshooting:get-system-info`、`enterprise-policy:updated` |

另有 45 处通道名是枚举常量，REA 标为"动态表达式"。读代码后确认的几组：

| 通道 | 做什么 |
| --- | --- |
| `focused-context:*`（7 个） | 焦点应用与输入框信息、选中文字、完整上下文、轮询参数 |
| `audio-context:get-audio-context` | 听写用的完整上下文 |
| `track-edit-text:start-track` / `stop-track` | 插入后的修改跟踪 |
| 键盘输入组（8 个） | 插入纯文本、插入富文本、重载快捷键、键盘设备列表 |

与主链路直接相关的通道：

```
audio-context:get-audio-context      取上下文
audio:opus-chunk-session-start       开始分块编码
audio:opus-chunk-session-encode      编码一块
audio:opus-chunk-session-end         结束
audio:opus-compress-by-audio-id      把整段录音压成 Opus（HTTP 兜底用）
audio:ai-voice-flow                  HTTP 兜底请求
audio:abort-ai-voice-flow-request    取消兜底
rsa:encrypt                          加密上下文
db:history-upsert                    写历史
keyboard:type-transcript             把成品文字贴进目标应用
track-edit-text:start-track          开始跟踪修改
```

## 本地存储

五个 electron-store（JSON 文件，位于 `~/Library/Application Support/Typeless/`）加一个 SQLite 库：

| 存储 | 文件 | 内容 |
| --- | --- | --- |
| `app-settings` | `app-settings.json` | 快捷键、麦克风、语言、历史保留时长、开机自启等设置；开发开关 `__DEV_API_HOST` 也读自这里 |
| `app-storage` | `app-storage.json` | 设备 ID、与服务器的时间差、登录数据 |
| `app-onboarding` | `app-onboarding.json` | 引导进度 |
| 窗口尺寸 | （名称未查） | `windowSizeMap` |
| 另一处 | （名称未查） | `lastSaveDirectory` |
| 数据库 | `typeless.db` | 历史记录，见 [08](08-local-data.md) |

`store:use` 是一个通用通道，渲染层通过它读写各个 store。

## 开发者留下的开关

| 开关 | 位置 | 作用 |
| --- | --- | --- |
| `__DEV_API_HOST` | `app-settings.json` | 设了就把 HTTP 和 WebSocket 的主机都换掉；主机名不含 `typeless.com` / `typeless.now` 时用明文 `http://`、`ws://`（readable:main/index.js:10134-10152，渲染层同逻辑在 UfR9-a2Z.js:7435） |
| `__debugForceWeakNetworkFallbackOnly` | 渲染层 localStorage | 强制只走 HTTP 兜底 |
| `page:open-devtools` | IPC | 打开各窗口的开发者工具 |
| `test:generate-test-records` 等 | IPC | 生成/清除测试历史记录 |
| `proxyUrl` | HTTP 客户端的属性 | 设了就走 undici 代理并关闭证书校验；没找到设置它的入口 |

这些在正式版里都还在。
