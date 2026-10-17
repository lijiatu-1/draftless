import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createDelivery } from "../../src/app/delivery.mjs";
import { createTranslator } from "../../src/i18n/index.mjs";

const zh = createTranslator("zh-CN");

const AUDIO_ID = "0b6f1c1e-5a44-4f0e-9d0b-2f9f3a1c7e55";
const audio = () => Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 7]).buffer;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "draftless-delivery-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/**
 * @param {Function} [paste] 小帮手的粘贴。默认成功
 * @param {Function} [writeClipboard] 主进程这一侧写剪贴板。默认记进 clipboard 数组
 */
function setup(paste = async () => ({ ok: true, reason: null }), writeClipboard = null) {
  const rows = [];
  const pasted = [];
  const clipboard = [];
  const delivery = createDelivery({
    recordingsDir: join(dir, "Recordings"),
    history: { add: (row) => rows.push(row) },
    paste: (text) => {
      pasted.push(text);
      return paste(text);
    },
    writeClipboard: writeClipboard ?? ((text) => clipboard.push(text)),
    log: { warn() {}, error() {} },
    now: () => new Date("2026-10-13T08:00:00.000Z"),
  });
  return { delivery, rows, pasted, clipboard };
}

const payload = (overrides = {}) => ({
  audioId: AUDIO_ID,
  text: "我们后天开会。",
  durationSeconds: 4.2,
  audio: audio(),
  ...overrides,
});

test("成品：存录音、记历史、贴出去", async () => {
  const { delivery, rows, pasted } = setup();
  assert.deepEqual(await delivery.completed(payload()), { notice: null });

  const audioLocalPath = join(dir, "Recordings", `${AUDIO_ID}.webm`);
  assert.deepEqual([...readFileSync(audioLocalPath)], [0x1a, 0x45, 0xdf, 0xa3, 7]);
  assert.deepEqual(rows, [
    {
      id: AUDIO_ID,
      status: "completed",
      refinedText: "我们后天开会。",
      error: null,
      duration: 4.2,
      audioLocalPath,
      createdAt: "2026-10-13T08:00:00.000Z",
    },
  ]);
  assert.deepEqual(pasted, ["我们后天开会。"]);
});

test("没有听到声音：记历史但不去贴", async () => {
  const { delivery, rows, pasted } = setup();
  const { notice: silent } = await delivery.completed(payload({ text: "" }));
  assert.equal(zh.text(silent), "没有听到声音");
  assert.equal(rows.length, 1);
  assert.deepEqual(pasted, []);
});

test("贴进管理员权限的窗口（UIPI 挡住了模拟按键）：提示用户自己按 Ctrl+V，剪贴板里一定有那段文字", async () => {
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "uipi_blocked" }));
  const { notice } = await delivery.completed(payload());
  // macOS 版的这条是"没有辅助功能权限"；Windows 上粘贴不受授权管，是管理员权限的窗口收不到模拟按键
  assert.match(zh.text(notice), /管理员权限的窗口收不到模拟按键.*Ctrl\+V/);
  // 小帮手在贴失败时不再还原剪贴板，这里再补写一次：两种失败（它写了 / 它没写）都保证文字在剪贴板里，
  // 不然"按 Ctrl+V"那句就是假话
  assert.deepEqual(clipboard, ["我们后天开会。"]);
});

test("SendInput 失败但不是被权限挡的（比如结构体大小不对那种）：不说成权限问题", async () => {
  // input_blocked 后面跟的是 GetLastError。87 是 ERROR_INVALID_PARAMETER——那个曾经让每次粘贴
  // 都失败（INPUT 结构体多垫了 8 字节），跟"管理员权限"毫无关系，文案不能那么说
  const { delivery, clipboard } = setup(async () => ({ ok: false, reason: "input_blocked:87" }));
  const { notice } = await delivery.completed(payload());
  assert.match(zh.text(notice), /没能自动粘贴.*Ctrl\+V/);
  assert.ok(!/管理员权限/.test(zh.text(notice)), "不能把非权限原因说成权限问题");
  assert.deepEqual(clipboard, ["我们后天开会。"]);
});

test("真被 UIPI 拦下（ERROR_ACCESS_DENIED = 5）：才说管理员权限的窗口", async () => {
  const { delivery } = setup(async () => ({ ok: false, reason: "input_blocked:5" }));
  const { notice } = await delivery.completed(payload());
  assert.match(zh.text(notice), /管理员权限的窗口收不到模拟按键/);
});

test("剪贴板被别的程序占着（小帮手连写都写不进去）：说成品在历史里，不谎称已复制", async () => {
  const { delivery, clipboard } = setup(
    async () => ({ ok: false, reason: "clipboard_busy" }),
    // 主进程这边也写不进剪贴板
    () => {
      throw new Error("剪贴板被占着");
    },
  );
  const { notice } = await delivery.completed(payload());
  assert.match(zh.text(notice), /剪贴板也被别的程序占着.*历史/);
  assert.ok(!/已复制/.test(zh.text(notice)));
  assert.deepEqual(clipboard, []);
});

test("粘贴出错：文字放进剪贴板，历史照样记上", async () => {
  const { delivery, rows, clipboard } = setup(async () => {
    throw new Error("原生小帮手退出了");
  });
  const { notice } = await delivery.completed(payload());
  assert.match(zh.text(notice), /没能自动粘贴.*Ctrl\+V/);
  assert.deepEqual(clipboard, ["我们后天开会。"]);
  assert.equal(rows.length, 1);
});

test("失败的听写：录音和原因都留下", () => {
  const { delivery, rows, pasted } = setup();
  delivery.failed({ audioId: AUDIO_ID, error: "等了 20 秒没有等到成品", durationSeconds: 9, audio: audio() });
  assert.equal(rows[0].status, "failed");
  assert.equal(rows[0].refinedText, "");
  assert.equal(rows[0].error, "等了 20 秒没有等到成品");
  assert.ok(existsSync(rows[0].audioLocalPath));
  assert.deepEqual(pasted, []);
});

test("录音是某个缓冲区里的一段时，只存那一段", async () => {
  const { delivery, rows } = setup();
  const whole = Uint8Array.from([9, 9, 0x1a, 0x45, 9]);
  await delivery.completed(payload({ audio: whole.subarray(2, 4) }));
  assert.deepEqual([...readFileSync(rows[0].audioLocalPath)], [0x1a, 0x45]);
});

test("来自页面的参数不合格时拒绝，不落任何文件", async () => {
  const { delivery, rows } = setup();
  const bad = [
    payload({ audioId: "../../etc/passwd" }),
    payload({ audioId: `${AUDIO_ID}/x` }),
    payload({ durationSeconds: Number.NaN }),
    payload({ audio: "不是二进制" }),
    payload({ text: 42 }),
  ];
  for (const item of bad) await assert.rejects(delivery.completed(item), TypeError);
  assert.throws(() => delivery.failed(payload({ error: undefined })), TypeError);
  assert.deepEqual(rows, []);
  assert.equal(existsSync(join(dir, "Recordings")) ? readdirSync(join(dir, "Recordings")).length : 0, 0);
});
