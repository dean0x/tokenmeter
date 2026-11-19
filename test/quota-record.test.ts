// Tests for the quota samples, the record pass-through and the bin shim
// (plan 3.1, 3.8, section 6). TP-15, and the record side of TP-1.
//
// Every data folder, source and write is inside a sandbox. Child processes get
// the sandbox env (HOME, XDG_STATE_HOME, TOKENMETER_DATA_DIR, TMPDIR). The
// in-process tests use a fixed clock. The child tests use the real clock, so
// their reset times are relative to the real now.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { errorRecord, SCHEMA_ID, type Result } from "../src/core.ts";
import { collect } from "../src/collect.ts";
import { type FsDeps, defaultDeps, prepareDataDir } from "../src/fsafe.ts";
import {
  QUOTA_LATEST_FILE,
  QUOTA_LATEST_REFRESH_MS,
  QUOTA_MONTH_CAP_BYTES,
  QUOTA_MONTH_READ_CAP_BYTES,
  type QuotaSample,
  type StatuslineQuota,
  parseStatusline,
  pickLatestSample,
  quotaMonthFile,
  readCodexLatest,
  readLatestQuota,
  readObservations,
  readQuotaSamples,
  recordStatuslineQuota,
  sampleLine,
  storeAppServerReading,
  storeCodexQuota,
} from "../src/quota.ts";
import { RECORD_COPY_CAP_BYTES, RECORD_DEADLINE_MS, type RecordIo, runRecord } from "../src/record.ts";
import { type Sandbox, assertGuarded, installSuiteGuard, makeSandbox } from "./helpers.ts";
import { TIMING_RUNS, judgeTiming, measurePaired, writeBaselineScript } from "./timing.ts";

installSuiteGuard();

const NOW = Date.parse("2026-11-03T12:00:00Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KIB = 1024;
const MIB = 1024 * KIB;
const FIXTURES = join(import.meta.dirname, "fixtures");
const BIN = join(import.meta.dirname, "..", "bin", "tokenmeter.js");
const CANARY = "CANARY-7f3a9c41";
const BASE_DEPS: FsDeps = defaultDeps();

const FIVE_RESET_MS = NOW + 2 * HOUR_MS;
const WEEK_RESET_MS = NOW + 3 * DAY_MS;

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

interface LimitSpec {
  readonly pct: unknown;
  readonly reset: unknown;
}

interface StatusSpec {
  readonly five?: LimitSpec | null;
  readonly week?: LimitSpec | null;
  readonly padding?: number;
}

// A statusline JSON with a canary in every field that is not a rate limit.
function statusJson(spec: StatusSpec = {}, nowMs: number = NOW): string {
  const five = spec.five === undefined ? { pct: 12.5, reset: (nowMs + 2 * HOUR_MS) / 1000 } : spec.five;
  const week = spec.week === undefined ? { pct: 40, reset: (nowMs + 3 * DAY_MS) / 1000 } : spec.week;
  const rate: Record<string, unknown> = { plan_label: CANARY };
  if (five !== null) rate["five_hour"] = { used_percentage: five.pct, resets_at: five.reset, note: CANARY };
  if (week !== null) rate["seven_day"] = { used_percentage: week.pct, resets_at: week.reset, note: CANARY };
  const body: Record<string, unknown> = {
    session_id: `sess-${CANARY}`,
    transcript_path: `/home/${CANARY}/t.jsonl`,
    cwd: `/work/${CANARY}`,
    model: { id: `m-${CANARY}`, display_name: `Model ${CANARY}` },
    workspace: { current_dir: `/w/${CANARY}`, project_dir: `/p/${CANARY}` },
    version: `1.${CANARY}`,
    output_style: { name: `style ${CANARY}` },
    cost: { total_cost_usd: 1.25, note: CANARY },
    rate_limits: rate,
  };
  if (spec.padding !== undefined) body["padding"] = "p".repeat(spec.padding);
  return JSON.stringify(body);
}

function rawPoint(pct: number, resetsAt: number): { usedPercent: number; resetsAt: number } {
  return { usedPercent: pct, resetsAt };
}

const ABSENT = { reason: "absent" } as const;

// A null point stands for a window that the statusline did not carry.
function quotaOf(five: ReturnType<typeof rawPoint> | null, week: ReturnType<typeof rawPoint> | null): StatuslineQuota {
  return { five_hour: five ?? ABSENT, week: week ?? ABSENT };
}

interface World {
  readonly sb: Sandbox;
  readonly dir: string;
}

function makeWorld(t: TestContext): World {
  const sb = makeSandbox(t);
  return { sb, dir: must(prepareDataDir(sb.dataDir, BASE_DEPS)) };
}

function readText(path: string): string {
  assertGuarded(path);
  return readFileSync(path, "utf8");
}

function linesOf(path: string): readonly string[] {
  return existsSync(path) ? readText(path).split("\n").filter((line) => line !== "") : [];
}

function modeOf(path: string): number {
  return lstatSync(path).mode & 0o777;
}

function writeLatest(w: World, body: unknown, mode: number = 0o600): string {
  const path = join(w.dir, QUOTA_LATEST_FILE);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body), { mode });
  chmodSync(path, mode);
  return path;
}

function latestBody(five: object | null, week: object | null): object {
  return { version: 1, claude: { five_hour: five, week } };
}

function storedPoint(pct: number, resetsAt: number, at: number): object {
  return { usedPercent: pct, resetsAt, at };
}

function allFiles(root: string): readonly string[] {
  const out: string[] = [];
  const pending: string[] = [root];
  for (let i = 0; i < 1000 && pending.length > 0; i += 1) {
    const dir = pending.pop();
    if (dir === undefined) break;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (lstatSync(path).isDirectory()) pending.push(path);
      else out.push(path);
    }
  }
  return out;
}

// --- in-process record ---

function recordIo(sb: Sandbox, stdin: PassThrough, stdout: Writable, patch: Partial<RecordIo> = {}): RecordIo {
  return {
    stdin,
    stdout,
    env: { TOKENMETER_DATA_DIR: sb.dataDir },
    platform: process.platform,
    homeDir: sb.home,
    deps: { ...BASE_DEPS, nowMs: () => NOW },
    deadlineMs: RECORD_DEADLINE_MS,
    ...patch,
  };
}

function collector(): { readonly out: Buffer[]; readonly sink: Writable } {
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      out.push(chunk);
      callback();
    },
  });
  return { out, sink };
}

async function recordWith(
  sb: Sandbox,
  chunks: readonly (Buffer | string)[],
  patch: Partial<RecordIo> = {},
): Promise<Buffer> {
  const stdin = new PassThrough();
  const { out, sink } = collector();
  const done = runRecord(recordIo(sb, stdin, sink, patch));
  for (const chunk of chunks) stdin.write(chunk);
  stdin.end();
  await done;
  return Buffer.concat(out);
}

// --- child process ---

interface RunResult {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number | null;
  readonly ms: number;
}

function runBin(
  args: readonly string[],
  input: Buffer | string,
  env: Readonly<Record<string, string>>,
  bin: string = BIN,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    const child = spawn(bin, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errs.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(errs).toString("utf8"),
        code,
        ms: performance.now() - start,
      });
    });
    child.stdin.end(input);
  });
}

// Reset times for the child tests: the child reads the real clock. They are
// fixed once per run, as in a real statusline, so a repeat is not a change.
const REAL_START = Date.now();
const REAL_FIVE_RESET_S = Math.round((REAL_START + 2 * HOUR_MS) / 1000);
const REAL_WEEK_RESET_S = Math.round((REAL_START + 3 * DAY_MS) / 1000);

function realStatus(spec: { five?: number; week?: number } = {}): string {
  return statusJson({
    five: { pct: spec.five ?? 12.5, reset: REAL_FIVE_RESET_S },
    week: { pct: spec.week ?? 40, reset: REAL_WEEK_RESET_S },
  });
}

function sampleFiles(dir: string): readonly string[] {
  return readdirSync(dir).filter((name) => /^quota-\d{4}-\d{2}\.jsonl$/.test(name)).sort();
}

function patternBytes(length: number): Buffer {
  const out = Buffer.allocUnsafe(length);
  let state = 12345;
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    out[i] = (state >>> 16) & 0xff;
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseStatusline
// ---------------------------------------------------------------------------

test("parse: reads the five hour and seven day limits, seconds or milliseconds", () => {
  const seconds = must(parseStatusline(statusJson(), NOW));
  assert.deepEqual(seconds, quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)));
  const millis = must(
    parseStatusline(statusJson({ five: { pct: 12.5, reset: FIVE_RESET_MS }, week: { pct: 40, reset: WEEK_RESET_MS } }), NOW),
  );
  assert.deepEqual(millis, seconds);
});

test("parse: copies only the two fields of each limit", () => {
  const parsed = must(parseStatusline(statusJson(), NOW));
  assert.deepEqual(Object.keys(parsed).sort(), ["five_hour", "week"]);
  assert.deepEqual(Object.keys(parsed.five_hour ?? {}).sort(), ["resetsAt", "usedPercent"]);
  assert.equal(JSON.stringify(parsed).includes(CANARY), false);
});

test("parse: a missing limit has the reason absent and the other one stays", () => {
  const onlyWeek = must(parseStatusline(statusJson({ five: null }), NOW));
  assert.deepEqual(onlyWeek.five_hour, ABSENT);
  assert.deepEqual(onlyWeek.week, rawPoint(40, WEEK_RESET_MS));
  const neither = must(parseStatusline(statusJson({ five: null, week: null }), NOW));
  assert.deepEqual(neither, quotaOf(null, null));
  const noLimits = must(parseStatusline(JSON.stringify({ model: { id: "x" } }), NOW));
  assert.deepEqual(noLimits, quotaOf(null, null));
});

test("parse: a percent outside 0 to 100 or not a number gives bad_percent for that limit", () => {
  const goodReset = (NOW + HOUR_MS) / 1000;
  for (const pct of [-0.1, 100.1, 1000, "50", null, true, Number.NaN, [1]]) {
    const parsed = must(parseStatusline(statusJson({ five: { pct, reset: goodReset } }), NOW));
    assert.deepEqual(parsed.five_hour, { reason: "bad_percent" }, `pct ${JSON.stringify(pct)}`);
    assert.equal("reason" in parsed.week, false);
  }
  const edges = must(
    parseStatusline(statusJson({ five: { pct: 0, reset: goodReset }, week: { pct: 100, reset: goodReset } }), NOW),
  );
  assert.deepEqual(edges.five_hour, rawPoint(0, goodReset * 1000));
  assert.deepEqual(edges.week, rawPoint(100, goodReset * 1000));
});

