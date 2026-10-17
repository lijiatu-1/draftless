import assert from "node:assert/strict";
import { test } from "node:test";

import { createWave, REST, WAVE_BARS } from "../../../src/renderer/bar/wave.mjs";

/** 固定种子的随机数：每次跑出来一样，又不是一个常数 */
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 随机数一直是正中间：不抖、不偏、该起的波都起，看得出形状 */
const steady = () => 0.5;

const FRAME_MS = 16;
const CENTER = Math.floor(WAVE_BARS / 2);

/**
 * 照页面的节奏跑一段：每 50 ms 听一个音量，每帧画一次。
 * @returns {number[][]} 每一帧的各根高度
 */
function play(wave, levels, { from = 0, until = from + levels.length * 50 } = {}) {
  const frames = [];
  for (let now = from; now < until; now += FRAME_MS) {
    const tick = Math.floor((now - from) / 50);
    if (tick < levels.length && (now - from) % 50 < FRAME_MS) wave.hear(levels[tick], now);
    frames.push(wave.frame(now));
  }
  return frames;
}

test("竖条数是单数：正中间有一根，波从那里起", () => {
  assert.equal(WAVE_BARS % 2, 1);
  assert.equal(createWave({ bars: WAVE_BARS }).frame(0).length, WAVE_BARS);
});

test("没声音、只有底噪的时候，竖条都伏着不动", () => {
  // 真实录音里停顿是最低的那一格（1/128），偶尔两格
  const wave = createWave({ bars: WAVE_BARS, random: seeded(1) });
  for (const heights of play(
    wave,
    Array.from({ length: 40 }, (_, i) => [0, 1 / 128, 2 / 128][i % 3]),
  )) {
    assert.deepEqual(heights, Array(WAVE_BARS).fill(REST));
  }
});

test("一个字：中间那根先起来，再一根接一根传到两边，中间高、两边低", () => {
  const wave = createWave({ bars: WAVE_BARS, random: steady });
  wave.hear(0.1, 1000);
  const first = wave.frame(1000);
  assert.ok(first[CENTER] > 0.8, String(first[CENTER]));
  assert.equal(first[0], REST);
  assert.equal(first[WAVE_BARS - 1], REST);

  const spread = wave.frame(1150);
  for (const height of spread) assert.ok(height > REST, spread.join());
  for (let i = 0; i < CENTER; i++) {
    assert.ok(spread[i] < spread[i + 1], `左边第 ${i} 根该比里面一根矮：${spread.join()}`);
    assert.ok(spread[WAVE_BARS - 1 - i] < spread[WAVE_BARS - 2 - i], `右边第 ${i} 根该比里面一根矮：${spread.join()}`);
  }
  assert.ok(spread[0] < spread[CENTER] * 0.6, spread.join());
});

test("说完就落回去：一秒半之后全部伏着", () => {
  const wave = createWave({ bars: WAVE_BARS, random: seeded(2) });
  const frames = play(wave, [0.1, 0.15, 0.08], { from: 1000, until: 1000 + 150 + 1500 });
  assert.ok(frames[10].some((height) => height > 0.5));
  assert.deepEqual(frames.at(-1), Array(WAVE_BARS).fill(REST));
});

test("轻声说话也起得来一大半，响的字明显更高；两格以下不起波", () => {
  const peakOf = (level) => {
    const wave = createWave({ bars: WAVE_BARS, random: steady });
    wave.hear(level, 0);
    return wave.frame(0)[CENTER];
  };
  // 真实录音里说话的音量：轻的 3 格，一般 8 到 20 格
  assert.ok(peakOf(3 / 128) > 0.5, String(peakOf(3 / 128)));
  assert.ok(peakOf(16 / 128) - peakOf(3 / 128) > 0.2, `${peakOf(16 / 128)} ${peakOf(3 / 128)}`);
  assert.ok(peakOf(1) <= 1);
  assert.equal(peakOf(2 / 128), REST);
});

test("说话的时候一直在跳：中间那根几乎每帧都在变，起落明显，两边比中间矮", () => {
  // 一段真实录音里说话的 3 秒（每 50 ms 一个音量，单位是 1/128）
  const speech = [
    28, 80, 62, 50, 51, 51, 29, 10, 3, 3, 20, 34, 33, 13, 22, 17, 6, 5, 20, 20, 17, 17, 17, 5, 3, 12, 26, 18, 2, 1, 1,
    1, 1, 12, 18, 6, 3, 3, 16, 24, 14, 4, 3, 13, 14, 13, 17, 20, 14, 1, 1, 2, 17, 23, 23, 4, 1, 3, 18, 14,
  ].map((step) => step / 128);
  const frames = play(createWave({ bars: WAVE_BARS, random: seeded(3) }), speech);
  const center = frames.map((heights) => heights[CENTER]);
  const edges = frames.map((heights) => (heights[0] + heights[WAVE_BARS - 1]) / 2);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

  const moving = center.slice(1).filter((height, i) => Math.abs(height - center[i]) > 0.005).length;
  assert.ok(moving / (center.length - 1) > 0.8, `变了的帧只有 ${moving}/${center.length - 1}`);
  assert.ok(Math.max(...center) - Math.min(...center) > 0.3, `起落 ${Math.min(...center)}–${Math.max(...center)}`);
  assert.ok(mean(center) > 0.5, `中间平均 ${mean(center)}`);
  assert.ok(mean(edges) < mean(center) * 0.6, `两边平均 ${mean(edges)}，中间 ${mean(center)}`);
});

test("不管来什么音量，高度都在伏着和满格之间", () => {
  const random = seeded(4);
  const wave = createWave({ bars: WAVE_BARS, random: seeded(5) });
  const levels = Array.from({ length: 400 }, () => random() ** 2 * 1.5);
  for (const heights of play(wave, levels)) {
    for (const height of heights) assert.ok(height >= REST && height <= 1, String(height));
  }
});

test("重置之后全部伏着，还没传到的波也不再传", () => {
  const wave = createWave({ bars: WAVE_BARS, random: steady });
  wave.hear(0.2, 0);
  wave.frame(0);
  wave.reset();
  assert.deepEqual(wave.frame(16), Array(WAVE_BARS).fill(REST));
  assert.deepEqual(wave.frame(200), Array(WAVE_BARS).fill(REST));
});
