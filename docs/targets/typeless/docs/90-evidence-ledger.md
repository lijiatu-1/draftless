# 90 证据台账

每条结论对应的证据来源。

- `ev_…`：REA 返回的 Evidence ID。MCP 会话的完整记录导出在 `_work/evidence/session-01.json`，命令行产生的在 `_work/evidence/native/`，都不进仓库。
- `readable:文件:行号`：去混淆后的可读树 `_work/readable/dist/` 里的位置。行号由 REA 的分析图给出，或经其定位后阅读。可读树是派生产物，重新生成后行号可能变。
- `本机数据`：对 `~/Library/Application Support/Typeless/` 的只读查询。
- `抓包`：2026-10-13 那一次，`_work/capture/20261013-005104/`，不进仓库。经 REA 读的部分引用 `ev_…`；其余来自同一次抓包里代理插件写出的 `http.jsonl`、`ws.jsonl`、`context/*.json`。

证据等级：**观察**＝直接从发行包字节或本机数据读到；**实测**＝在抓包里看到（样本是 4 次 13 秒以内的普通听写）；**推断**＝由观察推出、未经运行验证；**未知**＝尚无证据。

## 目标身份

| 项 | 值 | 来源 |
| --- | --- | --- |
| 应用 | Typeless 2.8.1（build 2.8.1.130），`now.typeless.desktop` | `ev_2ade80387624…` |
| 主程序 | `Contents/MacOS/Typeless`，arm64，sha256 `39977d69502d05a858f9e8df567b724f5bd769f6f965f8615042f86df3d07123` | open_binary |
| `app.asar` | 文件 sha256 `eb9bcc842478b12a7488d90778ad6b08e6788c8fa5e875782ec2af0387c6c80b`；Info.plist 登记的头部哈希 `a929537840b9…b517fc` | shasum；`ev_2ade80387624…` |
| 原件 `dist/` | 目录摘要 `02ac78addb80…daec8bd` | `ev_746a49c31792…` |
| 可读树 `dist/` | 目录摘要 `b86c4f96d298…2e8a50` | `ev_675220c1fc7d…` |

## REA 记录索引

### JS 与包（MCP 会话）

| Evidence ID | 操作 | 对象 |
| --- | --- | --- |
| `ev_746a49c31792850a11d22af3660a9ecf82f5e8e551fc0588ab6af5daffcd8641` | analyze_javascript_application | 原件 `dist/`（混淆） |
| `ev_9aabf8d385f1891885daedc3b3087587d01028968e628d4570c6b5e2304f9326` | inspect_analysis_view（摘要） | 同上 |
| `ev_675220c1fc7dd61b2392f7eb22389d90bbf8208c787a52c20d25d23687d50bb1` | analyze_javascript_application | 可读树 `dist/` |
| `ev_2c4ab4370c37ff7d5b2cb68424926154aea3916de3886baf93a1a0deb588cfe3` | inspect_analysis_view（摘要） | 同上 |
| `ev_2ade80387624432c0b0686ccbbf429b8611de1129c683c7832b1b4ca0c45e55a` | inspect_plist | `Info.plist` |
| `ev_c38e740933e3b271fb69e066f49d90a6f3df00d80f3c0857f1c85fbfe82401b4` | inspect_signature | 主程序 |
| `ev_7c03de934ec9abea2f3aa40d49042654ce2def9f3ffbd7eadea895fdbd8b9aa1` | inspect_plist | `build/entitlements.mac.plist` |

### 原生库（命令行，Ghidra 12.1.4）

