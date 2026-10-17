// 听写协议里本服务端用到的那一部分。
// 消息名和字段名照抄 Typeless 抓包的实测结果（docs/05-network-protocol.md），
// 这样仿刻的两端和逆向文档能一一对上。原版还有上下文、模式配置等消息，这里没有发送方，就不实现。

/** 3 秒一块实测 14–15 KB，这里留足余量；也用作 WebSocket 单帧上限 */
export const MAX_CHUNK_BYTES = 256 * 1024;
const MAX_AUDIO_ID_LENGTH = 128;

export const ClientType = Object.freeze({
  START: "start_audio",
  CHUNK_INFO: "set_audio_chunk_info",
  END: "end_audio",
});

export const ServerType = Object.freeze({
  STARTED: "audio_session_started",
  CHUNK_RECEIVED: "received_audio_chunk_count",
  ENDING: "audio_session_ending",
  COMPLETED: "audio_processing_completed",
  PROCESSING_ERROR: "audio_processing_error",
  ERROR: "error",
});

/** 客户端发来的东西不合协议。code 给程序判断，detail 给人看 */
export class ProtocolError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = "ProtocolError";
    this.code = code;
    this.detail = detail;
  }
}

/** 服务端消息的外壳。T/M/S 在抓包里只见过这一组取值 */
export function envelope(kind, value) {
  return { K: kind, V: value, T: "json", M: false, S: "done" };
}

function audioIdOf(message) {
  const id = message.audio_id;
  if (typeof id !== "string" || id.length === 0 || id.length > MAX_AUDIO_ID_LENGTH) {
    throw new ProtocolError("invalid_field", `audio_id 要是 1–${MAX_AUDIO_ID_LENGTH} 个字符的字符串`);
  }
  return id;
}

function positiveInteger(message, field, max) {
  const value = message[field];
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new ProtocolError("invalid_field", `${field} 要是 1–${max} 之间的整数`);
  }
  return value;
}

// 用 Map 而不是对象字面量：消息类型来自外部输入，不能让 "constructor" 这类原型属性名查到东西
const PARSERS = new Map([
  [ClientType.START, (message) => ({ type: ClientType.START, audioId: audioIdOf(message) })],
  [
    ClientType.CHUNK_INFO,
    (message) => ({
      type: ClientType.CHUNK_INFO,
      audioId: audioIdOf(message),
      index: positiveInteger(message, "index", Number.MAX_SAFE_INTEGER),
      size: positiveInteger(message, "size", MAX_CHUNK_BYTES),
    }),
  ],
  [ClientType.END, (message) => ({ type: ClientType.END, audioId: audioIdOf(message) })],
]);

/** 解析并校验一条文本消息，只留下服务端用得到的字段 */
export function parseClientMessage(text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    throw new ProtocolError("invalid_json", "文本帧不是合法的 JSON");
  }
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    throw new ProtocolError("invalid_message", "消息必须是 JSON 对象");
  }
  const parse = PARSERS.get(message.type);
  if (!parse) {
    throw new ProtocolError("unknown_type", `不认识的消息类型：${String(message.type).slice(0, 64)}`);
  }
  return parse(message);
}
