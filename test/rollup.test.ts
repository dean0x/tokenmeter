// Tests for the periods of the status output: the day rows added into days,
// weeks and months. The zone is injected, so no test changes the TZ of the test
// process. Everything here is in memory.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DAYS_HORIZON_DAYS,
  DAYS_MAX_MODELS,
  PERIODS_LONG_ROW_MODELS,
  PERIODS_MAX_MONTHS,
  PERIODS_MAX_WEEKS,
  type Result,
  STATUS_OUTPUT_MAX_BYTES,
} from "../src/core.ts";
import { DayRows, cutoffDateOf, shiftDate } from "../src/days.ts";
import { type Zone, zoneNamed } from "../src/periods.ts";
import { type PeriodRowJson, type PeriodsInput, type PeriodsJson, type Weekday, firstWeekdayOf, periodsOf } from "../src/rollup.ts";

const HOUR_MS = 3_600_000;
const KIB = 1024;

function must<T, E>(result: Result<T, E>): T {
  if (!result.ok) assert.fail(`expected an ok result, got ${JSON.stringify(result.error)}`);
  return result.value;
}

const NEW_YORK: Zone = must(zoneNamed("America/New_York"));
const HAVANA: Zone = must(zoneNamed("America/Havana"));
const UTC: Zone = { offsetMs: () => 0 };

// Wednesday 2026-11-11 12:00 in New York. New York left summer time on Nov 1,
// so the week of Sunday Nov 1 has 169 hours.
const NOW = Date.parse("2026-11-11T17:00:00Z");

type Entry = readonly [date: string, provider: "claude" | "codex", model: string, columns: readonly number[]];

function rowsOf(entries: readonly Entry[], cutThrough: string | null = null): DayRows {
  const rows = new DayRows(true, cutThrough);
  for (const [date, provider, model, columns] of entries) rows.add(date, provider, model, columns, 1);
  return rows;
}

// A collect that ended at `nowMs` and read everything, and room for the whole output.
function inputOf(rows: DayRows, patch: Partial<PeriodsInput> = {}): PeriodsInput {
  const nowMs = patch.nowMs ?? NOW;
  return {
    rows,
    zone: NEW_YORK,
    nowMs,
    weekStart: "sun",
    collect: { at: nowMs, complete: true },
    maxBytes: STATUS_OUTPUT_MAX_BYTES,
    ...patch,
  };
}

// One claude entry a day, with `output` set so that every sum tells its days.
const BASE: readonly Entry[] = [
  ["2026-10-31", "claude", "m-a", [1, 0, 0, 0, 10]],
  ["2026-11-01", "claude", "m-a", [2, 0, 0, 0, 20]],
  ["2026-11-01", "codex", "m-c", [4, 3, 0, 2, 1]],
  ["2026-11-02", "claude", "m-a", [0, 0, 0, 0, 40]],
  ["2026-11-08", "claude", "m-a", [0, 0, 0, 0, 80]],
  ["2026-11-09", "claude", "m-a", [0, 0, 0, 0, 160]],
  ["2026-11-11", "claude", "m-b", [0, 0, 0, 0, 320]],
];

function periods(weekStart: Weekday, entries: readonly Entry[] = BASE, zone: Zone = NEW_YORK, nowMs: number = NOW): PeriodsJson {
  return periodsOf(inputOf(rowsOf(entries), { weekStart, zone, nowMs }));
}

function starts(rows: readonly PeriodRowJson[]): string[] {
  return rows.map((row) => row.start);
}

function claudeOut(rows: readonly PeriodRowJson[]): number[] {
  return rows.map((row) => row.subs.claude.out);
}

// Every list is in order and has no hole: a row ends where the next one starts.
function assertContiguous(rows: readonly PeriodRowJson[]): void {
  rows.forEach((row, index) => {
    const next = rows[index + 1];
    if (next !== undefined) assert.equal(row.end_ms, next.start_ms, `${row.start} ends where ${next.start} starts`);
  });
}

