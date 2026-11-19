// Tests for the estimate log files: TP-23 to TP-26, TP-45 to TP-47, TP-63 and
// TP-69. The log is one month file for each UTC month, estimates-YYYY-MM.jsonl,
// in the data folder. The scoring and the keep time are pure and are tested in
// estimator.test.ts. Here the files are real, inside a sandbox.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { totalsOf } from "../src/analysis.ts";
import {
  ESTIMATE_LOG_CAP_BYTES,
  type MonthAccess,
  appendEstimateLines,
  estimateLogFile,
  isEstimateLogFile,
  logLineText,
  parseLogLine,
  pruneEstimateLog,
  readEstimateLog,
} from "../src/estimate-log.ts";
import {
  type EstimateItem,
  type EstimateLogLine,
  type FinishedTask,
  type NoBasisLogLine,
  type RangedLogLine,
  type SignalEstimate,
  keepTime,
  newLogLines,
  selfCheck,
} from "../src/estimator.ts";
import { type FsDeps, defaultDeps } from "../src/fsafe.ts";
import { isStoreFileName } from "../src/store.ts";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-03T12:00:00Z");
const DEPS: FsDeps = { ...defaultDeps(), nowMs: () => NOW };
// What a read of a log that is whole tells the append: every month was read.
const ALL_READ: MonthAccess = { unreadMonths: [], listingComplete: true };

function depsAt(nowMs: number): FsDeps {
  return { ...defaultDeps(), nowMs: () => nowMs };
}

// The data folder of a fresh sandbox.
function folder(t: TestContext): { readonly dir: string; readonly elsewhere: string } {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { mode: 0o700 });
  return { dir: sb.dataDir, elsewhere: sb.path("elsewhere.jsonl") };
}

function put(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text, { mode: 0o600 });
}

function logged(key: string, at: number, over: Partial<RangedLogLine> = {}): RangedLogLine {
  return { at, key, basis: "wide", basisName: "all", features: [], stage: null, basisProject: null, low: 100, high: 400, ...over };
}

function loggedNone(key: string, at: number, stage: string | null = null): NoBasisLogLine {
  return { at, key, basis: "none", basisName: "none", features: [], stage, basisProject: null, low: null, high: null };
}

// The month file of a valid time.
function fileOf(at: number): string {
  const name = estimateLogFile(at);
  assert.ok(name !== null, `no month file for ${at}`);
  return name;
}

function linesText(...lines: readonly EstimateLogLine[]): string {
  return lines.map((line) => `${logLineText(line)}\n`).join("");
}

function item(key: string, features: Record<string, number>): EstimateItem {
  return { key, tags: {}, features };
}

function estimateOf(key: string, basisName: string): SignalEstimate {
  const wide = basisName === "all" || basisName === "type";
  return {
    key,
    subscription: "claude",
    basis: wide ? "wide" : "similar",
    basisName,
    label: wide ? "wide, low confidence" : "similar",
    lowPct: 1,
    highPct: 4,
    rawLow: 100,
    rawHigh: 400,
    weightedLow: 100,
    weightedHigh: 400,
    count: 9,
    open: false,
    rough: false,
    typicalPct: 2,
    budgetPct: 3,
  };
}

function names(dir: string): string[] {
  return readdirSync(dir).sort();
}

// `count` valid feature names, f01, f02, and so on, in the order the writer sorts them.
function featureNames(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `f${String(i + 1).padStart(2, "0")}`);
}

// ---------------------------------------------------------------------------
// Names and lines
// ---------------------------------------------------------------------------

test("a month file is named after the UTC month of the line time", () => {
  assert.equal(estimateLogFile(Date.parse("2026-10-31T23:59:59.999Z")), "estimates-2026-10.jsonl");
  assert.equal(estimateLogFile(Date.parse("2026-11-01T00:00:00Z")), "estimates-2026-11.jsonl");
  assert.equal(estimateLogFile(Date.parse("2026-02-01T05:00:00+10:00")), "estimates-2026-01.jsonl");
});

test("a time that is not valid names no month file", () => {
  assert.equal(estimateLogFile(Number.NaN), null);
  assert.equal(estimateLogFile(Number.POSITIVE_INFINITY), null);
});

test("TP-24: the estimate log file names stay out of the store file name check", () => {
  for (const name of ["estimates-2026-11.jsonl", "estimates-2026-01.jsonl", fileOf(NOW)]) {
    assert.equal(isEstimateLogFile(name), true, name);
    assert.equal(isStoreFileName(name), false, name);
  }
  for (const name of ["store.json", "ledger.json", "buckets-2026-11.json", "dedupe-2026-11-03.json"]) {
    assert.equal(isStoreFileName(name), true, name);
    assert.equal(isEstimateLogFile(name), false, name);
  }
});

