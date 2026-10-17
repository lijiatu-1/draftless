import { WebSocket, WebSocketServer } from "ws";
import { msg } from "../i18n/index.mjs";
import {
  ClientType,
  envelope,
  MAX_CHUNK_BYTES,
  ProtocolError,
  parseClientMessage,
  ServerType,
} from "./protocol/protocol.mjs";
import { RecordingSession } from "./protocol/session.mjs";

export const WS_PATH = "/ws/rt_voice_flow";

/** 约 25 分钟的录音；Gemini 内联音频的请求上限是 20 MB，base64 之后仍有余量 */
const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const ERROR_DETAIL_MAX_LENGTH = 300;

/**
 * 启动听写服务。refiner 是"音频进、文字出"的那一步（refine），可以带一个开口时先做准备的 prepare，
 * 由调用方传入，测试时换成假的。
 * @returns {Promise<{ port: number, close: () => Promise<void> }>}
 */
export function startServer({
  host = "127.0.0.1",
  port,
  refiner,
  log,
  maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
  readContext = null,
}) {
  return new Promise((resolve, reject) => {
    const wss = new WebSocketServer({
      host,
      port,
      path: WS_PATH,
      maxPayload: MAX_CHUNK_BYTES,
      verifyClient: ({ origin }) => isLocalOrigin(origin),
    });
    wss.once("error", reject);
    wss.once("listening", () => {
      wss.off("error", reject);
      wss.on("error", (error) => log.error("server_error", { error: String(error) }));
      resolve({ port: wss.address().port, close: () => closeServer(wss) });
    });
    wss.on("connection", (socket) => handleConnection(socket, { refiner, log, maxAudioBytes, readContext }));
  });
}

/**
 * 服务只听本机端口，但浏览器里任何网页都能连本机端口，替用户花模型额度。
 * 浏览器发起的连接一定带 Origin，所以只放行没有 Origin 的（本机程序）和 file://（Electron 的本地页面）。
 */
function isLocalOrigin(origin) {
  return origin === undefined || origin === "file://";
}

function closeServer(wss) {
  for (const socket of wss.clients) socket.terminate();
  return new Promise((resolve, reject) => wss.close((error) => (error ? reject(error) : resolve())));
}