// A week or month holds the totals of the days inside it.
function assertSumsOfDays(days: readonly PeriodRowJson[], group: readonly PeriodRowJson[]): void {
  for (const row of group) {
    const inside = days.filter((day) => day.start_ms >= row.start_ms && day.start_ms < row.end_ms);
    for (const sub of ["claude", "codex", "total"] as const) {
      const add = (pick: (day: PeriodRowJson) => number): number => inside.reduce((sum, day) => sum + pick(day), 0);
      assert.equal(row.subs[sub].in, add((day) => day.subs[sub].in), `${row.start} ${sub} in`);
      assert.equal(row.subs[sub].out, add((day) => day.subs[sub].out), `${row.start} ${sub} out`);
      assert.equal(row.subs[sub].raw.weighted, add((day) => day.subs[sub].raw.weighted), `${row.start} ${sub} weighted`);
    }
  }
}

// ---------------------------------------------------------------------------
// Days
// ---------------------------------------------------------------------------

test("days run from the first day with data to today with no hole, and a day with no tokens is a row of zeros", () => {
  const { days } = periods("sun");
  assert.equal(days.length, 12);
  assert.equal(days[0]?.start, "2026-10-31");
  assert.equal(days[11]?.start, "2026-11-11");
  assertContiguous(days);
  const quiet = days.find((day) => day.start === "2026-11-04");
  assert.ok(quiet !== undefined);
  assert.deepEqual(quiet.subs.claude, { raw: { input: 0, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0, weighted: 0 }, in: 0, out: 0 });
  assert.deepEqual(quiet.models, {});
  assert.equal(quiet.full, true);
});

test("a day is from one local midnight to the next: the clock change day has 25 hours", () => {
  const { days } = periods("sun");
  const change = days.find((day) => day.start === "2026-11-01");
  assert.equal(change?.start_ms, Date.parse("2026-11-01T04:00:00Z"));
  assert.equal(change?.end_ms, Date.parse("2026-11-02T05:00:00Z"));
  assert.equal((change?.end_ms ?? 0) - (change?.start_ms ?? 0), 25 * HOUR_MS);
});

test("a day with the midnight skipped by a clock change starts at the jump", () => {
  // Havana moves its clocks from 00:00 to 01:00 on 2026-03-08.
  const entries: readonly Entry[] = [
    ["2026-03-07", "claude", "m", [0, 0, 0, 0, 1]],
    ["2026-03-08", "claude", "m", [0, 0, 0, 0, 2]],
    ["2026-03-09", "claude", "m", [0, 0, 0, 0, 3]],
  ];
  const { days } = periods("sun", entries, HAVANA, Date.parse("2026-03-10T17:00:00Z"));
  const jump = days.find((day) => day.start === "2026-03-08");
  assert.equal(jump?.start_ms, Date.parse("2026-03-08T05:00:00Z"));
  assert.equal(jump?.end_ms, Date.parse("2026-03-09T04:00:00Z"));
  assertContiguous(days);
});

test("the first day with data is not full, today is not full and current, every day between is full", () => {
  const { days } = periods("sun");
  assert.deepEqual(days.map((day) => day.full), [false, ...Array<boolean>(10).fill(true), false]);
  assert.deepEqual(days.map((day) => day.current), [...Array<boolean>(11).fill(false), true]);
});

test("in is input and every cache column, out is output, raw keeps the form of the period tokens", () => {
  const day = periods("sun").days.find((row) => row.start === "2026-11-01");
  assert.ok(day !== undefined);
  assert.deepEqual(day.subs.claude, { raw: { input: 2, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 20, weighted: 102 }, in: 2, out: 20 });
  // The Codex cache write columns are null in raw, and the 3 tokens of the column count in `in`.
  assert.deepEqual(day.subs.codex, { raw: { input: 4, cache_write: null, cache_write_1h: null, cache_read: 2, output: 1, weighted: 12.95 }, in: 9, out: 1 });
  assert.equal(day.subs.total.in, 11);
  assert.equal(day.subs.total.out, 21);
  assert.deepEqual(Object.keys(day.subs), ["claude", "codex", "total"]);
  assert.deepEqual(Object.keys(day.subs.total.raw), ["input", "cache_write", "cache_write_1h", "cache_read", "output", "weighted"]);
});