test("parse: a reset time must be in (now, now + 8 days]", () => {
  const cases: readonly [string, unknown, boolean][] = [
    ["now", NOW / 1000, false],
    ["one second before now", (NOW - 1000) / 1000, false],
    ["one second after now", (NOW + 1000) / 1000, true],
    ["exactly 8 days", (NOW + 8 * DAY_MS) / 1000, true],
    ["just past 8 days", (NOW + 8 * DAY_MS + 1000) / 1000, false],
    ["zero", 0, false],
    ["negative", -5, false],
    ["a string", String((NOW + HOUR_MS) / 1000), false],
    ["null", null, false],
    ["infinity", Number.POSITIVE_INFINITY, false],
  ];
  for (const [name, reset, expected] of cases) {
    const parsed = must(parseStatusline(statusJson({ five: { pct: 10, reset } }), NOW));
    assert.equal(!("reason" in parsed.five_hour), expected, name);
    if (!expected) assert.deepEqual(parsed.five_hour, { reason: "bad_reset" }, name);
  }
});

test("parse: text that is not a JSON object gives bad_json", () => {
  for (const text of ["", "not json", "[1,2]", "42", "null", '"str"', '{"a":', "\u0000\u0001"]) {
    assert.equal(mustFail(parseStatusline(text, NOW)), "bad_json", JSON.stringify(text));
  }
});

// ---------------------------------------------------------------------------
// Sample lines
// ---------------------------------------------------------------------------

test("sample line: fixed keys, one line, and it reads back", (t) => {
  const w = makeWorld(t);
  const sample: QuotaSample = { provider: "claude", window: "five_hour", at: NOW, usedPercent: 12.5, resetsAt: FIVE_RESET_MS };
  const line = sampleLine(sample);
  assert.equal(line.includes("\n"), false);
  assert.deepEqual(Object.keys(JSON.parse(line) as object), ["p", "w", "at", "pct", "reset"]);
  writeFileSync(join(w.dir, quotaMonthFile(NOW)), `${line}\n`, { mode: 0o600 });
  assert.deepEqual(readQuotaSamples(w.dir, ["2026-11"], NOW + MINUTE_MS), [sample]);
});

test("sample file name: the UTC month of the sample time", () => {
  assert.equal(quotaMonthFile(Date.parse("2026-11-30T23:59:59Z")), "quota-2026-11.jsonl");
  assert.equal(quotaMonthFile(Date.parse("2026-12-01T00:00:00Z")), "quota-2026-12.jsonl");
  assert.equal(quotaMonthFile(Date.parse("2026-01-01T00:00:00Z")), "quota-2026-01.jsonl");
});

test("read samples: bad lines and out of range lines are skipped, good ones kept", (t) => {
  const w = makeWorld(t);
  const good = sampleLine({ provider: "codex", window: "week", at: NOW - HOUR_MS, usedPercent: 30, resetsAt: WEEK_RESET_MS });
  const lines = [
    "not json",
    '{"p":"claude"}',
    good,
    sampleLine({ provider: "claude", window: "week", at: NOW - HOUR_MS, usedPercent: 101, resetsAt: WEEK_RESET_MS }),
    sampleLine({ provider: "claude", window: "week", at: NOW - HOUR_MS, usedPercent: 10, resetsAt: NOW - 2 * HOUR_MS }),
    sampleLine({ provider: "claude", window: "week", at: NOW + HOUR_MS, usedPercent: 10, resetsAt: WEEK_RESET_MS }),
    sampleLine({ provider: "claude", window: "week", at: NOW - HOUR_MS, usedPercent: 10, resetsAt: NOW + 20 * DAY_MS }),
    JSON.stringify({ p: "other", w: "week", at: NOW - HOUR_MS, pct: 10, reset: WEEK_RESET_MS }),
    JSON.stringify({ p: "claude", w: "month", at: NOW - HOUR_MS, pct: 10, reset: WEEK_RESET_MS }),
  ];
  writeFileSync(join(w.dir, quotaMonthFile(NOW)), `${lines.join("\n")}\n`, { mode: 0o600 });
  const samples = readQuotaSamples(w.dir, ["2026-11"], NOW);
  assert.equal(samples.length, 1);
  assert.equal(samples[0]?.provider, "codex");
});

test("read samples: a missing, unsafe or over-cap month file gives no samples", (t) => {
  const w = makeWorld(t);
  assert.deepEqual(readQuotaSamples(w.dir, ["2026-11", "2026-10"], NOW), []);
  const path = join(w.dir, quotaMonthFile(NOW));
  const line = sampleLine({ provider: "claude", window: "week", at: NOW - HOUR_MS, usedPercent: 30, resetsAt: WEEK_RESET_MS });
  writeFileSync(path, `${line}\n`, { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.deepEqual(readQuotaSamples(w.dir, ["2026-11"], NOW), [], "group readable file");
  chmodSync(path, 0o600);
  assert.equal(readQuotaSamples(w.dir, ["2026-11"], NOW).length, 1);
  assert.deepEqual(readQuotaSamples(w.dir, ["2026-11"], NOW, { ...BASE_DEPS, uid: BASE_DEPS.uid + 1 }), [], "foreign owner");
  writeFileSync(path, `${line}\n${"x".repeat(QUOTA_MONTH_READ_CAP_BYTES)}`, { mode: 0o600 });
  assert.deepEqual(readQuotaSamples(w.dir, ["2026-11"], NOW), [], "over the read cap");
  assert.deepEqual(readQuotaSamples(w.dir, ["../etc", "2026-13", "x"], NOW), [], "bad month names");
});

// Lines of one valid sample, as many as it takes to pass `bytes`.
function monthTextOver(bytes: number): { readonly text: string; readonly count: number } {
  const line = `${sampleLine(mk("claude", "week", NOW - HOUR_MS, 30, WEEK_RESET_MS))}\n`;
  const count = Math.ceil((bytes + 1) / Buffer.byteLength(line, "utf8"));
  return { text: line.repeat(count), count };
}

test("read samples: a month file a little over the write cap is still read", (t) => {
  const w = makeWorld(t);
  const path = join(w.dir, quotaMonthFile(NOW));
  const { text, count } = monthTextOver(QUOTA_MONTH_CAP_BYTES);
  writeFileSync(path, text, { mode: 0o600 });
  assert.ok(statSync(path).size > QUOTA_MONTH_CAP_BYTES, "the file is over the write cap");
  assert.ok(statSync(path).size < QUOTA_MONTH_READ_CAP_BYTES);
  assert.equal(readQuotaSamples(w.dir, ["2026-11"], NOW).length, count);
});

test("read cap: the margin over the write cap is 64 KiB", () => {
  assert.equal(QUOTA_MONTH_READ_CAP_BYTES, QUOTA_MONTH_CAP_BYTES + 64 * KIB);
});

// ---------------------------------------------------------------------------
// Writer: samples on a change, latest on a change or at 60 s
// ---------------------------------------------------------------------------

test("writer: the first sample writes one line per limit and the latest file", (t) => {
  const w = makeWorld(t);
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  assert.deepEqual(report, { appended: 2, skipped: 0, full: 0, latestWritten: true });
  const month = join(w.dir, "quota-2026-11.jsonl");
  assert.deepEqual(linesOf(month).map((l) => JSON.parse(l) as unknown), [
    { p: "claude", w: "five_hour", at: NOW, pct: 12.5, reset: FIVE_RESET_MS },
    { p: "claude", w: "week", at: NOW, pct: 40, reset: WEEK_RESET_MS },
  ]);
  assert.deepEqual(JSON.parse(readText(join(w.dir, QUOTA_LATEST_FILE))), {
    version: 1,
    claude: {
      five_hour: { usedPercent: 12.5, resetsAt: FIVE_RESET_MS, at: NOW },
      week: { usedPercent: 40, resetsAt: WEEK_RESET_MS, at: NOW },
    },
  });
  assert.equal(modeOf(month), 0o600);
  assert.equal(modeOf(join(w.dir, QUOTA_LATEST_FILE)), 0o600);
});

test("writer: no change inside 60 s writes no sample and leaves the latest file alone", (t) => {
  const w = makeWorld(t);
  const q = quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS));
  must(recordStatuslineQuota(w.dir, q, NOW, BASE_DEPS));
  const latest = join(w.dir, QUOTA_LATEST_FILE);
  const before = readText(latest);
  const again = must(recordStatuslineQuota(w.dir, q, NOW + QUOTA_LATEST_REFRESH_MS - 1, BASE_DEPS));
  assert.deepEqual(again, { appended: 0, skipped: 0, full: 0, latestWritten: false });
  assert.equal(readText(latest), before);
  assert.equal(linesOf(join(w.dir, "quota-2026-11.jsonl")).length, 2);
});

test("writer: no change at 60 s age refreshes the latest time and still writes no sample", (t) => {
  const w = makeWorld(t);
  const q = quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS));
  must(recordStatuslineQuota(w.dir, q, NOW, BASE_DEPS));
  const later = NOW + QUOTA_LATEST_REFRESH_MS;
  const again = must(recordStatuslineQuota(w.dir, q, later, BASE_DEPS));
  assert.deepEqual(again, { appended: 0, skipped: 0, full: 0, latestWritten: true });
  assert.equal(linesOf(join(w.dir, "quota-2026-11.jsonl")).length, 2);
  const view = readLatestQuota(w.dir, later, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: true, usedPercent: 12.5, resetsAt: FIVE_RESET_MS, at: later });
  assert.deepEqual(view.week, { known: true, usedPercent: 40, resetsAt: WEEK_RESET_MS, at: later });
});

test("writer: a change in one limit writes one sample and updates the latest file", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  const t1 = NOW + 10_000;
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(13, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), t1, BASE_DEPS));
  assert.deepEqual(report, { appended: 1, skipped: 0, full: 0, latestWritten: true });
  const lines = linesOf(join(w.dir, "quota-2026-11.jsonl")).map((l) => JSON.parse(l) as { w: string; pct: number });
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[2]?.w, lines[2]?.pct], ["five_hour", 13]);
  const view = readLatestQuota(w.dir, t1, BASE_DEPS);
  assert.equal(view.five_hour.known && view.five_hour.usedPercent, 13);
});

