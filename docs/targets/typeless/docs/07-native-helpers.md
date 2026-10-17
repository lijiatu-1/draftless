# 07 原生库

四个 Swift 动态库，JS 侧用 koffi 按 C 接口调用。它们是"语音输入工具"里与系统打交道的全部代码，也是自己仿写时最值得参考的部分。

分析手段：

- 接口签名：JS 侧的 koffi 声明（readable:main/index.js，行号见下）。
- 用到的系统 API：REA `inspect-macho` 的导入表。
- 字符串：REA `search`（Ghidra 引擎）。
- 伪代码：REA `function`（Ghidra 12.1.4）。Ghidra 不接受多架构合一的库，所以先用 `lipo -thin arm64` 切出单架构切片再分析；切片是派生产物，结论适用于原库的 arm64 部分。

| 库 | 原库 sha256（前 16 位） | inspect-macho 证据 |
| --- | --- | --- |
| libContextHelper | `521e38bbf92eca71` | `ev_b0061cae4075…` |
| libInputHelper | `4cd6ba0205e0e7a0` | `ev_16cad01399e2…` |
| libKeyboardHelper | `c5620b51b2cc5cfd` | `ev_d72a2a93e6e6…` |
| libUtilHelper | `3cb43b12ec683f40` | `ev_52a412e6963a…` |

都是 x86_64 + arm64 双架构，最低 macOS 11.0，每个约 400 KB。模块名形如 `InputHelper_arm64_temp`，是构建时的临时名。

## libContextHelper：读焦点上下文

### 接口（readable:main/index.js:10546-10560）

```c
void    getFocusedAppInfoAsync(int32_t timeoutMs, void (*cb)(const char *json));
void    getFocusedElementInfoAsync(int32_t timeoutMs, void (*cb)(const char *json));
void    getFocusedVisibleTextAsync(int32_t maxLength, int32_t timeoutMs, void (*cb)(const char *json));
void    getFocusedElementRelatedContentAsync(int32_t before, int32_t after, int32_t timeoutMs, void (*cb)(const char *json));
int32_t setFocusedWindowEnhancedUserInterface(void);
```

参数名是按 JS 调用处的实参推的。全部异步，结果以 JSON 字符串经回调返回。

### 系统 API

- 辅助功能：`AXUIElementCreateSystemWide`、`AXUIElementCreateApplication`、`AXUIElementCopyAttributeValue`、`…CopyMultipleAttributeValues`、`…CopyAttributeNames`、`AXUIElementSetAttributeValue`、`AXUIElementSetMessagingTimeout`、`AXIsProcessTrusted`
- 窗口：`CGWindowListCopyWindowInfo`（取窗口位置、窗口号、所属进程）
- 应用：`NSWorkspace`、`NSBundle`

### 机制（由导出函数名和字符串推断，未看伪代码）

- 取焦点：系统级元素的 `AXFocusedApplication` → `AXFocusedUIElement`。
- 读的属性：`AXValue`、`AXTitle`、`AXDescription`、`AXPlaceholderValue`、`AXNumberOfCharacters`、`AXSubrole`、`AXIdentifier`、`AXDOMClassList`、`AXPosition`、`AXSize`、`AXParent`、`AXHidden`、`AXEnabled`、`AXSelected` 等。
- **`AXEnhancedUserInterface`**：`setFocusedWindowEnhancedUserInterface` 给焦点应用设这个属性。Chromium 系应用（包括 Electron 应用）平时不建完整的辅助功能树，设了它才会建。每次完整采集前调一次，然后等 30 ms（readable:main/index.js:11680-11684）。
- 可见文字：`collectVisibleTexts(from:textElements:maxLength:currentLength:didTruncate:timeout:maxDepth:currentDepth:)` 递归遍历，`isElementVisible` 过滤，`smartJoinTexts` 拼接。
- 周围内容：`collectContentBefore` / `collectContentAfter(element:targetChars:collectedChars:content:timeout:)`，从输入框向前、向后收集到够数为止。
- 网页信息：`findWebArea(in:timeout:maxDepth:currentDepth:)` 向下找 `AXWebArea`；`findWebInfoByTraversingUp` 从焦点元素向上找网址和标题，只对 `bottomUpURLTraversalWhitelist` 里的应用用这条路（名单内容未取）。
- 每个采集函数都带 `CaptureTimeout`，到时间就返回已有的部分。

