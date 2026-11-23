// Tests for the per-day totals: the day rows that collect keeps next to the 15
// minute rows, the one-time backfill from the logs, and the days file.
//
// Every source root, data folder and write is inside a sandbox with a fixed
// clock. The local days follow an injected zone, so no test changes the TZ of the
// test process. No test reads or writes the real home.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAYS_MAX_MODELS, type Result, SCAN_BUDGET_BYTES, SCAN_BUDGET_MS, SLOT_MS } from "../src/core.ts";
import { type CollectInput, type CollectReport, collect } from "../src/collect.ts";
import { DAYS_FILE, DayRows, localDateOf } from "../src/days.ts";
import { type FsDeps, defaultDeps, prepareDataDir } from "../src/fsafe.ts";
import { type Zone, zoneNamed } from "../src/periods.ts";
import { bucketKey, bucketsFileName, loadBucketMonth, loadDayRows, parseBucketKey, slotOf } from "../src/store.ts";
import { assertGuarded, installSuiteGuard, makeSandbox, type Sandbox } from "./helpers.ts";

installSuiteGuard();

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MINUTE_MS = 60_000;
const DEPS: FsDeps = { ...defaultDeps(), nowMs: () => NOW };
const BUDGET = { bytes: SCAN_BUDGET_BYTES, ms: SCAN_BUDGET_MS };
const MTIME = NOW - HOUR_MS;
const PROJECT = "-work-alpha";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function must<T, E>(result: Result<T, E>): T {
  if (!result.ok) assert.fail(`expected an ok result, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function mustFail<T, E>(result: Result<T, E>): E {
  if (result.ok) assert.fail("expected an error result");
  return result.error;
}

// The zone of the tests: New York changes to standard time on 2026-11-01, so
// that local day has 25 hours.
const NEW_YORK: Zone = must(zoneNamed("America/New_York"));

interface World {
  readonly sb: Sandbox;
  readonly data: string;
  readonly claude: string;
  readonly codex: string;
}

function makeWorld(t: TestContext): World {
  const sb = makeSandbox(t);
  const data = must(prepareDataDir(sb.dataDir, DEPS));
  const claude = sb.path("src-claude");
  const codex = sb.path("src-codex");
  mkdirSync(claude);
  mkdirSync(codex);
  return { sb, data, claude, codex };
}

function inputOf(w: World, patch: Partial<CollectInput> = {}): CollectInput {
  return { dataDir: w.data, roots: { claude: w.claude, codex: w.codex }, budget: BUDGET, zone: NEW_YORK, ...patch };
}

function passOk(w: World, patch: Partial<CollectInput> = {}): CollectReport {
  return must(collect(inputOf(w, patch), DEPS));
}

function touch(path: string, mtimeMs: number): void {
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

function put(path: string, text: string, mtimeMs: number = MTIME): void {
  assertGuarded(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  touch(path, mtimeMs);
}

function append(path: string, text: string, mtimeMs: number = MTIME + 5 * MINUTE_MS): void {
  assertGuarded(path);
  appendFileSync(path, text);
  touch(path, mtimeMs);
}

// A clock that reads `first` at its first call, which is the start of a pass, and
// `later` at every call after.
function jumpDeps(first: number, later: number): FsDeps {
  let calls = 0;
  return { ...DEPS, nowMs: () => (calls++ === 0 ? first : later) };
}

function claudeFile(w: World, name: string, project: string = PROJECT): string {
  return join(w.claude, project, `${name}.jsonl`);
}

function codexFile(w: World, name: string, day: string = "2026/11/03"): string {
  return join(w.codex, ...day.split("/"), `rollout-${name}.jsonl`);
}

interface ClaudeSpec {
  readonly id: string;
  readonly at: string;
  readonly input?: number;
  readonly cw5m?: number;
  readonly cw1h?: number;
  readonly cacheRead?: number;
  readonly output?: number;
  readonly model?: string;
}

function claudeLine(spec: ClaudeSpec): string {
  const oneHour = spec.cw1h ?? 0;
  const fiveMinutes = spec.cw5m ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: spec.input ?? 0,
    cache_creation_input_tokens: fiveMinutes + oneHour,
    cache_read_input_tokens: spec.cacheRead ?? 0,
    output_tokens: spec.output ?? 0,
  };
  if (oneHour > 0) usage["cache_creation"] = { ephemeral_5m_input_tokens: fiveMinutes, ephemeral_1h_input_tokens: oneHour };
  return `${JSON.stringify({
    type: "assistant",
    timestamp: spec.at,
    cwd: "/work/alpha",
    requestId: `req_${spec.id}`,
    message: { id: `msg_${spec.id}`, model: spec.model ?? "claude-sonnet-5-5", usage },
  })}\n`;
}

function proxyLine(id: string, at: string, output: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: at,
    cwd: "/work/alpha",
    message: {
      id: `resp_${id}`,
      model: "gpt-9-test",
      usage: { input_tokens: 100, cache_read_input_tokens: 30, output_tokens: output },
    },
  })}\n`;
}

function codexMeta(at: string): string {
  return `${JSON.stringify({ timestamp: at, type: "session_meta", payload: { id: "sess-old", cwd: "/work/alpha" } })}\n`;
}

function codexTurn(at: string): string {
  return `${JSON.stringify({ timestamp: at, type: "turn_context", payload: { model: "gpt-5-codex" } })}\n`;
}

// Event n has its own last and total usage, so its key is its own. Its columns
// are input 90 + n (the cached 10 are not input), cache read 10 and output 5.
function codexEvent(at: string, n: number): string {
  const last = { input_tokens: 100 + n, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 105 + n };
  const total = { ...last, input_tokens: 1000 + n, total_tokens: 1005 + n };
  const payload = { type: "token_count", info: { total_token_usage: total, last_token_usage: last } };
  return `${JSON.stringify({ timestamp: at, type: "event_msg", payload })}\n`;
}

// An event with a last usage and no total usage: it has no key.
function codexKeyless(at: string): string {
  const last = { input_tokens: 100, cached_input_tokens: 10, output_tokens: 5, reasoning_output_tokens: 0, total_tokens: 105 };
  const payload = { type: "token_count", info: { last_token_usage: last } };
  return `${JSON.stringify({ timestamp: at, type: "event_msg", payload })}\n`;
}

function dayRows(w: World): DayRows {
  return must(loadDayRows(w.data, DEPS));
}

function columnsOn(rows: DayRows, date: string, provider: "claude" | "codex"): readonly number[] | undefined {
  return rows.get(date)?.[provider];
}

// The day rows that the 15 minute rows give, found with the same zone: the
// sum of each (provider, model) by the local day of the slot start.
function daysFromBuckets(w: World, zone: Zone): Map<string, Map<string, number[]>> {
  const out = new Map<string, Map<string, number[]>>();
  for (const month of ["2026-10", "2026-11"]) {
    for (const [key, columns] of must(loadBucketMonth(w.data, month, DEPS))) {
      const parts = parseBucketKey(key);
      assert.ok(parts !== null, key);
      const date = localDateOf(zone, parts.slot * SLOT_MS);
      const day = out.get(date) ?? new Map<string, number[]>();
      out.set(date, day);
      for (const name of [`${parts.provider}|*`, `${parts.provider}|${parts.model}`]) {
        const sum = day.get(name) ?? [0, 0, 0, 0, 0];
        day.set(name, sum.map((value, index) => value + (columns[index] ?? 0)));
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Day rows from a pass
// ---------------------------------------------------------------------------

test("a day row is the sum of its 15 minute rows, also across the 25 hour day of a clock change", (t) => {
  const w = makeWorld(t);
  // New York is 4 hours behind UTC until 2026-11-01 06:00Z, then 5 hours.
  put(
    claudeFile(w, "sess-a"),
    [
      claudeLine({ id: "a", at: "2026-10-31T23:50:00Z", input: 1, output: 10 }),
      claudeLine({ id: "b", at: "2026-11-01T03:59:00Z", input: 2, output: 20 }),
      claudeLine({ id: "c", at: "2026-11-01T04:00:00Z", input: 3, output: 30 }),
      claudeLine({ id: "d", at: "2026-11-01T05:30:00Z", input: 4, output: 40 }),
      claudeLine({ id: "e", at: "2026-11-01T06:30:00Z", input: 5, output: 50 }),
      claudeLine({ id: "f", at: "2026-11-02T04:59:00Z", input: 6, output: 60 }),
      claudeLine({ id: "g", at: "2026-11-02T05:00:00Z", input: 7, output: 70 }),
      claudeLine({ id: "h", at: "2026-11-03T08:00:00Z", model: "claude-opus-4-5", input: 11, cw5m: 8, cw1h: 9, cacheRead: 10, output: 80 }),
    ].join(""),
  );
  put(codexFile(w, "parent"), codexMeta("2026-11-03T08:00:00Z") + codexTurn("2026-11-03T08:00:01Z") + codexEvent("2026-11-03T08:01:00Z", 1));
  passOk(w);

  const rows = dayRows(w);
  assert.deepEqual(rows.dates(), ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-03"]);
  assert.deepEqual(columnsOn(rows, "2026-10-31", "claude"), [3, 0, 0, 0, 30]);
  // Local midnight is 04:00Z on Nov 1 and 05:00Z on Nov 2: the day holds 25 hours.
  assert.deepEqual(columnsOn(rows, "2026-11-01", "claude"), [18, 0, 0, 0, 180]);
  assert.deepEqual(columnsOn(rows, "2026-11-02", "claude"), [7, 0, 0, 0, 70]);
  assert.deepEqual(columnsOn(rows, "2026-11-03", "claude"), [11, 8, 9, 10, 80]);
  assert.deepEqual(columnsOn(rows, "2026-11-03", "codex"), [91, 0, 0, 10, 5]);
  assert.deepEqual(columnsOn(rows, "2026-11-01", "codex"), [0, 0, 0, 0, 0]);
  assert.deepEqual([...(rows.get("2026-11-03")?.models.keys() ?? [])].sort(), [
    "claude|claude-opus-4-5",
    "codex|gpt-5-codex",
  ]);

  const expected = daysFromBuckets(w, NEW_YORK);
  assert.deepEqual([...expected.keys()].sort(), rows.dates());
  for (const [date, byName] of expected) {
    const day = rows.get(date);
    assert.ok(day !== undefined, date);
    assert.deepEqual(day.claude, byName.get("claude|*") ?? [0, 0, 0, 0, 0], `${date} claude`);
    assert.deepEqual(day.codex, byName.get("codex|*") ?? [0, 0, 0, 0, 0], `${date} codex`);
    const models = new Map([...byName].filter(([name]) => !name.endsWith("|*")));
    assert.deepEqual(new Map(day.models), models, `${date} models`);
  }
});

test("a larger repeat replaces the counted columns, an earlier copy moves them to the earlier day", (t) => {
  const w = makeWorld(t);
  const file = claudeFile(w, "sess-a");
  put(
    file,
    claudeLine({ id: "x", at: "2026-11-02T05:30:00Z", input: 1, output: 10 }) +
      claudeLine({ id: "y", at: "2026-11-02T06:00:00Z", input: 100, output: 100 }),
  );
  passOk(w);
  assert.deepEqual(columnsOn(dayRows(w), "2026-11-02", "claude"), [101, 0, 0, 0, 110]);

  append(file, claudeLine({ id: "x", at: "2026-11-02T05:30:00Z", input: 1, output: 40 }));
  passOk(w);
  assert.deepEqual(columnsOn(dayRows(w), "2026-11-02", "claude"), [101, 0, 0, 0, 140]);

  // The copy is at 04:30Z, which is 23:30 on Nov 1 in New York.
  append(file, claudeLine({ id: "x", at: "2026-11-02T04:30:00Z", input: 1, output: 5 }));
  passOk(w);
  const rows = dayRows(w);
  assert.deepEqual(columnsOn(rows, "2026-11-01", "claude"), [1, 0, 0, 0, 40]);
  assert.deepEqual(columnsOn(rows, "2026-11-02", "claude"), [100, 0, 0, 0, 100]);
  const expected = daysFromBuckets(w, NEW_YORK);
  for (const date of rows.dates()) assert.deepEqual(columnsOn(rows, date, "claude"), expected.get(date)?.get("claude|*"), date);
});

test("a pass with no change leaves the days file as it was", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), claudeLine({ id: "a", at: "2026-11-03T08:00:00Z", input: 5, output: 6 }));
  passOk(w);
  const before = readFileSync(join(w.data, DAYS_FILE), "utf8");
  passOk(w);
  assert.equal(readFileSync(join(w.data, DAYS_FILE), "utf8"), before);
});

test("a day row older than the 400 day horizon is pruned, the oldest day inside it stays", (t) => {
  const w = makeWorld(t);
  // Today is 2026-11-03 in New York: the horizon holds 400 days, so it starts on 2025-09-30.
  const row = { claude: [1, 0, 0, 0, 1], codex: [0, 0, 0, 0, 0], models: {} };
  const body = { version: 1, backfilled: true, cutThrough: null, days: { "2025-09-29": row, "2025-09-30": row, "2026-10-30": row } };
  writeFileSync(join(w.data, DAYS_FILE), JSON.stringify(body), { mode: 0o600 });
  put(claudeFile(w, "sess-a"), claudeLine({ id: "a", at: "2026-11-03T08:00:00Z", input: 5, output: 6 }));
  passOk(w);
  assert.deepEqual(dayRows(w).dates(), ["2025-09-30", "2026-10-30", "2026-11-03"]);
});

// ---------------------------------------------------------------------------
// The backfill
// ---------------------------------------------------------------------------

function seedOldBuckets(w: World): void {
  const slot = slotOf(Date.parse("2026-08-10T10:00:00Z"));
  const key = bucketKey(slot, "claude", "claude-sonnet-5-5", PROJECT);
  const body = { version: 1, rows: { [key]: [1000, 0, 0, 0, 100] } };
  writeFileSync(join(w.data, bucketsFileName("2026-08")), JSON.stringify(body), { mode: 0o600 });
}

function seedOldLogs(w: World): void {
  put(
    claudeFile(w, "sess-old"),
    [
      // Before the first bucket row: counted.
      claudeLine({ id: "b1", at: "2026-08-05T10:00:00Z", input: 20, output: 2 }),
      // On a day that has bucket rows, after the first one: the buckets hold it.
      claudeLine({ id: "b2", at: "2026-08-10T12:00:00Z", input: 77, output: 7 }),
      // A day with no bucket row: counted once, with the largest output of the repeats.
      claudeLine({ id: "b3", at: "2026-09-10T10:00:00Z", input: 30, output: 3 }),
      claudeLine({ id: "b3", at: "2026-09-10T10:00:00Z", input: 30, output: 9 }),
      // Past the day horizon: not kept.
      claudeLine({ id: "b4", at: "2025-06-01T10:00:00Z", input: 55, output: 5 }),
      // Inside the 15 minute horizon: the normal scan counts it.
      claudeLine({ id: "n1", at: "2026-11-02T10:00:00Z", input: 40, output: 4 }),
    ].join(""),
  );
  put(claudeFile(w, "sess-copy", "-work-beta"), claudeLine({ id: "b3", at: "2026-09-10T10:00:00Z", input: 30, output: 5 }), NOW - 2 * HOUR_MS);
  put(
    codexFile(w, "old", "2026/09/10"),
    codexMeta("2026-09-10T11:00:00Z") + codexTurn("2026-09-10T11:00:01Z") + codexEvent("2026-09-10T11:00:02Z", 1),
  );
}

test("the first pass fills the day rows from the bucket files and from the logs before the horizon, once", (t) => {
  const w = makeWorld(t);
  seedOldBuckets(w);
  const bucketBody = readFileSync(join(w.data, bucketsFileName("2026-08")), "utf8");
  seedOldLogs(w);

  const first = passOk(w);
  assert.deepEqual(first.backfill, { ran: true, files: 3, rows: 3, cut: false });
  const rows = dayRows(w);
  assert.equal(rows.backfilled, true);
  assert.deepEqual(rows.dates(), ["2026-08-05", "2026-08-10", "2026-09-10", "2026-11-02"]);
  assert.deepEqual(columnsOn(rows, "2026-08-05", "claude"), [20, 0, 0, 0, 2]);
  assert.deepEqual(columnsOn(rows, "2026-08-10", "claude"), [1000, 0, 0, 0, 100]);
  assert.deepEqual(columnsOn(rows, "2026-09-10", "claude"), [30, 0, 0, 0, 9]);
  assert.deepEqual(columnsOn(rows, "2026-09-10", "codex"), [91, 0, 0, 10, 5]);
  assert.deepEqual(columnsOn(rows, "2026-11-02", "claude"), [40, 0, 0, 0, 4]);
  assert.equal(rows.get("2025-06-01"), undefined);

  // The backfill touches no 15 minute row: the old bucket file is as it was and no file for September exists.
  assert.equal(readFileSync(join(w.data, bucketsFileName("2026-08")), "utf8"), bucketBody);
  assert.equal([...must(loadBucketMonth(w.data, "2026-09", DEPS))].length, 0);

  // A second pass does not run it again, also for a new old line.
  append(claudeFile(w, "sess-old"), claudeLine({ id: "b5", at: "2026-09-12T10:00:00Z", input: 9, output: 9 }));
  const second = passOk(w);
  assert.deepEqual(second.backfill, { ran: false, files: 0, rows: 0, cut: false });
  assert.deepEqual(dayRows(w).dates(), ["2026-08-05", "2026-08-10", "2026-09-10", "2026-11-02"]);
});

for (const rebuild of [false, true]) {
  test(`proxy backfill counts only the uncovered date ${rebuild ? "after days.json is deleted" : "on the first pass"}`, (t) => {
    const w = makeWorld(t);
    seedOldBuckets(w);
    if (rebuild) {
      passOk(w);
      rmSync(join(w.data, DAYS_FILE));
    }
    put(
      claudeFile(w, "proxy"),
      proxyLine("before-first-slot", "2026-08-10T09:00:00Z", 20) +
        proxyLine("covered", "2026-08-10T12:00:00Z", 50) +
        proxyLine("uncovered", "2026-09-10T10:00:00Z", 10) +
        proxyLine("uncovered", "2026-09-10T10:01:00Z", 30),
    );

    const first = passOk(w);
    const rows = dayRows(w);
    assert.deepEqual(first.backfill, { ran: true, files: 1, rows: 1, cut: false });
    assert.deepEqual(columnsOn(rows, "2026-08-10", "codex"), [0, 0, 0, 0, 0]);
    assert.deepEqual(columnsOn(rows, "2026-08-10", "claude"), [1000, 0, 0, 0, 100]);
    assert.deepEqual(columnsOn(rows, "2026-09-10", "codex"), [100, 0, 0, 30, 30]);
    assert.deepEqual(columnsOn(rows, "2026-09-10", "claude"), [0, 0, 0, 0, 0]);

    assert.equal(passOk(w).backfill.ran, false);
    assert.deepEqual(columnsOn(dayRows(w), "2026-09-10", "codex"), [100, 0, 0, 30, 30]);
  });
}

test("a folder with no source file gets an empty days file and the backfill is marked done", (t) => {
  const w = makeWorld(t);
  const first = passOk(w);
  assert.deepEqual(first.backfill, { ran: true, files: 0, rows: 0, cut: false });
  const body = JSON.parse(readFileSync(join(w.data, DAYS_FILE), "utf8")) as unknown;
  assert.deepEqual(body, { version: 1, backfilled: true, cutThrough: null, days: {} });
  assert.equal(passOk(w).backfill.ran, false);
});

test("a listing that stopped early cuts the backfill and says so", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), claudeLine({ id: "a", at: "2026-09-10T10:00:00Z", input: 1, output: 1 }));
  put(claudeFile(w, "sess-b"), claudeLine({ id: "b", at: "2026-09-11T10:00:00Z", input: 2, output: 2 }));
  const report = passOk(w, { maxFilesPerPass: 1 });
  assert.equal(report.backfill.ran, true);
  assert.equal(report.backfill.cut, true);
  const rows = dayRows(w);
  assert.equal(rows.backfilled, true);
  // The 15 minute horizon starts at 2026-10-25T00:00Z, which is 20:00 on 2026-10-24 in New York.
  assert.equal(rows.cutThrough, "2026-10-24");
});

