import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { Cancelled } from "../../src/cli/ask-secret.mjs";
import { run } from "../../src/cli/main.mjs";
import { createUpdater } from "../../src/cli/updater.mjs";
import { NotRunningError, TimeoutError } from "../../src/control.mjs";
import { createTranslator, LocalizedError, msg } from "../../src/i18n/index.mjs";
import { downloadSize, findModel } from "../../src/models/catalog.mjs";
import { openHistory } from "../../src/storage/history.mjs";
import { keyFile, resolvePaths } from "../../src/storage/paths.mjs";
import { resolveSettings } from "../../src/storage/settings.mjs";

const READY = {
  pid: 4321,
  version: "0.1.0",
  starting: false,
  hotkey: "right_alt",
  hotkeyLabel: "Right Alt key",
  provider: "gemini",
  mode: "native",
  model: "gemini/gemini-3.6-flash",
  thinking: "MINIMAL",
  packaged: false,
  helper: "running",
  key: { state: "ready", source: "stored", problem: null, verified: true },
  permissions: { microphone: "granted", listen: true, trusted: true },
  summary: { ready: true, missing: [], blocker: null, degraded: null },
};
/** 存着的那把被撤销了 */
const REVOKED_KEY = {
  ...READY,
  key: { state: "rejected", source: "stored", cause: "key", problem: "这把 key 无效，检查有没有复制完整" },
  summary: { ready: false, missing: ["Gemini API key"], blocker: "API key 不能用", degraded: null },
};
/** 模型名写错：Gemini 拒绝了请求，key 本身没问题 */
const WRONG_MODEL = {
  ...READY,
  model: "gemini/gemini-nope",
  key: {
    state: "rejected",
    source: "stored",
    cause: "other",
    problem: "Gemini 拒绝了请求：models/gemini-nope is not found",
  },
  summary: { ready: false, missing: ["Gemini 验证"], blocker: "Gemini 验证没通过", degraded: null },
};
const NO_KEY = {
  ...READY,
  key: { state: "missing", source: null, problem: null },
  summary: { ready: false, missing: ["Gemini API key"], blocker: "还没有填 Gemini API key", degraded: null },
};
const NO_PERMISSIONS = {
  ...READY,
  permissions: { microphone: "denied", listen: false, trusted: true },
  summary: { ready: false, missing: ["麦克风权限", "键盘钩子"], blocker: "没有麦克风权限", degraded: null },
};

let dir;
let paths;
/** 有的测试要在家目录以外放东西 */
let outside = null;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sm-"));
  paths = resolvePaths({ DRAFTLESS_HOME: dir });
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (outside) rmSync(outside, { recursive: true, force: true });
  outside = null;
});

/**
 * 假的后台应用。running 是它现在的状态（null 表示没在运行），afterStart 是启动之后的状态，
 * saveKey 决定存 key 的结果，stopped 是停止时的说法，hung 为 true 表示它卡住了不答话。
 * reloadTheme、reloadLanguage 是让它重新读主题、语言时的回答，默认和真的一样：照设置文件里现在写的换。
 * changeRoute 是切模式、换各模式里的模型（set-mode、set-model、set-transcriber、set-polish）时的回答。
 * calls 记下命令行对它做过什么。
 */
function fakeDaemon({
  running = null,
  afterStart = READY,
  saveKey = () => ({ ok: true }),
  checkModel = () => ({ ok: true, source: "stored", ms: 812 }),
  changeRoute = () => ({ ok: true }),
  stopped = "quit",
  hung = false,
  reloadTheme = () => ({ theme: resolveSettings({ file: paths.settingsFile, env: {} }).theme.value }),
  reloadLanguage = () => ({ language: resolveSettings({ file: paths.settingsFile, env: {} }).language.value }),
} = {}) {
  const daemon = {
    calls: [],
    /** 每条命令带的参数 */
    requests: [],
    current: running,
    hung,
    async status(params = {}) {
      if (daemon.hung) throw new TimeoutError("status", 5_000);
      if (params.recheck) daemon.calls.push("recheck");
      return daemon.current;
    },
    async start({ onProgress }) {
      daemon.calls.push("start");
      onProgress("正在验证 key…");
      if (afterStart instanceof Error) throw afterStart;
      daemon.current = afterStart;
      return afterStart;
    },
    async stop() {
      daemon.calls.push("stop");
      const was = daemon.current !== null || daemon.hung;
      daemon.current = null;
      daemon.hung = false;
      return was ? stopped : "not-running";
    },
    async request(cmd, params) {
      daemon.calls.push(cmd);
      daemon.requests.push({ cmd, params });
      if (daemon.current === null) throw new NotRunningError();
      if (cmd === "check-model") return checkModel(params.model);
      if (cmd === "check-polish") return checkModel(params.polish);
      if (["set-mode", "set-model", "set-transcriber", "set-polish"].includes(cmd)) return changeRoute(cmd, params);
      if (cmd === "set-key") {
        const result = saveKey(params.key, params.provider);
        // 存 key 只改 key 的状态，用的是哪一家不变
        if (result.ok) daemon.current = { ...daemon.current, key: READY.key, summary: READY.summary };
        return result;
      }
      if (cmd === "forget-key") daemon.current = NO_KEY;
      if (cmd === "reload-theme") return reloadTheme();
      if (cmd === "reload-language") return reloadLanguage();
      return null;
    },
  };
  return daemon;
}

/** secrets：每次问 key 时依次给出的回答。可以是文字、要抛的错误，或者一个现算的函数 */
function harness({
  daemon = fakeDaemon(),
  interactive = true,
  env = {},
  secrets = [],
  answers = [],
  confirms = [],
  locale = "zh-CN",
  latest = "v0.1.0",
  configured = true,
  packageDir = join(paths.home, "app"),
  modelDownload = "finish",
} = {}) {
  const output = { out: "", err: "" };
  const asked = [];
  /** 普通提问（会回显的，比如选用哪一家）问过的话 */
  const questions = [];
  const tails = [];
  const confirmed = [];
  /** 问下载地址最新版本时给的限时。这一版不替人换程序，所以只记这个 */
  const updates = { checks: [] };
  /** 后台没在运行时命令行自己下载、删除的本机模型（假的模型库：下载一报进度就下完，或者没下下来） */
  const local = { downloads: [], removed: [], sources: [] };
  /** 真的那一份，只管把上一次问的结果记在家目录里：status 一天只问一次靠它 */
  const realUpdater = createUpdater({ env: {}, home: paths.home });
  const io = {
    out: (text) => {
      output.out += `${text}\n`;
    },
    err: (text) => {
      output.err += `${text}\n`;
    },
    env,
    interactive,
    color: false,
    version: "0.1.0",
    // 原来的断言都是中文的：这些测试按中文跑，英文的另有几条
    t: createTranslator(locale),
    paths,
    daemon,
    now: () => new Date("2026-10-13T07:00:00.000Z"),
    sleep: async () => {},
    localModels: ({ source, onChange = () => {} }) => {
      local.sources.push(source);
      const state = new Map();
      const models = {
        status: (id) => state.get(id) ?? { id, installed: false, download: null, problem: null },
        async download(id) {
          local.downloads.push(id);
          const total = downloadSize(findModel(id));
          state.set(id, { id, installed: false, download: { received: total / 2, total }, problem: null });
          onChange(id);
          if (modelDownload === "finish") {
            haveModel(id);
            state.set(id, { id, installed: true, download: null, problem: null });
          } else {
            state.set(id, {
              id,
              installed: false,
              download: null,
              problem: msg("localModels.downloadFailed", { model: id, reason: modelDownload }),
            });
          }
          onChange(id);
          return { ok: true };
        },
        remove(id) {
          local.removed.push(id);
          rmSync(join(paths.modelsDir, id), { recursive: true, force: true });
          return { ok: true };
        },
      };
      return models;
    },
    timeZone: "Asia/Shanghai",
    openHistory,
    async askSecret(prompt) {
      asked.push(prompt);
      const next = secrets.shift();
      const answer = typeof next === "function" ? next() : next;
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
    async ask(question) {
      questions.push(question);
      const next = answers.shift();
      const answer = typeof next === "function" ? next() : next;
      if (answer instanceof Error) throw answer;
      return answer ?? "";
    },
    async tail(args) {
      tails.push(args);
      return 0;
    },
    async confirm(question) {
      confirmed.push(question);
      return confirms.shift() ?? false;
    },
    // Windows 上密文由 DPAPI 按用户加密，没有一条单独的"钥匙串记录"可删
    removeKeychainKey: () => false,
    packageDir,
    // 和真的那一份同一个形状（configured / latest / lastCheck / rememberCheck / install），
    // 只是问版本这一步换成了测试给的那个回答，也不去下载、替换程序
    updater: {
      get configured() {
        return configured;
      },
      async latest(timeoutSeconds) {
        updates.checks.push(timeoutSeconds);
        const answer = typeof latest === "function" ? latest() : latest;
        if (answer instanceof Error) throw answer;
        return answer;
      },
      lastCheck: (file) => realUpdater.lastCheck(file),
      rememberCheck: (file, version) => realUpdater.rememberCheck(file, version),
      async install() {
        throw new LocalizedError(msg("cli.update.manual"));
      },
    },
  };
  return {
    io,
    output,
    asked,
    questions,
    tails,
    confirmed,
    daemon,
    updates,
    local,
    draftless: (...argv) => run(argv, io),
  };
}

/** 本机模型下好了：照模型仓的收据写一份（命令行只看收据，不读模型文件） */
function haveModel(id = "qwen3-asr-0.6b-q8") {
  const model = findModel(id);
  const where = join(paths.modelsDir, id);
  mkdirSync(where, { recursive: true });
  const files = Object.fromEntries(Object.values(model.files).map((file) => [file.path, file.sha256]));
  writeFileSync(join(where, ".complete.json"), JSON.stringify({ id, revision: model.origin.revision, files }));
}

/** 假装以前存过一把 key */
const haveStoredKey = () => writeFileSync(keyFile(paths, "gemini"), "密文");

// ---------- 启动 ----------

test("不带参数：没在运行就启动，然后给出状态面板", async () => {
  const { draftless, output, daemon } = harness();
  assert.equal(await draftless(), 0);
  assert.deepEqual(daemon.calls, ["start", "recheck"]);
  assert.match(output.out, /正在启动/);
  assert.match(output.out, /draftless 0\.1\.0 · 运行中/);
  assert.match(output.out, /按一下右 Alt 键开始说话/);
});

test("已经在运行时不再启动一次，只给面板；start 和不带参数是一回事", async () => {
  for (const argv of [[], ["start"]]) {
    const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
    assert.equal(await draftless(...argv), 0);
    assert.ok(!daemon.calls.includes("start"));
    assert.match(output.out, /运行中/);
  }
});

test("第一次用：先问 key，再启动；存好了直接能用；key 不出现在任何输出里", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  // 等启动的那段时间里终端是照常回显的：要是到那时才想起来要 key，提前粘贴的人会看到 key 显示在屏幕上
  const whenAsked = () => {
    assert.deepEqual(daemon.calls, [], "问 key 的时候还没开始启动");
    return "AIza-my-secret";
  };
  const { draftless, output, asked } = harness({ daemon, secrets: [whenAsked] });
  assert.equal(await draftless(), 0);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.deepEqual(saved, ["AIza-my-secret"]);
  assert.equal(asked.length, 1);
  // 去哪申请、存在哪，是和提示一起交给"不回显地问"的那一步的：要先关掉回显再让人看到"要 key 了"
  assert.match(asked[0], /aistudio\.google\.com\/apikey/);
  assert.doesNotMatch(output.out, /aistudio/);
  assert.match(output.out, /已保存，验证通过/);
  assert.match(output.out, /运行中/);
  assert.ok(!(output.out + output.err).includes("AIza-my-secret"));
});

test("第一次用：按模式分组问用哪一家，选 DeepSeek 就进 local 模式、问 DeepSeek 的 key", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "deepseek", mode: "local" } });
  // 4 是 DeepSeek：native 那组只列收音频的三家，DeepSeek 在 local 那组的第一个
  const { draftless, questions, asked, output } = harness({ daemon, answers: ["4"], secrets: ["sk-ds"] });
  const code = await draftless();
  assert.equal(code, 0, output.out + output.err);
  // 编号按清单里的顺序排：native 三家里 DeepSeek 不在（它是纯文本的），local 第二跳才有它
  assert.match(
    questions[0],
    /native 模式[\s\S]*1.*Gemini[\s\S]*2.*OpenAI[\s\S]*3.*Qwen[\s\S]*local 模式.*850 MB[\s\S]*4.*DeepSeek[\s\S]*5.*Qwen/,
  );
  assert.match(questions[0], /custom\/<模型名> --url/);
  assert.deepEqual([saved("mode"), saved("polish")], ["local", "deepseek/deepseek-flash"]);
  assert.match(asked[0], /DeepSeek API key/);
});

