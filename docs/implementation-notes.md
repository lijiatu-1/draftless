# FastSpeak 实现笔记

给想改代码的人看的：它和 Typeless 原版怎么对应、模型是怎么选的、提示词是怎么调出来的。只想用的话看 [README](../README.md) 就够了。

这份笔记记的是 Windows 上每一层怎么实现、为什么这么实现：和原版做法一致的地方写清依据（对着 docs/targets/typeless/ 的逆向笔记），有差别的地方写清为什么。平台差异的完整对照在 [Windows 移植笔记](windows-port.md)，实际测到了哪一步在[验证记录](verification.md)。下面带"实测"的数字，除了特别说明的，都是在 macOS 版那台机器上测的（2026-10），Windows 上没有重测。

FastSpeak 是照着对 Typeless 2.8.1 的[逆向分析](targets/typeless/README.md)做的，只做语音转写这一件事。下面提到的“原版”都指它。

## 用法上照着原版的地方

- 按一下开始、再按一下结束。按住超过 600 毫秒会取消并提示（原版 2.8.1 不支持按住说话）。
- 热键按着的时候又按了别的键，当作组合键处理，悄悄取消。
- 说话的时候按 `esc` 取消；悬浮条上左边取消、右边完成，点完成等于再按一下热键（原版的状态机里也是这几条路）。等成品时取消不了。
- 等成品最多 20 秒；单次录音最长 9 分钟。
- 贴字只有粘贴一条路：存剪贴板、写入要贴的文字、模拟 Ctrl+V、0.3 秒后把剪贴板还回去。
- 麦克风完全没信号时（设备被静音、选错输入）不上传，直接报错。

## 和原版的对应关系

