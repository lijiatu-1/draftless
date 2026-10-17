# 91 未决问题

分四类：等抓包就能回答的、需要再读代码的、客户端里原则上看不到的、已经回答的。

## 等下一次抓包回答

2026-10-13 抓过一次，只有 4 次普通听写（[09](09-runtime-capture.md#结果)）。下面是那次没覆盖到或只覆盖了一半的。

| # | 问题 | 现在的依据 |
| --- | --- | --- |
| Q02 | 黑名单应用（微信）里，光标前后文字和整框内容是否真的照发 | 代码里黑名单条件不覆盖 `getCurrentInputState`。抓包看到微信那次去采了光标文字、没去采可见文字和周围内容，但焦点输入框没取到，采集失败，没看到文字真的发出去 |
| Q07 | WebSocket 与 HTTP 赛跑，实际谁赢的比例 | 抓到的 4 次都是 WebSocket，1.4–1.9 秒就回了，HTTP 兜底没有启动。样本太少，也没有弱网的情况 |
| Q08 | `/user/traits` 实际上报的内容和触发频率 | 代码。抓包时 4 次听写后都没有手动改字，没有触发 |
| Q28 | 翻译和"问任何事"的消息：`set_mode_config` 的参数、`set_selected_text`、`delivery` 的实际取值、`web_metadata` 和 `external_action` 的内容 | 代码 |
| Q29 | 按住、短按（不到半秒）、Esc 取消时客户端发不发消息，已上传的音频怎么处理 | 代码（[10](10-interaction-state-machine.md)） |
| Q30 | 30 秒以上的录音：延时公式的第二档；HTTP 兜底和弱网降级的实际请求 | 代码；抓到的最长一次是 12.8 秒 |
| Q31 | Chrome 和微信为什么取不到焦点（`no_focused_application`、`no_focused_element`） | 抓包各看到一次。可能是应用本身的辅助功能树难读，也可能与 Typeless 刚重启有关，没有区分 |
| Q32 | 语音通道用过之后空闲多久会被断 | 启动后没用过的那次是 60 秒被服务端断开；用过之后最长只观察到 29 秒的间隔 |

## 需要再读代码

| # | 问题 |
| --- | --- |
| Q12 | 云同步里没读的部分：`load_older` 回填、`applyPulledTombstonesToLocal`、`acknowledge_hints`、谁调用 `invalidateSession`（主干已在 [13](13-history-cloud-sync.md)） |
| Q13 | 状态机里 `stopping`、`finishing`、`retrying` 的内部细节（主干状态图已在 [10](10-interaction-state-machine.md)） |
| Q14 | 结果卡片窗口内部怎么渲染、有哪些后续操作（投递分流已在 [14](14-result-delivery.md)） |
| Q15 | 录音器里分块边界怎么切、"麦克风动态降级"的实现（采样与编码参数、无声检测已在 [11](11-audio-recorder.md)） |
| Q16 | 原生层 `ShortcutDetector` 的规则（JS 侧的快捷键会话已在 [10](10-interaction-state-machine.md)） |
| Q17 | 统计事件的完整清单和各自属性（字面量搜到 13 个，是下限） |
| Q18 | 渲染层多久查一次更新；企业策略里"不允许成员云同步"那条分支做了什么；`enterprise-policy:updated` 的触发时机（主干已在 [15](15-update-policy-permissions.md)） |
| Q19 | 排障向导的数据打包后发往哪个接口 |
| Q20 | 剪贴板恢复的延时；`bottomUpURLTraversalWhitelist` 的内容 |
| Q21 | 原生库里有没有用到摄像头、蓝牙、屏幕录制（JS 侧已查，见 [15](15-update-policy-permissions.md#权限)） |
| Q27 | 登录相关的四个旧接口（`signin_with_google` 等）还有没有调用方；服务端时间偏移量何时校准；切换账号时清理了什么 |
| Q22 | `libopuschunk_session_create` 第四个参数的含义（前三个是采样率、声道数、码率）；`opus_convert_advanced` 的参数 |
| Q33 | 服务端消息外壳里 `T`、`M`、`S` 的含义和其他取值；成品里 `action`、`run_index` 的用途；`audio_session_ending` 的 `total_chunks` 数的是什么（抓包里只见到 `"json"`、`false`、`"done"`、`null`、1、1） |
| Q34 | 上下文里 `capture_frequency` 三个计数的含义；光标前文字 5000 字符的上限在代码哪里 |
| Q35 | `usage_stats` 回包里的 `week_word_usage_limit`（本机账号是 200000）到了上限会怎样 |
| Q36 | 上传的音频块为什么比标称码率大（37–40 kbps 对 32 kbps），本机录音文件为什么只有上传各块之和的 82%–86% |

## 客户端里看不到

| # | 问题 |
| --- | --- |
| Q23 | 服务端用什么模型做识别和清洗，提示词是什么 |
| Q24 | 上下文在服务端怎么用、存多久 |
| Q25 | `debug_info` 的内容（服务端密钥加密） |
| Q26 | 个人词典和"修改跟踪"在服务端怎么影响下一次结果 |

Q23 原本打算从外部行为侧面推：对比逐块的原始识别文字和成品。抓包发现听写时服务端不回原始识别文字，只回成品，所以这条路走不通。剩下的办法是自己控制输入：说同一段话的不同版本（带口头禅、带改口、换个应用），看成品怎么变。

## 已回答

| # | 问题 | 结论 | 出处 |
| --- | --- | --- | --- |
| Q01 | `start_audio` 的完整字段，初始上下文怎么发 | 第一份上下文就在 `start_audio` 里；完整字段见协议篇。抓包 | [05](05-network-protocol.md#客户端--服务端) |
| Q03 | `visible_screen_content` 实际有多长 | 纯文本。iTerm2 那次 10003 字符（截到 10000 加省略号），飞书 3741 字符；取不到焦点时没有这个键。抓包 | [06](06-context-capture-and-privacy.md#实测到的量) |
| Q04 | `device_environment` 有哪些字段 | 系统、版本、架构、CPU 核数、内存、语言、地区、厂商、机型、开机时长。抓包 | [06](06-context-capture-and-privacy.md#上下文的完整结构) |
| Q05 | WebSocket 何时建立、有没有保活 | 启动时预连；没有保活；空闲 60 秒被服务端断开，按键时重连。抓包加代码 | [05](05-network-protocol.md#连接) |
| Q06 | `end_audio` 到成品的耗时；逐块识别消息 | 1.4–1.9 秒（4 次）；听写时没有逐块识别消息。抓包 | [09](09-runtime-capture.md#耗时) |
| Q09 | 经代理转发会不会被 418 | 不会。16 个 HTTP 请求和 2 次 WebSocket 握手都正常。抓包 | [09](09-runtime-capture.md#开关和代理可用) |
| Q10 | `taking_longer_alert_delay_ms` 为什么本机是 7000 | 是公式算的：6000 加上按录音时长和选中文字长度的增量。抓包核对了第一档（不到 30 秒是 6500），时长单位是秒 | [14](14-result-delivery.md#成品里的时间参数) |
| Q11 | 登录流程与令牌存储 | 系统浏览器加 PKCE 加自定义协议回调；令牌文件的加密密钥由公开常量派生，没有用钥匙串 | [12](12-account-and-login.md) |
| Q12（主干） | 云同步的推拉协议、冲突、墓碑 | 只同步文字；云端优先；删除用墓碑 | [13](13-history-cloud-sync.md) |
| Q14（主干） | `delivery` 等字段怎么用 | 服务端决定投递方式：插入、结果卡片、打开外链 | [14](14-result-delivery.md) |
| Q16（JS 侧） | "按住说话"是否支持 | 2.8.1 不支持，按住超过 600 ms 会取消并提示。静态结论，抓包场景 12 复核 | [10](10-interaction-state-machine.md) |
| Q18（主干） | 更新流程、企业策略 | electron-updater 加静态文件源；企业策略管历史保留上限和云同步许可 | [15](15-update-policy-permissions.md) |
| Q19 | 主界面里对按键通道的订阅 | 排障向导的快捷键检测，记录打包前会删掉 | [10](10-interaction-state-machine.md#按键事件怎么走) |
| Q20（部分） | 白名单的作用 | "保证可写"的应用，插入后不做不可编辑兜底 | [14](14-result-delivery.md#落进输入框之后) |
| Q21（JS 侧） | 屏幕录制、摄像头、蓝牙的用途 | 屏幕录制只有申请权限的预留逻辑；摄像头和蓝牙是打包模板的默认声明，没有使用处 | [15](15-update-policy-permissions.md#权限) |
