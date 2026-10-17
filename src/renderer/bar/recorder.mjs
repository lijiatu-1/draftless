// 录音：打开麦克风，每 3 秒吐一块 Opus。参数照原版（docs/11-audio-recorder.md）：
// 单声道、32 kbps、3 秒一块，回声消除、降噪、自动增益全部关掉，把未加工的声音交给模型。
// 和原版不同的是容器：原版自带编码库出 Ogg，这里用浏览器自带的 MediaRecorder，出的是 WebM。

import { LocalizedError, msg } from "../../i18n/index.mjs";
import { meterLevels, openMicrophone } from "../shared/level-meter.mjs";

const CHUNK_MS = 3_000;
const MIME_TYPE = "audio/webm;codecs=opus";

/**
 * @param {object} handlers
 * @param {(chunk: Blob) => void} handlers.onChunk 每 3 秒一块，结束时还有最后一块
 * @param {(level: number) => void} handlers.onLevel 0–1 的瞬时音量，每 50 ms 一次（悬浮条的声波按这个节奏起波）
 * @param {(error: Error) => void} handlers.onError 录音中途出错
 */
export async function startRecording({ onChunk, onLevel, onError }) {
  const stream = await openMicrophone();
  const recorder = new MediaRecorder(stream, { mimeType: MIME_TYPE, audioBitsPerSecond: 32_000 });
  const chunks = [];
  let cancelled = false;

  recorder.addEventListener("dataavailable", (event) => {
    if (cancelled || event.data.size === 0) return;
    chunks.push(event.data);
    onChunk(event.data);
  });
  recorder.addEventListener("error", (event) => {
    if (!cancelled) {
      const reason = event.error?.message ?? msg("common.unknownReason");
      onError(new LocalizedError(msg("bar.recordError", { reason })));
    }
  });

  // 音量：给界面一点反馈，也用来发现"麦克风完全没信号"（设备被静音、选错了输入）
  const meter = meterLevels(stream, onLevel);
  const release = () => {
    meter.stop();
    for (const track of stream.getTracks()) track.stop();
  };

  const startedAt = performance.now();
  recorder.start(CHUNK_MS);

  return {
    /** 结束录音。最后一块会先经 onChunk 交出去，然后这里才返回 */
    stop() {
      return new Promise((resolve) => {
        recorder.addEventListener(
          "stop",
          () => {
            release();
            resolve({
              blob: new Blob(chunks, { type: MIME_TYPE }),
              durationSeconds: (performance.now() - startedAt) / 1000,
              hadSignal: meter.hadSignal(),
            });
          },
          { once: true },
        );
        recorder.stop();
      });
    },
    /** 丢弃这次录音，已经录下的不再交出去 */
    cancel() {
      cancelled = true;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
