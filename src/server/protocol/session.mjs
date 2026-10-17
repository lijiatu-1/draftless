import { audioTypeOf } from "../audio/transcode.mjs";
import { ProtocolError } from "./protocol.mjs";

/**
 * 一次录音在服务端的状态：按序收下各个音频块，最后合并成一段。
 * 每一块由两帧组成：先是一条声明（序号、字节数），紧跟一个二进制帧。
 */
export class RecordingSession {
  #chunks = [];
  #announced = null;
  #totalBytes = 0;
  #maxTotalBytes;
  #mimeType = null;

  constructor(audioId, { maxTotalBytes }) {
    this.audioId = audioId;
    this.#maxTotalBytes = maxTotalBytes;
  }

  get chunkCount() {
    return this.#chunks.length;
  }

  get totalBytes() {
    return this.#totalBytes;
  }

  /** 第一块到了才知道；之前是 null */
  get mimeType() {
    return this.#mimeType;
  }

  /** 记下"下一个二进制帧是第几块、多大"。序号从 1 开始（抓包实测） */
  announceChunk({ index, size }) {
    if (this.#announced) {
      throw new ProtocolError("chunk_missing", `第 ${this.#announced.index} 块声明之后没有收到音频帧`);
    }
    const expected = this.#chunks.length + 1;
    if (index !== expected) {
      throw new ProtocolError("chunk_out_of_order", `该收第 ${expected} 块，声明的是第 ${index} 块`);
    }
    this.#announced = { index, size };
  }

  /** 收下一个二进制帧。不合格的帧直接丢弃，客户端要重新声明才能再发这一块 */
  addChunk(data) {
    const announced = this.#announced;
    if (!announced) {
      throw new ProtocolError("chunk_without_info", "音频帧之前没有 set_audio_chunk_info");
    }
    this.#announced = null;
    if (data.length !== announced.size) {
      throw new ProtocolError(
        "chunk_size_mismatch",
        `第 ${announced.index} 块声明 ${announced.size} 字节，实际 ${data.length} 字节`,
      );
    }
    // 靠文件头认容器，不信客户端在 start_audio 里自报的格式。
    // 只认第一块的文件头：浏览器录的 WebM 后面各块是接着写的数据，没有文件头
    const mimeType = this.#mimeType ?? audioTypeOf(data);
    if (!mimeType) {
      throw new ProtocolError("unsupported_audio", "录音的开头既不是 Ogg 也不是 WebM");
    }
    if (this.#totalBytes + data.length > this.#maxTotalBytes) {
      throw new ProtocolError("audio_too_large", `录音超过了 ${this.#maxTotalBytes} 字节的上限`);
    }
    this.#mimeType = mimeType;
    this.#chunks.push(data);
    this.#totalBytes += data.length;
    return announced;
  }

  /**
   * 各块首尾相接就是完整的录音，不需要重新编码：
   * - WebM（浏览器 MediaRecorder 分片输出）本来就是一个文件被切开。
   * - Ogg 每块是独立的流时，相接得到"链式 Ogg"；实测 7 块相接的文件 Gemini 能从头识别到尾。
   */
  merge() {
    return Buffer.concat(this.#chunks, this.#totalBytes);
  }
}
