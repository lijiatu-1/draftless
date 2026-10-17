# 交接文档

写于 2026-10-17。这份文档的读者是**下一个接手的人或 AI**，读完应该能直接开工，不需要翻聊天记录。

---

## 一、这是什么

**FastSpeak**：Windows 上的开源语音输入。按一下热键说话，再按一下，整理好的文字贴进你正在打字的那个输入框。

- 仓库：https://github.com/lijiatu-1/fast-speak （公开，MIT）
- 网站：https://lijiatu-1.github.io/fast-speak/ （GitHub Pages，源在 `docs/`）
- 发布包：https://github.com/lijiatu-1/fast-speak/releases （`FastSpeak-win32-x64.zip`，267 MB）
- 数据目录：`%USERPROFILE%\.fast-speak`
- 当前版本：0.1.0

**实现方式**：先把 Typeless 的 macOS 客户端逆向了一遍（`docs/targets/typeless/`，18 篇中文笔记），再按它的协议和交互在 Windows 上独立实现。没有用它的任何代码，也没有抄袭关系。

---

## 二、跑起来

```powershell
cd D:\typeless\fast-speak
npm install          # 装完会自动补 Electron 二进制（scripts/build/fetch-electron.mjs）
npm run native       # 编原生小帮手（C#，用系统自带的 csc.exe）
npm start            # 就是 fastspeak 命令
npm run check        # biome + 全部测试（784 单测 + 6 安装测试）
```

打包和发布：

```powershell
npm run dist         # → dist\FastSpeak-win32-x64\
npm run dist:zip     # → dist\FastSpeak-win32-x64.zip（737 MB → 267 MB）
npm run icons        # 从 assets/*.svg 重生成 app.ico / tray.ico
```

需要 Node 22.13+（23 要 23.4+）。Windows 上不用另装编译器。

---

## 三、数据怎么流

```
按热键（C# 小帮手装全局钩子）
  ↓
渲染层录音，每 3 秒切一块 Opus
  ↓ WebSocket（127.0.0.1 随机端口）
主进程的听写服务（src/server/server.mjs）
  ├─ 收到 end_audio 的那一刻，读一次「焦点输入框里光标前的文字」（UIA，最多 500 字，400 ms 超时）
  ↓
整理（src/server/refine/）
  ├─ Qwen：两跳 ── omni-plus 只转写（1.4–2.4 秒、不思考）→ qwen-plus 整理
  ├─ Gemini / OpenAI：一次调用（它们本来就擅长一起干）
  ↓
写剪贴板 → 模拟 Ctrl+V → 恢复剪贴板（C# 小帮手）
  ↓
悬浮条显示结果；历史存 data\history.db
```

**关键文件**

| 文件 | 干什么 |
| --- | --- |
| `src/server/refine/refiner.mjs` | 一次调用的链路；`createModelRefiner` 按厂商决定走一步还是两步 |
| `src/server/refine/two-stage.mjs` | 两跳的链路（Qwen 走这条） |
| `src/server/refine/prompt.mjs` | **提示词。整个产品效果的核心就在这个文件里** |
| `src/server/providers/*.mjs` | 各家适配器（gemini / openai / openai-audio 共用 / qwen） |
| `native-win/Clipboard.cs` | 模拟粘贴（`INPUT` 结构体必须是 40 字节，见坑 1） |
| `native-win/Context.cs` | 读光标前文字的 UIA 逻辑 |
| `src/app/main.mjs` | 主进程：托盘、窗口、接线 |
| `src/app/delivery.mjs` | 成品落盘 + 投递（贴不进去时把文字留在剪贴板） |

---

## 四、这次（2026-10-17）改了什么

按提交顺序，每条都说清**为什么**：

| 提交 | 改了什么 | 为什么 |
| --- | --- | --- |
| `5ad0989` | 初版 | 项目本身 |
| `b5aa81c` | 补打包和安装脚本 | `.gitignore` 里的 `build/` 把 `scripts/build/` 一起忽略了，安装脚本根本没进仓库 → 一行安装 404 |
| `da3b753` | **整理改成两跳** | 见下面「五、1」 |
| `75bd20a` | **加上下文**：读光标前 500 字 | 原版靠上下文集判断「该整理到什么程度」，我们之前完全没有 |
| `ae7dd85` | **提示词从「保守整理」改成「帮他补完整想法」** | 见下面「五、2」 |
| `c8aef3a` | 去掉所有对另一个项目的引用 + README 重写 | 用户要求；README 原来没写清去哪下载 |
| `b068815` | 删掉一键安装脚本 | 用户说不要了，安装只剩「下载 zip → 跑 install.ps1」 |
| `22f1617` | 加落地页 `docs/index.html` | 用 taste-skill 做的，0 FAIL 通过真浏览器校验 |
| `9453f87` | 修发布后的坏图 | `docs/` 就是网站根目录，`../assets/` 指到根之外 |
| `c4e297a` | 下载按钮改 zip 直链 | 原来还要先跳 Release 页面再点一次 |

