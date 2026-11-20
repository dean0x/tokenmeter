// The periods of the status output: the day rows of days.json added into days,
// weeks and months. Pure functions of the rows, the zone and the clock.
//
//   periods { week_start, days, weeks, months }   each list oldest first
//
// A row is {start, start_ms, end_ms, full, current, subs, models}. `start` is the
// first local day, `start_ms` and `end_ms` are the local midnights of the start
// and of the next period. A week or month is the sum of its days, so every total
// agrees with the days. The list starts at the first day with data and has no
// gap after it: a day with no tokens is a row of zeros.
//
// `full` is true when the store covers every day of the row. That needs all of:
//   - the row ended before the last collect, and the last collect read everything
//     (a row that ended after it, or a backlog of unread lines, may miss tokens);
//   - the row starts after the first day with data (its start may be cut by the
//     logs that are gone or by the day horizon), so the week and the month of
//     that day are not full, and neither is the current period;
//   - the row starts after the last day that a cut backfill may have left
//     incomplete (days.json keeps it).
//
// The lists share a byte budget, so that the whole output stays under the cap of
// its reader: the months first, then the weeks, then the days. A list drops its
// oldest rows when the budget is short.

import {
  DAYS_MAX_MODELS,
  PERIODS_LONG_ROW_MODELS,
  PERIODS_MAX_DAYS,
  PERIODS_MAX_MONTHS,
  PERIODS_MAX_WEEKS,
} from "./core.ts";
import { totalsOf } from "./analysis.ts";
import { type DayRows, type DayTotals, cutoffDateOf, localDateOf, shiftDate, topModels, zeroColumns } from "./days.ts";
import { type Zone, localDayStart } from "./periods.ts";
import { type TokenColumnsJson, tokensJson } from "./status.ts";

// Index is the day of the week as JS counts it: 0 is Sunday.
export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export function isWeekday(value: string): value is Weekday {
  return (WEEKDAYS as readonly string[]).includes(value);
}

// Locale weekInfo gives the first day as 1 (Monday) to 7 (Sunday). A runtime
// without it, or a locale it does not know, gives Sunday.
interface WeekInfoLocale {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
}

export function firstWeekdayOf(locale: string): Weekday {
  try {
    const parsed = new Intl.Locale(locale) as Intl.Locale & WeekInfoLocale;
    const info = typeof parsed.getWeekInfo === "function" ? parsed.getWeekInfo() : parsed.weekInfo;
    const index = (info?.firstDay ?? 7) % WEEKDAYS.length;
    return WEEKDAYS[index] ?? "sun";
  } catch {
    return "sun";
  }
}

// The locale of this process, as ICU has it from the environment.
export function systemLocale(): string {
  return new Intl.DateTimeFormat().resolvedOptions().locale;
}

// ---------------------------------------------------------------------------
// The output shape
// ---------------------------------------------------------------------------

// `raw` is the five raw columns in the form of the periods of `subscriptions`
// (the Codex cache write columns are null). `in` adds input and all cache
// columns, `out` is the output.
export interface TotalJson {
  readonly raw: TokenColumnsJson;
  readonly in: number;
  readonly out: number;
}

export interface PeriodRowJson {
  readonly start: string;
  readonly start_ms: number;
  readonly end_ms: number;
  readonly full: boolean;
  readonly current: boolean;
  readonly subs: { readonly claude: TotalJson; readonly codex: TotalJson; readonly total: TotalJson };
  readonly models: Readonly<Record<string, TotalJson>>;
}

export interface PeriodsJson {
  readonly week_start: Weekday;
  readonly days: readonly PeriodRowJson[];
  readonly weeks: readonly PeriodRowJson[];
  readonly months: readonly PeriodRowJson[];
  // Rows within the count caps that did not fit the byte budget.
  readonly cut: { readonly days: number; readonly weeks: number; readonly months: number };
}

// ---------------------------------------------------------------------------
// Sums
// ---------------------------------------------------------------------------

interface Sum {
  readonly claude: number[];
  readonly codex: number[];
  // By model name. Two providers with one model name add into one entry.
  readonly models: Map<string, number[]>;
  readonly claudeModels: Set<string>;
}