test("writer: a new reset time counts as a change even at the same percent", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(5, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(5, FIVE_RESET_MS + 5 * HOUR_MS), null), NOW + 1000, BASE_DEPS));
  assert.equal(report.appended, 1);
});

test("writer: a limit missing from the input keeps its stored value", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  const t1 = NOW + 5 * MINUTE_MS;
  must(recordStatuslineQuota(w.dir, quotaOf(null, rawPoint(41, WEEK_RESET_MS)), t1, BASE_DEPS));
  const view = readLatestQuota(w.dir, t1, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: true, usedPercent: 12.5, resetsAt: FIVE_RESET_MS, at: NOW });
  assert.deepEqual(view.week, { known: true, usedPercent: 41, resetsAt: WEEK_RESET_MS, at: t1 });
});

test("writer: a sample goes to the file of its own UTC month", (t) => {
  const w = makeWorld(t);
  const endOfNov = Date.parse("2026-11-30T23:59:30Z");
  const startOfDec = Date.parse("2026-12-01T00:00:30Z");
  const reset = startOfDec + 2 * HOUR_MS;
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, reset), rawPoint(20, reset + DAY_MS)), endOfNov, BASE_DEPS));
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(11, reset), rawPoint(20, reset + DAY_MS)), startOfDec, BASE_DEPS));
  assert.deepEqual(sampleFiles(w.dir), ["quota-2026-11.jsonl", "quota-2026-12.jsonl"]);
  assert.equal(linesOf(join(w.dir, "quota-2026-11.jsonl")).length, 2);
  assert.equal(linesOf(join(w.dir, "quota-2026-12.jsonl")).length, 1);
});

test("writer: a month file at its 1 MiB cap takes no new sample, but the latest file still updates", (t) => {
  const w = makeWorld(t);
  const month = join(w.dir, "quota-2026-11.jsonl");
  const filler = `${"x".repeat(QUOTA_MONTH_CAP_BYTES - 40)}\n`;
  writeFileSync(month, filler, { mode: 0o600 });
  const size = statSync(month).size;
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  assert.deepEqual(report, { appended: 0, skipped: 0, full: 2, latestWritten: true });
  assert.equal(statSync(month).size, size);
  assert.equal(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour.known, true);
});

test("writer: a month file below the cap still takes a sample", (t) => {
  const w = makeWorld(t);
  const month = join(w.dir, "quota-2026-11.jsonl");
  writeFileSync(month, `${"x".repeat(QUOTA_MONTH_CAP_BYTES - 1000)}\n`, { mode: 0o600 });
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(12.5, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  assert.equal(report.appended, 1);
  assert.ok(statSync(month).size <= QUOTA_MONTH_CAP_BYTES);
});

test("writer: a damaged or foreign latest file is replaced, not trusted", (t) => {
  const w = makeWorld(t);
  const path = writeLatest(w, "{not json");
  const q = quotaOf(rawPoint(12.5, FIVE_RESET_MS), null);
  assert.equal(must(recordStatuslineQuota(w.dir, q, NOW, BASE_DEPS)).appended, 1);
  assert.equal(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour.known, true);
  assert.equal(modeOf(path), 0o600);
});

test("writer: a lower percent with the same reset time keeps the stored value and writes no sample", (t) => {
  const w = makeWorld(t);
  const month = join(w.dir, "quota-2026-11.jsonl");
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(6, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  const low = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(4, FIVE_RESET_MS), null), NOW + 2000, BASE_DEPS));
  assert.deepEqual(low, { appended: 0, skipped: 0, full: 0, latestWritten: false });
  const again = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(6, FIVE_RESET_MS), null), NOW + 7000, BASE_DEPS));
  assert.equal(again.appended, 0);
  const view = readLatestQuota(w.dir, NOW + 7000, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: true, usedPercent: 6, resetsAt: FIVE_RESET_MS, at: NOW });
  assert.equal(linesOf(month).filter((line) => line.includes('"five_hour"')).length, 1);
});

test("writer: a lower percent at 60 s age refreshes the time but keeps the higher percent", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(6, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  const later = NOW + QUOTA_LATEST_REFRESH_MS;
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(4, FIVE_RESET_MS), null), later, BASE_DEPS));
  assert.deepEqual(report, { appended: 0, skipped: 0, full: 0, latestWritten: true });
  assert.deepEqual(readLatestQuota(w.dir, later, BASE_DEPS).five_hour, {
    known: true,
    usedPercent: 6,
    resetsAt: FIVE_RESET_MS,
    at: later,
  });
});

test("writer: a higher percent with the same reset time replaces the stored value", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(4, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(6, FIVE_RESET_MS), null), NOW + 1000, BASE_DEPS));
  assert.equal(report.appended, 1);
  const view = readLatestQuota(w.dir, NOW + 1000, BASE_DEPS).five_hour;
  assert.ok(view.known && view.usedPercent === 6);
});

test("writer: a new reset time replaces the stored value, also at a lower percent", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(80, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  const nextReset = FIVE_RESET_MS + 5 * HOUR_MS;
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(2, nextReset), null), NOW + 1000, BASE_DEPS));
  assert.equal(report.appended, 1);
  assert.deepEqual(readLatestQuota(w.dir, NOW + 1000, BASE_DEPS).five_hour, {
    known: true,
    usedPercent: 2,
    resetsAt: nextReset,
    at: NOW + 1000,
  });
});

test("writer: the sequence 6, 6, 4, 6 from two sessions ends at 6 with one sample", (t) => {
  const w = makeWorld(t);
  for (const [index, pct] of [6, 6, 4, 6].entries()) {
    must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(pct, FIVE_RESET_MS), null), NOW + index * 2000, BASE_DEPS));
  }
  assert.equal(linesOf(join(w.dir, "quota-2026-11.jsonl")).filter((line) => line.includes('"five_hour"')).length, 1);
  const view = readLatestQuota(w.dir, NOW + 8000, BASE_DEPS).five_hour;
  assert.ok(view.known && view.usedPercent === 6);
});

test("writer: a stored value that is out of range does not hold back the new one", (t) => {
  const w = makeWorld(t);
  writeLatest(w, latestBody(storedPoint(150, FIVE_RESET_MS, NOW - MINUTE_MS), null));
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(6, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  const view = readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour;
  assert.ok(view.known && view.usedPercent === 6);
});

// ---------------------------------------------------------------------------
// Reason codes for a window that is not usable
// ---------------------------------------------------------------------------

test("reasons: an absent window with nothing stored is stored with its reason", (t) => {
  const w = makeWorld(t);
  const report = must(recordStatuslineQuota(w.dir, quotaOf(null, rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  assert.deepEqual(report, { appended: 1, skipped: 0, full: 0, latestWritten: true });
  const view = readLatestQuota(w.dir, NOW, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: false, reason: "absent" });
  assert.equal(view.week.known, true);
  assert.deepEqual(JSON.parse(readText(join(w.dir, QUOTA_LATEST_FILE))).claude.five_hour, { reason: "absent", at: NOW });
});

test("reasons: bad_percent and bad_reset are stored and read back", (t) => {
  const w = makeWorld(t);
  const q: StatuslineQuota = { five_hour: { reason: "bad_percent" }, week: { reason: "bad_reset" } };
  must(recordStatuslineQuota(w.dir, q, NOW, BASE_DEPS));
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS), {
    five_hour: { known: false, reason: "bad_percent" },
    week: { known: false, reason: "bad_reset" },
  });
  assert.deepEqual(linesOf(join(w.dir, "quota-2026-11.jsonl")), []);
});

test("reasons: the same reason again does not rewrite the latest file", (t) => {
  const w = makeWorld(t);
  const q = quotaOf(null, rawPoint(40, WEEK_RESET_MS));
  must(recordStatuslineQuota(w.dir, q, NOW, BASE_DEPS));
  const before = readText(join(w.dir, QUOTA_LATEST_FILE));
  const again = must(recordStatuslineQuota(w.dir, q, NOW + 30_000, BASE_DEPS));
  assert.deepEqual(again, { appended: 0, skipped: 0, full: 0, latestWritten: false });
  assert.equal(readText(join(w.dir, QUOTA_LATEST_FILE)), before);
});

test("reasons: an unusable window keeps a stored value whose period is still open", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(12.5, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  const t1 = NOW + 5 * MINUTE_MS;
  must(recordStatuslineQuota(w.dir, { five_hour: { reason: "bad_percent" }, week: rawPoint(41, WEEK_RESET_MS) }, t1, BASE_DEPS));
  assert.deepEqual(readLatestQuota(w.dir, t1, BASE_DEPS).five_hour, {
    known: true,
    usedPercent: 12.5,
    resetsAt: FIVE_RESET_MS,
    at: NOW,
  });
});

test("reasons: an unusable window replaces a stored value whose period has ended", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(12.5, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  const after = FIVE_RESET_MS + MINUTE_MS;
  must(recordStatuslineQuota(w.dir, quotaOf(null, rawPoint(40, WEEK_RESET_MS)), after, BASE_DEPS));
  assert.deepEqual(readLatestQuota(w.dir, after, BASE_DEPS).five_hour, { known: false, reason: "absent" });
});

test("reasons: a usable window replaces a stored reason", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(null, rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  const report = must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(3, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW + 1000, BASE_DEPS));
  assert.equal(report.appended, 1);
  assert.equal(readLatestQuota(w.dir, NOW + 1000, BASE_DEPS).five_hour.known, true);
});

test("reasons: a stored reason that is not one of the codes reads as bad_shape", (t) => {
  const w = makeWorld(t);
  writeLatest(w, latestBody({ reason: "free text", at: NOW }, storedPoint(40, WEEK_RESET_MS, NOW)));
  const view = readLatestQuota(w.dir, NOW, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: false, reason: "bad_shape" });
  assert.equal(view.week.known, true);
});

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

const UNKNOWN_MISSING = { known: false, reason: "missing" } as const;

test("reader: no file reads as unknown", (t) => {
  const w = makeWorld(t);
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS), { five_hour: UNKNOWN_MISSING, week: UNKNOWN_MISSING });
});

test("reader: a fresh file gives the percent, the reset time and the sample time", (t) => {
  const w = makeWorld(t);
  writeLatest(w, latestBody(storedPoint(12.5, FIVE_RESET_MS, NOW - MINUTE_MS), storedPoint(40, WEEK_RESET_MS, NOW - MINUTE_MS)));
  const view = readLatestQuota(w.dir, NOW, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: true, usedPercent: 12.5, resetsAt: FIVE_RESET_MS, at: NOW - MINUTE_MS });
  assert.deepEqual(view.week, { known: true, usedPercent: 40, resetsAt: WEEK_RESET_MS, at: NOW - MINUTE_MS });
});

