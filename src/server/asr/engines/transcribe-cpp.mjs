// transcribe.cpp（Handy 的引擎，MIT，基于 ggml）的适配器：读 GGUF，Apple 芯片上自动走 Metal，Windows 走 Vulkan，
// 别处退回 CPU；npm 上有 Mac 两种芯片（Intel 只有 CPU）、Windows、Linux 的预编译包。接口见 index.mjs。

/** 每一族都是一个 GGUF 文件，清单里叫 gguf；输出是干净的文字，没有要去掉的标记 */
const singleGguf = Object.freeze({ config: (file) => file("gguf") });

export const FAMILIES = Object.freeze({
  "qwen3-asr": singleGguf,
  "sense-voice": singleGguf,
});

export async function version() {
  const { version } = await import("transcribe-cpp");
  return version().version;
}

/**
 * @param {{ model: object, file: (role: string) => string, options?: { backend?: string, threads?: number } }} request
 *   backend：auto（默认，有 GPU 用 GPU）、cpu、metal、vulkan…；threads：CPU 那部分用几个线程，不给是库的默认值
 */
export async function load({ model, file, options = {} }) {
  const { TranscribeModel } = await import("transcribe-cpp");
  const loaded = await TranscribeModel.load(FAMILIES[model.family].config(file), {
    backend: options.backend ?? "auto",
  });
  const session = loaded.createSession({ nThreads: options.threads ?? 0 });
  return {
    backend: loaded.backend,
    async transcribe(samples) {
      // 只要文字，不要时间戳：时间戳要多算一遍对齐
      const result = await session.run(samples, { timestamps: "none" });
      return { text: String(result.text ?? "").trim() };
    },
    dispose() {
      session.dispose();
      loaded.dispose();
    },
  };
}
