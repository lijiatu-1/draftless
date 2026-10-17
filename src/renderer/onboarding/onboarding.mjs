import { keycapOf, localize, t } from "../shared/i18n.mjs";
import { createKeyPanel, KEY_LAYERS } from "../shared/key-panel.mjs";
import { meterLevels, openMicrophone } from "../shared/level-meter.mjs";
import { describeError, permissionGranted, permissionText } from "../shared/setup-text.mjs";
import { canContinue, groupStates, STEPS, startStep } from "./steps.mjs";

// 首次引导：接上模型 → 授权 → 测麦克风 → 测快捷键 → 真说一句 → 完成。
// 状态都在主进程；这里管走到哪一步、每一步怎么画。走完了主进程关掉这个窗口、打开主窗口。

const $ = (id) => document.getElementById(id);
/** 测麦克风时画几根条，中间的高、两边的矮 */
const METER_BARS = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45];

// 页面上写死的字先按界面语言填上
localize();

let setup = null;
let step = null;
// 第一步接上的是现在这种模式要的那家：native 是收音频的模型，local 是润色的模型。换模式在主窗口的设置里
let keyPanel = null;
let keyLayer = null;

async function refresh() {
  setup = await window.draftless.getSetup();
  render();
  return setup;
}

// ---------- 走到哪一步 ----------

/** 离开某一步时要收拾的：关麦克风、不再截热键 */
const leave = {
  microphone: () => stopMeter(),
  hotkey: () => window.draftless.captureHotkey(false),
};
/** 进入某一步时要做的 */
const enter = {
  microphone: () => startMeter(),
  // 测快捷键时热键不去开悬浮条，只送到这里
  hotkey: () => window.draftless.captureHotkey(true),
  try: () => $("try-text").focus(),
};

function go(next) {
  if (next === step) return;
  leave[step]?.();
  step = next;
  for (const section of document.querySelectorAll(".step")) section.hidden = section.dataset.step !== step;
  enter[step]?.();
  render();
}

const goBy = (offset) => go(STEPS[Math.min(STEPS.length - 1, Math.max(0, STEPS.indexOf(step) + offset))]);

function render() {
  if (setup === null || step === null) return;
  const states = groupStates(step);
  for (const item of document.querySelectorAll("[data-group]")) item.dataset.state = states[item.dataset.group];

  const wanted = setup.mode.value === "local" ? "polish" : "native";
  if (keyLayer !== wanted) {
    keyLayer = wanted;
    const layer = wanted === "polish" ? KEY_LAYERS.polish() : KEY_LAYERS.native;
    keyPanel = createKeyPanel($("key-panel"), { refresh, layer });
  }
  keyPanel.render(setup);

  for (const row of document.querySelectorAll("[data-permission]")) {
    const name = row.dataset.permission;
    const granted = permissionGranted(name, setup.permissions[name]);
    row.dataset.granted = String(granted === true);
    // 两把钩子那两行没有"允许"按钮：装没装上只能看状态，写法和设置里那一页一样
    const state = row.querySelector(".grant-state");
    if (state !== null) {
      const [label, tone] = permissionText(name, setup.permissions[name], t);
      state.textContent = label;
      state.dataset.tone = tone;
      continue;
    }
    const button = row.querySelector("button");
    button.textContent = t(granted ? "onboarding.permissions.on" : "onboarding.permissions.allow");
    button.disabled = granted === true;
  }

  const keycap = keycapOf(setup.hotkey.value);
  $("big-keycap").textContent = keycap;
  $("hotkey-select").replaceChildren(
    ...setup.hotkey.choices.map((id) => new Option(t(`hotkeys.${id}.name`), id, false, id === setup.hotkey.value)),
  );
  $("try-text").placeholder = t("onboarding.try.placeholder", { keycap });

  // 底下的两个按钮
  const first = step === STEPS[0] || (step === "permissions" && startStep(setup) === "permissions");
  $("back").hidden = first || step === "done";
  const next = $("next");
  next.hidden = step === "microphone" || step === "hotkey" || step === "done";
  next.disabled = !canContinue(step, setup);
  next.textContent = t(step === "try" && $("try-text").value.trim() === "" ? "onboarding.skip" : "onboarding.next");
}

// ---------- 测麦克风 ----------

let meter = null;
let stream = null;
/** 第几次打开麦克风。每次进出这一步都加一，等麦克风回来时对不上号的就是过时了的 */
let meterRun = 0;

async function startMeter() {
  const run = ++meterRun;
  $("microphone-error").hidden = true;
  const bars = METER_BARS.map(() => document.createElement("span"));
  $("meter").replaceChildren(...bars);
  let opened;
  try {
    opened = await openMicrophone();
  } catch (error) {
    if (run !== meterRun) return;
    $("microphone-error").textContent = t("onboarding.microphone.error", { reason: describeError(error) });
    $("microphone-error").hidden = false;
    return;
  }
  // 等麦克风的这一小会儿里人可能已经走开了，甚至又回来了：那一趟有自己的一路，这一路关掉
  if (run !== meterRun) {
    for (const track of opened.getTracks()) track.stop();
    return;
  }
  stream = opened;
  meter = meterLevels(stream, (level) => {
    // 说话的音量一般只到满格的一两成，放大一点才看得出在动
    const loud = Math.min(1, level * 4);
    bars.forEach((bar, index) => {
      bar.style.height = `${0.75 + loud * METER_BARS[index] * 7}rem`;
    });
  });
}

function stopMeter() {
  meterRun += 1;
  meter?.stop();
  meter = null;
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
}

// ---------- 用户的操作 ----------

$("back").addEventListener("click", () => goBy(-1));
$("next").addEventListener("click", () => goBy(1));
$("finish").addEventListener("click", () => window.draftless.finishOnboarding());

// 只有麦克风那行有按钮：Windows 设置里有它的开关。两把钩子没有可点的东西，不绑点击
for (const row of document.querySelectorAll("[data-permission]:not([data-status])")) {
  row
    .querySelector("button")
    .addEventListener("click", () => window.draftless.openPrivacySettings(row.dataset.permission));
}

$("microphone-yes").addEventListener("click", () => goBy(1));
$("microphone-no").addEventListener("click", () => {
  $("microphone-help").hidden = false;
});
$("microphone-settings").addEventListener("click", () => window.draftless.openPrivacySettings("microphone"));

$("hotkey-yes").addEventListener("click", () => goBy(1));
$("hotkey-no").addEventListener("click", () => {
  $("hotkey-choice").hidden = false;
  $("hotkey-select").focus();
});
$("hotkey-select").addEventListener("change", async (event) => {
  $("hotkey-note").hidden = true;
  try {
    const result = await window.draftless.setHotkey(event.target.value);
    $("hotkey-note").textContent = result.note ? t.text(result.note) : t("onboarding.hotkey.switched");
  } catch (error) {
    $("hotkey-note").textContent = t("onboarding.hotkey.failed", { reason: describeError(error) });
  }
  $("hotkey-note").hidden = false;
  await refresh();
});

// 说完的话贴进笔记里了："跳过"变成"继续"
$("try-text").addEventListener("input", render);

// ---------- 主进程来的 ----------

window.draftless.onSetupChanged(refresh);
window.draftless.onOnboardingHotkey(({ down }) => {
  if (down) $("big-keycap").dataset.pressed = "";
  else delete $("big-keycap").dataset.pressed;
});

await refresh();
go(startStep(setup));
