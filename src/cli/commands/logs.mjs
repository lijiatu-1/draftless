import { existsSync } from "node:fs";
import { noPositionals, parse, positiveInteger } from "../common.mjs";

// draftless logs：看后台应用的日志。

const DEFAULT_LOG_LINES = 40;

export async function logs(args, io) {
  const { values, positionals } = parse(args, {
    lines: { type: "string", short: "n", default: String(DEFAULT_LOG_LINES) },
    follow: { type: "boolean", short: "f", default: false },
  });
  noPositionals(positionals, "logs");
  const lines = positiveInteger(values.lines, "-n");
  if (!existsSync(io.paths.logFile)) {
    io.out(io.t("cli.logs.none", { file: io.paths.logFile }));
    return 0;
  }
  return io.tail(["-n", String(lines), ...(values.follow ? ["-f"] : []), io.paths.logFile]);
}
