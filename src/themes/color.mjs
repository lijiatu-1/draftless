// 主题里的颜色一律写成 oklch(亮度 彩度 色相)。这里把它换算成屏幕上的 sRGB，三处用得上：
// 算对比度（把关每套主题读不读得清）、在终端里画出颜色、给窗口一个页面还没画出来时的底色。
// 只认不透明的颜色：半透明的叠在什么上面不一定，对比度没法算。

const OKLCH = /^oklch\(\s*(\d*\.?\d+)\s+(\d*\.?\d+)\s+(\d*\.?\d+)\s*\)$/;

function parse(value) {
  const match = typeof value === "string" ? OKLCH.exec(value) : null;
  const [lightness, chroma, hue] = match ? match.slice(1).map(Number) : [];
  if (!match || lightness > 1) {
    throw new Error(`颜色要写成 oklch(亮度 彩度 色相)，亮度在 0 到 1 之间，现在是 ${JSON.stringify(value)}`);
  }
  return { lightness, chroma, hue };
}

/** 线性的 sRGB 三个分量。超出屏幕显示得了的范围时截到边上 */
function linearSrgb(value) {
  const { lightness, chroma, hue } = parse(value);
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  // Oklab 的定义（Björn Ottosson）：先到三种视锥细胞的响应，再到线性 sRGB
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((channel) => Math.min(1, Math.max(0, channel)));
}

/** @returns {[number, number, number]} 红绿蓝，各 0–255 */
export function toRgb(value) {
  return linearSrgb(value).map((channel) =>
    Math.round(255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055)),
  );
}

/** @returns {string} 形如 #1a2b3c */
export function toHex(value) {
  return `#${toRgb(value)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

/** 两个颜色之间的对比度，1（一样）到 21（黑和白）。算法是 WCAG 2 的 */
export function contrast(one, other) {
  const luminance = (value) => {
    const [red, green, blue] = linearSrgb(value);
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [darker, lighter] = [luminance(one), luminance(other)].sort((x, y) => x - y);
  return (lighter + 0.05) / (darker + 0.05);
}
