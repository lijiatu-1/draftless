import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const PASTE_TIMEOUT_MS = 3_000;
/** 读光标前文字最多等多久：读不到就算了，不能挡着这次听写 */
const CONTEXT_TIMEOUT_MS = 400;

/**
 * 启动原生小帮手（native-win/*.cs 编出来的 draftless-helper.exe）并和它对话。两边"一行一个 JSON"。
 *
 * 和原版是同一份东西、同一套协议：
 *   ready { listen, trusted, capture } / hotkey { down } / other_key / escape / click { id } / pasted { id, ok, reason } / exit
 * 差别只有 ready 里那两项说的是什么：macOS 上是输入监控和辅助功能两项权限；Windows 上没有这两项权限，
 * 说的是键盘钩子和鼠标钩子装上没有。上层照旧只认 listen、trusted、capture 三个名字。
 *
 * @param {string} command 可执行文件
 * @param {object} options
 * @param {string[]} [options.args]
 * @param {(event: object) => void} options.onEvent 收到上面的那些事件，以及小帮手不在了（退出或根本没起来）时的 exit，只报一次
 * @param {{ warn: Function, error: Function }} options.log
 */
export function startHelper(command, { args = [], onEvent, log }) {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    // 不加这个的话每次启动都会闪一个黑色的控制台窗口
    windowsHide: true,
  });
  /** 发出去还没回的粘贴请求：id → { resolve, reject, timer } */
  const pending = new Map();
  /** 正在等 context 回话的那几个回调（同一时刻通常只有一个） */
  const waiting = new Set();
  let nextId = 1;
  let exited = false;

  const rejectAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      log.warn("helper_bad_line", { line: line.slice(0, 200) });
      return;
    }
    if (event.event === "pasted") {
      const request = pending.get(event.id);
      if (!request) return;
      pending.delete(event.id);
      clearTimeout(request.timer);
      request.resolve({ ok: event.ok, reason: event.reason ?? null });
    } else if (event.event === "context") {
      // 读光标前文字的回话。日志只记字数，不记内容——那是用户正在写的东西
      log.info("context_captured", { chars: event.chars ?? 0, by: event.by ?? "none" });
      const text = typeof event.text === "string" ? event.text : "";
      for (const handler of waiting) handler(text);
      waiting.clear();
    } else if (event.event === "error") {
      log.error("helper_error", { message: event.message });
    } else {
      onEvent(event);
    }
  });
  createInterface({ input: child.stderr }).on("line", (line) => log.warn("helper_stderr", { line }));

  /** 它不在了：等着的粘贴全部失败，并往上报一次。启动不起来和中途退出都走这里 */
  const gone = (reason, code = null, signal = null) => {
    if (exited) return;
    exited = true;
    rejectAll(reason);
    onEvent({ event: "exit", code, signal });
  };

  child.on("error", (error) => {
    // 可执行文件不存在或没有执行权限时只有这个事件，不会再有 exit
    log.error("helper_spawn_failed", { command, error: String(error) });
    gone(error);
  });
  child.on("exit", (code, signal) => gone(new Error("原生小帮手退出了"), code, signal));

  return {
    /**
     * 把文字贴进当前输入框。
     * @returns {Promise<{ ok: boolean, reason: string | null }>} ok 为 false 时文字留在剪贴板里
     */
    paste(text) {
      if (exited) return Promise.reject(new Error("原生小帮手没有在运行"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("粘贴没有在限时内完成"));
        }, PASTE_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ cmd: "paste", id, text })}\n`);
      });
    },
    /**
     * 听写进行中：把 esc 和这几块里的鼠标点击截下来，不让别的应用收到。截到了会报 escape / click。
     * 小帮手不在了就什么也不做：那时热键本身也不灵，上面已经报过了。
     * @param {{ id: string, x: number, y: number, width: number, height: number }[]} regions 屏幕坐标
     */
    capture(regions) {
      if (!exited) child.stdin.write(`${JSON.stringify({ cmd: "capture", regions })}\n`);
    },
    /**
     * 录音期间把系统输出静音（扬声器的声音会回灌进麦克风），录完还原成用户原来的状态。
     * 不等回应：静音失败不该挡住这次听写，最坏就是回灌一点声音。
     * @param {boolean} on
     */
    setSystemMute(on) {
      if (!exited) child.stdin.write(`${JSON.stringify({ cmd: on ? "mute" : "unmute" })}\n`);
    },
    /**
     * 读焦点输入框里光标前的一段文字，用来给模型判断"他在写什么"。
     *
     * 拿不到是常态（老 Win32 程序、密码框、焦点在窗口而不是输入框），那时回空字符串。
     * **从不 reject**：上下文是锦上添花，它出问题不能把这次听写带下去。
     * 超时 400 ms——比原版给的 500 ms 紧一点，因为这个读不到就算了。
     *
     * @param {number} maxChars
     * @returns {Promise<string>}
     */
    readContext(maxChars = 500) {
      if (exited) return Promise.resolve("");
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(handler);
          resolve("");
        }, CONTEXT_TIMEOUT_MS);
        const handler = (text) => {
          clearTimeout(timer);
          resolve(text);
        };
        waiting.add(handler);
        child.stdin.write(`${JSON.stringify({ cmd: "context", maxChars })}\n`);
      });
    },
    /** 不截了 */
    release() {
      if (!exited) child.stdin.write(`${JSON.stringify({ cmd: "release" })}\n`);
    },
    /** 关掉标准输入，小帮手会自己退出 */
    stop() {
      child.stdin.end();
    },
  };
}

/**
 * 单独问一次小帮手的状态：带着 --check 启动、等它把能力和自检报上来、再退出。不监听热键，也不动剪贴板。
 * 命令行的 doctor 和"热键没反应时先看看钩子装没装上"用它。
 * @param {string} command
 * @returns {Promise<{ listen: boolean, capture: boolean, clipboard: boolean }>}
 */
export function checkHelper(command) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, ["--check"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let said = "";
    let settled = null;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("小帮手的自检超过 5 秒没有回话"));
    }, 5_000);
    createInterface({ input: child.stdout }).on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.event === "check") {
          settled = {
            listen: event.listen === true,
            capture: event.capture === true,
            clipboard: event.clipboard_text === true,
          };
        }
      } catch {
        // 不是 JSON 的行不当真：小帮手只在出错时才往这里写别的东西
      }
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      said += `${line}\n`;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (settled !== null) resolve(settled);
      else reject(new Error(`小帮手的自检没有回话（退出码 ${code}）${said ? `：${said.trim()}` : ""}`));
    });
  });
}
