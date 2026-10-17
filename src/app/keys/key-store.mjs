import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { LocalizedError, msg } from "../../i18n/index.mjs";

/**
 * 一家模型的 API key 的存放处：用系统提供的加密存成一个文件，明文只在内存里。
 *
 * Windows 上是 Electron 的 safeStorage，它背后是当前用户的 DPAPI：密钥由系统按用户管，
 * 文件被拷到别的机器、别的用户下是解不开的。
 *
 * 和原版的差别，据实写清楚：
 * - macOS 的钥匙串条目按应用隔离，别的应用读不到；Windows 上 DPAPI 按用户隔离，
 *   同一个用户下的其他程序也能解开这份密文。所以这里能承诺的是"离开这台机器、这个用户就解不开"，
 *   而不是"别的程序读不到"
 * - 没有权限位的讲究（0o600 在 Windows 上不生效）：%USERPROFILE% 下的文件默认只有本人和管理员能动
 *
 * @param {object} options
 * @param {string} options.file 密文文件的路径
 * @param {{ isEncryptionAvailable(): boolean, encryptString(text: string): Buffer, decryptString(data: Buffer): string }} options.safeStorage
 *   Electron 的 safeStorage；测试时换成假的
 */
export function createKeyStore({ file, safeStorage }) {
  return {
    /** @returns {string | null} 没存过时是 null。密文解不开（比如换了机器）会抛错 */
    load() {
      if (!existsSync(file)) return null;
      return safeStorage.decryptString(readFileSync(file));
    },

    save(key) {
      // 系统不提供加密时 Electron 在有的环境下会退回固定密钥，那等于存明文，所以直接拒绝
      if (!safeStorage.isEncryptionAvailable()) throw new LocalizedError(msg("key.keychainUnavailable"));
      writeFileSync(file, safeStorage.encryptString(key));
    },

    clear() {
      rmSync(file, { force: true });
    },

    /** 存过没有。只看文件在不在，不解密 */
    exists() {
      return existsSync(file);
    },
  };
}