// ---------------------------------------------------------------------------
// The limits and the order of the backfill
// ---------------------------------------------------------------------------

test("the backfill reads the files that hold only old lines first, so a byte limit spares them", (t) => {
  const w = makeWorld(t);
  const old = claudeFile(w, "sess-old");
  put(old, claudeLine({ id: "o", at: "2026-09-10T10:00:00Z", input: 30, output: 3 }), NOW - 20 * DAY_MS);
  // A newer file, mostly lines of the 15 minute horizon. It is bigger than the limit.
  put(
    claudeFile(w, "sess-live", "-work-beta"),
    claudeLine({ id: "live1", at: "2026-09-11T10:00:00Z", input: 1, output: 1 }) +
      claudeLine({ id: "live2", at: "2026-11-02T10:00:00Z", input: 40, output: 4 }),
  );

  const report = passOk(w, { maxBackfillBytes: statSync(old).size });

  assert.deepEqual(report.backfill, { ran: true, files: 1, rows: 1, cut: true });
  const rows = dayRows(w);
  assert.deepEqual(columnsOn(rows, "2026-09-10", "claude"), [30, 0, 0, 0, 3]);
  assert.deepEqual(columnsOn(rows, "2026-11-02", "claude"), [40, 0, 0, 0, 4]);
  assert.equal(rows.cutThrough, "2026-10-24");
});

