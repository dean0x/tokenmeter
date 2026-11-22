// Tests for the shares of a task in the status JSON (T2, T3): the tokens inside
// today, the week and the month, the part of the subscription's week, and the
// pool. The function under test is pure: it takes the status data and the pool
// setting and returns new data.

import { test } from "node:test";
import assert from "node:assert/strict";
import { CALIBRATION_LABEL, RESET_TOLERANCE_MS, analyze, totalsOf } from "../src/analysis.ts";
import {
  type EstimateLogLine,
  MAX_STAGES,
  SELF_CHECK_MIN_SCORED,
  SELF_CHECK_TASKS,
  type SignalEstimate,
  estimateFromSignals,
  hitRateBand,
} from "../src/estimator.ts";
import { ACCOUNT_MAX_AGE_MS, type AccountUsage } from "../src/account-usage.ts";
import { DayRows, shiftDate } from "../src/days.ts";
import { type Zone, WEEK_MS, localZone, zoneNamed } from "../src/periods.ts";
import { periodsOf } from "../src/rollup.ts";
import type { PoolConfig } from "../src/pool.ts";
import {
  type BuildInput,
  type EstimateJson,
  type QueueJson,
  type SelfCheckJson,
  type ShareJson,
  type StageCheckJson,
  type StatusData,
  type SubscriptionJson,
  type TaskJson,
  type TokenColumnsJson,
  buildStatus,
  estimateJson,
  overlayCodexAccount,
  refreshShares,
} from "../src/status.ts";
import type { Provider } from "../src/store.ts";
import type { TaskEntry } from "../src/tasks.ts";
import { installSuiteGuard } from "./helpers.ts";

installSuiteGuard();

const HOUR = 3_600_000;
const START = Date.parse("2026-11-01T00:00:00Z");
const WEEK_END = START + 7 * 24 * HOUR;
// The time of the read: inside the week, after the first reading.
const NOW = START + 2 * HOUR;
const SEPARATE: PoolConfig = { mode: "separate", reason: null };
const COMBINED: PoolConfig = { mode: "combined", weights: { claude: 0.5, codex: 1 } };

function columns(weighted: number): TokenColumnsJson {
  return { input: weighted, cache_write: 0, cache_write_1h: 0, cache_read: 0, output: 0, weighted };
}

// A subscription with `weekWeighted` tokens in its week and a seven day percent (null: unknown).
// The percent resets at `resetsAt`: by default at the end of the week of the tokens.
function subscription(id: Provider, weekWeighted: number, sevenDayPct: number | null, resetsAt: number = WEEK_END): SubscriptionJson {
  return {
    id,
    label: id,
    endpoint: null,
    root: "ok",
    quota: {
      five_hour: null,
      seven_day: sevenDayPct === null ? null : { pct: sevenDayPct, resets_at: resetsAt, at: START + HOUR },
      source: sevenDayPct === null ? "none" : "record",
      unknown: { five_hour: "missing", seven_day: sevenDayPct === null ? "missing" : null },
    },
    week: { start: START, end: WEEK_END, kind: "reset" },
    tokens: { today: columns(weekWeighted), week: columns(weekWeighted), month: columns(weekWeighted) },
    forecast: null,
    calibration: null,
  };
}

// A share that the collect pass wrote: the week percent is not worked out yet.
function share(subscriptionId: Provider, weekWeighted: number, over: Partial<ShareJson> = {}): ShareJson {
  return {
    subscription: subscriptionId,
    weighted: weekWeighted,
    raw: weekWeighted * 3,
    pct: null,
    today_weighted: weekWeighted / 2,
    week_weighted: weekWeighted,
    month_weighted: weekWeighted * 2,
    week_pct: null,
    ...over,
  };
}

function task(label: string, shares: readonly ShareJson[]): TaskJson {
  return { label, tags: {}, open: true, start: START, end: null, shared: false, shares, pool_pct: null };
}

function data(subscriptions: readonly SubscriptionJson[], tasks: readonly TaskJson[]): StatusData {
  return {
    version: 1,
    written_at: START + HOUR,
    collect: { at: START + HOUR, state: "ok", progress_pct: 100 },
    subscriptions,
    models: [],
    tasks,
    estimates: [],
    self_check: null,
    pool: { mode: "separate" },
    queue: null,
  };
}

function near(actual: number | null, expected: number, eps = 1e-9): void {
  assert.ok(actual !== null && Math.abs(actual - expected) <= eps, `${actual} is not near ${expected}`);
}

function firstShare(result: StatusData, index = 0): ShareJson {
  const found = result.tasks[index]?.shares[0];
  assert.ok(found !== undefined, "the share is missing");
  return found;
}

const UTC: Zone = { offsetMs: () => 0 };
const CODEX: SubscriptionJson = { ...subscription("codex", 200, 25), label: "Codex" };
const RAW = { input: 7, cache_write: 2, cache_write_1h: 3, cache_read: 5, output: 11, weighted: 200 };
const FRESH: AccountUsage = { at: NOW, rows: [["2026-11-01", 800], ["2026-11-08", 200]] };

function overlay(input: StatusData, account: AccountUsage | null, zone = UTC, nowMs = NOW) {
  return overlayCodexAccount(input, account, zone, nowMs);
}

test("the Codex account supplies week and month totals, but not today", () => {
  const codex = { ...CODEX, tokens: { today: RAW, week: RAW, month: RAW } };
  const [result] = overlay(data([codex], []), FRESH).subscriptions;
  assert.deepEqual(result, {
    ...codex, label: "Codex (account)", account: { at: NOW, through: "2026-11-08" },
    tokens: {
      today: { ...RAW, total: 28, source: "logs" },
      week: { ...RAW, total: 800, source: "account" },
      month: { ...RAW, total: 1000, source: "account" },
    },
  });
  const rows = new DayRows(true);
  rows.add("2026-11-01", "codex", "test-model", [7, 0, 0, 5, 11], 1);
  const { months } = periodsOf({
    rows, zone: UTC, nowMs: NOW, weekStart: "sun", collect: { at: NOW, complete: true }, account: FRESH, maxBytes: 4096,
  });
  assert.equal(months[0]?.subs.codex.account, result?.tokens.month.total);
});

test("Claude always shows the log totals, and Codex uses the same keys without an account", () => {
  const claude = { ...subscription("claude", 200, 30), label: "Claude" };
  const input = data([claude, CODEX], []);
  const logPeriod = { ...columns(200), total: 200, source: "logs" };
  const logTokens = { today: logPeriod, week: logPeriod, month: logPeriod };
  assert.deepEqual(overlay(input, FRESH).subscriptions[0], { ...claude, account: null, tokens: logTokens });
  assert.deepEqual(overlay(input, null).subscriptions, [claude, CODEX].map((sub) => ({
    ...sub, account: null, tokens: logTokens,
  })));
});

test("a fresh empty Codex account uses the same log totals and label as an absent account", () => {
  const codex = { ...CODEX, tokens: { today: RAW, week: RAW, month: RAW } };
  const input = data([codex], []);
  const [absent] = overlay(input, null).subscriptions;
  const [empty] = overlay(input, { at: NOW, rows: [] }).subscriptions;
  const logPeriod = { ...RAW, total: 28, source: "logs" };

  assert.deepEqual(empty, absent);
  assert.deepEqual(empty, {
    ...codex, account: null, tokens: { today: logPeriod, week: logPeriod, month: logPeriod },
  });
});

test("the Codex account leaves the share percent, calibration and forecast unchanged", () => {
  const codex = {
    ...CODEX,
    calibration: { per_pct_weighted: 30, confidence: "low", intervals: 3, label: CALIBRATION_LABEL } as const,
    forecast: { burn_pct_per_h: 1, at_reset_pct: 50, runs_out_at: null, at: NOW, basis: "latest sample" } as const,
  };
  const input = refreshShares(data([codex], [task("open", [share("codex", 100)])]), SEPARATE, NOW);
  const before = structuredClone(input);
  const result = overlay(input, FRESH);
  assert.equal(result.subscriptions[0]?.tokens.week.source, "account");
  assert.equal(firstShare(result).week_pct, 12.5);
  assert.deepEqual(result.tasks, input.tasks);
  assert.deepEqual(result.subscriptions[0]?.calibration, codex.calibration);
  assert.deepEqual(result.subscriptions[0]?.forecast, codex.forecast);
  assert.deepEqual(input, before);
});

test("an account contributes at 24 hours less 1 ms but not at 24 hours", () => {
  const input = data([CODEX], []);
  const ageLimit = NOW - ACCOUNT_MAX_AGE_MS;
  const sources = [ageLimit + 1, ageLimit].map((at) =>
    overlay(input, { ...FRESH, at }).subscriptions[0]?.tokens.week.source,
  );
  assert.deepEqual(sources, ["account", "logs"]);
});

