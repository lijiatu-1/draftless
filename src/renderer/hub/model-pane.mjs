import { backendText, measuredText, sizeText, tagTexts } from "../../models/describe.mjs";
import { t } from "../shared/i18n.mjs";
import { createKeyPanel, KEY_LAYERS } from "../shared/key-panel.mjs";
import { providerIcon } from "../shared/provider-icons.mjs";
import { describeError } from "../shared/setup-text.mjs";

// 设置里"模型"那一页：先选识别模式，再在模式里选模型。两种模式要选的东西不一样，各画各的：
//   native  一跳：收音频的那几家（key 面板，KEY_LAYERS.native）
//   local   两跳：第一跳是本机转写模型（列表、下载、取消、删除、下载源），第二跳是润色的那几家（key 面板，连同模型和地址）
// 上面的标签只是切换看哪一种；真要换模式按"改用"，验证过才换（内核 app/modes.mjs 的状态机）。
// 不在用的那种模式里也能先看、先填 key：第二跳的那家没有 key 就进不去 local，所以 key 要能先存。
// 那种模式里的模型只能在那种模式里当场换；没在用时点选的第一跳模型先记着，改用这种模式时一起带过去。

const $ = (id) => document.getElementById(id);

/** 显示一句话：msg 按界面语言翻，现成的字照写；空的就藏起来 */
function show(node, message, tone = "") {
  node.textContent = t.text(message);
  node.dataset.tone = tone;
  node.hidden = !message;
}

/**
 * @param {{ refresh: () => Promise<object> }} options refresh：重新问主进程要一份状态，并让整个窗口跟着更新
 */