test("the backfill ends between files when its time limit has passed, and says it was cut", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), claudeLine({ id: "a", at: "2026-09-10T10:00:00Z", input: 1, output: 1 }), NOW - 20 * DAY_MS);
  put(claudeFile(w, "sess-b"), claudeLine({ id: "b", at: "2026-09-09T10:00:00Z", input: 2, output: 2 }), NOW - 21 * DAY_MS);

  const report = must(collect(inputOf(w, { maxBackfillMs: 1000 }), jumpDeps(NOW, NOW + 5000)));

  assert.deepEqual(report.backfill, { ran: true, files: 1, rows: 1, cut: true });
  assert.deepEqual(dayRows(w).dates(), ["2026-09-10"]);
});

test("the backfill holds at most the key limit of messages, and says it was cut", (t) => {
  const w = makeWorld(t);
  put(
    claudeFile(w, "sess-a"),
    [
      claudeLine({ id: "a", at: "2026-09-10T10:00:00Z", input: 1, output: 1 }),
      claudeLine({ id: "b", at: "2026-09-11T10:00:00Z", input: 2, output: 2 }),
      claudeLine({ id: "c", at: "2026-09-12T10:00:00Z", input: 3, output: 3 }),
      // A repeat of a held message needs no room.
      claudeLine({ id: "a", at: "2026-09-10T10:00:00Z", input: 1, output: 9 }),
    ].join(""),
    NOW - 20 * DAY_MS,
  );

  const report = passOk(w, { maxBackfillKeys: 2 });

  assert.deepEqual(report.backfill, { ran: true, files: 1, rows: 2, cut: true });
  assert.deepEqual(columnsOn(dayRows(w), "2026-09-10", "claude"), [1, 0, 0, 0, 9]);
  assert.deepEqual(dayRows(w).dates(), ["2026-09-10", "2026-09-11"]);
});