test("第一次用：先问用哪一家，选 OpenAI 就记进设置、问 OpenAI 的 key，问完才启动", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" },
    saveKey: (key, provider) => {
      saved.push([key, provider]);
      return { ok: true };
    },
  });
  const whenChosen = () => {
    assert.deepEqual(daemon.calls, [], "选的时候还没开始启动");
    return "2";
  };
  const { draftless, questions, asked, output } = harness({ daemon, answers: [whenChosen], secrets: ["sk-my-secret"] });
  assert.equal(await draftless(), 0);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /1.*Gemini/);
  assert.match(questions[0], /2.*OpenAI/);
  // 以后怎么换也说一句，免得以为选了就定死了
  assert.match(questions[0], /draftless model/);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
  assert.equal(asked.length, 1);
  assert.match(asked[0], /platform\.openai\.com\/api-keys/);
  assert.deepEqual(saved, [["sk-my-secret", "openai"]]);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.match(output.out, /OpenAI/);
  assert.ok(!(output.out + output.err).includes("sk-my-secret"));
});

test("第一次用：直接回车就是 Gemini，设置文件不动", async () => {
  const daemon = fakeDaemon({ afterStart: NO_KEY });
  const { draftless, questions, asked } = harness({ daemon, answers: [""], secrets: ["AIza-key"] });
  assert.equal(await draftless(), 0);
  assert.equal(questions.length, 1);
  assert.ok(!existsSync(paths.settingsFile));
  assert.match(asked[0], /aistudio\.google\.com/);
});

test("选的时候写名字也认；写错了说能选什么，再问", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "openai" } });
  const { draftless, questions, output } = harness({ daemon, answers: ["nope", "OpenAI"], secrets: ["sk-key"] });
  assert.equal(await draftless(), 0);
  assert.equal(questions.length, 2);
  assert.match(output.err, /nope/);
  assert.match(output.err, /1.*2/);
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
});

test("别家已经有 key 时标出来；选它就不用再填，直接用它启动", async () => {
  writeFileSync(keyFile(paths, "openai"), "密文");
  const daemon = fakeDaemon({ afterStart: { ...READY, provider: "openai", model: "openai/gpt-audio-mini" } });
  const { draftless, questions, asked } = harness({ daemon, answers: ["2"] });
  assert.equal(await draftless(), 0);
  assert.match(questions[0], /OpenAI.*已经有 key/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-key"));
  assert.equal(resolveSettings({ file: paths.settingsFile, env: {} }).model.value, "openai/gpt-audio-mini");
});

test("设置里或环境变量里已经定了用哪家：不再问选哪家，直接问那一家的 key", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ model: "openai/gpt-audio-1.5" }));
  const fromFile = harness({ daemon: fakeDaemon({ afterStart: NO_KEY }), secrets: ["sk-key"] });
  assert.equal(await fromFile.draftless(), 0);
  assert.equal(fromFile.questions.length, 0);
  assert.match(fromFile.asked[0], /OpenAI/);
  rmSync(paths.settingsFile);

  const fromEnv = harness({
    daemon: fakeDaemon({ afterStart: NO_KEY }),
    env: { DRAFTLESS_MODEL: "gemini" },
    secrets: ["AIza"],
  });
  assert.equal(await fromEnv.draftless(), 0);
  assert.equal(fromEnv.questions.length, 0);
});

test("选哪家时按了 Ctrl-C：不问 key，照默认的启动，面板里说还差 key", async () => {
  const daemon = fakeDaemon({ afterStart: NO_KEY });
  const { draftless, questions, asked, output } = harness({ daemon, answers: [new Cancelled()] });
  assert.equal(await draftless(), 0);
  assert.equal(questions.length, 1);
  assert.equal(asked.length, 0);
  assert.deepEqual(daemon.calls, ["start", "recheck"]);
  assert.match(output.out, /还差 1 样/);
});

test("已经有 key（存着的，或者环境变量给的）时直接启动，不问", async () => {
  haveStoredKey();
  const stored = harness();
  assert.equal(await stored.draftless(), 0);
  assert.equal(stored.asked.length, 0);
  rmSync(keyFile(paths, "gemini"));

  const fromEnv = harness({ env: { GEMINI_API_KEY: "AIza-env" } });
  assert.equal(await fromEnv.draftless(), 0);
  assert.equal(fromEnv.asked.length, 0);
});

test("问到的 key 样子不对（带换行、空格）：当场说、当场再问，不发给后台，内容不出现在输出里", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  const { draftless, output, asked } = harness({ daemon, secrets: ["two\nlines-SECRET", "AIza-good"] });
  assert.equal(await draftless(), 0);
  assert.equal(asked.length, 2);
  assert.deepEqual(saved, ["AIza-good"]);
  assert.match(output.err, /这把 key 里有空格或换行/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("存着的 key 启动后发现已经不能用了：这时再问一把", async () => {
  haveStoredKey();
  const daemon = fakeDaemon({ afterStart: REVOKED_KEY });
  const { draftless, asked, output } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await draftless(), 0);
  assert.deepEqual(daemon.calls, ["start", "set-key", "recheck"]);
  assert.equal(asked.length, 1);
  assert.match(output.out, /运行中/);
});

test("不是 key 的问题时不问 key：模型名写错、环境变量里的 key 不对，都只在面板里说", async () => {
  haveStoredKey();
  const wrongModel = harness({ daemon: fakeDaemon({ afterStart: WRONG_MODEL }) });
  assert.equal(await wrongModel.draftless(), 0);
  assert.equal(wrongModel.asked.length, 0);
  assert.match(wrongModel.output.out, /gemini-nope is not found/);
  assert.match(wrongModel.output.out, /draftless config/);

  const badEnv = { ...REVOKED_KEY, key: { ...REVOKED_KEY.key, source: "env" } };
  const fromEnv = harness({ daemon: fakeDaemon({ afterStart: badEnv }), env: { GEMINI_API_KEY: "AIza-env" } });
  assert.equal(await fromEnv.draftless(), 0);
  assert.equal(fromEnv.asked.length, 0);
  assert.match(fromEnv.output.out, /环境变量 GEMINI_API_KEY/);
});

test("key 不对时说明原因再问一次", async () => {
  const answers = [{ ok: false, problem: "这把 key 无效，检查有没有复制完整" }, { ok: true }];
  const daemon = fakeDaemon({ afterStart: NO_KEY, saveKey: () => answers.shift() });
  const { draftless, output, asked } = harness({ daemon, secrets: ["wrong", "right"] });
  assert.equal(await draftless(), 0);
  assert.equal(asked.length, 2);
  assert.match(output.err, /这把 key 无效/);
  assert.match(output.out, /运行中/);
});

test("问 key 时什么都没填或者按了 Ctrl-C：不纠缠，面板里说还差 key", async () => {
  for (const secret of ["", new Cancelled()]) {
    const daemon = fakeDaemon({ afterStart: NO_KEY });
    const { draftless, output, asked } = harness({ daemon, secrets: [secret] });
    assert.equal(await draftless(), 0);
    // 启动前问过一次、他没填，启动后就不再问第二遍
    assert.equal(asked.length, 1);
    assert.ok(!daemon.calls.includes("set-key"));
    assert.match(output.out, /还差 1 样/);
    assert.match(output.out, /draftless key/);
  }
});

test("不是在终端里运行（脚本、管道）时不问 key，也不弹窗口", async () => {
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, ...{ permissions: NO_PERMISSIONS.permissions } } });
  const { draftless, asked, questions } = harness({ daemon, interactive: false });
  assert.equal(await draftless(), 0);
  assert.equal(asked.length, 0);
  assert.equal(questions.length, 0);
  assert.ok(!daemon.calls.includes("show-settings"));
});

test("第一次用、缺系统权限：打开首次引导，并在面板里说明", async () => {
  const daemon = fakeDaemon({ afterStart: NO_PERMISSIONS });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless(), 0);
  // 请求名沿用 show-settings：老版本的后台不认识 onboarding 这个参数，照样打开设置
  assert.deepEqual(
    daemon.requests.find(({ cmd }) => cmd === "show-settings"),
    { cmd: "show-settings", params: { onboarding: true } },
  );
  assert.match(output.out, /还差 2 样/);
  assert.match(output.out, /已经打开首次引导/);
});

test("用过的人缺了系统权限：只打开设置", async () => {
  haveStoredKey();
  const daemon = fakeDaemon({ afterStart: NO_PERMISSIONS });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless(), 0);
  const request = daemon.requests.find(({ cmd }) => cmd === "show-settings");
  assert.ok(request);
  assert.notEqual(request.params?.onboarding, true);
  assert.match(output.out, /已经打开设置/);
});

test("启动不起来时把原因说出来，以非零退出", async () => {
  const daemon = fakeDaemon({ afterStart: new Error("draftless 没能启动（退出码 2）") });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless(), 1);
  assert.match(output.err, /没能启动（退出码 2）/);
});

// ---------- 停止、重启、状态 ----------

test("stop：在运行就停掉，没在运行就照实说，是强行结束的也照实说", async () => {
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.draftless("stop"), 0);
  assert.match(running.output.out, /已经停掉/);
  const idle = harness();
  assert.equal(await idle.draftless("stop"), 0);
  assert.match(idle.output.out, /没有在运行/);
  const stuck = harness({ daemon: fakeDaemon({ hung: true, stopped: "killed" }) });
  assert.equal(await stuck.draftless("stop"), 0);
  assert.match(stuck.output.out, /强行结束/);
});

test("restart：先停再起", async () => {
  const { draftless, daemon, output } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("restart"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /运行中/);
});

test("restart：它卡住不答话时照样能重启", async () => {
  haveStoredKey();
  const { draftless, daemon, output } = harness({ daemon: fakeDaemon({ hung: true, stopped: "killed" }) });
  assert.equal(await draftless("restart"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /运行中/);
});

test("正在运行的是装成应用的那一个：不代它重启（会被换成终端启动的，权限和 key 是另一套），说怎么办", async () => {
  const packaged = { ...READY, packaged: true };
  const restarting = harness({ daemon: fakeDaemon({ running: packaged }) });
  assert.equal(await restarting.draftless("restart"), 1);
  assert.deepEqual(restarting.daemon.calls, []);
  assert.match(restarting.output.err, /装好的 Draftless/);
  assert.match(restarting.output.err, /退出 Draftless/);

  const configuring = harness({ daemon: fakeDaemon({ running: packaged }) });
  assert.equal(await configuring.draftless("config", "set", "hotkey", "fn"), 0);
  // 旧名字只是读的时候认：写进文件的是新 id
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { hotkey: "right_shift" });
  assert.deepEqual(configuring.daemon.calls, []);
  assert.match(configuring.output.out, /装好的 Draftless/);
  assert.doesNotMatch(configuring.output.out, /已经生效/);
});

test("它卡住不答话时，别的命令说清楚是卡住了、怎么停，不甩一屏调用栈", async () => {
  for (const argv of [[], ["status"], ["settings"]]) {
    const { draftless, output } = harness({ daemon: fakeDaemon({ hung: true }) });
    assert.equal(await draftless(...argv), 1);
    assert.match(output.err, /没有在 5 秒内回话/);
    assert.match(output.err, /draftless stop/);
  }
});

test("命令做到一半它没了：照实说没有在运行", async () => {
  const daemon = fakeDaemon({ running: READY });
  daemon.request = async () => {
    throw new NotRunningError();
  };
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("settings"), 1);
  assert.match(output.err, /没有在运行/);
});

test("status：只看不动；能用是 0，没在运行或还差东西是 1", async () => {
  const idle = harness();
  assert.equal(await idle.draftless("status"), 1);
  // 只会让它重新查一遍系统权限，不会把它启动起来
  assert.deepEqual(idle.daemon.calls, ["recheck"]);
  assert.match(idle.output.out, /没有运行/);

  const ready = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await ready.draftless("status"), 0);
  assert.ok(!ready.daemon.calls.includes("show-settings"));

  const incomplete = harness({ daemon: fakeDaemon({ running: NO_KEY }) });
  assert.equal(await incomplete.draftless("status"), 1);
});