**这一轮之前还修过两个硬 bug**（不在上面的提交里，但要知道）：

- **粘贴从来没成功过**：`Win32.cs` 的 `INPUT` 结构体是 56 字节，Windows 认的是 40，`SendInput` 一直返回 0、错误码 87。改成 `[StructLayout(LayoutKind.Explicit, Size = 40)]` 之后好了。
- **听写超时固定 20 秒**：长录音一旦网络抖一下，整次失败、文字永远不出现（用户说的"吞了"一半是这个）。现在 `voice-socket.mjs` 按录音长度放宽：`max(20s, 20s + 录音秒数)`。

---

## 五、两个最重要的决策，以及为什么

### 1. 为什么要两跳（`da3b753`）

听音频的模型（`qwen3.5-omni-plus`）本职是听懂声音，**文字加工不是它的强项**。让它一次干两件事，出来的是「带标点的听写」——这正是用户抱怨"跟普通语音输入没区别"的原因。

实测数据（同一条 33 秒真实录音）：

| 做法 | 语义重复能不能合并 | 耗时 |
| --- | --- | --- |
| 单跳 omni（不思考） | **0/5** | 1.4–2.4 秒 |
| 两跳：omni 转写 + qwen-plus 整理 | **能做到** | 3.3 秒 |

**为什么单跳做不到**：不思考的模型没有语义理解，它只在**匹配字面**。提示词里出现和录音一模一样的短语，它才"认出"是重复。所以「为什么会不达标」和「为什么会这样」它合并不了。

**两跳的固有缺陷**：第一跳听错的，第二跳改不了（它没听到音频）。所以第一跳的提示词（`two-stage.mjs` 的 `TRANSCRIBE_PROMPT`）特意要求「人名、产品名、术语按最可能的写法写，不要写音译的近似字」，同时**不许提前删东西**（整理不可逆）。

### 2. 提示词为什么要「帮他补完整想法」（`ae7dd85`）

原提示词（从别处抄来的）有一句：

```
不添加他没说的内容，不改变他的意思，不概括，不翻译。
```

这句话把 Typeless 演示里的四种能力全堵死了：

| 演示里的能力 | 现在能做到 |
| --- | --- |
| 事后补充修正前面的词（"哦对，小明是黄晓明的晓明"） | 回去改前面的"小明" |
| 补全模糊指代（"第一部哈利波特" → 《哈利·波特与魔法石》） | 能 |
| 按重要性重排（"停车位最重要" → 挪到第一条） | 能 |
| 把顺口的解释放进括号 | 能 |

改法是：允许补**唯一且公认的名称**、允许回去改他事后修正的词、允许按他明确的顺序重排、允许把解释放括号；同时把底线写死——**不能编造他说过的事实**（数目、时间、人名、承诺）。

**`prompt.mjs` 里的注释记着每一次实测数据**，改之前先读那里。

---

## 六、坑清单（都踩过，别再踩）

| # | 坑 | 症状 | 怎么解 |
| --- | --- | --- | --- |
| 1 | `INPUT` 结构体大小 | `SendInput` 返回 0，粘贴永远失败 | 必须 40 字节 + `LayoutKind.Explicit` |
| 2 | `.gitignore` 的 `build/` | 匹配**任何**叫 build 的目录，`scripts/build/` 全被忽略 | 写 `/build/` 只匹配根目录 |
| 3 | 分支名 | 建仓库时默认 `master`，所有 URL 写的是 `main` → 404 | `git branch -M main` + `gh repo edit --default-branch main` |
| 4 | `.ps1` 的 BOM | PowerShell 5.1 按 ANSI 读，中文注释的字节破坏语法 | 存成**带 BOM** 的 UTF-8；`make-zip.mjs` 里有断言拦着 |
| 5 | `docs/` 是网站根目录 | `../assets/icon.svg` 在本地文件路径下能用，发布后 404 | 把资源复制进 `docs/assets/`，用站点内相对路径。**本地检查器看不出来，要对线上地址跑** |
| 6 | `helper` 变量的暂时性死区 | `helper ? … : …` 立即求值会崩 | 包一层函数延迟到调用时 |
| 7 | `chatEndpoint()` 返回对象 | `Failed to parse URL from [object Object]` | 它返回 `{ baseUrl, name }`，要展开 |
| 8 | WAV 头不是固定 44 字节 | 算出来的音频时长差 100 倍 | Windows SAPI 的 `fmt ` 是 18 字节，`data` 在 38。`pcm.mjs` 的 `wavSeconds` 走 chunk 遍历 |
| 9 | C# 是 **C# 5** 语言级别 | `CS1056 unexpected $`、内联 `out var` 不支持 | 不能 `$"..."` 插值、不能 `?.`、不能 `nameof` |
| 10 | UIA 的程序集 | `CS0006: 未找到 UIAutomationClient.dll` | 要给全路径：`<csc目录>\WPF\UIAutomationClient.dll` |
| 11 | 版本号高 ≠ 适合 | `qwen3.8-omni-flash` 比 `qwen3.5-omni-plus` 新，但思考失控（1304–5459 token、16–72 秒） | 选型要拿真实录音实测，别按版本号挑 |

