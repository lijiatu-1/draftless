// 在终端里问一把 key：输入不回显，所以它不会留在屏幕上，也不会进 shell 的历史记录。

/** 用户按 Ctrl-C 放弃了输入 */
export class Cancelled extends Error {
  constructor() {
    super("已取消");
    this.name = "Cancelled";
  }
}

async function readAll(input) {
  let text = "";
  input.setEncoding("utf8");
  for await (const chunk of input) text += chunk;
  return text.trim();
}

/**
 * @param {string} prompt 提示语，写到 output
 * @param {object} [streams]
 * @param {import("node:stream").Readable & { isTTY?: boolean, setRawMode?: Function }} [streams.input]
 *   是终端时逐键读、不回显；不是终端（管道喂进来）时读到结束
 * @param {import("node:stream").Writable} [streams.output] 默认标准错误，这样标准输出可以照常被重定向
 * @returns {Promise<string>} 去掉首尾空白之后的输入
 * @throws {Cancelled}
 */
export function askSecret(prompt, { input = process.stdin, output = process.stderr } = {}) {
  if (!input.isTTY) return readAll(input);

  return new Promise((resolve, reject) => {
    let value = "";
    /** 正在跳过一个转义序列（方向键之类），直到遇到结束它的那个字母 */
    let escaping = false;

    const finish = (settle, result) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      settle(result);
    };

    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (escaping) {
          if (/[A-Za-z~]/.test(char)) escaping = false;
        } else if (char === "\r" || char === "\n") {
          finish(resolve, value.trim());
          return;
        } else if (char === "\u0003") {
          finish(reject, new Cancelled());
          return;
        } else if (char === "\u001b") {
          escaping = true;
        } else if (char === "\u007f" || char === "\b") {
          value = value.slice(0, -1);
        } else if (char >= " ") {
          value += char;
        }
      }
    };

    // 先关掉回显再给提示：手快的人（或者粘贴得快）在提示出来的同时就开始输入了
    input.setRawMode(true);
    output.write(prompt);
    input.resume();
    input.on("data", onData);
  });
}