test("missing, non-number and non-finite columns do not enter the log total", () => {
  const tokens = { today: { input: 7, cache_read: "11", output: Infinity, weighted: 200 }, week: columns(200) };
  const malformed = { ...CODEX, tokens } as unknown as SubscriptionJson;
  const periods = overlay(data([malformed], []), null).subscriptions[0]?.tokens;
  assert.deepEqual([periods?.today.total, periods?.week.total, periods?.month.total], [7, 200, 0]);
});

for (const [name, edge] of [
  ["Europe/Berlin", "2026-10-31T23:00:00Z"],
  ["America/New_York", "2026-11-01T04:00:00Z"],
  ["Pacific/Auckland", "2026-10-31T11:00:00Z"],
] as const) {
  test(`the Codex month uses the local month at the boundary in ${name}`, () => {
    const zone = zoneNamed(name);
    assert.ok(zone.ok);
    const at = Date.parse(edge);
    const account: AccountUsage = { at, rows: [["2026-10-31", 17], ["2026-11-01", 19]] };
    const input = data([CODEX], []);
    const months = [at - 1, at].map((nowMs) => overlay(input, account, zone.value, nowMs).subscriptions[0]?.tokens.month.total);
    assert.deepEqual(months, [17, 19]);
  });
}

const WEEK_ROWS = Array.from({ length: 15 }, (_, index) => [shiftDate("2026-11-01", index), 2 ** index] as const);

for (const [time, minutes, firstTotal, nextTotal] of [
  ["00:00Z", 0, 127, 16256], ["11:59Z", 719, 127, 16256],
  ["12:00Z", 720, 127, 16256], ["23:59Z", 1439, 254, 32512],
] as const) {
  test(`a reset at ${time} assigns seven distinct bucket midpoints to each adjacent week`, () => {
    const start = START + minutes * 60_000;
    const week = { start, end: start + WEEK_MS, kind: "reset" } as const;
    const input = data([{ ...CODEX, week }], []);
    const [first, next] = [start, week.end].map((nowMs) =>
      overlay(input, { at: nowMs, rows: WEEK_ROWS }, UTC, nowMs).subscriptions[0],
    );
    assert.deepEqual([first?.tokens.week.total, next?.tokens.week.total], [firstTotal, nextTotal]);
    assert.deepEqual(next?.week, week);
  });
}

test("an old reset week rolls over multiple weeks, but a rolling week takes the newest slots", () => {
  const oldWeek = { start: START - WEEK_MS, end: START };
  const nowMs = START + WEEK_MS + 12 * HOUR;
  const totals = (["reset", "rolling"] as const).map((kind) => {
    const input = data([{ ...CODEX, week: { ...oldWeek, kind } }], []);
    return overlay(input, { at: nowMs, rows: WEEK_ROWS }, UTC, nowMs).subscriptions[0]?.tokens.week.total;
  });
  assert.deepEqual(totals, [16256, 254]);
});

test("a month with partial account coverage uses account data and a week outside coverage uses logs", () => {
  const nowMs = Date.parse("2026-11-25T00:00:00Z");
  const account: AccountUsage = { at: nowMs, rows: [["2026-11-04", 10], ["2026-11-16", 20]] };
  const input = data([CODEX], []);
  const [gap, outside] = [Date.parse("2026-11-09T00:00:00Z"), nowMs].map((at) =>
    overlay(input, { ...account, at }, UTC, at).subscriptions[0],
  );
  assert.deepEqual([gap?.tokens.week.total, gap?.tokens.week.source], [0, "account"]);
  assert.deepEqual([outside?.tokens.week.total, outside?.tokens.week.source], [200, "logs"]);
  assert.deepEqual([outside?.tokens.month.total, outside?.tokens.month.source, outside?.label], [30, "account", "Codex (account)"]);
});

test("week_pct is the part of the subscription's week tokens, times the seven day percent", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, 20)], [
    task("A", [share("claude", 250), share("codex", 100)]),
  ]);
  const result = refreshShares(input, SEPARATE, NOW);
  near(result.tasks[0]?.shares[0]?.week_pct ?? null, 10);
  near(result.tasks[0]?.shares[1]?.week_pct ?? null, 4);
});

test("week_pct is unknown when the seven day percent is unknown or the week has no tokens", () => {
  const input = data([subscription("claude", 1000, null), subscription("codex", 0, 20)], [
    task("A", [share("claude", 250), share("codex", 0)]),
  ]);
  const shares = refreshShares(input, SEPARATE, NOW).tasks[0]?.shares ?? [];
  assert.deepEqual(shares.map((s) => s.week_pct), [null, null]);
});

test("week_pct is 0 for a task with no tokens in the week, when both numbers are known", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 0, null)], [
    task("A", [share("claude", 250, { week_weighted: 0 })]),
  ]);
  assert.equal(firstShare(refreshShares(input, SEPARATE, NOW)).week_pct, 0);
});

test("week_pct is never more than the seven day percent, whatever the tokens of the task", () => {
  const pct = 37.5;
  for (const weekWeighted of [0, 1, 500, 999.9999, 1000, 1000.4, 1001, 5000, 1e9]) {
    const input = data([subscription("claude", 1000, pct), subscription("codex", 0, null)], [
      task("A", [share("claude", 1000, { week_weighted: weekWeighted })]),
    ]);
    const weekPct = firstShare(refreshShares(input, SEPARATE, NOW)).week_pct;
    assert.ok(weekPct !== null && weekPct <= pct, `${weekWeighted} gives ${weekPct}`);
  }
  // A task that rounds up to more than the week total takes the whole percent, not more.
  const over = data([subscription("claude", 1000, pct), subscription("codex", 0, null)], [
    task("A", [share("claude", 1000, { week_weighted: 1000.4 })]),
  ]);
  assert.equal(firstShare(refreshShares(over, SEPARATE, NOW)).week_pct, pct);
});

test("the task shares of one week add up to no more than the seven day percent", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 0, null)], [
    task("A", [share("claude", 600)]),
    task("B", [share("claude", 300)]),
    task("C", [share("claude", 100)]),
  ]);
  const result = refreshShares(input, SEPARATE, NOW);
  const sum = result.tasks.reduce((acc, t) => acc + (t.shares[0]?.week_pct ?? 0), 0);
  near(sum, 40);
});

test("a snapshot from an older build has no raw or period tokens: they read as 0 and the week percent as unknown", () => {
  const old = share("claude", 250) as unknown as Record<string, unknown>;
  delete old["raw"];
  delete old["today_weighted"];
  delete old["week_weighted"];
  delete old["month_weighted"];
  delete old["week_pct"];
  const oldTask = { ...task("A", []), shares: [old] } as unknown as TaskJson;
  delete (oldTask as unknown as Record<string, unknown>)["pool_pct"];
  const input = data([subscription("claude", 1000, 40), subscription("codex", 0, null)], [oldTask]);
  const result = refreshShares(input, SEPARATE, NOW);
  assert.deepEqual(firstShare(result), {
    subscription: "claude",
    weighted: 250,
    raw: 0,
    pct: null,
    today_weighted: 0,
    week_weighted: 0,
    month_weighted: 0,
    week_pct: null,
  });
  assert.equal(result.tasks[0]?.pool_pct, null);
});

test("refreshShares keeps the raw tokens of a share as the collect pass wrote them", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, 20)], [
    task("A", [share("claude", 250, { raw: 1234 }), share("codex", 100, { raw: 56 })]),
  ]);
  const raws = refreshShares(input, SEPARATE, NOW).tasks[0]?.shares.map((s) => s.raw);
  assert.deepEqual(raws, [1234, 56]);
});

test("separate mode: pool is only the mode, and every pool_pct is null", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, 20)], [
    task("A", [share("claude", 250)]),
  ]);
  const result = refreshShares(input, SEPARATE, NOW);
  assert.deepEqual(result.pool, { mode: "separate" });
  assert.equal(result.tasks[0]?.pool_pct, null);
});

test("combined mode: pool has the weights and the weighted sum of the seven day percents", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, 20)], []);
  assert.deepEqual(refreshShares(input, COMBINED, NOW).pool, {
    mode: "combined",
    weights: { claude: 0.5, codex: 1 },
    used_pct: 0.5 * 40 + 1 * 20,
  });
});

test("combined mode: used_pct is null when a seven day percent is unknown", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, null)], []);
  assert.deepEqual(refreshShares(input, COMBINED, NOW).pool, {
    mode: "combined",
    weights: { claude: 0.5, codex: 1 },
    used_pct: null,
  });
});

test("combined mode: pool_pct is the weighted sum of the week percents of the shares of the task", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, 20)], [
    task("both", [share("claude", 250), share("codex", 100)]),
    task("claude only", [share("claude", 500)]),
    task("none", []),
  ]);
  const result = refreshShares(input, COMBINED, NOW);
  // Claude share 10% x 0.5, Codex share 4% x 1.
  near(result.tasks[0]?.pool_pct ?? null, 0.5 * 10 + 1 * 4);
  near(result.tasks[1]?.pool_pct ?? null, 0.5 * 20);
  assert.equal(result.tasks[2]?.pool_pct, 0);
});

