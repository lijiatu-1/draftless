// App 和命令行共用同一份 key，不需要合并。
//
// 原版这里是"把 App 另存的那一份 <厂商>-key.app.bin 并进共用的 <厂商>-key.bin"
// ——那边两边的钥匙串访问名单不一样，才需要分两份存。
// Windows 上 safeStorage 背后是当前用户的 DPAPI：同一个用户下，装成应用的进程和从命令行起的进程
// 解的是同一份密文，一开始就只有一个文件，没有要合并的东西。
//
// 留一个空实现，让调用的地方不用分平台，也知道这件事在 Windows 上为什么不存在。

/**
 * @returns {void} 这一版没有要做的事
 */
export function adoptAppKeys() {}