function handleConnection(socket, { refiner, log, maxAudioBytes, readContext }) {
  /** 正在收音频的那一次录音；end_audio 之后清空，整理在后台继续 */
  let session = null;
  /** 正在进行的整理，连接断开时用来取消 */
  const refining = new Set();

  const send = (kind, value) => {
    if (socket.readyState !== WebSocket.OPEN) {
      log.warn("send_skipped", { kind, audio_id: value.audio_id, reason: "连接已关闭" });
      return;
    }
    socket.send(JSON.stringify(envelope(kind, value)));
  };

  const requireSession = (audioId) => {
    if (!session) throw new ProtocolError("no_session", "还没有 start_audio");
    if (audioId !== undefined && audioId !== session.audioId) {
      throw new ProtocolError("audio_id_mismatch", `当前录音是 ${session.audioId}，消息里是 ${audioId}`);
    }
    return session;
  };

  const onText = (text) => {
    const message = parseClientMessage(text);
    switch (message.type) {
      case ClientType.START:
        if (session) {
          // 客户端取消录音时不发 end_audio，直接开始下一次
          log.info("session_abandoned", { audio_id: session.audioId, chunks: session.chunkCount });
        }
        session = new RecordingSession(message.audioId, { maxTotalBytes: maxAudioBytes });
        // 用户开口了：让模型那边先备好要用的东西（Gemini 建提示词缓存），说完整理时就用得上。
        // 不等它；备不好只是这一次贵一点，记一笔就算了
        Promise.resolve()
          .then(() => refiner.prepare?.())
          .catch((error) => log.warn("prepare_failed", { audio_id: message.audioId, error: String(error?.message) }));
        send(ServerType.STARTED, { audio_id: message.audioId, start_time: Date.now() });
        break;
      case ClientType.CHUNK_INFO:
        requireSession(message.audioId).announceChunk(message);
        break;
      case ClientType.END: {
        const finished = requireSession(message.audioId);
        session = null;
        // 整理要等上游一两秒，不能卡住这条连接上后面的消息
        finish(finished).catch((error) => failConnection(error));
        break;
      }
    }
  };

  const onChunk = (data) => {
    const { index, size } = requireSession().addChunk(data);
    send(ServerType.CHUNK_RECEIVED, { index, server_t: Date.now(), size });
  };

  const finish = async (finished) => {
    const context = { audio_id: finished.audioId, chunks: finished.chunkCount, bytes: finished.totalBytes };
    if (finished.chunkCount === 0) {
      log.warn("no_audio", context);
      send(ServerType.PROCESSING_ERROR, {
        audio_id: finished.audioId,
        code: "no_audio",
        detail: "no audio received",
        problem: msg("voice.noAudio"),
      });
      return;
    }
    send(ServerType.ENDING, {
      audio_id: finished.audioId,
      total_chunks: finished.chunkCount,
      completed_chunks: finished.chunkCount,
      failed_chunks: 0,
    });

    const abort = new AbortController();
    refining.add(abort);
    const startedAt = performance.now();
    try {
      // 他光标前面已经写好的字：模型靠它判断"在写代码还是写邮件"，从而决定整理力度。
      // 读不到是常态（很多应用没有可读的输入框），那时就是空字符串，不影响链路。
      // 放在 end_audio 这一刻读，是因为用户刚停嘴、焦点还停在他要输入的那个框里
      let contextText = "";
      if (readContext) {
        const startedContext = performance.now();
        try {
          contextText = (await readContext()) ?? "";
        } catch (error) {
          log.warn("context_failed", { audio_id: finished.audioId, error: String(error?.message ?? error) });
        }
        log.info("context_ready", {
          audio_id: finished.audioId,
          chars: contextText.length,
          ms: Math.round(performance.now() - startedContext),
        });
      }
      const refinedText = await refiner.refine(finished.merge(), {
        mimeType: finished.mimeType,
        signal: abort.signal,
        audioId: finished.audioId,
        context: contextText,
      });
      // 日志只记长度：成品是用户说的话，不该留在日志里
      log.info("refined", {
        ...context,
        refine_ms: Math.round(performance.now() - startedAt),
        text_length: refinedText.length,
      });
      // 后五项在普通听写里实测都是 null，照原样带上，客户端按同一套字段解析
      send(ServerType.COMPLETED, {
        audio_id: finished.audioId,
        refined_text: refinedText,
        status: true,
        run_index: 1,
        web_metadata: null,
        delivery: null,
        action: null,
        user_prompt: null,
        external_action: null,
      });
    } catch (error) {
      if (abort.signal.aborted) {
        log.info("refine_cancelled", { ...context, reason: "连接已断开" });
        return;
      }
      log.error("refine_failed", {
        ...context,
        refine_ms: Math.round(performance.now() - startedAt),
        error: String(error?.stack ?? error),
        // 模型层的错误（ModelError）给用户的是 problem，模型回的原文（已抹掉 key）在 detail 里
        ...(error?.detail ? { model_said: error.detail.slice(0, 1_000) } : {}),
        ...(error?.origin ? { origin: error.origin.slice(0, 2_000) } : {}),
      });
      // 原版只有 code 和 detail。problem 是我们加的：给用户看的那句话（msg 或原话），由悬浮条按界面语言翻
      send(ServerType.PROCESSING_ERROR, {
        audio_id: finished.audioId,
        code: "refine_failed",
        detail: String(error?.message ?? error).slice(0, ERROR_DETAIL_MAX_LENGTH),
        ...(error?.problem ? { problem: error.problem } : {}),
      });
    } finally {
      refining.delete(abort);
    }
  };

  /** 协议之外的错误说明服务端自己有 bug：记下来并断开，不带着坏状态继续 */
  const failConnection = (error) => {
    log.error("connection_failed", { audio_id: session?.audioId, error: String(error?.stack ?? error) });
    socket.close(1011, "internal error");
  };

  socket.on("message", (data, isBinary) => {
    try {
      if (isBinary) onChunk(data);
      else onText(data.toString("utf8"));
    } catch (error) {
      if (!(error instanceof ProtocolError)) {
        failConnection(error);
        return;
      }
      log.warn("protocol_error", { audio_id: session?.audioId, code: error.code, detail: error.detail });
      send(ServerType.ERROR, { audio_id: session?.audioId ?? null, code: error.code, detail: error.detail });
    }
  });

  socket.on("error", (error) => log.warn("socket_error", { audio_id: session?.audioId, error: String(error) }));

  socket.on("close", (code) => {
    if (session) log.info("session_abandoned", { audio_id: session.audioId, chunks: session.chunkCount, code });
    session = null;
    for (const abort of refining) abort.abort();
  });
}