协议照抄抓包看到的消息名和字段名（[05 网络协议](targets/typeless/docs/05-network-protocol.md#websocketwsrt_voice_flow)），只实现听写用到、并且 FastSpeak 的客户端会发的那几条。

| 方向 | 消息 | FastSpeak |
| --- | --- | --- |
| 客户端 → 服务端 | `start_audio` | 只用 `audio_id`，其余字段收下不用 |
| | `set_audio_chunk_info` + 二进制帧 | 序号从 1 开始，按序收；第一块的文件头必须是 Ogg 或 WebM |
| | `end_audio` | 只用 `audio_id` |
| | `set_mode_config`、`replace_audio_context` | 不实现（不采集上下文；原版用前者选听写 / 问点什么 / 翻译，这里只有听写——native 和 local 是识别链路的选择，不走协议） |
| 服务端 → 客户端 | `audio_session_started` | `{audio_id, start_time}` |
| | `received_audio_chunk_count` | `{index, server_t, size}` |
| | `audio_session_ending` | `{audio_id, total_chunks, completed_chunks, failed_chunks}`，这里数的是上传的块 |
| | `audio_processing_completed` | 九个字段与实测相同，听写用不到的五个固定为 `null` |
| | `audio_processing_error`、`error` | `{audio_id, code, detail}` |
| | `debug_info` | 不发 |

和原版不一样的地方：

- **没有登录和签名。** 服务只听本机端口，握手时拒绝带网页来源（`Origin` 为 `http(s)://…`）的连接，防止浏览器里的网页连进来花模型额度。
- **识别和整理是一次模型调用。** 原版服务端内部怎么做的看不到。各块首尾相接后整段发给选的那一家模型（默认 Gemini），Gemini 不用重新编码；OpenAI 不收 Opus，先在本机转成 WAV，见下面[不止一家模型](#不止一家模型)。
- **容器多认一种 WebM。** 原版用自带的编码库出 Ogg；浏览器自带的录音接口出的是 WebM，里面同样是 Opus。服务端按文件头判断是哪一种，实测 Gemini 两种都收。
- **不采集上下文。** 原版会把当前应用、输入框内容、屏幕可见文字一起上传（[06](targets/typeless/docs/06-context-capture-and-privacy.md)），这里只上传录音。

## 选型时测到的数

测试音频是系统朗读合成的一段 20.7 秒中英混说，带口头禅和一次改口；不是真人录音，结论只能当起点（真实录音的结果见下一节）。耗时是从本机经代理到 Gemini 的整次请求。

| 模型 | 思考档位 | 连接复用后的耗时 | 整理效果 |
| --- | --- | --- | --- |
| `gemini-3.5-flash-lite` | 默认 | 1.2–1.5 秒 | 口头禅删了，改口的痕迹（"不对，应该…"）留着 |
| `gemini-3.5-flash` | `MINIMAL` | 1.6–1.8 秒 | 改口处理对了，"就是说"有时留着 |
| `gemini-3.6-flash` | `MINIMAL` | 1.9–3.6 秒 | 同上 |
| `gemini-3.8-flash` | `LOW` | 2.3–3.3 秒 | 最干净 |
| `gemini-3.8-flash` | 默认 | 6–8 秒 | 最干净，思考用掉了大部分时间 |

原版实测是 `end_audio` 之后 1.4–1.9 秒出成品，所以默认选了 `gemini-3.5-flash`。后来 Google 停用了 3.5 Flash，发给它的请求自动转给 3.6 Flash（官方弃用页；2026-10-14 实测回话报的就是 3.6），默认值也就直接改成了 `gemini-3.6-flash`：实际用的模型没变，只是名字写对了。上表里 3.6 比当时的 3.5 慢一点，转过去之后的速度见下面"记账"一节的实测。

另外三个结论：

- **分块不用重新编码。** 7 个独立编码的 3 秒 Ogg 流首尾相接，Gemini 能从头识别到尾。
- **不能让模型在没有人声时"什么都不输出"。** 那样写时，3 秒静音 6 次里有 4 次编出了一句话。改成输出固定标记 `<无人声>` 后，静音和噪声各 6 次全部输出标记，服务端再把标记换成空字符串。
- **慢的只有进程里的第一次。** 第一次整理要 3.4–4.1 秒，之后稳定在 1.7–1.9 秒，闲置 70 秒和 180 秒后再测也一样，连接没有断。所以服务端只在启动时发一个最小的请求预热，不在每次录音前预热。这一步顺带验证了 key，无效时启动日志里会有 `warm_up_failed`。
- **要求 JSON 输出会让整理变差。** 用 JSON 字段表达"有没有人声"时，模型不再处理改口，所以没有采用。

## 用真实录音调过之后

2026-10-13 用作者自己 Typeless 历史里的 60 条真实录音（2026-08 之后的，2 秒到 121 秒）调了提示词，原版当时的成品当参照。

先核对了原版的排版规律（2853 条成品的统计）：62% 有换行，几乎都是空一行分段；15% 用了 `1.` 这种编号列表，列表前有一句以冒号结尾的话，项与项之间不空行；没有粗体和标题。跟时长强相关：10 秒内几乎不换行，20–40 秒 83% 分段，40 秒以上几乎全分。近两个月以陈述句收尾的成品有八成多不带最后那个句号。

| | 写坏的成品 | 原版分段的 38 条里也分了 | 原版用列表的 16 条里也用了 | 耗时中位 |
| --- | --- | --- | --- | --- |
| 调之前 | 10 条 | 6 条 | 0 条 | 2.1 秒 |
| 定稿（跑了 5 遍，每遍 60 条） | 0–1 条 | 33–35 条 | 7–9 条 | 1.9–2.0 秒 |

原版没分段而这里分了的是 0–3 条（共 22 条），原版没用列表而这里用了的是 0–1 条（共 44 条）。5 遍里后 2 遍是最终版，前 3 遍只差一条"列表从 1 开始编号"的规则。

"写坏的成品"指一眼能看出不对的：开头多出一个不相干的外文词、只输出了开头一小截、中间一长串下划线、整段写成繁体、正文里夹着时间戳。改了这几处：

- **不再把温度设成 0。** 只去掉这一项，同一批录音写坏的就从 10 条降到 5 条，截断和下划线没再出现。
- **录音后面跟一句文字。** 只给录音时成品开头偶尔会多出一个外文词，加上之后少了很多。
- **提示词加了排版规则和三个长例子**（分段、列表、隔了几句才改口）。
- **剩下压不住的在代码里兜底**：繁体字转成简体（[opencc-js](https://github.com/nk2028/opencc-js)）；开头多出的外文词去掉；成品里夹着时间戳就重新请求一次；最后一个句号去掉。前两条规则拿原版 2853 条成品验过误伤：分别是 0 条和 1 条。

还比不上原版的地方：

- **专有名词和人名会听错。** 原版会把当前应用和屏幕文字一起上传当上下文，这里只有录音。去掉标点后和原版成品的文字相似度，5 遍的中位在 0.80–0.82 之间。
- **列表用得比原版少。** 没说"第一、第二"但并列了几件事的话，原版更常整理成列表。
- **口吃偶尔删不干净**，约每 60 条 1 条。最常见的是单字的结巴（"要要做"）：2026-10-15 把它写进规则和例子，一段带"要要"的录音 30 次里从 6 次降到 2 次，没断根。思考档位调到 `LOW` 也断不了根（同一段 40 次里还有 2–6 次），耗时中位还多 0.3 秒左右，所以没改默认档位。也不在代码里删：原版 2888 条成品里单字重复的 42 处大多本来就对（"现在在跑""主要要汲取""不要要求""有有效期""用不了了"）。

## 不止一家模型

录音交给哪一家整理是一个策略：每家一个适配器，管"请求怎么拼、收哪些录音格式、报错怎么认"；提示词、收尾（繁转简、去句号、夹时间戳重来）、转格式是各家共用的一条流程。

```text
设置里的 model（openai/gpt-audio-mini）
   │
   ▼
src/server/providers/index.mjs   厂商清单：名字、key 的环境变量、申请页、默认模型、有没有思考档位。不加载 SDK
   │ load()
   ▼
providers/gemini.mjs、openai.mjs 适配器：ping()、generate()、AUDIO_TYPES、classifyError()
   │
   ▼
src/server/refine/refiner.mjs     共用的流程：这家不收录音的格式就先转（src/server/audio/），拿原文，统一收尾
   │                              出错一律抛 ModelError，分成 key / unavailable / other 三类（providers/errors.mjs）
   ▼
src/server/server.mjs             听写协议那一侧不知道背后是哪一家
```

每家一把 key，存成 `%USERPROFILE%\.fast-speak\<厂商>-key.bin`，用当前用户的 DPAPI 加密（Electron 的 `safeStorage`，见下面“安装和运行环境”）。Windows 版一开始就只有这一份，没有要从别处搬来的旧文件。设置里的 `model` 写成 `厂商/模型`；只写一个 Gemini 模型名的写法（macOS 版早期的）也照样认。

加厂商的规矩：作者点名要哪家才加。2026-10-13 先查了 DeepSeek：官方文档里它的对话接口只收文字、图片和文件（文件也只认图片格式），没有收音频的地方，也没有单独的语音识别接口，所以没接。除了 Gemini，官方文档写明能"收音频、按提示词一次出成品"的是 OpenAI（`gpt-audio` 系列）和阿里通义（Qwen-Omni）；作者选了先接 OpenAI。

**本机转写那一半照旧，只是运行库换成 Windows 的包。** local 模式第一步是本机的小模型：模型文件（`.onnx` / `.gguf`）和平台无关，还是从同一个源下载、核对 SHA-256；跑它的运行库由 npm 的预编译包提供，Windows 那份按本机自动选（`sherpa-onnx-win-x64`、`@transcribe-cpp/win32-x64-cpu-vulkan`）。走哪条加速后端由运行库自己挑：transcribe.cpp 在有 Vulkan 的机器上走 Vulkan，没有就退回 CPU；sherpa-onnx 那一份是 ONNX Runtime 的 CPU 版，没得挑。`catalog.mjs` 里那些 `measured` 全是 Apple 芯片上的数，在 Windows 上 `measuredOn(model, "windows-x64")` 返回空，界面就显示"还没有在这类机器上实测"——宁可空着，也不拿 Apple 芯片的数字冒充 Windows 的。

### OpenAI 那边实测到的

用的是作者的实验用 key，2026-10-13 从西雅图测的。录音是作者自己用 FastSpeak 时的 6 段测试录音（1.7–33.7 秒），没有用 Typeless 的历史录音（发给 OpenAI 这件事没问过作者）。

- **只收 wav 和 mp3。** 传 webm、ogg 都回 400："Supported values are: 'wav' and 'mp3'"。悬浮条录的是 WebM（Electron 的录音接口录不了 Ogg，实测 `MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")` 是 false），所以服务端先解码（[@audio/decode-webm](https://www.npmjs.com/package/@audio/decode-webm)）、降到 16 kHz、封成 WAV。降采样和封 WAV 是自己写的（`src/server/audio/pcm.mjs`），一分钟的录音约 60 毫秒。
- **采样率要降。** 同一段 90 秒的录音，48 kHz 的 WAV 要 18 秒，24 kHz 和 16 kHz 是 6–9 秒；三种算出来的音频 token 一样多（907），所以降采样只省上传、不省钱。
- **验证 key 不能发纯文字。** 这几个模型要求输入或输出里有音频，纯文字的请求回 400；所以带一段 0.1 秒静音、只要 1 个 token，约 0.7 秒。
- **报错**：假 key 回 401 `invalid_api_key`，写错的模型名回 404 `model_not_found`，都按实测写进了分类。账号没额度（429 `insufficient_quota`）、所在地区不支持（403 `unsupported_country_region_territory`，归成"暂时用不了"、提示查代理，不叫人换 key）照官方文档的错误码写的，没测到。
- **长录音慢。** WAV 比悬浮条录的 Opus 大七八倍，一次请求最多等 30 秒、包括上传；悬浮条那边等成品最多 20 秒（照原版）。按 90 秒的录音要 6–9 秒推算，三分钟以上的录音交给 OpenAI 可能等不到，录音会留着。没实测；要改的话可以换成 MP3（要多一个编码库）或者给 OpenAI 放宽等待。
- **选哪个模型。** 同 6 段录音、同一份提示词：

  | 模型 | 结果 | 耗时 |
  | --- | --- | --- |
  | `gpt-audio-mini` | 6 段都正常，静音那段输出了 `<无人声>` 标记；口头禅偶尔留着（"就是"） | 1.9–4.9 秒 |
  | `gpt-audio-1.5` | 两段把成品包成了 `{"final_text": "…"}` 或 `{"…"}`，两段开头多了换行；另一次同一段录音回了 500 "The model produced invalid content" | 1.7–4.1 秒 |

  所以默认用 `gpt-audio-mini`。提示词是对着 Gemini 调的，没拿成批的真实录音对 OpenAI 调过，作者定了边用边调。Typeless 的历史录音只发给 Gemini，而且它们是 Ogg：拆 Ogg 要用 LGPL 的 codec-parser，作者定了不随程序分发，所以服务端只把 WebM 转成 WAV，Ogg 交给 OpenAI 会直接报错。

### Gemini 的回归

换成策略之后 Gemini 的请求和以前一样。同一批 60 条 Typeless 录音又跑了一遍（v8），和之前同一份提示词的两遍（v7-1、v7-2）比：

| | v7-1 | v7-2 | v8 |
| --- | --- | --- | --- |
| 成功 / 写坏 | 60 / 1 | 60 / 0 | 60 / 0 |
| 文字相似度中位 | 0.80 | 0.82 | 0.80 |
| 原版用列表的 16 条里也用了 | 7 | 9 | 7 |
| 耗时中位 | 1.9 秒 | 1.9 秒 | 2.3 秒 |

v8 在前两遍之间。耗时多了 0.4 秒，原因没查实：每次请求的代码路径没有多出步骤，两次测的时候网络环境可能不一样。

## 记账：花了多少钱、多少 token、等了多久

原版是包月的，不需要这一项；这里每次调模型都按量收费，所以每一次回了话的调用都记一笔账。

```text
providers/gemini.mjs、openai.mjs        从回话里取用量，按回话报的型号查自家的价目表（providers/prices/）算钱
   │ { model, inputTokens, audioTokens, cachedTokens, outputTokens, thinkingTokens, costUsd }
   ▼
refine/refiner.mjs                      量一下等了多久，记一笔（onCall）：听写的带上 audio_id，验证 key 的算 check
   ▼
src/app/main.mjs → storage/history.mjs  存进历史库的 model_calls 表
   ▼
src/usage/report.mjs                    今天、本月、累计、按型号分开；fastspeak usage 和主窗口首页共用这一份
```

规矩和为什么：

- **价格只抄官方价目页的标准档付费价**（2026-10-14 抄的，出处写在 `providers/prices/` 两个文件的开头）。Gemini 在免费档里用不收钱，可接口不告诉我们这把 key 在哪一档，所以一律按付费价估算，界面上写明是估算。价目表里没有的型号 token 照记，钱写"价格不明"，不混进花费。
- **按回话报的型号算钱，不按请求的。** 实测请求 `gemini-3.5-flash`，回话里的 `modelVersion` 是 `gemini-3.6-flash`：官方弃用页写着 3.5 Flash 已停用，请求自动转给 3.6 Flash。3.6 Flash 不分文字和音频，输入 $0.75、输出 $3.75 每百万 token，2027-01-01 起翻倍；价目表按调用那天取价。OpenAI 回话报的是带日期的快照名（`gpt-audio-mini-2025-12-15`），去掉日期查价。
- **用量字段对着实测的回话写。** Gemini 的 `promptTokenCount` 含音频；思考的 token 单独报在 `thoughtsTokenCount`，不在 `candidatesTokenCount` 里（开 HIGH 实测：提示 26、输出 1、思考 179，合计 206），输出价按两者之和算；不思考时回话里没有这一项。OpenAI 的 `prompt_tokens_details` 分得出文字和音频；gpt-audio 系列的缓存价一栏是"-"，命中缓存也照原价算。
- **回了话但用不了的也记。** 被截断、被拦下的回话是收了钱的，所以适配器不再自己抛这类错，带着用量交回去，由整理流程记完账再报错。
- **没回话的记不了。** 用量只在回话里，没回话就没有数。连不上的请求没发出去，本来就不收钱；发出去了却等不到回话的（30 秒超时、听写服务关掉时断开）对方可能已经算完、照样收钱，账上会少这一笔，收没收没法知道（没验证），所以只在日志里记一条 `model_call_unmetered`。悬浮条上按 `esc` 取消发生在交出录音之前，不会碰到这种情况。
- **记账出错只写日志**，不能因为少记一笔把用户的这句话丢掉。
- **等了多久量的是发出请求到收齐回话**，不含本机转格式（交给 OpenAI 前那一步，一分钟的录音约 60 毫秒）。一次听写重来过的，几次加在一起才是用户等的；报表给中位数（"一般"）和九成分位（"慢时"）。
- **账存在历史库里**，库的版本从 1 升到 2，旧库打开时自动升上来。退回 0.4.2 之前要先降回去（命令写在 `src/storage/history.mjs` 的 MIGRATIONS 注释里），只丢账，不丢历史。

一次听写多少钱（合成的 5 秒语音，两家各走一遍端到端）：

| | 输入 token（其中音频） | 输出 token | 花费 | 模型用时 |
| --- | --- | --- | --- | --- |
| Gemini（实际是 3.6 Flash） | 1500（135） | 18 | $0.0012 | 3.4 秒 |
| OpenAI `gpt-audio-mini` | 1576（54） | 19 | $0.0015 | 2.7 秒 |

钱的大头是每次都带上的提示词：Gemini 那边光提示词就有 1365 个 token，占了这一次花费的八成多。所以接着做了提示词缓存。

### 提示词缓存

- **隐式缓存用不上。** Gemini 2.5 以后默认开着隐式缓存，命中的部分只收一成的价，但 3.6 Flash 要提示词前缀至少 4096 个 token 才会命中（[官方缓存文档](https://ai.google.dev/gemini-api/docs/caching)），我们的提示词 1350 个（`countTokens` 实测），上面几次一次都没命中。
- **显式缓存可以。** 实测在 3.6 Flash 上拿这 1350 个 token 建得起来（没被门槛拦下）；带着它的请求，回话里 `cachedContentTokenCount` 是 1350，成品一字不差。带缓存时不能再写 `systemInstruction`（实测 400），思考档位照设。缓存没了时回 403 "CachedContent not found (or permission denied)"。建一个约 0.7 秒，续一次约 0.4 秒。
- **怎么收钱。** 带缓存的请求里那 1350 个 token 按缓存价（3.6 Flash 是 $0.075 每百万，一成）；存着按小时收存储费（$0.50 每百万 token 每小时，2027 年起翻倍）；建的时候按标准输入价收一次——这一条是 [Vertex AI 的缓存文档](https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview)写的，Gemini API 的文档没说，按同样的算，**没验证**。存储按设的时长收、删早了不退，是社区里的说法，也没验证，所以账上记的是买下的时长。
- **什么时候建、放多久。** 开口说话（`start_audio`）时建，已经有了就往后续；说完整理时带上。建要 0.7 秒，录音一般好几秒，所以第一句话也用得上。放多久拿作者在原版上 126 天、3169 次听写的时间间隔（中位 3 分钟）模拟过，只算提示词那部分的钱：

  | 没人说话多久后过期 | 建了几次 | 存了多久 | 提示词的钱省多少 |
  | --- | --- | --- | --- |
  | 5 分钟 | 1339 | 152 小时 | 45% |
  | 15 分钟 | 828 | 324 小时 | 57% |
  | 30 分钟 | 587 | 496 小时 | 61% |
  | 60 分钟 | 391 | 734 小时 | 62% |

  取 30 分钟：再长省不了多少，空存着的时间倒是更长。隔很久才说一句的话（建一次只用一次），这一句反而比不缓存贵约两成。
- **出岔子都退回原样。** 缓存没了就照原样再发一遍；型号建不了（4xx，比如 4 Argon 起只有隐式缓存）就不再试；建不好只记警告。缓存只是省钱，不能耽误这一句话。
- **OpenAI 没做。** `gpt-audio-mini` 同样的请求连发 3 次、带上 `prompt_cache_key`，`cached_tokens` 都是 0，价目表上它的缓存价一栏也是"-"。

实测（合成的 5 秒语音，端到端）：开口时建缓存 0.74 秒，这一笔 $0.00135（建 $0.00101 加存 30 分钟 $0.00034）；接着那次整理命中 1350 个 token，花费从 $0.0012 降到 $0.00028，成品一样。再开口时只续期，连着两次续期之间那两秒的存储费不到 $0.000001。

## 界面：主题、窗口和悬浮条

**主题是数据，不是代码。** 三套主题只在颜色的值上不一样，没有哪一套要有自己的行为，所以没有做成“每套主题一个带方法的对象”。做成的是一份约定加一张登记表：

- `src/themes/contract.mjs` 列出界面要的全部颜色：悬浮条 10 个，窗口 12 个（浅色深色各一份）。界面只认这些名字，不知道现在用的是哪一套。窗口里有三个是为观感加的：`glow` 是渐变的另一头（主按钮、键帽、进度从 `primary` 走到它），`aura`、`aura2` 是窗口背后的两团光。
- 每套主题是一个文件，一份符合约定的数据；`index.mjs` 是登记表。加一套就是加一个文件、登记一行。
- 合不合格机器说了算（`themeProblems`）：缺了哪个、多了不认识的、颜色写法不对、该读得清的地方对比度不够（字 4.5、图标和色块 3），都指得出是哪一个。为了让对比度算得了，颜色只认 `oklch(亮度 彩度 色相)` 一种写法。渐变两头都要托得住主按钮上的字，光晕最浓的地方也要托得住正文和次要的字。
- 这一层不依赖 Electron，也不依赖 Node。命令行用它列主题、在终端里画出颜色，主进程用它生成 CSS。

**颜色怎么到页面上。** 页面的样式里一个颜色都不写，只用 `var(--…)`；值由预加载脚本注入。它一上来就同步向主进程要现在这套主题的 CSS，用 `webFrame.insertCSS` 放进页面，这发生在页面的第一个脚本运行之前（实测过），所以不会先闪一下没有颜色的样子。换主题时主进程给每个开着的窗口再发一份，先放上新的再撤掉旧的。命令行换主题走控制通道的 `reload-theme`，不重启。

样式和主题之间的约定有测试把关（`test/themes/css-tokens.test.mjs`）：主题给的变量样式文件里不重复定义、用到的变量都有出处、主题的每个变量都有地方用、样式里不写死颜色。

**窗口：结构照原版，观感是自己的。** 主窗口（`renderer/hub/`）照原版：左边侧栏切首页和历史记录，设置是盖在上面的对话框；原版把红绿灯塞进侧栏左上角，Windows 上没有红绿灯，这里是把标题栏藏起来、用 `titleBarOverlay` 把最小化/关闭画在右上角，符号颜色跟着主题走（深色主题下要白的，不然在深色底上看不见）。首次引导（`renderer/onboarding/`）照原版的"注册 · 设置 · 体验一下"三段，没有账号，第一段换成接上模型。观感不照抄原版的灰白：

- 窗口背后铺两团主题色的光（`aura`、`aura2`），一直不动。卡片和列表是半透明的面，透出一点光的颜色，上沿一道亮边。
- 玻璃（`backdrop-filter`）只用在后面真有东西的地方：侧栏（透出光，颜色被提一点）、设置对话框（后面的首页先整体模糊一层）、内容区往下滚时顶上那条拖窗口的地方（滚上去的字在它底下变模糊）。卡片后面只是平滑的光，加模糊看不出区别，就不加。
- 主题渐变只铺在小面积上：主按钮、开关、键帽、引导的进度和电平条。试过把首页的口述卡整块铺满渐变，太大太抢眼，收成了一张普通的卡，渐变只留在键帽上。
- 灰阶和面的颜色在 `shared/window.css` 里从主题的正文色、底色用 `color-mix` 调出来，换主题、换深浅色都跟着变。热力图的深浅在 oklab 里混：在 oklch 里把主题色和纯白（彩度为 0、色相写的是 0）混，色相会往 0 度拉，朱砂的浅档成了粉色（截图看到的）。
- 系统关掉"透明效果"时（`prefers-reduced-transparency`），玻璃和半透明的面换成实底。这个媒体查询在 Windows 上认不认那个开关，没验证——样式是照 CSS 的写法接的，macOS 版那边验过。
- 界面上的字是短词短句，细节放进悬停提示。

**悬浮条分三层。** `bar-view.mjs` 由状态机的状态算出该是哪种样子、提示怎么写（纯函数，有测试）；`bar-ui.mjs` 加 `bar.css` 把样子画出来，要宿主代办的只有两件事（显示/收起窗口、截哪几块）；`bar.mjs` 只剩控制。换主题只动数据，换壳只换那两件事的实现。

**为什么小帮手是一个独立进程。** 先试过不写原生代码：用 [koffi](https://koffi.dev) 在 Electron 主进程里直接调 Win32，钩子能装上（`SetWindowsHookExW` 拿到了有效句柄），但低层钩子的回调必须装在跑消息循环的那个线程上，而那个线程一回调 JS，Node 的主线程就被饿死——实测主线程的定时器 1.2 秒只跑了 2 拍（正常 12 拍）。"钩子收到按键 → JS 处理 → 决定吞不吞"这条路上走不通，所以退回 macOS 版的做法：一个独立的 `fast-speak-helper.exe`，和主进程"一行一个 JSON"说话。编译用系统自带的 `csc.exe`（.NET Framework 4，不用另装 SDK），`src/cli/native-helper.mjs` 按源码的 SHA-256 决定要不要重编。

**为什么点击和 `esc` 不经过悬浮条的窗口。** 悬浮条的窗口整个点不到（`setIgnoreMouseEvents(true)`，鼠标事件全部穿过去），它也拿不到键盘焦点（`focusable: false`）。两个按钮的点击和 `esc` 是原生小帮手在事件到达任何窗口之前截下来的：

- 试过让窗口自己收点击（macOS 版上做的这个试验）：Electron 的 `panel` 类型窗口加 `focusable: false`，点一下，最前面的应用还是从原来那个变成了我们（实测）。焦点一走，文字就贴不回原来的输入框。Windows 上同理，点击一旦真的落在我们的窗口上，前台就换人，所以这里也没有让窗口自己收点击。
- 原版也是 Electron，它的做法是点了之后用 AppleScript 把原来的应用重新切回最前面。这样原来的窗口会闪一下，而且要多一项“自动化”权限。Windows 上没有一条同样干脆的"把前台还回去"的路：`SetForegroundWindow` 自己有前台锁那套限制，成不成还得看对方是谁。
- 所以这里换了一条路：小帮手装两把低层钩子（`WH_KEYBOARD_LL`、`WH_MOUSE_LL`），平时不截，只在说话的时候打开——`esc` 和落在两个按钮范围里的鼠标按下、松开都吞掉，报给主进程，别的事件原样放行。这两把钩子不要授权，普通权限的进程就能装；装不上（安全软件拦了，或者进程没有桌面会话）时悬浮条不画那两个按钮，提示里也不提 `esc`，和 macOS 版缺辅助功能权限时是同一套降级。
- `esc` 必须吞掉而不是只听：不吞的话，取消听写的同时前台应用也会收到它，对话框会被关掉，终端里正在跑的东西会被打断。按下、长按的重复、以及那一下的松开都要吞——只吞按下的话，前台应用会收到一个没头没尾的半个事件。
- 几道保险：条收起来、页面崩了时主进程都会再说一遍“不截了”；小帮手截了 10 分钟没人理就自己松开（`--capture-limit` 可以调）。`esc` 一直被吞掉的话，在哪个应用里都按不出来。
- 踩过的坑：钩子过程要存成字段，不能是临时委托——被回收之后钩子还挂着、回调已经没了，之后按什么都没反应。还有一处是"手还没松开时说不截了"：那一半的按下和松开还得照常收，只能清状态，不然下一次按下会被当成上一次的延续。

**贴字也归小帮手，只有还原的粒度不一样。** 流程是：存剪贴板 → 写入要贴的文字（`CF_UNICODETEXT`）→ `SendInput` 发 Ctrl+V → 0.3 秒后把原来的还回去。macOS 的 NSPasteboard 一个 item 可以带多种类型、按 item 分组还原；Windows 的剪贴板是一张"格式 → 数据"的表，没有分组，所以按格式逐个存、逐个还。

- 两个存不下来的：延迟渲染的格式（拿到的是空句柄，真正的数据等系统来问），还原时只能丢掉那一种；`CF_BITMAP` 是 GDI 句柄而不是 HGLOBAL，也存不了——它一般和 `CF_DIB` 一起在，所以图片通常还原得回来。
- **贴失败时剪贴板不还原**，文字留在里面。这是"粘贴失败不能让用户丢字"的落地点：失败时也还原的话，那句"文字已复制，按 Ctrl+V"就是假话。
- 目标窗口是管理员权限时，UIPI 不允许低权限进程往高权限窗口发按键：`SendInput` 不报错、前台窗口却收不到，回 `reason: "uipi_blocked"`。发之前先比一次令牌提权状态（`Paste.ForegroundBlocksInput`），确定发不进去就不白发——否则会报贴好了、用户什么都没看到。判定和"不可写就给复制兜底"的对应关系见[移植笔记](windows-port.md#贴不进去先问一句再决定)。
- 剪贴板被别的程序占着（`OpenClipboard` 一秒内抢不到）时连存都存不下来，回 `reason: "clipboard_busy"`。这一路小帮手没写过剪贴板，所以由 `delivery.mjs` 补写一次；主进程那边也写不进去时，悬浮条改说"成品在历史里，从那里复制"，不谎称已复制。
- 写进去的时候顺带打三个"别记我"的标记（`CanIncludeInClipboardHistory`、`CanUploadToCloudClipboard`、`ExcludeClipboardContentFromMonitoring`），对应 macOS 版那个 `NSPasteboardType.transient`：不打的话你对着 FastSpeak 说的话会留在 Win+V 历史里。`--selftest` 里 `not_for_history_markers` 盯着这三个格式名系统认不认。

还没做的：悬浮条只出现在主显示器上，位置是那块屏幕可用区域的底边（任务栏上面），不跟着鼠标换屏（原版每 100 毫秒看一次鼠标在哪块屏幕上，跟着换）。

## 安装和运行环境

目标是跑一次脚本就装好：装的人不用另装编译器（从源码跑时要编小帮手，用的是系统自带的 .NET Framework 4），装的东西和产生的东西都在 `%USERPROFILE%\.fast-speak` 一个目录里（`app\`、`data\`、`models\`、`logs\`、`run\`、`cache\`，布局和 macOS 版一样）。

- **后台应用跑在 Electron 里，命令行跑在系统的 Node 上。** 从源码跑时，命令是 `bin/fastspeak.mjs`（要 Node 22.13 以上），后台应用由 `src/cli/daemon.mjs` 用 `node_modules\electron` 里那份 `electron.exe` 起；装好的那份，后台就是 `<家>\app` 里的 `FastSpeak.exe` 自己。Electron 里本来就有一个 Node（44.7 里是 24.21，带着 `node:sqlite`）——macOS 版那边连命令行都拿它跑（`ELECTRON_RUN_AS_NODE=1`，`fastspeak --version` 41–43 毫秒），Windows 这边走的是系统 Node，那条路没有对应物，41–43 毫秒也就没在这边测。
- **打包出一个能整目录拷走的文件夹。** `npm run dist`（`scripts/build/package.mjs`）先编小帮手、摆一个只含运行时依赖的暂存目录（`stage-app.mjs`，顺带把许可证和 MIT 不兼容的包拦下来），再交 `@electron/packager`（win32、x64、`asar: false`）。出来是 `dist\FastSpeak-win32-x64\`：`FastSpeak.exe` 加 `resources\app\`（代码、编好的小帮手、图标、`node_modules`）。不打 asar 是因为小帮手得能直接执行，页面和主进程的路径也和开发时一样。
- **安装脚本只做搬运，没有签名。** `scripts/build/install.ps1` 先请正在跑的那份退出（不退就结束掉），拷到 `<家>\app.new` 再整个换上去（中途失败时原来那份还在），建一个开始菜单快捷方式，再在 `<家>\bin` 里放一个 `fastspeak.cmd`、把 `<家>\bin` 加进用户的 PATH。入口单独放一个目录是有原因的：`<家>\app` 里那个 `FastSpeak.exe` 和命令同名（Windows 不分大小写），而 `PATHEXT` 里 `.EXE` 排在 `.CMD` 前面，直接把 app 加进 PATH 的话敲 `fastspeak` 会弹出窗口而不是跑子命令。这个 `.cmd` 用环境变量 `FASTSPEAK_ARGV_MODE=cli` 告诉 exe 走命令行——不能用 `--cli` 这种开关，Electron 会把不认识的 `--xxx` 当成自己的参数直接拒掉（报 `bad option`）。`main.cjs` 认这个变量，把子命令交给 `src/cli/main.mjs`，并且把 Chromium 的缓存目录挪进我们自己的 `cache\`、顺手关掉硬件加速，免得跑一条 `fastspeak status` 就在 `%APPDATA%` 下留一堆东西。不往系统目录里装，也不要管理员；家目录以外只多出那个开始菜单快捷方式。没有代码签名（要证书，这一版没有），第一次运行 SmartScreen 会拦一下（"更多信息 › 仍要运行"）；也没有 NSIS 那类安装程序。
- **Electron 的二进制是另外补的。** `node_modules\electron` 只是几十 KB 的壳，二进制在那个包的 `dist\` 里。`@electron/get` 在测过的网络下会报 `fetch failed`（同一个地址用 PowerShell 是通的），所以 `npm install` 后面挂了一个 `postinstall`：`scripts/build/fetch-electron.mjs` 用 PowerShell 下载、按 electron 包自带的 `checksums.json` 核对 SHA-256、再解到该在的位置。核对不过就重下一次，还不对就报错，不在磁盘上留一份坏的。
- **入口是 CommonJS 的 `main.cjs`。** 从打包好的 exe 双击启动时，ESM 里的 `import { app, BrowserWindow } from "electron"` 会报 `does not provide an export named 'BrowserWindow'`，进程静默退出；同一份代码用 `electron.exe <app 目录>` 起就完全正常。所以入口换成 CommonJS：用 `require` 拿到真的 electron 对象挂到 `globalThis` 上，`src/app/electron.mjs` 负责取到它，下面那些 ESM 的代码一行没改。
- **key 用当前用户的 DPAPI 加密。** 每家一个 `<厂商>-key.bin`，加密交给 Electron 的 `safeStorage`（背后是当前用户的 DPAPI）。和 macOS 版能承诺的不一样：钥匙串按应用隔离，别的应用读不到；DPAPI 按用户隔离，同一个用户下的其他程序也解得开。所以这里能说的是"离开这台机器、这个用户就解不开"，不是"别的程序读不到"。也没有"App 那份和命令行那份要合并"这回事——一开始就只有一份。
- **要用户动手的权限只剩麦克风。** 麦克风是一条系统隐私开关（第一次要麦克风时弹一次框，之后按"设置 › 隐私和安全性 › 麦克风"走）。两把低层钩子不要授权，装上就有；装不上多半是安全软件拦了，或者进程没有桌面会话。界面上把它们显示成"装上了 / 没装上"，不带"授权"按钮——Windows 上那两项没有对应的设置页，给个按钮只会点出一个错。三个名字（`microphone`、`listen`、`trusted`）照旧沿用 macOS 版的，含义按 Windows 的事实来：`listen` 是键盘钩子装上没有（没有就听不到热键），`trusted` 和 `capture` 都是鼠标钩子（没有就拦不住 `Esc` 和悬浮条上的点击，悬浮条也不画那两个按钮）。`trusted` 不写死成 true：写死的话"点击拦截没装上"这件事永远说不出来，`setup-state.mjs` 那条降级提示就永远不触发。真正被拦的是贴字那一步的 UIPI，那个另算。
- **起停靠进程号，不靠信号。** `fastspeak stop` 先通过控制通道请它自己 `quit`，等 5 秒还不退就 `taskkill /PID <pid> /T /F`，把整棵进程树（连转写子进程和小帮手）一起结束。要确认那个进程号跑的还是我们，用 `Get-CimInstance Win32_Process` 取命令行——Windows 上没有 `ps -o command=` 这回事；只看有没有 `electron` 字样不够，别的程序的辅助进程路径里也有，所以还要认 `electron.exe` / `FastSpeak.exe`。
- **更新只问版本，不换程序。** 这一版没接发布链。要让 `fastspeak update` 有用，用 `FASTSPEAK_INSTALL_BASE` 指一个网址前缀或者本机目录，那里放一个 `latest.txt`（一行一个版本号）：`update` 只说有没有新的、怎么换（下载新的解到同一个地方，或者重跑安装脚本），`status` 靠 `run\update-check.json` 一天问一次。没配时会明说"这一版没有配置更新源"，不叫人以为已经是最新的。为什么不做自动替换：Windows 上让正在运行的 exe 自己替换自己要绕过文件占用、杀毒软件的写入拦截、UAC 提权，第一版不碰这条线。
- **退回旧版本要先把历史库降回去。** 表结构的版本从 1 升到 2（多了记账那张表），旧版本见到比自己新的库不敢动、启动不了。要退回，先删掉 `model_calls` 表、把 `user_version` 降回 1：这两句 SQL 写在 `src/storage/history.mjs` 的 MIGRATIONS 注释里（那里给的库路径还是 macOS 的写法，Windows 上是 `%USERPROFILE%\.fast-speak\data\history.db`）。只丢账，说过的话都在。

**移植时在 Windows 上才暴露的三个 bug。** 都是"在 macOS 上被文件系统行为盖住了"：

- `src/storage/history.mjs`：库的版本比程序新时拒绝打开，但 `migrate()` 抛错之后那个 sqlite 连接一直开着。POSIX 上删一个还开着的文件没问题，Windows 上删不掉（测试收尾时 EPERM）。修法是抛错前先 `db.close()`。
- `src/storage/paths.mjs`：少一个 `appDir`。`fastspeak update` 靠它认出"这是装好的那一份"，缺了就永远说"从源码跑的，用 git pull"，`status` 也永远不提醒新版本。
- `src/cli/commands/uninstall.mjs`：`--keep-data` 读的是一个已经不存在的字段（`runtimeDir`），于是 `<家>\runtime` 从来没被删过，每次卸载还会打一条 Node 的弃用警告。

## 各文件

| 文件 | 做什么 | 对应原版 |
| --- | --- | --- |
| `scripts/build/package.mjs`、`scripts/build/install.ps1` | 打包和安装，见上面“安装和运行环境” | 原版是 macOS 上的一个 .dmg |
| `bin/fastspeak.mjs`、`src/cli/` | `fastspeak` 命令：起停后台应用、问 key、换模型、看历史、改设置、卸载。每个子命令在 `commands/` 里一个文件，画面在 `render/` | 原版没有命令行 |
| `src/cli/daemon.mjs` | 起停后台应用：用它找 Electron、编小帮手、等它准备好；停的时候先 `quit` 再 `taskkill /T /F` | |
| `src/control.mjs` | 命令和后台应用之间的控制通道（命名管道 `\\.\pipe\fastspeak-<sha256(用户名+数据目录) 的前 16 位>`，一问一答；已经有一个在跑时它用退出码 3 告诉启动它的命令） | |
| `src/storage/paths.mjs`、`src/storage/settings.mjs` | 东西放哪（`%USERPROFILE%\.fast-speak`）、有哪些设置。命令和后台应用共用 | |
| `src/platform/hotkeys.mjs` | 热键：能选哪几个（`right_alt` / `right_ctrl` / `right_shift` / `right_win`）、旧名字怎么认（`right_option` → `right_alt` 这些）、左右两边的修饰键都认、右 Alt 和右 Win 在 Windows 上的注意事项。整个仓库只有这里和 `native-win/Hooks.cs` 写死是哪几个键 | |
| `src/themes/` | 主题：界面要哪些颜色、每套主题的值、合不合格怎么查。见上面“界面：主题、窗口和悬浮条” | 原版只有一套外观 |
| `src/storage/legacy.mjs` | 这一版没有别处的旧数据要搬，留一个返回"没搬任何东西"的函数，让调用处不用分平台 | |
| `src/storage/history.mjs` | 历史库和账（每次调模型一笔）。后台应用写，命令只读着看 | `history_v2` 表的子集（[08](targets/typeless/docs/08-local-data.md)）；账是原版没有的 |
| `src/usage/` | 用量报表（今天、本月、累计、按型号）、首页的统计（字数、语速、连续天数、热力图）和数字的写法，命令和主窗口共用。见上面“记账” | 用量原版包月没有；首页统计照原版的"洞察" |
| `native-win/`（`Program.cs`、`Hooks.cs`、`Clipboard.cs`、`Protocol.cs`、`Win32.cs`、`Json.cs`） | 小帮手：听热键（只听不改，不报是哪个键）、贴字；说话时截住 `esc` 和悬浮条上的点击。用系统自带的 `csc.exe` 编成 `build\fast-speak-helper.exe`，和主进程"一行一个 JSON"（`ready` / `hotkey` / `other_key` / `pasted` / `escape` / `click` / `error` / `exit`，和 macOS 版逐字一致） | 键盘子进程和 Swift 库（[07](targets/typeless/docs/07-native-helpers.md)） |
| `src/app/helper.mjs` | 小帮手的主进程那一侧：起它、收发一行一个 JSON、把粘贴的请求和回话对上 | |
| `src/app/main.mjs` | 后台应用的主进程：窗口、托盘、和小帮手对接，把下面几样接起来 | 主进程（[03](targets/typeless/docs/03-process-architecture.md)） |
| `src/app/service.mjs` | 把 `src/server` 跑在主进程里；换 key 先验证再生效 | 原版的服务端在云上 |
| `src/app/modes.mjs` | 切模式、换各模式里的模型：当场生效，先拿新的 key / 模型验一遍 | |
| `src/app/keys/key-manager.mjs` | 每家一把 key：正在用的那家用哪把、是什么状态，启动时去哪找，怎么换、怎么删；给别家存 key、查某个模型能不能用。启动时只是够不着那一家的话先用着 | 原版用登录态，没有这一项 |
| `src/app/keys/key-store.mjs` | key 用当前用户的 DPAPI（Electron 的 `safeStorage`）加密后存成文件 | 原版用登录态，没有这一项 |
| `src/app/setup-state.mjs` | “能不能用、还差什么”的统一结论 | |
| `src/app/delivery.mjs` | 存录音、记历史、贴字；小帮手说贴不进去时把成品补写进剪贴板、在悬浮条上说明一句 | 结果投递（[14](targets/typeless/docs/14-result-delivery.md)） |
| `src/renderer/bar/machine.mjs` | 状态机 | 悬浮条的状态机（[10](targets/typeless/docs/10-interaction-state-machine.md)） |
| `src/renderer/bar/bar-view.mjs`、`bar-ui.mjs`、`bar.mjs` | 悬浮条：该是什么样子、把它画出来、控制 | 原版的悬浮条页面 |
| `src/renderer/hub/` | 主窗口：首页、历史记录、设置对话框 | 原版的 hub 页面 |
| `src/renderer/onboarding/` | 首次引导：接上模型 → 看权限（麦克风 + 两把钩子）→ 测麦克风 → 测快捷键 → 说一句 → 完成 | 原版的 onboarding 页面 |
| `src/renderer/shared/` | 三个页面共用：`tokens.css`（不随主题变的字号、间距、圆角、动效）、`window.css`（窗口的光晕、玻璃、按钮）、填 key 那一块和权限的说法（设置和引导都用） | |
| `src/renderer/bar/recorder.mjs` | 录音，每 3 秒一块 | 录音与编码（[11](targets/typeless/docs/11-audio-recorder.md)） |
| `src/renderer/bar/voice-socket.mjs` | 听写协议的客户端一侧 | 网络协议（[05](targets/typeless/docs/05-network-protocol.md)） |
| `src/server/` | 听写服务：收分块音频（`protocol/`），交给选的那一家模型整理成文字（`refine/`、`providers/`、`audio/`），见上面“不止一家模型”；本机转写在 `asr/`，两种模式（native / local）在 `modes.mjs` | 原版的服务端（内部看不到，只照着协议做） |