function newSum(): Sum {
  return { claude: zeroColumns(), codex: zeroColumns(), models: new Map(), claudeModels: new Set() };
}

function addInto(target: number[], columns: readonly number[]): void {
  target.forEach((value, index) => {
    target[index] = value + (columns[index] ?? 0);
  });
}

function addDay(sum: Sum, day: DayTotals | undefined): void {
  if (day === undefined) return;
  addInto(sum.claude, day.claude);
  addInto(sum.codex, day.codex);
  for (const [key, columns] of day.models) {
    const separator = key.indexOf("|");
    const name = key.slice(separator + 1);
    const into = sum.models.get(name) ?? zeroColumns();
    addInto(into, columns);
    sum.models.set(name, into);
    if (key.slice(0, separator) === "claude") sum.claudeModels.add(name);
  }
}

function totalJson(columns: readonly number[], provider: "claude" | "codex"): TotalJson {
  const [input = 0, cacheWrite5m = 0, cacheWrite1h = 0, cacheRead = 0, output = 0] = columns;
  return {
    raw: tokensJson(totalsOf(columns), provider),
    in: input + cacheWrite5m + cacheWrite1h + cacheRead,
    out: output,
  };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function weekStartDate(date: string, weekStart: Weekday): string {
  const day = new Date(Date.parse(`${date}T00:00:00Z`)).getUTCDay();
  const back = (day - WEEKDAYS.indexOf(weekStart) + WEEKDAYS.length) % WEEKDAYS.length;
  return shiftDate(date, -back);
}

function monthStartDate(date: string): string {
  return `${date.slice(0, 8)}01`;
}

// A month has 28 to 31 days, so 31 days after its first day is in the next month.
function nextMonthStartDate(date: string): string {
  return monthStartDate(shiftDate(monthStartDate(date), 31));
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface Clock {
  readonly zone: Zone;
  readonly nowMs: number;
  // A row is full only if it ended by this time: the end of the last collect, or
  // never when that collect left a backlog.
  readonly coveredUntilMs: number;
  // The first day with data.
  readonly first: string;
  // The last day that a cut backfill may have left incomplete, or null.
  readonly cutThrough: string | null;
  // The local midnight of each date that a row needs, found once.
  readonly starts: Map<string, number>;
}

function startOf(clock: Clock, date: string): number {
  let ms = clock.starts.get(date);
  if (ms === undefined) {
    ms = localDayStart(clock.zone, date);
    clock.starts.set(date, ms);
  }
  return ms;
}

function rowOf(clock: Clock, start: string, next: string, sum: Sum, modelLimit: number): PeriodRowJson {
  const startMs = startOf(clock, start);
  const endMs = startOf(clock, next);
  const claude = totalJson(sum.claude, "claude");
  const codex = totalJson(sum.codex, "codex");
  const both = zeroColumns();
  addInto(both, sum.claude);
  addInto(both, sum.codex);
  const models = topModels(sum.models, modelLimit).map(([name, columns]): readonly [string, TotalJson] => [
    name,
    totalJson(columns, sum.claudeModels.has(name) ? "claude" : "codex"),
  ]);
  const covered = start > clock.first && (clock.cutThrough === null || start > clock.cutThrough);
  return {
    start,
    start_ms: startMs,
    end_ms: endMs,
    full: covered && endMs <= clock.coveredUntilMs,
    current: startMs <= clock.nowMs && clock.nowMs < endMs,
    subs: { claude, codex, total: totalJson(both, "claude") },
    models: Object.fromEntries(models),
  };
}

interface Fitted {
  readonly rows: readonly PeriodRowJson[];
  // The JSON text of the rows, with one byte for each separator.
  readonly bytes: number;
  readonly cut: number;
}

// The newest rows, as many as fit in `maxBytes` of JSON text.
function newestWithin(rows: readonly PeriodRowJson[], maxBytes: number): Fitted {
  let bytes = 0;
  let keep = rows.length;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const size = row === undefined ? 0 : Buffer.byteLength(JSON.stringify(row)) + 1;
    if (bytes + size > maxBytes) break;
    bytes += size;
    keep = index;
  }
  return { rows: rows.slice(keep), bytes, cut: keep };
}

const EMPTY_LISTS = { days: [], weeks: [], months: [] } as const;
const ZERO_CUT = { days: 0, weeks: 0, months: 0 } as const;

// Day rows older than the day horizon, and rows dated more than two days after
// today (a clock or zone that moved), are left out.
const FUTURE_SLACK_DAYS = 2;

// Reserve the JSON frame with the largest possible cut count in each list.
const FRAME_BYTES = Buffer.byteLength(JSON.stringify({
  week_start: "sun", ...EMPTY_LISTS,
  cut: { days: PERIODS_MAX_DAYS, weeks: PERIODS_MAX_WEEKS, months: PERIODS_MAX_MONTHS },
}));

export interface PeriodsInput {
  readonly rows: DayRows;
  readonly zone: Zone;
  readonly nowMs: number;
  readonly weekStart: Weekday;
  // The last collect: when it ended, and whether it read every line.
  readonly collect: { readonly at: number; readonly complete: boolean };
  // The bytes that the periods may take as JSON text.
  readonly maxBytes: number;
}

export function periodsOf({ rows, zone, nowMs, weekStart, collect, maxBytes }: PeriodsInput): PeriodsJson {
  const today = localDateOf(zone, nowMs);
  const newest = shiftDate(today, FUTURE_SLACK_DAYS);
  const cutoff = cutoffDateOf(zone, nowMs);
  const dates = rows.dates().filter((date) => date >= cutoff && date <= newest);
  const first = dates[0];
  const last = dates[dates.length - 1];
  if (first === undefined || last === undefined) return { week_start: weekStart, ...EMPTY_LISTS, cut: ZERO_CUT };

  const clock: Clock = {
    zone,
    nowMs,
    coveredUntilMs: collect.complete ? Math.min(collect.at, nowMs) : Number.NEGATIVE_INFINITY,
    first,
    cutThrough: rows.cutThrough,
    starts: new Map(),
  };
  const weeks = new Map<string, Sum>();
  const months = new Map<string, Sum>();
  const days: { readonly date: string; readonly sum: Sum }[] = [];
  const end = last > today ? last : today;
  // One pass over the days from the first to the last: every day, with its sums
  // added into its week and its month. The bound is the cap on day rows.
  for (let date = first, count = 0; date <= end && count < PERIODS_MAX_DAYS; date = shiftDate(date, 1), count += 1) {
    const sum = newSum();
    addDay(sum, rows.get(date));
    days.push({ date, sum });
    for (const [map, key] of [
      [weeks, weekStartDate(date, weekStart)],
      [months, monthStartDate(date)],
    ] as const) {
      const into = map.get(key) ?? newSum();
      addDay(into, rows.get(date));
      map.set(key, into);
    }
  }

  const dayRows = days.map(({ date, sum }) => rowOf(clock, date, shiftDate(date, 1), sum, DAYS_MAX_MODELS));
  const weekRows = [...weeks].map(([start, sum]) =>
    rowOf(clock, start, shiftDate(start, 7), sum, PERIODS_LONG_ROW_MODELS),
  );
  const monthRows = [...months].map(([start, sum]) =>
    rowOf(clock, start, nextMonthStartDate(start), sum, PERIODS_LONG_ROW_MODELS),
  );
  const room = Math.max(0, maxBytes - FRAME_BYTES);
  const fitMonths = newestWithin(monthRows.slice(-PERIODS_MAX_MONTHS), room);
  const fitWeeks = newestWithin(weekRows.slice(-PERIODS_MAX_WEEKS), room - fitMonths.bytes);
  const fitDays = newestWithin(dayRows.slice(-PERIODS_MAX_DAYS), room - fitMonths.bytes - fitWeeks.bytes);
  return {
    week_start: weekStart, days: fitDays.rows, weeks: fitWeeks.rows, months: fitMonths.rows,
    cut: { days: fitDays.cut, weeks: fitWeeks.cut, months: fitMonths.cut },
  };
}