test("a Codex file in a folder more than a day after the horizon day is not read by the backfill", (t) => {
  const w = makeWorld(t);
  // The horizon day is 2026-10-25: folder 10/26 is read, folder 10/27 is not.
  put(
    codexFile(w, "near", "2026/10/26"),
    codexMeta("2026-10-26T00:30:00Z") + codexTurn("2026-10-26T00:30:01Z") + codexEvent("2026-10-24T23:00:00Z", 1),
  );
  put(
    codexFile(w, "far", "2026/10/27"),
    codexMeta("2026-10-27T10:00:00Z") + codexTurn("2026-10-27T10:00:01Z") + codexEvent("2026-10-27T10:00:02Z", 2),
  );

  const report = passOk(w);

  assert.equal(report.backfill.files, 1);
  assert.equal(report.backfill.rows, 1);
  assert.deepEqual(dayRows(w).dates(), ["2026-10-24", "2026-10-27"]);
});

test("the rows of the backfill count a Codex event that has no key", (t) => {
  const w = makeWorld(t);
  put(
    codexFile(w, "old", "2026/09/10"),
    codexMeta("2026-09-10T11:00:00Z") +
      codexTurn("2026-09-10T11:00:01Z") +
      codexKeyless("2026-09-10T11:00:02Z") +
      codexEvent("2026-09-10T11:00:03Z", 1),
  );

  const report = passOk(w);

  assert.deepEqual(report.backfill, { ran: true, files: 1, rows: 2, cut: false });
  // Input is 90 for the event with no key and 91 for the other, cache read 10 each.
  assert.deepEqual(columnsOn(dayRows(w), "2026-09-10", "codex"), [181, 0, 0, 20, 10]);
});