test("combined mode: pool_pct is null when a week percent of the task is unknown", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, null)], [
    task("both", [share("claude", 250), share("codex", 100)]),
    task("claude only", [share("claude", 250)]),
  ]);
  const result = refreshShares(input, COMBINED, NOW);
  assert.equal(result.tasks[0]?.pool_pct, null);
  near(result.tasks[1]?.pool_pct ?? null, 0.5 * 10);
});

test("refreshShares changes nothing in its input and keeps the field order", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, 20)], [
    task("A", [share("claude", 250)]),
  ]);
  const before = JSON.stringify(input);
  const result = refreshShares(input, COMBINED, NOW);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(Object.keys(firstShare(result)), [
    "subscription",
    "weighted",
    "raw",
    "pct",
    "today_weighted",
    "week_weighted",
    "month_weighted",
    "week_pct",
  ]);
  assert.deepEqual(Object.keys(result.tasks[0] ?? {}), [
    "label",
    "tags",
    "open",
    "start",
    "end",
    "shared",
    "shares",
    "pool_pct",
  ]);
});

// --- the reading and the tokens must belong to the same reset period ---

test("week_pct is unknown when the seven day reading is of another reset period than the tokens of the week", () => {
  // The reading is of the next week: its percent is of other tokens than the ones in `tokens.week`.
  const input = data([subscription("claude", 1000, 5, WEEK_END + 7 * 24 * HOUR), subscription("codex", 500, 20)], [
    task("A", [share("claude", 250), share("codex", 100)]),
  ]);
  const result = refreshShares(input, COMBINED, NOW);
  assert.equal(firstShare(result).week_pct, null);
  near(result.tasks[0]?.shares[1]?.week_pct ?? null, 4);
  assert.equal(result.tasks[0]?.pool_pct, null);
  // The percent of the reading itself is still known, so the pool keeps it.
  assert.deepEqual(result.pool, { mode: "combined", weights: { claude: 0.5, codex: 1 }, used_pct: 0.5 * 5 + 1 * 20 });
});

test("week_pct is known when the reset time of the reading is within the tolerance of the end of the week", () => {
  for (const offset of [-RESET_TOLERANCE_MS, -1, 0, 1, RESET_TOLERANCE_MS]) {
    const input = data([subscription("claude", 1000, 40, WEEK_END + offset), subscription("codex", 0, null)], [
      task("A", [share("claude", 250)]),
    ]);
    near(firstShare(refreshShares(input, SEPARATE, NOW)).week_pct, 10);
  }
  for (const offset of [-RESET_TOLERANCE_MS - 1, RESET_TOLERANCE_MS + 1]) {
    const input = data([subscription("claude", 1000, 40, WEEK_END + offset), subscription("codex", 0, null)], [
      task("A", [share("claude", 250)]),
    ]);
    assert.equal(firstShare(refreshShares(input, SEPARATE, NOW)).week_pct, null, String(offset));
  }
});

// --- a seven day percent of a week that has ended is not a current percent ---

test("a seven day percent whose reset time has passed gives no week_pct and no pool used_pct", () => {
  const input = data([subscription("claude", 1000, 40), subscription("codex", 500, 20)], [
    task("A", [share("claude", 250), share("codex", 100)]),
  ]);
  const before = refreshShares(input, COMBINED, WEEK_END - 1);
  near(before.tasks[0]?.shares[1]?.week_pct ?? null, 4);
  assert.deepEqual(before.pool, { mode: "combined", weights: { claude: 0.5, codex: 1 }, used_pct: 0.5 * 40 + 1 * 20 });

  for (const now of [WEEK_END, WEEK_END + HOUR]) {
    const after = refreshShares(input, COMBINED, now);
    assert.deepEqual(after.tasks[0]?.shares.map((s) => s.week_pct), [null, null]);
    assert.equal(after.tasks[0]?.pool_pct, null);
    assert.deepEqual(after.pool, { mode: "combined", weights: { claude: 0.5, codex: 1 }, used_pct: null });
  }
});

test("only the subscription whose week has ended loses its week percents", () => {
  const codexEnd = WEEK_END - 24 * HOUR;
  const codex: SubscriptionJson = {
    ...subscription("codex", 500, 20, codexEnd),
    week: { start: codexEnd - 7 * 24 * HOUR, end: codexEnd, kind: "reset" },
  };
  const input = data([subscription("claude", 1000, 40), codex], [
    task("A", [share("claude", 250), share("codex", 100)]),
  ]);
  const result = refreshShares(input, SEPARATE, codexEnd + HOUR);
  near(result.tasks[0]?.shares[0]?.week_pct ?? null, 10);
  assert.equal(result.tasks[0]?.shares[1]?.week_pct, null);
});

// --- the estimates: the basis name and project ---

const RANGED: SignalEstimate = {
  key: "A",
  subscription: "claude",
  basis: "similar",
  basisName: "issue_bytes",
  label: "similar",
  lowPct: 1.5,
  highPct: 4,
  rawLow: 15,
  rawHigh: 40,
  weightedLow: 150_000,
  weightedHigh: 400_000,
  count: 9,
  open: false,
  rough: false,
  typicalPct: 2,
  budgetPct: 3,
};

test("TP-18: an estimate carries the basis name next to the basis word", () => {
  const json = estimateJson(RANGED);
  assert.deepEqual(json, {
    key: "A",
    subscription: "claude",
    basis: "similar",
    basis_name: "issue_bytes",
    low_pct: 1.5,
    high_pct: 4,
    raw_low: 15,
    raw_high: 40,
    count: 9,
    typical_pct: 2,
    budget_pct: 3,
    basis_project: null,
  });
  assert.deepEqual(Object.keys(json), [
    "key",
    "subscription",
    "basis",
    "basis_name",
    "low_pct",
    "high_pct",
    "raw_low",
    "raw_high",
    "count",
    "typical_pct",
    "budget_pct",
    "basis_project",
  ]);
});

test("TP-14: an open range shows its low end and no high end, and reads rough with its basis name", () => {
  const open = {
    ...RANGED,
    label: "wide, low confidence",
    highPct: RANGED.lowPct,
    rawHigh: RANGED.rawLow,
    weightedHigh: RANGED.weightedLow,
    open: true,
    rough: true,
    typicalPct: null,
    budgetPct: null,
  } as const;
  assert.deepEqual(estimateJson(open), {
    key: "A",
    subscription: "claude",
    basis: "wide",
    basis_name: "issue_bytes",
    low_pct: 1.5,
    high_pct: null,
    raw_low: 15,
    raw_high: null,
    count: 9,
    typical_pct: null,
    budget_pct: null,
    basis_project: null,
  });
});

test("a clamped range reads rough: basis wide, the basis name and both ends kept", () => {
  const clamped = { ...RANGED, label: "wide, low confidence", rough: true } as const;
  assert.deepEqual(estimateJson(clamped), {
    key: "A",
    subscription: "claude",
    basis: "wide",
    basis_name: "issue_bytes",
    low_pct: 1.5,
    high_pct: 4,
    raw_low: 15,
    raw_high: 40,
    count: 9,
    typical_pct: 2,
    budget_pct: 3,
    basis_project: null,
  });
  assert.equal(estimateJson(RANGED).basis, "similar", "the control: a range that is not rough keeps its word");
});

test("TP-18: type and all read wide and keep their own name; no basis reads none with the name none", () => {
  const wide = { ...RANGED, basis: "wide", label: "wide, low confidence" } as const;
  assert.deepEqual(
    [estimateJson({ ...wide, basisName: "type" }), estimateJson({ ...wide, basisName: "all" })].map((json) => [json.basis, json.basis_name]),
    [["wide", "type"], ["wide", "all"]],
  );
  const none = estimateJson({ key: "N", subscription: "codex", basis: "none", basisName: "none", label: "no basis yet" });
  assert.deepEqual(none, { key: "N", subscription: "codex", basis: "none", basis_name: "none" });
  assert.deepEqual(Object.keys(none), ["key", "subscription", "basis", "basis_name"]);
});

test("TP-18: an estimate from an older snapshot reads its basis name as null and keeps its basis word and range", () => {
  const older = [
    { key: "A", subscription: "claude", basis: "similar", low_pct: 1, high_pct: 2, raw_low: 10, raw_high: 20, count: 3 },
    { key: "B", subscription: "claude", basis: "wide", low_pct: 1, high_pct: 2, count: 3 },
    { key: "C", subscription: "codex", basis: "none" },
  ] as unknown as readonly EstimateJson[];
  const result = refreshShares({ ...data([], []), estimates: older }, SEPARATE, NOW).estimates;
  assert.deepEqual(
    result.map((json) => [json.key, json.basis, json.basis_name]),
    [["A", "similar", null], ["B", "wide", null], ["C", "none", null]],
  );
  assert.deepEqual(result[0], {
    key: "A",
    subscription: "claude",
    basis: "similar",
    basis_name: null,
    low_pct: 1,
    high_pct: 2,
    raw_low: 10,
    raw_high: 20,
    count: 3,
    typical_pct: null,
    budget_pct: null,
    basis_project: null,
  });
});

