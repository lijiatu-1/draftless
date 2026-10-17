import { localize, t } from "./i18n.mjs";
import { providerIcon } from "./provider-icons.mjs";
import { describeError } from "./setup-text.mjs";

// 选用哪家的模型、填 key：主窗口设置里的"模型"一页和首次引导的第一步用的是这同一块。
// 一块面板只管一层的厂商（layer）：native 模式收音频的那几家，或者 local 模式第二跳润色的那几家。
// 列哪几家、选的是哪家、"改用"要换哪几项设置都由那一层说，两层互不相干（见下面的 KEY_LAYERS）。
// "改用"时正在用的就是这一层的模式：当场换这一层的模型；不是的话连同这家一起切到那种模式（内核只许这么换，app/modes.mjs）。
// 状态都在主进程，这里只负责画出来和转达用户的操作。key 只从这里往主进程走一趟，不会从主进程回到页面上。
// 一家有了 key 就不再摆输入框：点"换 key"才出来。能随时点"检查"拿这家的 key 发一个最小的请求，
// 看现在能不能用（欠费、没网、key 失效都在这时说出来）；点选一家、换了模型时也自动查一次。

/**
 * 改用某一层的某家：有新 key 先拿要换成的设置验证过存好，再换。
 * 正在用的就是这一层的模式时当场换这一层的模型（apply），不是的话连同这些设置一起切到那种模式
 * @param {(typeof KEY_LAYERS)["native"]} layer
 * @param {object} setup 最近一次的状态
 * @param {string} id
 * @param {string | undefined} key 顺带填的一把新的；不填就用那一家现有的
 */
export async function useVendor(layer, setup, id, key) {
  const changes = layer.changes(id);
  if (key !== undefined) {
    const saved = await window.draftless.saveKey(key, id, changes);
    if (!saved.ok) return saved;
  }
  return setup.mode.value === layer.mode ? layer.apply(changes) : window.draftless.setMode(layer.mode, changes);
}

/** 两层的厂商：属于哪种模式、列哪几家、这一层选的是哪家、改用某家时换哪几项设置、在那种模式里怎么当场换 */
export const KEY_LAYERS = {
  /** native 模式：收音频的模型，改用一家就是换成它的默认模型 */
  native: {
    mode: "native",
    vendors: (setup) => setup.native.providers,
    chosen: (setup) => setup.native.model.split("/")[0],
    changes: (id) => ({ model: id }),
    /** 检查时照什么查：选的就是它时照设置里现在的型号和思考档位，别家查它的默认模型 */
    checkChanges: (setup, id) => (id === setup.native.model.split("/")[0] ? {} : { model: id }),
    apply: (changes) => window.draftless.setModel(changes.model),
  },
  /**
   * local 模式第二跳：润色的模型。polish(id) 给出改用这家时的写法（厂商/模型），
   * customUrl() 是自定义服务的地址；不给时用它的默认模型、地址不变
   */
  polish: ({ polish = (id) => id, customUrl = () => undefined } = {}) => {
    function changes(id) {
      const url = customUrl();
      return url === undefined ? { polish: polish(id) } : { polish: polish(id), customUrl: url };
    }
    return {
      mode: "local",
      vendors: (setup) => setup.local.vendors,
      chosen: (setup) => setup.local.polish.split("/")[0],
      changes,
      /** 检查时照页面上选的模型（和自定义服务填的地址）查：选了模型就是要看它能不能用 */
      checkChanges: (_setup, id) => changes(id),
      apply: (changes) => window.draftless.setPolish(changes.polish, changes.customUrl),
    };
  },
};

/** 厂商在界面上叫什么：自定义服务没有牌子，按界面语言写 */
const named = (provider) => (provider.id === "custom" ? { ...provider, name: t("keyPanel.customName") } : provider);

/** 不是正在用的那家：只说它有没有 key、在哪（主进程只报来源，不解密） */
function otherKeyText(provider) {
  if (provider.key === "env") return [t("keyPanel.other.env", { variable: provider.keyEnv }), ""];
  if (provider.key === "stored") return [t("keyPanel.other.stored"), ""];
  return [t("keyPanel.other.none", { provider: provider.name }), ""];
}