test("a local day that the 15 minute horizon splits holds the old part from the logs and the rest from the scan", (t) => {
  const w = makeWorld(t);
  // The horizon is 2026-10-25T00:00Z. New York is on summer time then: its day
  // 2026-10-24 runs from 04:00Z to 04:00Z, so the horizon is at 20:00 on that day.
  put(
    claudeFile(w, "sess-a"),
    [
      claudeLine({ id: "before", at: "2026-10-24T15:00:00Z", input: 7, output: 70 }),
      claudeLine({ id: "after", at: "2026-10-25T02:00:00Z", input: 3, output: 30 }),
      claudeLine({ id: "next", at: "2026-10-25T05:00:00Z", input: 5, output: 50 }),
    ].join(""),
  );

  const report = passOk(w);

  assert.deepEqual(report.backfill, { ran: true, files: 1, rows: 1, cut: false });
  const rows = dayRows(w);
  assert.deepEqual(rows.dates(), ["2026-10-24", "2026-10-25"]);
  assert.deepEqual(columnsOn(rows, "2026-10-24", "claude"), [10, 0, 0, 0, 100]);
  assert.deepEqual(columnsOn(rows, "2026-10-25", "claude"), [5, 0, 0, 0, 50]);
  // Run again: nothing is counted twice.
  passOk(w);
  assert.deepEqual(columnsOn(dayRows(w), "2026-10-24", "claude"), [10, 0, 0, 0, 100]);
});