test("a line is one line of JSON and reads back as it was written", () => {
  const lines = [
    logged("A", NOW, { basis: "similar", basisName: "issue_bytes", features: ["churn", "issue_bytes"], low: 1234.5, high: 99999 }),
    loggedNone("B", NOW),
    logged("C", NOW, { basis: "similar", basisName: "churn+files", features: ["churn", "files"] }),
    // The model names stay valid basis names, although no feature may take one.
    logged("D", NOW, { basisName: "type" }),
    logged("E", NOW),
  ];
  for (const line of lines) {
    const text = logLineText(line);
    assert.equal(/[\r\n]/.test(text), false);
    assert.deepEqual(parseLogLine(text, NOW), line);
  }
});

test("a spent line, with the basis wide, the name spent and the stage run, reads back as it was written", () => {
  const line = logged("A", NOW, { basisName: "spent", stage: "run" });
  const text = logLineText(line);
  assert.equal((JSON.parse(text) as Record<string, unknown>)["basis_name"], "spent");
  assert.deepEqual(parseLogLine(text, NOW), line);
});

test("a line with sixteen feature names reads back as it was written", () => {
  const line = logged("A", NOW, { basis: "similar", basisName: "f01", features: featureNames(16) });
  assert.deepEqual(parseLogLine(logLineText(line), NOW), line);
});

test("TP-119: a line writes stage and project scope in order, with null scope for a shared basis or no basis", () => {
  const lines = [
    logged("A", NOW),
    logged("B", NOW, { stage: "issue", basisProject: "alpha" }),
    loggedNone("C", NOW),
    loggedNone("D", NOW, "plan"),
  ];
  for (const line of lines) {
    const text = logLineText(line);
    const written = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(written), ["at", "key", "basis", "basis_name", "features", "stage", "basis_project", "low", "high"]);
    assert.equal(written["stage"], line.stage);
    assert.equal(written["basis_project"], line.basisProject);
    assert.deepEqual(parseLogLine(text, NOW), line);
  }
});

test("TP-119: a line with no project scope reads with null scope", () => {
  const old = '{"at":' + NOW + ',"key":"A","basis":"wide","basis_name":"all","features":[],"stage":null,"low":100,"high":400}';
  assert.equal(parseLogLine(old, NOW)?.basisProject, null);
});

test("TP-119: the log keeps a change from shared to project scope but not a repeat", (t) => {
  const { dir } = folder(t);
  const shared = logged("A", NOW - DAY_MS);
  const scoped = logged("A", NOW - 2, { basisProject: "alpha" });
  const repeat = { ...scoped, at: NOW - 1 };
  put(dir, fileOf(NOW), linesText(shared, scoped, repeat));
  assert.deepEqual(readEstimateLog(dir, NOW, DEPS).lines, [shared, scoped]);
});

test("TP-120: invalid project scopes and project scopes with no basis make a line invalid", () => {
  const ranged = JSON.parse(logLineText(logged("A", NOW))) as Record<string, unknown>;
  for (const scope of ["", "has space", "a".repeat(65), 7, true, {}, []]) {
    assert.equal(parseLogLine(JSON.stringify({ ...ranged, basis_project: scope }), NOW), null);
  }
  const none = JSON.parse(logLineText(loggedNone("A", NOW))) as Record<string, unknown>;
  assert.equal(parseLogLine(JSON.stringify({ ...none, basis_project: "alpha" }), NOW), null);
});

test("a line with no stage key, or with stage null, reads with stage null", () => {
  const good = JSON.parse(logLineText(logged("A", NOW, { stage: "issue" }))) as Record<string, unknown>;
  assert.equal(parseLogLine(JSON.stringify(good), NOW)?.stage, "issue");
  const { stage: _written, ...absent } = good;
  assert.equal(Object.hasOwn(absent, "stage"), false);
  assert.equal(parseLogLine(JSON.stringify(absent), NOW)?.stage, null, "an older line has no stage key");
  assert.equal(parseLogLine(JSON.stringify({ ...good, stage: null }), NOW)?.stage, null);
});