test("status --json：给程序读的，一行 JSON，带运行状态、设置和统计", async () => {
  const { draftless, output } = harness({ daemon: fakeDaemon({ running: READY }) });
  await draftless("status", "--json");
  const parsed = JSON.parse(output.out);
  assert.equal(parsed.running, true);
  assert.equal(parsed.status.pid, 4321);
  assert.equal(parsed.settings.hotkey.value, "right_alt");
  assert.deepEqual(parsed.stats, { today: null, total: null });
});

// ---------- 更新 ----------

// Windows 版的 update 只问版本、不替人换程序（src/cli/updater.mjs）：下载地址从 DRAFTLESS_INSTALL_BASE 来，
// 那里放一个只有一行版本号的 latest.txt。macOS 版那一套"再跑一次 install.sh、换掉 .app、重新打开"在这里
// 没有对应物，那几条用例（App 装在哪、换 App、重开 App、按进程号找 App）随那条实现一起删掉了。

/** 像是用安装脚本装的：程序在家目录的 app 里 */
const installed = () => mkdirSync(join(paths.home, "app"), { recursive: true });
/** 下载地址：更新方法那句话里会带上它 */
const INSTALL_BASE = "https://dl.example.com/draftless";

test("update：下载地址上有更新的版本，就说清楚是哪个、怎么换（这一版不替人装）", async () => {
  installed();
  const { draftless, output, updates } = harness({ latest: "v0.2.0", env: { DRAFTLESS_INSTALL_BASE: INSTALL_BASE } });
  assert.equal(await draftless("update"), 0);
  assert.match(output.out, /有新版本 0\.2\.0（现在是 0\.1\.0）：运行 draftless update/);
  assert.match(output.out, /更新方法：从 https:\/\/dl\.example\.com\/draftless 下载新的发布包/);
  // 问的是下载地址（限时 20 秒），结果记下来：status 靠它一天只问一次
  assert.deepEqual(updates.checks, [20]);
  assert.equal(JSON.parse(readFileSync(paths.updateCheckFile, "utf8")).latest, "0.2.0");
});

test("update：正在运行的是装好的那一份时多说一句先退出；从终端启动的那一份不用", async () => {
  installed();
  const packaged = harness({ daemon: fakeDaemon({ running: { ...READY, packaged: true } }), latest: "v0.2.0" });
  assert.equal(await packaged.draftless("update"), 0);
  assert.match(packaged.output.out, /先退出正在运行的 Draftless/);

  const fromTerminal = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0" });
  assert.equal(await fromTerminal.draftless("update"), 0);
  assert.doesNotMatch(fromTerminal.output.out, /先退出/);
});

test("update：已经是最新的（或者比下载地址上的还新）就什么都不做", async () => {
  installed();
  for (const latest of ["v0.1.0", "0.1.0", "v0.0.9", "v0.1.0-rc.1"]) {
    const { draftless, output } = harness({ latest });
    assert.equal(await draftless("update"), 0, latest);
    assert.match(output.out, /已经是最新的（0\.1\.0）/, latest);
    assert.doesNotMatch(output.out, /更新方法/, latest);
  }
});

test("update：这一版没有配置更新源时明说，不让人以为已经是最新的", async () => {
  installed();
  const { draftless, output, updates } = harness({ configured: false, latest: "v0.2.0" });
  assert.equal(await draftless("update"), 1);
  assert.match(output.err, /没有配置更新源/);
  assert.doesNotMatch(output.out, /已经是最新的/);
  assert.deepEqual(updates.checks, [], "没配更新源就不去问");
});

test("update：后台卡住不答话时不知道跑的是哪个，照样说怎么换，也不硬去查进程", async () => {
  installed();
  const { draftless, output } = harness({ daemon: fakeDaemon({ hung: true }), latest: "v0.2.0" });
  assert.equal(await draftless("update"), 0);
  assert.match(output.out, /有新版本 0\.2\.0/);
  assert.doesNotMatch(output.out, /先退出/);
});

// macOS 版的"家目录经过符号链接（/tmp 其实是 /private/tmp）也认得出是装好的那一份"也删掉了：
// 现在判断装好没有是 isInstalledCopy(packageDir, appDir) 比 realpath（src/cli/updater.mjs），
// 那一条在 test/cli/updater.test.mjs 里核过；Windows 上建目录符号链接还要管理员或开发者模式，验不出更多东西。

test("update：从源码跑的这一份不归安装脚本管，说用 git pull，不去问下载地址", async () => {
  outside = mkdtempSync(join(tmpdir(), "sm-src-"));
  const { draftless, output, updates } = harness({ latest: "v0.2.0", packageDir: outside });
  assert.equal(await draftless("update"), 1);
  assert.deepEqual(updates.checks, []);
  assert.match(output.err, /git pull/);
  assert.ok(output.err.includes(outside));
});

test("update：问不到最新版本、问到的不像版本号，都照实说，不往下用", async () => {
  installed();
  const offline = harness({
    latest: new LocalizedError(
      msg("cli.update.unreachable", { url: "https://x/latest", reason: "curl: (6) 解析不了" }),
    ),
  });
  assert.equal(await offline.draftless("update"), 1);
  assert.match(offline.output.err, /https:\/\/x\/latest/);
  assert.match(offline.output.err, /curl: \(6\)/);
  // 问到的不像版本号时不去动上一次问的结果，也不会说"有新版本"
  assert.equal(existsSync(paths.updateCheckFile), false);

  const garbled = harness({ latest: "<html>出错了</html>" });
  assert.equal(await garbled.draftless("update"), 1);
  assert.match(garbled.output.err, /<html>/);
  assert.equal(existsSync(paths.updateCheckFile), false);

  assert.equal(await harness().draftless("update", "now"), 2);
});

test("status：有新版本时提醒一句；一天只问一次下载地址", async () => {
  installed();
  const { io, draftless, output, updates } = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0" });
  // 记下来的时间是真实的钟（src/cli/updater.mjs 的 rememberCheck 用的是 new Date()）：
  // 以它为基准往后拨，别让这条测试看跑的时候是哪一天
  const start = Date.now();
  io.now = () => new Date(start);
  await draftless("status");
  assert.match(output.out, /有新版本 0\.2\.0（现在是 0\.1\.0）：运行 draftless update/);
  await draftless("status");
  assert.equal(updates.checks.length, 1, "问过的一天之内不再问");
  // 过了一天再问
  io.now = () => new Date(start + 24 * 60 * 60 * 1000 + 1000);
  await draftless("status");
  assert.equal(updates.checks.length, 2);
  // status 不能为这个等太久
  assert.ok(updates.checks.every((seconds) => seconds <= 3));
});

/** 忘掉上一次问下载地址的结果：同一个测试里换一种情形时用 */
const forgetUpdateCheck = () => rmSync(paths.updateCheckFile, { force: true });

test("status：没有新版本、问不到、从源码跑的，都不提，也不影响退出码", async () => {
  installed();
  const same = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await same.draftless("status"), 0);
  assert.doesNotMatch(same.output.out, /新版本/);

  forgetUpdateCheck();
  const offline = harness({ daemon: fakeDaemon({ running: READY }), latest: new Error("没网") });
  // 同上：记下来的是真实的钟
  offline.io.now = () => new Date();
  assert.equal(await offline.draftless("status"), 0);
  assert.doesNotMatch(offline.output.out + offline.output.err, /新版本|没网/);
  // 没问到也记下：一天之内不再每看一次状态都等它
  await offline.draftless("status");
  assert.equal(offline.updates.checks.length, 1);

  forgetUpdateCheck();
  outside = mkdtempSync(join(tmpdir(), "sm-src-"));
  const source = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0", packageDir: outside });
  await source.draftless("status");
  assert.deepEqual(source.updates.checks, []);
});

test("status --json：带上有没有新版本（newVersion，没有是 null）", async () => {
  installed();
  const newer = harness({ daemon: fakeDaemon({ running: READY }), latest: "v0.2.0" });
  await newer.draftless("status", "--json");
  assert.equal(JSON.parse(newer.output.out).newVersion, "0.2.0");
  forgetUpdateCheck();
  const same = harness({ daemon: fakeDaemon({ running: READY }) });
  await same.draftless("status", "--json");
  assert.equal(JSON.parse(same.output.out).newVersion, null);
});

// ---------- key ----------

test("key：没在运行就先启动，问一把，存好", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    afterStart: NO_KEY,
    saveKey: (key) => {
      saved.push(key);
      return { ok: true };
    },
  });
  const { draftless, output } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await draftless("key"), 0);
  assert.deepEqual(daemon.calls.slice(0, 2), ["start", "set-key"]);
  assert.deepEqual(saved, ["AIza-new"]);
  assert.match(output.out, /已保存，验证通过/);
});

test("key：验证不过时说明原因，以非零退出，不反复问", async () => {
  const daemon = fakeDaemon({
    running: READY,
    saveKey: () => ({ ok: false, problem: "连不上 Gemini，检查网络后再试" }),
  });
  const { draftless, output, asked } = harness({ daemon, secrets: ["AIza-new"] });
  assert.equal(await draftless("key"), 1);
  assert.equal(asked.length, 1);
  assert.match(output.err, /连不上 Gemini/);
});

test("key：什么都没读到时不去打扰后台应用", async () => {
  const daemon = fakeDaemon({ running: READY });
  const { draftless, output } = harness({ daemon, secrets: [""] });
  assert.equal(await draftless("key"), 1);
  assert.deepEqual(daemon.calls, []);
  assert.match(output.err, /没有读到 key/);
});

test("key：从管道喂进来的内容样子不对（比如多行）：不启动、不发给后台，内容不出现在输出里", async () => {
  const { draftless, output, daemon } = harness({ secrets: ["line-one-SECRET\nline-two-SECRET"] });
  assert.equal(await draftless("key"), 1);
  assert.deepEqual(daemon.calls, []);
  assert.match(output.err, /这把 key 里有空格或换行/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("key 后面直接跟着一把 key：不照做，也不把它再打一遍，提醒这样写会进 shell 历史", async () => {
  const { draftless, output, daemon, asked } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("key", "AIza-typed-SECRET"), 2);
  assert.deepEqual(daemon.calls, []);
  assert.equal(asked.length, 0);
  assert.match(output.err, /历史/);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
});

test("key --forget：删掉存着的那一份；在运行的话让它也忘掉", async () => {
  // Windows 上只有一份：密文由当前用户的 DPAPI 加密，App 和命令行共用同一个文件
  writeFileSync(keyFile(paths, "gemini"), "密文");
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.draftless("key", "--forget"), 0);
  assert.deepEqual(running.daemon.calls, ["forget-key"]);
  assert.equal(existsSync(keyFile(paths, "gemini")), false);

  writeFileSync(keyFile(paths, "gemini"), "密文");
  const idle = harness();
  assert.equal(await idle.draftless("key", "--forget"), 0);
  assert.equal(existsSync(keyFile(paths, "gemini")), false);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /已经删掉/);
});

// ---------- 设置 ----------

test("config：列出每一项和文件位置", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("config"), 0);
  assert.match(output.out, /hotkey\s+right_alt/);
  // Windows 的路径里全是反斜杠，当正则用之前要先转义
  const literal = paths.settingsFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(output.out, new RegExp(literal));
});

test("config set：存进文件；在运行的话重启让它生效", async () => {
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  // 旧名字（fn 是 macOS 版的）当输入也认，写进文件的是 Windows 版的新 id
  assert.equal(await draftless("config", "set", "hotkey", "fn"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { hotkey: "right_shift" });
  assert.deepEqual(daemon.calls.slice(0, 2), ["stop", "start"]);
  assert.match(output.out, /hotkey 改成了 right_shift/);
  assert.match(output.out, /已经生效/);

  const idle = harness();
  assert.equal(await idle.draftless("config", "set", "thinking", "low"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /下次启动生效/);
});

test("config set：重启之后 Gemini 不认这个值（比如模型名写错）：不说“已经生效”，说原因和怎么撤回", async () => {
  const daemon = fakeDaemon({ running: READY, afterStart: WRONG_MODEL });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("config", "set", "model", "gemini-nope"), 1);
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.err, /gemini-nope is not found/);
  assert.match(output.err, /draftless config unset model/);
});

test("config set：重启时没连上 Gemini，新设置对不对还不知道：不说“已经生效”", async () => {
  const unverified = { ...READY, key: { ...READY.key, verified: false } };
  const { draftless, output } = harness({ daemon: fakeDaemon({ running: READY, afterStart: unverified }) });
  assert.equal(await draftless("config", "set", "model", "gemini-next"), 0);
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.out, /还没验证.*draftless status/);
});