test("a Codex key that the dedupe days of the horizon hold is not counted again from an older copy", (t) => {
  const w = makeWorld(t);
  put(codexFile(w, "resume"), codexMeta("2026-11-03T08:00:00Z") + codexTurn("2026-11-03T08:00:01Z") + codexEvent("2026-11-03T08:01:00Z", 1));
  passOk(w);
  // The days file is lost. The same event is in an old file, with an old time.
  rmSync(join(w.data, DAYS_FILE));
  put(
    codexFile(w, "origin", "2026/09/10"),
    codexMeta("2026-09-10T11:00:00Z") + codexTurn("2026-09-10T11:00:01Z") + codexEvent("2026-09-10T11:00:02Z", 1),
  );

  const report = passOk(w);

  assert.equal(report.backfill.ran, true);
  assert.equal(report.backfill.rows, 0);
  const rows = dayRows(w);
  assert.deepEqual(rows.dates(), ["2026-11-03"]);
  assert.deepEqual(columnsOn(rows, "2026-11-03", "codex"), [91, 0, 0, 10, 5]);
});

test("a damaged bucket file of a month before the horizon is skipped, and the backfill is marked as cut", (t) => {
  const w = makeWorld(t);
  const damaged = join(w.data, bucketsFileName("2026-08"));
  writeFileSync(damaged, "{not json", { mode: 0o600 });
  put(claudeFile(w, "sess-old"), claudeLine({ id: "b1", at: "2026-08-05T10:00:00Z", input: 20, output: 2 }));

  const report = passOk(w);

  assert.deepEqual(report.backfill, { ran: true, files: 1, rows: 1, cut: true });
  const rows = dayRows(w);
  assert.deepEqual(columnsOn(rows, "2026-08-05", "claude"), [20, 0, 0, 0, 2]);
  assert.equal(rows.cutThrough, "2026-10-24");
  assert.equal(readFileSync(damaged, "utf8"), "{not json");
  // The mark is kept: the next pass does not run the backfill again.
  assert.equal(passOk(w).backfill.ran, false);
});