test("a stage that is not a label makes the whole line invalid", () => {
  const good = JSON.parse(logLineText(logged("A", NOW))) as Record<string, unknown>;
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ["a stage with a space", "has space"],
    ["a numeric stage", 7],
    ["a stage of 65 characters", "a".repeat(65)],
    ["an empty stage", ""],
    ["an object stage", { name: "issue" }],
    ["a list stage", ["issue"]],
    ["a true stage", true],
  ];
  for (const [name, stage] of bad) assert.equal(parseLogLine(JSON.stringify({ ...good, stage }), NOW), null, name);
  assert.notEqual(parseLogLine(JSON.stringify({ ...good, stage: "a".repeat(64) }), NOW), null, "64 characters is the longest label");
});

test("the stage labels __proto__, constructor and toString read back as the own stage of the line", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  for (const stage of ["__proto__", "constructor", "toString"]) {
    const line = parseLogLine(logLineText(logged("A", NOW, { stage })), NOW);
    assert.equal(line?.stage, stage);
    assert.ok(line !== null && Object.hasOwn(line, "stage"));
    assert.equal(Object.getPrototypeOf(line), Object.prototype);
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

test("a line that is not valid reads as null", () => {
  // The good line as it is stored, then one stored field changed for each case.
  const good = JSON.parse(logLineText(logged("A", NOW))) as Record<string, unknown>;
  assert.notEqual(parseLogLine(JSON.stringify(good), NOW), null);
  const bad: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["a time before 2020", { at: Date.UTC(2019, 11, 31) }],
    ["a time after now", { at: NOW + 3_600_000 }],
    ["a time that is text", { at: "2026-11-03" }],
    ["a key with a space", { key: "bad key" }],
    ["a basis word that is unknown", { basis: "sure" }],
    ["a basis name with capitals", { basis_name: "Size" }],
    ["a basis name with three parts", { basis_name: "a+b+c" }],
    ["a feature name that is reserved", { features: ["constructor"] }],
    ["a feature name that is a model name", { features: ["all"] }],
    ["a feature name that is spent", { features: ["spent"] }],
    ["a pair with a model name", { basis: "similar", basis_name: "all+files" }],
    ["a pair with the name spent", { basis: "similar", basis_name: "spent+size" }],
    ["a pair that ends in the name spent", { basis: "similar", basis_name: "size+spent" }],
    ["a feature list that is not a list", { features: "size" }],
    ["more than sixteen features", { features: featureNames(17) }],
    ["the same feature twice", { features: ["size", "size"] }],
    ["a low end of zero", { low: 0 }],
    ["a low end above the high end", { low: 500, high: 400 }],
    ["a range that is not a number", { high: "400" }],
    ["a range on a line with no basis", { basis: "none", basis_name: "none" }],
    ["no range on a line with a basis", { low: null, high: null }],
    ["a name on a line with no basis", { basis: "none", low: null, high: null }],
  ];
  for (const [name, change] of bad) assert.equal(parseLogLine(JSON.stringify({ ...good, ...change }), NOW), null, name);
  for (const text of ["", "not json", "[]", "null", "7", "{}"]) assert.equal(parseLogLine(text, NOW), null, text);
  // JSON.stringify writes a high end past the largest number as null, so this one is written by hand.
  const infinite = logLineText(logged("A", NOW)).replace('"high":400', '"high":1e999');
  assert.ok(infinite.includes("1e999"));
  assert.equal(parseLogLine(infinite, NOW), null, "a high end that is not finite");
});

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

test("TP-23: a pass writes a line only when the key, the basis or the feature names change", (t) => {
  const { dir } = folder(t);
  const pass = (items: readonly EstimateItem[], estimates: readonly SignalEstimate[], at: number): number => {
    const read = readEstimateLog(dir, at, depsAt(at));
    const fresh = newLogLines(items, estimates, read.lines, at);
    const report = appendEstimateLines(dir, fresh, read, depsAt(at));
    assert.deepEqual(report, { appended: fresh.length, full: 0, failed: 0 });
    return fresh.length;
  };
  const a = item("A", { size: 5 });
  const b = item("B", {});
  const onSize = [estimateOf("A", "size"), estimateOf("B", "all")];
  const onType = [estimateOf("A", "type"), estimateOf("B", "all")];
  assert.equal(pass([a, b], onSize, NOW), 2);
  assert.equal(pass([a, b], onSize, NOW + 60_000), 0, "the same state is not written again");
  assert.equal(pass([item("A", { size: 900 }), b], onSize, NOW + 120_000), 0, "a new value is no change");
  assert.equal(pass([a, b], onType, NOW + 180_000), 1, "a new basis name");
  assert.equal(pass([item("A", { size: 5, churn: 3 }), b], onType, NOW + 240_000), 1, "a new feature name");
  assert.equal(pass([a, b, item("C", {})], [...onSize, estimateOf("C", "all")], NOW + 300_000), 2, "A is back on size, and C is new");
  const file = readFileSync(join(dir, fileOf(NOW)), "utf8");
  assert.equal(file.split("\n").length, 7, "six lines and the end of the last one");
});

test("a pass writes a new line when only the stage changes, the read keeps both lines, and a repeat writes none", (t) => {
  const { dir } = folder(t);
  const pass = (stage: string, at: number): readonly EstimateLogLine[] => {
    const read = readEstimateLog(dir, at, depsAt(at));
    const fresh = newLogLines([{ key: "A", tags: { stage }, features: {} }], [estimateOf("A", "all")], read.lines, at);
    appendEstimateLines(dir, fresh, read, depsAt(at));
    return fresh;
  };
  assert.equal(pass("issue", NOW).length, 1);
  assert.equal(pass("issue", NOW + 60_000).length, 0, "the same stage is not written again");
  assert.equal(pass("plan", NOW + 120_000).length, 1, "a new stage with the same basis");
  assert.equal(pass("plan", NOW + 180_000).length, 0);
  const lines = readEstimateLog(dir, NOW + 240_000, depsAt(NOW + 240_000)).lines;
  assert.deepEqual(lines.map((l) => l.stage), ["issue", "plan"]);
});

test("TP-25: an append to a month file at or above the cap is refused, and the file stays as it was", (t) => {
  const { dir } = folder(t);
  const file = join(dir, fileOf(NOW));
  put(dir, fileOf(NOW), "x".repeat(ESTIMATE_LOG_CAP_BYTES));
  assert.deepEqual(appendEstimateLines(dir, [logged("A", NOW), logged("B", NOW)], ALL_READ, DEPS), { appended: 0, full: 2, failed: 0 });
  assert.equal(statSync(file).size, ESTIMATE_LOG_CAP_BYTES);

  put(dir, fileOf(NOW), "x".repeat(ESTIMATE_LOG_CAP_BYTES + 10));
  assert.equal(appendEstimateLines(dir, [logged("A", NOW)], ALL_READ, DEPS).full, 1, "over the cap");
});

test("TP-25 and TP-133: a file below the cap takes one maximum-size scoped line and still reads it", (t) => {
  const { dir } = folder(t);
  const file = join(dir, fileOf(NOW));
  const features = featureNames(16).map((name) => name.padEnd(16, "a"));
  const line = logged("a".repeat(64), NOW, {
    basis: "similar", basisName: features.slice(0, 2).join("+"), features,
    stage: "b".repeat(64), basisProject: "c".repeat(64), low: 1.0000000000000002e-307, high: Number.MAX_VALUE,
  });
  const before = ESTIMATE_LOG_CAP_BYTES - 1;
  put(dir, fileOf(NOW), `${"x".repeat(before - 1)}\n`);
  assert.deepEqual(appendEstimateLines(dir, [line, logged("B", NOW)], ALL_READ, DEPS), { appended: 1, full: 1, failed: 0 });
  assert.equal(statSync(file).size, before + Buffer.byteLength(linesText(line)));
  assert.deepEqual(readEstimateLog(dir, NOW, DEPS).lines, [line]);
});

test("TP-122: an invalid or noncanonical line counts as failed and leaves the file unchanged", (t) => {
  const { dir } = folder(t);
  const file = fileOf(NOW);
  const before = linesText(logged("A", NOW));
  put(dir, file, before);
  const badScope = { ...logged("B", NOW), basisProject: "has space" };
  const badRange = logged("C", NOW, { low: 500 });
  const unordered = logged("D", NOW, { features: ["size", "files"] });
  assert.deepEqual(appendEstimateLines(dir, [badScope, badRange, unordered], ALL_READ, DEPS), { appended: 0, full: 0, failed: 3 });
  assert.equal(readFileSync(join(dir, file), "utf8"), before);
});

test("TP-25: a symlinked month file is refused and its target is not changed", (t) => {
  const { dir, elsewhere } = folder(t);
  writeFileSync(elsewhere, "target\n", { mode: 0o600 });
  symlinkSync(elsewhere, join(dir, fileOf(NOW)));
  assert.deepEqual(appendEstimateLines(dir, [logged("A", NOW)], ALL_READ, DEPS), { appended: 0, full: 0, failed: 1 });
  assert.equal(readFileSync(elsewhere, "utf8"), "target\n");
  assert.ok(lstatSync(join(dir, fileOf(NOW))).isSymbolicLink());
});

test("an append to a month file that the group or others can access is refused, as the read refuses it", (t) => {
  const { dir } = folder(t);
  const file = join(dir, fileOf(NOW));
  put(dir, fileOf(NOW), linesText(logged("OLD", NOW - DAY_MS)));
  const before = statSync(file).size;
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    chmodSync(file, mode);
    assert.deepEqual(appendEstimateLines(dir, [logged("A", NOW)], ALL_READ, DEPS), { appended: 0, full: 0, failed: 1 }, mode.toString(8));
    assert.equal(readEstimateLog(dir, NOW, DEPS).damaged, 1, `the read refuses ${mode.toString(8)} too`);
  }
  assert.equal(statSync(file).size, before);
  chmodSync(file, 0o600);
  assert.deepEqual(appendEstimateLines(dir, [logged("A", NOW)], ALL_READ, DEPS), { appended: 1, full: 0, failed: 0 });
});