test("TP-29: a ranged row has typical_pct and budget_pct after count, a no basis row has neither key, an open row has both null", () => {
  const json = estimateJson(RANGED);
  assert.deepEqual(Object.keys(json).slice(-4), ["count", "typical_pct", "budget_pct", "basis_project"]);
  assert.deepEqual([json.basis !== "none" && json.typical_pct, json.basis !== "none" && json.budget_pct], [2, 3]);

  const none = estimateJson({ key: "N", subscription: "claude", basis: "none", basisName: "none", label: "no basis yet" });
  assert.equal(Object.hasOwn(none, "typical_pct"), false);
  assert.equal(Object.hasOwn(none, "budget_pct"), false);

  const open = estimateJson({ ...RANGED, open: true, rough: true, typicalPct: null, budgetPct: null });
  assert.deepEqual([Object.hasOwn(open, "typical_pct"), open.basis !== "none" && open.typical_pct, open.basis !== "none" && open.budget_pct], [true, null, null]);
});

// The JSON row of an item on the spent basis, with ten finished tasks that cost 1 to 10 percent of the week.
function spentRow(usedPct: number): EstimateJson {
  const week = 1_000_000;
  const calibration = { ready: true, perPctWeighted: week, confidence: "medium", intervals: 3, label: CALIBRATION_LABEL } as const;
  const history = Array.from({ length: 10 }, (_, i) => ({
    tags: {},
    features: {},
    totals: { claude: totalsOf([(i + 1) * week, 0, 0, 0, 0]), codex: totalsOf([0, 0, 0, 0, 0]) },
  }));
  const item = { key: "A", tags: {}, features: {}, spent: usedPct * week };
  const [estimate] = estimateFromSignals([item], history, { claude: calibration, codex: calibration });
  assert.ok(estimate !== undefined);
  return estimateJson(estimate);
}

test("TP-45: an item on the spent basis with fewer than 5 tasks at or over its cost so far reads open: no high end, no raw high, no typical, no budget", () => {
  assert.deepEqual(spentRow(9.5), {
    key: "A",
    subscription: "claude",
    basis: "wide",
    basis_name: "spent",
    low_pct: 9.5,
    high_pct: null,
    raw_low: 9_500_000,
    raw_high: null,
    count: 1,
    typical_pct: null,
    budget_pct: null,
    basis_project: null,
  });
});

test("TP-30: a closed spent row keeps its typical and budget costs through the reader", () => {
  const row = spentRow(6);
  assert.ok(row.basis !== "none");
  assert.deepEqual([row.basis_name, row.count], ["spent", 5]);
  [row.low_pct, row.typical_pct, row.budget_pct, row.high_pct].forEach((value, index) => near(value, [6.4, 8, 9.2, 9.6][index] ?? Number.NaN));
  assert.deepEqual(readRows([row]), [row]);
});

const TYPICAL_BUDGET_ROW = { key: "A", subscription: "claude", basis: "similar", basis_name: "f1", low_pct: 1, high_pct: 4, raw_low: 10, raw_high: 40, count: 9 } as const;

function readRows(rows: readonly object[]): readonly EstimateJson[] {
  return refreshShares({ ...data([], []), estimates: rows as unknown as readonly EstimateJson[] }, SEPARATE, NOW).estimates;
}

test("TP-116: a project estimate ends with its project and keeps the wide basis and all name", () => {
  const row = estimateJson({ ...RANGED, basis: "wide", basisName: "all", basisProject: "alpha" });
  assert.deepEqual([row.basis, row.basis_name, Object.entries(row).at(-1)], ["wide", "all", ["basis_project", "alpha"]]);
});

test("TP-117: the snapshot reader keeps a valid project and replaces an absent or invalid project with null", () => {
  const row = { ...TYPICAL_BUDGET_ROW, typical_pct: 2, budget_pct: 3 };
  const input = [row, { ...row, basis_project: "alpha" }, { ...row, basis_project: "has space" }, { ...row, basis_project: 7 }];
  assert.deepEqual(readRows(input), [null, "alpha", null, null].map((basis_project) => ({ ...row, basis_project })));
});

function pairOf(row: EstimateJson | undefined): readonly unknown[] {
  assert.ok(row !== undefined && row.basis !== "none", "the row is a ranged row");
  return [row.typical_pct, row.budget_pct];
}

test("TP-30: a typical or budget that is not a finite number above 0, or that is above the other, reads both as null on refresh; a valid pair stays", () => {
  const pairs: readonly (readonly [unknown, unknown])[] = [
    [0, 3],
    [-1, 3],
    [2, 0],
    [2, -3],
    ["2", 3],
    [2, "3"],
    [Number.NaN, 3],
    [2, Number.POSITIVE_INFINITY],
    [3, 2],
    [2, undefined],
    [undefined, 3],
    [null, 3],
    [2, null],
  ];
  const rows = pairs.map(([typical, budget]) => ({ ...TYPICAL_BUDGET_ROW, typical_pct: typical, budget_pct: budget }));
  const read = readRows(rows);
  assert.deepEqual(read.map(pairOf), pairs.map(() => [null, null]));
  assert.deepEqual(pairOf(readRows([{ ...TYPICAL_BUDGET_ROW, typical_pct: 2, budget_pct: 3 }])[0]), [2, 3]);
  assert.deepEqual(pairOf(readRows([{ ...TYPICAL_BUDGET_ROW, typical_pct: 3, budget_pct: 3 }])[0]), [3, 3], "equal values are valid");
});

test("a typical cost under low_pct, or a budget cost over high_pct, reads both costs as null and keeps the rest of the row", () => {
  const rows = [
    { ...TYPICAL_BUDGET_ROW, typical_pct: 0.5, budget_pct: 3 },
    { ...TYPICAL_BUDGET_ROW, typical_pct: 2, budget_pct: 5 },
    { ...TYPICAL_BUDGET_ROW, typical_pct: 0.5, budget_pct: 5 },
  ];
  const read = readRows(rows);
  assert.deepEqual(read.map(pairOf), rows.map(() => [null, null]));
  assert.deepEqual(read, rows.map((row) => ({ ...row, typical_pct: null, budget_pct: null, basis_project: null })));
});

test("a typical and a budget cost in full order with the range keep both, also when they equal an end of the range", () => {
  const pairs: readonly (readonly [number, number])[] = [
    [2, 3],
    [1, 4],
    [1, 1],
    [4, 4],
  ];
  const rows = pairs.map(([typical, budget]) => ({ ...TYPICAL_BUDGET_ROW, typical_pct: typical, budget_pct: budget }));
  assert.deepEqual(readRows(rows).map(pairOf), pairs);
  assert.deepEqual(readRows(rows), rows.map((row) => ({ ...row, basis_project: null })));
});

test("TP-30: an open row, with high_pct null, reads both typical_pct and budget_pct as null whatever they hold", () => {
  const read = readRows([{ ...TYPICAL_BUDGET_ROW, high_pct: null, raw_high: null, typical_pct: 2, budget_pct: 3 }]);
  assert.deepEqual(pairOf(read[0]), [null, null]);
});

test("TP-31: a row from an older build, with neither field, reads both as null and keeps its other values", () => {
  const read = readRows([TYPICAL_BUDGET_ROW]);
  assert.deepEqual(read[0], { ...TYPICAL_BUDGET_ROW, typical_pct: null, budget_pct: null, basis_project: null });
});

test("TP-30: a no basis row stays without the two keys after a refresh", () => {
  const read = readRows([{ key: "N", subscription: "claude", basis: "none", basis_name: "none", typical_pct: 2, budget_pct: 3 }]);
  assert.deepEqual(read[0], { key: "N", subscription: "claude", basis: "none", basis_name: "none" });
});

// --- the self-check (TP-28, TP-48) ---

function withSelfCheck(value: unknown): StatusData {
  return { ...data([], []), self_check: value } as unknown as StatusData;
}

test("TP-48: a snapshot with a bad self_check object reads the object as null", () => {
  const bad: readonly unknown[] = [
    "x",
    7,
    [],
    {},
    { n: 1.5, hit_rate: 0.5, error_factor: 2 },
    { n: -1, hit_rate: 0.5, error_factor: 2 },
    { n: "5", hit_rate: 0.5, error_factor: 2 },
    { n: 5, hit_rate: 1.5, error_factor: 2 },
    { n: 5, hit_rate: "0.5", error_factor: 2 },
    { n: 5, hit_rate: 0.5, error_factor: 0.5 },
    { n: 5, hit_rate: 0.5 },
  ];
  for (const value of bad) {
    const read: SelfCheckJson | null = refreshShares(withSelfCheck(value), SEPARATE, NOW).self_check;
    assert.equal(read, null, JSON.stringify(value));
  }
});

