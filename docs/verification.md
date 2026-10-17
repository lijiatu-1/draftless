# 验证记录

这一版**实际跑到了哪一步**。没跑过的、跑不了的分开写，不拿"应该没问题"顶替。

跑这些的时候是 2026-10-17，Windows 11 家庭版中文版（26200）、x64、Node 24.15.0、
.NET Framework 4.0.30319（系统自带）。测试环境：`FASTSPEAK_HOME` 指到临时目录，不碰真实数据。

## 一、能重复跑的（命令 + 真实输出）

### 代码检查和单测

```
$ npm run lint
Checked 226 files in 131ms. No fixes applied.

$ npm test
ℹ tests 779            ← 单测（npm run test:unit）
ℹ pass 779
ℹ fail 0
ℹ tests 6              ← 安装脚本（npm run test:install）
ℹ pass 6
ℹ fail 0
```

785 条全过（779 单测 + 6 安装脚本）。移植过程中的起点是同一条命令 **762 条、708 过、54 挂**——
那 54 条挂的全是"断言的是 macOS 的行为"（`swiftc`、钥匙串、Unix 套接字、`.app`、`head`、`/tmp` 之类）。
处理分三类：

- **删掉** macOS 专属、Windows 上没有对应物的用例（签名/公证、dmg 发布布局、swiftc、钥匙串合并、
  `install.sh` 的十几条），每处都留了一行中文注释说明它原来管什么、为什么不再适用。共删 10 条。
- **重写**换了实现的那几块：控制通道（套接字 → 命名管道）、后台起停（SIGTERM/SIGKILL → taskkill）、
  更新（安装脚本换 .app → 只问版本）、卸载（符号链接清单 + 钥匙串 → 直接删目录）、
  路径布局、key 的存取（`oldFile` 和 `0o600` 没有了）、安装脚本（bash 的 `install.sh` → PowerShell 的
  `install.ps1`，6 条：装、升级、缺 exe、缺目录、不动别的、命令行入口的 `.cmd`）、
  贴字失败时把成品补进剪贴板。
- **改断言**：热键 id（`right_option`/`fn` → `right_alt`/`right_shift`）、权限的名字
  （输入监控/辅助功能 → 键盘钩子/点击拦截）、`⌘V` → `Ctrl+V`、系统设置路径、UI 文案。

新增 2 条：`update` 在"没配更新源"和"装好的那份在跑"两种情况下说的话。**没有一条是靠放宽断言变绿的。**

### 原生小帮手（C# 编出来的那个）

```
$ build\fast-speak-helper.exe --selftest
{"event":"selftest","wrote_text":true,"restored":true,"items":7,"not_for_history_markers":true,"input_size":40,"input_layout":true,"send_input":true,"send_sent":2,"send_error":0}
exit=0

$ build\fast-speak-helper.exe --check
{"event":"ready","listen":true,"trusted":true,"capture":true}
{"event":"check","listen":true,"trusted":true,"capture":true,"clipboard_text":true}
```