test("a line for a month that the pass did not read is not written, and a line for a month that it read is", (t) => {
  const { dir } = folder(t);
  const october = Date.parse("2026-10-20T00:00:00Z");
  put(dir, fileOf(october), linesText(logged("OLD", october)));
  const before = statSync(join(dir, fileOf(october))).size;
  // The October file looks safe, but the pass did not read it.
  const access: MonthAccess = { unreadMonths: ["2026-10"], listingComplete: true };
  assert.deepEqual(appendEstimateLines(dir, [logged("A", october), logged("B", NOW)], access, DEPS), { appended: 1, full: 0, failed: 1 });
  assert.equal(statSync(join(dir, fileOf(october))).size, before);
  assert.deepEqual(names(dir), ["estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);
});

test("with a folder listing that was cut short or failed, no line is written", (t) => {
  const { dir } = folder(t);
  const access: MonthAccess = { unreadMonths: [], listingComplete: false };
  assert.deepEqual(appendEstimateLines(dir, [logged("A", NOW), logged("B", NOW)], access, DEPS), { appended: 0, full: 0, failed: 2 });
  assert.deepEqual(names(dir), []);
});

test("a line with a time that is not valid is not written and is counted as failed", (t) => {
  const { dir } = folder(t);
  assert.deepEqual(appendEstimateLines(dir, [logged("A", Number.NaN), logged("B", NOW)], ALL_READ, DEPS), { appended: 1, full: 0, failed: 1 });
  assert.deepEqual(names(dir), ["estimates-2026-11.jsonl"]);
});

test("TP-122: an append refuses a time that names no readable month file", (t) => {
  const { dir } = folder(t);
  const at = Date.UTC(10_000, 0, 1);
  assert.deepEqual(appendEstimateLines(dir, [logged("A", at)], ALL_READ, depsAt(at)), { appended: 0, full: 0, failed: 1 });
  assert.deepEqual(names(dir), []);
});

test("a line goes to the month file of its own UTC time", (t) => {
  const { dir } = folder(t);
  const october = Date.parse("2026-10-31T23:59:59Z");
  const report = appendEstimateLines(dir, [logged("A", october), logged("B", NOW)], ALL_READ, DEPS);
  assert.deepEqual(report, { appended: 2, full: 0, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);
  assert.equal(statSync(join(dir, "estimates-2026-11.jsonl")).mode & 0o777, 0o600);
});

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

test("TP-26: bad lines are skipped, a repeat of the last state is removed, and lines come in time order", (t) => {
  const { dir } = folder(t);
  const t1 = NOW - 3 * DAY_MS;
  const first = logged("A", t1, { basis: "similar", basisName: "size", features: ["size"] });
  const repeat = { ...first, at: t1 + 1000, low: 5, high: 6 };
  const changed = logged("A", t1 + 2000);
  const back = { ...first, at: t1 + 3000 };
  const other = logged("B", t1 + 500);
  const october = Date.parse("2026-10-30T00:00:00Z");
  put(dir, "estimates-2026-11.jsonl", `not json\n${linesText(first, repeat, changed)}{"at":1}\n\n${linesText(back, other)}`);
  put(dir, "estimates-2026-10.jsonl", linesText(logged("OLD", october)));
  const read = readEstimateLog(dir, NOW, DEPS);
  assert.deepEqual(read.lines.map((l) => [l.key, l.at]), [["OLD", october], ["A", t1], ["B", t1 + 500], ["A", t1 + 2000], ["A", t1 + 3000]]);
  assert.deepEqual([read.damaged, read.atCap], [0, 0], "a bad line is skipped and is not damage");
});

test("a folder with no estimate log reads as no lines and no damage", (t) => {
  const { dir } = folder(t);
  put(dir, "store.json", "{}");
  const none = { lines: [], damaged: 0, atCap: 0, unreadMonths: [], listingComplete: true };
  assert.deepEqual(readEstimateLog(dir, NOW, DEPS), none);
  assert.deepEqual(readEstimateLog(join(dir, "missing"), NOW, DEPS), none);
});

test("the read judges a line by the time that the caller gives, not by the clock of its own deps", (t) => {
  const { dir } = folder(t);
  put(dir, "estimates-2026-11.jsonl", linesText(logged("A", NOW - DAY_MS)));
  assert.deepEqual(readEstimateLog(dir, NOW, DEPS).lines.map((l) => l.key), ["A"]);
  assert.deepEqual(readEstimateLog(dir, NOW - 2 * DAY_MS, DEPS).lines, [], "the line is later than the time that the caller gave");
  assert.equal(readEstimateLog(dir, NOW - 2 * DAY_MS, DEPS).damaged, 0, "a line that is too new is skipped and is not damage");
});

test("at most 24 months are read, the newest ones", (t) => {
  const { dir } = folder(t);
  for (let index = 0; index < 26; index += 1) {
    const at = Date.UTC(2024, index, 10);
    put(dir, fileOf(at), linesText(logged(`M${index}`, at)));
  }
  const read = readEstimateLog(dir, NOW, DEPS);
  assert.equal(read.lines.length, 24);
  assert.equal(read.lines[0]?.key, "M2");
  assert.equal(read.lines[23]?.key, "M25");
  assert.deepEqual(read.unreadMonths, ["2024-01", "2024-02"], "the two oldest months were not read");
  assert.equal(read.damaged, 0);
});

test("TP-69: a month file at or above the cap is counted, and one just below it is not", (t) => {
  const { dir } = folder(t);
  put(dir, "estimates-2026-08.jsonl", "x".repeat(ESTIMATE_LOG_CAP_BYTES - 1));
  put(dir, "estimates-2026-09.jsonl", "x".repeat(ESTIMATE_LOG_CAP_BYTES));
  put(dir, "estimates-2026-10.jsonl", "x".repeat(ESTIMATE_LOG_CAP_BYTES + 100));
  const read = readEstimateLog(dir, NOW, DEPS);
  assert.equal(read.atCap, 2);
  assert.equal(read.damaged, 0);
});

test("a month file over the read cap, a link and a file that others can read are damage, and their lines are not read", (t) => {
  const { dir, elsewhere } = folder(t);
  put(dir, "estimates-2026-07.jsonl", `${"x".repeat(ESTIMATE_LOG_CAP_BYTES + 70 * 1024)}\n`);
  writeFileSync(elsewhere, linesText(logged("LINKED", NOW - DAY_MS)), { mode: 0o600 });
  symlinkSync(elsewhere, join(dir, "estimates-2026-08.jsonl"));
  put(dir, "estimates-2026-09.jsonl", linesText(logged("OPEN", NOW - DAY_MS)));
  chmodSync(join(dir, "estimates-2026-09.jsonl"), 0o644);
  put(dir, "estimates-2026-10.jsonl", linesText(logged("GOOD", NOW - DAY_MS)));
  const read = readEstimateLog(dir, NOW, DEPS);
  assert.equal(read.damaged, 3);
  assert.deepEqual(read.lines.map((l) => l.key), ["GOOD"]);
  assert.deepEqual(read.unreadMonths, ["2026-07", "2026-08", "2026-09"], "the three months that were not read");
  assert.equal(read.listingComplete, true);
});

test("a data folder with more names than one listing holds is damage, and its listing is not complete", (t) => {
  const { dir } = folder(t);
  put(dir, "estimates-2026-10.jsonl", linesText(logged("GOOD", NOW - DAY_MS)));
  for (let index = 0; index < 1001; index += 1) put(dir, `other-${index}.txt`, "");
  const read = readEstimateLog(dir, NOW, DEPS);
  assert.equal(read.damaged, 1);
  assert.equal(read.listingComplete, false);
});

test("a data folder that cannot be listed is damage, no line is read, and the prune counts a failure and deletes nothing", (t) => {
  const { dir } = folder(t);
  put(dir, "estimates-2026-05.jsonl", "old\n");
  chmodSync(dir, 0o000);
  try {
    const read = readEstimateLog(dir, NOW, DEPS);
    assert.deepEqual(read, { lines: [], damaged: 1, atCap: 0, unreadMonths: [], listingComplete: false });
    assert.deepEqual(pruneEstimateLog(dir, Date.UTC(2026, 9, 1)), { removed: 0, failed: 1 });
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual(names(dir), ["estimates-2026-05.jsonl"]);
});

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

function monthFiles(...months: readonly string[]): Record<string, string> {
  return Object.fromEntries(months.map((month) => [`estimates-${month}.jsonl`, `${month}\n`]));
}

test("TP-26: only month files older than the month of the keep time are deleted", (t) => {
  const { dir } = folder(t);
  for (const [name, text] of Object.entries(monthFiles("2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11"))) put(dir, name, text);
  assert.deepEqual(pruneEstimateLog(dir, Date.UTC(2026, 7, 20)), { removed: 3, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-08.jsonl", "estimates-2026-09.jsonl", "estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);
});

test("the first instant of a month keeps that month, and the last instant of the month before cuts at that one", (t) => {
  const { dir } = folder(t);
  for (const [name, text] of Object.entries(monthFiles("2026-06", "2026-07", "2026-08"))) put(dir, name, text);
  assert.deepEqual(pruneEstimateLog(dir, Date.UTC(2026, 7, 1)), { removed: 2, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-08.jsonl"]);
  for (const [name, text] of Object.entries(monthFiles("2026-06", "2026-07"))) put(dir, name, text);
  assert.deepEqual(pruneEstimateLog(dir, Date.UTC(2026, 7, 1) - 1), { removed: 1, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-07.jsonl", "estimates-2026-08.jsonl"]);
});

test("a keep time that is not valid deletes nothing", (t) => {
  const { dir } = folder(t);
  for (const [name, text] of Object.entries(monthFiles("2026-05", "2026-06"))) put(dir, name, text);
  assert.deepEqual(pruneEstimateLog(dir, Number.NaN), { removed: 0, failed: 0 });
  assert.deepEqual(pruneEstimateLog(dir, Number.POSITIVE_INFINITY), { removed: 0, failed: 0 });
  assert.equal(names(dir).length, 2);
});

test("TP-46: a name other than the exact month name is never deleted, and neither is a link or a folder", (t) => {
  const { dir, elsewhere } = folder(t);
  writeFileSync(elsewhere, "target\n", { mode: 0o600 });
  const others = [
    "estimates-2026-1.jsonl",
    "estimates-2026-01.jsonl.bak",
    "xestimates-2026-01.jsonl",
    "estimates-2026-13.jsonl",
    "estimates-2026-00.jsonl",
    "estimates-2026-01.json",
    "estimates-20260-01.jsonl",
    "ESTIMATES-2026-01.jsonl",
    "estimates-latest.jsonl",
    "quota-2026-01.jsonl",
    "status.json",
  ];
  for (const name of others) put(dir, name, "keep\n");
  symlinkSync(elsewhere, join(dir, "estimates-2026-02.jsonl"));
  mkdirSync(join(dir, "estimates-2026-03.jsonl"));
  put(dir, "estimates-2026-04.jsonl", "old\n");
  assert.deepEqual(pruneEstimateLog(dir, Date.UTC(2026, 9, 15)), { removed: 1, failed: 0 });
  assert.deepEqual(names(dir), [...others, "estimates-2026-02.jsonl", "estimates-2026-03.jsonl"].sort());
  assert.ok(lstatSync(join(dir, "estimates-2026-02.jsonl")).isSymbolicLink());
  assert.equal(readFileSync(elsewhere, "utf8"), "target\n");
  assert.ok(existsSync(join(dir, "estimates-2026-03.jsonl")));
});

test("a prune with no keep time deletes nothing", (t) => {
  const { dir } = folder(t);
  for (const [name, text] of Object.entries(monthFiles("2020-01", "2026-05"))) put(dir, name, text);
  assert.deepEqual(pruneEstimateLog(dir, null), { removed: 0, failed: 0 });
  assert.equal(names(dir).length, 2);
});

// A state of the log for the pruning rules: thirty finished tasks that ended in
// November 2026, each with a line in October.
function thirtyFinished(): FinishedTask[] {
  return Array.from({ length: 30 }, (_, i): FinishedTask => ({
    label: `K${i}`,
    start: Date.UTC(2026, 9, 20),
    end: Date.UTC(2026, 10, 1 + i),
    totals: { claude: totalsOf([200, 0, 0, 0, 0]), codex: totalsOf([0, 0, 0, 0, 0]) },
  }));
}

function octoberLines(): EstimateLogLine[] {
  return thirtyFinished().map((task) => logged(task.label, Date.UTC(2026, 9, 15)));
}

test("TP-45: a long-open item keeps its month file, so its last line is still read when the item finishes", (t) => {
  const { dir } = folder(t);
  const july = Date.UTC(2026, 6, 20);
  put(dir, "estimates-2026-05.jsonl", linesText(logged("STALE", Date.UTC(2026, 4, 3))));
  put(dir, "estimates-2026-07.jsonl", linesText(logged("LONG", july)));
  put(dir, "estimates-2026-10.jsonl", linesText(...octoberLines()));
  const read = readEstimateLog(dir, NOW, DEPS);
  const keep = keepTime({ lines: read.lines, damaged: read.damaged > 0, finished: thirtyFinished(), openKeys: ["LONG"], windows: [] });
  assert.equal(keep, july);
  assert.deepEqual(pruneEstimateLog(dir, keep), { removed: 1, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-07.jsonl", "estimates-2026-10.jsonl"]);

  // The item finishes: its window ends after the line, and the line is still there to score.
  const totals = { claude: totalsOf([200, 0, 0, 0, 0]), codex: totalsOf([0, 0, 0, 0, 0]) };
  const long: FinishedTask = { label: "LONG", start: Date.UTC(2026, 10, 2), end: Date.UTC(2026, 10, 3), totals };
  assert.equal(selfCheck(readEstimateLog(dir, NOW, DEPS).lines, [long]).scored, 1);
});

test("an issue line in August and a plan line in October keep the August file, and the issue stage still scores after a prune", (t) => {
  const { dir } = folder(t);
  const finished = thirtyFinished();
  const five = finished.slice(0, 5);
  const august = Date.UTC(2026, 7, 15);
  const october = Date.UTC(2026, 9, 15);
  put(dir, "estimates-2026-08.jsonl", linesText(...five.map((task) => logged(task.label, august, { stage: "issue" }))));
  const planned = five.map((task) => logged(task.label, october, { stage: "plan" }));
  const rest = finished.slice(5).map((task) => logged(task.label, october));
  put(dir, "estimates-2026-10.jsonl", linesText(...planned, ...rest));
  const read = readEstimateLog(dir, NOW, DEPS);
  const keep = keepTime({ lines: read.lines, damaged: read.damaged > 0, finished, openKeys: [], windows: [] });
  assert.equal(keep, august);
  assert.deepEqual(pruneEstimateLog(dir, keep), { removed: 0, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-08.jsonl", "estimates-2026-10.jsonl"]);
  const after = selfCheck(readEstimateLog(dir, NOW, DEPS).lines, finished);
  assert.equal(after.stages.get("issue")?.scored, 5);
  assert.equal(after.stages.get("issue")?.hitRate, 1);
  assert.equal(after.stages.get("plan")?.scored, 5);
});

test("TP-47: with fewer than thirty finished tasks no month file is deleted", (t) => {
  const { dir } = folder(t);
  put(dir, "estimates-2026-01.jsonl", linesText(logged("OLD", Date.UTC(2026, 0, 5))));
  put(dir, "estimates-2026-10.jsonl", linesText(...octoberLines()));
  const read = readEstimateLog(dir, NOW, DEPS);
  const keep = keepTime({ lines: read.lines, damaged: read.damaged > 0, finished: thirtyFinished().slice(1), openKeys: [], windows: [] });
  assert.equal(keep, null);
  assert.deepEqual(pruneEstimateLog(dir, keep), { removed: 0, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-01.jsonl", "estimates-2026-10.jsonl"]);
});

test("TP-63: an item logged two months before its window starts keeps its month file while that window is among the thirty most recent", (t) => {
  const { dir } = folder(t);
  put(dir, "estimates-2026-05.jsonl", linesText(logged("STALE", Date.UTC(2026, 4, 3))));
  put(dir, "estimates-2026-06.jsonl", linesText(logged("STALE", Date.UTC(2026, 5, 3))));
  put(dir, "estimates-2026-07.jsonl", linesText(logged("K12", Date.UTC(2026, 6, 20))));
  put(dir, "estimates-2026-10.jsonl", linesText(...octoberLines().filter((l) => l.key !== "K12")));
  // K12 starts in September, two months after its line.
  const finished = thirtyFinished().map((task) => (task.label === "K12" ? { ...task, start: Date.UTC(2026, 8, 20) } : task));
  const read = readEstimateLog(dir, NOW, DEPS);
  const keep = keepTime({ lines: read.lines, damaged: read.damaged > 0, finished, openKeys: [], windows: [] });
  assert.equal(keep, Date.UTC(2026, 6, 20));
  assert.deepEqual(pruneEstimateLog(dir, keep), { removed: 2, failed: 0 });
  assert.deepEqual(names(dir), ["estimates-2026-07.jsonl", "estimates-2026-10.jsonl"]);
});