test("config set：还没启动过就先改设置时，把家目录和 run 建出来", async () => {
  rmSync(dir, { recursive: true });
  const { draftless } = harness();
  assert.equal(await draftless("config", "set", "hotkey", "right_win"), 0);
  // macOS 版这一步会把目录设成 0o700；Windows 上 %USERPROFILE% 下的目录默认只有本人和管理员进得去，
  // 没有这一位可设（ensureHome 只建目录和 run）
  assert.ok(existsSync(paths.home));
  assert.ok(existsSync(join(paths.home, "run")));
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { hotkey: "right_win" });
});

test("config set：填错时说能填什么，不动文件，以 2 退出", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("config", "set", "hotkey", "caps_lock"), 2);
  assert.match(output.err, /right_alt \/ right_ctrl \/ right_shift \/ right_win/);
  assert.equal(existsSync(paths.settingsFile), false);
  assert.equal(await draftless("config", "set", "hotkey"), 2);
  assert.equal(await draftless("config", "dance"), 2);
});

test("config set：这一项正被环境变量盖着时提醒一句", async () => {
  const { draftless, output } = harness({ env: { DRAFTLESS_HOTKEY: "right_command" } });
  assert.equal(await draftless("config", "set", "hotkey", "fn"), 0);
  assert.match(output.out, /DRAFTLESS_HOTKEY/);
});

test("config set 是不检查的后门：模式那一层管的几项照写，说平时用哪个命令换；不在那种模式里的说切过去才用上", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("config", "set", "transcriber", "sensevoice-small-q8"), 0);
  assert.equal(saved("transcriber"), "sensevoice-small-q8");
  assert.match(output.out, /平时用 draftless transcriber 换.*config set 不检查/);
  assert.match(output.out, /现在是 native 模式，这一项切到 local 模式时才用上/);

  const native = harness();
  assert.equal(await native.draftless("config", "set", "model", "openai"), 0);
  assert.match(native.output.out, /平时用 draftless model 换/);
  assert.doesNotMatch(native.output.out, /才用上/);

  // 只有 config set 能改的几项不提别的命令
  const plain = harness();
  assert.equal(await plain.draftless("config", "set", "thinking", "low"), 0);
  assert.doesNotMatch(plain.output.out, /平时用|才用上/);
  assert.equal(await plain.draftless("config", "set", "hotkey", "fn"), 0);
  assert.doesNotMatch(plain.output.out, /平时用|才用上/);
});

test("config set 把 local 的第一跳改成没下载的：重启后说还没下载、怎么下，不替用户下", async () => {
  const missing = { ...LOCAL_READY, localModel: { state: "missing", model: "qwen3-asr-0.6b-q8" } };
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: LOCAL_READY, afterStart: missing }) });
  assert.equal(await draftless("config", "set", "transcriber", "qwen3-asr-0.6b-q8"), 0);
  assert.match(
    output.out,
    /Qwen3-ASR 0\.6B \(Q8_0\) 还没下载：先运行 draftless transcriber download qwen3-asr-0\.6b-q8/,
  );
  assert.ok(!daemon.calls.includes("download-model"));
});

test("config unset：回到默认值", async () => {
  const { draftless, output } = harness();
  await draftless("config", "set", "hotkey", "fn");
  assert.equal(await draftless("config", "unset", "hotkey"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), {});
  assert.match(output.out, /hotkey 回到了默认值 right_alt/);
});

// ---------- 主题 ----------

test("theme：列出有哪几套，标出现在用的是哪套、怎么换", async () => {
  const { draftless, output, daemon } = harness();
  assert.equal(await draftless("theme"), 0);
  assert.match(output.out, /● ink\s+墨/);
  assert.match(output.out, / {4}cinnabar\s+朱砂/);
  assert.match(output.out, / {4}indigo\s+靛青/);
  assert.match(output.out, /现在用的是墨（ink）.*默认/);
  assert.match(output.out, /draftless theme cinnabar/);
  assert.deepEqual(daemon.calls, []);
});

test("theme <名字>：存进设置；在运行的话让它当场换，不重启；写 id 或写中文名都行", async () => {
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("theme", "朱砂"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { theme: "cinnabar" });
  assert.deepEqual(daemon.calls, ["reload-theme"]);
  assert.match(output.out, /主题换成了朱砂（cinnabar）/);
  assert.match(output.out, /已经生效/);

  assert.equal(await draftless("theme"), 0);
  assert.match(output.out, /● cinnabar\s+朱砂/);
  assert.match(output.out, /现在用的是朱砂（cinnabar）.*存在设置文件里/);

  const idle = harness();
  assert.equal(await idle.draftless("theme", "indigo"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /下次启动生效/);
});

test("theme：没有的那一套不存，说有哪几套，以 2 退出；多写了参数也是", async () => {
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("theme", "neon"), 2);
  assert.match(output.err, /ink \/ cinnabar \/ indigo/);
  assert.equal(existsSync(paths.settingsFile), false);
  assert.equal(await draftless("theme", "ink", "cinnabar"), 2);
  assert.deepEqual(daemon.calls, []);
});

test("theme：环境变量盖着时提醒；正在运行的那个带着环境变量启动的话，照实说它用的还是哪套", async () => {
  const daemon = fakeDaemon({ running: READY, reloadTheme: () => ({ theme: "indigo" }) });
  const { draftless, output } = harness({ daemon, env: { DRAFTLESS_THEME: "indigo" } });
  assert.equal(await draftless("theme", "cinnabar"), 0);
  assert.match(output.out, /环境变量 DRAFTLESS_THEME 现在设着/);
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.out, /用的还是靛青（indigo）.*DRAFTLESS_THEME/);
});

test("theme：正在运行的是不认识这条命令的旧版本：设置照存，说重启之后才换", async () => {
  const daemon = fakeDaemon({
    running: READY,
    reloadTheme: () => {
      throw new Error('不认识的命令："reload-theme"');
    },
  });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("theme", "cinnabar"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { theme: "cinnabar" });
  assert.doesNotMatch(output.out, /已经生效/);
  assert.match(output.out, /旧版本.*draftless restart/);
});

test("config set theme / config unset theme：和 theme 命令一样当场换，不重启", async () => {
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("config", "set", "theme", "indigo"), 0);
  assert.deepEqual(daemon.calls, ["reload-theme"]);
  assert.match(output.out, /theme 改成了 indigo/);
  assert.match(output.out, /已经生效/);
  assert.equal(await draftless("config", "unset", "theme"), 0);
  assert.deepEqual(daemon.calls, ["reload-theme", "reload-theme"]);
  assert.match(output.out, /theme 回到了默认值 ink/);
});

// ---------- 界面语言 ----------

test("英文：帮助、面板、用错了时的说法都是英文的", async () => {
  const { draftless, output } = harness({ daemon: fakeDaemon({ running: READY }), locale: "en" });
  assert.equal(await draftless("help"), 0);
  assert.match(output.out, /^draftless: press a hotkey, speak/);
  assert.match(output.out, /draftless theme <name> +Switch theme \(ink Ink \/ cinnabar Cinnabar \/ indigo Indigo\)/);
  assert.match(output.out, /latest 20 by default/);

  assert.equal(await draftless("status"), 0);
  assert.match(output.out, /draftless 0\.1\.0 · running/);
  assert.match(output.out, /press Right Alt to start talking/);
  assert.match(output.out, /Permissions +Microphone ✓ {3}Keyboard hook ✓ {3}Click interception ✓/);
  assert.match(output.out, /Model +Gemini gemini-3\.6-flash \(MINIMAL\)/);

  assert.equal(await draftless("frobnicate"), 2);
  assert.match(output.err, /There's no command called frobnicate\.\nRun draftless help to see all commands\./);
  assert.doesNotMatch(output.out + output.err, /[\u4e00-\u9fff]/);
});

test("英文：有新版本的提醒、update 说的话", async () => {
  installed();
  const { draftless, output } = harness({
    daemon: fakeDaemon({ running: READY }),
    locale: "en",
    latest: "v0.2.0",
    env: { DRAFTLESS_INSTALL_BASE: INSTALL_BASE },
  });
  assert.equal(await draftless("status"), 0);
  assert.match(output.out, /draftless 0\.2\.0 is out \(you have 0\.1\.0\): run draftless update\./);
  assert.equal(await draftless("update"), 0);
  assert.match(output.out, /draftless 0\.2\.0 is out \(you have 0\.1\.0\): run draftless update\./);
  assert.match(output.out, /To update: download the new release from https:\/\/dl\.example\.com\/draftless/);
  assert.doesNotMatch(output.out + output.err, /[\u4e00-\u9fff]/);
});

test("英文：后台报上来的原因（msg）按命令行的语言翻；0.5 以前的后台报的中文原话照原样", async () => {
  const problem = { key: "model.rejected", params: { provider: "Gemini", said: "models/gemini-nope is not found" } };
  const fresh = {
    ...READY,
    key: { state: "rejected", source: "stored", cause: "other", problem },
    summary: {
      ready: false,
      missing: [{ key: "setup.missing.check", params: { provider: "Gemini" } }],
      blocker: null,
      degraded: null,
    },
  };
  const { draftless, output } = harness({ daemon: fakeDaemon({ running: fresh }), locale: "en" });
  assert.equal(await draftless("status"), 1);
  assert.match(output.out, /Missing: Gemini check\./);
  assert.match(output.out, /Check failed: Gemini rejected the request: models\/gemini-nope is not found\./);

  const old = harness({ daemon: fakeDaemon({ running: WRONG_MODEL }), locale: "en" });
  assert.equal(await old.draftless("status"), 1);
  assert.match(old.output.out, /Missing: Gemini 验证\./);
});

test("config set language：存进设置；在运行的话让它当场换，不重启；没在运行就下次启动生效", async () => {
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("config", "set", "language", "zh_cn"), 0);
  assert.deepEqual(JSON.parse(readFileSync(paths.settingsFile, "utf8")), { language: "zh-CN" });
  assert.deepEqual(daemon.calls, ["reload-language"]);
  assert.match(output.out, /language 改成了 zh-CN。\n已经生效，不用重启/);
  assert.equal(await draftless("config", "unset", "language"), 0);
  assert.deepEqual(daemon.calls, ["reload-language", "reload-language"]);
  assert.match(output.out, /language 回到了默认值 system/);

  const idle = harness();
  assert.equal(await idle.draftless("config", "set", "language", "en"), 0);
  assert.deepEqual(idle.daemon.calls, []);
  assert.match(idle.output.out, /下次启动生效/);

  assert.equal(await idle.draftless("config", "set", "language", "fr"), 2);
  assert.match(idle.output.err, /system \/ en \/ zh-CN/);
});

test("config set language：环境变量盖着时照实说它用的还是哪种；旧版本的后台说要重启", async () => {
  const pinned = fakeDaemon({ running: READY, reloadLanguage: () => ({ language: "en" }) });
  const { draftless, output } = harness({ daemon: pinned, env: { DRAFTLESS_LANGUAGE: "en" } });
  assert.equal(await draftless("config", "set", "language", "zh-CN"), 0);
  assert.match(output.out, /环境变量 DRAFTLESS_LANGUAGE 现在设着/);
  assert.match(output.out, /用的还是English：.*DRAFTLESS_LANGUAGE/);

  const legacy = fakeDaemon({
    running: READY,
    reloadLanguage: () => {
      throw new Error('不认识的命令："reload-language"');
    },
  });
  const old = harness({ daemon: legacy });
  assert.equal(await old.draftless("config", "set", "language", "en"), 0);
  assert.match(old.output.out, /旧版本.*draftless restart/);
});

test("面板里写着界面语言：跟随系统时带上实际用的那种", async () => {
  const running = { ...READY, language: "system", locale: "en" };
  const { draftless, output } = harness({ daemon: fakeDaemon({ running }) });
  assert.equal(await draftless("status"), 0);
  assert.match(output.out, /语言 +跟随系统 · English/);
  const english = harness({
    daemon: fakeDaemon({ running: { ...READY, language: "zh-CN", locale: "zh-CN" } }),
    locale: "en",
  });
  assert.equal(await english.draftless("status"), 0);
  assert.match(english.output.out, /Language +简体中文/);
});

test("面板里写着正在用的主题", async () => {
  const { draftless, output } = harness({ daemon: fakeDaemon({ running: { ...READY, theme: "cinnabar" } }) });
  assert.equal(await draftless("status"), 0);
  assert.match(output.out, /主题\s+朱砂（cinnabar）/);
});

test("设置文件被改坏时，任何命令都先把这件事说清楚", async () => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(paths.settingsFile, "{ 坏了");
  const { draftless, output, daemon } = harness();
  assert.equal(await draftless(), 2);
  assert.match(output.err, /settings\.json/);
  assert.deepEqual(daemon.calls, []);
});