function keyText(key, provider) {
  // 启动时够不着的话先用着，如实说还没验证
  const unverified = key.verified === false;
  const named = { variable: provider.keyEnv, provider: provider.name, problem: key.problem };
  switch (key.state) {
    case "ready":
      if (key.source === "env")
        return [t(unverified ? "keyPanel.state.envUnverified" : "keyPanel.state.env", named), "ok"];
      if (key.source === "external") return [t("keyPanel.state.external"), "ok"];
      return unverified ? [t("keyPanel.state.savedUnverified", named), "pending"] : [t("keyPanel.state.saved"), "ok"];
    case "checking":
      return [t("keyPanel.state.checking"), "pending"];
    case "rejected":
      // 三种情况要做的事不一样：只有最后一种是在下面换一把就能解决的
      if (key.cause === "other") return [t("keyPanel.state.checkFailed", named), "problem"];
      if (key.source === "env") return [t("keyPanel.state.envRejected", named), "problem"];
      return [t("keyPanel.state.rejected", named), "problem"];
    case "unreadable":
      return [t.text(key.problem), "problem"];
    default:
      return [t("keyPanel.state.missing"), "problem"];
  }
}

const MARKUP = `
  <div class="providers" role="radiogroup" data-i18n-aria-label="keyPanel.models"></div>
  <div class="vendor-extra"></div>
  <div class="key-state-row">
    <p class="state"></p>
    <button type="button" class="button check-key" data-i18n="keyPanel.check.button" hidden></button>
    <button type="button" class="button primary use-provider" hidden></button>
  </div>
  <p class="check-result" role="status" hidden></p>
  <form class="key-form">
    <input type="password" class="input key-input" autocomplete="off" spellcheck="false"
      data-i18n-placeholder="keyPanel.placeholder" aria-label="API key" />
    <button type="button" class="button paste-key" data-i18n="keyPanel.paste"></button>
    <button type="submit" class="button primary save-key"></button>
  </form>
  <p class="problem key-problem" role="alert" hidden></p>
  <p class="hint key-note" hidden></p>
  <p class="links">
    <button type="button" class="link open-key-page"></button>
    <button type="button" class="link replace-key" hidden></button>
    <button type="button" class="link forget-key" hidden data-i18n="keyPanel.forget"></button>
  </p>`;

/**
 * 把这一块放进 container。
 * @param {HTMLElement} container
 * @param {{ refresh: () => Promise<unknown>, layer: (typeof KEY_LAYERS)["native"], onSelect?: (id: string) => void }} options
 *   refresh：存完、换完以后让整个窗口重新问一遍状态；layer：管哪一层的厂商（KEY_LAYERS）；
 *   onSelect：每次画完说一声现在看着的是哪家（设置页按它画那一家的模型、地址）
 * @returns {{ render: (setup: object) => void, check: () => void, slot: HTMLElement }}
 *   check：查一次现在看着的那家（换了模型时用）；slot：选哪家下面的一格，用的人往里放那一家要另填的（模型、地址），
 *   放在 key 和检查的上面：检查查的就是这里选的模型
 */
