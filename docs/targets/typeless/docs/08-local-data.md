# 08 本机数据

位置：`~/Library/Application Support/Typeless/`。以下来自对你本机数据的只读查看（2026-10-12）。凭据类的值没有读取，只看了键名和长度。

## 概览

| 文件 | 大小 | 内容 |
| --- | --- | --- |
| `typeless.db` | 262 MB | SQLite，历史记录 |
| `Recordings/` | 253 MB，3120 个 `.ogg` | 每条听写的音频，文件名是 `<audio_id>.ogg` |
| `app-settings.json` | 3 KB | 设置 |
| `app-storage.json` | 5 KB | 用户资料、订阅、额度、设备 ID、时间差、黑名单缓存 |
| `user-data.json` | 849 字节 | 二进制，不是明文 JSON；推断是加密保存的登录令牌（认证类里有 `generateEncryptionKey`、`saveUserData`） |
| `app-onboarding.json` | 2 KB | 引导进度 |
| `transcription-history-sync-state.json`、`-task.json` | <1 KB | 云同步状态，按用户 ID 分 |
| `Logs/` | 空 | |
| `sentry/` | | 崩溃上报队列 |
| 其余 | | Chromium 的缓存、Cookie、偏好等 |

## 数据库

`better-sqlite3` + `drizzle-orm`。迁移脚本是明文 SQL，在包内 `Resources/drizzle/`，共 14 个（`0000_far_falcon.sql` … `0013_ask_anything_external_push_candidate.sql`），本机 `__drizzle_migrations` 表里也是 14 条。

三张表：`history`（旧表，本机 0 行）、`history_v2`（3120 行）、`__drizzle_migrations`。

### `history_v2` 字段（readable:main/index.js:6947 起）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | text，主键 | 即 `audio_id` |
| `user_id` | text | |
| `status` | text | `completed` / `dismissed` / `error` |
| `mode` | text | `voice_transcript` / `voice_command` / `voice_translation` |
| `refined_text` | text | 成品文字，明文 |
| `duration` | real | 录音时长（秒） |
| `created_at`、`updated_at` | text | ISO 时间 |
| `server_updated_at` | integer | 云同步用 |
| `sync_status` | text | 默认 `pending_upload` |
| `sync_attempt_count` | integer | |
| `synced_from_cloud` | boolean | |
| `audio_local_path` | text | 录音文件路径 |
| `audio_metadata` | text | 音频参数 JSON |
| `app_version` | text | 如 `mac_2.8.1` |
| `mic_device`、`mic_device_info` | text、JSON | 麦克风 |
| `client_metadata` | JSON | 客户端侧的时间参数。实测就是 `end_audio` 消息里的那份 |
| `mode_meta` | JSON | 模式参数和结果（`ai_result`） |
| `debug_info` | text | 服务端回传的调试信息，加密。实测是 `debug_info` 消息的整个内容对象 |
| `audio_context` | text | 上下文，RSA 信封加密。实测是第二份（`replace_audio_context` 那份） |

旧表 `history` 多出 `audio`（BLOB，音频直接存库）、`edited_text` 系列、`ax_text`、`ax_html`、`focused_app_*` 等列。代码里有一个把旧表搬到新表的迁移任务（类 `wg`，`db:history-v2-migration-start`），会把旧的 AES 加密上下文重新包成 RSA 信封。

### 本机统计

| 模式 | 状态 | 条数 | 平均时长 | 合计 |
| --- | --- | --- | --- | --- |
| 听写 | completed | 2854 | 31.3 秒 | 24.8 小时 |
| 听写 | dismissed | 248 | 7.4 秒 | 0.5 小时 |
| 听写 | error | 5 | 12.3 秒 | |
| 听写 | （空） | 3 | 18.0 秒 | |
| 翻译 | dismissed / completed | 6 / 1 | | |
| 问任何事 | completed | 3 | 4.5 秒 | |

时间跨度 2026-06-02 至 2026-10-13，经历版本 1.5.1 到 2.8.1。

