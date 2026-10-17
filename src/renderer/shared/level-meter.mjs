// 麦克风和它的瞬时音量：悬浮条录音、首次引导里测麦克风，用的是这一份，测的就是录的那一路声音。
// 判断标准和原版一样（targets/typeless/docs/11-audio-recorder.md）：8 位波形只要偏离中点 1 格就算有信号。
// 它不是在判断有没有人说话，只是"麦克风有没有声音进来"。

/**
 * 打开麦克风。参数照原版（docs/11-audio-recorder.md）：单声道，回声消除、降噪、自动增益全部关掉，
 * 把未加工的声音交给模型
 */
export const openMicrophone = () =>
  navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

/** 每隔这么久报一次音量 */
const LEVEL_INTERVAL_MS = 50;

/**
 * @param {MediaStream} stream 麦克风
 * @param {(level: number) => void} onLevel 0–1 的瞬时音量，每 50 ms 一次
 * @returns {{ hadSignal: () => boolean, stop: () => void }} hadSignal：到现在为止有没有过信号
 */
export function meterLevels(stream, onLevel) {
  const audioContext = new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  audioContext.createMediaStreamSource(stream).connect(analyser);
  const waveform = new Uint8Array(analyser.fftSize);
  let peak = 0;
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(waveform);
    let deviation = 0;
    for (const sample of waveform) deviation = Math.max(deviation, Math.abs(sample - 128));
    peak = Math.max(peak, deviation);
    onLevel(deviation / 128);
  }, LEVEL_INTERVAL_MS);

  return {
    hadSignal: () => peak >= 1,
    stop() {
      clearInterval(timer);
      audioContext.close().catch((error) => console.warn("关闭 AudioContext 失败", error));
    },
  };
}
