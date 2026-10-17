import { existsSync, rmSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { msg } from "../../i18n/index.mjs";
import { noPositionals, parse, UsageError } from "../common.mjs";

// draftless uninstall：停掉后台，把 Draftless 的目录整个删掉；目录以外删不了的照实列出来。
//
// 和原版的差别：
// - 那边要照着一张清单删掉自己建在 PATH 里的符号链接，还要删钥匙串里那一条；
//   Windows 上命令行是装着的那份程序里带的（或者 npm 包自己的 .cmd 壳），钥匙串那一条不存在，
//   所以这两件事都没有了，`--keep-data` 也就只剩"删程序、留数据"这一种意思
// - 删完目录之后，Windows 这边还可能留下一个开始菜单快捷方式和 PATH 里的一条记录，
//   那是安装脚本建的，照实提醒用户去哪儿删

export async function uninstall(args, io) {
  const { values, positionals } = parse(args, {
    "keep-data": { type: "boolean", default: false },
    yes: { type: "boolean", short: "y", default: false },
  });
  noPositionals(positionals, "uninstall");
  const { paths, t } = io;
  const keepData = values["keep-data"];
  const named = { home: paths.home, yours: t("cli.uninstall.yours") };

  if (!values.yes) {
    if (!io.interactive) throw new UsageError(msg("cli.uninstall.needsConfirm"));
    io.out(t(keepData ? "cli.uninstall.planKeep" : "cli.uninstall.planAll", named));
    if (!(await io.confirm(t("cli.uninstall.confirm")))) {
      io.out(t("cli.uninstall.aborted"));
      return 1;
    }
  }

  // 它还开着那些文件。停不掉就不往下删，错误照直报出去
  await io.daemon.stop();

  const removed = [];
  const leftovers = [];

  if (keepData) {
    // 留着数据：只删程序、运行环境、日志、缓存和命令行的入口，
    // settings.json / key / 历史 / 录音 / 模型都留下
    // （运行环境和命令入口在 <家目录>\runtime 和 <家目录>\bin，install.ps1 建的；paths 里没有单独一项）
    const owned = [
      join(paths.home, "app"),
      join(paths.home, "runtime"),
      join(paths.home, "bin"),
      dirname(paths.logFile),
      paths.cacheDir,
    ];
    for (const dir of owned) {
      if (!existsSync(dir)) continue;
      rmSync(dir, { recursive: true, force: true });
    }
    removed.push(t("cli.uninstall.removedKeep", named));
  } else {
    rmSync(paths.home, { recursive: true, force: true });
    removed.push(t("cli.uninstall.removedAll", named));
  }

  io.out(t("cli.uninstall.done"));
  for (const item of removed) io.out(`  ${t("cli.uninstall.removed", { item })}`);
  if (keepData) io.out(`  ${t("cli.uninstall.kept", named)}`);
  // 删不了、或者不该由我们删的，照实列出来
  leftovers.push(t("cli.uninstall.permissions"));
  // 从源码目录运行的那种，程序不在我们的目录里
  if (!io.packageDir.startsWith(paths.home + sep)) leftovers.push(t("cli.uninstall.sourceDir", { dir: io.packageDir }));
  io.out(`  ${t("cli.uninstall.leftovers")}`);
  for (const item of leftovers) io.out(`    · ${item}`);
  return 0;
}
