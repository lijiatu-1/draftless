# Windows 移植笔记

FastSpeak 是先[把 Typeless 的客户端逆向了一遍](targets/typeless/README.md)（18 篇中文笔记：进程架构、语音链路、
网络协议、上下文采集、状态机、投递、更新……），再按它的协议和交互在 Windows 上实现的。

这份笔记记的是**每一处平台差异为什么这么处理**，以及**哪些是 Windows 的边界、不是没做**。
原版是 macOS 应用，所以「和原版一致」的地方说的是行为和协议；平台层（Swift 小帮手、钥匙串、Unix 套接字、.app 打包）
在 Windows 上全部换掉了，换成什么、为什么这么换，就是下面这些。

## 一、总览：哪些搬了，哪些重写了

| 子系统 | 怎么处理的 |
| --- | --- |
| 听写协议、音频解码与重采样、模型整理流程、几家的适配器、用量统计、主题、文案内核 | **原样搬**，一行没改 |
| `models/catalog.mjs` 的 `CHIPS` | 本来就有 `windows-x64` / `windows-arm64`，`chipOf()` 现成可用 |
| 本地转写的运行库（sherpa-onnx、transcribe.cpp） | 原样，加速后端由运行库自己挑 |
| 原生小帮手（热键、贴字、拦截） | **重写**：Swift → C#（`native-win/`），协议不变 |
| key 的存放 | **换实现**：钥匙串 → DPAPI（Electron 的 safeStorage） |
| 控制通道 | **换传输**：Unix 套接字 → 命名管道 |
| 进程管理 | **换命令**：`ps` / SIGTERM → CIM / taskkill |
| 权限模型 | **换语义**：TCC 三项 → 麦克风 + 两把钩子 |
| 托盘、窗口、图标 | **换做法**：Template 图片、`trafficLightPosition` → `.ico`、`titleBarOverlay` |
| 打包、安装、更新 | **重写**：codesign/dmg → @electron/packager + PowerShell 安装脚本 |
| 数据目录 | `%USERPROFILE%\.fast-speak` |

## 二、原生小帮手：为什么是 C#，而且必须是独立进程

macOS 版把三件事交给一个 Swift 小程序：听全局热键、模拟 ⌘V 贴字、听写中拦下 `Esc` 和悬浮条上的点击。