export function createModelPane({ refresh }) {
  /** 最近一次拿到的状态 */
  let latest = null;
  /** 正在看哪种模式；第一次画时是正在用的那种 */
  let view = null;
  /** 没在 local 模式时点选的第一跳模型，改用 local 时一起带过去 */
  let pendingTranscriber = null;
  /** 第二跳的面板正看着哪家；模型、地址那一格按它画 */
  let polishVendor = null;
  /** 模型、地址那一格是为哪家填的初值：换了一家才重新填，免得刷新时把正在打的字盖掉 */
  let extraFor = null;
  /** 一次只做一件事（换模式、换模型），做的时候别的按钮不让点 */
  let busy = false;

  const nativePanel = createKeyPanel($("key-panel"), { refresh, layer: KEY_LAYERS.native });
  const polishPanel = createKeyPanel($("polish-panel"), {
    refresh,
    layer: KEY_LAYERS.polish({ polish: polishChoice, customUrl: customUrlChoice }),
    onSelect: (id) => {
      polishVendor = id;
      renderPolishExtra();
    },
  });
  polishPanel.slot.append($("polish-extra"));

  /** 改用某家润色时写成什么：那一家有几个模型就用选的那个，自定义服务用填的模型名 */
  function polishChoice(id) {
    if (id === "custom") return `custom/${$("custom-model").value.trim()}`;
    const vendor = latest.local.vendors.find((found) => found.id === id);
    return vendor.models.length > 1 ? `${id}/${$("polish-model").value}` : id;
  }

  /** 自定义服务的地址：只有改用自定义服务时才带 */
  function customUrlChoice() {
    return polishVendor === "custom" ? $("custom-url").value.trim() : undefined;
  }

  /** 做一件会改设置的事：结果里的问题、交代显示在这一页上，做完刷新 */
  async function act(action, problemNode = $("mode-problem")) {
    if (busy) return;
    busy = true;
    show($("mode-problem"), null);
    show($("local-problem"), null);
    show($("mode-note"), null);
    render(latest);
    try {
      const result = await action();
      if (!result.ok && result.problem) show(problemNode, result.problem, "problem");
      else if (result.note) show($("mode-note"), result.note);
    } catch (error) {
      show(problemNode, t("keyPanel.failed", { reason: describeError(error) }), "problem");
    } finally {
      busy = false;
      await refresh();
    }
  }

  // ---------- 模式 ----------

  for (const tab of document.querySelectorAll(".mode-tab")) {
    tab.addEventListener("click", () => {
      view = tab.dataset.mode;
      show($("mode-problem"), null);
      render(latest);
    });
  }

  $("use-mode").addEventListener("click", () => {
    const changes = {};
    if (view === "local" && pendingTranscriber && pendingTranscriber !== latest.local.transcriber) {
      changes.transcriber = pendingTranscriber;
    }
    act(async () => {
      const result = await window.draftless.setMode(view, changes);
      if (result.ok) pendingTranscriber = null;
      return result;
    });
  });

  function renderModes(setup) {
    const current = setup.mode.value;
    for (const tab of document.querySelectorAll(".mode-tab")) {
      tab.setAttribute("aria-selected", String(tab.dataset.mode === view));
      tab.querySelector(".mode-live").hidden = tab.dataset.mode !== current;
    }
    $("mode-hint").textContent = t(`preferences.modes.${view}Hint`);
    $("mode-in-use").hidden = view !== current;
    // 连着单独启动的服务端时用哪种模式由那边定
    $("use-mode").hidden = view === current || !setup.switchable;
    $("use-mode").disabled = busy;
    $("use-mode").textContent = t("preferences.modes.use", { mode: t(`preferences.modes.${view}`) });
    $("mode-native").hidden = view !== "native";
    $("mode-local").hidden = view !== "local";
  }

  // ---------- local 第一跳：本机转写模型 ----------
  // 下载、取消、删除都由用户点，哪种模式里都能做；只有下载好了的能选。正在用的那个不能删（内核会拦）。

  /** 点了一次"删除"、等着确认的那个；过一会儿或者点了别的就作废 */
  let confirming = null;
  let confirmTimer = null;
  /** 每个本机模型最近一次检查：{ tone, text, ticket }。ticket 认是哪一次，查到一半又点了一次的，旧结果不要 */
  const transcriberChecks = new Map();

  /** 一个模型现在怎样：[说什么, 语气]。正在用的那个（local 模式里）先看服务报的装载状态 */
  function modelStateText(model, setup) {
    const local = setup.localModel;
    const inUse = setup.mode.value === "local" && local?.model === model.id;
    if (model.download) {
      const { received, total } = model.download;
      const percent = Math.floor((received / total) * 100);
      return [
        t("preferences.local.downloading", { percent, size: `${sizeText(received)} / ${sizeText(total)}` }),
        "pending",
      ];
    }
    if (inUse && local.state === "loading") return [t("preferences.local.loading"), "pending"];
    if (inUse && local.state === "ready") {
      return [t("preferences.local.ready", { backend: backendText(local.backend) }), "ok"];
    }
    if (inUse && local.state === "failed") return [t("preferences.local.failed"), "problem"];
    if (model.problem) return [t("preferences.local.downloadFailed"), "problem"];
    if (model.installed) return [t("preferences.local.downloaded"), ""];
    if (model.partial > 0) {
      return [t("preferences.local.partial", { percent: Math.floor((model.partial / model.bytes) * 100) }), ""];
    }
    return [t("preferences.local.notDownloaded", { size: sizeText(model.bytes) }), ""];
  }

  /** 右边的按钮：没下载的给下载（下过一半的是继续），正在下的给取消，下好了的给检查和删除（正在用的不给删） */
  function modelActions(model, setup) {
    const inUse = setup.mode.value === "local" && setup.local.transcriber === model.id;
    const button = (label, onClick, tone = "") => {
      const node = document.createElement("button");
      node.type = "button";
      node.className = `button${tone ? ` ${tone}` : ""}`;
      node.textContent = label;
      node.addEventListener("click", onClick);
      return node;
    };
    if (model.download)
      return [
        button(t("preferences.local.cancel"), () => modelAction(() => window.draftless.cancelDownload(model.id))),
      ];
    const removable = model.installed || model.partial > 0;
    const actions = [];
    if (model.installed && setup.switchable) {
      const node = button(t("preferences.local.check"), () => checkTranscriber(model.id));
      node.disabled = transcriberChecks.get(model.id)?.tone === "pending";
      actions.push(node);
    }
    if (!model.installed) {
      const label =
        model.partial > 0
          ? t("preferences.local.resume", { size: sizeText(model.bytes - model.partial) })
          : t("preferences.local.download", { size: sizeText(model.bytes) });
      actions.push(button(label, () => modelAction(() => window.draftless.downloadModel(model.id))));
    }
    if (removable && !inUse) {
      const sure = confirming === model.id;
      actions.push(
        button(
          t(sure ? "preferences.local.confirmDelete" : "preferences.local.delete"),
          () => (sure ? deleteModel(model.id) : askToConfirm(model.id)),
          sure ? "danger" : "",
        ),
      );
    }
    return actions;
  }

  /** 下载、取消、删除：出了问题显示在列表下面，做完刷新（进度由主进程推过来） */
  async function modelAction(action) {
    show($("models-problem"), null);
    try {
      const result = await action();
      if (result && !result.ok && result.problem) show($("models-problem"), result.problem, "problem");
    } catch (error) {
      show($("models-problem"), t("keyPanel.failed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  }

  /** 检查一个下载好的模型：主进程念一句交给它转（没在用的临时装上）。能用就只说能用，不能用说原因 */
  async function checkTranscriber(id) {
    const ticket = {};
    transcriberChecks.set(id, { tone: "pending", text: t("preferences.local.checking"), ticket });
    render(latest);
    let result;
    try {
      result = await window.draftless.checkTranscriber(id);
    } catch (error) {
      result = { ok: false, problem: t("keyPanel.failed", { reason: describeError(error) }) };
    }
    if (transcriberChecks.get(id)?.ticket !== ticket) return;
    transcriberChecks.set(
      id,
      result.ok
        ? { tone: "ok", text: t("preferences.local.checkOk"), ticket }
        : { tone: "problem", text: t.text(result.problem), ticket },
    );
    render(latest);
  }

  function askToConfirm(id) {
    confirming = id;
    clearTimeout(confirmTimer);
    confirmTimer = setTimeout(() => {
      confirming = null;
      render(latest);
    }, 4000);
    render(latest);
  }

  function deleteModel(id) {
    confirming = null;
    clearTimeout(confirmTimer);
    modelAction(() => window.draftless.deleteModel(id));
  }

  /** 列表上面那一行：本机下了几个、一共多大，磁盘还剩多少 */
  function renderSummary(setup) {
    const { transcribers, freeBytes } = setup.local;
    const installed = transcribers.filter((model) => model.installed);
    const parts = [
      t("preferences.local.summary", {
        count: String(installed.length),
        all: String(transcribers.length),
        size: sizeText(installed.reduce((sum, model) => sum + model.bytes, 0)),
      }),
    ];
    if (freeBytes !== null) parts.push(t("preferences.local.freeSpace", { size: sizeText(freeBytes) }));
    $("models-summary").textContent = parts.join(" · ");
  }

  function renderTranscribers(setup) {
    const local = setup.local;
    const chosen = setup.mode.value === "local" ? local.transcriber : (pendingTranscriber ?? local.transcriber);
    renderSummary(setup);
    $("transcribers").replaceChildren(
      ...local.transcribers.map((model) => {
        const row = document.createElement("div");
        row.className = "transcriber";
        const pick = document.createElement("button");
        pick.type = "button";
        pick.className = "transcriber-pick";
        pick.setAttribute("role", "radio");
        pick.setAttribute("aria-checked", String(model.id === chosen));
        // 没下载的选不了：先下载
        pick.disabled = busy || !setup.switchable || !model.installed;
        if (!model.installed) pick.title = t("preferences.local.downloadFirst");
        // 名字前面是出自哪家的图标
        const name = document.createElement("span");
        name.className = "transcriber-name";
        const label = document.createElement("span");
        label.textContent = model.name;
        const icon = providerIcon(model.maker);
        name.append(...(icon ? [icon, label] : [label]));
        const [text, tone] = modelStateText(model, setup);
        const state = document.createElement("span");
        state.className = "transcriber-state";
        state.dataset.tone = tone;
        state.textContent = text;
        const tags = document.createElement("span");
        tags.className = "tags";
        tags.append(
          ...tagTexts(model.tags).map((tag) => {
            const chip = document.createElement("span");
            chip.className = "tag";
            chip.textContent = t.text(tag);
            return chip;
          }),
        );
        const measured = document.createElement("span");
        measured.className = "transcriber-measured";
        measured.textContent = t.text(measuredText(model.measured, local.chip));
        pick.append(name, state, tags, measured);
        if (model.download) {
          const progress = document.createElement("progress");
          progress.className = "transcriber-progress";
          progress.max = model.download.total;
          progress.value = model.download.received;
          pick.append(progress);
        }
        if (model.problem) pick.title = t.text(model.problem);
        pick.addEventListener("click", () => chooseTranscriber(model.id));
        const actions = document.createElement("div");
        actions.className = "transcriber-actions";
        actions.append(...modelActions(model, setup));
        row.append(pick, actions);
        // 删掉了的模型，之前查的那次不再作数
        if (!model.installed) transcriberChecks.delete(model.id);
        const checked = transcriberChecks.get(model.id);
        if (checked) {
          const line = document.createElement("p");
          line.className = "transcriber-check";
          line.dataset.tone = checked.tone;
          line.setAttribute("role", "status");
          line.textContent = checked.text;
          row.append(line);
        }
        return row;
      }),
    );
    // 下载没成的：原因写在列表下面（只说最近的那一个，按钮上的"继续下载"就是重试）
    const failed = local.transcribers.find((model) => model.problem && !model.download);
    if (failed && $("models-problem").hidden) show($("models-problem"), failed.problem, "problem");
    // 正在用的那个装不上：说原因，给一个重试（再选一次同一个就是重试）
    const loadFailed = setup.mode.value === "local" && setup.localModel?.state === "failed";
    $("transcriber-retry").hidden = !loadFailed;
    $("transcriber-retry").disabled = busy;
    show($("transcriber-problem"), loadFailed ? setup.localModel.problem : null, "problem");
  }

  function chooseTranscriber(id) {
    if (latest.mode.value !== "local") {
      // 没在 local 模式：先记着，改用 local 时一起带过去
      pendingTranscriber = id;
      render(latest);
      return;
    }
    if (id === latest.local.transcriber && latest.localModel?.state !== "failed") return;
    act(() => window.draftless.setTranscriber(id), $("local-problem"));
  }

  $("transcriber-retry").addEventListener("click", () =>
    act(() => window.draftless.setTranscriber(latest.local.transcriber), $("local-problem")),
  );

  function renderSource(setup) {
    const { value, choices } = setup.local.source;
    $("model-source").replaceChildren(
      ...choices.map((id) => new Option(t(`modelSources.${id}`), id, false, id === value)),
    );
    $("model-source").disabled = busy || !setup.switchable;
  }

  $("model-source").addEventListener("change", async (event) => {
    show($("source-note"), null);
    try {
      const result = await window.draftless.setModelSource(event.target.value);
      show($("source-note"), result.note ?? null);
    } catch (error) {
      show($("source-note"), t("keyPanel.failed", { reason: describeError(error) }), "problem");
    }
    await refresh();
  });

  // ---------- local 第二跳：润色的模型和地址 ----------

  /** 面板看着的那家要另填的：有几个模型就给个下拉，自定义服务填模型名和地址 */
  function renderPolishExtra() {
    if (latest === null || polishVendor === null) return;
    const vendor = latest.local.vendors.find(({ id }) => id === polishVendor);
    const [chosenVendor, chosenModel] = latest.local.polish.split("/");
    const isChosen = polishVendor === chosenVendor;
    const many = vendor.models.length > 1;
    const custom = vendor.id === "custom";
    $("polish-model-row").hidden = !many;
    $("custom-fields").hidden = !custom;
    if (extraFor !== polishVendor) {
      extraFor = polishVendor;
      if (many) {
        const selected = isChosen ? chosenModel : vendor.defaultModel;
        $("polish-model").replaceChildren(
          ...vendor.models.map((model) => new Option(model, model, false, model === selected)),
        );
      }
      if (custom) {
        $("custom-model").value = isChosen ? chosenModel : "";
        $("custom-url").value = latest.local.customUrl;
      }
    }
    // 选的就是这家、正在 local 里：改了模型、地址按这个当场换（别家的由面板上的"改用"一起带过去）
    const live = isChosen && latest.mode.value === "local" && latest.switchable;
    $("polish-model").disabled = busy;
    $("apply-custom").hidden = !(custom && live);
    $("apply-custom").disabled = busy;
  }

  $("polish-model").addEventListener("change", () => {
    const [chosenVendor] = latest.local.polish.split("/");
    // 正在用的那家、正在 local 里：当场换，换的时候就验过了；别的先查一次选的这个模型能不能用
    if (polishVendor === chosenVendor && latest.mode.value === "local") {
      act(() => window.draftless.setPolish(polishChoice(polishVendor)), $("local-problem"));
    } else polishPanel.check();
  });

  $("apply-custom").addEventListener("click", () =>
    act(() => window.draftless.setPolish(polishChoice("custom"), customUrlChoice()), $("local-problem")),
  );

  // ---------- 画 ----------

  function render(setup) {
    latest = setup;
    if (view === null) view = setup.mode.value;
    // 已经在用了：没切过去之前记着的第一跳不要了
    if (setup.mode.value === "local") pendingTranscriber = null;
    renderModes(setup);
    nativePanel.render(setup);
    renderTranscribers(setup);
    renderSource(setup);
    polishPanel.render(setup);
  }

  return {
    render,
    /** 打开设置时回到正在用的那种模式 */
    reset() {
      view = null;
    },
  };
}