// ---------- 历史 ----------

function seedHistory() {
  const history = openHistory(paths.historyDb);
  const entry = (id, createdAt, refinedText) => ({
    id,
    status: "completed",
    refinedText,
    error: null,
    duration: 4,
    audioLocalPath: null,
    createdAt,
  });
  history.add(entry("a", "2026-10-12T01:05:00.000Z", "昨天说的"));
  history.add(entry("b", "2026-10-13T06:32:00.000Z", "今天说的"));
  history.close();
}

test("history：一次都没用过时说一句，不凭空建库", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("history"), 0);
  assert.match(output.out, /还没有听写记录/);
  assert.equal(existsSync(paths.historyDb), false);
});

test("history：按天分组列出来；-n 限制条数；后台应用在不在运行都能看", async () => {
  seedHistory();
  const all = harness();
  assert.equal(await all.draftless("history"), 0);
  assert.match(all.output.out, /今天 · 10月13日\n {2}14:32 {2}今天说的\n\n昨天 · 10月12日\n {2}09:05 {2}昨天说的/);
  assert.deepEqual(all.daemon.calls, []);

  const one = harness();
  assert.equal(await one.draftless("history", "-n", "1"), 0);
  assert.doesNotMatch(one.output.out, /昨天说的/);
  assert.match(one.output.out, /显示最近 1 条，共 2 条/);
});

test("history --json：原样给出记录", async () => {
  seedHistory();
  const { draftless, output } = harness();
  await draftless("history", "--json");
  assert.deepEqual(
    JSON.parse(output.out).map((entry) => entry.refinedText),
    ["今天说的", "昨天说的"],
  );
});

test("history -n 要是正整数", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("history", "-n", "abc"), 2);
  assert.match(output.err, /-n/);
});

test("有历史时面板里带上今天和累计的数；记过账的话带上花了多少钱", async () => {
  seedHistory();
  const before = harness({ daemon: fakeDaemon({ running: READY }) });
  await before.draftless("status");
  assert.match(before.output.out, /累计\s+2 次 · 8 字 · 8 秒\n/);

  seedCall();
  const after = harness({ daemon: fakeDaemon({ running: READY }) });
  await after.draftless("status");
  assert.match(after.output.out, /累计\s+2 次 · 8 字 · 8 秒 · \$0\.0011\n/);
  assert.match(after.output.out, /draftless usage/);
});

// ---------- 用量 ----------

/** 记一笔账：今天那句话调了一次 Gemini */
function seedCall() {
  const history = openHistory(paths.historyDb);
  history.addCall({
    purpose: "dictation",
    audioId: "b",
    provider: "gemini",
    model: "gemini-3.6-flash",
    inputTokens: 1390,
    audioTokens: 25,
    cachedTokens: 0,
    outputTokens: 4,
    thinkingTokens: 0,
    costUsd: 0.0011,
    latencyMs: 1700,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.close();
}

test("usage：一次都没用过时说一句，不凭空建库", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("usage"), 0);
  assert.match(output.out, /还没有用量记录/);
  assert.equal(existsSync(paths.historyDb), false);
});

test("usage：列出花了多少钱、多少 token、模型多久回话；后台应用不在运行也能看", async () => {
  seedHistory();
  seedCall();
  const { draftless, output, daemon } = harness();
  assert.equal(await draftless("usage"), 0);
  assert.match(output.out, /累计\s+\$0\.0011\s+1\.39K\s+1\s+一般 1\.7 秒，慢时 1\.7 秒/);
  assert.match(output.out, /Gemini gemini-3\.6-flash/);
  assert.deepEqual(daemon.calls, []);
});

test("usage --json：原样给出报表；还没有历史库时是 null", async () => {
  const empty = harness();
  await empty.draftless("usage", "--json");
  assert.equal(JSON.parse(empty.output.out), null);

  seedHistory();
  seedCall();
  const { draftless, output } = harness();
  await draftless("usage", "--json");
  const report = JSON.parse(output.out);
  assert.equal(report.total.costUsd, 0.0011);
  assert.equal(report.total.tokens, 1394);
  assert.deepEqual(report.total.latency, { medianMs: 1700, p90Ms: 1700 });
  assert.equal(report.models[0].model, "gemini-3.6-flash");
});

test("usage 不收别的参数", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("usage", "today"), 2);
  assert.match(output.err, /draftless usage/);
});

// ---------- 卸载 ----------

/** 摆出装好并用过之后的样子：程序在 <家目录>\app，运行环境在 <家目录>\runtime，数据也在这一个目录里 */
function seedInstalled() {
  for (const file of [
    join(paths.appDir, "package.json"),
    join(paths.home, "runtime", "Draftless.exe"),
    join(paths.home, "bin", "draftless.cmd"),
    paths.settingsFile,
    keyFile(paths, "gemini"),
    paths.historyDb,
    join(paths.recordingsDir, "a.webm"),
    join(paths.modelsDir, "qwen3-asr-0.6b-q8", ".complete.json"),
    paths.logFile,
    join(paths.cacheDir, "GPUCache", "data_0"),
  ]) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "x");
  }
}

test("uninstall --yes：停掉后台，把家目录整个删掉，并说清系统里还留着什么", async () => {
  seedInstalled();
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("uninstall", "--yes"), 0);
  assert.deepEqual(daemon.calls, ["stop"]);
  assert.equal(existsSync(paths.home), false);
  assert.match(output.out, /已经卸载/);
  assert.match(output.out, /删掉了/);
  // Windows 上没有钥匙串里的一条可删，也没有安装脚本记的链接清单：剩下要自己收拾的只有麦克风权限
  assert.match(output.out, /麦克风权限没有动/);
  assert.doesNotMatch(output.out, /钥匙串|com\.github\.Electron/);
});

test("uninstall --keep-data：只删程序、运行环境、日志和缓存，设置、key、历史、录音、模型都留着", async () => {
  seedInstalled();
  const { draftless, output } = harness();
  assert.equal(await draftless("uninstall", "--keep-data", "--yes"), 0);
  for (const kept of [
    paths.settingsFile,
    keyFile(paths, "gemini"),
    paths.historyDb,
    join(paths.recordingsDir, "a.webm"),
    join(paths.modelsDir, "qwen3-asr-0.6b-q8", ".complete.json"),
  ]) {
    assert.equal(existsSync(kept), true, kept);
  }
  for (const gone of [paths.appDir, join(paths.home, "runtime"), paths.cacheDir, dirname(paths.logFile)]) {
    assert.equal(existsSync(gone), false, gone);
  }
  assert.match(output.out, /留着/);
});

// macOS 版的"运行环境在别处留的那个共用的偏好文件（com.github.Electron.plist），有的话提一句、不删"
// 删掉了：Windows 版的 uninstall 不再看它（src/cli/commands/uninstall.mjs 只列麦克风权限和源码目录）。

test("uninstall：先说清楚要删什么再问一句；不答应就什么都不动", async () => {
  seedInstalled();
  const declined = harness({ daemon: fakeDaemon({ running: READY }), confirms: [false] });
  assert.equal(await declined.draftless("uninstall"), 1);
  assert.equal(declined.confirmed.length, 1);
  assert.match(declined.output.out, /历史和录音/);
  assert.deepEqual(declined.daemon.calls, []);
  assert.equal(existsSync(paths.historyDb), true);

  const agreed = harness({ confirms: [true] });
  assert.equal(await agreed.draftless("uninstall"), 0);
  assert.equal(existsSync(paths.home), false);
});

test("uninstall：不在终端里运行又没给 --yes 时不动手", async () => {
  seedInstalled();
  const { draftless, output, confirmed } = harness({ interactive: false });
  assert.equal(await draftless("uninstall"), 2);
  assert.equal(confirmed.length, 0);
  assert.match(output.err, /--yes/);
  assert.equal(existsSync(paths.historyDb), true);
});

test("uninstall：后台停不掉时不往下删（它还开着那些文件）", async () => {
  seedInstalled();
  const daemon = fakeDaemon({ running: READY });
  daemon.stop = async () => {
    throw new Error("draftless 停不掉（进程号 4321）");
  };
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("uninstall", "--yes"), 1);
  assert.match(output.err, /停不掉/);
  // 程序还在：它还开着那些文件，这时候删不干净
  assert.equal(existsSync(paths.appDir), true);
});

// ---------- 其余 ----------

test("logs：把日志文件的最后几行打出来，-f 一直跟着；还没有日志时照实说", async () => {
  const empty = harness();
  assert.equal(await empty.draftless("logs"), 0);
  assert.match(empty.output.out, /还没有日志/);

  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(paths.logFile, "{}\n");
  const { draftless, tails } = harness();
  await draftless("logs");
  await draftless("logs", "-n", "5", "-f");
  assert.deepEqual(tails, [
    ["-n", "40", paths.logFile],
    ["-n", "5", "-f", paths.logFile],
  ]);
});

test("settings：在运行时打开设置；没在运行时说先启动", async () => {
  const running = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await running.draftless("settings"), 0);
  assert.deepEqual(running.daemon.calls, ["show-settings"]);
  const idle = harness();
  assert.equal(await idle.draftless("settings"), 1);
  assert.match(idle.output.err, /draftless/);
});

test("help 和 --help 列出全部命令；--version 给版本号", async () => {
  for (const argv of [["help"], ["--help"], ["-h"]]) {
    const { draftless, output } = harness();
    assert.equal(await draftless(...argv), 0);
    for (const command of [
      "start",
      "stop",
      "restart",
      "status",
      "key",
      "config",
      "history",
      "usage",
      "logs",
      "settings",
      "theme",
      "uninstall",
    ]) {
      assert.match(output.out, new RegExp(`draftless ${command}`));
    }
  }
  const { draftless, output } = harness();
  assert.equal(await draftless("--version"), 0);
  assert.equal(output.out.trim(), "0.1.0");
});

test("不认识的命令和不认识的选项：说一声并指向 help，以 2 退出", async () => {
  const { draftless, output, daemon } = harness();
  assert.equal(await draftless("dance"), 2);
  assert.match(output.err, /dance/);
  assert.match(output.err, /draftless help/);
  assert.equal(await draftless("status", "--loud"), 2);
  assert.deepEqual(daemon.calls, []);
});

// ---------- 模型 ----------

/** 假装以前给 OpenAI 存过一把 key */
const haveOpenAIKey = () => writeFileSync(keyFile(paths, "openai"), "密文");
const savedModel = () => resolveSettings({ file: paths.settingsFile, env: {} }).model.value;

test("model：列出有哪几家、各用哪个模型、key 有没有、现在用的哪个", async () => {
  haveStoredKey();
  const { draftless, output } = harness({ env: { OPENAI_API_KEY: "sk-env" } });
  assert.equal(await draftless("model"), 0);
  assert.match(output.out, /● gemini\s+Gemini\s+gemini-3\.6-flash\s+key 存着/);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini（默认）\s+key 来自环境变量 OPENAI_API_KEY/);
});

test("model <厂商>：有它的 key 就直接换；在运行的话让它当场换，不重启", async () => {
  haveOpenAIKey();
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("model", "openai"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-model", params: { model: "openai/gpt-audio-mini" } });
  assert.match(output.out, /换成了 OpenAI 的 gpt-audio-mini/);
  assert.ok(!daemon.calls.includes("stop"));
  assert.match(output.out, /已经换上，不用重启/);

  const notRunning = harness();
  assert.equal(await notRunning.draftless("model", "openai/gpt-audio-1.5"), 0);
  assert.equal(savedModel(), "openai/gpt-audio-1.5");
  assert.match(notRunning.output.out, /下次启动生效/);
});

test("model <厂商>：还没有它的 key 时先问；问到的交给后台验证，存进它那一份，再换", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { draftless, output, asked } = harness({ daemon, secrets: ["sk-my-secret"] });
  assert.equal(await draftless("model", "openai"), 0);
  assert.deepEqual(saved, [{ key: "sk-my-secret", provider: "openai" }]);
  // 说的是 OpenAI 的 key、去哪申请
  assert.match(asked[0], /OpenAI API key/);
  assert.match(asked[0], /platform\.openai\.com\/api-keys/);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-model", params: { model: "openai/gpt-audio-mini" } });
  assert.ok(!(output.out + output.err).includes("sk-my-secret"));
});

