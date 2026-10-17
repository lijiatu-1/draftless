import assert from "node:assert/strict";
import { test } from "node:test";
import { activityGrid, activityLevel, countWords, dayKey, insights, TYPING_WPM } from "../../src/usage/insights.mjs";

// 日期都用本地时间构造：一天从哪儿算起跟着本机时区走，测试在哪个时区跑都一样
const at = (month, date, hour = 10) => new Date(2026, month - 1, date, hour).toISOString();
const said = (month, date, text = "你好世界", duration = 3) => ({ createdAt: at(month, date), text, duration });

test("字数：汉字、假名、谚文一个字算一个，别的语言一个词算一个，标点不算", () => {
  assert.equal(countWords("你好，世界。"), 4);
  assert.equal(countWords("Hello, world!"), 2);
  // 版本号 3.6 是一个词
  assert.equal(countWords("用 Gemini 3.6 Flash 整理"), 1 + 1 + 1 + 1 + 2);
  assert.equal(countWords("don't stop"), 2);
  assert.equal(countWords("こんにちは"), 5);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("……"), 0);
});

test("哪一天按本机的日历算", () => {
  assert.equal(dayKey(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
  assert.equal(dayKey(new Date(2026, 9, 14, 0, 0)), "2026-10-14");
});

test("总字数、总时长、平均速度、按打字速度算省下的时间", () => {
  const result = insights([said(10, 13, "一二三四五六七八九十", 6), said(10, 14, "one two three four five six", 6)], {
    now: new Date(2026, 9, 14, 12),
  });
  assert.equal(result.words, 16);
  assert.equal(result.seconds, 12);
  // 16 个字用了 12 秒：每分钟 80 个
  assert.equal(result.wordsPerMinute, 80);
  // 打这 16 个字要 16 / 40 分钟 = 24 秒，说只用了 12 秒
  assert.equal(TYPING_WPM, 40);
  assert.equal(result.savedSeconds, 12);
});

test("说得比打字还慢的，省下的时间不算成负的", () => {
  const result = insights([said(10, 14, "好", 30)], { now: new Date(2026, 9, 14, 12) });
  assert.equal(result.savedSeconds, 0);
});

test("什么都没说过：都是 0，没有第一天", () => {
  const result = insights([], { now: new Date(2026, 9, 14, 12) });
  assert.deepEqual(
    { ...result, perDay: Object.keys(result.perDay).length },
    {
      words: 0,
      seconds: 0,
      wordsPerMinute: 0,
      savedSeconds: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      firstDay: null,
      perDay: 0,
    },
  );
});

test("活跃天数、最长连续、当前连续：今天说过就数到今天", () => {
  const result = insights(
    [said(10, 1), said(10, 2), said(10, 3), said(10, 3), said(10, 10), said(10, 13), said(10, 14)],
    { now: new Date(2026, 9, 14, 12) },
  );
  assert.equal(result.activeDays, 6);
  assert.equal(result.longestStreak, 3);
  assert.equal(result.currentStreak, 2);
  assert.equal(result.firstDay, "2026-10-01");
  assert.equal(result.perDay["2026-10-03"], 2);
});

test("今天还没说：当前连续数到昨天，没断；昨天也没说才算断了", () => {
  const now = new Date(2026, 9, 14, 8);
  assert.equal(insights([said(10, 12), said(10, 13)], { now }).currentStreak, 2);
  assert.equal(insights([said(10, 11), said(10, 12)], { now }).currentStreak, 0);
});

test("连续天数跨月也接得上", () => {
  const result = insights([said(9, 30), said(10, 1)], { now: new Date(2026, 9, 1, 12) });
  assert.equal(result.longestStreak, 2);
  assert.equal(result.currentStreak, 2);
});

test("活跃程度分五档：没说、轻度、中度、高、强力", () => {
  assert.equal(activityLevel(0), 0);
  assert.equal(activityLevel(1), 1);
  assert.equal(activityLevel(4), 1);
  assert.equal(activityLevel(5), 2);
  assert.equal(activityLevel(15), 3);
  assert.equal(activityLevel(30), 4);
  assert.equal(activityLevel(500), 4);
});

test("热力图：每列一周、周日在上，最后一列是今天那一周；第一天之前和今天之后另外标出来", () => {
  // 2026-10-14 是周三
  const today = new Date(2026, 9, 14, 12);
  const perDay = { "2026-10-05": 3, "2026-10-14": 20 };
  const grid = activityGrid({ perDay, firstDay: "2026-10-05", end: today, today, weeks: 3 });

  assert.equal(grid.columns.length, 3);
  for (const column of grid.columns) assert.equal(column.length, 7);
  // 第一列从 2026-09-27（周日）开始
  assert.equal(grid.columns[0][0].day, "2026-09-27");
  assert.equal(grid.columns[2][6].day, "2026-10-17");

  const cell = (day) => grid.columns.flat().find((c) => c.day === day);
  assert.equal(cell("2026-10-04").state, "before");
  assert.deepEqual(cell("2026-10-05"), { day: "2026-10-05", count: 3, level: 1, state: "past" });
  assert.deepEqual(cell("2026-10-06"), { day: "2026-10-06", count: 0, level: 0, state: "past" });
  assert.deepEqual(cell("2026-10-14"), { day: "2026-10-14", count: 20, level: 3, state: "past" });
  assert.equal(cell("2026-10-15").state, "future");
});

test("热力图的月份标在这个月 1 号所在的那一列下面", () => {
  const today = new Date(2026, 9, 14, 12);
  const grid = activityGrid({ perDay: {}, firstDay: null, end: today, today, weeks: 3 });
  // 三列是 9-27、10-4、10-11 开头的三周：10 月 1 号在第一列（month 从 0 数，9 是十月）
  assert.deepEqual(grid.months, [{ column: 0, month: 9 }]);
});

test("往前翻：end 换成更早的一天，最后一列就是那一周", () => {
  const today = new Date(2026, 9, 14, 12);
  const grid = activityGrid({ perDay: {}, firstDay: "2026-01-01", end: new Date(2026, 8, 1), today, weeks: 1 });
  assert.equal(grid.columns[0][0].day, "2026-08-30");
  assert.ok(grid.columns[0].every((cell) => cell.state === "past"));
});

test("从没说过：第一天之前的格子是空的那种，不是斜线", () => {
  const today = new Date(2026, 9, 14, 12);
  const grid = activityGrid({ perDay: {}, firstDay: null, end: today, today, weeks: 1 });
  assert.equal(grid.columns[0][0].state, "past");
});