test("each model has its own totals, two providers with one model name add up, and the larger comes first", () => {
  const entries: readonly Entry[] = [
    ["2026-11-10", "claude", "shared", [1, 0, 0, 0, 1]],
    ["2026-11-10", "codex", "shared", [2, 5, 0, 0, 0]],
    ["2026-11-10", "codex", "only-codex", [0, 0, 0, 0, 100]],
    ["2026-11-10", "claude", "small", [0, 0, 0, 0, 1]],
  ];
  const day = periods("sun", entries).days[0];
  assert.deepEqual(Object.keys(day?.models ?? {}), ["only-codex", "shared", "small"]);
  assert.equal(day?.models["shared"]?.in, 8);
  assert.equal(day?.models["shared"]?.raw.cache_write, 5, "a name that Claude also has shows the cache write column");
  assert.equal(day?.models["only-codex"]?.raw.cache_write, null);
});

test("a day row keeps the 40 models with the most tokens, a week and a month row 20, and the provider totals keep all of them", () => {
  const entries: Entry[] = [];
  for (let index = 0; index < 45; index += 1) entries.push(["2026-11-10", "claude", `m${String(index).padStart(2, "0")}`, [0, 0, 0, 0, index + 1]]);
  const { days, weeks, months } = periods("sun", entries);
  const day = days[0];
  assert.equal(Object.keys(day?.models ?? {}).length, DAYS_MAX_MODELS);
  assert.equal(day?.models["m04"], undefined);
  assert.equal(day?.models["m05"]?.out, 6);
  assert.equal(day?.models["m44"]?.out, 45);
  assert.equal(day?.subs.claude.out, (45 * 46) / 2);
  for (const row of [weeks[0], months[0]]) {
    assert.equal(Object.keys(row?.models ?? {}).length, PERIODS_LONG_ROW_MODELS);
    assert.equal(row?.models["m24"], undefined);
    assert.equal(row?.models["m25"]?.out, 26);
    assert.equal(row?.subs.claude.out, (45 * 46) / 2);
  }
});

// ---------------------------------------------------------------------------
// Weeks
// ---------------------------------------------------------------------------

test("weeks that start on Sunday: the Saturday before is the week before, and each week sums its days", () => {
  const { weeks, days } = periods("sun");
  assert.deepEqual(starts(weeks), ["2026-10-25", "2026-11-01", "2026-11-08"]);
  assert.deepEqual(claudeOut(weeks), [10, 60, 560]);
  assertContiguous(weeks);
  assertSumsOfDays(days, weeks);
  // The week of Nov 1 holds the clock change: 7 days and one hour.
  assert.equal(weeks[1]?.start_ms, Date.parse("2026-11-01T04:00:00Z"));
  assert.equal(weeks[1]?.end_ms, Date.parse("2026-11-08T05:00:00Z"));
  assert.equal((weeks[1]?.end_ms ?? 0) - (weeks[1]?.start_ms ?? 0), 169 * HOUR_MS);
});

test("weeks that start on Monday: the same days fall in other weeks", () => {
  const { weeks, days, week_start: weekStart } = periods("mon");
  assert.equal(weekStart, "mon");
  assert.deepEqual(starts(weeks), ["2026-10-26", "2026-11-02", "2026-11-09"]);
  assert.deepEqual(claudeOut(weeks), [30, 120, 480]);
  assertContiguous(weeks);
  assertSumsOfDays(days, weeks);
});

test("any week start is read from the day of the week of a date, in every zone", () => {
  for (const [weekStart, first] of [["fri", "2026-10-30"], ["sat", "2026-10-31"], ["tue", "2026-10-27"]] as const) {
    assert.equal(periods(weekStart).weeks[0]?.start, first, weekStart);
    assert.equal(periods(weekStart, BASE, UTC).weeks[0]?.start, first, `${weekStart} in UTC`);
  }
});