test("reader: a window that has reset reads as unknown (stale), the other one stays", (t) => {
  const w = makeWorld(t);
  writeLatest(w, latestBody(storedPoint(80, NOW - 1, NOW - 5 * HOUR_MS), storedPoint(40, WEEK_RESET_MS, NOW - MINUTE_MS)));
  const view = readLatestQuota(w.dir, NOW, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: false, reason: "stale" });
  assert.equal(view.week.known, true);
});

test("reader: out of range values read as unknown", (t) => {
  const w = makeWorld(t);
  const cases: readonly [string, object][] = [
    ["percent over 100", storedPoint(100.5, FIVE_RESET_MS, NOW)],
    ["percent below 0", storedPoint(-1, FIVE_RESET_MS, NOW)],
    ["reset over 8 days after the sample", storedPoint(10, NOW + 9 * DAY_MS, NOW)],
    ["reset before the sample", storedPoint(10, NOW - HOUR_MS, NOW)],
    ["sample time in the future", storedPoint(10, FIVE_RESET_MS, NOW + HOUR_MS)],
    ["sample time before 2020", storedPoint(10, FIVE_RESET_MS, 1000)],
  ];
  for (const [name, point] of cases) {
    writeLatest(w, latestBody(point, null));
    const view = readLatestQuota(w.dir, NOW, BASE_DEPS);
    assert.equal(view.five_hour.known, false, name);
    assert.equal(view.five_hour.known === false && view.five_hour.reason, "out_of_range", name);
    assert.deepEqual(view.week, UNKNOWN_MISSING, name);
  }
});

test("reader: a wrong shape reads as unknown", (t) => {
  const w = makeWorld(t);
  const bodies: readonly unknown[] = [
    "{not json",
    "[]",
    {},
    { version: 1 },
    { version: 1, claude: [] },
    { version: "1", claude: {} },
    { version: 0, claude: {} },
    { version: 2, claude: latestBody(null, null) },
    latestBody({ usedPercent: "12", resetsAt: FIVE_RESET_MS, at: NOW }, null),
    latestBody({ usedPercent: 12, resetsAt: FIVE_RESET_MS }, null),
    latestBody([1, 2, 3], null),
  ];
  for (const body of bodies) {
    writeLatest(w, body);
    const view = readLatestQuota(w.dir, NOW, BASE_DEPS);
    assert.equal(view.five_hour.known, false, JSON.stringify(body));
    assert.equal(view.week.known, false, JSON.stringify(body));
  }
});

test("reader: a file over 4 KiB, a loose mode, a link or a foreign owner reads as unknown", (t) => {
  const w = makeWorld(t);
  const good = latestBody(storedPoint(12.5, FIVE_RESET_MS, NOW), null);
  const path = writeLatest(w, JSON.stringify(good) + " ".repeat(4 * KIB));
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour, { known: false, reason: "too_large" });

  writeLatest(w, good, 0o644);
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour, { known: false, reason: "unsafe" });
  writeLatest(w, good, 0o660);
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour, { known: false, reason: "unsafe" });

  writeLatest(w, good);
  assert.equal(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour.known, true);
  const foreign = readLatestQuota(w.dir, NOW, { ...BASE_DEPS, uid: BASE_DEPS.uid + 1 });
  assert.deepEqual(foreign.five_hour, { known: false, reason: "unsafe" });

  const target = join(w.dir, "target.json");
  writeFileSync(target, JSON.stringify(good), { mode: 0o600 });
  assert.ok(existsSync(path));
  unlinkSync(path);
  symlinkSync(target, path);
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour, { known: false, reason: "unsafe" });
});

// ---------------------------------------------------------------------------
// Latest sample for the reader (Codex restamp)
// ---------------------------------------------------------------------------

function mk(provider: "claude" | "codex", window: "five_hour" | "week", at: number, pct: number, reset: number): QuotaSample {
  return { provider, window, at, usedPercent: pct, resetsAt: reset };
}

test("latest sample: the highest percent of the current reset period wins, not the latest time", () => {
  const reset = NOW + 2 * DAY_MS;
  const samples = [
    mk("codex", "week", NOW - 3 * HOUR_MS, 35, reset),
    mk("codex", "week", NOW - 2 * HOUR_MS, 40, reset),
    // A restamped copy of a parent prefix: a later time, an older percent.
    mk("codex", "week", NOW - HOUR_MS, 30, reset),
  ];
  const picked = pickLatestSample(samples, "codex", "week", NOW);
  assert.deepEqual(picked, mk("codex", "week", NOW - 2 * HOUR_MS, 40, reset));
});

test("latest sample: equal percent takes the later time", () => {
  const reset = NOW + 2 * DAY_MS;
  const samples = [mk("codex", "week", NOW - 3 * HOUR_MS, 40, reset), mk("codex", "week", NOW - HOUR_MS, 40, reset)];
  assert.equal(pickLatestSample(samples, "codex", "week", NOW)?.at, NOW - HOUR_MS);
});

test("latest sample: a newer reset period wins over an older one, and a past period is ignored", () => {
  const oldReset = NOW + HOUR_MS;
  const newReset = oldReset + 5 * HOUR_MS;
  const samples = [
    mk("codex", "five_hour", NOW - HOUR_MS, 90, oldReset),
    mk("codex", "five_hour", NOW - 30 * MINUTE_MS, 3, newReset),
  ];
  assert.equal(pickLatestSample(samples, "codex", "five_hour", NOW)?.usedPercent, 3);
  const past = [mk("codex", "five_hour", NOW - 6 * HOUR_MS, 90, NOW - HOUR_MS)];
  assert.equal(pickLatestSample(past, "codex", "five_hour", NOW), null);
  assert.equal(pickLatestSample([], "codex", "five_hour", NOW), null);
});

test("latest sample: the provider and the window must match", () => {
  const reset = NOW + HOUR_MS;
  const samples = [mk("claude", "week", NOW, 50, reset), mk("codex", "five_hour", NOW, 20, reset)];
  assert.equal(pickLatestSample(samples, "codex", "week", NOW), null);
  assert.equal(pickLatestSample(samples, "claude", "week", NOW)?.usedPercent, 50);
});

// ---------------------------------------------------------------------------
// Codex samples from collect
// ---------------------------------------------------------------------------

test("codex: samples from a collect pass are stored once, in time order, and read back", (t) => {
  const w = makeWorld(t);
  const root = w.sb.path("src-codex");
  const file = join(root, "2026", "11", "03", "rollout-parent.jsonl");
  assertGuarded(file);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, readFileSync(join(FIXTURES, "codex-basic.jsonl")));
  utimesSync(file, (NOW - 3 * HOUR_MS) / 1000, (NOW - 3 * HOUR_MS) / 1000);

  const deps: FsDeps = { ...BASE_DEPS, nowMs: () => NOW };
  const report = must(collect({ dataDir: w.dir, roots: { claude: null, codex: root }, budget: { bytes: 200 * MIB, ms: 20_000 } }, deps));
  assert.equal(report.codexQuota.length, 8);

  const first = must(storeCodexQuota(w.dir, report.codexQuota, deps));
  // The fixture reports the week at 41 percent twice, at two times: one is a repeat.
  assert.deepEqual(first, { appended: 7, skipped: 1, full: 0, latestWritten: true });
  const month = join(w.dir, "quota-2026-11.jsonl");
  assert.equal(linesOf(month).length, 7);
  assert.equal(modeOf(month), 0o600);
  assert.equal(modeOf(join(w.dir, QUOTA_LATEST_FILE)), 0o600, "collect keeps the Codex windows in the latest file");

  const again = must(storeCodexQuota(w.dir, report.codexQuota, deps));
  assert.deepEqual(again, { appended: 0, skipped: 8, full: 0, latestWritten: false });
  assert.equal(linesOf(month).length, 7);

  const samples = readQuotaSamples(w.dir, ["2026-11"], NOW);
  assert.equal(samples.length, 7);
  assert.ok(samples.every((s) => s.provider === "codex"));
  const early = Date.parse("2026-11-03T10:30:00Z");
  assert.equal(pickLatestSample(samples, "codex", "five_hour", early)?.usedPercent, 20);
  assert.equal(pickLatestSample(samples, "codex", "week", early)?.usedPercent, 42);
  // At NOW the five hour window of the fixture has ended: unknown. The week is still open.
  assert.equal(pickLatestSample(samples, "codex", "five_hour", NOW), null);
  assert.equal(pickLatestSample(samples, "codex", "week", NOW)?.usedPercent, 42);
});

test("codex: samples go to the month of their own time", (t) => {
  const w = makeWorld(t);
  const a = mk("codex", "week", Date.parse("2026-10-31T23:59:00Z"), 10, Date.parse("2026-11-05T00:00:00Z"));
  const b = mk("codex", "week", Date.parse("2026-11-01T00:01:00Z"), 11, Date.parse("2026-11-05T00:00:00Z"));
  const report = must(storeCodexQuota(w.dir, [a, b], BASE_DEPS));
  assert.equal(report.appended, 2);
  assert.deepEqual(sampleFiles(w.dir), ["quota-2026-10.jsonl", "quota-2026-11.jsonl"]);
});

test("codex: the month cap holds for stored samples too, and a full file is counted apart from a repeat", (t) => {
  const w = makeWorld(t);
  const path = join(w.dir, "quota-2026-11.jsonl");
  writeFileSync(path, `${"x".repeat(QUOTA_MONTH_CAP_BYTES - 40)}\n`, { mode: 0o600 });
  const a = mk("codex", "week", NOW, 10, WEEK_RESET_MS);
  const report = must(storeCodexQuota(w.dir, [a], BASE_DEPS));
  assert.deepEqual(report, { appended: 0, skipped: 0, full: 1, latestWritten: true });
  assert.ok(statSync(path).size <= QUOTA_MONTH_CAP_BYTES);
});