| Evidence ID | 操作 | 对象 |
| --- | --- | --- |
| `ev_b0061cae407510bc2ef9d5c1b87da61c068d4fe545087b1ebb99b941b9279330` | inspect-macho | libContextHelper（原库） |
| `ev_16cad01399e291e3e06e66790d1fd157f7e155c45530de4d2073b07311bfdc46` | inspect-macho | libInputHelper（原库） |
| `ev_d72a2a93e6e6bf2e5f20fd61198605fe28422094cf4428c43979364a7a5e4dcc` | inspect-macho | libKeyboardHelper（原库） |
| `ev_52a412e6963a033e9f589c80317d2097feaf8885ff2d1896cafa7594ff24ff2e` | inspect-macho | libUtilHelper（原库） |
| `ev_7e744c7969bd3c7182b74f0742b31fe8b9cbef09a71c32454f21158dc71d8361` | function | libInputHelper arm64 切片 `_insertText` |
| `ev_de5df527a4d81a4310ceba1be2ada63c9a7d63778e99651f002ed1ee8108ddcc` | function | 同上 `performTextInsertion(with:)` |
| `ev_f14d43e1507e6ccd0f0c84af2c967f2bcf4f8a70ab4972258f89abfa25e577f2` | function | 同上 `simulatePasteCommand(completion:)` |
| `ev_2570dafef3e37ae0a578dae4e5b82e25bdbec5f87433ac681b57ffe3fa03c507` | function | libKeyboardHelper arm64 切片 `KeyboardMonitor.startMonitor` |
| `ev_003da589071155754b6f277fd1190ed8ae95e044be4bda870508d8a82db50c78` | search | libContextHelper 切片：浏览器标识、AX 属性名 |
| `ev_e73d124b0e44cd20541a30ac3e8d35d3df60d6fbb7ea32db11c47501052ee9c9` | search | libUtilHelper 切片：设备 ID、合盖状态 |
| `ev_e39480b286e993667249d23b4651592bf541adf1e0f9d885ade69affe834a31b` | search | libInputHelper 切片：文本读取相关 |
| `ev_96cc9a8e94f47140e687a4a2ece2e69894f576737b016489e2326c9906b08bbe` | search | libKeyboardHelper 切片：类名 |

### 抓包（MCP 会话）

| Evidence ID | 操作 | 对象 |
| --- | --- | --- |
| `ev_eff73fa79df76cd89209dd53f60b83e14f0aff1a4a79082f2f7900f5e47ff660` | inspect_web_network_capture | `capture.har` 第 4、14 条：`get_dictation_settings`、启动时的 WebSocket 握手 |
| `ev_17870b08e45f6267e83e04eaeefb814e610a9d846f565e95d68e76b641f86cf6` | inspect_web_network_capture | 同上，第 1、6、15 条：`sync_status`、`usage_stats`、`metrics_mp` |

`capture.har` 的 sha256 是 `2651eefbb7be44e55729b220e2be7c84b971edf9b1543d45dd12a435db822e6f`，18 条记录，由 `tools/capture.sh har` 从 `flows.mitm` 导出并隐去凭据，重复导出得到相同的摘要。

arm64 切片的 sha256 前 16 位：Context `1ec75d0d3fc5845c`、Input `f28cd2211ddee2ba`、Keyboard `5c2e97d536311e8e`、Util `8a28ad793915931c`。

## 结论