test("model <厂商>：没有它的 key 又没法问（不在终端里）、或者问了没给：不换，说清先做什么", async () => {
  const quiet = harness({ interactive: false });
  assert.equal(await quiet.draftless("model", "openai"), 1);
  assert.match(quiet.output.err, /还没有 OpenAI 的 key.*draftless key openai/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  const declined = harness({ daemon: fakeDaemon({ running: READY }), secrets: [""] });
  assert.equal(await declined.draftless("model", "openai"), 1);
  assert.match(declined.output.err, /没有换/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  const rejected = harness({
    daemon: fakeDaemon({ running: READY, saveKey: () => ({ ok: false, problem: "这把 key 无效" }) }),
    secrets: ["sk-bad", "", ""],
  });
  assert.equal(await rejected.draftless("model", "openai"), 1);
  assert.match(rejected.output.err, /这把 key 没有通过：这把 key 无效/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");
});

test("model：不认识的厂商、写错的模型名，以 2 退出并说能填什么；写的是润色的那家时指到 local 模式", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("model", "nope"), 2);
  assert.match(output.err, /gemini \/ openai/);
  assert.equal(await draftless("model", "deepseek"), 2);
  assert.match(output.err, /DeepSeek.*local.*draftless polish deepseek/);
  assert.equal(await draftless("model", "openai/gpt audio"), 2);
  assert.equal(await draftless("model", "openai", "extra"), 2);
});

test("model check：查现在用的那个，说能不能用、key 从哪来、来回多久", async () => {
  haveStoredKey();
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("model", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-model", params: { model: "gemini/gemini-3.6-flash" } });
  assert.match(output.out, /能用：Gemini 的 gemini-3\.6-flash.*0\.8 秒/);
});

test("model check <模型>：查别的；不能用时说原因和下一步，以 1 退出", async () => {
  const missing = harness({
    daemon: fakeDaemon({
      running: READY,
      checkModel: () => ({ ok: false, cause: "missing", problem: "还没有 OpenAI 的 key：运行 draftless key openai" }),
    }),
  });
  assert.equal(await missing.draftless("model", "check", "openai"), 1);
  assert.deepEqual(missing.daemon.requests.at(-1).params, { model: "openai/gpt-audio-mini" });
  assert.match(missing.output.err, /不能用：还没有 OpenAI 的 key/);

  const wrong = harness({
    daemon: fakeDaemon({
      running: READY,
      checkModel: () => ({ ok: false, cause: "other", problem: "OpenAI 没有这个模型，或者这把 key 用不了它：…" }),
    }),
  });
  assert.equal(await wrong.draftless("model", "check", "openai/gpt-audio-9"), 1);
  assert.match(wrong.output.err, /不能用：OpenAI 没有这个模型/);
});

test("model check：没在运行就先启动；正在运行的是旧版本、不认识这条命令时说要重启", async () => {
  const fresh = harness();
  assert.equal(await fresh.draftless("model", "check"), 0);
  assert.deepEqual(fresh.daemon.calls, ["start", "check-model"]);

  const old = fakeDaemon({ running: READY });
  old.request = async (cmd) => {
    throw new Error(`不认识的命令：${cmd}`);
  };
  const outdated = harness({ daemon: old });
  assert.equal(await outdated.draftless("model", "check"), 1);
  assert.match(outdated.output.err, /旧版本.*draftless restart/);
});

// ---------- 每家一把 key ----------

test("key <厂商>：问的是那一家的 key，存进它那一份；不是正在用的那家时提示怎么换过去（按它在哪一层）", async () => {
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { draftless, output, asked } = harness({ daemon, secrets: ["sk-new"] });
  assert.equal(await draftless("key", "openai"), 0);
  assert.deepEqual(saved, [{ key: "sk-new", provider: "openai" }]);
  assert.match(asked[0], /OpenAI API key/);
  assert.match(output.out, /要换成用它：draftless model openai/);

  const deepseek = harness({ daemon: fakeDaemon({ running: READY }), secrets: ["sk-ds"] });
  assert.equal(await deepseek.draftless("key", "deepseek"), 0);
  assert.match(deepseek.asked[0], /DeepSeek API key/);
  // 录音不发给它，只发转出来的文字
  assert.match(deepseek.asked[0], /本机/);
  assert.match(deepseek.asked[0], /platform\.deepseek\.com/);
  // 现在是 native 模式：polish 只在 local 里能用，提示连模式一起切
  assert.match(deepseek.output.out, /要换成用它：draftless mode local --polish deepseek/);

  const fromLocal = harness({ daemon: fakeDaemon({ running: LOCAL_READY }), secrets: ["sk-ds", "sk-oa"] });
  assert.equal(await fromLocal.draftless("key", "openai"), 0);
  assert.match(fromLocal.output.out, /要换成用它：draftless mode native --model openai/);
});

test("key 后面写的不是厂商名：多半是把 key 本身写在了命令里，不照做也不把它打出来", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("key", "sk-proj-SECRET"), 2);
  assert.doesNotMatch(output.out + output.err, /SECRET/);
  assert.match(output.err, /shell 的历史记录/);
});

test("key --forget <厂商>：只删那一家的；不写就删正在用的那家", async () => {
  haveStoredKey();
  haveOpenAIKey();
  const { draftless, output, daemon } = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await draftless("key", "--forget", "openai"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "forget-key", params: { provider: "openai" } });
  // 每家一个文件，只删点名的那一家
  assert.equal(existsSync(keyFile(paths, "openai")), false);
  assert.equal(existsSync(keyFile(paths, "gemini")), true);
  assert.match(output.out, /OpenAI 的 key 已经删掉/);
});

test("正在用 OpenAI 时第一次启动：问的是 OpenAI 的 key", async () => {
  writeFileSync(paths.settingsFile, JSON.stringify({ model: "openai/gpt-audio-mini" }));
  const daemon = fakeDaemon({ afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" } });
  const { draftless, asked } = harness({ daemon, secrets: ["sk-first"] });
  assert.equal(await draftless(), 0);
  assert.match(asked[0], /OpenAI API key/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-first",
    provider: "openai",
  });
});

test("改了模型、重启之后发现那家没有 key：说清还差它，不说已经生效", async () => {
  const daemon = fakeDaemon({
    running: READY,
    afterStart: { ...NO_KEY, provider: "openai", model: "openai/gpt-audio-mini" },
  });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("config", "set", "model", "openai"), 1);
  assert.match(output.err, /还没有 OpenAI 的 key.*draftless key openai/);
  assert.doesNotMatch(output.out, /已经生效/);
});

test("改模型时 GEMINI_MODEL（旧名字）设着：提醒它盖着新值", async () => {
  haveOpenAIKey();
  const { draftless, output } = harness({ env: { GEMINI_MODEL: "gemini-3.5-flash" } });
  assert.equal(await draftless("model", "openai"), 0);
  assert.match(output.out, /环境变量 GEMINI_MODEL 现在设着/);
});

test("model：key 是启动后台时从环境变量给的（命令行这边没有）也照实写，不说成还没有", async () => {
  const fromEnv = { ...READY, key: { state: "ready", source: "env", problem: null, verified: true } };
  const { draftless, output } = harness({ daemon: fakeDaemon({ running: fromEnv }) });
  assert.equal(await draftless("model"), 0);
  assert.match(output.out, /● gemini\s+Gemini\s+gemini-3\.6-flash\s+key 来自环境变量 GEMINI_API_KEY/);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini（默认）\s+还没有 key/);
});

// ---------- 审查之后补的 ----------

/** 0.3 的后台应用：状态里没有 provider，也不认按厂商存、删 key */
const LEGACY_DAEMON = (() => {
  const { provider: _provider, ...rest } = READY;
  return { ...rest, model: "gemini-3.5-flash" };
})();

test("后台是 0.3 的：给别家存 key、删别家的 key 都先拦下，说要重启；不发请求、不删文件", async () => {
  haveStoredKey();
  haveOpenAIKey();
  const forget = harness({ daemon: fakeDaemon({ running: LEGACY_DAEMON }) });
  assert.equal(await forget.draftless("key", "--forget", "openai"), 1);
  assert.match(forget.output.err, /旧版本.*draftless restart/);
  assert.ok(!forget.daemon.calls.includes("forget-key"));
  assert.ok(existsSync(keyFile(paths, "openai")) && existsSync(keyFile(paths, "gemini")));

  const save = harness({ daemon: fakeDaemon({ running: LEGACY_DAEMON }), secrets: ["sk-new"] });
  assert.equal(await save.draftless("key", "openai"), 1);
  assert.ok(!save.daemon.calls.includes("set-key"));
  assert.equal(save.asked.length, 0);

  // Gemini 的 key 旧后台本来就会存
  const gemini = harness({ daemon: fakeDaemon({ running: LEGACY_DAEMON }), secrets: ["AIza-new"] });
  assert.equal(await gemini.draftless("key", "gemini"), 0);
});

/** 0.6 及以前的后台应用：状态里没有 mode，只认 Gemini 和 OpenAI 的 key */
const BEFORE_MODES_DAEMON = (() => {
  const { mode: _mode, ...rest } = READY;
  return rest;
})();

test("后台是 0.6 的：切 local 要给 DeepSeek 存 key 时先拦下，说要重启；不发请求、不切；OpenAI 的 key 照常存", async () => {
  haveModel();
  const daemon = fakeDaemon({ running: BEFORE_MODES_DAEMON });
  const { draftless, output, asked } = harness({ daemon, secrets: ["sk-ds"] });
  assert.equal(await draftless("mode", "local"), 1);
  assert.match(output.err, /旧版本.*DeepSeek.*draftless restart/);
  assert.ok(!daemon.calls.includes("set-key") && !daemon.calls.includes("set-mode"));
  assert.equal(saved("mode"), "native");
  // 先拦再问：不让人粘贴了 key 才听说存不了
  assert.equal(asked.length, 0);

  const openai = harness({ daemon: fakeDaemon({ running: BEFORE_MODES_DAEMON }), secrets: ["sk-openai"] });
  assert.equal(await openai.draftless("key", "openai"), 0);
  assert.ok(openai.daemon.calls.includes("set-key"));
});

test("换模型时那家的 key 被拒：不换，说原因，设置不动，以 1 退出", async () => {
  haveOpenAIKey();
  const daemon = fakeDaemon({
    running: READY,
    changeRoute: () => ({ ok: false, problem: "这把 key 无效，检查有没有复制完整" }),
  });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("model", "openai"), 1);
  assert.match(output.err, /没有换：这把 key 无效/);
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");
  assert.doesNotMatch(output.out, /已经换上/);
});

test("换模型时正在运行的是旧版本、不认识当场换：存进设置，重启让它生效（老路）", async () => {
  haveOpenAIKey();
  const old = fakeDaemon({ running: READY });
  const request = old.request;
  old.request = async (cmd, params) => {
    if (cmd === "set-model") throw new Error(`不认识的命令：${cmd}`);
    return request(cmd, params);
  };
  const { draftless, output } = harness({ daemon: old });
  assert.equal(await draftless("model", "openai"), 0);
  assert.equal(savedModel(), "openai/gpt-audio-mini");
  assert.deepEqual(old.calls.slice(-2), ["stop", "start"]);
  assert.match(output.out, /已经生效/);
});

test("装成应用的在运行：它的 key 存在它自己那一份里，看 key 有没有以它报的为准", async () => {
  const app = { ...READY, packaged: true, keys: { gemini: "stored", openai: "stored" } };
  const { draftless, output, asked } = harness({ daemon: fakeDaemon({ running: app }) });
  assert.equal(await draftless("model"), 0);
  assert.match(output.out, /openai\s+OpenAI\s+gpt-audio-mini（默认）\s+key 存着/);
  // 不再问一遍 key；装成应用的也能当场换，不用退出重开
  assert.equal(await draftless("model", "openai"), 0);
  assert.equal(asked.length, 0);
  assert.match(output.out, /已经换上，不用重启/);
});

