import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { msg } from "../i18n/index.mjs";

// 一次听写结束后主进程要做的事：存录音、记历史、把文字贴出去。
// 和原版一样，录音存在 Recordings/<audio_id> 下，失败的也存（docs/08-local-data.md）。

/** audio_id 会拼进文件名，只接受页面用 crypto.randomUUID() 生成的那种格式 */
const AUDIO_ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

function checkRecording({ audioId, durationSeconds, audio }) {
  if (typeof audioId !== "string" || !AUDIO_ID.test(audioId)) throw new TypeError("audioId 不是 UUID");
  if (!Number.isFinite(durationSeconds) || durationSeconds < 0) throw new TypeError("durationSeconds 不是有效的时长");
  if (!(audio instanceof ArrayBuffer) && !ArrayBuffer.isView(audio)) throw new TypeError("audio 不是二进制数据");
}

/**
 * @param {object} deps
 * @param {string} deps.recordingsDir
 * @param {{ add: Function }} deps.history
 * @param {(text: string) => Promise<{ ok: boolean }>} deps.paste
 * @param {(text: string) => void} deps.writeClipboard
 * @param {{ warn: Function, error: Function }} deps.log
 */
export function createDelivery({ recordingsDir, history, paste, writeClipboard, log, now = () => new Date() }) {
  const record = (payload, fields) => {
    checkRecording(payload);
    mkdirSync(recordingsDir, { recursive: true });
    const audioLocalPath = join(recordingsDir, `${payload.audioId}.webm`);
    const { audio } = payload;
    // 视图可能只是底层缓冲区的一段，只写它自己那一段
    const bytes = ArrayBuffer.isView(audio)
      ? new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength)
      : new Uint8Array(audio);
    writeFileSync(audioLocalPath, bytes);
    history.add({
      id: payload.audioId,
      duration: payload.durationSeconds,
      audioLocalPath,
      createdAt: now().toISOString(),
      ...fields,
    });
  };

  return {
    /**
     * 成品回来了：先落盘，再贴。贴不进去时把文字放进剪贴板，用户不会丢字。
     *
     * 剪贴板由这里兜底写一遍，而不是只指望小帮手：小帮手在 `uipi_blocked`／`input_blocked` 时
     * 会把文字留在剪贴板里，但 `clipboard_busy`（剪贴板被别的程序占着，连存都存不下来）那一路
     * 根本没写进去。两种都在这里补一次，悬浮条上那句"文字已复制，按 Ctrl+V"才在每种失败下都成立。
     * @returns {Promise<{ notice: object | null }>} notice 是要在悬浮条上告诉用户的话（msg，悬浮条按界面语言翻）
     */
    async completed(payload) {
      if (typeof payload.text !== "string") throw new TypeError("text 不是字符串");
      record(payload, { status: "completed", refinedText: payload.text, error: null });
      if (payload.text === "") return { notice: msg("delivery.silent") };
      let result;
      try {
        result = await paste(payload.text);
      } catch (error) {
        log.error("paste_failed", { audio_id: payload.audioId, error: String(error?.message ?? error) });
        writeClipboard(payload.text);
        return { notice: msg("delivery.pasteFailed") };
      }
      if (result.ok) return { notice: null };
      // 没贴进去：文字一定在剪贴板里，说清是为什么、怎么自己贴
      log.warn("paste_not_delivered", { audio_id: payload.audioId, reason: result.reason });
      try {
        writeClipboard(payload.text);
      } catch (error) {
        // 连主进程都写不进去（剪贴板被别的程序死攥着）。这时那句话就不该说"已复制"，
        // 只能说成品在哪——它在历史里
        log.error("clipboard_fallback_failed", { audio_id: payload.audioId, error: String(error?.message ?? error) });
        return { notice: msg("delivery.pasteFailedNoClipboard") };
      }
      // 文案要跟原因对上：只有真的被权限挡住才说"管理员权限的窗口"。
      // input_blocked 后面跟着的是 GetLastError：5（ERROR_ACCESS_DENIED）才是被 UIPI 拦了，
      // 别的码（比如曾经那个 87）是别的问题，硬说成权限会把人带偏
      const blockedByUipi = result.reason === "uipi_blocked" || result.reason === "input_blocked:5";
      const noticeKey =
        result.reason === "not_editable"
          ? "delivery.notEditable"
          : blockedByUipi
            ? "delivery.noAccessibility"
            : "delivery.pasteFailed";
      return { notice: msg(noticeKey) };
    },

    /** 这次听写失败了：录音和原因记进历史 */
    failed(payload) {
      if (typeof payload.error !== "string") throw new TypeError("error 不是字符串");
      record(payload, { status: "failed", refinedText: "", error: payload.error });
    },
  };
}
