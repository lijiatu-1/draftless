# 05 网络协议

协议来自静态阅读；普通听写这条路已经用抓包对过一遍（[09](09-runtime-capture.md#结果)，2026-10-13，4 次听写）。标"实测"的是那次抓包看到的，没标的仍是代码里读出来的。翻译、"问任何事"、HTTP 兜底、`/user/traits` 没有抓到。

## 主机

| 用途 | 地址 |
| --- | --- |
| API | `https://api.typeless.com`（写死，readable:main/index.js:52） |
| 实时语音 | `wss://api.typeless.com/ws/rt_voice_flow` |
| 官网 | `https://www.typeless.com` |
| 更新 | `https://typeless-static.com/desktop-release/` |
| 崩溃上报 | Sentry（`o4510514257526784.ingest.us.sentry.io`） |

统计事件不直连第三方，发到自家的 `/app/metrics_mp`（从名字推断由服务端转给 Mixpanel）。

实测：回包都来自 `nginx`，带两个自定义响应头，`x-p-t` 是一个数（4.4–181.9，推断是服务端处理耗时的毫秒数），`r-id` 是 26 个字符的请求编号。

## 请求签名

每个发往 API 的 HTTP 请求过两个中间件（readable:main/index.js:3195-3364）。

**安全中间件**加这些头：

| 头 | 值 |
| --- | --- |
| `X-App-Version` | `mac_2.8.1` |
| `X-Browser-Name` / `-Version` / `-Major` | 运行环境信息 |
| `X-Authorization` | 见下 |

`X-Authorization` 的明文是一个 JSON：

```
{
  "X-Env": "prod",
  "X-Client-Domain": <来源页面的域>,
  "X-Client-Path": <来源页面地址>,
  "X-Random": <6 位随机数>,
  "t": <校正后的毫秒时间戳>,
  "p": <签名>,
  "d": <设备 ID>,
  "<一个固定的 40 位十六进制键>": { "a": "" }
}
```

- `p` = HMAC-SHA1(消息 = `t:版本:路径:用户ID`，密钥 = `t:固定盐`)。
- 整个 JSON 用 CryptoJS 的口令式 AES 加密（OpenSSL 兼容格式，Base64 后以 `U2FsdGVkX1` 开头），口令是写死在包里的一个常量。

固定盐和口令是两个 56 位十六进制常量，在 readable:main/index.js:56-57。本文档不抄录它们的值。

**鉴权中间件**加 `Authorization: Bearer <access_token>`。`/oauth/refresh_access_token` 和 `/get_blacklist_domain` 不需要登录。

实测：

- 16 个 HTTP 请求的 `X-Authorization` 全部以 `U2FsdGVkX1` 开头，与上面说的格式一致。主进程发的是 344 个字符，渲染层发的是 576 或 600 个，差别来自明文里的来源页面地址长短。
- `Authorization` 里是三段式的 JWT，头部 `alg` 为 `HS256`，声明有 `exp`、`iat`、`jti`、`subject`、`type`。
- 登录状态下 `/app/get_blacklist_domain` 也带了 `Authorization`。
- 主进程的请求 `user-agent` 是 `node`，`X-Browser-*` 三个头都是 `unknown`，另带 Sentry 的 `sentry-trace` 和 `baggage`。渲染层的请求是 Chromium 的完整请求头，`x-browser-name` 为 `Chrome`。

**时间校正**：服务端回 418 且响应体里 `ja3_tls_code` 为 `101010101` 时，客户端取响应头 `Date` 算出与本地的时间差存起来，之后的 `t` 都加上这个差。WebSocket 的 `received_audio_chunk_count` 消息里的 `server_t` 也用来校时。字段名带 `ja3_tls`，推断服务端有基于 TLS 指纹的校验，具体规则未知。实测经 mitmproxy 转发的 16 个请求和 2 次 WebSocket 握手没有一个被回 418，所以这条校验即使存在，也没有拦换了 TLS 栈的连接。

**其他状态码**：401 有专门的中间件处理（主进程里那个回调是空的，渲染层的没读）；413 提示输入超出模型长度上限。

## 上下文加密信封

`audio_context` 等敏感字段发出前包一层（readable:main/index.js:3888-3909）：

```
{
  "_encrypted": true,
  "_v": 1,
  "_type": "json" | "str",
  "_key":  Base64( RSA-OAEP-SHA256( 随机 32 字节 AES 密钥 ) ),
  "_data": Base64( AES-256-GCM 密文 ‖ 16 字节认证标签 )      // IV 为 12 字节全零
}
```

- 公钥来自 `GET /user/get_user_info` 回包的 `data.rsa_public_key`（本机样本的 `_key` 是 344 个 Base64 字符，即 2048 位 RSA）。
- 取不到公钥时退回用写死口令的 AES，并上报一条 `error_monitoring_rsa_encryption_failed` 统计事件。
- 用到这层信封的地方：`audio_context`（WebSocket 和 HTTP）、`/user/traits` 的 `log`、`/app/metrics_mp` 的 `info`（最后一项是实测看到的）。
- 实测 `_key` 都是 344 个字符，`_type` 都是 `json`。`end_audio` 里的上下文是空对象 `{}`，加密后 `_data` 只有 24 个字符。

## WebSocket：`/ws/rt_voice_flow`

### 连接

```
wss://api.typeless.com/ws/rt_voice_flow?v=mac_2.8.1&t=<加密串>&m=0
```

`t` 是把 `{ token, s, t, d }` 用同一个写死口令 AES 加密后的串：`token` 是访问令牌，`s` 是对路径 `/ws/rt_voice_flow` 做的同款 HMAC-SHA1 签名，`t` 是时间戳，`d` 是设备 ID（readable:UfR9-a2Z.js:10783-10800）。

断网后上线会自动重连；发消息时发现没连上也会先连，消息进队列，连上后补发（readable:UfR9-a2Z.js:10939-11009）。状态机在空闲满 1 小时后主动断开（[10](10-interaction-state-machine.md#时间参数)）。

**没有保活。** 消息类型的枚举里有 `ping` 和 `pong`，但可读树里找不到发送 `ping` 的代码。实测也一样：

- 应用启动时就连上了，之后 60 秒没有任何消息，连接被服务端一侧断开（关闭码 1006，没有关闭帧）。客户端没有立即重连。
- 四分钟后第一次按键才重新握手，那次的 `start_audio` 在按下 1158 ms 后才发出；连接还在的另外三次是 103–184 ms。
- 第二条连接的 108 秒里只有听写本身的 59 条消息，没有 `ping`。

所以它是"用的时候才有"的连接，隔一会儿再用就要付一次建连的时间。用过之后空闲多久会断，这次没有观察到（见 [09](09-runtime-capture.md#语音通道不是常连的)）。

握手请求不带 `Authorization` 和 `X-Authorization`，`Origin` 是 `file://`。`t` 实测 576 个字符，以 `U2FsdGVkX1` 开头。`m` 在唯一的调用处写死为 0（readable:UfR9-a2Z.js:10875）。客户端提出 `permessage-deflate`，服务端没有接受，消息不压缩。

### 客户端 → 服务端

文本消息是 JSON，`type` 字段区分：

| type | 时机 | 主要字段 |
| --- | --- | --- |
| `start_audio` | 开始录音 | 实测完整字段：`audio_chunk_time`（3）、`audio_sample_rate`（16000）、`audio_metadata`、`device_id`（64 个字符）、`mode`（内部名，如 `voice_transcript`）、`device_name`、`audio_id`、`audio_context`（信封，第一份上下文）、`client_metadata` |
| `set_mode_config` | 紧跟 `start_audio`，默认模式也发（实测） | `audio_id`、`mode`（服务端名，如 `transcript`）、`parameters`（听写时为空对象） |
| `set_selected_text` | （未读） | |
| `replace_audio_context` | 完整上下文取到后 | `audio_id`、`audio_context`（信封） |
| `set_audio_chunk_info` | 每个音频块之前 | `audio_id`、`index`、`size`、`duration` |
| （二进制帧） | 紧跟上一条 | Opus 音频块 |
| `end_audio` | 结束录音 | 实测完整字段：`user_over_time`、`send_time`、`audio_time`（如 `"12.8s"`）、`total_duration`（秒）、`start_recording_time`、`stop_recording_time`、`diff`（如 `"12914ms"`）、`mode`、`record_pressed_to_audio_stream_connected_latency_ms`、`record_pressed_to_first_audio_sample_latency_ms`、`audio_id`、`audio_context`（信封，内容是空对象）、`client_metadata` |
| `ping` | 枚举里有，没有发送方 | |

`client_metadata` 是 `{need_weak_network_downgrade, taking_longer_alert_delay_ms}`。`start_audio` 里的延时是 6000，`end_audio` 里的按 [14](14-result-delivery.md#成品里的时间参数) 的公式重算（实测 4 次都是 6500）。

`audio_metadata` 实测是 `{audio_duration: 3, audio_format: "ogg", audio_bitrate: 32000, audio_channels: 1, audio_sample_rate: 16000, audio_codec: "opus", audio_variable_bitrate: true, audio_bit_depth: 16, need_merge: true}`。

二进制帧实测每一块都以 `OggS` 加流起始标记开头（9 块全是），也就是每块是一个独立的 Ogg 流。

### 服务端 → 客户端

JSON，类型在 `K`（或 `msg_type`），内容在 `V`（或 `data`）。实测的外壳是 `{K, V, T, M, S}`，`T` 都是 `"json"`，`M` 都是 `false`，`S` 都是 `"done"`；后三个字段的其他取值没见到，从名字推断与分段或流式的回包有关。

"实测"一列有内容的，是普通听写里真的出现过的：

| 类型 | 含义 | 内容（代码） | 实测 |
| --- | --- | --- | --- |
| `audio_session_started` | 会话开始 | | `{audio_id, start_time}`，`start_audio` 之后 256–323 ms |
| `session_started` | 同上，另一个名字 | | 没出现 |
| `received_audio_chunk_count` | 确认收到一块 | `server_t`（服务器时间，用来校时） | `{index, server_t, size}`，每块一条 |
| `audio_session_ending` | 音频收齐 | | `{audio_id, total_chunks, completed_chunks, failed_chunks, receive_data_time, process_receive_data_time, process_delay}`，`end_audio` 之后 279–398 ms |
| `transcription` | 某一块的识别文字 | `text`、`chunk_index` | 没出现 |
| `audio_processing_completed` | 成品 | `audio_id`、`refined_text`、`delivery`、`user_prompt`、`web_metadata`、`external_action` | `{audio_id, refined_text, status, run_index, web_metadata, delivery, action, user_prompt, external_action}`，`end_audio` 之后 1.4–1.9 秒 |
| `refine_completed` / `refine_selected_text` | 成品的另外两个名字 | 同上 | 没出现 |
| `process_mode` | 服务端判定的处理模式 | | 没出现 |
| `important_notification` | 提醒或付费墙 | `type`、`alertKey`、`behavior.interruptSession`、`behavior.duration` | 没出现 |
| `debug_info` | 调试信息 | 加密串，客户端不解，原样存库 | `{audio_id, debug_info, app_version}`，成品之后 27–331 ms；内层字符串 17–88 KB |
| `pong` | | | 没出现 |
| `error` / `transcription_error` / `refine_error` / `refine_selected_text_error` / `audio_processing_error` | 错误 | `code`、`detail` | 没出现 |

听写时成品里的 `web_metadata`、`delivery`、`action`、`user_prompt`、`external_action` 都是 `null`，`status` 是 `true`，`run_index` 是 1。`action` 和 `run_index` 是抓包才看到的字段，用途没有查。

**录音过程中服务端不回识别文字。** 枚举里有 `transcription`，客户端也有处理它的代码，但 4 次听写里一条都没有：服务端对每一块只回收到确认，成品在音频收齐后一次给出。之前据这个消息名推断"服务端逐块出识别结果"，这个推断撤回；服务端内部是不是边收边识别，客户端这一侧看不出来。

`audio_session_ending` 的 `total_chunks` 在上传了 5 块的那次也是 1，推断数的是服务端合并（`need_merge`）之后的处理单元。

## HTTP：语音兜底接口

`POST /ai/voice_flow`，`multipart/form-data`，超时 40 秒（readable:main/index.js:17817-17935）：

| 字段 | 内容 |
| --- | --- |
| `audio_id` | 本次录音的 UUID |
| `mode` | `transcript` / `ask_anything` / `translation` |
| `audio_file` | 整段音频，`audio/ogg` |
| `audio_context` | 信封加密的上下文（JSON 字符串） |
| `audio_metadata` | 音频参数 JSON，含 `audio_duration` |
| `parameters` | JSON：`selected_text` 或 `output_language` |
| `is_retry` | 是否用户手动重试 |
| `user_over_time`、`send_time`、`device_name` | 可选 |

回包 `data`：`refine_text`、`delivery`、`user_prompt`、`web_metadata`、`external_action`；顶层另有 `debug`。失败时可能带 `important_notification`、`detail`、`code`。

## HTTP：接口总表

主进程发起（REA 端点节点，机制为 `ye.get` / `ye.post`）：

| 接口 | 用途 |
| --- | --- |
| `POST /ai/voice_flow` | 语音兜底 |
| `POST /user/traits` | 上报插入后的修改 |
| `GET /user/get_user_info` | 用户信息、RSA 公钥 |
| `POST /app/get_blacklist_domain` | 黑白名单配置。实测是 `POST`（`GET` 会得到 405），回包的 `data` 是一个 728 字符的加密字符串，以 `U2FsdGVkX1` 开头 |
| `POST /app/metrics_mp` | 统计事件。实测请求体是 `{info: 信封}`，用的是 RSA 信封；写死口令的 AES 是取不到公钥时的退路 |
| `POST /sync/check` | 同步检查 |
| `POST /transcription_history/{push,pull,load_older,sync_status,sync_settings,acknowledge_hints,wipe}` | 历史云同步 |
| `POST /user/get_user_surveys`、`/user/submit_survey` | 引导问卷 |
| `/oauth/*` | 登录：`signin_with_google`、`auth_user_from_google`、`signin_with_email`、`verify_secret_code`、`exchange_app_login_code`、`refresh_access_token`、`logout` |

渲染层发起（在渲染层代码里找到的路径）：

| 接口 | 用途 |
| --- | --- |
| `/user/dictionary/{list,add,update,delete,batch-delete,bulk-import,bulk-import/preview}` | 个人词典 |
| `/user/get_dictation_settings`、`/user/set_dictation_settings`、`/user/update_settings` | 听写设置 |
| `/user/personal_stats`、`/user/usage_stats`、`/user/insights` | 使用统计 |
| `/user/feedback`、`/user/diagnostics_report` | 反馈与诊断（会带上服务端加密的调试信息） |
| `/user/get_invitation_codes`、`/user/submit_affiliate_code` | 邀请 |
| `/user/update_onboarding`、`/user/delete_account` | 引导、注销 |
| `/app/get_free_quota_notice_banner_config`、`/app/get_onboarding_copy_config` | 界面配置 |

各接口的请求体和回包结构，除语音主接口和 `/user/traits` 外都没有逐个读。

### 启动时实测到的回包

回包的统一外形是 `{status: "OK", msg, data}`。请求体除特别说明外都是空对象 `{}`。

| 接口 | `data` 的结构 |
| --- | --- |
| `GET /user/get_user_info` | 47 个键：账号（`user_id`、`email`、`created_at`、`signup_method`、`locale`）、订阅（`roles`、`subscription_*`、`payment_method`）、设置（`dictation_settings`、`translation_settings`、`personal_auto_style_on`、`personal_auto_dictionary_on`）、组织（`org_id`、`org_settings`、`group_*`）、云同步（`transcription_sync_enabled`、`retention_seconds`、`purge_before_at`）、各平台引导进度（`onboarding.ios/android/macos`）、推广（`referral`、`affiliate_*`、`invitation_code_used`），以及 `rsa_public_key`（451 个字符的 PEM） |
| `GET /user/get_dictation_settings` | `{dictation_settings: {output_language_map: {zh, en}, auto_punctuation, smart_formatting}}` |
| `POST /user/usage_stats` | `{voice_transcription: {total_words, total_audio_seconds, avg_wpm, mins_saved, week_word_usage_limit, week_word_usage_value}}` |
| `POST /user/personal_stats` | `{enabled, category_stats: [{display_name, category_id, icon, learning_ratio, usage_ratio}], total_learning_ratio}` |
| `POST /user/insights` | 请求 `{start_date, end_date}`（秒级时间戳）；回 `{summary: {active_days, longest_streak, current_streak}, heatmap: {days, has_more_before}}` |
| `POST /transcription_history/sync_status` | `{quota_overflow_warning, transcription_sync_enabled, transcription_sync_enabled_at, retention_seconds, purge_before_at, server_now, passive_disabled_by_tier, passive_disabled_by_org}` |
| `POST /app/get_free_quota_notice_banner_config` | `{banner_enabled, title, button}` |

`usage_stats` 里有 `week_word_usage_limit`，本机账号（年度会员）拿到的是 200000。也就是说服务端按周统计字数并带一个上限，付费账号也有这个字段；到了上限会怎样，客户端代码里没有查。

## REA 端点识别的一个误报

REA 的 `discover-static-endpoint` 把 electron-store 的 `.get("键名")` 也归成了 network 端点（76 条观察里约 50 条是这类）。上表只收了经 API 客户端发出的那些。