全部 3120 条的 `sync_status` 都是 `pending_upload`，即历史云同步在这台机器上没有开启过（或从未成功）。

### 三个加密/不透明字段

**`audio_context`**：3120 条全部是 RSA 信封（`{"_encrypted":true,"_v":1,"_type":"json","_key":…,"_data":…}`），平均 21.8 KB。包括 1.5.1 时期的老记录，说明旧格式已被迁移重新加密。公钥对应的私钥只在服务端，**本机读不出明文**。客户端等于把一份只有服务端能读的副本存在了本地，用途推断是重试和云同步时原样带上。

例外：2026-10-13 抓包期间产生的 4 条，上下文是用抓包代理的临时公钥加密的（[09](09-runtime-capture.md#上下文是密文的问题)），服务端也解不开。

**`debug_info`**：2862 条有值，平均 64 KB。外层是 `{audio_id, app_version, debug_info}`，内层 `debug_info` 是一个 `U2FsdGVkX1…` 开头的口令式 AES 密文。用包里写死的两个常量都解不开，客户端代码里也没有解密它的逻辑，只在提交反馈和诊断报告时原样传回服务端。内容未知，没有进一步尝试。

**`user-data.json`**：见上。

### 明文可读的元数据（本机最新一条）

```json
// client_metadata
{"need_weak_network_downgrade":false,"taking_longer_alert_delay_ms":7000,"full_audio_compression_time_ms":601.5}

// audio_metadata
{"audio_duration":3,"audio_format":"ogg","audio_bitrate":32000,"audio_channels":1,"audio_sample_rate":16000,
 "audio_codec":"opus","audio_variable_bitrate":true,"audio_bit_depth":16,"need_merge":true}

// mode_meta 的结构
{"ai_result":{"user_prompt":null,"refined_text":"…","web_metadata":null,"external_action":null,"delivery":null}}
```

## 设置（`app-settings.json`）

本机当前值里与行为有关的几项：

| 键 | 值 | 含义 |
| --- | --- | --- |
| `featureShortcutBindings.dictationMode` | `Fn`、`RightCmd` | 听写 |
| `featureShortcutBindings.askAnythingMode` | `Fn+Space` | 问任何事 |
| `featureShortcutBindings.translationMode` | `Fn+LeftShift` | 翻译 |
| `featureShortcutBindings.pasteLastTranscript` | `Ctrl+Cmd+V` | 再贴一次上一条 |
| `historyDurationSeconds` | `-1` | 历史永久保留 |
| `enabledOpusCompression` | `true` | 用 Opus；关掉则传 WAV |
| `enabledMuteBackgroundAudio` | `true` | 录音时静音系统输出 |
| `dynamicMicrophoneDegradationEnabled` | `true` | 麦克风动态降级（未读实现） |
| `selectedLanguages` | `zh-CN`、`en-US` | 识别语言 |
| `__DEV_API_HOST` | 空字符串 | 开发主机开关，默认就有这个键 |

其余键：窗口尺寸、麦克风列表、界面语言、开机自启、外观、几个一次性迁移标记。

## `app-storage.json` 的结构

```
userData            用户 ID、邮箱、角色、订阅方案与状态、订阅平台、起止时间
quotaUsage          每日请求数、每周字数等额度计数
accessibilityConfig 黑白名单缓存（带同步时间）
TYPELESS_DEVICE_ID  设备 ID
TYPELESS_TIME_DIFF  与服务器的时间差
…
```

## 能用这些数据做什么

- **导出自己的听写历史**：`refined_text`、时间、时长、模式都是明文，一条 SQL 就能导出。
- **拿到自己的全部原始录音**：`Recordings/*.ogg` 是标准 Opus，任何播放器能放。25 小时的"原始语音 + 成品文字"配对，是自建识别和清洗流程时现成的对照集。
- **做不了的**：还原当时发给服务端的上下文，以及服务端的调试信息。
