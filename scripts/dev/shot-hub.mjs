// 把应用的主窗口渲染出来截一张图：落地页需要"它自己的界面"当素材。
// 检查器说得很清楚——软件的照片就是它自己的界面，不是找来的建筑照。

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow } from "electron";

const OUT = join(import.meta.dirname, "..", "..", "docs", "assets");
mkdirSync(OUT, { recursive: true });

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: 1120,
      height: 760,
      show: false,
      backgroundColor: "#f7f4ed",
      webPreferences: {
        preload: join(import.meta.dirname, "..", "..", "src", "renderer", "shared", "preload.cjs"),
        sandbox: false,
      },
    });
    await win.loadFile(join(import.meta.dirname, "..", "..", "src", "renderer", "hub", "hub.html"));
    await new Promise((r) => setTimeout(r, 3000));
    const image = await win.capturePage();
    const size = image.getSize();
    writeFileSync(join(OUT, "hub.png"), image.toPNG());
    console.log("截好了: docs/assets/hub.png " + size.width + "x" + size.height);
    app.exit(0);
  } catch (error) {
    console.log("失败：" + error.message);
    app.exit(1);
  }
});