test("a damaged bucket file inside the horizon stops the first pass with store_corrupt and writes no days file", (t) => {
  const w = makeWorld(t);
  writeFileSync(join(w.data, bucketsFileName("2026-10")), "{not json", { mode: 0o600 });

  const error = mustFail(collect(inputOf(w), DEPS));

  assert.equal(error.code, "store_corrupt");
  assert.throws(() => readFileSync(join(w.data, DAYS_FILE)));
});

for (const patch of [{ maxBackfillBytes: 0 }, { maxBackfillMs: 1.5 }, { maxBackfillKeys: -1 }] as const) {
  test(`a backfill limit that is not a whole number of at least 1 is refused: ${JSON.stringify(patch)}`, (t) => {
    const w = makeWorld(t);
    assert.deepEqual(mustFail(collect(inputOf(w, patch), DEPS)), { code: "internal_error", file: null });
  });
}

test("a line written while the backfill ran is counted by the normal scan, not refused as a future time", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-old"), claudeLine({ id: "old", at: "2026-09-10T10:00:00Z", input: 30, output: 3 }));
  // The line is 100 s after the start of the pass. The backfill took 90 s, so the
  // line was written before the normal scan began.
  put(claudeFile(w, "sess-live", "-work-beta"), claudeLine({ id: "live", at: "2026-11-03T12:01:40Z", input: 5, output: 6 }));
  const report = must(collect(inputOf(w), jumpDeps(NOW, NOW + 90_000)));

  assert.equal(report.backfill.ran, true);
  assert.equal(report.rows.counted, 1);
  assert.equal(report.rows.skipped["bad_time"], undefined);
  assert.deepEqual(columnsOn(dayRows(w), "2026-11-03", "claude"), [5, 0, 0, 0, 6]);
});

// ---------------------------------------------------------------------------
// DayRows
// ---------------------------------------------------------------------------

test("a removal larger than what a day holds stops at 0, and an empty day has no row", () => {
  const rows = new DayRows(true);
  rows.add("2026-11-03", "claude", "m", [1, 2, 3, 4, 5], 1);
  rows.add("2026-11-03", "claude", "m", [9, 0, 0, 0, 0], -1);
  assert.deepEqual(rows.get("2026-11-03")?.claude, [0, 2, 3, 4, 5]);
  rows.add("2026-11-03", "claude", "m", [0, 2, 3, 4, 5], -1);
  assert.equal(rows.get("2026-11-03"), undefined);
  rows.add("2026-11-04", "codex", "m", [1, 0, 0, 0, 0], -1);
  assert.deepEqual(rows.dates(), []);
});

function manyModels(count: number, tokens: (index: number) => number): DayRows {
  const rows = new DayRows(true);
  for (let index = 0; index < count; index += 1) {
    rows.add("2026-11-03", "claude", `m${String(index).padStart(2, "0")}`, [0, 0, 0, 0, tokens(index)], 1);
  }
  return rows;
}

function modelNamesOf(rows: DayRows): string[] {
  const body = rows.toJson() as { days: Record<string, { models: Record<string, unknown> }> };
  return Object.keys(body.days["2026-11-03"]?.models ?? {}).map((key) => key.slice("claude|".length));
}