### 认得的浏览器（REA search，`ev_003da5890711…`）

Safari、Chrome、Chromium、Edge、Brave、Arc、Firefox、Firefox Nightly、Opera、Vivaldi、DuckDuckGo、Orion（Kagi）、ChatGPT Atlas、Perplexity Comet。

## libInputHelper：插入文字、读选区

### 接口（readable:main/index.js:10868-10876）

```c
int32_t     insertText(const char *text);
int32_t     insertRichText(const char *html, const char *text);
int32_t     deleteBackward(int32_t count);
const char *getSelectedText(int32_t timeoutMs);
const char *getCurrentInputState(int32_t timeoutMs);
void        getSelectedTextBySimulateCopyAsync(int32_t timeoutMs, void (*cb)(const char *json));
```

### 系统 API

- 模拟按键：`CGEventSourceCreate`、`CGEventCreateKeyboardEvent`、`CGEventSetFlags`、`CGEventPost`
- 剪贴板：`NSPasteboard`、`NSPasteboardItem`、`NSPasteboardTypeString`
- 键盘布局：`TISCopyCurrentKeyboardInputSource`、`TISGetInputSourceProperty`、`UCKeyTranslate`、`LMGetKbdType`
- 辅助功能：`AXUIElementCopyParameterizedAttributeValue`、`AXTextMarkerRangeCreate`、`AXTextMarkerRangeCopyStartMarker` / `…EndMarker`

### 插入文字的做法

`insertText`（`ev_7e744c7969bd…`）：检查参数，不在主线程就同步切到主线程，然后调 `performTextInsertion(with:)`。

`performTextInsertion(with:)`（`ev_de5df527a4d8…`）的伪代码整理后是：

```
savePasteboard()                                  // 存下当前剪贴板的全部条目
pb = NSPasteboard.general
pb.prepareForNewContents(options:)
item = NSPasteboardItem()
item.setString(text, forType: .string)
item.setData(Data(), forType: .transient)         // 标记为临时内容
pb.writeObjects([item])
simulatePasteCommand { … }                        // 完成回调里恢复剪贴板
return true
```

`simulatePasteCommand(completion:)`（`ev_f14d43e1507e…`）把实际的按键模拟排到主队列异步执行。按键本身（⌘V）由上面的 `CGEvent*` 一组接口发出；`findKeyCodeForCharacter` 配合键盘布局接口找出当前布局下 "V" 对应的键码，这样在非 QWERTY 布局下也能贴对。

要点：

- **只有粘贴这一条路**，没有"直接改输入框的值"的分支。所以它在任何能粘贴的地方都能用，代价是会短暂占用剪贴板。
- "临时内容"标记在库里是 `NSPasteboardType.transient` 这个扩展常量，对应剪贴板管理工具之间的约定（让它们不把这次写入记进历史）；具体的类型字符串没有取。
- 贴完到恢复剪贴板之间等多久，没有读到。

`insertRichText(html, text)` 同理，剪贴板里同时放 HTML 和纯文本两种格式（`performRichTextInsertion(html:text:)`）。

### 读输入框文字

`getCurrentInputState` 返回光标位置、前文、选中、后文。内部结构体 `TextReading { before, selected, after, outcome }`，相关函数 `locateElement`、`readSelectedText`、`populateReadingFields`、`makeReadingResult(…captureSucceeded:didTruncate:)`。

对网页内容用的是文本标记接口（字符串 `AXStringForTextMarkerRange attribute successfully retrieved`），这是 WebKit 和 Chromium 暴露光标位置的方式；原生输入框走普通的 `AXSelectedTextRange` 一类属性（推断）。

`getSelectedTextBySimulateCopyAsync`：辅助功能读不到选区时，存剪贴板 → 模拟 ⌘C → 读剪贴板 → 恢复。

## libKeyboardHelper：全局按键

### 接口（readable:main/index.js:11825-11832）

```c
typedef bool (*KeyboardCallback)(int32_t, char *, int32_t, int32_t, char *);

bool        startMonitor(KeyboardCallback cb);
void        stopMonitor(void);
void        processEvents(void);
void        updateTargetShortcuts(char *json);
void        resetPressingKeycodes(void);
void        setWatcherInterval(double seconds);
const char *getKeyboardDeviceList(void);
```

这个库在单独的子进程里加载。

### 系统 API