test("TP-48: a snapshot without self_check, as an older build wrote it, reads it as null", () => {
  const older = data([], []) as unknown as Record<string, unknown>;
  delete older["self_check"];
  const read = refreshShares(older as unknown as StatusData, SEPARATE, NOW);
  assert.equal(read.self_check, null);
  assert.equal(read.version, 1, "the rest of the snapshot is as it was");
});

const SELF_CHECK_KEYS = ["n", "hit_rate", "error_factor", "bias", "band_low", "band_high", "width", "useful_rate", "stages", "projects"];
const STAGE_KEYS = ["n", "hit_rate", "error_factor", "bias", "band_low", "band_high", "width", "useful_rate"];
const NO_NUMBERS = { hit_rate: null, error_factor: null, bias: null, band_low: null, band_high: null, width: null, useful_rate: null };

// The band that `n` scored tasks carry: the reader accepts no other band for a count.
function bandOf(n: number): Pick<StageCheckJson, "band_low" | "band_high"> {
  const band = hitRateBand(n);
  return { band_low: band?.low ?? null, band_high: band?.high ?? null };
}

function stageJson(over: Partial<StageCheckJson> = {}): StageCheckJson {
  return { n: 6, hit_rate: 0.5, error_factor: 2, bias: 1.5, ...bandOf(over.n ?? 6), width: 2, useful_rate: 0.25, ...over };
}

function checkJson(over: Partial<SelfCheckJson> = {}): SelfCheckJson {
  return { n: 12, hit_rate: 0.75, error_factor: 1.8, bias: 1.2, ...bandOf(over.n ?? 12), width: 2.5, useful_rate: 0.5, stages: { plan: stageJson() }, projects: null, ...over };
}

// A copy of `value` without the named keys: a field that is absent, not null.
function omit(value: object, ...keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

function readSelfCheck(value: unknown): SelfCheckJson | null {
  return refreshShares(withSelfCheck(value), SEPARATE, NOW).self_check;
}

// The stages object of a read, which must be there.
function stagesOf(read: SelfCheckJson | null): Readonly<Record<string, StageCheckJson>> {
  const stages = read?.stages;
  assert.ok(stages !== null && stages !== undefined, "the stages are missing");
  return stages;
}

test("TP-28: a self_check object keeps its numbers, and nulls for a task count that is too small or a log that cannot be read", () => {
  const good: readonly SelfCheckJson[] = [
    checkJson(),
    checkJson({ stages: {} }),
    checkJson({ n: 30, hit_rate: 0, error_factor: 1, bias: 0.25, band_low: 19 / 30, band_high: 28 / 30, useful_rate: 0, stages: null }),
    { n: 3, ...NO_NUMBERS, stages: {}, projects: {} },
    { n: 0, ...NO_NUMBERS, stages: {}, projects: {} },
    { n: null, ...NO_NUMBERS, stages: null, projects: null },
  ];
  for (const value of good) {
    const read: SelfCheckJson | null = readSelfCheck(value);
    assert.deepEqual(read, value);
    assert.deepEqual(Object.keys(read ?? {}), SELF_CHECK_KEYS);
  }
});

test("a snapshot from before bias, bands and stages keeps its three numbers and reads the new fields as null", () => {
  const older: readonly [Record<string, unknown>, SelfCheckJson][] = [
    [
      { n: 12, hit_rate: 0.75, error_factor: 1.8 },
      { n: 12, hit_rate: 0.75, error_factor: 1.8, bias: null, band_low: null, band_high: null, width: null, useful_rate: null, stages: null, projects: null },
    ],
    [{ n: 3, hit_rate: null, error_factor: null }, { n: 3, ...NO_NUMBERS, stages: null, projects: null }],
    [{ n: null, hit_rate: null, error_factor: null }, { n: null, ...NO_NUMBERS, stages: null, projects: null }],
  ];
  for (const [value, expected] of older) {
    const read = readSelfCheck(value);
    assert.deepEqual(read, expected);
    assert.deepEqual(Object.keys(read ?? {}), SELF_CHECK_KEYS);
  }
});

test("a bias of zero, below zero, infinite, not a number or text makes the whole self_check null", () => {
  for (const bias of [0, -1, -0.5, Number.POSITIVE_INFINITY, Number.NaN, "1.2", true, [], {}]) {
    assert.equal(readSelfCheck(checkJson({ bias: bias as unknown as number })), null, String(bias));
  }
  assert.deepEqual(readSelfCheck(checkJson({ bias: 1e-300 }))?.bias, 1e-300, "a very small bias above zero is kept");
});

test("a band outside 0 to 1, a low above the high, one band null, or numbers under five scored make the whole self_check null", () => {
  const bad: readonly unknown[] = [
    checkJson({ band_low: -0.1 }),
    checkJson({ band_high: 1.1 }),
    checkJson({ band_low: 0.9, band_high: 0.5 }),
    checkJson({ band_low: null }),
    checkJson({ band_high: null }),
    checkJson({ band_low: "0.4" as unknown as number }),
    omit(checkJson(), "band_low"),
    omit(checkJson(), "band_high"),
    checkJson({ n: 4 }),
    checkJson({ n: 0, hit_rate: null, error_factor: null, bias: 1, band_low: null, band_high: null }),
    checkJson({ n: 4, hit_rate: null, error_factor: null, bias: null }),
    checkJson({ n: 4, hit_rate: null, error_factor: 2, bias: null, band_low: null, band_high: null }),
    checkJson({ n: 4, hit_rate: 0.5, error_factor: null, bias: null, band_low: null, band_high: null }),
  ];
  for (const value of bad) assert.equal(readSelfCheck(value), null, JSON.stringify(value));
  assert.deepEqual(readSelfCheck(checkJson({ n: 5, band_low: 0.4, band_high: 1 }))?.band_low, 0.4, "the band of five tasks is kept");
});

test("a band that is not the band of the task count makes the whole self_check null, and the band of each count from 5 to 30 is kept", () => {
  const bad: readonly SelfCheckJson[] = [
    checkJson({ band_low: 0.4, band_high: 1 }),
    checkJson({ n: 5, ...bandOf(12) }),
    checkJson({ n: 30, band_low: 0.6, band_high: 0.9 }),
    checkJson({ band_low: 0, band_high: 1 }),
    checkJson({ band_low: 0.5, band_high: 0.5 }),
    checkJson({ n: SELF_CHECK_TASKS + 1, band_low: 0, band_high: 1 }),
  ];
  for (const value of bad) assert.equal(readSelfCheck(value), null, JSON.stringify(value));

  for (let n = SELF_CHECK_MIN_SCORED; n <= SELF_CHECK_TASKS; n += 1) {
    const value = checkJson({ n, ...bandOf(n), stages: { plan: stageJson({ n }) } });
    assert.deepEqual(readSelfCheck(value), value, String(n));
  }
});

test("a stage band that is not the band of the stage task count gives stages null and keeps the rest of the self_check", () => {
  const wrong: readonly unknown[] = [
    { plan: stageJson({ band_low: 0.4, band_high: 1 }) },
    { plan: stageJson({ n: 30, band_low: 0.6, band_high: 0.9 }) },
    { plan: stageJson({ band_low: 0, band_high: 1 }) },
    { plan: stageJson({ band_low: 0.5, band_high: 0.5 }) },
    { plan: stageJson({ n: 6, ...bandOf(12) }) },
    { plan: stageJson(), issue: stageJson({ band_low: 0.4, band_high: 1 }) },
  ];
  for (const stages of wrong) {
    assert.deepEqual(readSelfCheck({ ...checkJson(), stages }), { ...checkJson(), stages: null }, JSON.stringify(stages));
  }
});

test("a self_check with n null has every number null and stages null or absent, else the whole self_check is null", () => {
  const unread = { n: null, ...NO_NUMBERS, stages: null, projects: null };
  const bad: readonly unknown[] = [
    { ...unread, hit_rate: 0.5 },
    { ...unread, error_factor: 2 },
    { ...unread, bias: 1.5 },
    { ...unread, ...bandOf(12) },
    { ...unread, width: 2 },
    { ...unread, useful_rate: 0.5 },
    { n: null, hit_rate: 0.5, error_factor: 2, bias: 1.5, ...bandOf(12), stages: { plan: stageJson() } },
    { ...unread, stages: {} },
    { ...unread, stages: { plan: stageJson() } },
    { ...unread, stages: "x" },
    { n: null, hit_rate: 0.5, error_factor: 2 },
  ];
  for (const value of bad) assert.equal(readSelfCheck(value), null, JSON.stringify(value));
  assert.deepEqual(readSelfCheck(unread), unread);
  assert.deepEqual(readSelfCheck(omit(unread, "stages")), unread, "absent stages read null");
});

test("a bad stages value gives stages null and keeps every other field of the self_check", () => {
  const keepTop = (stages: unknown): SelfCheckJson | null => readSelfCheck({ ...checkJson(), stages });
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, stageJson()]));
  const bad: readonly unknown[] = [
    { "has space": stageJson() },
    { "": stageJson() },
    { ["x".repeat(65)]: stageJson() },
    { plan: stageJson({ n: -1 }) },
    { plan: stageJson({ n: 31 }) },
    { plan: stageJson({ n: 1.5 }) },
    { plan: stageJson({ n: "6" as unknown as number }) },
    { plan: stageJson({ n: null as unknown as number }) },
    { plan: stageJson({ n: Number.POSITIVE_INFINITY }) },
    nine,
    { plan: stageJson({ n: 4 }) },
    { plan: stageJson({ n: 0 }) },
    { plan: stageJson({ n: 4, hit_rate: null, error_factor: null, bias: null, band_low: null, band_high: 1 }) },
    { plan: stageJson({ bias: 0 }) },
    { plan: stageJson({ bias: Number.POSITIVE_INFINITY }) },
    { plan: stageJson({ hit_rate: 1.5 }) },
    { plan: stageJson({ error_factor: 0.5 }) },
    { plan: stageJson({ band_low: 0.9, band_high: 0.5 }) },
    { plan: stageJson({ band_low: null }) },
    { plan: stageJson({ width: 0.5 }) },
    { plan: stageJson({ width: "2" as unknown as number }) },
    { plan: stageJson({ width: Number.POSITIVE_INFINITY }) },
    { plan: stageJson({ useful_rate: 1.5 }) },
    { plan: stageJson({ useful_rate: 0.9 }) },
    { plan: stageJson({ hit_rate: null, useful_rate: 0.1 }) },
    { plan: stageJson({ n: 4, hit_rate: null, error_factor: null, bias: null, band_low: null, band_high: null, useful_rate: null }) },
    { plan: omit(stageJson(), "bias") },
    { plan: omit(stageJson(), "band_high") },
    { plan: 7 },
    { plan: null },
    { plan: [] },
    { plan: "x" },
    { plan: stageJson(), issue: stageJson({ bias: -1 }) },
    "x",
    7,
    true,
    [],
    [stageJson()],
  ];
  for (const stages of bad) {
    const read = keepTop(stages);
    assert.deepEqual(read, { ...checkJson(), stages: null }, JSON.stringify(stages));
  }
  assert.deepEqual(keepTop(null), { ...checkJson(), stages: null });
  assert.deepEqual(readSelfCheck(omit(checkJson(), "stages")), { ...checkJson(), stages: null }, "absent stages read null");
});

