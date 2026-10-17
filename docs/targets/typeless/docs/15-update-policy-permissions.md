# 15 更新、企业策略与权限

三块零散但需要交代的内容。静态阅读的结论。

## 自动更新

用的是 electron-updater，配置在包内的 `Contents/Resources/app-update.yml`：

```yaml
provider: generic
channel: arm64
url: https://typeless-static.com/desktop-release/
updaterCacheDirName: typeless-updater
```

`generic` 表示更新源就是一个放静态文件的地址，客户端去取频道对应的清单文件，比对版本号。

| 项 | 做法 | 位置 |
| --- | --- | --- |
| 自动下载 | 关闭（`autoDownload = false`），由界面决定何时下 | readable:main/index.js:19967 |
| 降级 | 不允许（`allowDowngrade = false`） | 19969 |
| 触发 | 主进程不自己定时，全部由渲染层通过 IPC 发起 | 20066-20158 |
| 静默更新 | `updater:check-update-and-download-silently`：有新版就直接下，下完弹提示 | 20112-20158 |
| 安装 | `updater:quit-and-install` | 20106-20111 |

IPC 通道一共四个：`updater:check-for-update`、`updater:download-update`、`updater:quit-and-install`、`updater:check-update-and-download-silently`。渲染层多久查一次没有读。

两处细节：

- **芯片频道修正**（19976-20001）。启动时如果是 Apple 芯片（或者是在 Rosetta 下运行），而 `app-update.yml` 里的频道还是 `latest`，就把它改写成 `arm64` 并存回文件。推断目的是让装了 Intel 版的 Apple 芯片机器下次更新换到原生版本。本机这个文件已经是 `arm64`。
- **错误归类**（20031-20060）。把更新库抛出的错误按文字归成"本地找不到更新包""代码签名错误""网络错误"三类再通知界面，更新失败还会上报一条统计事件。

应用代码里没有看到对更新包的额外验证。完整性依赖 electron-updater 自身的机制（清单里的校验和、macOS 上的代码签名检查），这是该库的通用行为，没有在本包里逐项核实。

## 企业策略

渲染层调 `enterprise-policy:updated`（调用处在 readable:UfR9-a2Z.js:8556，触发时机没有读），主进程据此调整两件事（readable:main/index.js:18373-18425）：

判断是不是企业用户：`subscription_type` 为 `ENTERPRISE` 且有 `org_id`。

| 用户信息里的字段 | 作用 |
| --- | --- |
| `org_settings.retention_policy.transcription` | 本地历史保留时长的上限。值等于 31536000（一年）时上限为一年，其他值视为不设上限 |
| `org_settings.cloud_sync_policy.allow_member_cloud_sync` | 成员能不能用云同步。不为 `true` 时走另一条分支，推断是强制关闭同步，那段没有读完 |

非企业用户上限设为 -1（不限）。

也就是说组织管理员能做的是：把成员的本地历史限制在一年以内，以及禁止成员把历史同步到云端。对个人版没有影响。

## 权限

### 系统权限的实际用途

`Info.plist` 里声明了五项用途说明，逐项对到代码：

| 声明 | 代码里的用途 |
| --- | --- |
| 麦克风 | 录音（[11](11-audio-recorder.md)） |
| 屏幕录制 | 只有"申请"这一步，见下 |
| 摄像头 | 没有找到使用处。说明文字是 Electron 打包工具的默认模板（`This app needs access to the camera`） |
| 蓝牙（两项） | 同上，默认模板，没有找到使用处 |

辅助功能和输入监控不需要在 `Info.plist` 里声明，它们的用途见 [07](07-native-helpers.md)。

"没有找到使用处"的搜索范围：可读树全部 JS 文件，字面量搜 `navigator.bluetooth`、`requestDevice`、`"camera"`、`videoinput`、`getDisplayMedia`、带 `video` 的媒体约束，均为 0 处。原生库没有针对这几项单独查。

### 屏幕录制权限

主进程的权限处理里有一个分支叫 `screen-audio-capture`（readable:main/index.js:19282-19302）：

- 查询：`getMediaAccessStatus("screen")`。
- 申请：调一次 `desktopCapturer.getSources({types: ["screen"]})`，目的只是让系统弹出授权框，返回的屏幕源没有被使用。被拒绝就打开系统设置的对应页面。

这是全包里 `desktopCapturer` 唯一的一处调用。在渲染层没有搜到 `screen-audio-capture` 这个权限名的调用方，也没有搜到 `getDisplayMedia`。

结论：**2.8.1 里没有实际截屏或录系统声音的代码路径，只有一段申请权限的预留逻辑。** 从名字推断它是为"录制系统声音"（比如会议转写）准备的。权限名如果在渲染层是拼接出来的，字面量搜索会漏，所以这条是有边界的否定。

"可见文字"（[06](06-context-capture-and-privacy.md)）走的是辅助功能接口，不是截屏，不需要这项权限。

### 辅助功能权限的自检

申请辅助功能权限时，主进程和键盘子进程各查一次，结果不一致就重置权限并重启应用（19255-19264）。推断是为了处理"系统设置里显示已授权但子进程实际没生效"这种 macOS 上常见的状态不同步。

### Electron 内部的权限开关

- 默认会话：所有权限请求一律放行（20413-20415）。
- 各窗口的会话：只放行 `media`（麦克风），其余拒绝（4606-4611）。

窗口用的是一个独立分区的会话（`session.fromPartition`，4578），不是默认会话，所以对窗口生效的是第二条。默认会话全放行影响的是不走该分区的内容；有哪些内容走默认会话没有查。

## 给仿写的备忘

- 只声明用得到的权限。打包模板带出来的摄像头、蓝牙说明应当删掉，否则用户在系统设置里看到会起疑。
- 更新源用静态文件加 electron-updater 的 `generic` 模式足够，不需要自己写更新服务。
- 权限状态以"真正干活的那个进程"查到的为准，不要只信主进程。