**先试过不写原生代码**：用 [koffi](https://koffi.dev) 在 Electron 主进程里直接调 Win32。钩子能装上
（`SetWindowsHookExW(13)`/`(14)` 实测都返回了有效句柄），但有一个硬伤——低层钩子的回调必须装在
**跑消息循环的那个线程**上，而那个线程一回调 JS，Node 的主线程就被饿死：实测主线程的定时器
1.2 秒只跑了 2 拍（正常 12 拍）。这条路上"钩子收到按键 → JS 处理 → 决定吞不吞"根本走不通。

所以退回 macOS 版的做法：一个独立的 `fast-speak-helper.exe`，和主进程用"一行一个 JSON"说话。
编译用 Windows 自带的 .NET Framework 4 里的 `csc.exe`（路径固定，不用装 SDK）：
`src/cli/native-helper.mjs` 会比对源码的 SHA-256，变了才重编。

**这不是"没做"，而是 Windows 只给了这一条能用的路。**

### 热键：映射和取舍

| macOS | Windows | 说明 |
| --- | --- | --- |
| `right_option` | `right_alt`（默认） | 同一个位置。右 Alt 单按在带菜单栏的程序里会去聚焦菜单——Windows 的行为，需要在文案里说清楚 |
| `right_command` | `right_win` | 那个位置上的键。右 Win 单按会被系统当成开始菜单，所以不当默认 |
| `right_control` | `right_ctrl` | 同名换位 |
| `fn` | `right_shift` | Windows 没有 fn，退到同一个"右手小指"的习惯 |

旧名字作为**输入别名**保留（`src/platform/hotkeys.mjs`）：设置文件里写着 `fn` 也认，规整成 `right_shift`。
左右两边的修饰键都认——macOS 版只认右边，但 Windows 上左右 Alt 在绝大多数程序里是同一个键，按错边不该判成"热键没反应"。

### 贴字：剪贴板那点事

流程和 macOS 版一样：存剪贴板 → 换成要贴的文字 → 发 Ctrl+V → 0.3 秒后把原来的还回去。

**带"别记我"的标记。** 逆向笔记 `07` 的备忘第 3 条要求"写入（带临时标记）"：macOS 上那是一个
`NSPasteboardType.transient`，让剪贴板工具不把这次写入记进历史。Windows 上没有这个类型，
对应物是三个剪贴板格式（`native-win/Clipboard.cs` 的 `MarkNotForHistory`）：

- `CanIncludeInClipboardHistory` = 0：Win+V 的历史不收这次
- `CanUploadToCloudClipboard` = 0：跨设备云剪贴板不收
- `ExcludeClipboardContentFromMonitoring`：剪贴板管理器之间的"本次别处理"约定

不打这几个标记的话，你对着 FastSpeak 说的话会留在 Win+V 里——本来只是要贴进输入框的东西，
不该在剪贴板历史里留一份。`--selftest` 里有一项 `not_for_history_markers` 专门盯这三个格式名
系统认不认（`RegisterClipboardFormat` 返回 0 就是没有这个格式，标记写了也白写）。

差别在还原的粒度：macOS 的 NSPasteboard 一个 item 可以带多种类型、按 item 分组还原；Windows 的剪贴板是
一张"格式 → 数据"的表，没有分组，所以按格式逐个存、逐个还。两个已知边界：

- **延迟渲染的格式存不下来**（句柄是空的，真正的数据等系统来问）。还原时只能丢掉那一种。
- **`CF_BITMAP` 是 GDI 句柄而不是 HGLOBAL**，存不了；它一般和 `CF_DIB` 一起在，所以图片通常还原得回来。

### 贴不进去：先问一句，再决定

Windows 不允许低权限进程往高权限窗口发按键（UIPI）。目标程序是"以管理员身份运行"时，`SendInput`
**不报错**，但前台窗口收不到——如果只看 `SendInput` 的返回值，就会报"贴好了"，而用户什么都没看到。

所以发之前先比一次权限：取前台窗口所属进程的令牌，看它有没有被提权；我们没提权、对面提权了，
就直接回 `uipi_blocked`，让悬浮条说"管理员权限的窗口收不到模拟按键：文字已复制，按 Ctrl+V 粘贴"。
这正是逆向笔记 `14` 的备忘第 1 条（"插入后检查输入框是否可编辑，不可编辑就给复制兜底"）
在 Windows 上的落地方式——那边用辅助功能问"能不能写"，这边用令牌问"发不发得进去"。

**贴失败时剪贴板不还原。** 只有贴出去了才在 0.3 秒后把原来那份还回去；`uipi_blocked` /
`input_blocked` 时文字就留在剪贴板里，那句"按 Ctrl+V"才是真的。`clipboard_busy`（连存都存不下来、
根本没写过）这一路由主进程补写一次；主进程也写不进去时，悬浮条改说"成品在历史里，从那里复制"。
一句话：不管哪条路失败，用户都不会丢字，也不会听到一句假话。

### 为什么发的是 `VK_V` 而不是"按当前布局找那个键"

笔记 `07` 说 macOS 版用 `findKeyCodeForCharacter` 配合键盘布局（`UCKeyTranslate`）找 V 的键码，
这样非 QWERTY 布局下也贴得对。Windows 上这一层的语义不一样：快捷键（accelerator）是按
**虚拟键码**注册的，`Ctrl+V` 在绝大多数程序里就是 `VK_V`（0x56）。按布局去找字符 'V' 对应的键码，
在 Dvorak 上会得到 K 键——那反而贴不出来。所以这里固定发 `VK_V`，是正确的做法，不是省略。

## 三、控制通道：命名管道

命令行和后台应用之间原来是数据目录里的一个 Unix 套接字。Windows 上换成命名管道：

```
\\.\pipe\fastspeak-<sha256(用户名 + 数据目录) 前 16 位>
```

- 名字里带数据目录的指纹：同一台机器上同时跑着从源码起的和装好的两份时不会串。
- 没有"路径太长"那条限制，也没有权限位可设——管道的访问控制由系统按用户做。
- 进程一没，管道就没了，不用清残留文件。`node:net` 的 `listen`/`connect` 本来两种都认，
  所以 `src/control.mjs` 除了"地址是什么、怎么清"之外一行没改。

## 四、权限：TCC 三项 → 麦克风 + 两把钩子

macOS 上要用户授权三项：麦克风、输入监控、辅助功能。Windows 上只有一项要用户动手：

| 名字（沿用 macOS 的键名） | Windows 上是什么意思 |
| --- | --- |
| `microphone` | 系统的麦克风隐私开关（`ms-settings:privacy-microphone`） |
| `listen` | **键盘钩子装上了没有**——没装上就听不到热键 |
| `trusted` | **鼠标钩子装上了没有**——没装上就拦不住 `Esc` 和悬浮条上的点击 |

后两样不要授权：普通权限的进程就能装低层钩子。装不上的原因通常是安全软件拦了，或者进程没有桌面会话。
界面上把它们显示成"已装上 / 没装上"，不带"授权"按钮——`openPrivacySettings("listen")` 在 Windows 上
没有对应的设置页，给个按钮只会点出一个错。

## 五、托盘、悬浮条、窗口

| macOS 的做法 | Windows 上换成 | 为什么 |
| --- | --- | --- |
| 菜单栏 Template 图片（系统自动反色） | `assets/tray.ico`，自己带深色底 | Windows 不替我们反色 |
| `Tray.setTitle()` 在图标旁边写字 | `setToolTip()` + 右键菜单首行 | Windows 的托盘项没有"旁边写字"这回事 |
| `app.on("activate")`（点程序坞图标） | `tray.on("double-click")` | Windows 没有那个事件 |
| `titleBarStyle: "hidden"` + `trafficLightPosition` | 同 hidden + `titleBarOverlay` | 整个藏掉标题栏会连最小化/关闭按钮一起没了，页面里又没有替代控件 |
| `setVisibleOnAllWorkspaces` | `setAlwaysOnTop(true, "screen-saver")` | Windows 上前者是空操作 |
| `app.focus({ steal: true })` | `window.moveTop()` + `focus()` | steal 是 macOS 的选项 |
| 悬浮条收不到点击（`setIgnoreMouseEvents`）+ 原生截点击 | **不变** | Windows 上也一样：点击一旦落到我们的窗口上就会把前台切换掉，输入框照样丢焦点 |

## 六、存储、key、数据目录

- 数据目录 `%USERPROFILE%\.fast-speak`，布局和 macOS 版一样（`data/`、`models/`、`logs/`、`run/`、`cache/`）。
- key 还是每家用一个 `<厂商>-key.bin`，加密换成 Electron 的 `safeStorage`（背后是当前用户的 DPAPI）。
  **能承诺的边界不一样了**：macOS 的钥匙串按应用隔离，别的应用读不到；DPAPI 按用户隔离，
  同一个用户下的其他程序也解得开。所以这里承诺的是"离开这台机器、这个用户就解不开"。
- 没有"0.7.0 及以前 App 另存的那份 key"要合并：一开始就只有一个文件。

## 七、进程管理和卸载

- 看一个进程跑的是什么：`ps -o command=` → `Get-CimInstance Win32_Process`（PowerShell 拿得到命令行）。
- 结束进程：Windows 没有 SIGTERM/SIGKILL 两级。先请它自己 `quit`，不听话就 `taskkill /PID <pid> /T /F`
  （连它起的转写进程和小帮手一起）。
- 命令行入口：装好的程序里带着 `fastspeak`，PATH 里那一条由安装脚本加；npm 全局装的时候用 npm 自己的 `.cmd` 壳。

## 八、打包

- `npm run dist` → `dist/FastSpeak-win32-x64/FastSpeak.exe`，一个能双击、也能整个目录拷走的程序。
- `scripts/build/install.ps1` 把它装进 `%USERPROFILE%\.fast-speak\app`、建开始菜单快捷方式、给 PATH 加一条。
- 没有代码签名：第一次运行 SmartScreen 会拦（"更多信息 › 仍要运行"）。

### 命令行的入口：装了之后 `fastspeak` 怎么跑

装好的那份只有一个 `FastSpeak.exe`。`install.ps1` 在 `<家>\bin` 下建一个 `fastspeak.cmd`，
把 `<家>\bin`（不是 `<家>\app`）加进 PATH：

- 为什么不加 `<家>\app`：那里面的 `FastSpeak.exe` 和命令同名（Windows 的文件名不分大小写），
  而 `PATHEXT` 里 `.EXE` 排在 `.CMD` 前面，敲 `fastspeak` 会先命中 exe、弹出窗口而不是跑子命令。
- `.cmd` 里只有一个环境变量和一条命令：`set FASTSPEAK_ARGV_MODE=cli` 然后
  `"<家>\app\FastSpeak.exe" %*`。为什么不用 `--cli` 这种开关：Electron 会把不认识的 `--xxx`
  当成自己的参数直接拒掉（实测报 `bad option: --cli`），轮不到应用代码。
- `main.cjs` 认这个变量：把 `process.argv` 余下的部分交给 `src/cli/main.mjs`，跑完就退出，
  不弹窗口。顺手还把 Chromium 的 `userData` 挪进我们自己的 `cache\` 并关掉硬件加速——
  否则跑一条 `fastspeak status` 就会在 `%APPDATA%\FastSpeak` 下留一堆 GPU 缓存。

从源码跑的时候不走这条：`bin/fastspeak.mjs` 是 npm 的 bin，直接是 Node 脚本。

### 那个入口文件为什么是 CommonJS

`package.json` 的 `main` 指向 `main.cjs`，不是 `src/app/main.mjs`。踩到的坑：

- 在 ESM 里 `import { app, BrowserWindow } from "electron"` 只在"用 app 目录启动"时成立；
- 从打包好的 exe 双击启动时，那条具名导入会报 `The requested module 'electron' does not provide an
  export named 'BrowserWindow'`，进程直接退出，连日志都来不及写；
- 同一份代码用 `electron.exe <app 目录>` 起就完全正常（开发时 `fastspeak start` 走的就是这条）。

`main.cjs` 是 CommonJS：用 `require` 拿到真的 electron 对象挂到 `globalThis` 上，
`src/app/electron.mjs` 里"先静态 import、不行就退回那一份"。两边写法都不用跟着变。

### 更新

这一版**只问版本，不自动换程序**。`FASTSPEAK_INSTALL_BASE` 指一个网址前缀或本机目录，那里放一个
`latest.txt`（一行一个版本号）。`fastspeak update` 会告诉你有没有新的、怎么换（下载新的发布包、
解到同一个地方，或者重跑安装脚本）。没配这个变量时会明说"这一版没有配置更新源"。

为什么不做自动替换：Windows 上让正在运行的 exe 自己替换自己要绕过文件占用、杀毒软件的写入拦截、
UAC 提权，第一版不碰这条线。

## 九、本地模型

模型文件（`.onnx` / `.gguf`）和平台无关，照旧从同一个源下载、核对 SHA-256。
运行库的 Windows 版由 npm 的 optionalDependencies 提供（`sherpa-onnx-win-x64`、
`@transcribe-cpp/win32-x64-cpu-vulkan`），装的时候按本机自动选。

**没有在 Windows 上跑过一轮实测**：界面上"实测"那一栏沿用目录里标着 `apple-silicon` 的数字，
在 Windows 上 `measuredOn(model, "windows-x64")` 返回空，会显示"还没有在这类机器上实测"。
拿 Mac 的数字冒充 Windows 的实测是不可接受的，所以宁可让它空着。

## 十、文案

两份语言文件（`src/i18n/locales/{en,zh-CN}.mjs`）里的键一个没增删（除了新功能必需的几个），
只把值换成了 Windows 的说法：系统设置路径、Ctrl+V、托盘、任务管理器、DPAPI、csc.exe。
`test/i18n/catalogs.test.mjs` 会检查两份的键结构和 HTML 里的默认文字都对得上。
`apple-silicon` / `metal` 这类芯片和加速器标签留着：目录里那些实测数字是按它们标的。