test("a width under 1 or not a number, or a useful rate outside 0 to 1, above the hit rate or with no hit rate, makes the whole self_check null", () => {
  for (const width of [0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, "2", true, [], {}]) {
    assert.equal(readSelfCheck(checkJson({ width: width as unknown as number })), null, `width ${String(width)}`);
  }
  for (const usefulRate of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5", true, [], {}]) {
    assert.equal(readSelfCheck(checkJson({ useful_rate: usefulRate as unknown as number })), null, `useful rate ${String(usefulRate)}`);
  }
  assert.equal(readSelfCheck(checkJson({ hit_rate: 0.5, useful_rate: 0.6 })), null, "a useful rate above the hit rate");
  assert.equal(readSelfCheck(checkJson({ hit_rate: null, useful_rate: 0.5 })), null, "a useful rate with no hit rate");
  assert.equal(readSelfCheck(checkJson({ n: 4, ...NO_NUMBERS, width: 2 })), null, "a width under five scored tasks");
  assert.notEqual(readSelfCheck(checkJson({ n: 4, ...NO_NUMBERS })), null, "the same check with no width is kept");
  assert.deepEqual(readSelfCheck(checkJson({ width: 1, hit_rate: 0.5, useful_rate: 0.5 })), checkJson({ width: 1, hit_rate: 0.5, useful_rate: 0.5 }), "the limits are kept");
});

test("a stage with a bad width or useful rate gives stages null and keeps every other field of the self_check", () => {
  for (const stage of [stageJson({ width: 0.5 }), stageJson({ width: "2" as unknown as number }), stageJson({ useful_rate: 0.9 })]) {
    assert.deepEqual(readSelfCheck(checkJson({ stages: { plan: stage } })), checkJson({ stages: null }), JSON.stringify(stage));
  }
});

test("a snapshot with no width or useful rate, at the top or in the stages, reads both as null and keeps its stages", () => {
  const older = {
    ...omit(checkJson(), "width", "useful_rate"),
    stages: { plan: omit(stageJson(), "width", "useful_rate"), issue: omit(stageJson({ n: 8 }), "width", "useful_rate") },
  };
  const read = readSelfCheck(older);
  assert.deepEqual(read, checkJson({ width: null, useful_rate: null, stages: { plan: stageJson({ width: null, useful_rate: null }), issue: stageJson({ n: 8, width: null, useful_rate: null }) } }));
  assert.deepEqual(Object.keys(read ?? {}), SELF_CHECK_KEYS);
  for (const stage of Object.values(stagesOf(read))) assert.deepEqual(Object.keys(stage), STAGE_KEYS);
});

test("a width of null with a useful rate is kept: a width that is not finite leaves the other numbers", () => {
  const value = checkJson({ hit_rate: 1, useful_rate: 0.4, width: null });
  assert.deepEqual(readSelfCheck(value), value);
});

test("stages with no scored task, eight stages, and the limits of the task count are kept", () => {
  const empty = stageJson({ n: 0, hit_rate: null, error_factor: null, bias: null, band_low: null, band_high: null, width: null, useful_rate: null });
  const four = stageJson({ n: 4, hit_rate: null, error_factor: null, bias: null, band_low: null, band_high: null, width: null, useful_rate: null });
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`s${i}`, stageJson({ n: 30 })]));
  for (const stages of [{ plan: empty, run: four, issue: stageJson({ n: 5 }) }, eight, {}]) {
    assert.deepEqual(readSelfCheck(checkJson({ stages })), checkJson({ stages }));
  }
});

test("the stage labels __proto__, constructor and toString read as own entries of the stages object", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const text = JSON.stringify(checkJson({ stages: {} })).replace(
    '"stages":{}',
    `"stages":{"__proto__":${JSON.stringify(stageJson({ n: 7 }))},"constructor":${JSON.stringify(stageJson({ n: 8 }))},"toString":${JSON.stringify(stageJson({ n: 9 }))}}`,
  );
  const parsed = JSON.parse(text) as { stages: Record<string, unknown> };
  assert.ok(Object.hasOwn(parsed.stages, "__proto__"), "the fixture has an own __proto__ key");

  const stages = stagesOf(readSelfCheck(parsed));
  assert.deepEqual(Object.keys(stages), ["__proto__", "constructor", "toString"]);
  assert.deepEqual(Object.values(stages).map((stage) => stage.n), [7, 8, 9]);
  assert.equal(Object.getPrototypeOf(stages), Object.prototype);
  assert.ok(Object.hasOwn(stages, "__proto__"));
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

test("TP-127: an invalid projects map reads as null and keeps the rest of the self-check", () => {
  const expected = { ...checkJson(), projects: null };
  const tooMany = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`alpha${i}`, stageJson()]));
  for (const projects of [{ "has space": stageJson() }, { alpha: stageJson({ n: -1 }) }, tooMany, []]) {
    assert.deepEqual(readSelfCheck({ ...expected, projects }), expected);
  }
  const noCount = { n: null, ...NO_NUMBERS, stages: null, projects: null };
  assert.deepEqual(readSelfCheck({ ...noCount, projects: { alpha: stageJson() } }), noCount);
});

// --- the self_check that a built status carries ---

const SEP_1 = Date.parse("2026-09-01T00:00:00Z");
const DAY = 24 * HOUR;

// A finished task from day `2 + index` to day `3 + index` that cost `weighted`.
function history(costs: readonly number[]): TaskEntry[] {
  return costs.map((weighted, i) => ({
    label: `K${i}`,
    tags: {},
    start: SEP_1 + (2 + i) * DAY,
    end: SEP_1 + (3 + i) * DAY,
    shared: false,
    totals: { claude: totalsOf([weighted, 0, 0, 0, 0]), codex: totalsOf([0, 0, 0, 0, 0]) },
    features: {},
  }));
}

// A line for key `Ki` one hour before it starts, with the range 100 to 400.
function lineBefore(index: number, stage: string | null, hoursBefore = 1): EstimateLogLine {
  const at = SEP_1 + (2 + index) * DAY - hoursBefore * HOUR;
  return { at, key: `K${index}`, basis: "wide", basisName: "all", features: [], stage, low: 100, high: 400 };
}