test("a day row keeps the 40 models with the most weighted tokens, and the provider total keeps all", () => {
  const rows = manyModels(45, (index) => index + 1);
  const names = modelNamesOf(rows);
  assert.equal(names.length, DAYS_MAX_MODELS);
  assert.equal(names.includes("m04"), false);
  assert.equal(names.includes("m05"), true);
  assert.equal(rows.get("2026-11-03")?.claude[4], (45 * 46) / 2);
});

test("models with equal tokens are cut in text order of their name", () => {
  const names = modelNamesOf(manyModels(41, () => 7));
  assert.equal(names.length, DAYS_MAX_MODELS);
  assert.equal(names.includes("m39"), true);
  assert.equal(names.includes("m40"), false);
});

test("the days file reads back as it was written", (t) => {
  const w = makeWorld(t);
  const rows = new DayRows(true);
  rows.add("2026-11-02", "claude", "claude-sonnet-5-5", [1, 2, 3, 4, 5], 1);
  rows.add("2026-11-02", "codex", "gpt-5-codex", [6, 0, 0, 7, 8], 1);
  writeFileSync(join(w.data, DAYS_FILE), JSON.stringify(rows.toJson()), { mode: 0o600 });
  const back = dayRows(w);
  assert.equal(back.backfilled, true);
  assert.deepEqual(back.dates(), ["2026-11-02"]);
  assert.deepEqual(back.get("2026-11-02")?.claude, [1, 2, 3, 4, 5]);
  assert.deepEqual(back.get("2026-11-02")?.codex, [6, 0, 0, 7, 8]);
  assert.deepEqual([...(back.get("2026-11-02")?.models ?? [])], [
    ["claude|claude-sonnet-5-5", [1, 2, 3, 4, 5]],
    ["codex|gpt-5-codex", [6, 0, 0, 7, 8]],
  ]);
});

test("a missing days file reads as no rows and no backfill done", (t) => {
  const w = makeWorld(t);
  const rows = dayRows(w);
  assert.equal(rows.backfilled, false);
  assert.deepEqual(rows.dates(), []);
});

const GOOD_ROW = { claude: [0, 0, 0, 0, 1], codex: [0, 0, 0, 0, 0], models: {} };
const FILE = { version: 1, backfilled: true, cutThrough: null };
const BAD_BODIES: readonly (readonly [string, unknown])[] = [
  ["a date that is not a day", { ...FILE, days: { "2026-02-30": GOOD_ROW } }],
  ["a date with extra text", { ...FILE, days: { "2026-02-03x": GOOD_ROW } }],
  ["a row with four columns", { ...FILE, days: { "2026-02-03": { ...GOOD_ROW, claude: [1, 2, 3, 4] } } }],
  ["a negative count", { ...FILE, days: { "2026-02-03": { ...GOOD_ROW, claude: [0, 0, 0, 0, -1] } } }],
  ["a count with a fraction", { ...FILE, days: { "2026-02-03": { ...GOOD_ROW, codex: [0, 0, 0, 0, 1.5] } } }],
  ["a model key without a provider", { ...FILE, days: { "2026-02-03": { ...GOOD_ROW, models: { "other|m": [0, 0, 0, 0, 1] } } } }],
  ["a model key that is __proto__", { ...FILE, days: { "2026-02-03": { ...GOOD_ROW, models: JSON.parse('{"__proto__":[0,0,0,0,1]}') } } }],
  ["41 models in a day", { ...FILE, days: { "2026-02-03": { ...GOOD_ROW, models: Object.fromEntries(Array.from({ length: 41 }, (_, index) => [`claude|m${index}`, [0, 0, 0, 0, 1]])) } } }],
  ["a backfilled mark that is not a boolean", { ...FILE, backfilled: 1, days: {} }],
  ["a days list", { ...FILE, days: [] }],
  ["no cut mark", { version: 1, backfilled: true, days: {} }],
  ["a cut mark that is not a day", { ...FILE, cutThrough: "2026-02-30", days: {} }],
  ["a cut mark that is not text", { ...FILE, cutThrough: 20260203, days: {} }],
  ["a cut mark before the backfill ran", { ...FILE, backfilled: false, cutThrough: "2026-02-03", days: {} }],
];

for (const [name, body] of BAD_BODIES) {
  test(`the days file with ${name} is refused as store_corrupt`, (t) => {
    const w = makeWorld(t);
    writeFileSync(join(w.data, DAYS_FILE), JSON.stringify(body), { mode: 0o600 });
    const error = mustFail(loadDayRows(w.data, DEPS));
    assert.deepEqual(error, { code: "store_corrupt", file: DAYS_FILE });
  });
}