**两条方法论上的坑**（比代码坑更值钱）：

- **别拿合成语音给自己打分**。Windows SAPI 造的中文干净、没有犹豫和口吃，按它估的参数会系统性偏小。真实录音在 `%USERPROFILE%\.fast-speak\data\Recordings\*.webm`。
- **先穷举候选，再谈调参**。同一个 API 下 4 个 omni 模型的差距是 20–50 倍，比任何参数都大。这一轮开头我一直在调 `thinking_budget`（384 → 1024 → 按秒算），全是在拟合数据；真正的原因是模型选错了。

---

## 七、未完成 / 已知问题

| # | 问题 | 严重度 | 线索 |
| --- | --- | --- | --- |
| 1 | **`scripts/dev/` 里堆了 15 个脚本** | 中 | 计划里要合并成一个带参数的 `eval.cjs`，没做。功能重叠的有 6 个（`eval-real` / `eval-omni` / `eval-prompt-qwen` / `eval-repeat` / `eval-loss*` / `eval-twostage`） |
| 2 | **语义重复去重不稳定** | 中 | 两跳之后能做到，但没量化过命中率。建议拿五条以上真实录音统计 |
| 3 | **local 模式没在 Windows 上端到端验证** | 中 | 模型和运行库都在，但速度和准确率没测过 |
| 4 | **国内访问 `*.github.io` 可能不稳** | 中 | `github.com` 通常更稳。README 里有完整的手动安装说明 |
| 5 | **没有代码签名** | 低 | 第一次运行 SmartScreen 会拦，要点"仍要运行" |
| 6 | **自动更新只做一半** | 低 | 会告诉你有没有新版本，换程序要自己装 |
| 7 | **网站没有视频** | 低 | 检查器唯一剩下的 WARN。这页面确实没有视频可放，是有意的 |
| 8 | `docs/verification.md` 里还留着被推翻的方案 | 低 | 已经加了"⚠️ 这一节后来被推翻了"的提示，但没删。历史价值 > 误导风险 |

**没做的功能**（用户明确说过不加，别再主动加）：上下文里的其他七份（屏幕可见文字、应用名、选区）、HTTP 兜底赛跑、修改跟踪、个人词典、"问任何事"、翻译、云同步。

---

## 八、界面和文案的约定

- **三套主题**：`ink`（墨，默认）/ `cinnabar`（朱砂）/ `indigo`（靛）。颜色用 OKLCH，定义在 `src/themes/`。
- **朱砂只表示"它正在为你干活"**：正在听的声波、整理中的波、主按钮、完成时的勾。出错用黄色，不用红色。
- **界面中英双语**，文案在 `src/i18n/locales/`。
- **日志只记长度和耗时，不记内容**（成品是用户说的话）。上下文也只记字数不记内容。
- **落地页的设计约束**（改之前先读 `docs/site.css` 顶部注释）：标题只比正文大一点（"安静的仪器"方向）、单栏宽 34rem、朱砂不给按钮上色（检查器判定过"米白+陶土"是别的品牌的调子，所以按钮是米白底墨字）。

---

## 九、下一步建议（按性价比排）

1. **量化语义去重的命中率**：拿 5–10 条真实录音，每种跑 3 次，统计「换着说法说两遍」能不能合并。这是唯一还没量化的核心能力。
2. **合并 `scripts/dev/`**：15 个脚本压成 4 个（`eval.cjs` 带子命令 + 3 个专用），顺手删掉一次性的。
3. **在 Windows 上跑一遍 local 模式**：至少验证「能转写、能润色、不崩」。
4. 如果还想继续提效果：考虑**只在长录音时开思考**（`thinking_budget` 按秒给，但是给第二跳的纯文本模型，不是给听写那一步）。

---

## 十、怎么验证没被我改坏

```powershell
npm run check                       # 784 单测 + 6 安装测试，必须全绿
npm run lint                        # biome，必须干净
```

拿真实录音验效果（需要一把 Qwen key，存在 `%USERPROFILE%\.fast-speak\qwen-key.bin`）：

```powershell
node_modules\electron\dist\electron.exe scripts\dev\eval-twostage.mjs
```

它会跑三条真实录音，打印两跳的耗时、字数和成品。看两件事：**耗时 3–5 秒**、**口头禅和语义重复被删掉**。

网站改完要**对线上地址**再验一次（本地检查器发现不了路径问题）：

```powershell
node D:\typeless\.skills\taste-skill\scripts\inspect.mjs "https://lijiatu-1.github.io/fast-speak/"
```

`taste-skill` 装在 `D:\typeless\.skills\taste-skill\`（项目外，不进仓库）。
