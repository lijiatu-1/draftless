# 开发

[README](../README.md) 讲的是怎么装、怎么用；这里是从源码跑、目录结构、打包，以及每一块为什么这么分。
和 macOS 版的对应关系、每一处平台差异的处理办法，在 [Windows 移植笔记](windows-port.md)；
这一版实际测到了哪一步，在[验证记录](verification.md)。

## 从源码跑

需要 Node 22.13 以上（用 23 的话要 23.4 以上）。Windows 上不用另装编译器：原生小帮手用系统自带的
.NET Framework 4 里的 `csc.exe` 编（路径固定在 `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\`；
装在别处的话用 `DRAFTLESS_CSC` 指过去）。

```powershell
npm install                   # 装依赖；postinstall 会把 Electron 的二进制补上
npm start                     # 就是 draftless；子命令写在 -- 后面，比如 npm start -- status
npm run check                 # 代码检查 + 全部测试（不联网、不开窗口）
npm run dist                  # 打 dist\Draftless-win32-x64\，双击里面的 Draftless.exe
npm run icons                 # 从 assets 里的 svg 重新生成 app.ico / tray.ico
npm run native                # 只编原生小帮手
```

从源码跑的和装好的用的是同一个 `%USERPROFILE%\.draftless`，想分开就设 `DRAFTLESS_HOME`
（要用绝对路径）。

要真调模型的命令需要环境里有那一家的 key（`GEMINI_API_KEY`、`OPENAI_API_KEY`）。

## 目录

| 目录 | 内容 |
| --- | --- |
| `main.cjs` | Electron 的入口（CommonJS）。为什么不是 `.mjs`，见[移植笔记](windows-port.md#那个入口文件为什么是-commonjs) |
| `bin/`、`src/cli/` | `draftless` 命令 |
| `src/app/` | 后台应用的主进程（Electron）：悬浮条、托盘、主窗口、首次引导；`keys/` 是 key 的保存和启用；`electron.mjs` 是拿 Electron API 的那一层 |
| `src/renderer/`、`src/preload/` | 各个窗口的页面，一个窗口一个目录：`bar/`（悬浮条）、`hub/`（主窗口）、`onboarding/`（首次引导），共用的在 `shared/` |
| `src/platform/` | Windows 专属的那一层：`hotkeys.mjs` 是热键的名字和别名（唯一写死哪几个键的地方） |
| `src/themes/` | 主题：要哪些颜色、每套给什么值 |
| `src/i18n/` | 界面语言：每种语言一个文案文件，跟随系统时怎么挑、翻译函数 |
| `src/server/` | 听写服务：`protocol/` 收分块音频，`refine/` 交给模型整理，`providers/` 每家一个适配器，`audio/` 解码和重采样，`asr/` 本地转写，`modes.mjs` 两种识别模式 |
| `src/models/` | 本地模型的配置表 `catalog.mjs`（全局只有这一份）和下载/校验/删除 |
| `src/usage/` | 用量报表和首页统计 |
| `src/storage/` | `%USERPROFILE%\.draftless` 里的东西：放在哪、设置、历史库 |
| `src/control.mjs`、`src/log.mjs` | 命令行和后台之间那条命名管道、日志 |
| `native-win/` | 原生小帮手的 C# 源码：热键钩子、贴字（剪贴板 + SendInput）、听写中拦 Esc 和点击 |
| `assets/` | 图标：`icon.svg` 是那方印，`tray.svg` 是托盘上的五道；`app.ico`/`tray.ico` 由 `npm run icons` 生成 |
| `scripts/build/` | 开发用的脚本：编小帮手、生成图标、补 Electron 二进制、打包、PowerShell 安装脚本 |
| `test/` | 自动测试，目录和 `src/` 对应 |
| `docs/targets/typeless/` | 对 Typeless 的[逆向分析](targets/typeless/README.md)，18 篇。Draftless 的协议和交互照着它 |

## 加一家模型

在 `src/server/providers/` 下写一个适配器（请求怎么拼、收哪些录音格式、报错怎么认），
在同目录的 `index.mjs` 里登记一行。整理流程（提示词、收尾、重试、转格式）各家共用，在 `src/server/refine/`。

## 加一个本地转写模型

1. 在 `src/models/catalog.mjs` 加一项：原始地址钉在某一次提交上，每个文件写上大小和 sha256，注明许可。
   它用的运行库要在 `src/server/asr/engines/` 登记过。
2. 在 `bench/lib/candidates.mjs` 加一个候选，跑一轮评测，把实测数字填回配置表的 `measured`。

**Windows 上的实测**：目录里现有的 `measured` 全是 Apple 芯片的，Windows 上会显示"还没有在这类机器上实测"。
要补的话照着 `bench/` 里那套跑一轮，`chip` 写 `windows-x64`。**不要**把 Apple 芯片的数字改个标签填过来。

## 加一种界面语言

照 `src/i18n/locales/en.mjs` 写一个文件，在 `src/i18n/index.mjs` 的 `LOCALES` 里登记一行。
缺了哪句、参数对不上、单复数写法这种语言没有，`test/i18n/` 会指出来。

## 改原生小帮手

`native-win/` 下的几个 `.cs`：

| 文件 | 管什么 |
| --- | --- |
| `Program.cs` | 入口：命令行参数、读标准输入、分发命令 |
| `Hooks.cs` | 两个低层钩子、热键状态机、拦截 esc 和点击 |
| `Clipboard.cs` | 剪贴板快照/还原、写文字 |
| `Protocol.cs` | 一行一个 JSON 的读写（按 UTF-8，不走控制台的代码页） |
| `Json.cs`、`Win32.cs` | 小 JSON 解析、Win32 声明 |

改完跑 `npm run native` 重编。`src/cli/native-helper.mjs` 会比对源码的 SHA-256，所以第一次启动时也会
自动重编；重编之前要先把正在跑的 draftless 停掉——exe 被占着时删不掉，会报 EPERM。

## 打包

`npm run dist` 打出来的东西：

```
dist\Draftless-win32-x64\
  Draftless.exe            Electron 的运行时
  resources\app\           代码、编好的小帮手、图标、node_modules
```

打的时候会：编小帮手 → 摆一个只含运行时依赖的暂存目录 → 交 `@electron/packager`。
暂存那一步默认跑 `npm install`；网络不通时可以用 `node scripts/build/package.mjs --reuse-node-modules`
直接拷本机已经装好的 `node_modules`（只在本机试用）。

没有签名、没有 NSIS 安装包。装是用 `scripts/build/install.ps1`：拷贝到 `<家>\app`、建开始菜单快捷方式、加 PATH。

## 发布

这一版没有接发布链（macOS 那份的 COS + dmg 那套没有对应物）。要让 `draftless update` 有用，
需要在一个**网址前缀或本机目录**下放 `latest.txt`（一行一个版本号），然后用 `DRAFTLESS_INSTALL_BASE`
指过去——`draftless update` 只问版本、告诉人怎么换，不自动替换。
