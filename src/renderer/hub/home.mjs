import { formatCount, formatSeconds, formatSpan, formatTokens, formatUsd } from "../../usage/format.mjs";
import { activityGrid } from "../../usage/insights.mjs";
import { keycapOf, t } from "../shared/i18n.mjs";
import { providerIcon } from "../shared/provider-icons.mjs";

// 首页：原版"洞察"那一列——四个数、活跃天数和热力图，再加我们的花费；右边一列是口述卡和版本。
// 数是主进程从全部历史里算好的（src/usage/insights.mjs、src/usage/report.mjs），这里只管画。
// 花费按模型分开列：哪家、哪个型号、本机的那一跳各花了多少、用了多少次，选今天、本月或累计看。

const $ = (id) => document.getElementById(id);

/** 热力图上每个格子多宽（加上间隔），和 hub.css 里的 --cell、--gap 一致：0.875rem + 0.375rem */
const CELL_PITCH = 20;
/** 热力图格子的五档，文案里的名字（home.levels.*）；月份同样（months.*） */
const LEVELS = ["none", "light", "moderate", "high", "power"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const dayLabel = new Intl.DateTimeFormat(t.locale, { month: "long", day: "numeric", weekday: "short" });

// 热力图左边那一列星期几（从星期日起）：按界面语言写最短的那种（S、M… / 日、一…）
const weekday = new Intl.DateTimeFormat(t.locale, { weekday: "narrow" });
document
  .getElementById("heatmap-weekdays")
  .replaceChildren(
    ...Array.from({ length: 7 }, (_, index) =>
      Object.assign(document.createElement("span"), { textContent: weekday.format(new Date(2026, 0, 4 + index)) }),
    ),
  );

/** 一个数加一个小一号的单位；还没有数时是两道横线，和原版一样 */
function setValue(element, value, unit) {
  if (value === null) {
    element.textContent = "--";
    element.dataset.empty = "";
    return;
  }
  delete element.dataset.empty;
  const unitNode = document.createElement("span");
  unitNode.className = "unit";
  unitNode.textContent = unit;
  element.replaceChildren(value, unitNode);
}

function setSpan(element, seconds) {
  const { value, unit } = formatSpan(seconds);
  setValue(element, value, t(`units.${unit}`));
}

/**
 * @param {{ onOpenSettings: () => void }} options
 */
export function createHome() {
  /** 最近一次拿到的统计；窗口变宽变窄时热力图要按它重画 */
  let latest = null;
  /** 热力图往前翻了几页（一页是当前能放下的那么多周）；0 是最近的 */
  let pagesBack = 0;
  let weeks = 0;

  function renderStats(insights) {
    const empty = insights.activeDays === 0;
    setValue($("stat-words"), empty ? null : formatCount(insights.words), t("units.words", { count: insights.words }));
    if (empty) {
      for (const id of ["stat-saved", "stat-time", "stat-speed"]) setValue($(id), null);
    } else {
      setSpan($("stat-saved"), insights.savedSeconds);
      setSpan($("stat-time"), insights.seconds);
      setValue($("stat-speed"), String(insights.wordsPerMinute), t("units.wpm"));
    }
    const days = (count) => t("units.days", { count });
    setValue($("stat-active"), String(insights.activeDays), days(insights.activeDays));
    setValue($("stat-current"), String(insights.currentStreak), days(insights.currentStreak));
    setValue($("stat-longest"), String(insights.longestStreak), days(insights.longestStreak));
  }

  function renderHeatmap() {
    if (latest === null) return;
    const container = $("heatmap-cells");
    // 放得下几周就画几周，至少一周
    weeks = Math.max(1, Math.floor((container.clientWidth + 6) / CELL_PITCH));
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate() - pagesBack * weeks * 7);
    const grid = activityGrid({ perDay: latest.perDay, firstDay: latest.firstDay, end, today, weeks });

    container.replaceChildren(
      ...grid.columns.flat().map((cell) => {
        const node = document.createElement("span");
        node.className = "cell";
        node.dataset.level = String(cell.level);
        node.dataset.state = cell.state;
        if (cell.state !== "future") {
          const [year, month, date] = cell.day.split("-").map(Number);
          const day = dayLabel.format(new Date(year, month - 1, date));
          const level = t(`home.levels.${LEVELS[cell.level]}`);
          node.title =
            cell.state === "before"
              ? t("home.notStarted", { day })
              : cell.count > 0
                ? t("home.dayCount", { day, count: cell.count, level })
                : t("home.dayLevel", { day, level });
        }
        return node;
      }),
    );
    // 月份写在这个月 1 号所在那一列的下面；列之间是均匀撑开的，按比例放
    const pitch = weeks > 1 ? (container.clientWidth - 14) / (weeks - 1) : 0;
    $("heatmap-months").replaceChildren(
      ...grid.months.map(({ column, month }) => {
        const label = document.createElement("span");
        label.textContent = t(`months.${MONTHS[month]}`);
        label.style.left = `${column * pitch}px`;
        return label;
      }),
    );
    $("heatmap-next").disabled = pagesBack === 0;
    // 第一天之前没什么可看的：最早一列已经在开始用之前了就不再往前翻
    const first = grid.columns[0][0].day;
    $("heatmap-back").disabled = latest.firstDay === null || first <= latest.firstDay;
  }

  /** 花费那张卡看的是哪一段：today / month / total。默认本月 */
  let spendPeriod = "month";
  /** 最近一次的用量报表，切换时段时重画用 */
  let usage = null;

  /** 表里的一行：头一格是名字（或"合计"），后面是花费、token、次数、一般多久 */
  function spendRow(head, { cost, tokens, count, latency }, { tag = "tr" } = {}) {
    const tr = document.createElement(tag === "tr" ? "tr" : tag);
    const th = document.createElement("th");
    th.scope = "row";
    th.append(head);
    const cells = [cost, tokens, count, latency].map((text) => {
      const td = document.createElement("td");
      td.textContent = text;
      return td;
    });
    tr.append(th, ...cells);
    return tr;
  }

  /** 一个型号叫什么：图标、名字；云上的跟着型号，本机的标"本机" */
  function modelLabel(row) {
    const label = document.createElement("span");
    label.className = "spend-model";
    const icon = row.icon ? providerIcon(row.icon) : null;
    const name = document.createElement("span");
    name.textContent = row.name;
    const detail = document.createElement("span");
    detail.className = row.local ? "spend-model-tag" : "spend-model-id";
    detail.textContent = row.local ? t("home.local") : row.model;
    label.append(...(icon ? [icon] : []), name, detail);
    return label;
  }

  const waited = (latency) => (latency ? formatSeconds(latency.medianMs, t) : "—");
  /** 有的型号没有标价时，钱只加得上知道价的那几笔 */
  const costText = (row) => (row.calls > 0 && row.unpricedCalls === row.calls ? "—" : formatUsd(row.costUsd));

  function renderSpend() {
    const card = $("spend");
    card.hidden = usage === null || usage.total.calls === 0;
    if (card.hidden) return;
    const period = usage[spendPeriod];
    for (const tab of document.querySelectorAll(".period-tab")) {
      tab.setAttribute("aria-selected", String(tab.dataset.period === spendPeriod));
    }
    $("spend-total").textContent = formatUsd(period.costUsd);
    $("spend-label").textContent = t(`home.spend.${spendPeriod}`);
    const rows = period.models.map((row) =>
      spendRow(modelLabel(row), {
        cost: row.local ? t("home.free") : costText(row),
        tokens: row.local ? "—" : formatTokens(row.tokens),
        count: String(row.dictations),
        latency: waited(row.latency),
      }),
    );
    if (rows.length === 0) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "spend-empty";
      td.textContent = t("home.emptyPeriod");
      tr.append(td);
      rows.push(tr);
    }
    $("spend-rows").replaceChildren(...rows);
    // 合计：次数是听写的次数（本机转写加润色的两跳算一次），耗时是整次听写等模型的时间
    $("spend-sum").replaceChildren(
      spendRow(t("home.sum"), {
        cost: formatUsd(period.costUsd),
        tokens: formatTokens(period.tokens),
        count: String(period.dictations),
        latency: waited(period.latency),
      }),
    );
    // 底下一行小字：里面含了几次检查、多少是提示词缓存，有的型号没标价，钱是估算的
    const notes = [];
    if (period.checks > 0) notes.push(t("home.checks", { count: period.checks }));
    if (period.cacheCostUsd > 0) notes.push(t("home.cache", { cost: formatUsd(period.cacheCostUsd) }));
    const unpriced = period.models.filter(({ unpricedCalls }) => unpricedCalls > 0);
    if (unpriced.length > 0) {
      notes.push(
        t("home.unpriced", { models: t.list(unpriced.map(({ model }) => model)), count: period.unpricedCalls }),
      );
    }
    notes.push(t("home.estimate"));
    $("spend-note").hidden = false;
    $("spend-note").textContent = notes.join(" · ");
  }

  for (const tab of document.querySelectorAll(".period-tab")) {
    tab.addEventListener("click", () => {
      spendPeriod = tab.dataset.period;
      renderSpend();
    });
  }

  $("heatmap-back").addEventListener("click", () => {
    pagesBack++;
    renderHeatmap();
  });
  $("heatmap-next").addEventListener("click", () => {
    pagesBack = Math.max(0, pagesBack - 1);
    renderHeatmap();
  });
  // 窗口拉宽拉窄时，能放下的周数跟着变
  new ResizeObserver(() => renderHeatmap()).observe($("heatmap-cells"));

  return {
    /**
     * @param {{ insights: object, usage: object, app: { version: string, hotkey: string } }} data
     */
    render({ insights, usage: report, app }) {
      latest = insights;
      renderStats(insights);
      renderHeatmap();
      usage = report;
      renderSpend();
      $("home-keycap").textContent = keycapOf(app.hotkey);
      $("home-version").textContent = `v${app.version}`;
    },
  };
}
