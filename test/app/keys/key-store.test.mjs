import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKeyStore } from "../../../src/app/keys/key-store.mjs";
import { createTranslator } from "../../../src/i18n/index.mjs";

const zh = createTranslator("zh-CN");
/** 报错里给人看的那句，按中文翻出来对得上 */
const said = (pattern) => (error) => pattern.test(zh.text(error.problem ?? error.message));

// 假的 safeStorage：把字节逐个异或一下，够区分"存的是密文还是明文"。
// Windows 上它背后是当前用户的 DPAPI（Windows 版的钥匙串）；这一层只管"存进去能读回来、盘上不是明文"。
const fakeSafeStorage = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (text) => Buffer.from(text, "utf8").map((byte) => byte ^ 0x5a),
  decryptString: (buffer) => Buffer.from(buffer.map((byte) => byte ^ 0x5a)).toString("utf8"),
});

function tempStore(safeStorage = fakeSafeStorage()) {
  const dir = mkdtempSync(join(tmpdir(), "draftless-key-"));
  const file = join(dir, "gemini-key.bin");
  return { file, store: createKeyStore({ file, safeStorage }), cleanup: () => rmSync(dir, { recursive: true }) };
}

test("没存过时读出来是 null", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  assert.equal(store.load(), null);
});

test("存进去能原样读回来；磁盘上不是明文", (t) => {
  const { file, store, cleanup } = tempStore();
  t.after(cleanup);
  store.save("AIza-not-a-real-key");
  assert.equal(store.load(), "AIza-not-a-real-key");
  assert.ok(!readFileSync(file).includes("AIza-not-a-real-key"));
});

test("清掉之后读出来是 null，重复清不报错", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.save("AIza-not-a-real-key");
  store.clear();
  store.clear();
  assert.equal(store.load(), null);
});

test("存过没有只看文件在不在，不解密：密钥换了也答得上来", (t) => {
  const { store, cleanup } = tempStore({
    isEncryptionAvailable: () => true,
    encryptString: (text) => Buffer.from(text),
    decryptString: () => assert.fail("不该解密"),
  });
  t.after(cleanup);
  assert.equal(store.exists(), false);
  store.save("k");
  assert.equal(store.exists(), true);
});

test("系统不提供加密时拒绝保存，不退回到存明文", (t) => {
  const { store, cleanup } = tempStore(fakeSafeStorage(false));
  t.after(cleanup);
  assert.throws(() => store.save("AIza-not-a-real-key"), said(/加密/));
  assert.equal(store.exists(), false);
});

test("覆盖保存：后存的为准，不留上一份的字节", (t) => {
  const { store, cleanup } = tempStore();
  t.after(cleanup);
  store.save("AIza-first-key-value-long");
  store.save("AIza-second");
  assert.equal(store.load(), "AIza-second");
});