test("英文时每个命令的输出里都没有漏翻的中文（用户自己说的话除外）", async () => {
  const history = openHistory(paths.historyDb);
  history.add({
    id: "a",
    status: "completed",
    refinedText: "Let's meet at 9:30.",
    error: null,
    duration: 4,
    audioLocalPath: null,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.add({
    id: "b",
    status: "failed",
    refinedText: "",
    error: null,
    duration: 75,
    audioLocalPath: null,
    createdAt: "2026-10-12T06:32:00.000Z",
  });
  history.addCall({
    purpose: "dictation",
    audioId: "a",
    provider: "gemini",
    model: "gemini-3.6-flash",
    inputTokens: 1390,
    audioTokens: 25,
    cachedTokens: 0,
    outputTokens: 4,
    thinkingTokens: 0,
    costUsd: 0.0011,
    latencyMs: 1700,
    createdAt: "2026-10-13T06:32:00.000Z",
  });
  history.addCall({
    purpose: "check",
    audioId: null,
    provider: "openai",
    model: "gpt-unknown",
    inputTokens: 10,
    audioTokens: 0,
    cachedTokens: 0,
    outputTokens: 1,
    thinkingTokens: 0,
    costUsd: null,
    latencyMs: 900,
    createdAt: "2026-10-13T06:33:00.000Z",
  });
  history.close();
  const missing = { ...NO_PERMISSIONS, summary: { ...NO_PERMISSIONS.summary, missing: [], blocker: null } };
  const commands = [
    [["status"], READY],
    [["status"], missing],
    [["status"], null],
    [["config"], READY],
    [["theme"], READY],
    [["model"], READY],
    [["usage"], null],
    [["history"], null],
    [["logs"], null],
    [["stop"], READY],
    [["settings"], null],
    [["key", "--forget", "openai"], READY],
    [["uninstall"], null],
    [["model", "nope"], READY],
    [["model", "deepseek"], READY],
    [["mode"], READY],
    [["mode", "local"], READY],
    [["mode", "cloud"], READY],
    [["transcriber"], READY],
    [["polish"], READY],
    [["polish", "custom/m"], READY],
    [["history", "extra"], null],
  ];
  for (const [argv, running] of commands) {
    const { draftless, output } = harness({ daemon: fakeDaemon({ running }), locale: "en", interactive: false });
    await draftless(...argv);
    assert.doesNotMatch(output.out + output.err, /[一-鿿]/, argv.join(" "));
  }
});

// ---------- 模式，和各模式里的模型 ----------

/** 假装以前给 DeepSeek 存过一把 key */
const haveDeepSeekKey = () => writeFileSync(keyFile(paths, "deepseek"), "密文");
const saved = (name) => resolveSettings({ file: paths.settingsFile, env: {} })[name].value;
/** 正在 local 模式的后台 */
const LOCAL_READY = {
  ...READY,
  provider: "deepseek",
  mode: "local",
  model: null,
  thinking: null,
  transcriber: "qwen3-asr-0.6b-q8",
  polish: "deepseek/deepseek-flash",
  localModel: { state: "ready", model: "qwen3-asr-0.6b-q8", backend: "MTL0" },
};

test("mode：列出两种模式、各自用的模型，现在用的打一个点，说怎么切、两种模式里各自怎么换模型", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("mode"), 0);
  assert.match(output.out, /● native\s+原生：录音直接交给模型\s+Gemini 的 gemini-3\.6-flash/);
  assert.match(output.out, /\n {4}local\s+本地转写，再交给模型润色\s+qwen3-asr-0\.6b-q8 → DeepSeek 的 deepseek-flash/);
  assert.match(output.out, /draftless mode local/);
  assert.match(output.out, /draftless model\b/);
  assert.match(output.out, /draftless transcriber/);
  assert.match(output.out, /draftless polish/);
});

test("mode <模式>：有那种模式要的 key 就让在运行的那个当场切，不重启", async () => {
  haveModel();
  haveDeepSeekKey();
  const daemon = fakeDaemon({ running: READY });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("mode", "local"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-mode", params: { mode: "local", changes: {} } });
  assert.ok(!daemon.calls.includes("stop"));
  assert.match(output.out, /切到了 local 模式：qwen3-asr-0\.6b-q8 → DeepSeek 的 deepseek-flash/);
  assert.match(output.out, /已经换上，不用重启/);
});

test("mode local：0.7.0 的后台切过去后自己下载模型，照它报的说一声，进度去哪看", async () => {
  haveDeepSeekKey();
  haveModel();
  const downloading = {
    ...LOCAL_READY,
    localModel: { state: "downloading", model: "qwen3-asr-0.6b-q8", received: 425, total: 850 },
  };
  const daemon = fakeDaemon({ running: READY });
  daemon.request = (
    ({ request }) =>
    async (cmd, params) => {
      const result = await request.call(daemon, cmd, params);
      if (cmd === "set-mode") daemon.current = downloading;
      return result;
    }
  )(daemon);
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("mode", "local"), 0);
  assert.match(output.out, /本地模型在后台下载（50%）.*draftless status/);
});

test("mode <模式>：还没有那种模式要的 key 时先问，拿要切过去的设置验证过存好，再切", async () => {
  haveModel();
  const saved = [];
  const daemon = fakeDaemon({
    running: READY,
    saveKey: (key, provider) => {
      saved.push({ key, provider });
      return { ok: true };
    },
  });
  const { draftless, asked, output } = harness({ daemon, secrets: ["sk-ds"] });
  assert.equal(await draftless("mode", "local"), 0);
  assert.deepEqual(saved, [{ key: "sk-ds", provider: "deepseek" }]);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-ds",
    provider: "deepseek",
    changes: { mode: "local" },
  });
  assert.match(asked[0], /DeepSeek API key/);
  assert.equal(daemon.requests.at(-1).cmd, "set-mode");
  assert.ok(!(output.out + output.err).includes("sk-ds"));
});

test("mode <模式>：没有 key 又没法问时不切，说先做什么；没在运行时存进设置、下次启动生效", async () => {
  haveModel();
  const quiet = harness({ interactive: false });
  assert.equal(await quiet.draftless("mode", "local"), 1);
  assert.match(quiet.output.err, /还没有 DeepSeek 的 key.*draftless key deepseek/);
  assert.equal(saved("mode"), "native");

  haveDeepSeekKey();
  const notRunning = harness();
  assert.equal(await notRunning.draftless("mode", "local"), 0);
  assert.equal(saved("mode"), "local");
  assert.match(notRunning.output.out, /下次启动生效/);
  assert.deepEqual(notRunning.daemon.calls, []);
});

test("mode：写错的模式以 2 退出并说能填什么；切没通过以 1 退出说原因", async () => {
  haveModel();
  const { draftless, output } = harness();
  assert.equal(await draftless("mode", "cloud"), 2);
  assert.match(output.err, /native \/ local/);

  haveDeepSeekKey();
  const refused = harness({
    daemon: fakeDaemon({ running: READY, changeRoute: () => ({ ok: false, problem: "DeepSeek 余额不足" }) }),
  });
  assert.equal(await refused.draftless("mode", "local"), 1);
  assert.match(refused.output.err, /没有换：DeepSeek 余额不足/);
});

test("在 local 模式时换 native 的模型：不能换，说先切回 native；不问 key、不发请求、不改设置", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { draftless, output, asked } = harness({ daemon, secrets: ["sk-x"] });
  assert.equal(await draftless("model", "openai"), 1);
  assert.match(output.err, /现在是 local 模式.*收音频的模型.*native 模式.*draftless mode native/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-model"));
  assert.equal(savedModel(), "gemini/gemini-3.6-flash");

  // 没在运行时看设置里的模式
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "local" }));
  const offline = harness();
  assert.equal(await offline.draftless("model", "openai"), 1);
  assert.match(offline.output.err, /现在是 local 模式/);
});

test("在 native 模式时换 local 的两跳：不能换，说先切到 local；列出来看可以，但标明现在用不上", async () => {
  const daemon = fakeDaemon({ running: READY });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("transcriber", "sensevoice-small-q8"), 1);
  assert.match(output.err, /现在是 native 模式.*本机转写模型（第一跳）.*local 模式.*draftless mode local/);
  assert.equal(await draftless("polish", "deepseek/deepseek-v4-pro"), 1);
  assert.match(output.err, /润色模型（第二跳）/);
  assert.ok(!daemon.calls.some((call) => call.startsWith("set-")));

  const list = harness({ daemon: fakeDaemon({ running: READY }) });
  assert.equal(await list.draftless("transcriber"), 0);
  assert.match(list.output.out, /现在是 native 模式，用不上.*draftless mode local/);
});

test("mode local 连带第二跳：没有 DeepSeek 的 key 也能直接用自定义服务进 local", async () => {
  haveModel();
  const daemon = fakeDaemon({ running: READY });
  const { draftless, asked } = harness({ daemon, secrets: ["sk-custom"] });
  assert.equal(
    await draftless("mode", "local", "--polish", "custom/qwen3:8b", "--url", "http://127.0.0.1:11434/v1"),
    0,
  );
  assert.match(asked[0], /Custom|自定义服务/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-custom",
    provider: "custom",
    changes: { mode: "local", polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" },
  });
  assert.deepEqual(daemon.requests.at(-1), {
    cmd: "set-mode",
    params: { mode: "local", changes: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" } },
  });
});

test("mode 连带的设置不是那种模式的：以 2 退出说能带什么", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("mode", "native", "--polish", "deepseek"), 2);
  assert.match(output.err, /--model/);
  assert.equal(await draftless("mode", "local", "--model", "openai"), 2);
  assert.match(output.err, /--transcriber.*--polish.*--url/);
});

test("transcriber：列出本机转写模型（第一跳），大小、下载过没有、在下的进度，现在用的打一个点；最后说本机下了几个、怎么下载删除", async () => {
  haveModel("sensevoice-small-q8");
  const { draftless, output } = harness();
  assert.equal(await draftless("transcriber"), 0);
  assert.match(output.out, /local 模式的第一跳/);
  assert.match(output.out, /● qwen3-asr-0\.6b-q8\s+Qwen3-ASR 0\.6B \(Q8_0\)\s+850 MB\s+还没下载/);
  assert.match(output.out, /sensevoice-small-q8\s+SenseVoice Small \(Q8_0\)\s+253 MB\s+已下载/);
  assert.match(output.out, /本机已下载 1 \/ 4 个，共 253 MB · 磁盘剩余 /);
  assert.match(output.out, /换一个：draftless transcriber sensevoice-small-q8/);
  assert.match(output.out, /下载：draftless transcriber download qwen3-asr-0\.6b-q8 · 停下：cancel · 删除：delete/);

  // 后台在运行：以它报的为准（正在下的进度、上次没下下来的）
  const total = downloadSize(findModel("qwen3-asr-0.6b-q8"));
  const running = {
    ...LOCAL_READY,
    localModels: [
      {
        id: "qwen3-asr-0.6b-q8",
        installed: false,
        download: { received: total / 4, total },
        partial: 0,
        problem: null,
      },
      {
        id: "sensevoice-small-q8",
        installed: false,
        download: null,
        partial: 0,
        problem: "SenseVoice 没下下来：断网了",
      },
    ],
  };
  const busy = harness({ daemon: fakeDaemon({ running }) });
  assert.equal(await busy.draftless("transcriber"), 0);
  assert.match(busy.output.out, /qwen3-asr-0\.6b-q8.*下载中 25%/);
  assert.match(busy.output.out, /sensevoice-small-q8.*没下下来\n(.*\n){2}.*断网了/);
});

