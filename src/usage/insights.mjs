// 首页的"洞察"：一共说了多少字、多长时间、多快、省下多少时间，哪些天在用、连着用了几天，以及活动热力图。
// 对应原版首页的那几块（hub__home__usage_stats__*、hub__home__insights__*）。原版这些数是服务端算好发下来的，
// 算法看不到；这里拿本机的历史自己算，口径写在各个函数上。
// 纯函数，不碰 Node 也不碰页面：主进程算好交给窗口，以后命令行要看也用这一份。

/**
 * 打字的速度（字每分钟），用来估"省下多少时间"：同样的字打出来要多久，减去说它用了多久。
 * 这是我们自己定的估算口径（原版的 mins_saved 在服务端算，公式看不到）：拼音输入、英文打字一般都在每分钟四十上下
 */
export const TYPING_WPM = 40;

/** 一个字算一个的文字：汉字、日文假名、韩文。别的语言按词数 */
const CHARACTER_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;
/** 一个词：字母数字连在一起的一串，中间可以夹撇号或小数点（don't、3.6） */
const WORD = /[\p{L}\p{N}]+(?:['’.][\p{L}\p{N}]+)*/gu;

/** 一段话有多少字：汉字、假名、谚文一个字算一个，别的一个词算一个，标点不算 */
export function countWords(text) {
  const characters = text.match(CHARACTER_SCRIPTS)?.length ?? 0;
  const words = text.replace(CHARACTER_SCRIPTS, " ").match(WORD)?.length ?? 0;
  return characters + words;
}

const pad = (number) => String(number).padStart(2, "0");

/** 这一刻在本机日历上是哪一天：YYYY-MM-DD */
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

/** 本机日历上往后数 n 天（n 可以是负的）。按日期加减，不按 24 小时：夏令时那天也不会错位 */
const addDays = (date, n) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + n);

/** 从 day 往前数，连着有记录的有几天（day 自己没有就是 0） */
function streakEndingOn(day, perDay) {
  let streak = 0;
  for (let cursor = day; perDay[dayKey(cursor)] > 0; cursor = addDays(cursor, -1)) streak++;
  return streak;
}

/**
 * @param {{ createdAt: string, text: string, duration: number }[]} dictations 完成了的听写（失败的不算）
 * @param {{ now: Date }} options 今天按本机的时区算
 * @returns {{ words: number, seconds: number, wordsPerMinute: number, savedSeconds: number, activeDays: number,
 *   currentStreak: number, longestStreak: number, firstDay: string | null, perDay: Record<string, number> }}
 *   perDay：每天说了几次。当前连续：今天说过就数到今天；今天还没说的话数到昨天，昨天也没说才算断了
 */
export function insights(dictations, { now }) {
  let words = 0;
  let seconds = 0;
  /** @type {Record<string, number>} */
  const perDay = {};
  for (const { createdAt, text, duration } of dictations) {
    words += countWords(text);
    seconds += duration;
    const day = dayKey(new Date(createdAt));
    perDay[day] = (perDay[day] ?? 0) + 1;
  }

  const days = Object.keys(perDay).sort();
  let longestStreak = 0;
  let run = 0;
  let previous = null;
  for (const day of days) {
    run = previous !== null && dayKey(addDays(parseDay(previous), 1)) === day ? run + 1 : 1;
    longestStreak = Math.max(longestStreak, run);
    previous = day;
  }
  const today = streakEndingOn(now, perDay);

  return {
    words,
    seconds,
    wordsPerMinute: seconds === 0 ? 0 : Math.round(words / (seconds / 60)),
    savedSeconds: Math.max(0, Math.round((words / TYPING_WPM) * 60 - seconds)),
    activeDays: days.length,
    currentStreak: today > 0 ? today : streakEndingOn(addDays(now, -1), perDay),
    longestStreak,
    firstDay: days[0] ?? null,
    perDay,
  };
}

/** YYYY-MM-DD → 本机那一天的零点 */
function parseDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

/**
 * 一天说了几次 → 热力图上的深浅：0 没说、1 轻度、2 中度、3 高、4 强力（原版图例分这五档，
 * 门槛看不到，这里按次数定：1–4 次、5–14 次、15–29 次、30 次以上）
 */
export function activityLevel(count) {
  if (count >= 30) return 4;
  if (count >= 15) return 3;
  if (count >= 5) return 2;
  if (count >= 1) return 1;
  return 0;
}

/**
 * 活动热力图：一列一周（周日在最上面），最后一列是 end 所在的那一周，往前一共 weeks 列。
 * 每一格：day、count、level（见 activityLevel）、state——past（今天和以前）、before（开始用之前，原版画斜线）、
 * future（今天以后，原版留白）。months：每个月 1 号所在的那一列标上月份（0 是一月）
 * @param {{ perDay: Record<string, number>, firstDay: string | null, end: Date, today: Date, weeks: number }} options
 */
export function activityGrid({ perDay, firstDay, end, today, weeks }) {
  const todayKey = dayKey(today);
  const start = addDays(end, -end.getDay() - (weeks - 1) * 7);
  const columns = [];
  const months = [];
  for (let column = 0; column < weeks; column++) {
    const cells = [];
    for (let row = 0; row < 7; row++) {
      const date = addDays(start, column * 7 + row);
      const day = dayKey(date);
      const count = perDay[day] ?? 0;
      const state = day > todayKey ? "future" : firstDay !== null && day < firstDay ? "before" : "past";
      cells.push({ day, count, level: activityLevel(count), state });
      if (date.getDate() === 1) months.push({ column, month: date.getMonth() });
    }
    columns.push(cells);
  }
  return { columns, months };
}