test("codex: a sample that is already stored is a repeat, not a full file, in a file a little over the write cap", (t) => {
  const w = makeWorld(t);
  const path = join(w.dir, quotaMonthFile(NOW));
  const stored = mk("codex", "week", NOW - HOUR_MS, 10, WEEK_RESET_MS);
  const { text } = monthTextOver(QUOTA_MONTH_CAP_BYTES);
  writeFileSync(path, `${sampleLine(stored)}\n${text}`, { mode: 0o600 });
  assert.ok(statSync(path).size > QUOTA_MONTH_CAP_BYTES);
  const size = statSync(path).size;
  const repeat = mk("codex", "week", NOW, 10, WEEK_RESET_MS);
  const changed = mk("codex", "week", NOW, 11, WEEK_RESET_MS);
  const report = must(storeCodexQuota(w.dir, [repeat, changed], BASE_DEPS));
  assert.deepEqual(report, { appended: 0, skipped: 1, full: 1, latestWritten: true });
  assert.equal(statSync(path).size, size);
});

test("codex: a sample with the stored percent and reset time is skipped, a changed one is appended", (t) => {
  const w = makeWorld(t);
  const month = join(w.dir, quotaMonthFile(NOW));
  const start = mk("codex", "week", NOW - 30 * MINUTE_MS, 40, WEEK_RESET_MS);
  assert.deepEqual(must(storeCodexQuota(w.dir, [start], BASE_DEPS)), { appended: 1, skipped: 0, full: 0, latestWritten: true });

  // The same percent and reset time at a later time: no new line, only the time of the latest file moves.
  const later = mk("codex", "week", NOW, 40, WEEK_RESET_MS);
  assert.deepEqual(must(storeCodexQuota(w.dir, [later], BASE_DEPS)), { appended: 0, skipped: 1, full: 0, latestWritten: true });
  assert.equal(linesOf(month).length, 1);

  // A changed percent, a changed reset time and another window are new.
  const percent = mk("codex", "week", NOW + MINUTE_MS, 41, WEEK_RESET_MS);
  const reset = mk("codex", "week", NOW + 2 * MINUTE_MS, 41, WEEK_RESET_MS + DAY_MS);
  const other = mk("codex", "five_hour", NOW + 3 * MINUTE_MS, 41, WEEK_RESET_MS);
  const report = must(storeCodexQuota(w.dir, [percent, reset, other], BASE_DEPS));
  assert.deepEqual(report, { appended: 3, skipped: 0, full: 0, latestWritten: true });
  assert.equal(linesOf(month).length, 4);
});

test("codex: equal samples inside one batch are stored once", (t) => {
  const w = makeWorld(t);
  const samples = [
    mk("codex", "week", NOW, 40, WEEK_RESET_MS),
    mk("codex", "week", NOW + MINUTE_MS, 40, WEEK_RESET_MS),
    mk("codex", "week", NOW + 2 * MINUTE_MS, 40, WEEK_RESET_MS),
  ];
  assert.deepEqual(must(storeCodexQuota(w.dir, samples, BASE_DEPS)), { appended: 1, skipped: 2, full: 0, latestWritten: true });
});

test("codex: an older percent from a restamped copy is stored once, then the newer percent is a repeat", (t) => {
  const w = makeWorld(t);
  const month = join(w.dir, quotaMonthFile(NOW));
  const pass = (): readonly QuotaSample[] => [
    mk("codex", "week", NOW, 40, WEEK_RESET_MS),
    mk("codex", "week", NOW + MINUTE_MS, 30, WEEK_RESET_MS),
    mk("codex", "week", NOW + 2 * MINUTE_MS, 40, WEEK_RESET_MS),
  ];
  assert.equal(must(storeCodexQuota(w.dir, pass(), BASE_DEPS)).appended, 2);
  const later = pass().map((s) => ({ ...s, at: s.at + HOUR_MS }));
  assert.deepEqual(must(storeCodexQuota(w.dir, later, BASE_DEPS)), { appended: 0, skipped: 3, full: 0, latestWritten: true });
  assert.equal(linesOf(month).length, 2);
});

test("codex: a Claude sample with the same numbers does not hide a Codex sample", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(null, rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  const sample = mk("codex", "week", NOW, 40, WEEK_RESET_MS);
  assert.equal(must(storeCodexQuota(w.dir, [sample], BASE_DEPS)).appended, 1);
});

// --- the Codex windows of the latest file ---

// The Codex observations of the data folder.
function codexSeen(w: World, nowMs: number): readonly QuotaSample[] {
  return readObservations(w.dir, nowMs, BASE_DEPS).filter((s) => s.provider === "codex");
}

// Read a little after the last sample time of these tests.
function observed(w: World, window: "five_hour" | "week"): QuotaSample | null {
  return codexSeen(w, NOW + 10 * MINUTE_MS).find((s) => s.window === window) ?? null;
}

function latestJson(w: World): { readonly claude: unknown; readonly codex?: unknown } {
  return JSON.parse(readText(join(w.dir, QUOTA_LATEST_FILE))) as { claude: unknown; codex?: unknown };
}

test("codex latest: the same numbers seen again move the time of the latest sample, and add no line", (t) => {
  const w = makeWorld(t);
  const month = join(w.dir, quotaMonthFile(NOW));
  const change = mk("codex", "week", NOW - 30 * MINUTE_MS, 40, WEEK_RESET_MS);
  const again = mk("codex", "week", NOW, 40, WEEK_RESET_MS);
  assert.deepEqual(must(storeCodexQuota(w.dir, [change], BASE_DEPS)), { appended: 1, skipped: 0, full: 0, latestWritten: true });
  assert.deepEqual(observed(w, "week"), change);
  const lines = linesOf(month);

  assert.deepEqual(must(storeCodexQuota(w.dir, [again], BASE_DEPS)), { appended: 0, skipped: 1, full: 0, latestWritten: true });
  assert.deepEqual(linesOf(month), lines, "the month file did not grow");
  assert.deepEqual(observed(w, "week"), again);
  assert.equal(observed(w, "five_hour"), null);

  // The same pass again changes nothing.
  assert.deepEqual(must(storeCodexQuota(w.dir, [again], BASE_DEPS)), { appended: 0, skipped: 1, full: 0, latestWritten: false });
});

test("codex latest: an earlier sample time of the same numbers does not move the time back", (t) => {
  const w = makeWorld(t);
  must(storeCodexQuota(w.dir, [mk("codex", "week", NOW, 40, WEEK_RESET_MS)], BASE_DEPS));
  const early = mk("codex", "week", NOW - HOUR_MS, 40, WEEK_RESET_MS);
  assert.equal(must(storeCodexQuota(w.dir, [early], BASE_DEPS)).latestWritten, false);
  assert.equal(observed(w, "week")?.at, NOW);
});

test("codex latest: the highest percent of one reset time stays, a newer reset time replaces it, an older one does not", (t) => {
  const w = makeWorld(t);
  must(storeCodexQuota(w.dir, [mk("codex", "week", NOW - HOUR_MS, 40, WEEK_RESET_MS)], BASE_DEPS));

  // A restamped copy: a later time, a lower percent.
  const copy = mk("codex", "week", NOW, 30, WEEK_RESET_MS);
  assert.equal(must(storeCodexQuota(w.dir, [copy], BASE_DEPS)).latestWritten, false);
  assert.deepEqual(observed(w, "week"), mk("codex", "week", NOW - HOUR_MS, 40, WEEK_RESET_MS));

  const higher = mk("codex", "week", NOW + MINUTE_MS, 41, WEEK_RESET_MS);
  must(storeCodexQuota(w.dir, [higher], BASE_DEPS));
  assert.deepEqual(observed(w, "week"), higher);

  const next = mk("codex", "week", NOW + 2 * MINUTE_MS, 5, WEEK_RESET_MS + DAY_MS);
  must(storeCodexQuota(w.dir, [next], BASE_DEPS));
  assert.deepEqual(observed(w, "week"), next);

  // A restamped copy of the old period, with a later time than the stored one.
  const old = mk("codex", "week", NOW + 3 * MINUTE_MS, 50, WEEK_RESET_MS);
  assert.equal(must(storeCodexQuota(w.dir, [old], BASE_DEPS)).latestWritten, false);
  assert.deepEqual(observed(w, "week"), next);
});

test("codex latest: inside one pass the highest percent of the newest reset time wins, with the last time it was seen", (t) => {
  const w = makeWorld(t);
  const samples = [
    mk("codex", "week", NOW - 3 * MINUTE_MS, 40, WEEK_RESET_MS),
    mk("codex", "week", NOW - 2 * MINUTE_MS, 30, WEEK_RESET_MS),
    mk("codex", "week", NOW - MINUTE_MS, 40, WEEK_RESET_MS),
    mk("codex", "five_hour", NOW - MINUTE_MS, 7, FIVE_RESET_MS),
  ];
  must(storeCodexQuota(w.dir, samples, BASE_DEPS));
  assert.deepEqual(observed(w, "week"), mk("codex", "week", NOW - MINUTE_MS, 40, WEEK_RESET_MS));
  assert.deepEqual(observed(w, "five_hour"), mk("codex", "five_hour", NOW - MINUTE_MS, 7, FIVE_RESET_MS));
});

test("codex latest: the Claude windows of the latest file stay, and record keeps the Codex windows", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  const claude = readLatestQuota(w.dir, NOW, BASE_DEPS);
  const codex = mk("codex", "week", NOW, 25, WEEK_RESET_MS);
  must(storeCodexQuota(w.dir, [codex], BASE_DEPS));
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS), claude, "collect did not change the Claude reading");
  assert.deepEqual(observed(w, "week"), codex);
  assert.deepEqual(Object.keys(latestJson(w)).sort(), ["claude", "codex", "version"]);

  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, FIVE_RESET_MS), rawPoint(41, WEEK_RESET_MS)), NOW + MINUTE_MS, BASE_DEPS));
  const week = readLatestQuota(w.dir, NOW + MINUTE_MS, BASE_DEPS).week;
  assert.ok(week.known && week.usedPercent === 41);
  assert.deepEqual(observed(w, "week"), codex, "record did not change the Codex window");
});

test("codex latest: a folder with no Claude window gets a latest file, and the Claude windows read as missing", (t) => {
  const w = makeWorld(t);
  must(storeCodexQuota(w.dir, [mk("codex", "week", NOW, 25, WEEK_RESET_MS)], BASE_DEPS));
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS), {
    five_hour: { known: false, reason: "missing" },
    week: { known: false, reason: "missing" },
  });
  assert.equal(modeOf(join(w.dir, QUOTA_LATEST_FILE)), 0o600);
});

test("codex latest: a record-only folder keeps the file it had: no Codex section until Codex is seen", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  assert.deepEqual(Object.keys(latestJson(w)).sort(), ["claude", "version"]);
});