| # | 结论 | 等级 | 证据 |
| --- | --- | --- | --- |
| F01 | 主进程、预加载、worker 和 17 个渲染层文件被 javascript-obfuscator 混淆；主进程 2843 条字符串 | 观察 | webcrack 日志；两次 REA 分析的通道数 8 → 112 |
| F02 | API 主机写死为 `https://api.typeless.com`，环境 `prod` | 观察 | readable:main/index.js:52-59 |
| F03 | 请求签名：`X-Authorization` = 口令式 AES( JSON{…, t, p, d} )，`p` = HMAC-SHA1(`t:版本:路径:用户ID`, `t:盐`)，口令和盐写死在包里 | 观察 | readable:main/index.js:3195-3247、2475-2477 |
| F04 | 登录态请求带 `Authorization: Bearer` | 观察 | readable:main/index.js:3300-3342 |
| F05 | 418 + `ja3_tls_code == 101010101` 时用响应头 `Date` 校正时间差 | 观察 | readable:main/index.js:3409-3417 |
| F06 | `POST /ai/voice_flow` 的字段与回包 | 观察 | readable:main/index.js:17817-17935；REA 端点节点 → 17903 |
| F07 | 上下文信封：RSA-OAEP-SHA256 包 AES-256-GCM 密钥，IV 全零，公钥来自 `/user/get_user_info` | 观察 | readable:main/index.js:3780-3909 |
| F08 | WebSocket `/ws/rt_voice_flow` 的收发消息类型；结束后与 HTTP 赛跑。听写时实际出现的类型见 F51 | 观察 | readable:UfR9-a2Z.js:10755-10800、11142-11560 |
| F09 | 内置黑白名单（版本 1.0.3）及其内容 | 观察 | readable:main/index.js:3670-3704 |
| F10 | HTTP 客户端的 `proxyUrl`：undici 代理且关证书校验 | 观察 | readable:main/index.js:3452-3474、3561 |
| F11 | `audio_context` 的字段结构 | 观察；实测 8 份明文的结构与之一致 | readable:main/index.js:11440-11770；抓包 `context/*.json` |
| F12 | 每 1 秒的常驻焦点轮询，默认不带文字内容 | 观察 | readable:main/index.js:11340-11405 |
| F13 | 听写时上下文分两次取：开始时轻量，录音中补可见文字 10000 / 周围 1000+1000，超时 500 ms。实测第一份在 `start_audio` 里，第二份晚 50–250 ms 经 `replace_audio_context` 整份替换 | 观察；实测 | readable:qA149QP2.mjs:5768-5772、5856-5868 |
| F14 | 黑名单只跳过可见文字和周围内容，不影响光标前后文字。实测微信那次没去采前两项、去采了光标文字，但焦点没取到、采集失败，文字照发这一点没有直接看到 | 推断；实测支持一半 | readable:main/index.js:11468（可见文字）、11546（光标文字，无黑名单条件）、11563（周围内容）、11711（黑名单判定） |
| F15 | 插入后修改跟踪：最长约 15 秒、每秒读输入框全文、结束时发 `/user/traits` | 观察（代码）；抓包时没有触发 | readable:main/index.js:17222-17480 |
| F16 | 插入文字 = 存剪贴板 → 写入带临时标记的条目 → 模拟粘贴 → 恢复 | 观察 | `ev_de5df527a4d8…`、`ev_f14d43e1507e…`、`ev_16cad01399e2…` |
| F17 | 全局按键用 `CGEventTapCreate(HID 层, 头部插入, 主动式, 掩码 0x6001c00)`，在子进程里 | 观察 | `ev_2570dafef3e3…`；readable:main/index.js:12038 |
| F18 | 读上下文全靠辅助功能接口，对焦点应用设 `AXEnhancedUserInterface` | 观察（API 与字符串）；流程为推断 | `ev_b0061cae4075…`、`ev_003da5890711…` |
| F19 | 设备 ID 是自生成的 UUID，存钥匙串并有本地缓存互相修复 | 观察（字符串与 API） | `ev_e73d124b0e44…`、`ev_52a412e6963a…` |
| F20 | 开发开关 `__DEV_API_HOST` 在正式版里生效，主进程与渲染层都读。实测设成本机地址后 HTTP 和 WebSocket 都改走明文连本机 | 观察；实测 | readable:main/index.js:10134-10152；UfR9-a2Z.js:7435 |
| F21 | 窗口会话设为直连，不走系统代理 | 观察 | readable:main/index.js:4578-4581 |
| F22 | 预加载把 `ipcRenderer.invoke` 原样暴露给页面，无通道白名单 | 观察 | readable:preload/index.mjs:69-91；REA 图 context-bridge-api ×3 |
| F23 | 签名：Simply LLC (947QKAND4W)，hardened runtime，4 项 entitlement | 观察 | `ev_c38e740933e3…` |
| F24 | fuses：允许 `--inspect` 与 `NODE_OPTIONS`，asar 完整性校验开启 | 观察 | 自写脚本读 Electron Framework 的 fuse 区（非 REA） |
| F25 | 本机 3120 条记录的 `audio_context` 全是 RSA 信封；`debug_info` 是服务端密钥加密，包内常量解不开 | 观察 | 本机数据；openssl 试解失败 |
| F26 | 音频参数：Opus/Ogg、16 kHz、单声道、32 kbps VBR、3 秒一块。实测 `start_audio` 里的 `audio_metadata` 与之相同 | 观察；实测 | 本机数据（最新记录 `audio_metadata`）；readable:qA149QP2.mjs:6426-6436 |
| F27 | 模式映射：`voice_transcript`→`transcript`、`voice_command`→`ask_anything`、`voice_translation`→`translation` | 观察 | readable:main/index.js:6879-6881、17211-17215 |
| F28 | 经本机 mitmproxy 反向代理转发的免登录请求能得到服务端正常回包 | 观察 | 2026-10-12 自测：`GET /app/get_blacklist_domain` → 405 |
| F29 | 原生层每次按键变化都上报"当前按住的全部键"，主进程广播给四个窗口 | 观察 | readable:main/index.js:11833-11880、12754-12764 |
| F30 | 悬浮条统计最近 60 秒在可编辑输入框里的击键，超过 60 个触发提示；仅在内存 | 观察 | readable:qA149QP2.mjs:7886-7960 |
| F31 | 状态机时间参数：长按 600 ms、单次录音上限 9 分钟、分块 3 秒、WebSocket 空闲 1 小时断开等。实测分块间隔 2.998–3.005 秒 | 观察；分块间隔为实测 | readable:qA149QP2.mjs:4191、4546、6101-6104、6181-6200 |
| F32 | 认不出输入框时上报应用名、bundle id、网页网址和域名（每个应用加网址一次）。实测 Chrome 和微信各报了一次，字段是 `appName`、`appBundleId`、`webDomain` 加版本和语言 | 观察；实测 | readable:main/index.js `error_monitoring_undetectable_textbox_found` 处；`ev_17870b08e45f…`（第 15 条）与抓包 `context/001.json`、`007.json` |
| F34 | 麦克风约束关闭回声消除、降噪、自动增益；AudioContext 16 kHz；worklet 每次 1024 采样 | 观察 | readable:UfR9-a2Z.js:11848、14360-14379；`renderer/static/js/C7lI2ZxR.js` |
| F35 | 分块编码会话：码率 32000、复杂度 9 | 观察 | readable:main/worker/chunkSessionWorker.js:12-14、113、133 |
| F36 | "无声"检测阈值为 8 位波形偏离 1，检测的是麦克风无信号而非语音活动 | 观察 | readable:qA149QP2.mjs:4367-4440 |
| F33 | 按下功能键即开始录音；松开后进入免提录音，再按一次结束；`long_pressing` 状态会停止录音并提示不要按住 | 观察（状态定义） | readable:qA149QP2.mjs:6812-7160 |
| F37 | 2.8.1 不支持"按住说话"：按下 600 ms 未松即发 `LONG_HOLD` 并取消录音；`pushToTalk` 子状态没有入边 | 观察（代码）；运行时未验证 | readable:qA149QP2.mjs:6972-7039、7390-7525；6 处进入 `recording_active` 的转移均带子状态 |
| F38 | 登录是系统浏览器加 PKCE 加 `typeless://auth/google/success` 回调，换令牌接口 `/oauth/exchange_app_login_code` | 观察 | readable:main/index.js:10001-10096、14027-14118 |
| F39 | `user-data.json` 的加密密钥由操作系统、架构、应用名和固定盐派生；主进程里没有 `safeStorage` | 观察；否定结论的范围是 `main/index.js` 字面量搜索 | readable:main/index.js:9890-9896 |
| F40 | 云同步只推文字字段，不含录音和上下文；每批 200 条、失败重试上限 3、拉取每页 500 最多 5 页 | 观察（代码）；本机未开启，无运行时观察 | readable:main/index.js:8587-8610、8926-8946、9092-9105 |
| F41 | 同步冲突云端优先：`server_version_mismatch` 的记录直接标为已同步 | 观察 | readable:main/index.js:8975-8986 |
| F42 | "问任何事"的投递方式由服务端的 `delivery` 决定：`replace` 插入、`reply` 卡片、`external` 打开外链 | 观察 | readable:qA149QP2.mjs:5238-5258 |
| F43 | 打开外链只放行 `http:`、`https:`、`mailto:` | 观察 | readable:main/index.js:19048-19066 |
| F44 | 黑名单在悬浮条里叫 `isBestEffortInsertion`，白名单叫 `isGuaranteedWritable`；输入框不可编辑且不在两份名单里才给兜底提示 | 观察（名字与分支）；含义为推断 | readable:qA149QP2.mjs:5290-5311、5373-5404 |
| F45 | HTTP 兜底延时 = 6000 + ceil(时长/30)×500 + ceil(选中文字长度/1000)×500 毫秒，弱网降级时为 0。实测 4 次（2.5–12.8 秒）都是 6500，时长单位是秒；第二档和选中文字项没有样本 | 观察；第一档为实测 | readable:qA149QP2.mjs:5422-5429；UfR9-a2Z.js:11221-11244 |
| F46 | 更新源是 `https://typeless-static.com/desktop-release/`（electron-updater generic），不自动下载、不允许降级 | 观察 | 包内 `Resources/app-update.yml`；readable:main/index.js:19967-19969 |
| F47 | `desktopCapturer` 全包只有一处调用，用来触发屏幕录制授权框；JS 里没有 `getDisplayMedia`，也没有摄像头和蓝牙的使用处 | 观察；否定结论的范围是可读树全部 JS 的字面量搜索，原生库未查 | readable:main/index.js:19282-19302 |
| F48 | 主界面对 `global-keyboard` 的订阅是排障向导的快捷键检测，保留最近 30 条，打包前删除 | 观察；打包后的去向未读 | readable:DNMdpbnK.mjs:53654-53686、7538-7590 |
| F49 | 企业策略：`retention_policy.transcription` 限本地历史保留上限，`cloud_sync_policy.allow_member_cloud_sync` 管云同步许可 | 观察；不许可分支未读完 | readable:main/index.js:18373-18425 |
| F50 | 语音通道在启动时预连；空闲 60 秒被服务端一侧断开（1006，无关闭帧）；客户端不立即重连，下次按键时重连 | 实测（一次）；直连时是否相同未验证 | 抓包 `flows.mitm`：握手 00:51:17.071，关闭 00:52:17.054，`closed_by_client = false`；下一次握手在 00:55:48 |
| F51 | 听写的消息顺序固定：`start_audio`、`set_mode_config`、`replace_audio_context`、（`set_audio_chunk_info` 加二进制帧）×N、`end_audio`；服务端回 `audio_session_started`、每块一条 `received_audio_chunk_count`、`audio_session_ending`、`audio_processing_completed`、`debug_info` | 实测（4/4） | 抓包 `ws.jsonl`，59 条消息 |
| F52 | 没有应用层保活：枚举里有 `ping`、`pong`，没有发送方；108 秒的连接里没有 `ping` | 观察（可读树全量字面量搜索）；实测 | readable:UfR9-a2Z.js:10758、10771；抓包 `ws.jsonl` |
| F53 | 听写时服务端不回 `transcription`，只回成品 | 实测（4/4）；其他模式未验证 | 抓包 `ws.jsonl` |
| F54 | 服务端消息外壳为 `{K, V, T, M, S}`；成品的 `V` 有 `status`、`run_index`、`action` 三个代码里没读到的字段 | 实测 | 抓包 `ws.jsonl` |
| F55 | 每个音频块是独立的 Ogg 流（9/9 以 `OggS` 加流起始标记开头）；3 秒整块 13.8–15.0 KB | 实测 | 抓包 `ws.jsonl` 的帧头与 `set_audio_chunk_info` |
| F56 | `end_audio` 到成品 1447–1925 ms；按下到 `start_audio` 发出 103–184 ms，需重连的那次 1158 ms | 实测（4 次）；含本机代理和抓包代理两跳 | 抓包 `ws.jsonl` 时间戳与 `end_audio` 里的时间字段 |
| F57 | 4 次都由 WebSocket 给出结果，没有发出 `/ai/voice_flow` | 实测 | 抓包 `http.jsonl`（16 个往返里没有该路径） |
| F58 | 经 mitmproxy 转发的 16 个 HTTP 请求和 2 次握手没有 418 或其他非 200 状态 | 实测 | 抓包 `http.jsonl` |
| F59 | `X-Authorization` 和握手参数 `t` 都以 `U2FsdGVkX1` 开头；主进程的签名头 344 字符，渲染层的 576 或 600；`Authorization` 是 HS256 的 JWT | 实测（只核对格式和长度，未记录值） | 抓包 `flows.mitm`；`ev_eff73fa79df7…`、`ev_17870b08e45f…` 里的请求头 |
| F60 | 上下文明文的量：iTerm2 光标前 5000（截断）、可见文字 10003（截断）、周围 985，明文 55.7 KB；飞书可见 3741、周围 585；Chrome 和微信取不到焦点，几乎为空 | 实测 | 抓包 `context/003.json`、`006.json`、`010.json`、`013.json` |
| F61 | `device_environment` 的字段；`context_metadata.context_quality` 逐项记录成败、耗时、截断和错误码 | 实测 | 抓包 `context/*.json` |
| F62 | `/app/metrics_mp` 的请求体是 `{info: RSA 信封}`；`/app/get_blacklist_domain` 是 `POST`，回包 `data` 是 728 字符的加密字符串 | 实测 | `ev_17870b08e45f…`（第 15 条）；抓包 `http.jsonl` |
| F63 | 抓到的 4 个 `audio_id` 即 `history_v2` 最新 4 行；成品文字 4/4 相同；库里的上下文是第二份的信封，`debug_info` 是该消息的整个内容对象，`client_metadata` 是 `end_audio` 里那份 | 实测加本机数据 | 抓包 `ws.jsonl` 对 `typeless.db` 只读查询 |
| F64 | `usage_stats` 回包带 `week_word_usage_limit`（本机账号为 200000）和 `week_word_usage_value` | 实测 | `ev_17870b08e45f…`（第 6 条） |

