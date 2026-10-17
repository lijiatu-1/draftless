import { writeFileSync } from "node:fs";

// 端到端测试时由主进程加载（设了 DRAFTLESS_E2E_OUT 才会）。它代替人做两件事：
// 模拟"按一下热键、说几秒、再按一下"，以及在该贴字的时候只记下文字、不真的去贴。
// 麦克风由 Chromium 的假设备提供（scripts/dev/e2e.mjs 传的启动参数），整条链路其余部分都是真的。
// 走 local 模式时，先等本地模型下载、装好再按热键（数据目录是新的，模型真的要从下载源下一遍），记下各花了多久。

const OUT_PATH = process.env.DRAFTLESS_E2E_OUT;
const RECORD_MS = Number(process.env.DRAFTLESS_E2E_RECORD_MS ?? 7_500);
const GIVE_UP_MS = RECORD_MS + 40_000;

const pasted = [];
let finish = null;

export const fakeHelper = {
  async paste(text) {
    pasted.push(text);
    return { ok: true, reason: null };
  },
  // 不截真的 esc 和鼠标点击
  capture() {},
  release() {},
  stop() {},
};

/** 主进程在一次听写有了结局（成功或失败）时调用 */
export function onFinished(outcome) {
  finish?.(outcome);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 本地模型装好之前一直等。还没下载的替用户点一下下载（App 不会自己下），每过 10% 说一声。不走 local 模式时直接返回
 * @param {() => object | null} localModel 服务报的本地模型状态（app/service.mjs 的 localModel）
 * @param {(id: string) => Promise<{ ok: boolean, problem?: object }>} downloadModel 模型库的下载（models/library.mjs）
 * @returns {Promise<{ downloadMs: number, loadMs: number, backend: string } | { failed: string } | null>}
 */
async function waitForLocalModel(localModel, downloadModel) {
  if (!localModel() || localModel().state === "off") return null;
  const startedAt = performance.now();
  let downloadedAt = null;
  let reported = -1;
  let asked = false;
  for (;;) {
    const local = localModel();
    if (local.state === "failed") return { failed: JSON.stringify(local.problem) };
    if (local.state === "missing" && !local.total && !asked) {
      asked = true;
      const started = await downloadModel(local.model);
      if (!started.ok) return { failed: JSON.stringify(started.problem) };
    } else if (local.state === "missing" && local.total) {
      const percent = Math.floor((local.received / local.total) * 10) * 10;
      if (percent !== reported) console.log(`本地模型下载中 ${percent}%`);
      reported = percent;
    } else if (local.state !== "missing" && downloadedAt === null) downloadedAt = performance.now();
    if (local.state === "ready") {
      return {
        downloadMs: Math.round(downloadedAt - startedAt),
        loadMs: Math.round(performance.now() - downloadedAt),
        backend: local.backend,
      };
    }
    await sleep(200);
  }
}

export async function run({ bar, history, localModel, downloadModel, quit }) {
  const done = (result, code) => {
    writeFileSync(OUT_PATH, JSON.stringify({ ...result, pasted, history: history.list() }, null, 2));
    quit(code);
  };
  const local = await waitForLocalModel(localModel, downloadModel);
  if (local?.failed) return done({ failed: `本地模型没装上：${local.failed}` }, 1);
  const giveUp = setTimeout(() => done({ failed: `等了 ${GIVE_UP_MS / 1000} 秒没有结局` }, 1), GIVE_UP_MS);
  const outcome = new Promise((resolve) => {
    finish = resolve;
  });

  // 走到这里时页面可能已经加载完了，那样就等不到 did-finish-load
  if (bar.webContents.isLoading()) {
    await new Promise((resolve) => bar.webContents.once("did-finish-load", resolve));
  }
  const press = async () => {
    bar.webContents.send("input", { event: "hotkey", down: true });
    await sleep(120);
    bar.webContents.send("input", { event: "hotkey", down: false });
  };
  await sleep(500);
  await press();
  await sleep(RECORD_MS);
  await press();

  const result = await outcome;
  clearTimeout(giveUp);
  done({ ...result, ...(local ? { localModel: local } : {}) }, result.failed ? 1 : 0);
}
