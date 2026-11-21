// Tests for the periods, the token totals, the calibration and the forecast
// (plan 3.5, section 4, step 6). TP-2, TP-3 (the period and model split) and TP-5,
// with the time zone cases for the two DST changes of Europe/Berlin in 2026.
//
// The time zone is an injected dependency. One test starts a child process with
// TZ set, to check the local zone. No test changes the TZ of the test process.
// Data folders and writes are inside a sandbox.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SLOT_MS, type Result, type TokenRecord } from "../src/core.ts";
import {
  type Analysis,
  type AnalysisInput,
  type BucketRow,
  CALIBRATION_LABEL,
  NOT_READY_LABEL,
  type SubscriptionUsage,
  type TokenTotals,
  analyze,
  forecastFrom,
  loadBucketRows,
  periodSlots,
  readAnalysis,
} from "../src/analysis.ts";
import {
  HOUR_MS,
  WEEK_MS,
  type Zone,
  localZone,
  monthPeriod,
  slotRange,
  todayPeriod,
  weekPeriod,
  zoneNamed,
} from "../src/periods.ts";
import {
  QUOTA_LATEST_FILE,
  type QuotaSample,
  type StatuslineQuota,
  quotaMonthFile,
  recordStatuslineQuota,
  sampleLine,
  storeCodexQuota,
} from "../src/quota.ts";
import { DAY_MS, type Provider, bucketKey, parseBucketKey, slotOf } from "../src/store.ts";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();

const MINUTE_MS = 60_000;
const PROBE = join(import.meta.dirname, "fixtures", "tz-probe.ts");

// A Friday reset, a Thursday "now" inside that week.
const RESET = Date.parse("2026-11-06T09:00:00Z");
const START = RESET - WEEK_MS;
const NOW = Date.parse("2026-11-05T12:00:00Z");

const UTC: Zone = { offsetMs: () => 0 };
const ZERO: TokenRecord = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

function utc(iso: string): number {
  return Date.parse(iso);
}

function must<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, "the result is an error");
  return result.value;
}