function buildInput(lines: readonly EstimateLogLine[], entries: readonly TaskEntry[], damaged = false): BuildInput {
  return {
    nowMs: NOW,
    analysis: analyze({ nowMs: NOW, zone: localZone(), rows: [], samples: [], observations: [], collectState: "ok" }),
    collectState: "ok",
    progressPct: 100,
    roots: { claude: "scanned", codex: "scanned" },
    usage: [],
    history: entries,
    openItems: [],
    pool: SEPARATE,
    estimateLog: { lines, damaged },
  };
}

function builtSelfCheck(lines: readonly EstimateLogLine[], entries: readonly TaskEntry[], damaged = false): SelfCheckJson {
  const check = buildStatus(buildInput(lines, entries, damaged)).data.self_check;
  assert.ok(check !== null, "the self_check is missing");
  return check;
}

test("a built self_check keeps check fields in order and gives each stage the eight metrics", () => {
  // The range is 100 to 400, so its log middle is 200. The costs 400, 400, 400, 200 and 50 give four hits and
  // one miss. The offsets are ln 1/2 (three times), 0 and ln 4: the bias is exp of their median, 1/2, and the
  // error factor is the median of exp of their size, 2. So the bias and the error factor differ. The width is
  // 4 (400 over 100) and the four hits are useful, because the bound of 4 times the low end is inclusive.
  const entries = history([400, 400, 400, 200, 50]);
  const lines = entries.flatMap((_, i) => [lineBefore(i, "plan"), lineBefore(i, "issue", 2)]);
  const check = builtSelfCheck(lines, entries);
  const expectFive = (value: Omit<SelfCheckJson, "stages" | "projects">): void => {
    assert.deepEqual([value.n, value.hit_rate, value.band_low, value.band_high], [5, 0.8, 0.4, 1]);
    near(value.bias, 0.5);
    near(value.error_factor, 2);
    assert.equal(value.width, 4);
    near(value.useful_rate, 0.8);
  };
  assert.deepEqual(Object.keys(check), SELF_CHECK_KEYS);
  expectFive(check);
  const stages = stagesOf(check);
  assert.deepEqual(Object.keys(stages), ["issue", "plan"]);
  for (const stage of Object.values(stages)) {
    assert.deepEqual(Object.keys(stage), STAGE_KEYS);
    expectFive(stage);
  }
});

test("a built self_check read back from snapshot text passes through refreshShares unchanged, its stages in order", () => {
  // Seven tasks with five hits, and an issue stage on the first five only. Hits are under the scored count,
  // so the hit rate, the bias, the error factor and the band differ from one stage to the next.
  const entries = history([400, 400, 400, 200, 50, 800, 200]);
  const lines = entries.flatMap((_, i) => [lineBefore(i, "plan"), ...(i < 5 ? [lineBefore(i, "issue", 2)] : [])]);
  const built = buildStatus(buildInput(lines, entries)).data;
  const check = built.self_check;
  assert.ok(check !== null, "the self_check is missing");
  const stages = stagesOf(check);
  assert.deepEqual(Object.keys(stages), ["issue", "plan"]);
  assert.deepEqual([check.n, stages["issue"]?.n, stages["plan"]?.n], [7, 5, 7]);
  for (const value of [check, ...Object.values(stages)]) {
    assert.ok(value.hit_rate !== null && value.hit_rate < 1, "a miss");
    assert.ok(value.bias !== null && Number.isFinite(value.bias) && value.bias !== value.error_factor);
    assert.ok(value.error_factor !== null && Number.isFinite(value.error_factor));
    assert.equal(value.width, 4);
    assert.ok(value.useful_rate !== null && value.useful_rate <= value.hit_rate);
  }

  const onDisk = JSON.parse(JSON.stringify(built)) as StatusData;
  const read = refreshShares(onDisk, SEPARATE, NOW).self_check;
  assert.deepEqual(read, check);
  assert.deepEqual(Object.keys(read ?? {}), SELF_CHECK_KEYS);
  assert.deepEqual(Object.keys(stagesOf(read)), ["issue", "plan"]);
  for (const stage of Object.values(stagesOf(read))) assert.deepEqual(Object.keys(stage), STAGE_KEYS);
});

test("a built self_check of four scored tasks has width and useful_rate null at the top level and in each stage", () => {
  const entries = history([200, 200, 200, 200]);
  const check = builtSelfCheck(entries.flatMap((_, i) => [lineBefore(i, "plan"), lineBefore(i, "issue", 2)]), entries);
  assert.equal(check.n, 4);
  assert.deepEqual([check.width, check.useful_rate], [null, null]);
  const stages = stagesOf(check);
  assert.deepEqual(Object.keys(stages), ["issue", "plan"]);
  for (const stage of Object.values(stages)) assert.deepEqual([stage.n, stage.width, stage.useful_rate], [4, null, null]);
});

test("TP-128: project map keys stay own data through the status writer and reader", () => {
  const projects = ["__proto__", "constructor", "toString"];
  const entries = history([200, 200, 200]).map((entry, i) => ({ ...entry, tags: { project: projects[i] ?? "" } }));
  const check = builtSelfCheck(entries.map((_, i) => lineBefore(i, null)), entries);
  const expected = Object.fromEntries(projects.map((project) => [project, { n: 1, ...NO_NUMBERS }]));
  assert.deepEqual(Object.getOwnPropertyDescriptor(check, "projects")?.value, expected);
  assert.deepEqual(readSelfCheck(JSON.parse(JSON.stringify(check))), check);
});

test("a built self_check whose width is not finite keeps the other numbers, and the reader keeps the self_check", () => {
  // Two ranges of 100 to 200 and three of 1e-300 to 1e10, every cost 150: all five are hits, the median of the
  // five ratios is infinite, and the two narrow ranges are the only useful ones.
  const entries = history([150, 150, 150, 150, 150]);
  const lines = entries.map(
    (_, i): EstimateLogLine => ({
      at: SEP_1 + (2 + i) * DAY - HOUR,
      key: `K${i}`,
      basis: "wide",
      basisName: "all",
      features: [],
      stage: null,
      ...(i < 2 ? { low: 100, high: 200 } : { low: 1e-300, high: 1e10 }),
    }),
  );
  const built = buildStatus(buildInput(lines, entries)).data;
  const check = built.self_check;
  assert.ok(check !== null, "the self_check is missing");
  assert.equal(check.n, 5);
  assert.equal(check.width, null);
  assert.equal(check.hit_rate, 1);
  near(check.useful_rate, 0.4);
  assert.ok(check.error_factor !== null && check.bias !== null && check.band_low !== null && check.band_high !== null);
  const onDisk = JSON.parse(JSON.stringify(built)) as StatusData;
  assert.deepEqual(refreshShares(onDisk, SEPARATE, NOW).self_check, check);
});

test("TP-126: a readable log without stage or project data has empty maps", () => {
  const entries = history([200, 200, 200, 200, 200]);
  const unstaged = builtSelfCheck(entries.map((_, i) => lineBefore(i, null)), entries);
  assert.deepEqual([unstaged.stages, unstaged.projects], [{}, {}]);
  assert.equal(unstaged.n, 5);
  assert.deepEqual(builtSelfCheck([], entries), { n: 0, ...NO_NUMBERS, stages: {}, projects: {} });
});

test("TP-126: a damaged log has null metrics and maps", () => {
  const entries = history([200, 200, 200, 200, 200]);
  const check = builtSelfCheck(entries.map((_, i) => lineBefore(i, "plan")), entries, true);
  assert.deepEqual(check, { n: null, ...NO_NUMBERS, stages: null, projects: null });
  assert.deepEqual(Object.keys(check), SELF_CHECK_KEYS);
});

test("the stages of a built self_check stay under 2.5 KiB as snapshot text: one over the limit, 64-character labels, fractional values", () => {
  // Costs on both sides of the range 100 to 400 give hits and misses, and long fractions for the other values.
  const entries = history(Array.from({ length: 30 }, (_, i) => 90.123456 + i * 17.3217));
  const labels = Array.from({ length: MAX_STAGES + 1 }, (_, j) => `${j}${"x".repeat(63)}`);
  const lines = entries.flatMap((_, i) => labels.map((label, j) => lineBefore(i, label, 1 + j)));
  const stages = stagesOf(builtSelfCheck(lines, entries));
  assert.deepEqual(Object.keys(stages), labels.slice(0, MAX_STAGES));
  const text = JSON.stringify(stages);
  assert.match(text, /\d\.\d{14,}/, "the fixture gives values with long fractions");
  assert.ok(text.length < 2560, `${text.length} bytes`); // Each of the 8 stages has the two values width and useful_rate; the worst case is about 2260 bytes.
});

