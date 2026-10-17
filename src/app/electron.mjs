// 主进程怎么拿到 Electron 的 API。
//
// 这个文件替换掉原来那行 `import { app, BrowserWindow } from "electron"`。为什么：
// 打出来的程序从 exe 双击启动时，那条具名导入会报
//   The requested module 'electron' does not provide an export named 'BrowserWindow'
// 进程直接退出，连日志都来不及写。同一份代码用 `electron.exe <app 目录>` 起（开发时 `draftless start` 走的路）
// 却完全正常，所以问题在"打包好的 exe 从 resources/app 里加载 ESM 入口"这条路上，不在业务代码里。
//
// 这里的做法：**先照常静态 import**（能用的环境下这一条就够了，也是 Electron 官方推荐的写法），
// 拿回来之后检查它是不是真的带着主进程要用的那几个（app、BrowserWindow）。没有的话依次退回：
//   1. 入口 main.cjs 用 require 拿到的那个（CommonJS 那条路在打包环境里是通的）
//   2. 动态 import 的 default / module.exports
// 三条都不行时抛一句说清楚的话，而不是让后面的代码在半路上报 "undefined is not an object"。

import * as electronNamespace from "electron";

/** 这个对象像不像真的 Electron：主进程最少要用到这两样 */
function looksUsable(candidate) {
  return Boolean(candidate) && typeof candidate === "object" && typeof candidate.BrowserWindow === "function";
}

/**
 * 挑一个真的带了 API 的对象。顺序有讲究：
 * 先静态 import（开发时就是它），再入口挂的那份，最后 default 那两样。
 */
function pick() {
  const candidates = [electronNamespace, globalThis.__draftlessElectron, electronNamespace?.default];
  for (const candidate of candidates) {
    if (looksUsable(candidate)) return candidate;
  }
  // 一个都不行：把每条路的实际情况写进错误里，排查时不用再猜
  throw new Error(
    "拿不到 Electron 的 API：静态 import、入口 require、动态 import 三条路都没给出可用的模块。" +
      `静态 import 的键是 ${Object.keys(electronNamespace).join(",") || "（空）"}，` +
      `入口挂的是 ${typeof globalThis.__draftlessElectron}`,
  );
}

export const electron = pick();
export const {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  safeStorage,
  screen,
  shell,
  systemPreferences,
  Tray,
} = electron;

export default electron;