test("transcriber <模型>：不用 key，让在运行的那个当场换；写错了以 2 退出说能填什么", async () => {
  haveModel("sensevoice-small-q8");
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { draftless, output, asked } = harness({ daemon });
  assert.equal(await draftless("transcriber", "sensevoice-small-q8"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-transcriber", params: { transcriber: "sensevoice-small-q8" } });
  assert.equal(asked.length, 0);
  assert.match(output.out, /第一跳换成了 sensevoice-small-q8/);

  const wrong = harness();
  assert.equal(await wrong.draftless("transcriber", "gemini"), 2);
  assert.match(wrong.output.err, /qwen3-asr-0\.6b-q8/);
});

// ---------- 本机模型：下载、停下、删除 ----------

/**
 * 会下载的后台：download-model 之后每看一次状态前进一截，第二次看时下好了（outcome 为 "fail" 时报没下下来）。
 * delete-model 照内核的规矩：正在用的（local 模式的第一跳）不让删
 */
function modelDaemon({ running = LOCAL_READY, outcome = "finish" } = {}) {
  const daemon = fakeDaemon({ running });
  const total = (id) => downloadSize(findModel(id));
  const views = new Map();
  const view = (id) =>
    views.get(id) ?? {
      id,
      installed: existsSync(join(paths.modelsDir, id, ".complete.json")),
      download: null,
      partial: 0,
      problem: null,
    };
  const polls = new Map();
  const status = daemon.status;
  daemon.status = async (params) => {
    const current = await status.call(daemon, params);
    if (current === null) return null;
    for (const [id, count] of polls) {
      polls.set(id, count + 1);
      if (count >= 1) {
        polls.delete(id);
        if (outcome === "finish") {
          haveModel(id);
          views.delete(id);
        } else views.set(id, { ...view(id), download: null, problem: `${id} 没下下来：${outcome}` });
      }
    }
    return { ...current, localModels: ["qwen3-asr-0.6b-q8", "sensevoice-small-q8"].map(view) };
  };
  const request = daemon.request;
  daemon.request = async (cmd, params) => {
    if (cmd === "download-model") {
      daemon.calls.push(cmd);
      daemon.requests.push({ cmd, params });
      views.set(params.id, {
        ...view(params.id),
        download: { received: total(params.id) / 2, total: total(params.id) },
      });
      polls.set(params.id, 0);
      return { ok: true };
    }
    if (cmd === "cancel-download") {
      daemon.calls.push(cmd);
      polls.delete(params.id);
      views.delete(params.id);
      return { ok: true };
    }
    if (cmd === "delete-model") {
      daemon.calls.push(cmd);
      const current = daemon.current;
      if (current.mode === "local" && current.transcriber === params.id) {
        return { ok: false, problem: `${params.id} 正在用，删不了：先换一个模型，或切回 native` };
      }
      rmSync(join(paths.modelsDir, params.id), { recursive: true, force: true });
      return { ok: true };
    }
    return request.call(daemon, cmd, params);
  };
  return daemon;
}

test("transcriber <模型>：要换的还没下载时先问；答是就交给后台下完再换，进度一截一截说", async () => {
  const daemon = modelDaemon();
  const { draftless, output, confirmed } = harness({ daemon, confirms: [true] });
  assert.equal(await draftless("transcriber", "sensevoice-small-q8"), 0);
  assert.match(
    confirmed[0],
    /SenseVoice Small \(Q8_0\) 还没下载（253 MB，从国内源（draftless 的 CDN）下）。现在下载吗/,
  );
  assert.match(output.out, /交给后台下了：按 Ctrl-C 只是不看进度/);
  assert.match(output.out, /下载中 50%/);
  assert.match(output.out, /SenseVoice Small \(Q8_0\) 下好了/);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-transcriber", params: { transcriber: "sensevoice-small-q8" } });
});

test("transcriber <模型>：不想下就不下也不换；不能问时说先运行哪条命令；没下下来时不换", async () => {
  const declined = harness({ daemon: modelDaemon(), confirms: [false] });
  assert.equal(await declined.draftless("transcriber", "sensevoice-small-q8"), 1);
  assert.match(declined.output.out, /没有下载，也没有换/);
  assert.ok(!declined.daemon.calls.includes("download-model") && !declined.daemon.calls.includes("set-transcriber"));

  const quiet = harness({ daemon: modelDaemon(), interactive: false });
  assert.equal(await quiet.draftless("transcriber", "sensevoice-small-q8"), 1);
  assert.match(quiet.output.err, /还没下载：先运行 draftless transcriber download sensevoice-small-q8/);

  const failing = harness({ daemon: modelDaemon({ outcome: "断网了" }), confirms: [true] });
  assert.equal(await failing.draftless("transcriber", "sensevoice-small-q8"), 1);
  assert.match(failing.output.err, /没下下来：断网了/);
  assert.ok(!failing.daemon.calls.includes("set-transcriber"));
});

test("transcriber download：用户自己点的，不再问；后台没在运行就在命令行这个进程里下；已经下好的直说", async () => {
  const idle = harness();
  assert.equal(await idle.draftless("transcriber", "download", "qwen3-asr-0.6b-q8"), 0);
  assert.deepEqual(idle.local.downloads, ["qwen3-asr-0.6b-q8"]);
  assert.deepEqual(idle.local.sources, ["cn"]);
  assert.match(idle.output.out, /下载 Qwen3-ASR 0\.6B \(Q8_0\)（850 MB，从国内源（draftless 的 CDN））/);
  assert.match(idle.output.out, /下好了/);
  assert.equal(idle.confirmed.length, 0);

  const again = harness();
  assert.equal(await again.draftless("transcriber", "download", "qwen3-asr-0.6b-q8"), 0);
  assert.match(again.output.out, /已经下载好了/);
  assert.deepEqual(again.local.downloads, []);

  const failing = harness({ modelDownload: "磁盘写不进去" });
  assert.equal(await failing.draftless("transcriber", "download", "sensevoice-small-q8"), 1);
  assert.match(failing.output.err, /没下下来：磁盘写不进去/);

  const wrong = harness();
  assert.equal(await wrong.draftless("transcriber", "download"), 2);
  assert.equal(await wrong.draftless("transcriber", "download", "gemini"), 2);
});

test("transcriber check：交给后台念一句、转一次，说念的、转出来的和用了多久；不写就查现在选的", async () => {
  haveModel();
  const daemon = modelDaemon();
  const request = daemon.request;
  daemon.request = async (cmd, params, options) => {
    if (cmd !== "check-transcriber") return request.call(daemon, cmd, params, options);
    daemon.calls.push(cmd);
    daemon.requests.push({ cmd, params });
    if (params.id === "sensevoice-small-q8") {
      return { ok: false, problem: "SenseVoice Small (Q8_0) 还没下载（253 MB）：先下载再用" };
    }
    const said = "今天下午三点开会，记得带上电脑。";
    return { ok: true, said, text: said, transcribeMs: 312, loadMs: 1840, backend: "metal" };
  };
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("transcriber", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-transcriber", params: { id: "qwen3-asr-0.6b-q8" } });
  assert.match(output.out, /正在检查 Qwen3-ASR 0\.6B \(Q8_0\)/);
  assert.match(
    output.out,
    /能用。念的是「今天下午三点开会，记得带上电脑。」，转出来「今天下午三点开会，记得带上电脑。」，转写用了 0\.3 秒/,
  );
  assert.match(output.out, /临时装上用了 1\.8 秒/);

  // 没下载的不去问后台，直接说怎么下
  const asked = daemon.calls.filter((cmd) => cmd === "check-transcriber").length;
  assert.equal(await draftless("transcriber", "check", "sensevoice-small-q8"), 1);
  assert.match(output.err, /还没下载：先运行 draftless transcriber download sensevoice-small-q8/);
  assert.equal(daemon.calls.filter((cmd) => cmd === "check-transcriber").length, asked);
  assert.equal(await draftless("transcriber", "check", "gemini"), 2);
  assert.equal(await draftless("transcriber", "check", "qwen3-asr-0.6b-q8", "extra"), 2);
});

test("transcriber cancel：后台正在下的停下；没在下的直说", async () => {
  const daemon = modelDaemon();
  const { draftless, output } = harness({ daemon });
  await daemon.request("download-model", { id: "sensevoice-small-q8" });
  assert.equal(await draftless("transcriber", "cancel", "sensevoice-small-q8"), 0);
  assert.ok(daemon.calls.includes("cancel-download"));
  assert.match(output.out, /停下了 SenseVoice Small \(Q8_0\) 的下载/);
  assert.equal(await draftless("transcriber", "cancel", "sensevoice-small-q8"), 0);
  assert.match(output.out, /没有在下载/);
});

test("transcriber delete：先确认；--yes 不问；不能问又没 --yes 时以 2 退出；正在用的删不了；没下载的不用删", async () => {
  haveModel("sensevoice-small-q8");
  const asked = harness({ daemon: modelDaemon(), confirms: [false] });
  assert.equal(await asked.draftless("transcriber", "delete", "sensevoice-small-q8"), 1);
  assert.match(asked.confirmed[0], /删掉 SenseVoice Small \(Q8_0\)（253 MB）/);
  assert.match(asked.output.out, /没有删/);
  assert.ok(existsSync(join(paths.modelsDir, "sensevoice-small-q8")));

  const quiet = harness({ daemon: modelDaemon(), interactive: false });
  assert.equal(await quiet.draftless("transcriber", "delete", "sensevoice-small-q8"), 2);
  assert.match(quiet.output.err, /--yes/);

  const sure = harness({ daemon: modelDaemon() });
  assert.equal(await sure.draftless("transcriber", "delete", "sensevoice-small-q8", "--yes"), 0);
  assert.match(sure.output.out, /删掉了 SenseVoice Small \(Q8_0\)，腾出 253 MB/);
  assert.equal(existsSync(join(paths.modelsDir, "sensevoice-small-q8")), false);

  haveModel("qwen3-asr-0.6b-q8");
  const inUse = harness({ daemon: modelDaemon() });
  assert.equal(await inUse.draftless("transcriber", "delete", "qwen3-asr-0.6b-q8", "--yes"), 1);
  assert.match(inUse.output.err, /正在用，删不了/);

  const nothing = harness();
  assert.equal(await nothing.draftless("transcriber", "delete", "sensevoice-small-q8", "--yes"), 0);
  assert.match(nothing.output.out, /本来就没下载/);
});

test("transcriber delete：后台没在运行时自己删；设置里 local 模式用的就是它就不删", async () => {
  haveModel("sensevoice-small-q8");
  const idle = harness();
  assert.equal(await idle.draftless("transcriber", "delete", "sensevoice-small-q8", "--yes"), 0);
  assert.deepEqual(idle.local.removed, ["sensevoice-small-q8"]);

  haveModel("qwen3-asr-0.6b-q8");
  writeFileSync(paths.settingsFile, JSON.stringify({ mode: "local" }));
  const inUse = harness();
  assert.equal(await inUse.draftless("transcriber", "delete", "qwen3-asr-0.6b-q8", "--yes"), 1);
  assert.match(inUse.output.err, /正在用，删不了/);
  assert.deepEqual(inUse.local.removed, []);
});

test("mode local：要用的本机模型还没下载时先问；不下就不切，也不问 key", async () => {
  const daemon = modelDaemon({ running: READY });
  const { draftless, output, asked } = harness({ daemon, confirms: [false] });
  assert.equal(await draftless("mode", "local"), 1);
  assert.match(output.out, /没有下载，也没有换/);
  assert.equal(asked.length, 0);
  assert.ok(!daemon.calls.includes("set-mode"));

  haveDeepSeekKey();
  const yes = harness({ daemon: modelDaemon({ running: READY }), confirms: [true] });
  assert.equal(await yes.draftless("mode", "local"), 0);
  assert.match(yes.output.out, /下好了[\s\S]*切到了 local 模式/);
});

test("polish：列出润色的那几家（第二跳），各家能挑的模型、key 有没有，自定义服务怎么填", async () => {
  haveDeepSeekKey();
  const { draftless, output } = harness();
  assert.equal(await draftless("polish"), 0);
  assert.match(output.out, /local 模式的第二跳/);
  assert.match(output.out, /● deepseek\s+DeepSeek\s+deepseek-flash\s+key 存着/);
  assert.match(output.out, /deepseek-v4-pro/);
  assert.match(output.out, /custom\s+自定义服务/);
  assert.match(output.out, /draftless polish custom\/<模型名> --url <地址>/);
});

test("polish <厂商>/<模型>：有 key 就让在运行的那个当场换", async () => {
  haveDeepSeekKey();
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("polish", "deepseek/deepseek-v4-pro"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "set-polish", params: { polish: "deepseek/deepseek-v4-pro" } });
  assert.match(output.out, /第二跳换成了 DeepSeek 的 deepseek-v4-pro/);
});

test("polish custom/<模型> --url <地址>：先问自定义服务的 key，连模型和地址一起验证，再换", async () => {
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { draftless, asked } = harness({ daemon, secrets: ["sk-custom"] });
  assert.equal(await draftless("polish", "custom/qwen3:8b", "--url", "http://127.0.0.1:11434/v1/chat/completions"), 0);
  // 自定义服务没有申请 key 的页面
  assert.doesNotMatch(asked[0], /申请/);
  assert.deepEqual(daemon.requests.find(({ cmd }) => cmd === "set-key").params, {
    key: "sk-custom",
    provider: "custom",
    changes: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" },
  });
  assert.deepEqual(daemon.requests.at(-1), {
    cmd: "set-polish",
    params: { polish: "custom/qwen3:8b", customUrl: "http://127.0.0.1:11434/v1" },
  });
});

test("polish：自定义服务没给地址、写的是收音频的那家，以 2 退出说清楚", async () => {
  const { draftless, output } = harness();
  assert.equal(await draftless("polish", "custom/m"), 2);
  assert.match(output.err, /--url/);
  assert.equal(await draftless("polish", "openai"), 2);
  // openai 只在听写那边有；润色能选的是这三家
  assert.match(output.err, /deepseek \/ qwen \/ custom/);
});

test("polish check：查第二跳现在用的那个能不能用", async () => {
  haveDeepSeekKey();
  const daemon = fakeDaemon({ running: LOCAL_READY });
  const { draftless, output } = harness({ daemon });
  assert.equal(await draftless("polish", "check"), 0);
  assert.deepEqual(daemon.requests.at(-1), { cmd: "check-polish", params: { polish: "deepseek/deepseek-flash" } });
  assert.match(output.out, /能用：DeepSeek 的 deepseek-flash/);
});
