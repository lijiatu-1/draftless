// 悬浮条的画面：告诉它现在该是什么样子，它把样子画出来、让条出现和消失、把音量画成声波。
// 该是什么样子由 bar-view.mjs 算，这里只管画。它不知道录音和网络的事，也不直接找主进程：
// 要宿主代办的两件事由调用方给。以后换一个壳时，这个文件和 bar.css 不用动，换掉那两个函数就行。

import { controlsIn, hintFor, LINGER_MS, View } from "./bar-view.mjs";
import { createWave, REST, WAVE_BARS } from "./wave.mjs";

/** 整理中那道波有几根竖条 */
const THINK_BARS = 11;
/** 条淡出去要多久。和 bar.css 里 data-shown="false" 的过渡一样长 */
const FADE_OUT_MS = 200;
/** 按钮点得到的范围比看到的圆大一圈，正好撑满条的高度 */
const HIT_SLOP = 6;
/** 系统开了"减弱动态效果"时，声波隔这么久才画一次 */
const REDUCED_MOTION_MS = 200;

/**
 * @param {object} options
 * @param {Document} options.document 悬浮条的页面（bar.html）
 * @param {object} options.host 要宿主代办的事
 * @param {(visible: boolean) => void} options.host.setVisible 把悬浮条的窗口显示出来 / 收起来
 * @param {(regions: object[] | null) => void} options.host.capture 开始截 esc 和这几块里的点击
 *   （{ id, x, y, width, height }，窗口里的位置）；null 是不截了
 * @param {string} options.keycap 热键的短名字，写在提示里
 * @param {Function} options.t 界面语言的翻译函数（src/i18n），提示按它写
 */