function near(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not near ${expected}`);
}

function tokens(part: Partial<TokenRecord>): TokenRecord {
  return { ...ZERO, ...part };
}

function totals(part: Partial<TokenRecord>, weighted: number): TokenTotals {
  return { ...ZERO, ...part, weighted };
}

function row(
  ms: number,
  provider: Provider,
  model: string,
  part: Partial<TokenRecord>,
  folderKey = "proj",
): BucketRow {
  return { slot: slotOf(ms), provider, model, folderKey, tokens: tokens(part) };
}

// One row for each 15-minute slot from `fromMs` up to, not including, `toMs`.
function fill(provider: Provider, fromMs: number, toMs: number, part: Partial<TokenRecord>): BucketRow[] {
  const rows: BucketRow[] = [];
  for (let ms = fromMs; ms < toMs; ms += SLOT_MS) rows.push(row(ms, provider, "m", part));
  return rows;
}

function sample(
  provider: Provider,
  at: number,
  usedPercent: number,
  resetsAt = RESET,
  window: QuotaSample["window"] = "week",
): QuotaSample {
  return { provider, window, at, usedPercent, resetsAt };
}

function run(over: Partial<AnalysisInput>): Analysis {
  return analyze({ nowMs: NOW, zone: UTC, rows: [], samples: [], observations: [], collectState: "ok", ...over });
}

function sub(analysis: Analysis, provider: Provider): SubscriptionUsage {
  const found = analysis.subscriptions.find((s) => s.provider === provider);
  assert.ok(found !== undefined, "the subscription is missing");
  return found;
}

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

test("zoneNamed gives the Berlin offset on both sides of the two DST changes", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  assert.equal(berlin.offsetMs(utc("2026-03-29T00:59:59.999Z")), HOUR_MS);
  assert.equal(berlin.offsetMs(utc("2026-03-29T01:00:00Z")), 2 * HOUR_MS);
  assert.equal(berlin.offsetMs(utc("2026-10-25T00:59:59.999Z")), 2 * HOUR_MS);
  assert.equal(berlin.offsetMs(utc("2026-10-25T01:00:00Z")), HOUR_MS);
});

test("zoneNamed refuses an unknown zone name", () => {
  const result = zoneNamed("Not/AZone");
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error, "bad_zone");
});

// ---------------------------------------------------------------------------
// Today and the month, local time
// ---------------------------------------------------------------------------

test("today in Berlin on the spring DST day is 23 hours from local midnight", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  const today = todayPeriod(berlin, utc("2026-03-29T12:00:00Z"));
  assert.equal(today.start, utc("2026-03-28T23:00:00Z"));
  assert.equal(today.end, utc("2026-03-29T22:00:00Z"));
});

test("today in Berlin on the autumn DST day is 25 hours from local midnight", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  const today = todayPeriod(berlin, utc("2026-10-25T12:00:00Z"));
  assert.equal(today.start, utc("2026-10-24T22:00:00Z"));
  assert.equal(today.end, utc("2026-10-25T23:00:00Z"));
});

test("today changes at local midnight, not at midnight UTC", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  const before = todayPeriod(berlin, utc("2026-11-03T22:59:59.999Z"));
  const after = todayPeriod(berlin, utc("2026-11-03T23:00:00Z"));
  assert.equal(before.start, utc("2026-11-02T23:00:00Z"));
  assert.equal(after.start, utc("2026-11-03T23:00:00Z"));
  assert.equal(before.end, after.start);
});

test("today in a zone with a half hour offset", () => {
  const kolkata = must(zoneNamed("Asia/Kolkata"));
  const today = todayPeriod(kolkata, utc("2026-11-05T20:00:00Z"));
  assert.equal(today.start, utc("2026-11-05T18:30:00Z"));
  assert.equal(today.end, utc("2026-11-06T18:30:00Z"));
});

test("today starts at the first instant of the day when local midnight does not exist", () => {
  const jump = utc("2026-06-10T00:00:00Z");
  // The local clock goes from 23:59:59.999 to 01:00 at `jump`.
  const gap: Zone = { offsetMs: (ms) => (ms >= jump ? HOUR_MS : 0) };
  const today = todayPeriod(gap, jump + 5 * HOUR_MS);
  assert.equal(today.start, jump);
  assert.equal(today.end, utc("2026-06-10T23:00:00Z"));
});

test("the month in Berlin starts at local midnight of the first, in March and October", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  const march = monthPeriod(berlin, utc("2026-03-29T12:00:00Z"));
  assert.equal(march.start, utc("2026-02-28T23:00:00Z"));
  assert.equal(march.end, utc("2026-03-31T22:00:00Z"));
  const october = monthPeriod(berlin, utc("2026-10-25T12:00:00Z"));
  assert.equal(october.start, utc("2026-09-30T22:00:00Z"));
  assert.equal(october.end, utc("2026-10-31T23:00:00Z"));
});

test("the month follows the local date near the turn of the month", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  // 00:30 local on 1 October, still 30 September in UTC.
  const october = monthPeriod(berlin, utc("2026-09-30T22:30:00Z"));
  assert.equal(october.start, utc("2026-09-30T22:00:00Z"));
  // 23:30 local on 31 October, 22:30 in UTC.
  const stillOctober = monthPeriod(berlin, utc("2026-10-31T22:30:00Z"));
  assert.equal(stillOctober.start, utc("2026-09-30T22:00:00Z"));
  const november = monthPeriod(berlin, utc("2026-10-31T23:00:00Z"));
  assert.equal(november.start, utc("2026-10-31T23:00:00Z"));
  assert.equal(november.end, utc("2026-11-30T23:00:00Z"));
});

test("the month rolls over the end of the year", () => {
  const month = monthPeriod(UTC, utc("2026-12-15T10:00:00Z"));
  assert.equal(month.start, utc("2026-12-01T00:00:00Z"));
  assert.equal(month.end, utc("2027-01-01T00:00:00Z"));
});

test("localZone follows the TZ of a child process", (t) => {
  const sb = makeSandbox(t);
  const probe = (tz: string, nowMs: number): { today: { start: number; end: number }; month: { start: number; end: number } } => {
    const child = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", PROBE, String(nowMs)],
      { env: { ...sb.env, TZ: tz }, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(child.status, 0);
    return JSON.parse(child.stdout);
  };
  const spring = utc("2026-03-29T12:00:00Z");
  const berlin = probe("Europe/Berlin", spring);
  assert.equal(berlin.today.start, utc("2026-03-28T23:00:00Z"));
  assert.equal(berlin.today.end, utc("2026-03-29T22:00:00Z"));
  assert.equal(berlin.month.start, utc("2026-02-28T23:00:00Z"));
  const zero = probe("UTC", spring);
  assert.equal(zero.today.start, utc("2026-03-29T00:00:00Z"));
  assert.equal(zero.month.start, utc("2026-03-01T00:00:00Z"));
  assert.equal(typeof localZone().offsetMs(spring), "number");
});

// ---------------------------------------------------------------------------
// The week
// ---------------------------------------------------------------------------

test("the Claude week is the seven days before the latest week reset", () => {
  const week = weekPeriod([sample("claude", START + HOUR_MS, 3)], "claude", NOW);
  assert.deepEqual(week, { start: START, end: RESET, kind: "reset" });
});

test("the week is rolled forward by whole weeks when the reset is past", () => {
  const old = sample("claude", utc("2026-10-20T09:00:00Z"), 40, utc("2026-10-23T09:00:00Z"));
  const week = weekPeriod([old], "claude", NOW);
  assert.deepEqual(week, { start: utc("2026-10-30T09:00:00Z"), end: RESET, kind: "reset" });
});

test("a reset at exactly now is past, so the week rolls forward", () => {
  const ended = sample("claude", NOW - 2 * HOUR_MS, 40, NOW);
  const week = weekPeriod([ended], "claude", NOW);
  assert.deepEqual(week, { start: NOW, end: NOW + WEEK_MS, kind: "reset" });
});

test("the week with no week sample is a rolling seven days of whole slots", () => {
  const week = weekPeriod([], "claude", utc("2026-11-05T12:07:00Z"));
  assert.deepEqual(week, {
    start: utc("2026-10-29T12:15:00Z"),
    end: utc("2026-11-05T12:15:00Z"),
    kind: "rolling",
  });
});

test("the week ignores five hour samples and the other provider", () => {
  const samples = [
    sample("claude", NOW - HOUR_MS, 10, NOW + HOUR_MS, "five_hour"),
    sample("codex", NOW - HOUR_MS, 10, RESET),
  ];
  assert.equal(weekPeriod(samples, "claude", NOW).kind, "rolling");
  assert.equal(weekPeriod(samples, "codex", NOW).kind, "reset");
});

test("the week takes the newest reset period when samples of two periods exist", () => {
  const samples = [
    sample("claude", START - 3 * 24 * HOUR_MS, 90, START + 1000),
    sample("claude", START + HOUR_MS, 3, RESET),
  ];
  assert.equal(weekPeriod(samples, "claude", NOW).end, RESET);
});

test("slotRange maps a period to whole slots, the slot of the end going to the next period", () => {
  const range = slotRange({ start: utc("2026-11-05T09:07:30Z"), end: utc("2026-11-06T09:07:30Z") });
  assert.equal(range.from, slotOf(utc("2026-11-05T09:00:00Z")));
  assert.equal(range.to, slotOf(utc("2026-11-06T09:00:00Z")));
});

test("periodSlots gives both subscriptions the same today and month, and each its own week", () => {
  const codexReset = RESET + 2 * DAY_MS;
  const analysis = run({
    samples: [sample("claude", NOW - HOUR_MS, 40), sample("codex", NOW - HOUR_MS, 10, codexReset)],
  });
  const today = slotRange({ start: utc("2026-11-05T00:00:00Z"), end: utc("2026-11-06T00:00:00Z") });
  const month = slotRange({ start: utc("2026-11-01T00:00:00Z"), end: utc("2026-12-01T00:00:00Z") });
  const claudeWeek = slotRange({ start: START, end: RESET });
  const codexWeek = slotRange({ start: codexReset - WEEK_MS, end: codexReset });
  // Four different ranges: a mixed-up mapping can not give the right answer by chance.
  assert.equal(new Set([today, month, claudeWeek, codexWeek].map((range) => `${range.from}:${range.to}`)).size, 4);

  const slots = periodSlots(analysis);
  assert.deepEqual(slots.claude, { today, week: claudeWeek, month });
  assert.deepEqual(slots.codex, { today, week: codexWeek, month });
});

test("periodSlots gives an empty week to a subscription that is not in the analysis", () => {
  const analysis = run({ samples: [sample("claude", NOW - HOUR_MS, 40)] });
  const claudeOnly = { ...analysis, subscriptions: analysis.subscriptions.filter((s) => s.provider === "claude") };
  const slots = periodSlots(claudeOnly);
  assert.deepEqual(slots.codex.week, { from: 0, to: 0 });
  assert.deepEqual(slots.claude.week, slotRange({ start: START, end: RESET }));
});

// ---------------------------------------------------------------------------
// Tokens per period, subscription and model (TP-3)
// ---------------------------------------------------------------------------

const SPLIT_ROWS: readonly BucketRow[] = [
  row(utc("2026-11-05T10:00:00Z"), "claude", "opus", { input: 100, cacheWrite5m: 40, cacheWrite1h: 10, cacheRead: 1000, output: 20 }, "proj-a"),
  row(utc("2026-11-05T11:00:00Z"), "claude", "opus", { input: 1 }, "proj-b"),
  row(utc("2026-11-03T10:00:00Z"), "claude", "opus", { input: 7 }),
  row(utc("2026-11-01T00:00:00Z"), "claude", "sonnet", { output: 3 }),
  row(utc("2026-10-31T23:45:00Z"), "claude", "sonnet", { input: 5 }),
  row(utc("2026-10-30T08:45:00Z"), "claude", "opus", { input: 11 }),
  row(utc("2026-11-05T09:00:00Z"), "codex", "gpt-5", { input: 50, cacheRead: 500, output: 5 }),
  row(utc("2026-10-29T12:15:00Z"), "codex", "gpt-5", { input: 9 }),
  row(utc("2026-10-29T12:00:00Z"), "codex", "gpt-5", { input: 1000 }),
];

test("tokens split by period and subscription with five columns and the weighted value", () => {
  const analysis = run({ rows: SPLIT_ROWS, samples: [sample("claude", utc("2026-11-05T09:00:00Z"), 40)] });
  const claude = sub(analysis, "claude");
  // 1 h cache write has weight 2, 5 min 1.25, cache read 0.1, output 5.
  assert.deepEqual(claude.tokens.today, totals({ input: 101, cacheWrite5m: 40, cacheWrite1h: 10, cacheRead: 1000, output: 20 }, 371));
  assert.deepEqual(claude.tokens.week, totals({ input: 113, cacheWrite5m: 40, cacheWrite1h: 10, cacheRead: 1000, output: 23 }, 398));
  assert.deepEqual(claude.tokens.month, totals({ input: 108, cacheWrite5m: 40, cacheWrite1h: 10, cacheRead: 1000, output: 23 }, 393));
  const codex = sub(analysis, "codex");
  assert.deepEqual(codex.tokens.today, totals({ input: 50, cacheRead: 500, output: 5 }, 125));
  assert.deepEqual(codex.tokens.week, totals({ input: 59, cacheRead: 500, output: 5 }, 134));
  assert.deepEqual(codex.tokens.month, totals({ input: 50, cacheRead: 500, output: 5 }, 125));
});

test("a 1 hour cache write counts with weight 2", () => {
  const analysis = run({ rows: [row(NOW - HOUR_MS, "claude", "opus", { cacheWrite1h: 100 })] });
  assert.equal(sub(analysis, "claude").tokens.today.weighted, 200);
});

test("tokens split by model, with folders merged and the models sorted by the week", () => {
  const analysis = run({ rows: SPLIT_ROWS, samples: [sample("claude", utc("2026-11-05T09:00:00Z"), 40)] });
  assert.deepEqual(
    analysis.models.map((m) => [m.provider, m.name]),
    [["claude", "opus"], ["codex", "gpt-5"], ["claude", "sonnet"]],
  );
  const [opus, gpt, sonnet] = analysis.models;
  assert.deepEqual(opus?.tokens.today, totals({ input: 101, cacheWrite5m: 40, cacheWrite1h: 10, cacheRead: 1000, output: 20 }, 371));
  assert.deepEqual(opus?.tokens.week, totals({ input: 108, cacheWrite5m: 40, cacheWrite1h: 10, cacheRead: 1000, output: 20 }, 378));
  assert.deepEqual(opus?.tokens.month, totals({ input: 108, cacheWrite5m: 40, cacheWrite1h: 10, cacheRead: 1000, output: 20 }, 378));
  assert.deepEqual(gpt?.tokens.week, totals({ input: 59, cacheRead: 500, output: 5 }, 134));
  assert.deepEqual(sonnet?.tokens.today, totals({}, 0));
  assert.deepEqual(sonnet?.tokens.week, totals({ input: 5, output: 3 }, 20));
  assert.deepEqual(sonnet?.tokens.month, totals({ output: 3 }, 15));
});

test("the same model name under two subscriptions stays two models", () => {
  const rows = [row(NOW - HOUR_MS, "claude", "shared", { input: 1 }), row(NOW - HOUR_MS, "codex", "shared", { input: 2 })];
  const names = run({ rows }).models.map((m) => `${m.provider}/${m.name}/${m.tokens.today.input}`);
  assert.deepEqual([...names].sort(), ["claude/shared/1", "codex/shared/2"]);
});

test("a subscription with no rows has zero totals and the periods stay filled", () => {
  const analysis = run({});
  assert.deepEqual(analysis.subscriptions.map((s) => s.provider), ["claude", "codex"]);
  assert.deepEqual(sub(analysis, "claude").tokens.month, totals({}, 0));
  assert.deepEqual(analysis.models, []);
});

test("a week reset that is not on a slot edge gives its end slot to the next week", () => {
  const odd = RESET + 7.5 * MINUTE_MS;
  const rows = [
    row(START - SLOT_MS, "claude", "m", { input: 1 }),
    row(START, "claude", "m", { input: 10 }),
    row(utc("2026-11-05T12:00:00Z"), "claude", "m", { input: 100 }),
    row(RESET, "claude", "m", { input: 1000 }),
  ];
  const analysis = run({ rows, samples: [sample("claude", NOW - HOUR_MS, 40, odd)] });
  // The start is 09:07:30, so the slot 09:00 is in this week. The end slot 09:00 is not.
  assert.equal(sub(analysis, "claude").tokens.week.input, 10 + 100);
});

test("the rolling week counts the slot of now and starts a whole week of slots earlier", () => {
  const rows = [
    row(utc("2026-10-29T12:00:00Z"), "claude", "m", { input: 1 }),
    row(utc("2026-10-29T12:15:00Z"), "claude", "m", { input: 10 }),
    row(utc("2026-11-05T12:00:00Z"), "claude", "m", { input: 100 }),
    row(utc("2026-11-05T12:15:00Z"), "claude", "m", { input: 1000 }),
  ];
  const analysis = run({ rows });
  assert.equal(sub(analysis, "claude").week.kind, "rolling");
  assert.equal(sub(analysis, "claude").tokens.week.input, 110);
});

// ---------------------------------------------------------------------------
// Time zones: a slot is never counted twice or lost on the DST days
// ---------------------------------------------------------------------------

function dayInputs(rows: readonly BucketRow[], zone: Zone, nowList: readonly number[]): number[] {
  return nowList.map((nowMs) => sub(run({ rows, zone, nowMs }), "claude").tokens.today.input);
}

test("the spring DST day in Berlin has 92 slots and the three days tile", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  const rows = fill("claude", utc("2026-03-27T00:00:00Z"), utc("2026-04-01T00:00:00Z"), { input: 1 });
  const nows = [utc("2026-03-28T12:00:00Z"), utc("2026-03-29T12:00:00Z"), utc("2026-03-30T12:00:00Z")];
  const inputs = dayInputs(rows, berlin, nows);
  assert.deepEqual(inputs, [96, 92, 96]);
  const first = todayPeriod(berlin, nows[0] ?? 0);
  const middle = todayPeriod(berlin, nows[1] ?? 0);
  const last = todayPeriod(berlin, nows[2] ?? 0);
  assert.equal(first.end, middle.start);
  assert.equal(middle.end, last.start);
  assert.equal(slotRange({ start: first.start, end: last.end }).to - slotRange({ start: first.start, end: last.end }).from, 284);
});

test("the autumn DST day in Berlin has 100 slots and the three days tile", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  const rows = fill("claude", utc("2026-10-23T00:00:00Z"), utc("2026-10-28T00:00:00Z"), { input: 1 });
  const nows = [utc("2026-10-24T12:00:00Z"), utc("2026-10-25T12:00:00Z"), utc("2026-10-26T12:00:00Z")];
  assert.deepEqual(dayInputs(rows, berlin, nows), [96, 100, 96]);
  const middle = todayPeriod(berlin, nows[1] ?? 0);
  assert.equal(todayPeriod(berlin, nows[0] ?? 0).end, middle.start);
  assert.equal(middle.end, todayPeriod(berlin, nows[2] ?? 0).start);
});

test("the month in Berlin counts 2972 slots in March and 2980 in October", () => {
  const berlin = must(zoneNamed("Europe/Berlin"));
  const march = fill("claude", utc("2026-02-20T00:00:00Z"), utc("2026-04-08T00:00:00Z"), { input: 1 });
  assert.equal(sub(run({ rows: march, zone: berlin, nowMs: utc("2026-03-29T12:00:00Z") }), "claude").tokens.month.input, 2972);
  const october = fill("claude", utc("2026-09-20T00:00:00Z"), utc("2026-11-08T00:00:00Z"), { input: 1 });
  assert.equal(sub(run({ rows: october, zone: berlin, nowMs: utc("2026-10-25T12:00:00Z") }), "claude").tokens.month.input, 2980);
});

// ---------------------------------------------------------------------------
// Forecast (TP-2)
// ---------------------------------------------------------------------------

test("the forecast gives the percent at the reset and the run-out time", () => {
  const at = START + 48 * HOUR_MS;
  const forecast = sub(run({ samples: [sample("claude", at, 30)] }), "claude").forecast;
  assert.ok(forecast !== null);
  near(forecast.burnPctPerHour, 0.625);
  near(forecast.atResetPct, 105);
  assert.equal(forecast.runsOutAt, at + 112 * HOUR_MS);
  assert.equal(forecast.basis, "latest sample");
});

test("the forecast says not before reset when the burn stays under the limit", () => {
  const forecast = sub(run({ samples: [sample("claude", START + 48 * HOUR_MS, 20)] }), "claude").forecast;
  assert.ok(forecast !== null);
  near(forecast.atResetPct, 70);
  assert.equal(forecast.runsOutAt, null);
});

test("the Claude forecast uses the later lower sample of the open week", () => {
  const lower = sample("claude", START + 84 * HOUR_MS, 36, RESET - 1000);
  const samples = [
    sample("claude", START - HOUR_MS, 90, START),
    sample("claude", START + 72 * HOUR_MS, 98),
    sample("claude", START + 76 * HOUR_MS, 99),
    sample("claude", START + 80 * HOUR_MS, 100),
    lower,
  ];
  const forecast = sub(run({ samples }), "claude").forecast;
  assert.ok(forecast !== null);
  assert.equal(forecast.at, lower.at);
  near(forecast.burnPctPerHour, 36 / (84 + 1000 / HOUR_MS));
  assert.equal(forecast.runsOutAt, null);
});

test("the Codex forecast ignores a restamped older percent", () => {
  const samples = [
    sample("codex", START - HOUR_MS, 90, START),
    sample("codex", START + 24 * HOUR_MS, 10),
    sample("codex", START + 48 * HOUR_MS, 30),
    sample("codex", START + 60 * HOUR_MS, 20),
  ];
  const forecast = sub(run({ samples }), "codex").forecast;
  assert.ok(forecast !== null);
  near(forecast.burnPctPerHour, 0.625);
});

test("there is no burn in the first 3 percent of the week", () => {
  const edge = 18_144_000; // 3 percent of 7 days
  assert.equal(forecastFrom({ usedPercent: 3, resetsAt: RESET, at: START + edge - 1 }), null);
  const kept = forecastFrom({ usedPercent: 3, resetsAt: RESET, at: START + edge });
  assert.ok(kept !== null);
  near(kept.burnPctPerHour, 3 / 5.04);
  assert.equal(sub(run({ samples: [sample("claude", START + 5 * HOUR_MS, 5)] }), "claude").forecast, null);
  assert.notEqual(sub(run({ samples: [sample("claude", START + 6 * HOUR_MS, 5)] }), "claude").forecast, null);
});

test("a full quota runs out at the sample time and an unused one never runs out", () => {
  const full = forecastFrom({ usedPercent: 100, resetsAt: RESET, at: START + 48 * HOUR_MS });
  assert.equal(full?.runsOutAt, START + 48 * HOUR_MS);
  const idle = forecastFrom({ usedPercent: 0, resetsAt: RESET, at: START + 48 * HOUR_MS });
  assert.equal(idle?.burnPctPerHour, 0);
  assert.equal(idle?.atResetPct, 0);
  assert.equal(idle?.runsOutAt, null);
});

test("a sample of a week that is over gives no forecast", () => {
  const past = sample("claude", START - 2 * 24 * HOUR_MS, 60, START);
  assert.equal(sub(run({ samples: [past] }), "claude").forecast, null);
});

test("the forecast of each subscription uses its own samples", () => {
  const analysis = run({ samples: [sample("codex", START + 48 * HOUR_MS, 30)] });
  assert.equal(sub(analysis, "claude").forecast, null);
  assert.ok(sub(analysis, "codex").forecast !== null);
});

// ---------------------------------------------------------------------------
// Calibration (TP-5)
// ---------------------------------------------------------------------------

// 1000 weighted tokens in every slot: 4000 an hour, so an interval of `hours`
// with `points` of change gives 4000 * hours / points.
const STEADY = (provider: Provider = "claude"): BucketRow[] =>
  fill(provider, START - HOUR_MS, NOW + HOUR_MS, { input: 1000 });

type Step = readonly [hours: number, points: number];

function chain(provider: Provider, firstAt: number, firstPct: number, steps: readonly Step[], jitter = false): QuotaSample[] {
  const out = [sample(provider, firstAt, firstPct)];
  let at = firstAt;
  let pct = firstPct;
  steps.forEach(([hours, points], index) => {
    at += hours * HOUR_MS;
    pct += points;
    out.push(sample(provider, at, pct, jitter && index % 2 === 0 ? RESET + 1000 : RESET));
  });
  return out;
}

function claudeCalibration(over: Partial<AnalysisInput>): SubscriptionUsage["calibration"] {
  return sub(run({ rows: STEADY(), ...over }), "claude").calibration;
}

function readyOf(calibration: SubscriptionUsage["calibration"]): { perPctWeighted: number; confidence: string; intervals: number } {
  assert.ok(calibration.ready, "the calibration is not ready");
  assert.equal(calibration.label, CALIBRATION_LABEL);
  return calibration;
}

test("two intervals give the median and low confidence", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[10, 10], [15, 10]]);
  const calibration = readyOf(claudeCalibration({ samples }));
  near(calibration.perPctWeighted, 5000);
  assert.equal(calibration.confidence, "low");
  assert.equal(calibration.intervals, 2);
});

test("three intervals with a spread of 0.5 or less give medium confidence", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[7.5, 10], [10, 10], [12.5, 10]]);
  const calibration = readyOf(claudeCalibration({ samples }));
  near(calibration.perPctWeighted, 4000);
  assert.equal(calibration.confidence, "medium");
  assert.equal(calibration.intervals, 3);
});

test("three intervals with a wide spread give low confidence", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[2.5, 10], [10, 10], [22.5, 10]]);
  const calibration = readyOf(claudeCalibration({ samples }));
  near(calibration.perPctWeighted, 4000);
  assert.equal(calibration.confidence, "low");
});

test("six intervals with a spread of 0.25 or less give high confidence", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[9, 10], [10, 10], [10, 10], [10, 10], [10, 10], [11, 10]]);
  const calibration = readyOf(claudeCalibration({ samples }));
  near(calibration.perPctWeighted, 4000);
  assert.equal(calibration.confidence, "high");
  assert.equal(calibration.intervals, 6);
});

test("six intervals with a spread above 0.25 give medium confidence", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[5, 10], [7.5, 10], [10, 10], [10, 10], [12.5, 10], [15, 10]]);
  const calibration = readyOf(claudeCalibration({ samples }));
  near(calibration.perPctWeighted, 4000);
  assert.equal(calibration.confidence, "medium");
});

test("six intervals with a spread above 0.5 give low confidence", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[2.5, 10], [5, 10], [10, 10], [10, 10], [15, 10], [22.5, 10]]);
  const calibration = readyOf(claudeCalibration({ samples }));
  near(calibration.perPctWeighted, 4000);
  assert.equal(calibration.confidence, "low");
});

test("an interval needs 1 hour and 5 points, so one interval alone falls back to the rough value", () => {
  const first = START + 6 * HOUR_MS;
  const exact = chain("claude", first, 5, [[1, 5], [1, 5]]);
  const exactCalibration = readyOf(claudeCalibration({ samples: exact }));
  near(exactCalibration.perPctWeighted, 800);
  assert.equal(exactCalibration.confidence, "low");
  assert.equal(exactCalibration.intervals, 2);

  // 59 minutes: the pair does not count, so the chain goes on to the third sample.
  const short = [
    sample("claude", first, 5),
    sample("claude", first + 59 * MINUTE_MS, 10),
    sample("claude", first + 119 * MINUTE_MS, 15),
  ];
  const shortCalibration = readyOf(claudeCalibration({ samples: short }));
  assert.equal(shortCalibration.confidence, "rough");
  assert.equal(shortCalibration.intervals, 1);

  // 4 points: the same.
  const small = [
    sample("claude", first, 5),
    sample("claude", first + HOUR_MS, 9),
    sample("claude", first + 2 * HOUR_MS, 14),
  ];
  const smallCalibration = readyOf(claudeCalibration({ samples: small }));
  assert.equal(smallCalibration.confidence, "rough");
  assert.equal(smallCalibration.intervals, 1);
});

test("Codex intervals ignore a restamped older percent and repeats of a percent", () => {
  const base = chain("codex", START + 6 * HOUR_MS, 5, [[10, 10], [15, 10]]);
  const noise = [
    sample("codex", START + 50 * HOUR_MS, 5),
    sample("codex", START + 60 * HOUR_MS, 15),
    sample("codex", START + 70 * HOUR_MS, 25),
  ];
  const analysis = run({ rows: STEADY("codex"), samples: [...base, ...noise] });
  const calibration = readyOf(sub(analysis, "codex").calibration);
  near(calibration.perPctWeighted, 5000);
  assert.equal(calibration.intervals, 2);
});

test("Claude calibration counts rises on both sides of a drop but not across it", () => {
  const samples = chain("claude", START + 72 * HOUR_MS, 90, [[2, 10], [1, -64], [1, 5]]);
  const tieAt = START + 73 * HOUR_MS;
  const ties = [sample("claude", tieAt, 89), sample("claude", tieAt, 91)];
  const calibration = readyOf(claudeCalibration({ samples: [...ties, ...samples.reverse()] }));
  near(calibration.perPctWeighted, 800);
  assert.equal(calibration.intervals, 2);
  assert.equal(calibration.confidence, "low");
});

test("Claude calibration does not divide the tokens of the whole week by the percent after a drop", () => {
  const samples = chain("claude", START + 72 * HOUR_MS, 98, [[4, 1], [4, 1], [4, -64]]);
  const claude = sub(run({ rows: STEADY(), samples }), "claude");

  assert.equal(claude.calibration.ready, false);
  assert.equal(claude.latest.week?.usedPercent, 36);
  assert.equal(claude.week.end, RESET);
});

test("a reset time that moves by a second stays in the same reset period", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[10, 10], [15, 10]], true);
  const calibration = readyOf(claudeCalibration({ samples }));
  near(calibration.perPctWeighted, 5000);
  assert.equal(calibration.intervals, 2);
});

test("intervals of an earlier reset period do not count", () => {
  const earlier = chain("claude", START - 6 * 24 * HOUR_MS, 5, [[10, 10], [15, 10]]).map((s) => ({ ...s, resetsAt: START }));
  const samples = [...earlier, sample("claude", START + 24 * HOUR_MS, 8)];
  const calibration = readyOf(claudeCalibration({ samples }));
  assert.equal(calibration.confidence, "rough");
});

test("an interval with no tokens is dropped", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[10, 10], [15, 10]]);
  const calibration = sub(run({ samples }), "claude").calibration;
  assert.equal(calibration.ready, false);
});

test("one sample at 5 percent or more gives a rough value", () => {
  const calibration = readyOf(claudeCalibration({ samples: [sample("claude", START + 24 * HOUR_MS, 8)] }));
  // 96 slots of 1000 from the week start, divided by 8 points.
  near(calibration.perPctWeighted, 12_000);
  assert.equal(calibration.confidence, "rough");
  assert.equal(calibration.intervals, 0);
});

test("a rough value needs 5 percent", () => {
  const at = START + 24 * HOUR_MS;
  assert.equal(claudeCalibration({ samples: [sample("claude", at, 4.9)] }).ready, false);
  assert.equal(claudeCalibration({ samples: [sample("claude", at, 5)] }).ready, true);
});

test("a rough value needs a finished scan", () => {
  const samples = [sample("claude", START + 24 * HOUR_MS, 8)];
  for (const collectState of ["counting", "never", "stopped"] as const) {
    const calibration = claudeCalibration({ samples, collectState });
    assert.equal(calibration.ready, false, collectState);
    assert.equal(calibration.label, NOT_READY_LABEL);
  }
});

test("a rough value needs a sample of the current week", () => {
  const old = sample("claude", START - 2 * 24 * HOUR_MS, 60, START);
  assert.equal(claudeCalibration({ samples: [old] }).ready, false);
});

test("a rough value with no tokens is not ready", () => {
  assert.equal(sub(run({ samples: [sample("claude", START + 24 * HOUR_MS, 8)] }), "claude").calibration.ready, false);
});

test("the intervals replace the rough value from two intervals on", () => {
  const samples = chain("claude", START + 6 * HOUR_MS, 5, [[10, 10], [15, 10]]);
  const calibration = readyOf(claudeCalibration({ samples }));
  assert.notEqual(calibration.confidence, "rough");
});

test("Codex calibrates from its own samples and rows", () => {
  const samples = chain("codex", START + 6 * HOUR_MS, 5, [[10, 10], [15, 10]]);
  const analysis = run({ rows: STEADY("codex"), samples });
  near(readyOf(sub(analysis, "codex").calibration).perPctWeighted, 5000);
  assert.equal(sub(analysis, "claude").calibration.ready, false);
});

// ---------------------------------------------------------------------------
// Bucket keys and the data folder
// ---------------------------------------------------------------------------

test("parseBucketKey reads back what bucketKey wrote and refuses anything else", () => {
  const key = bucketKey(123456, "codex", "gpt-5.1", "work-example-proj");
  assert.deepEqual(parseBucketKey(key), { slot: 123456, provider: "codex", model: "gpt-5.1", folderKey: "work-example-proj" });
  for (const bad of ["", "1|claude|m", "x|claude|m|f", "1|other|m|f", "1|claude|bad model|f", "1|claude|m|f|g", "1|claude|m|f/g"]) {
    assert.equal(parseBucketKey(bad), null, bad);
  }
});

function bucketsBody(entries: ReadonlyArray<readonly [number, Provider, string, readonly number[]]>): string {
  const rows: Record<string, readonly number[]> = {};
  for (const [ms, provider, model, columns] of entries) rows[bucketKey(slotOf(ms), provider, model, "proj")] = columns;
  return JSON.stringify({ version: 1, rows });
}

function writeData(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, name), text, { mode: 0o600 });
}

// readAnalysis takes the bucket rows as input, so the rows are loaded first.
function analysisOf(dataDir: string, nowMs: number, zone: Zone): Analysis {
  return readAnalysis(dataDir, nowMs, zone, "ok", must(loadBucketRows(dataDir, nowMs)));
}

test("readAnalysis reads the local month across two UTC month files, and the quota samples", (t) => {
  const sb = makeSandbox(t);
  const now = utc("2026-10-05T12:00:00Z");
  const berlin = must(zoneNamed("Europe/Berlin"));
  writeData(sb.dataDir, "buckets-2026-09.json", bucketsBody([
    [utc("2026-09-30T21:45:00Z"), "claude", "opus", [1, 0, 0, 0, 0]],
    [utc("2026-09-30T22:00:00Z"), "claude", "opus", [10, 0, 0, 0, 0]],
  ]));
  writeData(sb.dataDir, "buckets-2026-10.json", bucketsBody([
    [utc("2026-10-05T09:00:00Z"), "claude", "opus", [100, 0, 0, 0, 0]],
  ]));
  const sampleAt = utc("2026-10-05T09:00:00Z");
  const reset = utc("2026-10-09T09:00:00Z");
  writeData(sb.dataDir, "quota-2026-10.jsonl", `${sampleLine(sample("claude", sampleAt, 30, reset))}\n`);

  const analysis = analysisOf(sb.dataDir, now, berlin);
  const claude = sub(analysis, "claude");
  // 00:00 local on 1 October is 22:00 UTC on 30 September: that row is in the month.
  assert.equal(claude.tokens.month.input, 110);
  assert.equal(claude.tokens.today.input, 100);
  assert.deepEqual(claude.week, { start: reset - WEEK_MS, end: reset, kind: "reset" });
  assert.equal(claude.tokens.week.input, 100);
  assert.ok(claude.forecast !== null);
  assert.equal(analysis.today.start, utc("2026-10-04T22:00:00Z"));
});

test("readAnalysis on an empty data folder gives zeros, a rolling week and no calibration", (t) => {
  const sb = makeSandbox(t);
  const analysis = analysisOf(sb.dataDir, NOW, UTC);
  for (const s of analysis.subscriptions) {
    assert.equal(s.week.kind, "rolling");
    assert.equal(s.forecast, null);
    assert.equal(s.calibration.ready, false);
    assert.equal(s.tokens.week.weighted, 0);
  }
});

test("loadBucketRows returns the store error of a damaged bucket file", (t) => {
  const sb = makeSandbox(t);
  writeData(sb.dataDir, "buckets-2026-11.json", "{not json");
  const result = loadBucketRows(sb.dataDir, NOW);
  assert.equal(result.ok, false);
  assert.equal(result.ok ? null : result.error.code, "store_corrupt");
});

// ---------------------------------------------------------------------------
// The latest sample of each window
// ---------------------------------------------------------------------------

test("each subscription lists the latest sample of its open windows, an ended window gives null", () => {
  const fiveReset = NOW + 2 * HOUR_MS;
  const samples = [
    sample("codex", NOW - 3 * HOUR_MS, 10, NOW - HOUR_MS, "five_hour"),
    sample("codex", NOW - 2 * HOUR_MS, 40, RESET, "week"),
    sample("claude", NOW - HOUR_MS, 7, fiveReset, "five_hour"),
  ];
  const analysis = run({ samples });
  assert.equal(sub(analysis, "codex").latest.five_hour, null, "the 5 hour window has ended");
  assert.deepEqual(sub(analysis, "codex").latest.week, samples[1]);
  assert.deepEqual(sub(analysis, "claude").latest.five_hour, samples[2]);
  assert.equal(sub(analysis, "claude").latest.week, null);
});

test("the latest sample of a window is the highest percent of the newest reset period", () => {
  const samples = [
    sample("codex", NOW - 4 * HOUR_MS, 30, RESET),
    sample("codex", NOW - 3 * HOUR_MS, 41, RESET),
    // A restamped copy: a later time with an older percent.
    sample("codex", NOW - HOUR_MS, 35, RESET),
  ];
  assert.deepEqual(sub(run({ samples }), "codex").latest.week, samples[1]);
});

// ---------------------------------------------------------------------------
// The time a sample was last seen
// ---------------------------------------------------------------------------

test("an observation of the same numbers gives the latest sample and the forecast its later time", () => {
  const change = sample("codex", NOW - 3 * HOUR_MS, 40);
  const seen = sample("codex", NOW - 20 * MINUTE_MS, 40);
  const codex = sub(run({ samples: [change], observations: [seen] }), "codex");
  assert.deepEqual(codex.latest.week, seen);
  assert.deepEqual(codex.forecast, forecastFrom({ usedPercent: 40, resetsAt: RESET, at: seen.at }));
  assert.notDeepEqual(codex.forecast, forecastFrom({ usedPercent: 40, resetsAt: RESET, at: change.at }));
});

test("an observation of other numbers, another provider or an earlier time changes nothing", () => {
  const change = sample("codex", NOW - 3 * HOUR_MS, 40);
  const without = sub(run({ samples: [change] }), "codex");
  const others = [
    sample("codex", NOW - 20 * MINUTE_MS, 41),
    sample("codex", NOW - 20 * MINUTE_MS, 40, RESET + HOUR_MS),
    sample("claude", NOW - 20 * MINUTE_MS, 40),
    sample("codex", NOW - 20 * MINUTE_MS, 40, RESET, "five_hour"),
    sample("codex", NOW - 4 * HOUR_MS, 40),
  ];
  const withOthers = sub(run({ samples: [change], observations: others }), "codex");
  assert.deepEqual(withOthers.latest, without.latest);
  assert.deepEqual(withOthers.forecast, without.forecast);
});

test("the rough calibration keeps the time of the change, not the time the numbers were last seen", () => {
  const change = sample("codex", START + 24 * HOUR_MS, 8);
  const seen = sample("codex", START + 48 * HOUR_MS, 8);
  const rows = STEADY("codex");
  const calibration = sub(run({ rows, samples: [change], observations: [seen] }), "codex").calibration;
  // 96 slots of 1000 from the week start to the change, divided by 8 points.
  near(readyOf(calibration).perPctWeighted, 12_000);
});

test("readAnalysis: two Codex passes with the same percent give the latest sample and the forecast the later time", (t) => {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { recursive: true, mode: 0o700 });
  const change = sample("codex", NOW - 3 * HOUR_MS, 40);
  const seen = sample("codex", NOW - 20 * MINUTE_MS, 40);
  must(storeCodexQuota(sb.dataDir, [change]));
  const monthPath = join(sb.dataDir, quotaMonthFile(change.at));
  const stored = readFileSync(monthPath, "utf8");
  must(storeCodexQuota(sb.dataDir, [seen]));
  assert.equal(readFileSync(monthPath, "utf8"), stored, "the month file did not grow");

  const codex = sub(analysisOf(sb.dataDir, NOW, UTC), "codex");
  assert.equal(codex.latest.week?.at, seen.at);
  assert.deepEqual(codex.forecast, forecastFrom({ usedPercent: 40, resetsAt: RESET, at: seen.at }));
  assert.notDeepEqual(codex.forecast, forecastFrom({ usedPercent: 40, resetsAt: RESET, at: change.at }));
});

// The Claude week percent is written by record: a sample line when the percent
// changes, and the time of the last reading in the latest file.
const CLAUDE_QUOTA: StatuslineQuota = {
  five_hour: { reason: "absent" },
  week: { usedPercent: 40, resetsAt: RESET },
};

test("the forecast says the time of the reading that it used", () => {
  const at = START + 48 * HOUR_MS;
  assert.equal(forecastFrom({ usedPercent: 40, resetsAt: RESET, at })?.at, at);
});

test("readAnalysis: the Claude week seen again gives the latest sample and the forecast the time of the last reading", (t) => {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { recursive: true, mode: 0o700 });
  const changeAt = NOW - 3 * HOUR_MS;
  const seenAt = NOW - 20 * MINUTE_MS;
  must(recordStatuslineQuota(sb.dataDir, CLAUDE_QUOTA, changeAt));
  const monthPath = join(sb.dataDir, quotaMonthFile(changeAt));
  const stored = readFileSync(monthPath, "utf8");
  must(recordStatuslineQuota(sb.dataDir, CLAUDE_QUOTA, seenAt));
  assert.equal(readFileSync(monthPath, "utf8"), stored, "the month file did not grow");

  const claude = sub(analysisOf(sb.dataDir, NOW, UTC), "claude");
  assert.equal(claude.latest.week?.at, seenAt);
  assert.equal(claude.forecast?.at, seenAt);
  assert.deepEqual(claude.forecast, forecastFrom({ usedPercent: 40, resetsAt: RESET, at: seenAt }));
  assert.notDeepEqual(claude.forecast, forecastFrom({ usedPercent: 40, resetsAt: RESET, at: changeAt }));
});

test("readAnalysis: an older store with no Claude window in the latest file uses the time of the change", (t) => {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { recursive: true, mode: 0o700 });
  const changeAt = NOW - 3 * HOUR_MS;
  must(recordStatuslineQuota(sb.dataDir, CLAUDE_QUOTA, changeAt));
  writeFileSync(
    join(sb.dataDir, QUOTA_LATEST_FILE),
    JSON.stringify({ version: 1, claude: { five_hour: null, week: null } }),
    { mode: 0o600 },
  );

  const claude = sub(analysisOf(sb.dataDir, NOW, UTC), "claude");
  assert.equal(claude.latest.week?.at, changeAt);
  assert.equal(claude.forecast?.at, changeAt);
});