test("codex latest: a damaged latest file is replaced, not trusted", (t) => {
  const w = makeWorld(t);
  writeLatest(w, "{not json");
  const codex = mk("codex", "week", NOW, 25, WEEK_RESET_MS);
  assert.equal(must(storeCodexQuota(w.dir, [codex], BASE_DEPS)).latestWritten, true);
  assert.deepEqual(observed(w, "week"), codex);
});

test("codex latest reader: a file with no Codex section gives none, and a Codex section does not change the Claude reading", (t) => {
  const w = makeWorld(t);
  const claude = latestBody(storedPoint(10, FIVE_RESET_MS, NOW), storedPoint(40, WEEK_RESET_MS, NOW)) as { claude: unknown };
  writeLatest(w, { version: 1, claude: claude.claude });
  assert.deepEqual(codexSeen(w, NOW), []);
  const before = readLatestQuota(w.dir, NOW, BASE_DEPS);
  assert.ok(before.week.known);

  writeLatest(w, { version: 1, claude: claude.claude, codex: { five_hour: null, week: storedPoint(25, WEEK_RESET_MS, NOW) } });
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS), before);
  assert.deepEqual(codexSeen(w, NOW), [mk("codex", "week", NOW, 25, WEEK_RESET_MS)]);
});

test("codex latest reader: a Codex window that is out of range, a reason or of a wrong shape gives no observation", (t) => {
  const w = makeWorld(t);
  const claude = { five_hour: null, week: null };
  writeLatest(w, {
    version: 1,
    claude,
    codex: {
      five_hour: { reason: "absent", at: NOW },
      week: storedPoint(50, NOW + 100 * DAY_MS, NOW),
    },
  });
  assert.deepEqual(codexSeen(w, NOW), []);
  writeLatest(w, { version: 1, claude, codex: { five_hour: "x", week: storedPoint(150, WEEK_RESET_MS, NOW) } });
  assert.deepEqual(codexSeen(w, NOW), []);
  writeLatest(w, { version: 1, claude, codex: storedPoint(25, WEEK_RESET_MS, NOW) });
  assert.deepEqual(codexSeen(w, NOW), []);
});

test("observations: the Claude windows of the latest file read as samples with the time they were last seen", (t) => {
  const w = makeWorld(t);
  const change = NOW - 30 * MINUTE_MS;
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), change, BASE_DEPS));
  const lines = linesOf(join(w.dir, quotaMonthFile(change)));
  // The same numbers again, a little later than the refresh time of the file.
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, FIVE_RESET_MS), rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  assert.deepEqual(linesOf(join(w.dir, quotaMonthFile(change))), lines, "the month file did not grow");
  assert.deepEqual(readObservations(w.dir, NOW, BASE_DEPS), [
    mk("claude", "five_hour", NOW, 10, FIVE_RESET_MS),
    mk("claude", "week", NOW, 40, WEEK_RESET_MS),
  ]);
});

test("observations: Claude first, then Codex, each window with its own numbers", (t) => {
  const w = makeWorld(t);
  must(recordStatuslineQuota(w.dir, quotaOf(null, rawPoint(40, WEEK_RESET_MS)), NOW, BASE_DEPS));
  must(storeCodexQuota(w.dir, [mk("codex", "week", NOW, 25, WEEK_RESET_MS)], BASE_DEPS));
  assert.deepEqual(readObservations(w.dir, NOW, BASE_DEPS), [
    mk("claude", "week", NOW, 40, WEEK_RESET_MS),
    mk("codex", "week", NOW, 25, WEEK_RESET_MS),
  ]);
});

test("observations: an older store with no Claude value, a Claude reason code, a bad Claude value or no file gives no Claude observation", (t) => {
  const w = makeWorld(t);
  assert.deepEqual(readObservations(w.dir, NOW, BASE_DEPS), []);
  writeLatest(w, latestBody(null, null));
  assert.deepEqual(readObservations(w.dir, NOW, BASE_DEPS), []);
  writeLatest(w, latestBody({ reason: "absent", at: NOW }, { reason: "bad_percent", at: NOW }));
  assert.deepEqual(readObservations(w.dir, NOW, BASE_DEPS), []);
  writeLatest(w, latestBody(storedPoint(140, FIVE_RESET_MS, NOW), storedPoint(40, WEEK_RESET_MS, NOW + 100 * DAY_MS)));
  assert.deepEqual(readObservations(w.dir, NOW, BASE_DEPS), []);
  writeLatest(w, "{not json");
  assert.deepEqual(readObservations(w.dir, NOW, BASE_DEPS), []);
});

test("codex latest: a stored Codex window that is out of range does not hold back a new one", (t) => {
  const w = makeWorld(t);
  writeLatest(w, { version: 1, claude: { five_hour: null, week: null }, codex: { five_hour: null, week: storedPoint(50, NOW + 100 * DAY_MS, NOW) } });
  const codex = mk("codex", "week", NOW, 10, WEEK_RESET_MS);
  must(storeCodexQuota(w.dir, [codex], BASE_DEPS));
  assert.deepEqual(observed(w, "week"), codex);
});

// ---------------------------------------------------------------------------
// Codex latest reader and merge
// ---------------------------------------------------------------------------

test("codex latest: the HUD reader ignores a newer version with valid windows", (t) => {
  const w = makeWorld(t);
  writeLatest(w, { version: 2, claude: {}, codex: { week: storedPoint(40, WEEK_RESET_MS, NOW) } });
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), []);
});

test("codex latest: the Codex writer replaces a newer version with version 1", (t) => {
  const w = makeWorld(t);
  const path = writeLatest(w, { version: 2, claude: {}, codex: { week: storedPoint(40, WEEK_RESET_MS, NOW) } });
  const sample = { window: "week", at: NOW, usedPercent: 10, resetsAt: WEEK_RESET_MS } as const;
  assert.equal(must(storeCodexQuota(w.dir, [sample], BASE_DEPS)).latestWritten, true);
  assert.equal(JSON.parse(readText(path)).version, 1);
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), [{ ...sample, src: "rollouts", reached: false }]);
});

test("writer: the statusline writer replaces a newer latest file with version 1", (t) => {
  const w = makeWorld(t);
  const path = writeLatest(w, { ...latestBody(storedPoint(40, FIVE_RESET_MS, NOW), null), version: 2 });
  const quota = quotaOf(rawPoint(10, FIVE_RESET_MS), null);
  assert.equal(must(recordStatuslineQuota(w.dir, quota, NOW, BASE_DEPS)).latestWritten, true);
  assert.equal(JSON.parse(readText(path)).version, 1);
  assert.deepEqual(readLatestQuota(w.dir, NOW, BASE_DEPS).five_hour, { known: true, ...quota.five_hour, at: NOW });
});

test("codex latest: a version 1 reading without metadata defaults to rollouts and not reached", (t) => {
  const w = makeWorld(t);
  const at = NOW - 8 * DAY_MS;
  const resetsAt = at + HOUR_MS;
  writeLatest(w, { ...latestBody(null, null), codex: { five_hour: storedPoint(25, resetsAt, at) } });
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), [
    { window: "five_hour", usedPercent: 25, resetsAt, at, src: "rollouts", reached: false },
  ]);
});

test("codex latest: the reader drops old readings and keeps future readings within clock slack", (t) => {
  const w = makeWorld(t);
  const oldAt = NOW - 8 * DAY_MS - 1;
  const futureAt = NOW + MINUTE_MS;
  writeLatest(w, {
    ...latestBody(null, null),
    codex: { five_hour: storedPoint(25, oldAt + HOUR_MS, oldAt), week: storedPoint(40, WEEK_RESET_MS, futureAt) },
  });
  const read = (now: number) => readCodexLatest(w.dir, now, BASE_DEPS);
  assert.deepEqual(read(NOW).map((point) => point.window), ["week"]);
  assert.deepEqual(read(NOW - 1).map((point) => point.window), ["five_hour"]);
});

test("codex latest: the reader drops a window with invalid metadata", (t) => {
  const w = makeWorld(t);
  writeLatest(w, {
    ...latestBody(null, null),
    codex: {
      five_hour: { ...storedPoint(25, FIVE_RESET_MS, NOW), src: "other" },
      week: { ...storedPoint(40, WEEK_RESET_MS, NOW), reached: "true" },
    },
  });
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), []);
  assert.deepEqual(codexSeen(w, NOW), []);
});

test("codex latest: the reader drops windows with fractional times", (t) => {
  const w = makeWorld(t);
  writeLatest(w, {
    ...latestBody(null, null),
    codex: {
      five_hour: storedPoint(25, FIVE_RESET_MS, NOW - 0.5),
      week: storedPoint(40, WEEK_RESET_MS + 0.5, NOW),
    },
  });
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), []);
});

test("codex latest: the reader refuses a loose file or a symlink", (t) => {
  const w = makeWorld(t);
  const body = { ...latestBody(null, null), codex: { week: storedPoint(40, WEEK_RESET_MS, NOW) } };
  const path = writeLatest(w, body, 0o644);
  const read = () => readCodexLatest(w.dir, NOW, BASE_DEPS);
  assert.deepEqual(read(), []);
  chmodSync(path, 0o600);
  assert.equal(read().length, 1);
  const target = join(w.dir, "other.json");
  copyFileSync(path, target);
  unlinkSync(path);
  symlinkSync(target, path);
  assert.deepEqual(read(), []);
});

test("codex latest: record preserves the reached flag of a rollout with unchanged quota numbers", (t) => {
  const w = makeWorld(t);
  const sample = { window: "week", at: NOW, usedPercent: 40, resetsAt: WEEK_RESET_MS, reached: false } as const;
  must(storeCodexQuota(w.dir, [sample], BASE_DEPS));
  const next = must(storeCodexQuota(w.dir, [{ ...sample, reached: true }], BASE_DEPS));
  assert.deepEqual(next, { appended: 0, skipped: 1, full: 0, latestWritten: true });
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), [
    { ...sample, src: "rollouts", reached: true },
  ]);
});

