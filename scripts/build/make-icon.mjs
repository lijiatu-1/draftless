import { writeFileSync } from "node:fs";
import { join } from "node:path";
import pngToIco from "png-to-ico";
import sharp from "sharp";

// 从 assets 里的两个 svg 生成 Windows 要用的图标：icon.svg → app.ico（应用图标），tray.svg → tray.ico（托盘）。
//
// 这一层的职责：那边用 rsvg-convert 和 iconutil 做 .icns
// 和 trayTemplate.png；Windows 上要的是 .ico——一个文件里放好几种尺寸，系统按需要挑
// （任务栏、开始菜单、文件列表、Alt+Tab 要的各不一样大）。
//
// 托盘图标和 macOS 那份不一样：macOS 的 Template 图片系统会替我们反色（浅色菜单栏上变黑、深色上变白），
// Windows 不会。所以这里给托盘图标垫一块深色圆角底，白的那几道压在深色上，
// 浅色任务栏上是有底的深色方块、深色任务栏上是白线——两边都看得见。
//
// 改了图标才需要跑：`npm run icons`。生成的文件是提交进仓库的。

const packageDir = join(import.meta.dirname, "..", "..");

/** 应用图标要放的几种尺寸。Windows 上 256 是最常用的一档，列表视图还会用到 16、32 */
const APP_SIZES = [16, 24, 32, 48, 64, 128, 256];
/** 托盘图标：16 是标准尺寸，200% 缩放的任务栏用 32 */
const TRAY_SIZES = [16, 20, 24, 32];
/** 先按这个边渲染，再缩到要的尺寸：svg 是矢量的，中间这个值只影响清晰度，不影响最终大小 */
const MASTER = 512;

/**
 * 一个 svg 渲染成几种尺寸的 png 缓冲区。
 * @param {string} svgFile
 * @param {number[]} sizes
 * @param {{ background?: { r: number, g: number, b: number, alpha: number } }} [options]
 */
async function render(svgFile, sizes, { background } = {}) {
  const master = await sharp(svgFile, { density: 288 })
    .resize(MASTER, MASTER, { fit: "contain", background: background ?? { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
  const pngs = [];
  for (const size of sizes) {
    pngs.push(
      await sharp(master)
        .resize(size, size, { fit: "contain", background: background ?? { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer(),
    );
  }
  return pngs;
}

writeFileSync(
  join(packageDir, "assets", "app.ico"),
  await pngToIco(await render(join(packageDir, "assets", "icon.svg"), APP_SIZES)),
);

// 托盘：tray.svg 只有那五道声波、没有底色。垫一块近黑的底，浅色任务栏上看得清；
// 托盘图标本来就小，不加圆角，16 像素上的圆角只会把笔画吃掉
const trayBackground = { r: 26, g: 28, b: 32, alpha: 1 };
const trayPngs = await render(join(packageDir, "assets", "tray.svg"), TRAY_SIZES, { background: trayBackground });
writeFileSync(join(packageDir, "assets", "tray.ico"), await pngToIco(trayPngs));

console.log(`生成了 assets/app.ico（${APP_SIZES.join("/")}）和 assets/tray.ico（${TRAY_SIZES.join("/")}）`);
