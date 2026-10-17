# 11 录音与编码

录音在悬浮条渲染进程里做，编码在主进程的 worker 线程里做。静态阅读的结论；重采样和分块的内部实现没有逐行读。

## 采集

| 项 | 值 | 位置 |
| --- | --- | --- |
| 取流 | `navigator.mediaDevices.getUserMedia({ audio: … })` | readable:UfR9-a2Z.js:14500 |
| 麦克风约束 | `sampleSize: 16`，**回声消除、降噪、自动增益全部关闭** | 14360-14364 |
| AudioContext 采样率 | 16000 Hz | 11848、14367 |
| 取样方式 | `AudioWorkletNode("typeless-audio-capture")` | 11877 |
| worklet 每次上交 | 1024 个采样（16 kHz 下是 64 ms） | `renderer/static/js/C7lI2ZxR.js` |

关掉浏览器自带的三项处理，交给服务端的是未加工的原始声音。推断原因是识别模型自己处理噪声更好，前端处理反而会损伤信号。

worklet 那个文件（3 KB）是全包里少数没被混淆的应用代码，类名 `TypelessAudioCaptureProcessor` 原样可见。

开始录音时还做两件事（14506-14514）：延时后播放提示音；如果开了"录音时静音背景音"，调 `libUtilHelper.muteAudio` 把系统输出静音，结束后恢复。

## 编码

录音器配置（readable:UfR9-a2Z.js:14370-14379）：

```
numberOfChannels:    1
encoderSampleRate:   48000
encoderBitRate:      32000
encoderFrameSize:    20        // 毫秒
maxFramesPerPage:    10        // 每个 Ogg 页最多 10 帧，即 200 ms
encoderApplication:  2049      // Opus 的 OPUS_APPLICATION_AUDIO
bufferLength:        4096
wavBitDepth:         16
```

分块编码会话（readable:main/worker/chunkSessionWorker.js:12-14、113、133）：

```
libopuschunk_session_create(sampleRate, channels, 32000, 1)
libopuschunk_session_set_complexity(session, 9)
```

第三个参数是码率。第四个参数的含义没有确认，结合元数据里的 `audio_variable_bitrate: true`，推断是可变码率开关。复杂度 9 是偏高的档位（范围 0–10），用更多计算换同码率下更好的音质。

每 3 秒的一块编码后作为一个二进制 WebSocket 帧发出，前面跟一条 `set_audio_chunk_info`。`need_merge: true` 表明各块是可拼接的片段，服务端拼成完整音频。

整段编码（HTTP 兜底用）走另一个库 `libopusenc` 的 `opus_convert_advanced`。本机最新一条记录里整段压缩用了约 600 ms。

## "无声"检测

`recording_active` 进入 1 秒后启动（readable:qA149QP2.mjs:4365-4440）：

- 每 100 ms 用 `AnalyserNode.getByteTimeDomainData` 取一帧波形。
- 只要有一个采样偏离中点（128）达到 1，就算"有声音"。
- 在规定时长内一直没有，就以"未检测到语音"结束本次录音。

阈值是 1（8 位量化的最小一格），所以它检测的不是"有没有人说话"，而是"麦克风是不是完全没信号"——设备被静音、被别的程序占用、选错了输入设备这类情况。它不是语音活动检测，说话中间的停顿不会触发它。

## 设备选择

- 麦克风列表和选中项存在 `app-settings.json`。
- `libUtilHelper.deviceIsLidOpen` 查合盖状态，合盖时内置麦克风不可用。
- 设置里有 `dynamicMicrophoneDegradationEnabled` 和 `preferredBuiltInMicId`，名字上看是"当前麦克风不行时自动换到内置麦克风"，实现没有读。

## 给仿写的备忘

- 16 kHz 单声道、关闭全部前端处理、Opus 32 kbps：这组参数可以直接照搬。
- 分块上传的价值在于把上传时间摊到说话过程里。块长 3 秒是它的选择；块越短首包越早，但帧数越多。
- 浏览器环境里可以直接用 `MediaRecorder` 出 Opus，不必自己带编码库。它自带编码库的原因推断是要精确控制分块边界和拼接。