test("codex latest: a newer app-server reading replaces an older rollout, but an older reply does not", (t) => {
  const w = makeWorld(t);
  const log = { window: "week", at: NOW - MINUTE_MS, usedPercent: 60, resetsAt: WEEK_RESET_MS, reached: false } as const;
  const reply = { ...log, at: NOW, usedPercent: 30, resetsAt: WEEK_RESET_MS - HOUR_MS, reached: true };
  must(storeCodexQuota(w.dir, [log], BASE_DEPS));
  const store = (sample: typeof reply) => must(storeAppServerReading(w.dir, [sample], BASE_DEPS));
  assert.equal(store({ ...reply, at: log.at - 1 }).latestWritten, false);
  assert.deepEqual(store(reply), { appended: 0, skipped: 1, full: 0, latestWritten: true });
  assert.equal(modeOf(join(w.dir, QUOTA_LATEST_FILE)), 0o600);
  assert.equal(modeOf(join(w.dir, quotaMonthFile(NOW))), 0o600);
  must(recordStatuslineQuota(w.dir, quotaOf(rawPoint(10, FIVE_RESET_MS), null), NOW, BASE_DEPS));
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), [{ ...reply, src: "appserver" }]);
});

test("codex latest: app-server wins at equal times, and only a later rollout candidate can replace it", (t) => {
  const w = makeWorld(t);
  const log = { window: "week", at: NOW, usedPercent: 60, resetsAt: WEEK_RESET_MS, reached: false } as const;
  const reply = { ...log, usedPercent: 100, reached: true };
  must(storeCodexQuota(w.dir, [log], BASE_DEPS));
  const stored = must(storeAppServerReading(w.dir, [reply], BASE_DEPS));
  assert.deepEqual(stored, { appended: 1, skipped: 0, full: 0, latestWritten: true });
  const copy = { ...log, at: NOW + MINUTE_MS, usedPercent: 50 };
  assert.equal(must(storeCodexQuota(w.dir, [copy, log], BASE_DEPS)).latestWritten, false);
  assert.deepEqual(readCodexLatest(w.dir, NOW, BASE_DEPS), [{ ...reply, src: "appserver" }]);
  const later = { ...log, at: copy.at, usedPercent: 70 };
  assert.equal(must(storeCodexQuota(w.dir, [later], BASE_DEPS)).latestWritten, true);
  assert.deepEqual(readCodexLatest(w.dir, later.at, BASE_DEPS), [{ ...later, src: "rollouts" }]);
});

for (const [source, store] of [["appserver", storeAppServerReading], ["rollouts", storeCodexQuota]] as const) {
  test(`codex latest: ${source} replaces a reading from before a one-day clock rollback`, (t) => {
    const { dir } = makeWorld(t);
    const sample = { window: "week", at: NOW, usedPercent: 40, resetsAt: WEEK_RESET_MS, reached: false } as const;
    const future = { ...sample, at: NOW + DAY_MS, usedPercent: 60 };
    const seed = source === "appserver" ? storeCodexQuota : storeAppServerReading;
    must(seed(dir, [future], { ...BASE_DEPS, nowMs: () => future.at }));
    assert.deepEqual(readCodexLatest(dir, NOW, BASE_DEPS), []);
    assert.equal(must(store(dir, [sample], { ...BASE_DEPS, nowMs: () => NOW })).latestWritten, true);
    assert.deepEqual(readCodexLatest(dir, NOW, BASE_DEPS), [{ ...sample, src: source }]);
  });
}

for (const first of ["record", "rollouts", "appserver"] as const) {
  test(`codex latest: a ${first} write preserves both sections when another writer overlaps`, (t) => {
    const { dir } = makeWorld(t);
    const claude = quotaOf(rawPoint(10, FIVE_RESET_MS), null);
    const sample = { window: "week", at: NOW, usedPercent: 40, resetsAt: WEEK_RESET_MS, reached: false } as const;
    const record = (deps: FsDeps) => must(recordStatuslineQuota(dir, claude, NOW, deps));
    const store = first === "rollouts" ? storeCodexQuota : storeAppServerReading;
    const codex = (deps: FsDeps) => must(store(dir, [sample], deps));
    const [write, overlap] = first === "record" ? [record, codex] : [codex, record];
    const attempts: boolean[] = [];
    const overlappingDeps = { ...BASE_DEPS, suffix: () => {
      // Start the other writer after this writer has read its snapshot, before rename.
      attempts.push(overlap(BASE_DEPS).latestWritten);
      return BASE_DEPS.suffix();
    } };
    assert.equal(write(overlappingDeps).latestWritten, true);
    assert.deepEqual(attempts, [false], "the other writer must not report a write that the first writer overwrites");
    assert.equal(overlap(BASE_DEPS).latestWritten, true);
    assert.deepEqual(readObservations(dir, NOW, BASE_DEPS).map(({ provider, usedPercent }) => [provider, usedPercent]),
      [["claude", 10], ["codex", 40]]);
  });
}

// ---------------------------------------------------------------------------
// Record in process (streams)
// ---------------------------------------------------------------------------

test("record: input reaches the output unchanged and the quota is stored", async (t) => {
  const w = makeWorld(t);
  const input = statusJson();
  const out = await recordWith(w.sb, [input]);
  assert.equal(out.toString("utf8"), input);
  const view = readLatestQuota(w.dir, NOW, BASE_DEPS);
  assert.deepEqual(view.five_hour, { known: true, usedPercent: 12.5, resetsAt: FIVE_RESET_MS, at: NOW });
  assert.deepEqual(view.week, { known: true, usedPercent: 40, resetsAt: WEEK_RESET_MS, at: NOW });
});

test("record: chunks are copied in order, also when they split a multi-byte character", async (t) => {
  const w = makeWorld(t);
  const whole = Buffer.from(statusJson({ week: null }) + "\né€\u{1f600}", "utf8");
  const cuts = [3, 11, whole.length - 3, whole.length - 1];
  const parts: Buffer[] = [];
  let from = 0;
  for (const cut of cuts) {
    parts.push(whole.subarray(from, cut));
    from = cut;
  }
  parts.push(whole.subarray(from));
  const out = await recordWith(w.sb, parts);
  assert.deepEqual(out, whole);
});

test("record: stdout is ended at the end of stdin, before the store work starts", async (t) => {
  const w = makeWorld(t);
  const log: string[] = [];
  const stdout = new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
    final(callback): void {
      log.push("stdout.final");
      callback();
    },
  });
  const stdin = new PassThrough();
  const deps: FsDeps = {
    ...BASE_DEPS,
    nowMs: () => {
      log.push("clock");
      return NOW;
    },
  };
  const done = runRecord(recordIo(w.sb, stdin, stdout, { deps }));
  stdin.end(statusJson());
  await done;
  assert.equal(log[0], "stdout.final");
  assert.ok(log.includes("clock"), "the store work ran");
  assert.equal(stdout.writableEnded, true);
});

test("record: input over the 64 KiB copy cap passes through whole and stores nothing", async (t) => {
  const w = makeWorld(t);
  const big = statusJson({ padding: RECORD_COPY_CAP_BYTES + 10 });
  assert.ok(big.length > RECORD_COPY_CAP_BYTES);
  const out = await recordWith(w.sb, [big.slice(0, 40_000), big.slice(40_000)]);
  // Buffer.equals: a failing deepEqual on a big buffer makes a huge diff.
  assert.ok(out.equals(Buffer.from(big, "utf8")), "output differs from input");
  assert.deepEqual(readdirSync(w.dir), []);
});

test("record: input just under the cap is parsed", async (t) => {
  const w = makeWorld(t);
  const base = statusJson({ padding: 0 });
  const input = statusJson({ padding: RECORD_COPY_CAP_BYTES - base.length - 20 });
  assert.ok(input.length < RECORD_COPY_CAP_BYTES);
  await recordWith(w.sb, [input]);
  assert.equal(readLatestQuota(w.dir, NOW, BASE_DEPS).week.known, true);
});

test("record: input that is not a JSON object passes through and stores nothing", async (t) => {
  const w = makeWorld(t);
  const text = "plain text, not JSON\n";
  const out = await recordWith(w.sb, [text]);
  assert.equal(out.toString("utf8"), text);
  assert.deepEqual(readdirSync(w.dir), []);
});

test("record: a statusline with no rate limits stores nothing, and does not create the data folder", async (t) => {
  const sb = makeSandbox(t);
  const input = JSON.stringify({ model: { id: "x" }, cwd: "/w" });
  const out = await recordWith(sb, [input]);
  assert.equal(out.toString("utf8"), input);
  assert.equal(existsSync(sb.dataDir), false);
});

test("record: a deadline that has passed stops the store work and nothing else", async (t) => {
  const w = makeWorld(t);
  let calls = 0;
  const deps: FsDeps = { ...BASE_DEPS, nowMs: () => (calls++ === 0 ? NOW : NOW + 10 * RECORD_DEADLINE_MS) };
  const input = statusJson();
  const out = await recordWith(w.sb, [input], { deps });
  assert.equal(out.toString("utf8"), input);
  assert.deepEqual(readdirSync(w.dir), []);
});

test("record: a slow reader gets every byte in order (backpressure)", async (t) => {
  const w = makeWorld(t);
  const out: Buffer[] = [];
  const slow = new Writable({
    highWaterMark: 16,
    write(chunk: Buffer, _encoding, callback): void {
      out.push(chunk);
      setImmediate(callback);
    },
  });
  const stdin = new PassThrough();
  let paused = 0;
  stdin.on("pause", () => {
    paused += 1;
  });
  const done = runRecord(recordIo(w.sb, stdin, slow));
  const total = patternBytes(256 * KIB);
  for (let at = 0; at < total.length; at += 8 * KIB) stdin.write(total.subarray(at, at + 8 * KIB));
  stdin.end();
  await done;
  assert.ok(Buffer.concat(out).equals(total), "output differs from input");
  assert.ok(paused > 0, "stdin was never paused for the slow reader");
});

test("record: a broken output does not stop the read, throw or hang", { timeout: 10_000 }, async (t) => {
  const w = makeWorld(t);
  let writes = 0;
  const broken = new Writable({
    write(_chunk, _encoding, callback): void {
      writes += 1;
      callback(new Error("EPIPE simulated"));
    },
  });
  const stdin = new PassThrough();
  const done = runRecord(recordIo(w.sb, stdin, broken));
  const input = statusJson();
  stdin.write(input.slice(0, 20));
  stdin.write(input.slice(20));
  stdin.end();
  await done;
  assert.ok(writes >= 1);
  // The input was read in full, so the quota is still stored.
  assert.equal(readLatestQuota(w.dir, NOW, BASE_DEPS).week.known, true);
});

// ---------------------------------------------------------------------------
// The bin, as a child process
// ---------------------------------------------------------------------------

test("bin: file mode 755 and the shebang line", () => {
  assert.equal(statSync(BIN).mode & 0o777, 0o755);
  const first = readFileSync(BIN, "utf8").split("\n")[0];
  assert.equal(first, "#!/usr/bin/env node");
});