## 工具与限制

- **REA 6.4.0** 是主干。MCP 会话没有配置 Ghidra 路径，原生库分析走的是 REA 命令行（`GHIDRA_INSTALL_DIR` 指向 `.tools/ghidra_12.1.4_PUBLIC`）。
- REA 的 Ghidra 引擎不接受多架构合一的 Mach-O，需先 `lipo -thin`。
- REA 的端点识别把 electron-store 的 `.get("键")` 误归为 network 端点。
- REA 的 `recover_javascript_sources` 仅支持 Linux x64，去混淆用了 **webcrack 2.16.0**。
- Ghidra 官方包不带 macOS 原生反编译器，用它自带的 `support/gradle/gradlew buildNatives` 在本机编了一份（安装包 sha256 已与官方发布值核对一致）。
- 没有用 REA 完成的两处：fuse 读取、本机数据库查询。
- 抓包交给 REA 的是 HAR：`inspect_web_network_capture` 读 mitmproxy 原生格式需要 Linux，本机是 macOS，所以先用 mitmdump 转 HAR 再隐去凭据（`tools/capture.sh har`）。经 REA 读的是 5 条 HTTP 记录；WebSocket 那条记录有 55 万字节，消息内容是从代理插件写的 `ws.jsonl` 读的，没有经过 REA。
- 静态结论与抓包的对照是人工逐条做的。REA 的 `correlate_static_and_runtime` 不适用：从它的输入定义看，它对照的是两个版本之间的静态差异和运行时差异，需要两份"比较"记录，这里只有一个版本。
- F37–F49 是在 REA 给出的应用图（`ev_675220c1fc7d…`）基础上直接读可读树得到的，引用的是 `文件:行号`。试过用 `trace_application_feature` 以 `exchange_app_login_code` 为种子追登录链路，没有命中（`ev_543fc8f37f12…`，覆盖状态 no-match）：这个端点是以对象属性的形式定义再拼接的，不在图的字面量节点里。
