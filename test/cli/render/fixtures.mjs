// 几个画面的测试共用的：固定的时区和"现在"、一个就绪的状态、默认设置。
// 画面按中文画（原来的断言都是中文的）；要看英文的另给 english。

import { createTranslator } from "../../../src/i18n/index.mjs";

export const zh = createTranslator("zh-CN");
export const en = createTranslator("en");

export const timeZone = "Asia/Shanghai";
// 上海时间 2026-10-13 15:00
export const now = new Date("2026-10-13T07:00:00.000Z");
export const plain = { color: false, timeZone, now, t: zh };
export const english = { ...plain, t: en };

export const ready = {
  pid: 4321,
  version: "0.1.0",
  starting: false,
  hotkey: "right_alt",
  hotkeyLabel: "右 Alt 键",
  provider: "gemini",
  model: "gemini/gemini-3.6-flash",
  thinking: "MINIMAL",
  packaged: false,
  helper: "running",
  key: { state: "ready", source: "stored", problem: null, verified: true },
  permissions: { microphone: "granted", listen: true, trusted: true },
  summary: { ready: true, missing: [], blocker: null, degraded: null },
};
export const settings = {
  hotkey: { value: "right_alt", source: "default" },
  mode: { value: "native", source: "default" },
  model: { value: "gemini/gemini-3.6-flash", source: "default" },
  thinking: { value: "MINIMAL", source: "default" },
  transcriber: { value: "qwen3-asr-0.6b-q8", source: "default" },
  polish: { value: "deepseek/deepseek-flash", source: "default" },
  customUrl: { value: "", source: "default" },
  modelSource: { value: "cn", source: "default" },
  theme: { value: "ink", source: "default" },
  language: { value: "system", source: "default" },
};
export const noStats = { today: null, total: null };