test("a week is full when the store covers all its days and it has ended; the first week and the current week are not", () => {
  const sunday = periods("sun").weeks;
  assert.deepEqual(sunday.map((week) => week.full), [false, true, false]);
  assert.deepEqual(sunday.map((week) => week.current), [false, false, true]);
  const monday = periods("mon").weeks;
  assert.deepEqual(monday.map((week) => week.full), [false, true, false]);
  assert.deepEqual(monday.map((week) => week.current), [false, false, true]);
});

test("a week that starts on the first day with data is not full", () => {
  const { weeks } = periods("sun", [["2026-11-01", "claude", "m", [0, 0, 0, 0, 1]]]);
  assert.deepEqual(weeks.map((week) => [week.start, week.full]), [["2026-11-01", false], ["2026-11-08", false]]);
});

// ---------------------------------------------------------------------------
// Months
// ---------------------------------------------------------------------------

test("months are from the first local day to the first of the next month, and each sums its days", () => {
  const { months, days } = periods("sun");
  assert.deepEqual(starts(months), ["2026-10-01", "2026-11-01"]);
  assert.deepEqual(claudeOut(months), [10, 620]);
  assert.equal(months[0]?.start_ms, Date.parse("2026-10-01T04:00:00Z"));
  assert.equal(months[0]?.end_ms, Date.parse("2026-11-01T04:00:00Z"));
  assert.equal(months[1]?.end_ms, Date.parse("2026-12-01T05:00:00Z"));
  assertContiguous(months);
  assertSumsOfDays(days, months);
});

test("a month is full when it has ended and the first day with data is before it", () => {
  const entries: readonly Entry[] = [
    ["2026-09-30", "claude", "m", [0, 0, 0, 0, 1]],
    ["2026-10-15", "claude", "m", [0, 0, 0, 0, 2]],
    ["2026-11-02", "claude", "m", [0, 0, 0, 0, 4]],
  ];
  const { months } = periods("sun", entries);
  assert.deepEqual(months.map((month) => [month.start, month.full, month.current]), [
    ["2026-09-01", false, false],
    ["2026-10-01", true, false],
    ["2026-11-01", false, true],
  ]);
});

