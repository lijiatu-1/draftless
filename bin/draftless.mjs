#!/usr/bin/env node
// draftless 命令的入口。这里只做几件必须抢在加载其余代码之前的事，命令本身在 src/cli/main.mjs。
import { nodeVersionProblem } from "../src/cli/node-version.mjs";

// 先查 Node 的版本：其余的代码（连同文案那一层）都可能用到旧版本没有的写法
const versionProblem = nodeVersionProblem(process.versions.node);
if (versionProblem) {
  console.error(await inTerminalLanguage(versionProblem));
  process.exit(1);
}

// 这句说在读设置之前，按终端的语言说。这份代码只用 Windows 的原生接口（热键钩子、DPAPI、命名管道），
// 换到别的系统上没有一个功能是原地就能跑的，不如在入口处用一句话说清楚，别让它带着半个能用的样子起来
const { createTranslator, localesFromEnv, matchLocale } = await import("../src/i18n/index.mjs");
if (process.platform !== "win32") {
  console.error(createTranslator(matchLocale(localesFromEnv(process.env)))("cli.winOnly"));
  process.exit(1);
}

// 历史库用的是 Node 自带的 SQLite。在 Node 22 和 24 里它还标着"实验性"，每跑一次命令都会往终端上
// 打一句警告。只滤掉这一句，别的警告照常显示
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning?.message ?? warning).includes("SQLite")) return;
  emitWarning.call(process, warning, ...rest);
};

// 输出接到 head 这类程序上时，那头读够了就把管道关掉，这边再写会报 EPIPE。这是正常结束，不是出错
for (const stream of [process.stdout, process.stderr]) {
  stream.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
}

const { main } = await import("../src/cli/main.mjs");
process.exitCode = await main(process.argv.slice(2));

/**
 * Node 版本不够时的那句话，按终端的语言说。文案那一层用到较新的 Node 才有的写法（replaceAll、Object.hasOwn），
 * 太旧的 Node 上它加载不了或者翻不出来：那就用英文说，原因还是这一句，不是那一层的调用栈
 */
async function inTerminalLanguage(problem) {
  try {
    const { createTranslator, localesFromEnv, matchLocale } = await import("../src/i18n/index.mjs");
    return createTranslator(matchLocale(localesFromEnv(process.env))).text(problem);
  } catch {
    return problem.english;
  }
}