export function createKeyPanel(container, { refresh, layer, onSelect }) {
  container.innerHTML = MARKUP;
  localize(container);
  const find = (selector) => container.querySelector(selector);
  const keyInput = find(".key-input");
  const saveButton = find(".save-key");
  const useButton = find(".use-provider");
  const keyProblem = find(".key-problem");
  const keyNote = find(".key-note");
  const checkButton = find(".check-key");
  const checkResult = find(".check-result");
  /** 正在保存或者正在改用时不让重复提交，也不让别处的刷新把按钮重新点亮 */
  let saving = false;
  /** 现在看着的是哪一家（id）。打开时是这一层选的那家；点了别家就看别家的 key，可以改用它 */
  let selected = null;
  /** 最近一次拿到的状态 */
  let latest = null;
  /** 有 key 的那家点了"换 key"：摆出输入框。换一家看、换好了就收起 */
  let replacing = false;
  /** 每家最近一次检查：{ tone, text, ticket }。ticket 认是哪一次，查到一半又查了一次的，先回来的旧结果不要 */
  const checks = new Map();

  /** 显示一句话：msg 按界面语言翻，现成的字照写；空的就藏起来 */
  const show = (node, message) => {
    node.textContent = t.text(message);
    node.hidden = !message;
  };

  /** 每家一个按钮：图标和名字，这一层选的那家后面打个勾。有没有 key 在下面那行说 */
  function renderProviders(providers, currentId) {
    find(".providers").replaceChildren(
      ...providers.map((provider) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "provider";
        button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", String(provider.id === selected));
        const name = document.createElement("span");
        name.className = "provider-name";
        name.textContent = provider.name;
        const icon = providerIcon(provider.id);
        button.append(...(icon ? [icon, name] : [name]));
        if (provider.id === currentId) {
          const mark = document.createElement("span");
          mark.className = "provider-in-use";
          mark.title = t("keyPanel.inUse");
          mark.textContent = "✓";
          mark.setAttribute("aria-label", t("keyPanel.inUse"));
          button.append(mark);
        }
        button.addEventListener("click", () => {
          if (selected === provider.id) return;
          selected = provider.id;
          replacing = false;
          keyInput.value = "";
          show(keyProblem, null);
          show(keyNote, null);
          render(latest);
          // 点选了一家：有 key 就当场查一次它现在能不能用
          if (hasKey(latest, provider)) check();
        });
        return button;
      }),
    );
  }

  /** 这家有没有能拿来用的 key。服务正拿着它的 key 时看那把的状态：不能用的、没有的都算没有 */
  function hasKey(setup, provider) {
    if (provider.id === setup.provider.id) return setup.key.state === "ready" || setup.key.state === "checking";
    return provider.key !== null;
  }

  /** 查一次现在看着的那家：拿它的 key 发一个最小的请求，不换掉正在用的 */
  async function check() {
    const id = selected;
    const ticket = {};
    checks.set(id, { tone: "pending", text: t("keyPanel.check.running"), ticket });
    render(latest);
    let result;
    try {
      result = await window.draftless.checkModel(layer.mode, layer.checkChanges(latest, id));
    } catch (error) {
      result = { ok: false, problem: t("keyPanel.failed", { reason: describeError(error) }) };
    }
    if (checks.get(id)?.ticket !== ticket) return;
    checks.set(
      id,
      result.ok
        ? { tone: "ok", text: t("keyPanel.check.ok"), ticket }
        : { tone: "problem", text: t("keyPanel.check.failed", { problem: t.text(result.problem) }), ticket },
    );
    render(latest);
  }

  function render(setup) {
    latest = setup;
    // 这一块说的是选中的那一家：它的 key 在不在、去哪申请；不是这一层选的那家时可以改用它
    const providers = layer.vendors(setup).map(named);
    const chosen = layer.chosen(setup);
    if (!providers.some(({ id }) => id === selected)) selected = chosen;
    const provider = providers.find(({ id }) => id === selected);
    const isCurrent = provider.id === chosen;
    // 服务手里正拿着它的 key（正在用的模式选的就是它）：说那把 key 的状态；别的只说有没有
    const holding = provider.id === setup.provider.id;
    // 连着单独启动的服务端时用哪家由那边定，不给选
    find(".providers").hidden = !setup.switchable;
    if (setup.switchable) renderProviders(providers, chosen);
    keyInput.setAttribute("aria-label", `${provider.name} API key`);
    // 自定义服务没有申请 key 的页面
    find(".open-key-page").hidden = !provider.hasKeyPage;
    if (provider.hasKeyPage) find(".open-key-page").textContent = t(`providers.${provider.id}.getKey`);
    const [text, tone] = holding ? keyText(setup.key, provider) : otherKeyText(provider);
    find(".state").textContent = text;
    find(".state").dataset.tone = tone;
    // 别家已经有 key：一点就改用它；没有的话在下面填一把，保存时一起改用
    useButton.hidden = isCurrent || provider.key === null;
    if (!saving) useButton.textContent = t("keyPanel.use", { provider: provider.name });
    useButton.disabled = saving;
    if (!saving) {
      saveButton.textContent = isCurrent ? t("keyPanel.save") : t("keyPanel.saveAndUse", { provider: provider.name });
    }
    // 一次只有一个主按钮：别家已经有 key 时主要是"改用"，填一把新的退到次要
    saveButton.classList.toggle("primary", useButton.hidden);
    // 环境变量和外部服务端的 key 不归这里管，不提供"删除"
    find(".forget-key").hidden = (holding ? setup.key.source : provider.key) !== "stored";
    const editable = setup.key.source !== "external";
    // 有 key 的不摆输入框，点"换 key"才出来；没有或者不能用的直接摆出来
    const keyed = hasKey(setup, provider);
    find(".key-form").hidden = !editable || (keyed && !replacing);
    find(".replace-key").hidden = !editable || !keyed;
    find(".replace-key").textContent = t(replacing ? "keyPanel.keepKey" : "keyPanel.replace");
    keyInput.disabled = !editable;
    find(".paste-key").disabled = !editable;
    saveButton.disabled = saving || !editable;
    // 检查：有 key 才能查；服务启动时正在验的那把等它验完
    const checked = checks.get(provider.id);
    checkButton.hidden = !setup.switchable || !editable || !keyed;
    checkButton.disabled = saving || checked?.tone === "pending" || (holding && setup.key.state === "checking");
    checkResult.hidden = checkButton.hidden || !checked;
    checkResult.textContent = checked?.text ?? "";
    checkResult.dataset.tone = checked?.tone ?? "";
    onSelect?.(selected);
  }

  /**
   * 存 key、改用别家都走这里：一次只做一件，做的时候按钮上写着"验证中…"，做完刷新。
   * @param {HTMLButtonElement} button
   * @param {() => Promise<{ ok: boolean, problem?: object | string, note?: object }>} action
   */
  async function submit(button, action) {
    if (saving) return;
    saving = true;
    const label = button.textContent;
    saveButton.disabled = true;
    useButton.disabled = true;
    button.textContent = t("keyPanel.verifying");
    show(keyProblem, null);
    show(keyNote, null);
    try {
      const result = await action();
      if (result.ok) {
        keyInput.value = "";
        replacing = false;
        // 换了 key：之前查的那次说的是旧的那把
        checks.delete(selected);
        show(keyNote, result.note ?? null);
      } else show(keyProblem, result.problem);
    } catch (error) {
      show(keyProblem, t("keyPanel.failed", { reason: describeError(error) }));
    } finally {
      saving = false;
      button.textContent = label;
      await refresh();
    }
  }

  find(".key-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const value = keyInput.value;
    // 选中的就是这一层选的那家：只存 key（服务正拿着它的 key 就当场换上）；
    // 不是的话存这把 key 的同时改用它，验证过才换
    const isCurrent = selected === layer.chosen(latest);
    const holding = selected === latest.provider.id;
    submit(saveButton, () => {
      if (!isCurrent) return useVendor(layer, latest, selected, value);
      return holding ? window.draftless.saveKey(value) : window.draftless.saveKey(value, selected, {});
    });
  });

  useButton.addEventListener("click", () => submit(useButton, () => useVendor(layer, latest, selected)));

  find(".paste-key").addEventListener("click", async () => {
    const text = (await window.draftless.readClipboard()).trim();
    if (text === "") {
      show(keyProblem, t("keyPanel.clipboardEmpty"));
      return;
    }
    show(keyProblem, null);
    keyInput.value = text;
    keyInput.focus();
  });

  find(".forget-key").addEventListener("click", async () => {
    const provider = named(layer.vendors(latest).find(({ id }) => id === selected) ?? latest.provider);
    const inUse = provider.id === latest.provider.id;
    const question = t(inUse ? "keyPanel.confirmForgetInUse" : "keyPanel.confirmForget", { provider: provider.name });
    if (!window.confirm(question)) return;
    await window.draftless.forgetKey(selected);
    checks.delete(selected);
    replacing = false;
    await refresh();
  });

  checkButton.addEventListener("click", () => check());

  find(".replace-key").addEventListener("click", () => {
    replacing = !replacing;
    keyInput.value = "";
    show(keyProblem, null);
    render(latest);
    if (replacing) keyInput.focus();
  });

  find(".open-key-page").addEventListener("click", () => window.draftless.openKeyPage(selected));

  return { render, check, slot: find(".vendor-extra") };
}