`CGEventTapCreate`、`CGEventTapEnable`、`CFMachPortCreateRunLoopSource`、`CFRunLoopAddSource`、`CFRunLoopRunInMode`、`CGEventGetFlags`、`CGEventGetIntegerValueField`；`IOHIDManagerCreate`、`IOHIDManagerCopyDevices`、`IOHIDDeviceGetProperty`；键盘布局同上。

### 监听方式

`KeyboardMonitor.startMonitor`（`ev_2570dafef3e3…`）里的关键调用：

```c
CGEventTapCreate(
    0,           // kCGHIDEventTap：最靠近硬件的一层
    0,           // kCGHeadInsertEventTap：插在最前
    0,           // kCGEventTapOptionDefault：主动式，可以改写或吞掉事件
    0x6001c00,   // 关心的事件
    callback, NULL);
```

掩码 `0x6001c00` 展开是第 10、11、12、25、26 位：按键按下、按键抬起、修饰键变化、其他鼠标键按下、其他鼠标键抬起。也就是键盘全部事件加鼠标侧键，鼠标侧键可以绑成快捷键。

选主动式而不是只听式，推断是为了能吞掉快捷键本身，不让它漏给前台应用；回调类型的返回值 `bool` 与此吻合。创建成功后挂到当前线程的 run loop，再调 `startWatcher`（一个定时器，间隔可由 `setWatcherInterval` 调）。库里导出了 `processEvents`，并导入了 `CFRunLoopRunInMode`，推断是由 JS 侧周期性调用来驱动 run loop（调用点没读）。

类：`KeyboardMonitor`、`ShortcutDetector`、`KeyboardUtils`、`KeyboardDeviceList`。快捷键匹配在原生层做（`ShortcutDetector`），目标快捷键由 JS 以 JSON 下发。`KeyboardDeviceList` 用 IOHID 枚举键盘设备。

事件监听需要辅助功能权限（或输入监控权限）。系统在回调超时后会自动停用监听，定时器 watcher 推断就是用来发现并重新启用它的。

## libUtilHelper：杂项

### 接口（readable:main/index.js:2965-2979）

```c
int         launchApplicationByName(const char *name);
int         muteAudio(void);
int         unmuteAudio(void);
int         isAudioMuted(void);
int32_t     deviceIsLidOpen(void);
const char *getAudioDevicesJSON(void);
void        getAudioDevicesJSONAsync(void (*cb)(char *json));
const char *getDeviceId(const char *);
int         checkAccessibilityPermission(void);
```

### 系统 API 与用途

| 接口 | 用到的系统 API | 用途 |
| --- | --- | --- |
| 静音 | CoreAudio `AudioObjectGetPropertyData` / `SetPropertyData` | 录音时把系统输出静音（设置项"录音时静音背景音"） |
| 设备列表 | CoreAudio | 麦克风选择 |
| 合盖检测 | IOKit `IOPMrootDomain` 的 `AppleClamshellState` | 合盖时内置麦克风不可用，要换设备 |
| 设备 ID | Security `SecItemAdd` / `CopyMatching` / `Delete` | 见 [06](06-context-capture-and-privacy.md#设备标识) |
| 权限 | `AXIsProcessTrusted` | |

## 两个 Opus 库

`libopuschunk`（分块编码会话）和 `libopusenc`（整段转换）是 C 库，在 worker 线程里用 koffi 调。接口见 readable:main/worker/*.js：

```c
void   *libopuschunk_session_create(int, int, int, int);
int     libopuschunk_session_set_complexity(void *, int);
void    libopuschunk_session_destroy(void *);
uint64  libopuschunk_estimate_output_size(uint64, int);
int     opus_convert_advanced(const char *in, const char *out, int, float, int, int, double *);
```

没有进一步分析。

## 给仿写的备忘

三件事各自的最小实现路径：

1. **全局热键**：`CGEventTapCreate`（HID 层、主动式）+ run loop。要处理监听被系统停用后的恢复。
2. **读上下文**：系统级 AX 元素 → 焦点应用 → 焦点元素 → 读属性；对 Chromium 系应用先设 `AXEnhancedUserInterface`；网页光标用文本标记接口；所有调用设超时（`AXUIElementSetMessagingTimeout`）。
3. **注入文字**：存剪贴板 → 写入（带临时标记）→ 模拟 ⌘V（按当前键盘布局找键码）→ 恢复剪贴板。