test("a month over a year end and a short month are found by calendar date", () => {
  const entries: readonly Entry[] = [
    ["2025-12-31", "claude", "m", [0, 0, 0, 0, 1]],
    ["2026-01-01", "claude", "m", [0, 0, 0, 0, 2]],
    ["2026-02-28", "claude", "m", [0, 0, 0, 0, 4]],
    ["2026-03-01", "claude", "m", [0, 0, 0, 0, 8]],
  ];
  const { months } = periods("sun", entries, UTC, Date.parse("2026-03-05T12:00:00Z"));
  assert.deepEqual(starts(months), ["2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01"]);
  assert.deepEqual(claudeOut(months), [1, 2, 4, 8]);
  assertContiguous(months);
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

test("no day row gives empty lists and the week start", () => {
  assert.deepEqual(periodsOf(inputOf(new DayRows(true), { weekStart: "mon" })), { week_start: "mon", days: [], weeks: [], months: [] });
});

test("a day row past the day horizon, or days after today, is left out", () => {
  const cutoff = cutoffDateOf(NEW_YORK, NOW);
  const entries: readonly Entry[] = [
    [shiftDate(cutoff, -1), "claude", "m", [0, 0, 0, 0, 1]],
    [cutoff, "claude", "m", [0, 0, 0, 0, 2]],
    ["2026-11-14", "claude", "m", [0, 0, 0, 0, 4]],
  ];
  const { days } = periods("sun", entries);
  assert.equal(days.length, DAYS_HORIZON_DAYS);
  assert.equal(days[0]?.start, cutoff);
  assert.equal(days[DAYS_HORIZON_DAYS - 1]?.start, "2026-11-11");
  assert.equal(days.reduce((sum, day) => sum + day.subs.claude.out, 0), 2);
});

// The worst store: every day of the horizon, `modelsPerDay` models in both
// providers, names of the longest length, and the largest counts that a day holds.
function fullHorizon(modelsPerDay: number): DayRows {
  const rows = new DayRows(true);
  const first = cutoffDateOf(NEW_YORK, NOW);
  for (let offset = 0; offset < DAYS_HORIZON_DAYS; offset += 1) {
    for (let model = 0; model < modelsPerDay; model += 1) {
      const name = `model-number-${model}`.padEnd(64, "x");
      rows.add(shiftDate(first, offset), "claude", name, [1_000_000 + model, 20_000, 3_000, 400_000_000, 5_000 + offset], 1);
      rows.add(shiftDate(first, offset), "codex", name, [2_000_000 + model, 0, 0, 300_000_000, 7_000 + offset], 1);
    }
  }
  return rows;
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

test("400 days give 400 day rows, and the weeks and the months stay under their caps", () => {
  const { days, weeks, months } = periodsOf(inputOf(fullHorizon(2)));
  assert.equal(days.length, DAYS_HORIZON_DAYS);
  assert.ok(weeks.length >= 57 && weeks.length <= PERIODS_MAX_WEEKS, `${weeks.length} weeks`);
  assert.ok(months.length >= 13 && months.length <= PERIODS_MAX_MONTHS, `${months.length} months`);
  assertSumsOfDays(days, weeks);
  assertSumsOfDays(days, months);
  assert.equal(days[0]?.full, false);
  assert.equal(weeks[0]?.full, false);
});

test("the worst store gives periods under the output budget, and the other fields of the output take their bytes first", () => {
  const rows = fullHorizon(DAYS_MAX_MODELS);
  for (const others of [0, 100 * KIB, 400 * KIB, 800 * KIB]) {
    const maxBytes = STATUS_OUTPUT_MAX_BYTES - others;
    const result = periodsOf(inputOf(rows, { maxBytes }));
    assert.ok(jsonBytes(result) <= maxBytes, `${others} bytes of other fields: ${jsonBytes(result)} bytes of periods`);
  }
});

test("the lists drop their oldest rows when the budget is short, the days first, then the weeks, then the months", () => {
  const rows = fullHorizon(DAYS_MAX_MODELS);
  const whole = periodsOf(inputOf(rows, { maxBytes: Number.MAX_SAFE_INTEGER }));
  assert.equal(whole.days.length, DAYS_HORIZON_DAYS, "with no limit nothing is dropped");
  const monthsBytes = jsonBytes(whole.months);
  const weeksBytes = jsonBytes(whole.weeks);

  // Room for the months and the weeks and a little more: the days are cut.
  const days = periodsOf(inputOf(rows, { maxBytes: monthsBytes + weeksBytes + 100 * KIB }));
  assert.deepEqual([days.months.length, days.weeks.length], [whole.months.length, whole.weeks.length]);
  assert.ok(days.days.length > 0 && days.days.length < DAYS_HORIZON_DAYS, `${days.days.length} days`);
  assert.equal(days.days[days.days.length - 1]?.start, "2026-11-11", "the newest day stays");

  // Room for the months and half of the weeks: no day, the oldest weeks cut.
  const weeks = periodsOf(inputOf(rows, { maxBytes: monthsBytes + weeksBytes / 2 }));
  assert.equal(weeks.days.length, 0);
  assert.equal(weeks.months.length, whole.months.length);
  assert.ok(weeks.weeks.length > 0 && weeks.weeks.length < whole.weeks.length, `${weeks.weeks.length} weeks`);
  assert.equal(weeks.weeks[weeks.weeks.length - 1]?.start, whole.weeks[whole.weeks.length - 1]?.start);

  // Room for half of the months: the newest months stay and no day fits.
  const months = periodsOf(inputOf(rows, { maxBytes: monthsBytes / 2 }));
  assert.equal(months.days.length, 0);
  assert.ok(months.months.length > 0 && months.months.length < whole.months.length, `${months.months.length} months`);
  assert.equal(months.months[months.months.length - 1]?.start, whole.months[whole.months.length - 1]?.start);

  // No room at all.
  assert.deepEqual(periodsOf(inputOf(rows, { maxBytes: 0 })), { week_start: "sun", days: [], weeks: [], months: [] });
});

test("the worst store and the largest other fields still give an output under the reader cap of 1 MiB", () => {
  const rows = fullHorizon(DAYS_MAX_MODELS);
  const others = 600 * KIB;
  const result = periodsOf(inputOf(rows, { maxBytes: STATUS_OUTPUT_MAX_BYTES - others }));
  assert.ok(others + jsonBytes(result) <= STATUS_OUTPUT_MAX_BYTES);
  assert.ok(STATUS_OUTPUT_MAX_BYTES < 1024 * KIB);
});

// ---------------------------------------------------------------------------
// What the store covers
// ---------------------------------------------------------------------------

test("a row is full only if it ended before the last collect", () => {
  // The collect ended on 2026-11-09 at 22:00 in New York. The day of Nov 9 ended after it.
  const at = Date.parse("2026-11-10T03:00:00Z");
  const { days, weeks } = periodsOf(inputOf(rowsOf(BASE), { collect: { at, complete: true } }));
  assert.deepEqual(
    days.map((day) => [day.start, day.full]),
    [
      ["2026-10-31", false],
      ...["01", "02", "03", "04", "05", "06", "07", "08"].map((day): [string, boolean] => [`2026-11-${day}`, true]),
      ["2026-11-09", false],
      ["2026-11-10", false],
      ["2026-11-11", false],
    ],
  );
  assert.deepEqual(weeks.map((week) => week.full), [false, true, false]);
});

test("a row is full when the last collect ended after the row", () => {
  // Nov 11 ended at 00:00 on Nov 12 in New York, which is 05:00Z; the collect ended at 06:00Z.
  const late = Date.parse("2026-11-12T06:00:00Z");
  const { days } = periodsOf(inputOf(rowsOf(BASE), { nowMs: late, collect: { at: late, complete: true } }));
  assert.equal(days.find((day) => day.start === "2026-11-11")?.full, true);
  assert.equal(days.find((day) => day.start === "2026-11-12")?.current, true);
});

test("no row is full while the last collect left a backlog", () => {
  const { days, weeks, months } = periodsOf(inputOf(rowsOf(BASE), { collect: { at: NOW, complete: false } }));
  assert.equal([...days, ...weeks, ...months].some((row) => row.full), false);
  assert.equal(days.length, 12, "the rows are still there");
});

test("a cut backfill leaves the days up to its mark, and the weeks and months that hold them, not full", () => {
  const { days, weeks } = periodsOf(inputOf(rowsOf(BASE, "2026-11-05")));
  assert.deepEqual(
    days.filter((day) => day.start <= "2026-11-07").map((day) => [day.start, day.full]),
    [
      ["2026-10-31", false],
      ["2026-11-01", false],
      ["2026-11-02", false],
      ["2026-11-03", false],
      ["2026-11-04", false],
      ["2026-11-05", false],
      ["2026-11-06", true],
      ["2026-11-07", true],
    ],
  );
  // Without the mark the week of Nov 1 is full.
  assert.deepEqual(weeks.map((week) => week.full), [false, false, false]);
  assert.equal(periodsOf(inputOf(rowsOf(BASE))).weeks[1]?.full, true);
});

// ---------------------------------------------------------------------------
// The first day of the week
// ---------------------------------------------------------------------------

test("the first day of the week comes from the locale; a locale that is not valid gives Sunday", () => {
  assert.equal(firstWeekdayOf("en-US"), "sun");
  assert.equal(firstWeekdayOf("de-DE"), "mon");
  assert.equal(firstWeekdayOf("en-GB"), "mon");
  assert.equal(firstWeekdayOf("not a locale!"), "sun");
});
