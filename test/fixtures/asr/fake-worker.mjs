// 假的转写进程：协议照真的走（worker.mjs 的 serveTranscriber），模型换成假的。
// 交来的样本个数决定它怎么做：1 个 → 进程崩掉，2 个 → 一直不回话，3 个 → 运行库报错，别的 → 回 "模型 id:样本数"
import { serveTranscriber } from "../../../src/server/asr/worker.mjs";

serveTranscriber(
  { on: (event, handler) => process.on(event, handler), send: (m) => process.send(m), exit: process.exit },
  async ({ model, options }) => {
    if (options.failLoad) throw new Error("模型文件坏了");
    return {
      backend: "fake",
      async transcribe(samples) {
        if (samples.length === 1) process.exit(3);
        if (samples.length === 2) return new Promise(() => {});
        if (samples.length === 3) throw new Error("运行库报错");
        if (!(samples instanceof Float32Array)) throw new Error("样本不是 Float32Array");
        return { text: `${model.id}:${samples.length}` };
      },
      dispose() {},
    };
  },
);
process.on("disconnect", () => process.exit(0));
