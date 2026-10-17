# 01 包结构与签名

## 身份

| 项 | 值 | 证据 |
| --- | --- | --- |
| Bundle ID | `now.typeless.desktop` | `ev_2ade80387624…` |
| 版本 | 2.8.1（build 2.8.1.130） | 同上 |
| 最低系统 | macOS 11.0 | 同上 |
| URL scheme | `typeless://`（登录回调用） | 同上 |
| 签名 | Developer ID Application: Simply LLC (947QKAND4W) | `ev_c38e740933e3…` |
| 签名时间 | 2026-09-24 | 同上 |
| 主程序 | `Contents/MacOS/Typeless`，仅 arm64 | open_binary |
| Electron | 33.4.11 | Electron Framework 的 Info.plist |
| 更新源 | `https://typeless-static.com/desktop-release/`（electron-updater generic，频道 arm64） | `Resources/app-update.yml` |

## 权限

签名内嵌的 entitlements 只有四项（`ev_c38e740933e3…`，与 `build/entitlements.mac.plist` 一致 `ev_7c03de934ec9…`）：

- `com.apple.security.device.audio-input`：麦克风
- `com.apple.security.network.client`：联网
- `com.apple.security.cs.allow-jit`、`allow-unsigned-executable-memory`：V8 需要

没有 `disable-library-validation`、`get-task-allow`、`allow-dyld-environment-variables`。含义：不能用调试器附加，不能注入动态库，它加载的库必须是同一团队签名。

Info.plist 里声明了四类用途说明：麦克风、摄像头、蓝牙、屏幕录制。后三类在已读代码里没有看到对应调用（`desktopCapturer` 有导入，用途未查）。

辅助功能权限（Accessibility）不走 entitlement，由用户在系统设置里授予。读上下文、监听全局按键、模拟粘贴都依赖它。

## Electron 安全开关（fuses）

从 Electron Framework 二进制里读出（自写脚本解析哨兵串，非 REA）：

| 开关 | 状态 | 含义 |
| --- | --- | --- |
| RunAsNode | 开 | 可用 `ELECTRON_RUN_AS_NODE` 把它当 Node 跑 |
| EnableNodeOptionsEnvironmentVariable | 开 | 认 `NODE_OPTIONS`、`NODE_EXTRA_CA_CERTS` |
| EnableNodeCliInspectArguments | 开 | 认 `--inspect`，主进程可挂调试器 |
| EnableEmbeddedAsarIntegrityValidation | 开 | 启动时校验 `app.asar`，改包会起不来 |
| OnlyLoadAppFromAsar | 开 | 只从 asar 加载 |
| EnableCookieEncryption | 关 | |

asar 完整性校验值登记在 Info.plist 的 `ElectronAsarIntegrity`。所以运行时观察不能靠改包，只能靠外部手段（调试端口、改配置、代理）。

## 包内布局

```
Typeless.app/Contents/
├── MacOS/Typeless                        主程序（Electron 壳）
├── Frameworks/
│   ├── Electron Framework.framework
│   └── Typeless Helper*.app ×4           GPU / Renderer / Plugin / 通用
└── Resources/
    ├── app.asar                          292 MB，应用代码 + node_modules
    ├── app.asar.unpacked/                better-sqlite3.node、koffi.node
    ├── app-update.yml
    ├── build/entitlements.mac.plist
    ├── drizzle/                          14 个数据库迁移 SQL
    └── lib/
        ├── context-helper/build/libContextHelper.dylib     读焦点上下文
        ├── input-helper/build/libInputHelper.dylib         插入文字、读选区
        ├── keyboard-helper/build/libKeyboardHelper.dylib   全局按键监听
        ├── util-helper/build/libUtilHelper.dylib           音频设备、设备标识
        ├── libopusenc/…/libopusenc.dylib                   整段音频转 Opus
        ├── libopuschunk/…/libopuschunk.dylib               分块 Opus 编码
        └── child-process-helper/bin/macos/macosCheckAccessibility
```

asar 内应用自己的代码只有 `dist/`（256 个文件，55 MB，其中 JS 约 19 MB），其余是依赖。

## 依赖里能看出的东西

`package.json` 的依赖（`_work/asar/package.json`）：

- `koffi`：从 JS 直接调 C 接口，4 个 Swift 库都这么接。
- `better-sqlite3` + `drizzle-orm`：本地数据库。
- `electron-store`：JSON 配置文件。
- `undici`：HTTP 代理支持。
- `crypto-js`：请求签名用的 AES 和 HMAC。
- `@sentry/electron`：崩溃上报。
- `winax`、`@libsql/client`：Windows 端和未启用的远端库，macOS 上未见使用。

`lint-staged` 配置里有 `src/**/*.swift` 和 `swiftformat`，说明 Swift 库和 JS 在同一个仓库里开发。