- `--selftest`：把剪贴板存下来、写一句、读回来、再原样还回去。`restored:true` 是"7 种格式逐个对上了"；
  `not_for_history_markers:true` 是那三个"别记我"的格式名系统都认（见
  [移植笔记](windows-port.md#贴字剪贴板那点事)），认不出来的话你说的话会留在 Win+V 历史里。
- `--check`：`listen`/`capture` 是两个低层钩子（`WH_KEYBOARD_LL`/`WH_MOUSE_LL`）
  都装上了；`clipboard_text` 是"剪贴板里现在有文字"。

### 协议往返（主进程那一侧看到的东西）

单独起一个小帮手，发 `capture`/`release`/`paste`，看它怎么回：

```
EVENT {"event":"ready","listen":true,"trusted":true,"capture":true}
EVENT {"event":"pasted","id":1,"ok":false,"reason":"input_blocked"}
EXITED
```

`ready` 说明三个能力都在；`pasted` 这条是**在非交互会话里**跑的，`SendInput` 返回 0（排不进系统输入队列），
所以回的是 `input_blocked` —— 这正是"发不出按键"时该有的那条路径：文字留在剪贴板里，不静默失败。
真键盘下的贴字见下面第二节。

### 命令行

临时数据目录，走一遍主要的子命令：

```
$ node bin/fastspeak.mjs start
Starting fastspeak…

fastspeak 0.1.0 · running, 1 thing missing
  Missing: Gemini API key.
  Key          Not set: run fastspeak key
  Permissions  Microphone ✓   Keyboard hook ✓   Click interception ✓
  Hotkey       Right Alt
  Mode         Native: the recording goes straight to the model
  Model        Gemini gemini-3.6-flash (MINIMAL)
  Theme        Ink (ink)
  Language     System · 简体中文

$ node bin/fastspeak.mjs status --json
{"running":true,"status":{"pid":39832,...,"packaged":false,"key":{"state":"missing",...},...}}

$ node bin/fastspeak.mjs history
No dictations yet. Run fastspeak to start, then press the hotkey and say something.

$ node bin/fastspeak.mjs usage
No usage yet. Say something first: every model call's cost, tokens, and reply time get recorded.

$ node bin/fastspeak.mjs config
Settings
  hotkey       right_alt   Right Alt · default
               Which key starts and stops dictation. Options: right_alt / right_ctrl / right_shift / right_win
  ...
$ node bin/fastspeak.mjs stop
fastspeak stopped.
```

后台起来之后数据目录里是 `data\history.db`、`logs\main.log`、`run\daemon.pid` 三样（缓存目录 `cache\` 另算）。

### 打包和安装

```
$ npm run dist
打好了：D:\typeless\fast-speak\dist\FastSpeak-win32-x64
可以这样直接跑：D:\typeless\fast-speak\dist\FastSpeak-win32-x64\FastSpeak.exe

$ powershell -ExecutionPolicy Bypass -File scripts\build\install.ps1 -InstallHome <临时目录> -NoPath -NoShortcut
正在装到 <临时目录>\app.new …
装好了：<临时目录>\app
```

装出来的目录是 `<家>\app\{FastSpeak.exe, resources\, locales\, ...}`，`resources\app\` 里是代码、
编好的小帮手（`build\fast-speak-helper.exe`）、图标和 `node_modules`。

## 二、在真桌面会话里跑过的

这些是**用 explorer 启动**（和双击同一条路，`Start-Process` 在 PowerShell 里起不来 Electron 的 GUI，
原因没追——不是程序的问题，是那台机器的会话注入方式）。

### 打好的程序双击启动

```
进程：FastSpeak.exe（主）+ 4 个渲染/GPU 辅助 + fast-speak-helper.exe
窗口：MainWindowTitle = "FastSpeak"（首次引导）
日志（默认数据目录 %USERPROFILE%\.fast-speak\logs\main.log）：
  {"event":"started","version":"0.1.0","hotkey":"right_alt","route":"native: gemini/gemini-3.6-flash",
   "locale":"zh-CN","home":"C:\\Users\\…\\.fast-speak","packaged":true,"by_cli":false}
  {"event":"helper_launched","hotkey":"right_alt"}
  {"event":"helper_ready","listen":true,"trusted":true,"capture":true}
  {"event":"settings_offered","missing":[{"key":"setup.missing.key",...}]}
```

`packaged:true` 说明确实是打好的那一份在跑；`helper_ready` 三项全 true 说明两把钩子都装上了；
`settings_offered` 说明"缺 key → 自动打开首次引导"这条也走了。

### 装好的那份启动

```
进程：<临时目录>\app\FastSpeak.exe（主）
      <临时目录>\app\resources\app\build\fast-speak-helper.exe --key right_alt
窗口：MainWindowTitle = "FastSpeak"
```

### 之前走过的

`fastspeak start`（命令行启动）走的也是同一条主进程路径，`helper_ready`、数据目录、控制通道都验过。

## 三、没验的（如实列出）

### 只能人做的

- **真键盘按热键**：`WH_KEYBOARD_LL` 装上和 `--check` 都验了，但"按下右 Alt → 悬浮条出现"这一步要人按。
  同理：按 `Esc` 取消、点悬浮条上的 ✕/✓、说话时前台应用不换焦点。
- **真麦克风录一段、真模型出字、真贴进记事本**：要 key 和麦克风。
- **`SendInput` 真的把 Ctrl+V 送进目标程序**：在非交互会话里 `SendInput` 返回 0（排不进队列），
  所以只验到"走的是 `input_blocked` 那条兜底"。桌面会话里应该正常，但没实测。

上面四条是这一版唯一需要人配合的部分。做完之后请把结果补进这一节。

### 有理由没做的

- **自动替换程序（更新）**：这一版只问版本、不换程序，见 [Windows 移植笔记](windows-port.md#更新)。
- **代码签名 / SmartScreen**：没有证书，第一次运行会被拦一下。
- **Windows 上的本地模型实测**：模型文件跟 macOS 那份一样，但速度和准确率没在 Windows 上测过。
  界面上会显示"还没有在这类机器上实测"，不拿 Apple 芯片的数字冒充。
- **arm64**：`CHIPS` 里留了位，没打 arm64 的包。
- **代理 / 企业网络的证书**：这台机器上 `@electron/get` 和 npm 的一部分地址走 Node 的 fetch 会报
  `UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `fetch failed`，同样的地址用 PowerShell 是通的。
  所以 Electron 的二进制改成用 PowerShell 下（`scripts/build/fetch-electron.mjs`，带 SHA-256 核对），
  打包时的依赖安装也留了 `--reuse-node-modules` 这条路。这是环境问题，不是程序的问题，
  但在别的机器上第一次 `npm install` 时可能要留意。

## 四、按逆向笔记核对时补上的四处

逆向笔记（`docs/targets/typeless/docs/`）的"给仿写的备忘"里有两条，原版在 macOS 上做了，
搬到 Windows 时我一开始漏了；核对时补上。第三、四两处是同一次核对里发现的自相矛盾——
顺带说一句：这两处是"文档 subagent 写完把代码和文案对不上的地方如实记下来"，我再去改代码，
不是文档写错了。

1. **`07` 备忘第 3 条"写入（带临时标记）"**：macOS 版给剪贴板写入打 `NSPasteboardType.transient`，
   让剪贴板工具不把这次写入记进历史。原来 Windows 版只写 `CF_UNICODETEXT`，等于你说的话会留在
   Win+V 历史里。现在同时打上 `CanIncludeInClipboardHistory` = 0、`CanUploadToCloudClipboard` = 0、
   `ExcludeClipboardContentFromMonitoring`（`Clipboard.MarkNotForHistory`），自检里加了
   `not_for_history_markers` 盯着这三个格式名系统认不认。
2. **`14` 备忘第 1 条"插入后检查输入框是否可编辑，不可编辑就给复制兜底"**：原来只在 `SendInput`
   一条都没排进队列时才报失败——而 UIPI 拦下来的情况 `SendInput` 是"成功"的，于是会报"贴好了"、
   用户什么都没看到。现在发按键之前先比一次令牌提权状态（`Paste.ForegroundBlocksInput`）：
   对面是管理员程序、我们不是时，直接回 `uipi_blocked`。
3. **贴失败时不再还原剪贴板。** 上一条补完之后，文案说"文字已复制"，但 `Paste.Deliver` 无论成没成
   都在 0.3 秒后还原剪贴板——照做的话那句话是假话，用户按 Ctrl+V 什么都没有。现在只有贴出去了才还原；
   `clipboard_busy`（连存都存不下来、根本没写过）由 `delivery.mjs` 补写一次，主进程也写不进去时
   改说"成品在历史里，从那里复制"（新文案键 `delivery.pasteFailedNoClipboard`）。
4. **`trusted` 不再写死成 true。** `Protocol.Ready` 原来恒报 `trusted: true`，鼠标钩子的真实状态只走
   `capture`；结果是"点击拦截的钩子没装上"这件事永远说不出来，`setup-state.mjs` 那条降级提示永远不触发。
   现在 `trusted` 跟着鼠标钩子报，三个名字的含义和 `docs/windows-port.md` 里写的一致。

四处都编进了小帮手，`--selftest` 和单测都跑过（见上）。真键盘下"贴进记事本"和"贴进管理员程序"两条
仍然要在第二节那批人工验收里过一遍。

## 五、移植过程中发现并修掉的三个真 bug

都是"在 macOS 上被文件系统行为盖住了"，到 Windows 上才暴露：

1. **`src/storage/history.mjs`**：库的版本比程序新时拒绝打开，但 `migrate()` 抛错之后那个 sqlite 连接一直开着。
   POSIX 上删一个还开着的文件没问题，Windows 上删不掉（测试收尾 EPERM）。修法是抛错前先 `db.close()`。
2. **`src/storage/paths.mjs`**：少一个 `appDir`。`fastspeak update` 靠它认出"这是装好的那一份"，
   缺了就永远说"从源码跑的，用 git pull"，`status` 也永远不提醒新版本。
3. **`src/cli/commands/uninstall.mjs`**：`--keep-data` 读的是一个已经不存在的字段（`runtimeDir`），
   于是 `<家>\runtime` 从来没被删过，每次卸载还会打一条 Node 的弃用警告。

## 六、打包那一层踩到的坑（写下来给下一个人）

- **Electron 的二进制下不下来**：`@electron/get` 报 `fetch failed`，同样的 URL 用 PowerShell 能下。
  现在 `npm install` 后面挂了一个 `postinstall`（`scripts/build/fetch-electron.mjs`）补这一步，带 SHA-256 核对。
- **ESM 里 `import { app } from "electron"` 在打包后的 exe 里不成立**：报
  `does not provide an export named 'BrowserWindow'`，进程静默退出。同一份代码用
  `electron.exe <app 目录>` 起就正常。现在入口是 CommonJS 的 `main.cjs`，`src/app/electron.mjs` 负责取。
- **PowerShell 5.1 读没有 BOM 的 `.ps1`**：按 ANSI 解，中文成乱码、引号配对跟着坏，报"括号没闭合"。
  `install.ps1` 存成 UTF-8 **带 BOM**。
- **`$Home` 是只读自动变量**：安装脚本的参数改叫 `$InstallHome`。
- **`Copy-Item -Recurse` 在 5.1 上的行为**：`-Destination` 已存在时是把源目录**里面的东西**拷进去。
  `install.ps1` 里用 `Copy-Item -Path "<源>\*" -Destination <目标> -Recurse` 写死这一点，并断言拷完有 `FastSpeak.exe`。

## 七、加 Qwen（2026-10-17）

在移植完成之后加的第三家模型。两个位置都接上了，**各用各的型号**：

| 位置 | 型号 | 为什么 |
| --- | --- | --- |
| native（收音频、一次出成品） | `qwen3.8-omni-flash` | 要能听声音，omni 系列里 flash 档最便宜 |
| local 第二步（文本润色） | `qwen-plus` | 纯文本任务，不必按多模态计价 |

**怎么接的。** 百炼的 **OpenAI 兼容模式**和原来的 `openai.mjs` 是同一套请求形状（`messages` 里放
`input_audio`），所以把那部分抽成了 `src/server/providers/openai-audio.mjs`，OpenAI 和 Qwen 各留一份薄配置
（地址、称呼、算钱的规矩）。抽的时候**先把 OpenAI 的 13 条测试跑绿才往下走**——那是"重构没改行为"的守卫。
润色那一跳复用现成的 `openai-chat` 协议，只加了 `baseUrlEnv` 这个字段（环境变量换地址）。

**跑过的（能重复）：**

```
$ npm run lint
Checked 234 files. No fixes applied.                    ← 0 error 0 warning

$ npm test
ℹ tests 779 / pass 779 / fail 0                         ← 单测（原来 755，多出 24 条）
ℹ tests   6 / pass   6 / fail 0                         ← 安装脚本

$ node bin/fastspeak.mjs model                          ← 没有 key 也列得出来
  ● gemini   Gemini   gemini-3.6-flash               no key yet
    openai   OpenAI   gpt-audio-mini (default)       no key yet
    qwen     Qwen     qwen3.8-omni-flash (default)   no key yet

$ node bin/fastspeak.mjs config set model qwen/qwen3.8-omni-flash
model set to qwen/qwen3.8-omni-flash.
$ node bin/fastspeak.mjs config | grep model
  model        qwen/qwen3.8-omni-flash  Qwen · from the settings file

$ node bin/fastspeak.mjs polish                         ← 润色那一跳的清单
  ● deepseek   DeepSeek   deepseek-flash            no key yet
                              also: deepseek-v4-pro
    qwen       Qwen       qwen-plus (default)       no key yet
                              also: qwen-max / qwen3.8-omni-flash

$ node bin/fastspeak.mjs model check qwen               ← 没有 key 时说的话
Not usable: No Qwen key yet: run fastspeak key qwen
exit=1
```

**新增的 14 条测试**（`test/server/providers/qwen.test.mjs` 10 条、`vendors.test.mjs` 2 条、
两个价格表各 1 条），全部用假 fetch，覆盖：请求打到
`…/compatible-mode/v1/chat/completions`、body 里是 wav 的 `input_audio` 加 `modalities:["text"]`、
`FASTSPEAK_QWEN_BASE_URL` 能换地址（并且换出来的地址也要过 http(s) 校验）、`modalities` 关得掉、
401/404/429/403/5xx 各自映射对且文案里带 "Qwen"、被截断的回话不当成品、usage 拆成
input/audio/cached/output。另外首次引导那两条老测试的断言跟着改了：厂商编号从两个变三个
（native 是 1 Gemini / 2 OpenAI / 3 Qwen，local 是 4 DeepSeek / 5 Qwen），
`polish openai` 的报错里"能用的"多了 qwen。

**真 key 跑出来的那个 400，以及它怎么解决的（这一段是本次最值钱的记录）。**

第一次用真的百炼 key 跑，首次引导里直接报：

```
Qwen 拒绝了请求：<400> InternalError.Algo.InvalidParameter:
The provided URL does not appear to be valid. Ensure it is correctly formatted
```

当时的实现是照 OpenAI 的形状发 `input_audio: { data: <纯 base64>, format: "wav" }`。
报错说 "URL"，说明**百炼把这个字段当 URL 解析**。于是写了 `scripts/dev/probe-qwen-audio.mjs`，
用真 key 把几种可能的形状各发一次（key 从终端读、不回显、不写盘），结果：

| # | 形状 | 结果 |
| --- | --- | --- |
| 1 | `qwen-plus` 纯文本 | ✅ 485 ms（key 本身有效） |
| 2 | `qwen3.8-omni-flash` 纯文本 | ✅ 2349 ms（omni 也收纯文字） |
| 3 | **纯 base64 + format**（当时的实现） | ❌ 400 说的就是那个 URL 错 |
| **4** | **data URI + `modalities`** | ✅ **829 ms** |
| 5 | 纯 base64，不带 format | ❌ 同样是 400 URL 错 |
| **6** | **data URI，不带 `modalities`** | ✅ **1059 ms** |
| 7 | `qwen3-asr-flash` + 纯 base64 | ❌ 400 URL 错 |
| 8 | `qwen3-asr-flash` + data URI | ❌ 另一个错："The dedicated task `asr` … does not support this input" |
| 9 | 原生接口 `multimodal-generation` + data URI | ✅ 但 **10 480 ms**，慢十倍 |

**结论：`input_audio.data` 必须是 `data:audio/wav;base64,…`，纯 base64 不行。**
于是 `openai-audio.mjs` 多了一个 `audioEncoding` 参数（`"base64"` / `"data-uri"`）：
OpenAI 传纯 base64（它只认这个），Qwen 传 data URI。**一处配置，两家各按各自的规矩来。**

顺带得出几个事实（都写进 `qwen.mjs` 的注释了）：

- `modalities: ["text"]` **带不带都通**（4 和 6 都成功），还是带上——意图明确，也省得它连语音一起出
- `qwen3-asr-flash` 那条路走不通：它要专门的 ASR 接口，不收 `input_audio` 这种消息形状
- 原生接口能用但慢十倍，不值得为它多写一个适配器
- `qwen3.8-omni-flash` 默认**开思考**（回话里 `reasoning_tokens` 16–100），所以比纯文本 ping 慢。
  要更快可以试 `enable_thinking: false`，但**没实测成品质量**，没敢加——等有真实录音对比再说
- 静音录音回的是**空字符串**（`content=""`），这是对的：`delivery.silent` 那句"没有听到声音"就靠它

**已经用真 key 走通的一步（2026-10-17，日志里的原话）：**

```
$ node bin/fastspeak.mjs key qwen
Starting fastspeak…
Verifying…
Key saved and verified.

# logs/main.log
{"event":"model_call","purpose":"check","model":"qwen3.8-omni-flash",
 "audio_tokens":2,"output_tokens":2,"thinking_tokens":1,"cost_usd":null,"latency_ms":845}
```

`audio_tokens: 2` 是那 0.1 秒静音真的作为音频被收下了（不是被当文字忽略），845 ms 和探针的 829 ms
吻合，`qwen-key.bin` 146 字节写进了 `%USERPROFILE%\.fast-speak`。**key 检查这一关（也就 ping）是通的。**

**还没验证的（如实列出）：**

1. **成品质量没看过。** 上面那次只发了 0.1 秒静音，只证明"通"，没证明"整理得好不好"。
   要验：`fastspeak model qwen`，然后真说一句话。
2. **`qwen3.8-omni-flash` 在你账号上开没开通。** 这次通了，说明开了。换型号（比如
   `qwen3.5-omni-plus`）时仍可能遇到"没开通"，报错会照实说。
3. **价格表是空的。** `prices/qwen.mjs` 和 `chat/prices/qwen.mjs` 里的 `PRICES` 都是 `{}`，
   所以 Qwen 的花费一律算成空（首页把它列在"没定价"里，token 照记）。
   **没有编一个数字填上**——记错的钱比记不出钱更糟。补的时候照 `prices/openai.mjs` 的结构抄官方页，
   并改掉那两个"价目表还是空的"的测试（它们会提醒你）。
4. **没做流式（SSE）。** 一开始打算加，后来查到 qwen 支持非流式（有人修过
   [strip stream_options for qwen non-streaming](https://github.com/diegosouzapw/OmniRoute/commit/3c3dcadd4c49e3da7f06273c1577ee0a9fb8ca0a)），
   而且 `refiner.refine()` 只返回最终文字、悬浮条不做逐字显示，流式没有用户可见收益，
   只会给 `chat/openai-chat.mjs`（连带 DeepSeek）增加复杂度。**真出现"必须流式才通"的报错再加。**
5. **润色那一跳（`qwen-plus`）没跑过端到端。** 探针的第 1 条已经证明"纯文本 chat completions + 这把 key"
   是通的（485 ms），但 FastSpeak 里润色要的是"本机转写 + 润色"整条路，得先下载 850 MB 的本机模型。

**界面上的变化**（没截图，按代码和 CLI 的输出对）：

- 首次引导「先接上模型」那一排按钮：Gemini / OpenAI **/ Qwen**，`.providers` 是 `flex-wrap`，三个按钮挤不下会换行
- 设置 › 模型：native 那组的 key 面板多一项 Qwen；local 第二跳的润色下拉多 Qwen（可再选三个型号）
- 首页**不会多选项**——它不是选模型的地方；只有真用 Qwen 听过写之后，花费卡里多一行 `Qwen · qwen3.8-omni-flash`
- Qwen 的图标本来就在（`src/renderer/shared/provider-icons.mjs`，本机 ASR 模型 `qwen3-asr` 用的就是它），没画新的
### 真机跑出来之后：思考失控 → 超时 → 静默丢内容

> ⚠️ **这一节的结论后来被推翻了。** 当时把"思考失控"当成参数问题，一路调 `thinking_budget`；
> 真正的原因是**听写模型选错了**（`qwen3.8-omni-flash` 会思考失控）。最终解法见本节后面
> 的[整理效果那一节](#整理效果从合成语音骗我到换模型的完整经过)——换 `qwen3.5-omni-plus`，
> 预算参数整套删掉。这里保留过程，是因为"怎么走错"比"结论"更有参考价值。

上面那次"key 检查通过"之后，真机跑了三次，历史里留了三条：一次成功（「下周五开会」），
两次「失败 · 等了 20 秒没有等到成品」。日志把原因说得很清楚：

| 时间 | 输出 token | 其中思考 | 耗时 | 结果 |
| --- | --- | --- | --- | --- |
| 13:25:51 | 81 | 73 | **2.3 秒** | ✅ 出字 |
| 13:28:02 | **1725** | **1709** | **29.6 秒** | 撞上 30 秒请求超时，成品被丢 |

同一个模型、同一份代码，思考量差 23 倍。而**界面等成品的超时是 20 秒**
（`src/renderer/bar/voice-socket.mjs` 的 `REFINE_TIMEOUT_MS`，照抄原版），服务端的请求超时是 30 秒
（`refiner.mjs`）。20 < 30，所以界面先报失败、后台还在等，最后返回的成品没人要——这是第二个 bug，
根子还是模型太慢。

**关掉思考行不行？不行。** 实测（12 秒中文，带口头禅和改口，每档两遍）：

| 写法 | 耗时 | 思考 | 成品 |
| --- | --- | --- | --- |
| `enable_thinking: false` | 986–1864 ms | 0 | 原样转写，口头禅和改口全留着 |
| `thinking: { type: "disabled" }` | 1281–1623 ms | 0 | 同上 |
| 关思考 + 更强硬的提示词 | 1074–3895 ms | 0 | **还是**原样转写 |

"抹掉口头禅、处理改口"正是这个功能的全部价值，关掉思考就没了，换提示词也补不回来。

**解法是给思考设上限（`thinking_budget`），而这个上限不能小。** 42 秒的长录音（三点内容的会议记录）：

| `thinking_budget` | 耗时 | 思考 | 成品 |
| --- | --- | --- | --- |
| 不设 | **30 秒超时** | — | 失败 |
| 128 | 4965–6641 ms | 128（打满） | **只剩第 3 点，前两点整个没了** |
| 256 | 7347 ms | 256（打满） | 完整，但卡在边界 |
| **384** | **7174–9254 ms** | 293（未打满） | **完整，有余量** |
| 512 | 9254 ms | 512 | 完整，略慢且有波动 |

12 秒短录音上 384 是 3.2–3.9 秒、思考 153–169，和 512 的思考量差不多但更稳。**取 384。**

**最危险的是 128 那一行**：它不是超时，不是报错，而是**平平静静地少说了两件事**，
`finish_reason` 还是 `stop`，任何长度检查、任何错误处理都发现不了。所以这里的原则是
**预算必须给够**——被掐断时模型会自己"收尾"，代码层面拦不住。

改完之后产品自己的链路（`createModelRefiner`，不是探针）跑出来：

```
12 秒录音：5053 / 3417 ms，思考 122 / 121
          我们这个项目原定是下周四上线，测试那边还需要大概 2 天时间
42 秒录音：5353 ms，思考 208
          今天我们要讨论几个事情：
          1. 这个季度的销售情况：整体上来说比上个季度好了大概 15%，但华东区那边反而下滑了，下降了大概 8%
          2. 下个月的产品发布会：定在 11 月 8 号，场地那边还需要再确认一下
          3. 招人的事情：我们计划在年底之前把测试团队扩大一倍，从 3 个人扩到 6 个人
```

从 29.6 秒（还超时）降到 3.4–5.4 秒，长录音 5.4 秒、三点齐全。

**这一段是怎么测出来的**：`scripts/dev/try-real-audio.cjs`（Electron，自己解 safeStorage 的 key，
不走产品、不改设置）拿 Windows 自带语音合成的一段中文跑产品自己的 refiner。比让人对着麦克风试一遍可靠，
而且能连着跑、能换参数。key 只在进程内存里，不打印。
### 回头看 Gemini 和原版是怎么做同一件事的

> ⚠️ **这一节里"按秒算预算"的做法后来也废掉了**（模型换了之后不需要预算）。留下的价值是
> 那几个对照：Gemini 用档位不猜数字、原版客户端根本不发模型参数、那份提示词是对着
> Gemini 调的。这三条到现在仍然成立。

上面那些数是自己试出来的，后来对着两边已有的做法核了一遍——有两处该早点照抄。

**Gemini 那条路（`src/server/providers/gemini.mjs` + `gemini-cache.mjs`）：**

| 做法 | 内容 |
| --- | --- |
| 思考是**档位**，不是数值 | `thinkingConfig: { thinkingLevel }`，取值 `MINIMAL / LOW / MEDIUM / HIGH`，**默认 `MINIMAL`** |
| 档位是设置项 | `settings.thinking`，`GEMINI_THINKING_LEVEL` 可以临时盖 |
| **提示词缓存预热** | 用户开口说话时（`prepare()`）就把 system prompt 建成 30 分钟的缓存，整理时直接用。首次 3.4–4.1 秒 → 之后 1.7–1.9 秒 |
| 不设 temperature | 设成 0 时 60 条真实录音里有 10 条成品是坏的（开头多外文词、只出一小截），去掉后降到 5 条 |
| 截断/被拦一律不当成品 | `finishReason !== "STOP"` 就报错，不贴半截字 |

**原版（Typeless）的做法**（逆向笔记 `10-interaction-state-machine.md:101-109`）：

| 等什么 | 超时 | 常量 |
| --- | --- | --- |
| 听写等成品 | 20 秒 | `VOICE_TRANSCRIPT_REFINE_TIMEOUT_MS` |
| 问任何事等成品 | 30 秒 | `VOICE_COMMAND_REFINE_TIMEOUT_MS` |
| HTTP 兜底 | 40 秒 | `main/index.js:17905` |

原版是**内层短、外层长**（20 → 40），内层超时能先把错误报给用户，外层还有一倍余量留给请求本身。
FastSpeak 是 20 秒（`voice-socket.mjs`）→ 30 秒（`refiner.mjs`），方向对，但 20:30 比 20:40 紧。
不过这不影响用户看到的东西（20 秒就会提示失败），**所以没改**。

**照抄过来的两处：**

1. **预算改成按录音长度给，而不是写死。** Gemini 靠"档位"把思考压到最低档，Qwen 没有档位、
   只有数值，那就按输入的大小给。公式 `max(384, 秒数 × 7)`（上限 2048）：
   典型的一句仍是 384（实测过的那个数），60 秒才升到 420，120 秒 840。
   **为什么不干脆给大一点**：实测给 426 时它把 426 全用满、而且那一次改口没处理
   （"11 月 5 号，不对，是 11 月 8 号"原样留着）；给 384（用掉 293）那次处理干净了。
   **打满就是信号——要么不够、要么给多了，两头都不好。**
2. **`wavSeconds` 不能假设 44 字节头。** 这是加自适应预算时踩出来的：Windows 语音合成的 wav
   `fmt ` 块是 18 字节，`data` 落在 offset 38，按标准 44 字节读会把 12 秒算成 **7656 秒**
   （预算直接顶到上限 2048，慢一倍）。改成按 chunk 走，两种头都算得对，另有测试守着。

**没照抄的一处，以及为什么**：Gemini 有提示词缓存，Qwen 没有——四次真机调用的 `cached_tokens` **全是 0**。
DashScope 的上下文缓存对 omni 系列不生效（或者需要显式开，没查到文档）。这是它比 Gemini 慢的结构性原因：
每次都要重新处理 1400 多个输入 token。**没有为此写代码**——显式缓存要另查 API，收益只是省 token 钱，
不影响用户等的时间（输入侧并行处理）。如实记在这里。
### 粘贴从来没成功过：INPUT 结构体大了 8 字节

真机上跑完，历史里两条记录、界面上弹的是"管理员权限的窗口收不到模拟按键：文字已复制，按 Ctrl+V 粘贴"。
日志里是 `reason: "input_blocked"`——**每一次都是**，从 13:25 到现在没有一次粘贴成功过。

查下来跟权限没关系。`native-win/Win32.cs` 里 INPUT 那个联合体是这么写的：

```csharp
[StructLayout(LayoutKind.Sequential)]
public struct INPUT
{
    public uint type;
    public KEYBDINPUT ki;   // 24 字节，从 offset 8 起（有对齐）
    public long padding1;
    public long padding2;
    public long padding3;   // 垫了三个 long
}
```

type(4) + 对齐(4) + ki(24) + 三个 long(24) = **56 字节**。而 Windows 的 `sizeof(INPUT)` 是 **40**。
`SendInput` 会拿 `cbSize` 跟它自己认的比，不匹配就**一个键都不发**、直接返回 0，
`GetLastError` 是 87（ERROR_INVALID_PARAMETER）。

于是：模型出字了、剪贴板也写好了，就是贴不进光标。用户看到的是"要手动按 Ctrl+V"。

**修法**：用 `LayoutKind.Explicit` + `Size = 40` 把大小钉死，让 `ki` 落在 offset 8：

```csharp
[StructLayout(LayoutKind.Explicit, Size = 40)]
public struct INPUT
{
    [FieldOffset(0)] public uint type;
    [FieldOffset(8)] public KEYBDINPUT ki;
}
```

**两道闸守住它**（都在 `--selftest` 里，`npm run native` 之后随时能跑）：

```
$ build\fast-speak-helper.exe --selftest
{"event":"selftest",...,"input_size":40,"input_layout":true,"send_input":true,"send_sent":2,"send_error":0}
```

- `input_size` / `input_layout`：`Marshal.SizeOf(INPUT)` 必须是 40
- `send_input`：真发一次 F24（没有程序会绑它），看返回几条。`send_sent: 2` 说明排进队列了；
  修之前这里是 `0`，`send_error: 87`

另外 `Deliver` 的失败原因现在带上 `GetLastError`（`input_blocked:87`），文案也按原因分：
只有 `uipi_blocked` 和 `input_blocked:5`（ERROR_ACCESS_DENIED）才说"管理员权限的窗口"，
别的码说"没能自动粘贴"——之前一律说成权限问题，把人往错方向带。

**顺带说清一件事**：之前 `docs/verification.md` 里写过"`SendInput` 返回 0 是因为没有桌面会话"，
那个判断是错的。真正的错误码一直是 87，只是没往日志里带，所以看不出来。这条也算一次教训：
**把 GetLastError 记下来，比猜一个原因有用**。
### 把思考预算加进 extraBody 时踩的坑：ping 也被带上了

真机上填 key 时报：

```
Qwen 拒绝了请求：<400> InternalError.Algo.InvalidParameter:
max_completion_tokens [1] must be greater than thinking_budget [384]
```

原因是 `extraBody` 是个"每次都摊进请求体"的参数，而验 key 那一步（ping）只要 1 个 token
（`max_completion_tokens: 1`，为的是便宜、快）——百炼要求 `max_completion_tokens > thinking_budget`，
两个一起发就被拒了。

**这是一次回归**：在你第一次填 key 成功（13:22）之后我才加的思考预算，所以那会儿 ping 里没有这个参数。
加的时候没注意到 ping 也会走同一个 `extraBody`。

修法是把 `extraBody` 写成按"有没有录音"分岔——ping 拿到的是 `{ audio: null }`：

```js
extraBody: ({ audio }) => (audio === null ? {} : { thinking_budget: thinkingBudget(audio) }),
```

并补了一条测试专门盯它（之前那 15 条 qwen 测试里没有一条断言"ping 不带 thinking_budget"，
所以这个回归一路绿着溜过去了）：**验 key 那一步不能带 thinking_budget**。

### 字体为什么和 macOS 版不一样（这是设计差异，不是 bug）

`tokens.css` 里两边是这样：

```css
/* macOS */
--font: -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif;
--font-rounded: ui-rounded, -apple-system, "PingFang SC", system-ui, sans-serif;

/* Windows */
--font: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
--font-rounded: /* 和上面一模一样 */
```

macOS 那个 `ui-rounded` 是 SF Pro Rounded（系统的圆体），Windows 没有对应的圆体中文字体。
照着凑一套只会和正文不是一家，所以 `--font-rounded` 直接跟 `--font` 一样，层次靠**字重**拉开
（标题 650、正文 510）—— 注释里写了理由。

**实测这台机器上的字体都在**（`scripts/dev/check-fonts.cjs`）：

```
✅ Segoe UI Variable Text / Display / Small    ✅ Microsoft YaHei UI    ✅ Cascadia Mono
"Segoe UI Variable Text" 的可变字重：✅ 400 ✅ 510 ✅ 590 ✅ 650 ✅ 700
devicePixelRatio：1.25（系统缩放 125%）
```

样式里大量用 510 / 590 / 650 这种非整百的字重，靠的正是 `Segoe UI Variable` 的可变轴。
它不在时才会回退到非可变的 `Segoe UI`，那些字重会被量化——真出现那种情况，先跑这个脚本看。
### 整理效果：从"合成语音骗了我"到"换模型"的完整经过

这一段值得完整留着，因为它记录了一次**方向错到底**的排查。

**第一次误判：拿合成语音打分。** 前面那些"整理得挺好"的结论，全是用 Windows 语音合成（SAPI）
造的中文测的。合成语音干净、没有犹豫和口吃，所以看起来没问题。真人的话一上就废：

| 录音 | 模型 | 思考 | 耗时 | 成品 |
| --- | --- | --- | --- | --- |
| 41.3 秒 | `qwen3.8-omni-flash` + 预算 384 | 384（打满） | 7799 ms | 191 字逐字转写："那个 ［已隐去］ 的那个图标，然后我们没有属于我们的…有没有什么，然后就另外的话" |
| 9.3 秒 | 同上 | 384（打满） | 7211 ms | 把"逻辑建模"听成"**多迪字母**" |

**第二次误判：把现象当参数问题调。** 于是我加了个 `thinking_budget`，从 384 调到 1024、再改成按秒算
（`秒数 × 7` → `秒数 × 20`）。每一步都能"让某一条录音变好"，换一条又崩——**那是在拟合数据**。

**真正的原因：模型选错了。** 账号里有 176 个模型，能收音频的 omni 有 4 个（`GET /models` 列出来的），
拿同一段 41.3 秒真实录音全部跑一遍：

| 模型 | 预算 | 耗时 | 思考 token | 成品 |
| --- | --- | --- | --- | --- |
| `qwen3.8-omni-flash` | 不设 | **16–72 秒** | 1304–5459 | 慢到撞 20 秒超时，把 Logseq 听成"逻辑字母" |
| `qwen3.8-omni-flash` | 1024 | 8.6 秒 | 549 | 中，还有"然后""另外的话" |
| **`qwen3.5-omni-plus`** | 不设 | **1.4–2.4 秒** | **0** | **最好**：口头禅、重复、口吃都清了，还分了段 |
| `qwen3.5-omni-flash` | 不设 | 1.3 秒 | 0 | 一般（"然后我们没有"留着） |
| `qwen3-omni-flash` | 不设 | 1.7 秒 | 0 | 差（把产品名听成"speaker more"） |

**plus 档根本不产生思考 token**——所以那个护栏在这个模型上是多余的，`thinking_budget` 整套删掉。

**最终用产品代码复跑四条真实录音**（`scripts/dev/eval-real.cjs`，走 `qwen.mjs` 的 `createClient`）：

| 录音 | 耗时 | 思考 | 成品 |
| --- | --- | --- | --- |
| 41.3 秒 | **2399 ms** | 0 | 软件图标没有换，我们采用的是 ［已隐去］ 的图标，但没有适合 Fast Speak 的。我们需要一个属于自己的图标，我可以通过 GPT 生成一个，你可以说说你的想法吗？…GitHub 上面我们把图标改了之后上传过去。另外，有没有什么办法让别人通过跑终端、输入一行命令直接下载安装？ |
| 31.1 秒 | **1957 ms** | 0 | 我的意思是让 AI 直接在代码层面上生成你要的元件，然后 AI 把元件拼接…而不是让豆包它来打开 Logisim 软件，然后再操控 Logisim，不是这样子。 |
| 9.3 秒 | **1479 ms** | 0 | 你用 AI 跑一下，跟 AI 说用多 agent 写前面那个报告不就好了吗？这么简单的事。 |
| 8.0 秒 | **1518 ms** | 0 | 你用 AI 跑一下 Logisim，让 AI 用 Logisim 写报告，写你那个实验不就好了吗？ |

（转写引文里提到的另一个产品名已隐去。）

四条全部 ≤ 2.4 秒、思考 0。同一条 41 秒录音从 **51 秒（3815 个思考 token）降到 2.4 秒**，快 21 倍。

**成本**（按百炼控制台的标价算，¥0.8/¥2.7 与 ¥7/¥40，汇率 7.2）：

| | 输入 token | 输出 token（思考） | 每次成本 |
| --- | --- | --- | --- |
| `qwen3.5-omni-plus` | 1597 | 69（**0**） | **¥0.0139** |
| `qwen3.8-omni-flash`（失控那次） | 1633 | 5530（**5459**） | ¥0.0162 |
| `qwen3.8-omni-flash`（正常那次） | 1633 | ~400 | ¥0.0050 |

**单价贵 9–15 倍的 plus，实际每次可能更便宜**——思考 token 按输出价计费，flash 烧掉的那几千个
比 plus 的总价还高。只有 flash 不失控的时候它才便宜，而它失不失控不可控。

价格已填进 `src/server/providers/prices/qwen.mjs`，`fastspeak usage` 现在能算出真实花费
（之前 `PRICES` 是空对象，`cost_usd` 一直是 `null`）。

**三条教训，都写进代码注释了：**

1. **别拿合成语音给自己打分**——它的语速、停顿、口吃分布和真人完全不同，按它估的参数会系统性偏小
2. **先穷举候选模型，再谈调参数**——同一个 API 下 4 个 omni 模型的差距是 20–50 倍，比任何参数都大
3. **版本号高不代表适合**——`qwen3.8-omni-flash` 比 `qwen3.5-omni-plus` 新，但在这件事上更慢更差

另外纠正文档里之前写错的一条：**`qwen-omni-turbo` 是 404 型号不存在**；`qwen3.5-omni-plus`
第一次调回 500（瞬时故障，重试正常）。换型号前先 `GET /models` 确认它在册。

**同步提醒**：`settings.json` 里如果已经写死了旧型号（`"model": "qwen/qwen3.8-omni-flash"`），
**换默认值不会影响它**——要跑一次 `fastspeak model qwen`，或者手动改掉那一行。

### 换了图标

原来是那个"朱砂印 + 五道声波"（`assets/icon.svg` 的注释里还写着"macOS 图标的画法"）。
换成自己的：

- 记号是首字母 **F**，左边那道竖拆成**三道高低起伏的短竖**——既是 F 的笔，也是说话的波形
- 两道横保持文字的走向，中间那道用朱砂（`#c7563c`）点睛，和三个主题呼应
- 底色 `#26313d`（墨），四周留白按 Windows 11 的图标网格

试过两版被否掉的：**三道竖条 + 三角箭头**（256 和 16 像素下都被认成信号格和播放键）、
**声波渐变收成箭头**（还是像音量）。用首字母是为了小尺寸下也能认出来。

托盘图标（`assets/tray.svg`）取同一组图形、只留白：
**图形必须是浅色**——Windows 的托盘不会替图标反色（macOS 的 Template 图片会），
`make-icon.mjs` 会在它下面垫一块近黑的底，于是深色任务栏上是白线、浅色任务栏上是有边界的深色方块。
写成深色就会融进深色任务栏里（踩过，16 像素下整块看不见）。

生成：`npm run icons` → `assets/app.ico`（16/24/32/48/64/128/256）、`assets/tray.ico`（16/20/24/32）。