export function createBarUi({ document, host, keycap: initialKeycap, t: initialT }) {
  /** 在设置里改了热键时跟着换 */
  let keycap = initialKeycap;
  /** 在设置里换了语言时跟着换 */
  let t = initialT;
  const { body } = document;
  const hint = document.getElementById("hint");
  const message = document.getElementById("message");
  const buttons = { cancel: document.getElementById("cancel"), confirm: document.getElementById("confirm") };
  const window = document.defaultView;
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  const makeBars = (id, count) => {
    const bars = Array.from({ length: count }, () => document.createElement("i"));
    document.getElementById(id).replaceChildren(...bars);
    return bars;
  };
  const waveBars = makeBars("wave", WAVE_BARS);
  // 每根竖条错开一点起步，连起来才是一道滚过去的波
  for (const [index, bar] of makeBars("think", THINK_BARS).entries()) bar.style.setProperty("--i", index);

  /** 现在画着的样子。条收起来之后是 hidden */
  let view = View.HIDDEN;
  /** 两个按钮点不点得动 */
  let controls = false;
  const wave = createWave({ bars: WAVE_BARS });
  /** 正在听时每帧画一次声波；不在听是 null */
  let waveFrame = null;
  /** 上一次画声波的时间 */
  let drawnAt = -Infinity;
  /** 让宿主截着的那几块，写成一行文字方便比较；没在截是 null */
  let captured = null;
  /** 到时间把条收起来的定时器 */
  let hideTimer = null;
  /** 录音最后 1 分钟剩下的秒数；不在倒计时里是 null */
  let secondsLeft = null;

  function drawWave(heights) {
    for (const [index, bar] of waveBars.entries()) bar.style.setProperty("--h", heights[index].toFixed(3));
  }

  function animateWave(now) {
    const heights = wave.frame(now);
    // 减弱动态效果时声波还是要动（它在告诉人"听到你了"），只是画得慢
    if (!reducedMotion.matches || now - drawnAt >= REDUCED_MOTION_MS) {
      drawWave(heights);
      drawnAt = now;
    }
    waveFrame = window.requestAnimationFrame(animateWave);
  }

  /** 进了"正在听"从伏着开始一帧一帧画；出来就停下、全部伏着。收起来的时候只停下，照着停下时的样子淡出去 */
  function syncWave() {
    if (view === View.RECORDING) {
      if (waveFrame === null) {
        wave.reset();
        waveFrame = window.requestAnimationFrame(animateWave);
      }
      return;
    }
    if (waveFrame !== null) window.cancelAnimationFrame(waveFrame);
    waveFrame = null;
    if (view !== View.HIDDEN) drawWave(Array(WAVE_BARS).fill(REST));
  }

  function drawHint() {
    const parts = hintFor(view, { keycap, cancellable: controls, secondsLeft }, t);
    hint.replaceChildren(
      ...parts.map((part) =>
        typeof part === "string" ? part : Object.assign(document.createElement("kbd"), { textContent: part.key }),
      ),
    );
  }

  /** 一个按钮在窗口里的位置。按排版算，不看正在进行的动画：条出现时是从下面浮上来的，量那一刻的位置会偏 */
  function regionOf(id) {
    const button = buttons[id];
    let x = -HIT_SLOP;
    let y = -HIT_SLOP;
    for (let node = button; node !== null; node = node.offsetParent) {
      x += node.offsetLeft;
      y += node.offsetTop;
    }
    return { id, x, y, width: button.offsetWidth + 2 * HIT_SLOP, height: button.offsetHeight + 2 * HIT_SLOP };
  }

  /** 这个样子下该截什么就让宿主截什么。和上一次一样就不重复说 */
  function syncCapture() {
    const ids = controls ? controlsIn(view) : [];
    const regions = ids.length > 0 ? ids.map(regionOf) : null;
    const next = regions && JSON.stringify(regions);
    if (next === captured) return;
    captured = next;
    host.capture(regions);
  }

  function hide() {
    view = View.HIDDEN;
    syncCapture();
    syncWave();
    // 样子先不换：照着现在的样子淡出去，淡完再把窗口收起来
    body.dataset.shown = "false";
    hideTimer = setTimeout(() => {
      host.setVisible(false);
      body.dataset.view = View.HIDDEN;
    }, FADE_OUT_MS);
  }

  return {
    /**
     * 换成这种样子。
     * @param {string} next bar-view.mjs 的 View 之一
     * @param {string | null} text 提示或者出错时的那句话
     */
    show(next, text = null) {
      // 还是这个样子、这句话：不重画，免得把正在放的动画和"过几秒收起来"的定时器重新开始
      if (next === view && (text ?? "") === message.textContent) return;
      clearTimeout(hideTimer);
      if (next === View.HIDDEN) {
        hide();
        return;
      }
      view = next;
      body.dataset.view = next;
      message.textContent = text ?? "";
      drawHint();
      syncWave();
      if (body.dataset.shown !== "true") {
        host.setVisible(true);
        body.dataset.shown = "true";
      }
      // 排版定了才量得出按钮在哪
      syncCapture();
      if (LINGER_MS[next] !== undefined) hideTimer = setTimeout(hide, LINGER_MS[next]);
    },

    /** 录音剩下的秒数（最后 1 分钟每秒一次）；null 是不在倒计时 */
    setCountdown(seconds) {
      if (seconds === secondsLeft) return;
      secondsLeft = seconds;
      // show() 在"同样子、同一句话"时不重画，而倒计时只改提示行，所以这里自己画
      if (view === View.RECORDING) drawHint();
    },

    /** 正在听时的一个瞬时音量（0–1） */
    level(value) {
      if (view !== View.RECORDING) return;
      wave.hear(value, window.performance.now());
    },

    /** 两个按钮点不点得动、esc 截不截得住（要点击拦截那把钩子）。点不动时不画按钮，提示里也不提 esc */
    setControls(enabled) {
      controls = enabled;
      body.dataset.controls = String(enabled);
      if (view !== View.HIDDEN) drawHint();
      syncCapture();
    },

    /** 热键换了：提示里写新的那个 */
    setKeycap(next) {
      keycap = next;
      if (view !== View.HIDDEN) drawHint();
    },

    /**
     * 语言换了：提示按新的语言写，正在显示的那句话换成 text（调用方按新的语言翻好的）。
     * 不走 show：样子没变，不该把动画和"过几秒收起来"重新开始
     */
    setTranslator(next, text = null) {
      t = next;
      if (view === View.HIDDEN) return;
      message.textContent = text ?? "";
      drawHint();
    },
  };
}