test("the stage labels __proto__, constructor and toString go through the built status, the snapshot text and the reader as own stages", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const entries = history([200, 200, 200, 200, 200]);
  const labels = ["__proto__", "constructor", "toString"];
  const lines = entries.flatMap((_, i) => labels.map((label, j) => lineBefore(i, label, 1 + j)));
  const built = buildStatus(buildInput(lines, entries)).data;
  assert.deepEqual(Object.keys(stagesOf(built.self_check)), ["__proto__", "constructor", "toString"]);

  const onDisk = JSON.parse(JSON.stringify(built)) as StatusData;
  const read = refreshShares(onDisk, SEPARATE, NOW).self_check;
  const stages = stagesOf(read);
  assert.deepEqual(Object.keys(stages), ["__proto__", "constructor", "toString"]);
  assert.deepEqual(Object.values(stages).map((stage) => stage.n), [5, 5, 5]);
  assert.equal(Object.getPrototypeOf(stages), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

test("TP-18: a snapshot with the basis name keeps it, and a name that is not text reads as null", () => {
  const current = [estimateJson(RANGED), estimateJson({ key: "N", subscription: "claude", basis: "none", basisName: "none", label: "no basis yet" })];
  const kept = refreshShares({ ...data([], []), estimates: current }, SEPARATE, NOW).estimates;
  assert.deepEqual(kept, current);

  const bad = [{ ...current[0], basis_name: 7 }, { ...current[1], basis_name: { x: 1 } }] as unknown as readonly EstimateJson[];
  const read = refreshShares({ ...data([], []), estimates: bad }, SEPARATE, NOW).estimates;
  assert.deepEqual(read.map((json) => json.basis_name), [null, null]);
});

// --- the queue ---

const QUEUE_KEYS = ["count", "expected_pct", "low_pct", "high_pct", "likely_low_pct", "likely_high_pct", "spent_pct"];
const QUEUE: QueueJson = { count: 3, expected_pct: 6, low_pct: 4, high_pct: 8, likely_low_pct: 5, likely_high_pct: 7, spent_pct: 2 };
const NO_SUMS = { expected_pct: null, low_pct: null, high_pct: null, likely_low_pct: null, likely_high_pct: null, spent_pct: null };

// What the reader makes of a queue value in a snapshot.
function readQueue(value: unknown): QueueJson | null {
  return refreshShares({ ...data([], []), queue: value } as unknown as StatusData, SEPARATE, NOW).queue;
}

test("TP-42: a valid queue passes through refreshShares with its keys in order, and a queue of no sums keeps its count", () => {
  const read = readQueue(QUEUE);
  assert.deepEqual(read, QUEUE);
  assert.deepEqual(Object.keys(read ?? {}), QUEUE_KEYS);
  // The costs so far may be any size next to the draws; the ends may be equal.
  assert.deepEqual(readQueue({ ...QUEUE, spent_pct: 100, likely_low_pct: 4, likely_high_pct: 4 }), { ...QUEUE, spent_pct: 100, likely_low_pct: 4, likely_high_pct: 4 });
  assert.deepEqual(readQueue({ count: 2, ...NO_SUMS }), { count: 2, ...NO_SUMS });
  const zeros = { count: 0, expected_pct: 0, low_pct: 0, high_pct: 0, likely_low_pct: 0, likely_high_pct: 0, spent_pct: 0 };
  assert.deepEqual(readQueue(zeros), zeros);
  assert.equal(readQueue({ ...QUEUE, count: 500 })?.count, 500);
});

test("TP-42: the reader reads each field by name: a key it does not know is dropped", () => {
  const read = readQueue({ ...QUEUE, extra: 1 });
  assert.deepEqual(read, QUEUE);
  assert.deepEqual(Object.keys(read ?? {}), QUEUE_KEYS);
});

test("TP-42: a count outside 0 to 500 or not a whole number, a bad sum, a broken order or a mixed null set reads as a null queue", () => {
  const bad: readonly (readonly [string, unknown])[] = [
    ["count 501", { ...QUEUE, count: 501 }],
    ["count -1", { ...QUEUE, count: -1 }],
    ["count 1.5", { ...QUEUE, count: 1.5 }],
    ["count as text", { ...QUEUE, count: "3" }],
    ["count NaN", { ...QUEUE, count: Number.NaN }],
    ["count null", { ...QUEUE, count: null }],
    ["a negative sum", { ...QUEUE, expected_pct: -1 }],
    ["a negative spent", { ...QUEUE, spent_pct: -0.5 }],
    ["a sum as text", { ...QUEUE, low_pct: "4" }],
    ["a sum that is NaN", { ...QUEUE, high_pct: Number.NaN }],
    ["a sum that is not finite", { ...QUEUE, high_pct: Number.POSITIVE_INFINITY }],
    ["low above likely_low", { ...QUEUE, low_pct: 5.5 }],
    ["likely_low above likely_high", { ...QUEUE, likely_low_pct: 7.5 }],
    ["likely_high above high", { ...QUEUE, likely_high_pct: 8.5 }],
    ["one sum null, the others numbers", { ...QUEUE, expected_pct: null }],
    ["one number, the others null", { count: 3, ...NO_SUMS, spent_pct: 2 }],
    ["a sum is absent", { count: 3, expected_pct: 6, low_pct: 4, high_pct: 8, likely_low_pct: 5, likely_high_pct: 7 }],
    ["a text", "x"],
    ["a number", 7],
    ["a list", [QUEUE]],
    ["null", null],
  ];
  for (const [label, value] of bad) assert.equal(readQueue(value), null, label);
});

test("TP-43: a snapshot from an older build has no queue key and reads queue null, with the other fields kept", () => {
  const older = data([], [task("A", [share("claude", 10)])]) as unknown as Record<string, unknown>;
  delete older["queue"];
  const read = refreshShares(older as unknown as StatusData, SEPARATE, NOW);
  assert.equal(read.queue, null);
  assert.deepEqual(Object.keys(read).slice(-2), ["pool", "queue"], "the queue comes after the pool");
  assert.equal(read.tasks.length, 1);
  assert.deepEqual(Object.keys(refreshShares(data([], []), SEPARATE, NOW)).slice(-2), ["pool", "queue"]);
});

// Open items for a built status: the key only.
function openItems(count: number): BuildInput["openItems"] {
  return Array.from({ length: count }, (_, i) => ({ key: `K${i}`, tags: {}, features: {} }));
}

test("TP-43: a built status has the queue right after the pool: count of the open items, and no sums while the week is not known", () => {
  const built = buildStatus({ ...buildInput([], history([100, 200, 300])), openItems: openItems(2) }).data;
  assert.deepEqual(Object.keys(built).slice(-2), ["pool", "queue"]);
  assert.deepEqual(built.queue, { count: 2, ...NO_SUMS });
  assert.deepEqual(Object.keys(built.queue ?? {}), QUEUE_KEYS);
});

test("TP-43: a built status with no open item has a queue of count 0 and sums of 0, also with no week", () => {
  const queue = buildStatus(buildInput([], [])).data.queue;
  assert.deepEqual(queue, { count: 0, expected_pct: 0, low_pct: 0, high_pct: 0, likely_low_pct: 0, likely_high_pct: 0, spent_pct: 0 });
});

test("TP-39, TP-43: a built status with 500 open items has a queue, and with 501 the queue is null", () => {
  assert.equal(buildStatus({ ...buildInput([], []), openItems: openItems(500) }).data.queue?.count, 500);
  assert.equal(buildStatus({ ...buildInput([], []), openItems: openItems(501) }).data.queue, null);
});

test("TP-63: a snapshot from before the change keeps its old fields through refreshShares and reads every new field as null", () => {
  const stage = { n: 5, hit_rate: 0.5, error_factor: 2, bias: 1.5, ...bandOf(5) };
  const ranged = { key: "A", subscription: "claude", basis: "similar", basis_name: "f1", low_pct: 1, high_pct: 4, raw_low: 10, raw_high: 40, count: 9 };
  const none = { key: "N", subscription: "claude", basis: "none", basis_name: "none" };
  const older = { ...data([], []), estimates: [ranged, none], self_check: { ...stage, stages: { plan: stage } } } as unknown as Record<string, unknown>;
  delete older["queue"];

  const read = refreshShares(older as unknown as StatusData, SEPARATE, NOW);

  assert.deepEqual(Object.keys(read), ["version", "written_at", "collect", "subscriptions", "models", "tasks", "estimates", "self_check", "pool", "queue"]);
  assert.equal(read.queue, null);
  assert.deepEqual(read.estimates, [{ ...ranged, typical_pct: null, budget_pct: null, basis_project: null }, none]);
  assert.deepEqual(Object.keys(read.estimates[0] ?? {}), [...Object.keys(ranged), "typical_pct", "budget_pct", "basis_project"]);
  assert.deepEqual(read.self_check, { ...stage, width: null, useful_rate: null, stages: { plan: { ...stage, width: null, useful_rate: null } }, projects: null });
  assert.deepEqual(Object.keys(read.self_check ?? {}), ["n", "hit_rate", "error_factor", "bias", "band_low", "band_high", "width", "useful_rate", "stages", "projects"]);
  assert.deepEqual([read.version, read.written_at, read.pool], [1, START + HOUR, { mode: "separate" }]);
});
