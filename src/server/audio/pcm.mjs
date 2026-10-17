// 解码之后的那几步：合成单声道、降采样、封成 WAV。都是几行能写清的小事，所以不另装库：
// 看过的降采样库里，周下载只有几百的不放心用，封 WAV 只是写一个 44 字节的头。

/**
 * 识别用的统一格式：16 kHz、单声道。云端模型和本地转写都收它，说话用 16 kHz 足够；
 * 进来的录音不管什么格式，先换成这个再往下交（transcode.mjs 的 toSpeech）。
 */
export const SPEECH_SAMPLE_RATE = 16_000;

/** 低通滤波器的长度。越长越陡，也越慢：97 个系数时一分钟的录音约 60 毫秒（实测） */
const TAPS = 97;
/** 截止频率占目标采样率的比例：降到 16 kHz 时在 7.2 kHz，留一点余量给过渡带，说话的声音基本在 4 kHz 以下 */
const CUTOFF_RATIO = 0.45;

/** 多声道取平均合成一个声道。录音本来就是单声道的，原样返回 */
export function mixDown(channels) {
  if (channels.length === 1) return channels[0];
  const mixed = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < mixed.length; i++) mixed[i] += channel[i] / channels.length;
  }
  return mixed;
}

/** 加了 Blackman 窗的 sinc 低通，系数之和为 1（低频增益不变）。cutoff 是相对于输入采样率的频率 */
function lowPass(cutoff) {
  const middle = (TAPS - 1) / 2;
  const kernel = new Float64Array(TAPS);
  let sum = 0;
  for (let i = 0; i < TAPS; i++) {
    const x = i - middle;
    const sinc = x === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * x) / (Math.PI * x);
    const window =
      0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (TAPS - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (TAPS - 1));
    kernel[i] = sinc * window;
    sum += kernel[i];
  }
  return kernel.map((value) => value / sum);
}

/**
 * 降采样到 to。只做整数倍（Opus 解出来总是 48 kHz，降到 16 kHz 是 3 倍）：
 * 先低通把新采样率表示不了的高频滤掉，否则它们会折回来变成说话频段里的杂音，再每几个取一个。
 * @param {Float32Array} samples
 */
export function downsample(samples, from, to) {
  if (from === to) return samples;
  const factor = from / to;
  if (!Number.isInteger(factor)) throw new Error(`只能从 ${to} Hz 的整数倍降下来，这段录音是 ${from} Hz`);
  const kernel = lowPass((CUTOFF_RATIO * to) / from);
  const middle = (TAPS - 1) / 2;
  const output = new Float32Array(Math.ceil(samples.length / factor));
  for (let o = 0; o < output.length; o++) {
    const start = o * factor - middle;
    let sum = 0;
    for (let k = Math.max(0, -start); k < TAPS && start + k < samples.length; k++) {
      sum += kernel[k] * samples[start + k];
    }
    output[o] = sum;
  }
  return output;
}

/** 单声道 16 位小端 PCM 的 WAV 文件 */
export function encodeWav(samples, sampleRate) {
  const dataBytes = samples.length * 2;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16); // fmt 块的长度
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(1, 22); // 单声道
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28); // 每秒字节数
  wav.writeUInt16LE(2, 32); // 每个样本的字节数
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < samples.length; i++) {
    // 超出 ±1 的截到边上：直接换算会溢出，绕成相反符号的爆音
    const value = Math.max(-1, Math.min(1, samples[i]));
    wav.writeInt16LE(Math.round(value < 0 ? value * 0x8000 : value * 0x7fff), 44 + i * 2);
  }
  return wav;
}

/**
 * encodeWav 写出的那种 WAV（单声道、16 位 PCM、44 字节的头）→ 样本。评测把录音洗成这一种存盘，再读回来交给各个模型；
 * 别的写法（立体声、浮点、多出几个块）不去猜，直接报错，免得不同来源的录音悄悄走了不同的路。
 * @param {Buffer} wav
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
/**
 * WAV 有多长（秒）。比 decodeWav 轻：只读头，不解码一遍样本——它要用的场合是按录音长度
 * 决定请求参数（见 providers/qwen.mjs 的思考预算），不需要拿到声音本身。
 * 不是认识的 WAV 时返回 null，由调用方决定退而求其次用什么值。
 *
 * 按 chunk 走一遍，不假设头正好 44 字节：`fmt ` 块可能是 16 也可能是 18 字节（Windows 的
 * 语音合成就是 18），那时 `data` 会落在 offset 38 而不是 44。开头按标准 44 字节读的话，
 * 12 秒的录音会被算成 7656 秒（实测踩过）。
 * @param {Buffer} wav
 * @returns {number | null}
 */
export function wavSeconds(wav) {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }
  let format = null;
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString("ascii", at, at + 4);
    const size = wav.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      if (body + 16 > wav.length) return null;
      format = {
        channels: wav.readUInt16LE(body + 2),
        sampleRate: wav.readUInt32LE(body + 4),
        bitsPerSample: wav.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      if (!format) return null;
      const bytesPerSecond = format.sampleRate * format.channels * (format.bitsPerSample / 8);
      if (!bytesPerSecond) return null;
      return size / bytesPerSecond;
    }
    // 块按 2 字节对齐：奇数大小后面有一个填充字节
    at = body + size + (size % 2);
  }
  return null;
}

export function decodeWav(wav) {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 16) !== "WAVEfmt ") {
    throw new Error("不是 WAV 文件");
  }
  if (wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(34) !== 16) throw new Error("只认 16 位 PCM 的 WAV");
  if (wav.readUInt16LE(22) !== 1) throw new Error(`只认单声道的 WAV，这个有 ${wav.readUInt16LE(22)} 个声道`);
  const dataBytes = wav.readUInt32LE(40);
  if (wav.toString("ascii", 36, 40) !== "data" || wav.length !== 44 + dataBytes) {
    throw new Error(`WAV 的长度对不上：头里写着 ${dataBytes} 字节的声音，文件有 ${wav.length - 44} 字节`);
  }
  const samples = new Float32Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i++) {
    const value = wav.readInt16LE(44 + i * 2);
    samples[i] = value < 0 ? value / 0x8000 : value / 0x7fff;
  }
  return { samples, sampleRate: wav.readUInt32LE(24) };
}