test("bin record: text input comes out byte for byte, exit 0, empty stderr, rate limits stored", async (t) => {
  const sb = makeSandbox(t);
  const input = realStatus();
  const r = await runBin(["record"], input, sb.env);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.toString("utf8"), input);
  const view = readLatestQuota(sb.dataDir, Date.now(), BASE_DEPS);
  assert.equal(view.five_hour.known && view.five_hour.usedPercent, 12.5);
  assert.equal(view.week.known && view.week.usedPercent, 40);
  assert.equal(modeOf(sb.dataDir), 0o700);
});

test("bin record: binary input, empty input and large input come out byte for byte", async (t) => {
  const sb = makeSandbox(t);
  const allBytes = Buffer.alloc(256 * 1000);
  for (let i = 0; i < allBytes.length; i += 1) allBytes[i] = i % 256;
  const cases: readonly [string, Buffer][] = [
    ["every byte value", allBytes],
    ["empty", Buffer.alloc(0)],
    ["one byte", Buffer.from([0])],
    ["invalid utf-8", Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xf0, 0x28, 0x8c, 0x28, 0x0a])],
    ["over 64 KiB", patternBytes(RECORD_COPY_CAP_BYTES * 5 + 17)],
    ["3 MiB", patternBytes(3 * MIB)],
  ];
  for (const [name, input] of cases) {
    const r = await runBin(["record"], input, sb.env);
    assert.equal(r.code, 0, name);
    assert.equal(r.stderr, "", name);
    assert.ok(r.stdout.equals(input), `${name}: output differs from input`);
  }
  // None of these is a statusline JSON, so the data folder is never made.
  assert.equal(existsSync(sb.dataDir), false);
});

test("bin record: a missing data folder is created 0700 and used", async (t) => {
  const sb = makeSandbox(t);
  assert.equal(existsSync(sb.dataDir), false);
  const r = await runBin(["record"], realStatus(), sb.env);
  assert.equal(r.code, 0);
  assert.equal(modeOf(sb.dataDir), 0o700);
  assert.ok(existsSync(join(sb.dataDir, QUOTA_LATEST_FILE)));
});

test("bin record: a data folder that cannot be made gives a full pass-through and exit 0", async (t) => {
  const sb = makeSandbox(t);
  const blocker = sb.path("blocker");
  writeFileSync(blocker, "a file, not a folder");
  const input = realStatus();
  const r = await runBin(["record"], input, { ...sb.env, TOKENMETER_DATA_DIR: join(blocker, "data") });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.toString("utf8"), input);
  assert.equal(readText(blocker), "a file, not a folder");
});

test("bin record: a group writable data folder is refused, with a full pass-through and exit 0", async (t) => {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { mode: 0o700 });
  chmodSync(sb.dataDir, 0o777);
  const input = realStatus();
  const r = await runBin(["record"], input, sb.env);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.toString("utf8"), input);
  assert.deepEqual(readdirSync(sb.dataDir), []);
  assert.equal(modeOf(sb.dataDir), 0o777);
});

test("bin record: a symlinked data folder is refused, with a full pass-through and exit 0", async (t) => {
  const sb = makeSandbox(t);
  const target = sb.path("elsewhere");
  mkdirSync(target, { mode: 0o700 });
  symlinkSync(target, sb.dataDir);
  const input = realStatus();
  const r = await runBin(["record"], input, sb.env);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.toString("utf8"), input);
  assert.deepEqual(readdirSync(target), []);
});

test("bin record: only the rate limits are stored; the canary is in no data file and not on stderr", async (t) => {
  const sb = makeSandbox(t);
  const input = realStatus();
  assert.ok(input.includes(CANARY));
  const r = await runBin(["record"], input, sb.env);
  assert.equal(r.code, 0);
  assert.ok(r.stdout.toString("utf8").includes(CANARY), "the canary passes through to stdout");
  assert.equal(r.stderr.includes(CANARY), false);
  const files = allFiles(sb.dataDir);
  assert.ok(files.length >= 2, "the latest file and a sample file");
  for (const file of files) {
    assert.equal(readText(file).includes(CANARY), false, file);
    for (const word of ["sess-", "transcript", "display_name", "/work/", "current_dir", "output_style"]) {
      assert.equal(readText(file).includes(word), false, `${file} holds ${word}`);
    }
  }
  assert.deepEqual(allFiles(sb.home), [], "nothing is written under the sandbox home");
});

test("bin record: a sample is written only on a change", async (t) => {
  const sb = makeSandbox(t);
  const first = realStatus({ five: 12.5, week: 40 });
  await runBin(["record"], first, sb.env);
  const count = (): number => sampleFiles(sb.dataDir).flatMap((f) => linesOf(join(sb.dataDir, f))).length;
  assert.equal(count(), 2);
  await runBin(["record"], realStatus({ five: 12.5, week: 40 }), sb.env);
  await runBin(["record"], realStatus({ five: 12.5, week: 40 }), sb.env);
  assert.equal(count(), 2, "same values, no new sample");
  await runBin(["record"], realStatus({ five: 13, week: 40 }), sb.env);
  assert.equal(count(), 3, "one limit changed, one new sample");
  await runBin(["record"], realStatus({ five: 13, week: 41 }), sb.env);
  assert.equal(count(), 4);
});

test("bin record: the latest five hour and seven day values and reset times, stale and bad ones read as unknown", async (t) => {
  const sb = makeSandbox(t);
  const now = Date.now();
  const five = Math.round((now + HOUR_MS) / 1000);
  const week = Math.round((now + 2 * DAY_MS) / 1000);
  const input = statusJson({ five: { pct: 33.3, reset: five }, week: { pct: 71, reset: week } }, now);
  await runBin(["record"], input, sb.env);
  const view = readLatestQuota(sb.dataDir, Date.now(), BASE_DEPS);
  assert.ok(view.five_hour.known && view.five_hour.usedPercent === 33.3 && view.five_hour.resetsAt === five * 1000);
  assert.ok(view.week.known && view.week.usedPercent === 71 && view.week.resetsAt === week * 1000);
  // The same file, read after both reset times: both unknown.
  const later = readLatestQuota(sb.dataDir, week * 1000 + 1, BASE_DEPS);
  assert.deepEqual(later, { five_hour: { known: false, reason: "stale" }, week: { known: false, reason: "stale" } });
  // A statusline with a bad percent never reaches the file.
  const bad = statusJson({ five: { pct: 250, reset: five }, week: null }, now);
  const r = await runBin(["record"], bad, sb.env);
  assert.equal(r.code, 0);
  const kept = readLatestQuota(sb.dataDir, Date.now(), BASE_DEPS).five_hour;
  assert.ok(kept.known && kept.usedPercent === 33.3, "the old value stays");
});

test("bin record: with Node too old, the input still passes through, exit 0, empty stderr", async (t) => {
  const sb = makeSandbox(t);
  const preload = sb.path("old-node.cjs");
  writeFileSync(
    preload,
    'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "20.11.0" }, configurable: true });\n',
  );
  const input = realStatus();
  const r = await runBin(["record"], input, { ...sb.env, NODE_OPTIONS: `--require=${preload}` });
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.equal(r.stdout.toString("utf8"), input);
  assert.equal(existsSync(sb.dataDir), false, "no store work on an old Node");
});

test("bin record: when the record module cannot be imported, the input still passes through, exit 0", async (t) => {
  const sb = makeSandbox(t);
  const shimDir = sb.path("shim", "bin");
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, "tokenmeter.js");
  copyFileSync(BIN, shim);
  chmodSync(shim, 0o755);
  const input = patternBytes(200 * KIB);
  const r = await runBin(["record"], input, sb.env, shim);
  assert.equal(r.code, 0);
  assert.equal(r.stderr, "");
  assert.ok(r.stdout.equals(input));
});

test("bin: an unknown command prints a JSON usage_error, and node_too_old on an old Node", async (t) => {
  const sb = makeSandbox(t);
  const r = await runBin(["bogus"], "", sb.env);
  assert.equal(r.stderr, "");
  assert.deepEqual(JSON.parse(r.stdout.toString("utf8")), { schema: SCHEMA_ID, ok: false, error: errorRecord("usage_error") });
  assert.equal(r.code, 2);

  const none = await runBin([], "", sb.env);
  assert.equal(JSON.parse(none.stdout.toString("utf8")).error.code, "usage_error");

  const preload = sb.path("old-node.cjs");
  writeFileSync(
    preload,
    'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "21.7.3" }, configurable: true });\n',
  );
  const old = await runBin(["status"], "", { ...sb.env, NODE_OPTIONS: `--require=${preload}` });
  assert.deepEqual(JSON.parse(old.stdout.toString("utf8")), { schema: SCHEMA_ID, ok: false, error: errorRecord("node_too_old") });
  assert.equal(old.code, 1);
});

test("bin record: the median start stays near a bare Node start", async (t) => {
  const sb = makeSandbox(t);
  const baseline = writeBaselineScript(sb.path("baseline.js"));
  const { baselineMs, commandMs } = await measurePaired(
    TIMING_RUNS,
    async () => {
      const r = await runBin([], "", sb.env, baseline);
      assert.equal(r.code, 0);
      return r.ms;
    },
    async (i) => {
      const r = await runBin(["record"], realStatus({ five: 10 + i / 2, week: 30 + i / 4 }), sb.env);
      assert.equal(r.code, 0);
      assert.equal(r.stderr, "");
      return r.ms;
    },
  );
  const verdict = judgeTiming(commandMs, baselineMs);
  t.diagnostic(verdict.detail);
  assert.ok(verdict.ok, verdict.detail);
});

test("bin record: the timing check fails for a planted 1 s start delay", async (t) => {
  const sb = makeSandbox(t);
  const baseline = writeBaselineScript(sb.path("baseline.js"));
  const preload = sb.path("slow-start.cjs");
  writeFileSync(preload, "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);\n");
  const slowEnv = { ...sb.env, NODE_OPTIONS: `--require=${preload}` };
  const { baselineMs, commandMs } = await measurePaired(
    3,
    async () => (await runBin([], "", sb.env, baseline)).ms,
    async (i) => {
      const r = await runBin(["record"], realStatus({ five: 10 + i, week: 30 + i }), slowEnv);
      assert.equal(r.code, 0);
      return r.ms;
    },
  );
  const verdict = judgeTiming(commandMs, baselineMs);
  t.diagnostic(verdict.detail);
  assert.equal(verdict.ok, false, verdict.detail);
});
