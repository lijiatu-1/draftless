# 06 上下文采集与隐私

这一篇回答：除了声音，它还读了什么、什么时候读、读了发到哪。

结论来自主进程的上下文采集类（readable:main/index.js:11340-11790）、悬浮条的调用点（qA149QP2.mjs:5750-5900）和修改跟踪类（main/index.js:17222-17480）。本机数据库里的上下文是服务端公钥加密的，读不出来；明文样本来自 2026-10-13 的抓包（[09](09-runtime-capture.md#上下文的明文)），共 4 次听写、8 份上下文。字段结构与代码里读到的一致，[实测到的量](#实测到的量)一节是那次看到的长度和成败。

## 上下文的完整结构

`collectFullContext` 返回的对象，也就是发给服务端的 `audio_context`：

```
audio_context
├── device_environment            系统信息
│   ├── operating_system / os_version / architecture
│   ├── hardware                  cpu_cores、memory_bytes
│   ├── locale / region
│   ├── device_manufacturer / device_model
│   └── system_uptime_seconds     开机至今的秒数
├── active_application
│   ├── app_name                  应用名
│   ├── app_identifier            bundle id
│   ├── window_title              窗口标题
│   ├── window_position           窗口位置和大小
│   ├── app_type                  web_browser | native_app
│   ├── app_metadata              进程号、应用路径、窗口号
│   ├── visible_screen_content    窗口内可见文字 ★（只在第二份里，没采到时没有这个键）
│   └── browser_context           网页标题、网址、域名（只有浏览器才有这个键）
├── text_insertion_point
│   ├── input_area_type           输入区类型
│   ├── accessibility_role        辅助功能角色（如 AXTextArea）
│   ├── position_on_screen        输入框位置
│   ├── input_capabilities        是否可编辑、是否支持 Markdown、DOM id、DOM class 列表
│   ├── cursor_state
│   │   ├── cursor_position
│   │   ├── has_text_selected / selected_text    选中的文字
│   │   ├── text_before_cursor                   光标前的文字
│   │   ├── text_after_cursor                    光标后的文字
│   │   └── full_field_content                   前 + 选中 + 后
│   └── surrounding_context       输入框之前/之后的内容 ★
└── context_metadata
    ├── context_capture_version   实测为 2
    ├── is_own_application        焦点是不是 Typeless 自己的窗口
    ├── capture_timestamp
    ├── capture_frequency         三个计数，含义没有查
    ├── total_capture_duration_ms 这次采集总耗时
    ├── is_text_capture_blocked_by_blacklist
    └── context_quality           每一步的成败，见下
```

`context_quality` 下面最多五项：`app_window`、`visible_text`、`input_element`、`cursor_input`、`surrounding_context`。每项有 `status`（`success` 或 `error`）、`duration_ms`、`is_timeout`，失败时带 `error_code`，采文字的几项还有 `content_length` 和 `is_truncated`。哪一步没有去做，就没有那一项。服务端由此知道每份上下文缺了什么、为什么缺。

`device_environment` 的字段是抓包补全的。它带着机型、CPU 核数、内存大小和开机时长，每次听写都发。

带 ★ 的两项受黑名单控制。

## 什么时候采

| 时机 | 采什么 | 去向 |
| --- | --- | --- |
| **常驻轮询**，每 1 秒 | 应用信息 + 输入框基本信息。默认不带光标文字、不带可见文字、不带周围内容 | 留在内存；用于修改跟踪和判断当前应用 |
| **开始录音** | 应用、输入框、光标状态（含前后文字和选中文字） | 作为会话初值，并随 `start_audio` 消息发给服务端（实测） |
| **录音过程中** | 上一项 + 可见文字（上限 10000）+ 周围内容（前后各 1000），各 500 ms 超时 | 加密后经 WebSocket `replace_audio_context` 发给服务端 |
| **插入文字之后** | 同上一项的完整采集一次，之后每秒读一次输入框全文，最长约 15 秒 | 结束时发 `/user/traits` |
| **"问任何事"模式且没选中文字** | 额外尝试模拟 ⌘C 取选区 | 作为 `selected_text` |

10000 和 1000 这两个数是传给原生库的参数，从函数签名 `getFocusedVisibleTextAsync(int32, int32, 回调)`、`getFocusedElementRelatedContentAsync(int32, int32, int32, 回调)` 和原生函数名里的 `targetChars`、`maxLength` 看，单位是字符数（推断）。

常驻轮询从应用就绪起就开着（`intervalTime = 1000`），与是否在听写无关。轮询的参数可由渲染层通过 `focused-context:set-last-focused-info-timer` 修改；目前看到的唯一修改者是修改跟踪。

## 黑名单

内置一份配置（版本 1.0.3，readable:main/index.js:3670-3704），启动后还会从 `/app/get_blacklist_domain` 拉新的：

| 类别 | macOS 上的内容 |
| --- | --- |
| 应用黑名单 | Sublime Text 4、微信、Excel、WPS、Zed |
| 应用白名单 | Cursor、Slack、Apple 邮件、Figma、ChatGPT Atlas、Conductor、WezTerm、Thunderbird、LINE |
| 网址黑名单（前缀） | `https://docs.google.com/document/d`、`https://docs.qq.com/doc/`、`https://docs.qq.com/sheet/` |
| 网址白名单（前缀） | `https://www.figma.com/design/` |

Windows 端的黑名单长得多（终端、Office、Zoom、WhatsApp、JetBrains 等 30 项）。

**黑名单挡的范围**。`collectFullContext` 先算 `isTextCaptureBlockedByBlacklist`，再把结果传给两个采集函数：

- `collectFocusedAppInfo`：被拦截时跳过 `getFocusedVisibleTextAsync`，即不采可见文字。
- `collectFocusedInputInfo`：被拦截时跳过 `getFocusedElementRelatedContentAsync`，即不采输入框周围内容。但 `getCurrentInputState`（光标前后文字、选中文字）的调用条件里**没有**黑名单这一项。

所以从代码看，在微信里听写时，聊天窗口里别人的消息（可见文字）不会被采，但你正在输入的那一框文字会。抓包看到了一半：微信那次 `is_text_capture_blocked_by_blacklist` 为 `true`，`context_quality` 里没有 `visible_text` 和 `surrounding_context`（没有去采），有 `cursor_input`（去采了）。但那次焦点输入框没取到，`cursor_input` 以 `no_focused_element` 失败，所以"输入框文字真的发出去了"没有直接看到。**两份名单的本意是"辅助功能靠不靠得住"，不是隐私分级。** 悬浮条在把文字落进输入框之后会再查一次这两份名单，那里用的名字说得很直白（readable:qA149QP2.mjs:5373-5404）：黑名单叫 `isBestEffortInsertion`（只能尽力插入），白名单叫 `isGuaranteedWritable`（保证可写）。意思是：黑名单里的应用，辅助功能给出的信息不可信；白名单里的应用，即使辅助功能说"这里不可编辑"，粘贴也一定能成。两份名单在这里的用途见 [14](14-result-delivery.md#落进输入框之后)。这也解释了名单的内容：微信、Excel、谷歌文档这类自绘界面的在黑名单，Cursor、Slack、邮件在白名单。主进程里黑名单另有 `isTextCaptureBlockedByBlacklist` 这个名字，所以"不读取可见文字"是它的第二个用途，没看到白名单在采集环节起作用。

查黑名单出错时按"已拦截"处理。

另有两处特判：自家窗口不采；Notion 网页版的 `AXWebArea` 角色下把光标前后文字清空。

## 实测到的量

2026-10-13 抓到的 4 次听写里，服务端最终拿到的那份上下文（第二份）：

| 应用 | 命中黑名单 | 光标前 / 后 / 整框 | 可见文字 | 周围内容（前 / 后） | 采集耗时 | 明文大小 |
| --- | --- | --- | --- | --- | --- | --- |
| Chrome | 否 | 0 / 0 / 0（焦点没取到） | 0（去采了，为空） | 没有采 | 98 ms | 2.0 KB |
| 微信 | 是 | 0 / 0 / 0（焦点没取到） | 没有采 | 没有采 | 47 ms | 1.8 KB |
| iTerm2 | 否 | 5000 / 199 / 5199 | 10003 | 0 / 985 | 109 ms | 55.7 KB |
| 飞书 | 否 | 失败 | 3741 | 541 / 44 | 246 ms | 6.7 KB |

长度的单位是字符。

- **上限与代码里的参数对得上。** 可见文字在 iTerm2 那次被截到 10000 字符（另加三个字符的省略号），`is_truncated` 为 `true`。光标前文字被截到 5000 字符，这个上限是抓包才看到的。
- **终端是发得最多的地方。** 终端的整个文字区在辅助功能里是一个 `AXTextArea`，所以"输入框全文"就是终端最近的输出，"可见文字"是屏幕上的内容，加上周围内容，一次听写合计一万六千多字符。iTerm2 不在 macOS 的黑名单里。终端里刚打印过的密钥、令牌、内部数据都会跟着听写上传。
- **聊天软件里别人的消息会被采。** 飞书那次，输入框的光标文字没取到（`unsupported_accessibility_operation`），但可见文字 3741 字符和输入框前面的 541 字符都取到了，这些是聊天窗口里的内容。
- **取不到焦点时几乎是空的。** Chrome 和微信两次的错误码是 `no_focused_application`、`no_focused_element`，窗口位置、网址、标题全为空，`is_editable` 为 `false`。这时客户端会另发一条统计事件 `error_monitoring_undetectable_textbox_found`，带应用名、包名和网页域名（[09](09-runtime-capture.md#统计上报)）。为什么取不到没有查清，这两次文字都正常贴进去了。
- **采集很快。** 8 份上下文的总耗时在 46–246 ms 之间，没有一项超时。

## 插入后的修改跟踪

类 `Bm`（readable:main/index.js:17222-17480）。流程：

1. 文字贴进去后，渲染层调 `track-edit-text:start-track`，传入成品文字和模式。
2. 主进程做一次完整上下文采集。只有当输入框可编辑、且框里确实能找到刚贴的文字时才开始跟踪。
3. 记下"贴入前"的状态：`text_before_cursor`（去掉贴入的部分）、`text_after_cursor`、`full_field_content`。
4. 把常驻轮询切到"带光标文字"模式，同时监听按键事件。
5. 以下任一情况结束跟踪并上报：
   - 焦点换了输入框（`switch_input_box`）
   - 输入框被清空（`clear_input_box`）
   - 改动较大且刚按过回车（`press_enter`，推断对应"发送了消息"）
   - 15 秒内没有新的编辑（`track_timeout`；每次检测到编辑会重新计时）
6. 上报 `POST /user/traits`，内容（信封加密）：

   ```
   refined_inserted_text     它给的文字
   original_input_box        贴入前：光标前文字、光标后文字、整框内容
   edited_input_box          结束时：整框内容
   active_application        应用信息
   device_environment        设备信息
   mode
   ```

7. 回包里如果有 `auto_add_dictionary`，主界面会弹"已自动加入词典"的提示。

这是它"越用越准"的机制：拿你的手动修正去对比它的输出，自动沉淀成个人词典。代价是那 15 秒里输入框的全部内容（包括你接着手打的东西）会离开本机。

改动较大但没按回车时不上报，只在本地写一条 `tracking_edit.log`，里面有当时的整框内容和最近的按键。本机 `Logs/` 目录是空的，这类日志是否默认落盘没有确认。

## 全局按键

键盘子进程用事件监听拿到全系统的按键按下、抬起和修饰键变化（见 [07](07-native-helpers.md)）。每次变化都会把"当前按住的全部键"传回主进程，再广播给四个窗口，普通字母键也在其中。

已确认的用途有三个：匹配快捷键；修改跟踪时判断"用户在编辑"和"用户按了回车"；悬浮条里统计你最近 60 秒在输入框里敲了多少键，超过 60 个就提示一次。细节见 [10](10-interaction-state-machine.md#按键事件怎么走)。

这三处都只在内存里用，没有看到写盘或上传。主界面的大包里还有一处订阅没有读，所以结论是"读过的地方没有"，不是"绝对没有"。

## 存在本机的

- 每条听写的音频：`Recordings/<id>.ogg`，按"历史保留时长"设置清理。
- 每条听写的上下文：`typeless.db` 里，RSA 信封密文，本机解不开。实测存的是第二份（完整的那份）。
- 成品文字：`typeless.db`，明文。

详见 [08](08-local-data.md)。

## 设备标识

`libUtilHelper` 生成一个 UUID 作为设备 ID，存在钥匙串里，另有一份本地缓存，两边互相修复（原生库字符串：`Keychain self-healing…`、`Both Keychain and cache are missing, generating new Device ID`）。这个 ID 进每个请求的签名头（`d` 字段）。钥匙串条目不随应用卸载删除，所以卸载重装后设备 ID 应该不变（推断，未验证）。
