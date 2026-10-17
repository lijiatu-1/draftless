import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DEFAULT_SOURCE, downloadSize, downloadUrls } from "./catalog.mjs";

// 模型仓：把配置表（catalog.mjs）里的模型下载到本机、校验、列出、删除。App、命令行、评测用的都是它。
// 一个模型一个目录 <仓>/<模型 id>/，文件照配置表里的相对路径放。每个文件先写成 .part，sha256 对上了才改回原名；
// 全部下齐后写一张收据 .complete.json（钉着的那次提交和每个文件的 sha256）。有收据、且和配置表对得上，才算装好了。
// 依次试几个下载地址：用户选的下载源在前，别的源垫后（catalog.mjs 的 downloadUrls）。
// 只用 Node 自带的 fetch 和文件操作，哪个系统都一样。

const RECEIPT = ".complete.json";

/** 多久收不到一个字节就算卡住了，放弃这个地址换下一个 */
const STALL_MS = 30_000;

/** 收据的内容：配置表里决定"装的是不是这一份"的那几样 */
const receiptOf = (model) => ({
  id: model.id,
  revision: model.origin.revision,
  files: Object.fromEntries(Object.values(model.files).map((file) => [file.path, file.sha256])),
});

/**
 * @param {object} options
 * @param {string} options.dir 仓放在哪
 * @param {typeof globalThis.fetch} [options.fetch] 测试时换成假的
 * @param {string} [options.source] 先从哪个下载源下（catalog.mjs 的 SOURCES，设置里的 modelSource）
 * @param {number} [options.stallMs] 多久收不到数据算卡住，测试时换成短的
 */
export function createModelStore({ dir, fetch = globalThis.fetch, source = DEFAULT_SOURCE, stallMs = STALL_MS }) {
  const dirOf = (model) => join(dir, model.id);

  function isInstalled(model) {
    const path = join(dirOf(model), RECEIPT);
    if (!existsSync(path)) return false;
    return JSON.stringify(JSON.parse(readFileSync(path, "utf8"))) === JSON.stringify(receiptOf(model));
  }

  /** 已经在那儿、内容也对的文件不再下：断了重来时只补缺的 */
  async function alreadyThere(path, file) {
    if (!existsSync(path)) return false;
    return (await sha256Of(createReadStream(path))) === file.sha256;
  }

  async function download(model, file, { signal, onProgress }) {
    const target = join(dirOf(model), file.path);
    if (await alreadyThere(target, file)) {
      onProgress?.(file.size);
      return;
    }
    mkdirSync(dirname(target), { recursive: true });
    const failures = [];
    for (const url of downloadUrls(model, file, source)) {
      try {
        await fetchTo(url, target, file, { signal, onProgress });
        return;
      } catch (error) {
        // 用户自己取消的不换地址
        if (signal?.aborted) throw error;
        failures.push(`${url}：${error.message}`);
      }
    }
    throw new Error(`${file.path} 哪个地址都没下下来：\n${failures.join("\n")}`);
  }

  /** 从一个地址下一个文件：先写成 .part，大小和 sha256 都对上才改回原名。卡住超过 stallMs 就放弃 */
  async function fetchTo(url, target, file, { signal, onProgress }) {
    const stall = new AbortController();
    let timer;
    const kick = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(new Error(`${stallMs / 1000} 秒没收到数据`)), stallMs);
    };
    const aborted = signal ? AbortSignal.any([signal, stall.signal]) : stall.signal;
    const partial = `${target}.part`;
    const hash = createHash("sha256");
    let received = 0;
    const meter = new Transform({
      transform(chunk, _encoding, done) {
        kick();
        hash.update(chunk);
        received += chunk.length;
        onProgress?.(received);
        done(null, chunk);
      },
    });
    kick();
    try {
      const response = await fetch(url, { signal: aborted, redirect: "follow" });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(partial), { signal: aborted });
      if (received !== file.size) throw new Error(`${file.path} 下载到 ${received} 字节，配置表里是 ${file.size} 字节`);
      const digest = hash.digest("hex");
      if (digest !== file.sha256)
        throw new Error(`${file.path} 的 sha256 对不上：下载到的是 ${digest}，配置表里是 ${file.sha256}`);
      renameSync(partial, target);
    } catch (error) {
      rmSync(partial, { force: true });
      // 卡住时 fetch 报的是"被取消了"，换成卡住的原因
      throw stall.signal.aborted && !signal?.aborted ? stall.signal.reason : error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    dirOf,
    isInstalled,

    /**
     * 下载并校验一个模型的全部文件。已经装好的直接返回。
     * @param {{ signal?: AbortSignal, onProgress?: (p: { received: number, total: number }) => void }} [options]
     *   onProgress：进度按整个模型算，已经下好的文件算满
     * @returns {Promise<string>} 模型目录
     */
    async install(model, { signal, onProgress } = {}) {
      if (isInstalled(model)) return dirOf(model);
      // 收据最后写：中途失败、被打断时没有收据，下次还会接着补
      rmSync(join(dirOf(model), RECEIPT), { force: true });
      const total = downloadSize(model);
      let done = 0;
      for (const file of Object.values(model.files)) {
        await download(model, file, {
          signal,
          onProgress: (received) => onProgress?.({ received: done + received, total }),
        });
        done += file.size;
      }
      writeFileSync(join(dirOf(model), RECEIPT), JSON.stringify(receiptOf(model), null, 2));
      return dirOf(model);
    },

    /**
     * 还差多少字节没下：最终的文件还不在的，按清单里的大小算（不核对内容，下载时会核对）。下载前查磁盘空间用
     */
    missingBytes(model) {
      return Object.values(model.files)
        .filter((file) => !existsSync(join(dirOf(model), file.path)))
        .reduce((sum, file) => sum + file.size, 0);
    },

    /** 删掉一个模型的整个目录。没装过的什么也不做 */
    remove(model) {
      rmSync(dirOf(model), { recursive: true, force: true });
    },

    /** 装好了的模型 id（目录里有收据的） */
    installed() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(dir, entry.name, RECEIPT)))
        .map((entry) => entry.name)
        .sort();
    },
  };
}

async function sha256Of(stream) {
  const hash = createHash("sha256");
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest("hex");
}
