// Tests for the pure estimator: one-signal and two-signal fits, the candidate
// selector, the honest range from leave-one-out errors, the lines of the estimate
// log and the self-check, and the queue sum. TP-8 to TP-16, TP-19, TP-23, TP-27,
// TP-28, TP-32 to TP-40, TP-43, TP-47, TP-50 to TP-52, TP-63 to TP-66 and TP-68.
//
// The 30-task fixture is a copy of a study data set. The test never reads the
// study folder. Tasks are labelled T01 to T30 in file order.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CALIBRATION_LABEL, type Calibration, NOT_READY_LABEL, totalsOf } from "../src/analysis.ts";
import {
  BASIS_ALL,
  BASIS_NONE,
  BASIS_SPENT,
  BASIS_TYPE,
  MODEL_BASIS_NAMES,
  SYNC_MAX_OPEN_ITEMS,
  isFeatureName,
  percentile,
  utcMonthOf,
} from "../src/core.ts";
import {
  type Candidate,
  type EstimateItem,
  type EstimateLogLine,
  type EstimateTask,
  type FinishedTask,
  type NoBasisLogLine,
  type QueueSum,
  type RangedLogLine,
  type ScoredPair,
  type SelfCheck,
  type SignalEstimate,
  type StageCheck,
  type WindowSpan,
  QUEUE_DRAWS,
  QUEUE_SEED,
  SELF_CHECK_TASKS,
  checkOf,
  estimateFromSignals,
  fitLine,
  fitPlane,
  hitRateBand,
  keepTime,
  newLogLines,
  nextQueueState,
  pctOfWeek,
  projectOf,
  queueSum,
  rangeShifts,
  scoreCandidates,
  scoreRatio,
  selfCheck,
} from "../src/estimator.ts";

test("TP-101: the own project tag takes precedence over the own repo tag", () => {
  assert.equal(projectOf({ project: "alpha" }), "alpha");
  assert.equal(projectOf({ repo: "beta" }), "beta");
  assert.equal(projectOf({ project: "alpha", repo: "beta" }), "alpha");
  assert.equal(projectOf({}), null);
});

test("TP-102: project tags use own entries and keep member names as values", () => {
  const inherited: Record<string, string> = {};
  Object.setPrototypeOf(inherited, { project: "alpha", repo: "beta" });
  assert.equal(projectOf({ project: "__proto__" }), "__proto__");
  assert.equal(projectOf({ project: "constructor" }), "constructor");
  assert.equal(projectOf({ repo: "toString" }), "toString");
  assert.equal(projectOf(inherited), null);
  const ownRepo = Object.setPrototypeOf({ repo: "gamma" }, { project: "alpha" });
  assert.equal(projectOf(ownRepo), "gamma");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Weighted tokens for 1 percent of the week. It is small, so the floor of the
// fits (0.1 percent of the week, 1 token here) sits under every cost of the tests
// that are not about the floor.
const PER_PCT = 10;

// The week of the tests that are about the floor: 1 percent is 1,000,000 weighted
// tokens, so the floor is 100,000.
const WEEK_PER_PCT = 1_000_000;
const FLOOR = WEEK_PER_PCT * 0.1;

function ready(perPctWeighted: number): Calibration {
  return { ready: true, perPctWeighted, confidence: "medium", intervals: 3, label: CALIBRATION_LABEL };
}

const CAL = { claude: ready(PER_PCT), codex: ready(PER_PCT) };
const WEEK_CAL = { claude: ready(WEEK_PER_PCT), codex: ready(WEEK_PER_PCT) };

// A deterministic source of numbers from 0 up to 1.
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `no element at ${index}`);
  return value;
}

// A finished task on claude, from its five token columns.
function taskFrom(columns: readonly number[], type: string | null, features: Record<string, number> = {}): EstimateTask {
  return {
    tags: type === null ? {} : { type },
    features,
    totals: { claude: totalsOf(columns), codex: totalsOf([0, 0, 0, 0, 0]) },
  };
}

// A finished task whose weighted tokens are `weighted` and whose raw tokens are the same.
function task(weighted: number, type: string | null, features: Record<string, number> = {}): EstimateTask {
  return taskFrom([weighted, 0, 0, 0, 0], type, features);
}

function item(key: string, type: string | null, features: Record<string, number> = {}, spent?: number): EstimateItem {
  return { key, tags: type === null ? {} : { type }, features, ...(spent === undefined ? {} : { spent }) };
}

function only(estimates: readonly SignalEstimate[]): SignalEstimate {
  assert.equal(estimates.length, 1);
  return at(estimates, 0);
}

function ranged(estimate: SignalEstimate): Extract<SignalEstimate, { basis: "similar" | "wide" }> {
  assert.ok(estimate.basis !== "none", "a basis was expected");
  return estimate;
}

function close(actual: number, expected: number, tolerance = 1e-9): void {
  const scale = Math.max(1, Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= tolerance * scale, `${actual} is not close to ${expected}`);
}

function candidateOf(candidates: readonly Candidate[], model: Candidate["model"]): Candidate | undefined {
  return candidates.find((c) => JSON.stringify(c.model) === JSON.stringify(model));
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length / 2;
  return sorted.length % 2 === 1 ? at(sorted, (sorted.length - 1) / 2) : (at(sorted, middle - 1) + at(sorted, middle)) / 2;
}

// Tasks whose cost follows a feature: log(cost) = 3 + 0.9 log(1 + size) + noise.
function sizeTasks(count: number, seed: number, name = "size"): EstimateTask[] {
  const rand = lcg(seed);
  return Array.from({ length: count }, (_, i) => {
    const z = 2 + 7 * rand();
    return task(Math.exp(3 + 0.9 * z + 0.5 * (rand() - 0.5)), `t${i % 3}`, { [name]: Math.expm1(z) });
  });
}

// Tasks with no feature and a cost that has nothing to do with the type.
function plainTasks(count: number, seed: number): EstimateTask[] {
  const rand = lcg(seed);
  return Array.from({ length: count }, (_, i) => task(Math.exp(5 + 3 * rand()), `t${i % 3}`));
}

// Tasks with two features: log(cost) = 1 + w1 z1 + w2 z2 + noise.
function pairTasks(count: number, seed: number, w1: number, w2: number, noise: number): EstimateTask[] {
  const rand = lcg(seed);
  return Array.from({ length: count }, (_, i) => {
    const z1 = 3 + 6 * rand();
    const z2 = 3 + 6 * rand();
    const y = 1 + w1 * z1 + w2 * z2 + noise * (rand() - 0.5);
    return task(Math.exp(y), `t${i % 3}`, { f1: Math.expm1(z1), f2: Math.expm1(z2) });
  });
}

// ---------------------------------------------------------------------------
// The 30-task fixture (cost in millions of weighted tokens, type, six features)
// ---------------------------------------------------------------------------

const FIXTURE_FEATURES = ["issue_bytes", "plan_bytes", "brief_bytes", "churn", "files", "commits"] as const;

type FixtureRow = readonly [label: string, cost: number, type: string, values: readonly (number | null)[]];

// Values follow FIXTURE_FEATURES. null means the feature is absent.
const FIXTURE: readonly FixtureRow[] = [
  ["T01", 43.2, "bug", [1181, 8039, 1705, 1363, 19, 11]],
  ["T02", 5.7, "bug", [727, null, null, 2781, 16, 28]],
  ["T03", 82.4, "bug", [1979, null, null, 13244, 86, 29]],
  ["T04", 1.3, "tech-debt", [692, null, 2497, 35, 8, 3]],
  ["T05", 2.3, "bug", [502, null, 1238, 46, 5, 1]],
  ["T06", 1.7, "bug", [459, null, null, 99, 5, 2]],
  ["T07", 3.1, "testing", [598, null, null, 261, 4, 2]],
  ["T08", 11.8, "testing", [977, null, null, 138, 6, 8]],
  ["T09", 21.4, "feature", [1178, null, null, 1104, 21, 8]],
  ["T10", 3.0, "bug", [724, null, null, 21, 4, 3]],
  ["T11", 15.0, "documentation", [1522, null, null, 501, 8, 5]],
  ["T12", 0.6, "tech-debt", [1349, null, null, 443, 16, 3]],
  ["T13", 2.4, "tech-debt", [642, null, null, 117, 8, 3]],
  ["T14", 3.1, "tech-debt", [616, null, null, 416, 7, 2]],
  ["T15", 2.9, "tech-debt", [683, null, null, 147, 7, 3]],
  ["T16", 6.1, "tech-debt", [682, null, null, 1475, 21, 3]],
  ["T17", 28.9, "bug", [1754, 32969, 2406, 1097, 33, 15]],
  ["T18", 57.1, "feature", [3993, null, 10968, 4902, 80, 17]],
  ["T19", 8.4, "feature", [1839, null, 3002, 359, 13, 4]],
  ["T20", 20.0, "feature", [1839, 16930, 7539, 1117, 30, 9]],
  ["T21", 20.0, "feature", [1839, 16930, 7539, 1117, 30, 9]],
  ["T22", 79.6, "tech-debt", [1839, 41226, 8291, 17233, 209, 36]],
  ["T23", 13.5, "feature", [664, 2860, null, 171, 6, 6]],
  ["T24", 8.7, "documentation", [1585, null, 2358, 142, 8, 3]],
  ["T25", 340.0, "feature", [null, 18638, 28660, 41000, 147, 48]],
  ["T26", 72.1, "feature", [null, 39012, null, null, null, null]],
  ["T27", 41.9, "feature", [null, null, 11661, 1699, 17, 13]],
  ["T28", 15.5, "bug", [null, null, null, null, null, null]],
  ["T29", 7.1, "documentation", [null, null, null, null, null, null]],
  ["T30", 1.7, "feature", [null, null, null, null, null, null]],
];

function fixtureTask(row: FixtureRow): EstimateTask {
  const features: Record<string, number> = {};
  FIXTURE_FEATURES.forEach((name, index) => {
    const value = row[3][index];
    if (value !== null && value !== undefined) features[name] = value;
  });
  return task(Math.round(row[1] * 1e6), row[2], features);
}

const FIXTURE_TASKS: readonly EstimateTask[] = FIXTURE.map(fixtureTask);

// ---------------------------------------------------------------------------
// Brute-force references for the leave-one-out scores
// ---------------------------------------------------------------------------

// A plain least-squares line, refitted without the left-out task.
function lineOf(zs: readonly number[], ys: readonly number[]): (z: number) => number {
  const meanZ = zs.reduce((a, b) => a + b, 0) / zs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let szz = 0;
  let szy = 0;
  zs.forEach((z, i) => {
    szz += (z - meanZ) ** 2;
    szy += (z - meanZ) * (at(ys, i) - meanY);
  });
  const slope = szy / szz;
  return (z) => meanY + slope * (z - meanZ);
}

function logCost(t: EstimateTask): number {
  return Math.log(t.totals.claude.weighted);
}

// The error of the "all" prediction of each task: its log cost minus the median of the others.
function allErrors(tasks: readonly EstimateTask[]): number[] {
  const ys = tasks.map(logCost);
  return ys.map((y, i) => y - median(ys.filter((_, j) => j !== i)));
}

function bruteScore(tasks: readonly EstimateTask[], indices: readonly number[], predictFor: (rest: readonly number[], i: number) => number): number {
  const ys = tasks.map(logCost);
  const own = indices.map((i) => Math.abs(at(ys, i) - predictFor(indices.filter((j) => j !== i), i)));
  const baseline = allErrors(tasks);
  return median(own) / median(indices.map((i) => Math.abs(at(baseline, i))));
}

// ---------------------------------------------------------------------------
// TP-8: minimum tasks
// ---------------------------------------------------------------------------

test("TP-8: a feature fit needs eight finished tasks with that feature", () => {
  const without = plainTasks(10, 1);
  const seven = [...sizeTasks(7, 2), ...without];
  const eight = [...sizeTasks(8, 2), ...without];
  assert.equal(candidateOf(scoreCandidates(seven, "claude"), { kind: "single", feature: "size" }), undefined);
  const found = candidateOf(scoreCandidates(eight, "claude"), { kind: "single", feature: "size" });
  assert.ok(found !== undefined);
  assert.equal(found.count, 8);
});

test("TP-8: a type needs three finished tasks", () => {
  const two = [...Array.from({ length: 2 }, (_, i) => task(100 + 50 * i, "x")), ...Array.from({ length: 5 }, (_, i) => task(1000 + 700 * i, "y"))];
  const three = [...Array.from({ length: 3 }, (_, i) => task(100 + 50 * i, "x")), ...Array.from({ length: 5 }, (_, i) => task(1000 + 700 * i, "y"))];
  assert.equal(candidateOf(scoreCandidates(two, "claude"), { kind: "type", type: "x" }), undefined);
  assert.equal(candidateOf(scoreCandidates(three, "claude"), { kind: "type", type: "x" })?.count, 3);
});

test("TP-8: the all candidate needs three finished tasks, and an item without a candidate has no basis", () => {
  assert.equal(candidateOf(scoreCandidates([task(100, "x"), task(200, "x")], "claude"), { kind: "all" }), undefined);
  const result = only(estimateFromSignals([item("A", "x")], [task(100, "x"), task(200, "x")], CAL));
  assert.deepEqual(result, { key: "A", subscription: "claude", basis: "none", basisName: "none", label: "no basis yet" });
});

// `count` feature names f00, f01, and so on, which sort in that order.
function nameList(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `f${String(i).padStart(2, "0")}`);
}

// Twelve tasks. The first `carrying` of them carry every name, with random values.
function namedHistory(names: readonly string[], carrying: number, seed: number): EstimateTask[] {
  const rand = lcg(seed);
  return Array.from({ length: 12 }, (_, i) => {
    const features = i < carrying ? Object.fromEntries(names.map((name) => [name, Math.expm1(2 + 6 * rand())])) : {};
    return task(Math.exp(4 + 2 * rand()), `t${i % 3}`, features);
  });
}

function singleNames(candidates: readonly Candidate[]): string[] {
  return candidates.flatMap((c) => (c.model.kind === "single" ? [c.model.feature] : [])).sort();
}

test("TP-8: at most sixteen feature names are scored: the most finished tasks first, ties by name", () => {
  const names = nameList(18);
  // Every name appears on the same 8 tasks, so the order falls back to the name.
  const singles = singleNames(scoreCandidates(namedHistory(names, 8, 3), "claude"));
  assert.deepEqual(singles, names.slice(0, 16));
});

test("a name that more tasks carry is scored before a name that sorts first", () => {
  const names = nameList(17);
  // f16 sorts last, but 10 tasks carry it and only 8 carry each other name.
  const rand = lcg(4);
  const history = Array.from({ length: 12 }, (_, i) => {
    const carried = i < 8 ? names : i < 10 ? ["f16"] : [];
    return task(Math.exp(4 + 2 * rand()), `t${i % 3}`, Object.fromEntries(carried.map((name) => [name, Math.expm1(2 + 6 * rand())])));
  });
  const singles = singleNames(scoreCandidates(history, "claude"));
  assert.equal(singles.length, 16);
  assert.ok(singles.includes("f16"));
  assert.ok(!singles.includes("f15"), "the name that sorts last of the others is the one that drops");
});

test("eleven names with enough tasks each get one single candidate, and the candidates stay within the bound", () => {
  const names = nameList(11);
  const candidates = scoreCandidates(namedHistory(names, 10, 5), "claude");
  assert.deepEqual(singleNames(candidates), names);
  const types = 3;
  // The all candidate, the types, at most 16 singles and at most 3 pairs.
  assert.ok(candidates.length <= 1 + types + 16 + 3, `${candidates.length} candidates`);
});

test("the estimate uses the feature only when the item carries it", () => {
  const history = [...sizeTasks(20, 5), ...plainTasks(6, 6)];
  const withFeature = only(estimateFromSignals([item("A", "t0", { size: 500 })], history, CAL));
  const withoutFeature = only(estimateFromSignals([item("B", "t0")], history, CAL));
  assert.equal(withFeature.basisName, "size");
  assert.notEqual(withoutFeature.basisName, "size");
});

test("with no ready calibration on the subscription every item has no basis", () => {
  const history = sizeTasks(12, 7);
  const result = only(estimateFromSignals([item("A", "t0", { size: 500 })], history, { claude: { ready: false, label: NOT_READY_LABEL }, codex: ready(1) }));
  assert.equal(result.basis, "none");
});

test("a week size that is not a finite number above 0 gives no basis to every item and no percent of the week", () => {
  const history = [task(100, "x"), task(200, "x"), task(300, "x")];
  const items = [item("A", "x"), item("B", null)];
  assert.deepEqual(estimateFromSignals(items, history, CAL).map((e) => e.basis), ["wide", "wide"], "a finite week gives a basis");
  assert.equal(pctOfWeek(ready(10), 100), 10);
  for (const week of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    const calibration = ready(week);
    assert.deepEqual(estimateFromSignals(items, history, { claude: calibration, codex: calibration }).map((e) => e.basis), ["none", "none"], `week ${week}`);
    assert.equal(pctOfWeek(calibration, 100), null, `week ${week}`);
  }
});

// ---------------------------------------------------------------------------
// The floor: a task under 0.1 percent of the week is out of the fits
// ---------------------------------------------------------------------------

test("the floor leaves out a task under 0.1 percent of the week and keeps one exactly at it, and the history does not change", () => {
  const history = [task(FLOOR - 1, null), task(FLOOR, null), task(2 * FLOOR, null), task(3 * FLOOR, null)];
  const before = structuredClone(history);
  const result = ranged(only(estimateFromSignals([item("A", null)], Object.freeze(history), WEEK_CAL)));
  assert.equal(result.basisName, "all");
  assert.equal(result.count, 3);
  close(result.weightedLow, 1.2 * FLOOR);
  close(result.weightedHigh, 2.8 * FLOOR);
  assert.deepEqual(history, before);
});

test("a type of three tasks with one under the floor is no candidate, and a feature on eight tasks with one under the floor gives no fit", () => {
  const rest = Array.from({ length: 5 }, (_, i) => task(10 * FLOOR + 7 * FLOOR * i, "y"));
  const typed = [task(FLOOR / 2, "x"), task(2 * FLOOR, "x"), task(3 * FLOOR, "x"), ...rest];
  assert.equal(candidateOf(scoreCandidates(typed, "claude"), { kind: "type", type: "x" })?.count, 3, "no floor: the type counts");
  assert.equal(candidateOf(scoreCandidates(typed, "claude", FLOOR), { kind: "type", type: "x" }), undefined);

  const sized = Array.from({ length: 8 }, (_, i) => task((i === 0 ? 0.5 : 2 + i) * FLOOR, null, { size: 10 * (i + 1) }));
  assert.equal(candidateOf(scoreCandidates(sized, "claude"), { kind: "single", feature: "size" })?.count, 8, "no floor: the feature has a fit");
  assert.equal(candidateOf(scoreCandidates(sized, "claude", FLOOR), { kind: "single", feature: "size" }), undefined);
});

test("three history tasks with two under the floor give no basis to every item that has no cost so far", () => {
  const under = [task(FLOOR / 2, "x"), task(FLOOR / 3, "x"), task(5 * FLOOR, "x")];
  const items = [item("A", "x"), item("B", null), item("C", "z", { size: 5 })];
  assert.deepEqual(estimateFromSignals(items, under, WEEK_CAL).map((e) => e.basis), ["none", "none", "none"]);
  const over = [task(4 * FLOOR, "x"), task(3 * FLOOR, "x"), task(5 * FLOOR, "x")];
  assert.deepEqual(estimateFromSignals(items, over, WEEK_CAL).map((e) => e.basis), ["wide", "wide", "wide"], "the control: all three over the floor");
});

test("scoreCandidates with no floor argument keeps a task under the floor, and a NaN floor leaves every task out", () => {
  const history = [task(FLOOR / 2, null), task(2 * FLOOR, null), task(3 * FLOOR, null)];
  assert.equal(candidateOf(scoreCandidates(history, "claude"), { kind: "all" })?.count, 3);
  assert.equal(candidateOf(scoreCandidates(history, "claude", 0), { kind: "all" })?.count, 3);
  assert.equal(candidateOf(scoreCandidates(history, "claude", FLOOR), { kind: "all" }), undefined);
  assert.deepEqual(scoreCandidates(history, "claude", Number.NaN), []);
});

// ---------------------------------------------------------------------------
// TP-9: pairs
// ---------------------------------------------------------------------------

test("TP-9: a pair needs forty tasks with both features and a clear gain over the better single fit", () => {
  const forty = pairTasks(40, 11, 0.6, 0.6, 0.1);
  const candidates = scoreCandidates(forty, "claude");
  const pair = candidateOf(candidates, { kind: "pair", features: ["f1", "f2"] });
  assert.ok(pair !== undefined);
  assert.equal(pair.count, 40);
  const singles = candidates.filter((c) => c.model.kind === "single");
  assert.ok(singles.length === 2 && singles.every((c) => pair.score <= 0.95 * c.score));
  // A pair needs both features in the item. An item with one of them takes the single fit.
  assert.equal(only(estimateFromSignals([item("A", "t0", { f1: 300, f2: 300 })], forty, CAL)).basisName, "f1+f2");
  assert.equal(only(estimateFromSignals([item("B", "t0", { f1: 300 })], forty, CAL)).basisName, "f1");
});

test("TP-9: thirty-nine tasks with both features give no pair", () => {
  const history = [...pairTasks(39, 11, 0.6, 0.6, 0.1), ...sizeTasks(11, 12, "f1")];
  const models = scoreCandidates(history, "claude").map((c) => c.model.kind);
  assert.ok(!models.includes("pair"));
});

test("TP-9: a second feature with no information gives no pair", () => {
  const rand = lcg(21);
  const history = Array.from({ length: 60 }, (_, i) => {
    const z1 = 3 + 6 * rand();
    const z2 = 3 + 6 * rand();
    return task(Math.exp(1 + 0.8 * z1 + 0.4 * (rand() - 0.5)), `t${i % 3}`, { f1: Math.expm1(z1), f2: Math.expm1(z2) });
  });
  assert.ok(!scoreCandidates(history, "claude").some((c) => c.model.kind === "pair"));
});

test("TP-9: pairs are made only from the three names with the best single scores", () => {
  // All four features move the cost, f3 the least. So the gain rule would not remove a
  // pair with f3: only the cap on names keeps f3 out of every pair.
  const weights = [0.5, 0.5, 0.45, 0.4];
  const rand = lcg(19);
  const history = Array.from({ length: 50 }, (_, i) => {
    const z = weights.map(() => 3 + 6 * rand());
    const y = 1 + weights.reduce((sum, weight, k) => sum + weight * at(z, k), 0) + 0.1 * (rand() - 0.5);
    return task(Math.exp(y), `t${i % 3}`, Object.fromEntries(z.map((value, k) => [`f${k}`, Math.expm1(value)])));
  });
  const pairs = scoreCandidates(history, "claude").flatMap((c) => (c.model.kind === "pair" ? [c.model.features.join("+")] : []));
  assert.deepEqual(pairs.sort(), ["f0+f1", "f0+f2", "f1+f2"]);
});

// ---------------------------------------------------------------------------
// TP-10: the selector
// ---------------------------------------------------------------------------

test("TP-10: equal scores between two features go to the name that sorts first", () => {
  // Both features carry the same values on every task, so the two fits score the same.
  const rand = lcg(61);
  const history = Array.from({ length: 20 }, (_, i) => {
    const size = Math.expm1(2 + 7 * rand());
    return task(Math.exp(3 + 0.9 * Math.log1p(size) + 0.5 * (rand() - 0.5)), `t${i % 3}`, { files: size, churn: size });
  });
  const candidates = scoreCandidates(history, "claude");
  const churn = candidateOf(candidates, { kind: "single", feature: "churn" });
  const files = candidateOf(candidates, { kind: "single", feature: "files" });
  assert.ok(churn !== undefined && files !== undefined);
  assert.equal(churn.score, files.score);
  assert.ok(churn.score < 1);
  assert.equal(only(estimateFromSignals([item("A", "t0", { files: 400, churn: 400 })], history, CAL)).basisName, "churn");
});

test("TP-10: a type with the same score as all gives way to all, so all is the basis", () => {
  // Every task has the same type, so the type group is the whole history.
  const history = Array.from({ length: 6 }, (_, i) => task(100 * (i + 1) ** 2, "same"));
  const candidates = scoreCandidates(history, "claude");
  assert.equal(candidateOf(candidates, { kind: "type", type: "same" })?.score, 1);
  assert.equal(only(estimateFromSignals([item("A", "same")], history, CAL)).basisName, "all");
});

test("TP-10: a feature with a score under 1 beats all", () => {
  const history = sizeTasks(20, 41);
  const result = ranged(only(estimateFromSignals([item("A", "t1", { size: 400 })], history, CAL)));
  assert.equal(result.basisName, "size");
  assert.equal(result.basis, "similar");
  assert.equal(result.label, "similar");
  assert.equal(result.count, 20);
});

// ---------------------------------------------------------------------------
// TP-11, TP-50, TP-68: fits
// ---------------------------------------------------------------------------

test("TP-11: a fit with all-equal x values gives null", () => {
  assert.equal(fitLine([2, 2, 2, 2], [1, 2, 3, 4]), null);
  // The mean of equal numbers can differ from the number by rounding. It is still all-equal.
  assert.equal(fitLine(Array.from({ length: 7 }, () => 0.1), [1, 2, 3, 4, 5, 6, 7]), null);
  assert.equal(fitPlane([2, 2, 2, 2, 2], [1, 2, 3, 4, 5], [1, 3, 2, 5, 4]), null);
  assert.equal(fitPlane([1, 2, 3, 4, 5], [7, 7, 7, 7, 7], [1, 3, 2, 5, 4]), null);
});

test("TP-11: a non-finite input or result gives null and a fit never throws", () => {
  assert.equal(fitLine([1, 2, 3, Number.NaN], [1, 2, 3, 4]), null);
  assert.equal(fitLine([1, 2, 3, 4], [1, 2, Number.POSITIVE_INFINITY, 4]), null);
  assert.equal(fitLine([1, 2, 3, 4], [1e308, -1e308, 1e308, -1e308]), null);
  assert.equal(fitLine([1, 2, 3, 4], [1, 2, 3]), null);
  assert.equal(fitLine([], []), null);
  assert.equal(fitLine([1, 2], [1, 2]), null);
  assert.equal(fitPlane([1, 2, 3, 4, 5], [5, 3, 4, 1, 2], [1, 2, 3, Number.NaN, 5]), null);
  assert.doesNotThrow(() => fitLine([Number.NaN], [Number.NaN]));
  assert.doesNotThrow(() => fitPlane([], [], []));
});

test("TP-11: a line fit gives the slope, the intercept and the leave-one-out errors", () => {
  const zs = [1, 2, 3, 4, 5, 6, 7, 8];
  const ys = [1, 2, 3, 4, 5, 6, 7, 8].map((z, i) => 2 + 3 * z + (i % 2 === 0 ? 0.1 : -0.1));
  const fit = fitLine(zs, ys);
  assert.ok(fit !== null);
  close(fit.slope, 3, 0.05);
  // The closed form equals a refit without each task.
  zs.forEach((z, i) => {
    const rest = zs.map((_, j) => j).filter((j) => j !== i);
    const predict = lineOf(rest.map((j) => at(zs, j)), rest.map((j) => at(ys, j)));
    close(at(fit.errors, i), at(ys, i) - predict(z), 1e-9);
  });
});

test("TP-11: an item with all-equal values in every task gets no feature fit and falls back to the type or all", () => {
  const history = Array.from({ length: 12 }, (_, i) => task(Math.exp(5 + (i % 5) * 0.6), `t${i % 3}`, { files: 5 }));
  const result = only(estimateFromSignals([item("A", "t0", { files: 5 })], history, CAL));
  assert.ok(result.basisName === "type" || result.basisName === "all");
});

// Two columns that are almost one line. Their relative gap sets the determinant.
function nearLine(count: number, gap: number): { z1: number[]; z2: number[]; y: number[] } {
  const rand = lcg(51);
  const z1 = Array.from({ length: count }, (_, i) => i);
  const z2 = z1.map((z) => z + gap * (2 * rand() - 1));
  const y = z1.map((z, i) => 1 + 0.5 * z + 0.3 * at(z2, i) + 0.5 * (rand() - 0.5));
  return { z1, z2, y };
}

test("TP-50: a pair with near-collinear values gives null through the relative determinant floor", () => {
  const collinear = nearLine(40, 2e-5);
  assert.equal(fitPlane(collinear.z1, collinear.z2, collinear.y), null);
  // The same values with a clear gap fit.
  const apart = nearLine(40, 5);
  assert.ok(fitPlane(apart.z1, apart.z2, apart.y) !== null);
});

test("TP-50: near-collinear features give no pair candidate", () => {
  const rand = lcg(52);
  const history = Array.from({ length: 50 }, (_, i) => {
    const z = 3 + 6 * rand();
    return task(Math.exp(1 + 0.8 * z + 0.3 * (rand() - 0.5)), `t${i % 3}`, { f1: Math.expm1(z), f2: Math.expm1(z + 1e-7 * rand()) });
  });
  assert.ok(!scoreCandidates(history, "claude").some((c) => c.model.kind === "pair"));
});

test("TP-68: scaling both columns of a pair by one factor leaves the decision unchanged", () => {
  const scaled = (z: readonly number[], factor: number): number[] => z.map((v) => v * factor);
  for (const [gap, expectFit] of [
    [2e-5, false],
    [0.02, true],
  ] as const) {
    const { z1, z2, y } = nearLine(40, gap);
    for (const factor of [1e-6, 1e-3, 1, 1e3, 1e6]) {
      const fit = fitPlane(scaled(z1, factor), scaled(z2, factor), y);
      assert.equal(fit !== null, expectFit, `gap ${gap}, factor ${factor}`);
    }
  }
});

test("TP-68: scaling the features of a pair leaves the winner of the estimate unchanged", () => {
  const scaledHistory = (factor: number): EstimateTask[] =>
    pairTasks(40, 11, 0.6, 0.6, 0.1).map((t) => ({ ...t, features: Object.fromEntries(Object.entries(t.features).map(([k, v]) => [k, v * factor])) }));
  const names = [1, 1e6].map((factor) => only(estimateFromSignals([item("A", "t0", { f1: 300 * factor, f2: 300 * factor })], scaledHistory(factor), CAL)).basisName);
  assert.deepEqual(names, ["f1+f2", "f1+f2"]);
});

// ---------------------------------------------------------------------------
// TP-13, TP-14, TP-52: the range
// ---------------------------------------------------------------------------

test("TP-13: three tasks widen both ends outward by half the extreme error", () => {
  const shifts = rangeShifts([-1, 0.2, 0.6]);
  close(shifts.low, -1.5);
  close(shifts.high, 0.9);
});

test("TP-13: eight tasks widen both ends, because the 1-based indexes are 0 and 9", () => {
  const shifts = rangeShifts([-0.8, -0.4, -0.2, 0, 0.1, 0.3, 0.5, 0.6]);
  close(shifts.low, -1.2);
  close(shifts.high, 0.9);
});

test("TP-13: nine tasks use the first and the last error, and thirty tasks use the third and the 28th", () => {
  const nine = rangeShifts([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual([nine.low, nine.high], [1, 9]);
  const thirty = rangeShifts(Array.from({ length: 30 }, (_, i) => i + 1));
  assert.deepEqual([thirty.low, thirty.high], [3, 28]);
});

test("TP-13: the range of a feature fit is the prediction plus the shifts of its leave-one-out errors", () => {
  const history = sizeTasks(8, 61);
  const fit = fitLine(history.map((t) => Math.log1p(at(Object.values(t.features), 0))), history.map(logCost));
  assert.ok(fit !== null);
  const shifts = rangeShifts([...fit.errors].sort((a, b) => a - b));
  const z = Math.log1p(900);
  const predicted = fit.intercept + fit.slope * z;
  const result = ranged(only(estimateFromSignals([item("A", "t0", { size: 900 })], history, CAL)));
  assert.equal(result.basisName, "size");
  close(result.rawLow, Math.exp(predicted + shifts.low), 1e-9);
  close(result.rawHigh, Math.exp(predicted + shifts.high), 1e-9);
  close(result.lowPct, result.rawLow / PER_PCT);
});

test("TP-14: a type or all basis reads rough: basis wide and the low confidence label", () => {
  const history = [...Array.from({ length: 6 }, (_, i) => task(100 * (i + 1), "a")), ...Array.from({ length: 6 }, (_, i) => task(10_000 * (i + 1), "b"))];
  const byType = ranged(only(estimateFromSignals([item("A", "a")], history, CAL)));
  assert.equal(byType.basisName, "type");
  assert.equal(byType.basis, "wide");
  assert.equal(byType.label, "wide, low confidence");
  const byAll = ranged(only(estimateFromSignals([item("B", "unknown")], history, CAL)));
  assert.equal(byAll.basisName, "all");
  assert.equal(byAll.basis, "wide");
  assert.equal(byAll.count, 12);
});

test("the basis name of each model that is not a feature fit is a reserved name of core", () => {
  const history = [...Array.from({ length: 6 }, (_, i) => task(100 * (i + 1), "a")), ...Array.from({ length: 6 }, (_, i) => task(10_000 * (i + 1), "b"))];
  const names = [
    only(estimateFromSignals([item("A", "a")], history, CAL)).basisName,
    only(estimateFromSignals([item("B", "unknown")], history, CAL)).basisName,
    only(estimateFromSignals([item("C", "a")], [], CAL)).basisName,
  ];
  assert.deepEqual(names, [BASIS_TYPE, BASIS_ALL, BASIS_NONE]);
  // The fourth name is the basis of an item in progress; the three above come from the history.
  const modelNames = [...names, BASIS_SPENT];
  for (const name of modelNames) assert.ok(MODEL_BASIS_NAMES.has(name), name);
  assert.equal(MODEL_BASIS_NAMES.size, modelNames.length);
  assert.equal(MODEL_BASIS_NAMES.size, 4);
  assert.equal(isFeatureName(BASIS_SPENT), false);
});

// ---- A running item under the start of the spent rule (TP-14, TP-48) ----

// The cost so far from which the spent rule takes an item: half a percent of the
// week of WEEK_CAL.
const SPENT_START = WEEK_PER_PCT * 0.5;

// The size of the items of the tests that use bandTasks, inside its sizes.
const BAND_SIZE = Math.expm1(6.5);

// Twenty finished tasks whose cost sits in a narrow band, 150,000 to 250,000
// weighted tokens, and follows the size (z from 6 to 7). With the week WEEK_CAL
// the band is over the floor of the fits, and a running item that has used up to
// 1.2 times the high end of its range is still under the start of the spent rule.
function bandTasks(): EstimateTask[] {
  const rand = lcg(71);
  return Array.from({ length: 20 }, (_, i) => {
    const z = 6 + i / 19;
    return task(150_000 * Math.exp(0.5 * (z - 6) + 0.04 * (rand() - 0.5)), `t${i % 3}`, { size: Math.expm1(z) });
  });
}

function bandEstimate(history: readonly EstimateTask[], spent?: number): Ranged {
  if (spent !== undefined) {
    assert.ok(spent < SPENT_START, `the cost so far ${spent} is not under the start ${SPENT_START}`);
    assert.ok(Math.min(...history.map((entry) => entry.totals.claude.weighted)) >= FLOOR, "the history is not over the floor");
  }
  return ranged(only(estimateFromSignals([item("A", "t0", { size: BAND_SIZE }, spent)], history, WEEK_CAL)));
}

test("TP-14: a running item never has its low end below its cost so far", () => {
  const history = bandTasks();
  const base = bandEstimate(history);
  const lowW = base.lowPct * WEEK_PER_PCT;
  const highW = base.highPct * WEEK_PER_PCT;
  assert.ok(lowW < highW);

  // Below the low end: nothing changes.
  assert.deepEqual(bandEstimate(history, lowW / 2), base);
  // Inside the range: the low end moves up to the cost so far.
  const inside = bandEstimate(history, (lowW + highW) / 2);
  close(inside.lowPct * WEEK_PER_PCT, (lowW + highW) / 2);
  assert.equal(inside.highPct, base.highPct);
  assert.equal(inside.open, false);
  // Above the high end: the range is open from the cost so far. Its high fields
  // hold the low end, the value of the estimate log: never a reversed range.
  const above = bandEstimate(history, highW * 1.2);
  close(above.lowPct * WEEK_PER_PCT, highW * 1.2);
  assert.equal(above.open, true);
  assert.equal(above.highPct, above.lowPct);
  assert.equal(above.weightedHigh, above.weightedLow);
  close(above.rawHigh, above.rawLow);
  assert.equal(above.basisName, "size", "under the start value the item keeps its own basis");
});

test("TP-14: an open range on a similar basis reads rough and keeps its basis for the log", () => {
  const history = bandTasks();
  const base = bandEstimate(history);
  assert.deepEqual([base.basis, base.label], ["similar", "similar"]);
  const above = bandEstimate(history, base.highPct * WEEK_PER_PCT * 1.2);
  assert.equal(above.open, true);
  assert.equal(above.label, "wide, low confidence");
  // The basis and its name stay, so the log writes no new line when the item runs past its range.
  assert.deepEqual([above.basis, above.basisName], [base.basis, base.basisName]);
  const items = [item("A", "t0", { size: BAND_SIZE })];
  const first = newLogLines(items, [base], [], 1_000);
  assert.deepEqual(newLogLines(items, [above], first, 2_000), []);
  // A first line from an open range logs its low end as its high end.
  const lines = newLogLines(items, [above], [], 1_000);
  assert.deepEqual(lines.map((line) => [line.basis, line.low, line.high]), [["similar", above.weightedLow, above.weightedLow]]);
});

test("TP-14: a running item on a group basis keeps its low end at its cost so far", () => {
  // A week of 9,500 tokens for 1 percent: the floor is 950, under the smallest cost,
  // and the start of the spent rule is 4,750, over the middle of the range.
  const group = { claude: ready(9_500), codex: ready(9_500) };
  const history = Array.from({ length: 8 }, (_, i) => task(1000 * (i + 1), "a"));
  const base = ranged(only(estimateFromSignals([item("A", "a")], history, group)));
  const spent = (base.lowPct * 9_500 + base.highPct * 9_500) / 2;
  assert.ok(spent < 0.5 * 9_500, "the cost so far is under the start of the spent rule");
  const running = ranged(only(estimateFromSignals([item("A", "a", {}, spent)], history, group)));
  assert.equal(running.basisName, "all");
  close(running.rawLow, spent);
});

test("TP-52: the percent range and the raw range of a weighted token fit come from the same factor range", () => {
  // Weighted tokens W with a raw to weighted ratio that differs from task to task.
  const rand = lcg(81);
  const ratios: number[] = [];
  const history = Array.from({ length: 14 }, (_, i) => {
    const z = 2 + 7 * rand();
    const weighted = Math.exp(3 + 0.9 * z + 0.4 * (rand() - 0.5));
    const share = rand();
    // input counts 1 and cache read counts 0.1 per token.
    const input = weighted * share;
    const cacheRead = (weighted * (1 - share)) / 0.1;
    const t = taskFrom([input, 0, 0, cacheRead, 0], `t${i % 3}`, { size: Math.expm1(z) });
    ratios.push((input + cacheRead) / t.totals.claude.weighted);
    return t;
  });
  const result = ranged(only(estimateFromSignals([item("A", "t0", { size: 700 })], history, CAL)));
  assert.equal(result.basisName, "size");
  close(result.rawHigh / result.rawLow, result.highPct / result.lowPct);
  const ratio = median(ratios);
  close(result.rawLow, result.lowPct * PER_PCT * ratio, 1e-9);
  close(result.rawHigh, result.highPct * PER_PCT * ratio, 1e-9);
});

test("TP-52: a type range gives the same factor in percent and raw tokens", () => {
  // Cache reads count 0.1 per token, so a task with w weighted tokens has 10 w raw tokens.
  const history = [
    ...[10, 20, 40, 80, 160, 320].map((w) => taskFrom([0, 0, 0, w * 10, 0], "a")),
    ...[1e5, 2e5, 4e5, 8e5, 16e5, 32e5].map((w) => taskFrom([0, 0, 0, w * 10, 0], "b")),
  ];
  const result = ranged(only(estimateFromSignals([item("A", "a")], history, CAL)));
  assert.equal(result.basisName, "type");
  close(result.rawHigh / result.rawLow, result.highPct / result.lowPct);
  close(result.rawLow, result.lowPct * PER_PCT * 10);
});

// ---------------------------------------------------------------------------
// The clamp, the rough flag, and the typical and budget costs
// ---------------------------------------------------------------------------

// Ten tasks whose size runs from 10 to 100 in steps of 10. The cost follows the
// size with a small noise that goes up and down, so the size fit beats all.
function sizeRunTasks(): EstimateTask[] {
  return Array.from({ length: 10 }, (_, i) => {
    const size = 10 * (i + 1);
    return task(Math.exp(3 + 0.9 * Math.log1p(size) + (i % 2 === 0 ? 0.15 : -0.15) + 0.01 * i), null, { size });
  });
}

type Ranged = Extract<SignalEstimate, { basis: "similar" | "wide" }>;

function sizeEstimate(history: readonly EstimateTask[], size: number): Ranged {
  return ranged(only(estimateFromSignals([item("A", null, { size })], history, CAL)));
}

// The ends and the two costs of a range that is not open, in percent of the week.
function ladderOf(estimate: Ranged): number[] {
  assert.ok(estimate.typicalPct !== null && estimate.budgetPct !== null, `${estimate.key} has no typical or budget`);
  return [estimate.lowPct, estimate.typicalPct, estimate.budgetPct, estimate.highPct];
}

function assertLadder(estimate: Ranged): void {
  const [low, typical, budget, high] = ladderOf(estimate);
  assert.ok(low !== undefined && typical !== undefined && budget !== undefined && high !== undefined);
  assert.ok(low <= typical && typical <= budget && budget <= high, `${low} ${typical} ${budget} ${high}`);
}

test("an item past the largest or under the smallest value of a feature fit gets the range of that value and reads rough, with its basis and name kept", () => {
  const history = sizeRunTasks();
  const top = sizeEstimate(history, 100);
  const above = sizeEstimate(history, 1000);
  assert.deepEqual([top.basis, top.basisName, top.rough, top.label], ["similar", "size", false, "similar"]);
  assert.deepEqual([above.basis, above.basisName, above.rough, above.label, above.open], ["similar", "size", true, "wide, low confidence", false]);
  assert.deepEqual({ ...above, rough: false, label: "similar" }, top, "the range, the costs and the count are those of the value 100");

  const bottom = sizeEstimate(history, 10);
  const below = sizeEstimate(history, 1);
  assert.equal(bottom.rough, false, "a value equal to the smallest value is not clamped");
  assert.equal(below.rough, true);
  assert.deepEqual({ ...below, rough: false, label: "similar" }, bottom);
  assert.equal(sizeEstimate(history, 55).rough, false, "a value inside the range is not clamped");
});

test("a clamped estimate writes no new log line after an unclamped line of the same fit, and its own line says similar", () => {
  const history = sizeRunTasks();
  const inside = [item("A", null, { size: 100 })];
  const past = [item("A", null, { size: 1000 })];
  const first = newLogLines(inside, [sizeEstimate(history, 100)], [], 1_000);
  const clamped = sizeEstimate(history, 1000);
  assert.deepEqual(newLogLines(past, [clamped], first, 2_000), []);
  assert.deepEqual(newLogLines(past, [clamped], [], 1_000).map((line) => [line.basis, line.basisName]), [["similar", "size"]]);
});

test("a pair item past the largest value of one feature gets the range at that largest value, reads rough and keeps the pair name", () => {
  const history = pairTasks(40, 11, 0.6, 0.6, 0.1);
  const largest = history.reduce((most, entry) => Math.max(most, entry.features["f1"] ?? 0), 0);
  const estimateAt = (f1: number): Ranged => ranged(only(estimateFromSignals([item("A", "t0", { f1, f2: 300 })], history, CAL)));
  const edge = estimateAt(largest);
  const far = estimateAt(1e12);
  assert.deepEqual([edge.basisName, edge.basis, edge.rough], ["f1+f2", "similar", false]);
  assert.deepEqual([far.basisName, far.basis, far.rough, far.label], ["f1+f2", "similar", true, "wide, low confidence"]);
  assert.deepEqual({ ...far, rough: false, label: "similar" }, edge);
});

test("a pair item past the largest value of its second feature, or under the smallest value of its first, gets the range at that value and reads rough", () => {
  const history = pairTasks(40, 11, 0.6, 0.6, 0.1);
  const valuesOf = (name: string): number[] => history.map((entry) => entry.features[name] ?? Number.NaN);
  const estimateAt = (f1: number, f2: number): Ranged => ranged(only(estimateFromSignals([item("A", "t0", { f1, f2 })], history, CAL)));

  const edge2 = estimateAt(300, Math.max(...valuesOf("f2")));
  const far2 = estimateAt(300, 1e12);
  assert.deepEqual([edge2.rough, far2.rough, far2.basisName], [false, true, "f1+f2"]);
  assert.deepEqual({ ...far2, rough: false, label: "similar" }, edge2);

  const edge1 = estimateAt(Math.min(...valuesOf("f1")), 300);
  const under1 = estimateAt(0, 300);
  assert.deepEqual([edge1.rough, under1.rough], [false, true]);
  assert.deepEqual({ ...under1, rough: false, label: "similar" }, edge1);
});

test("the all basis on costs of 1 to 10 percent gives low 1.9, typical 5.5, budget 8.2 and high 9.1", () => {
  const history = Array.from({ length: 10 }, (_, i) => task(PER_PCT * (i + 1), null));
  const result = ranged(only(estimateFromSignals([item("A", null)], history, CAL)));
  assert.equal(result.basisName, "all");
  ladderOf(result).forEach((value, index) => close(value, [1.9, 5.5, 8.2, 9.1][index] ?? Number.NaN));
});

test("a winning type group of four costs gives the typical and budget costs at the 50th and 80th percentile", () => {
  const history = [...[100_000, 110_000, 120_000, 130_000].map((w) => task(w, "a")), ...[1e7, 1.1e7, 1.2e7, 1.3e7].map((w) => task(w, "b"))];
  const result = ranged(only(estimateFromSignals([item("A", "a")], history, CAL)));
  assert.equal(result.basisName, "type");
  const [, typical, budget] = ladderOf(result);
  close((typical ?? Number.NaN) * PER_PCT, 115_000);
  close((budget ?? Number.NaN) * PER_PCT, 124_000);
});

test("the typical and budget costs of a fit are the prediction plus the 50th and 80th percentile of the sorted leave-one-out errors", () => {
  const history = sizeRunTasks();
  // The expected values come from the test line fit, not from the production helpers.
  const zs = history.map((entry) => Math.log1p(entry.features["size"] ?? Number.NaN));
  const ys = history.map(logCost);
  const errors = zs
    .map((z, i) => {
      const rest = zs.map((_, j) => j).filter((j) => j !== i);
      return at(ys, i) - lineOf(rest.map((j) => at(zs, j)), rest.map((j) => at(ys, j)))(z);
    })
    .sort((a, b) => a - b);
  assert.equal(errors.length, 10);
  const predicted = lineOf(zs, ys)(Math.log1p(55));
  // With 10 errors the low end is the smallest error: floor(0.1 * 11) = 1. The
  // percentile is linear at the place p * 9: P50 is at 4.5 and P80 is at 7.2.
  const low = Math.exp(predicted + at(errors, 0));
  const typical = Math.max(Math.exp(predicted + (at(errors, 4) + at(errors, 5)) / 2), low);
  const budget = Math.max(Math.exp(predicted + at(errors, 7) + 0.2 * (at(errors, 8) - at(errors, 7))), typical);
  const [, typicalPct, budgetPct] = ladderOf(sizeEstimate(history, 55));
  close((typicalPct ?? Number.NaN) * PER_PCT, typical);
  close((budgetPct ?? Number.NaN) * PER_PCT, budget);
});

test("every ranged estimate that is not open has its low end, typical cost, budget and high end in order, over fits, pairs and groups", () => {
  let checked = 0;
  const check = (estimate: SignalEstimate): void => {
    const result = ranged(estimate);
    if (result.open) return;
    assertLadder(result);
    checked += 1;
  };
  const sized = sizeRunTasks();
  for (const size of [0, 1, 10, 33, 55, 100, 5000, 1e12]) check(only(estimateFromSignals([item("S", null, { size })], sized, CAL)));
  const paired = pairTasks(40, 11, 0.6, 0.6, 0.1);
  for (const f1 of [1, 40, 300, 1e12]) {
    for (const f2 of [1, 300, 1e12]) check(only(estimateFromSignals([item("P", "t0", { f1, f2 })], paired, CAL)));
  }
  const grouped = [...[100, 110, 120, 130].map((w) => task(w, "a")), ...[1e4, 1.1e4, 1.2e4, 1.3e4].map((w) => task(w, "b"))];
  for (const type of ["a", "b", "z"]) check(only(estimateFromSignals([item("G", type)], grouped, CAL)));
  FIXTURE.forEach((row, index) => {
    const others = FIXTURE_TASKS.filter((_, i) => i !== index);
    const estimate = only(estimateFromSignals([{ key: row[0], tags: { type: row[2] }, features: at(FIXTURE_TASKS, index).features }], others, CAL));
    if (estimate.basis !== "none") check(estimate);
  });
  assert.ok(checked >= 40, `${checked} ranges were checked`);
});

test("an open estimate has no typical and no budget, and a running item inside its range has a typical cost of at least its cost so far", () => {
  const history = bandTasks();
  const base = bandEstimate(history);
  const [low, , , high] = ladderOf(base);
  const open = bandEstimate(history, (high ?? Number.NaN) * WEEK_PER_PCT * 1.2);
  assert.equal(open.open, true);
  assert.deepEqual([open.typicalPct, open.budgetPct], [null, null]);

  const spentAt = (low ?? Number.NaN) * WEEK_PER_PCT * 0.5 + (high ?? Number.NaN) * WEEK_PER_PCT * 0.5;
  const running = bandEstimate(history, spentAt);
  assert.equal(running.open, false);
  const [, typical, budget] = ladderOf(running);
  assert.ok((typical ?? 0) * WEEK_PER_PCT >= spentAt - 1e-9, `${typical} ${spentAt}`);
  assertLadder(running);
  assert.ok((budget ?? 0) >= (typical ?? Number.POSITIVE_INFINITY));
  // Inside the range and under the typical cost, the typical cost does not move.
  const [, baseTypical] = ladderOf(base);
  const early = bandEstimate(history, (low ?? Number.NaN) * WEEK_PER_PCT * 1.0001);
  assert.equal(ladderOf(early)[1], baseTypical);
});

test("when one of the typical and budget costs is not a finite number of percent, both are null", () => {
  // A week of 1e-300 tokens for 1 percent: a cost of 1 is 1e300 percent, and a cost of 1e9 overflows.
  const tiny = { claude: ready(1e-300), codex: ready(1e-300) };
  const history = [1, 1, 1, 1e9, 1e9].map((w) => task(w, null));
  const result = ranged(only(estimateFromSignals([item("A", null)], history, tiny)));
  assert.equal(result.basisName, "all");
  assert.ok(Number.isFinite(result.lowPct) && result.lowPct > 0);
  assert.deepEqual([result.typicalPct, result.budgetPct], [null, null]);
});

// ---------------------------------------------------------------------------
// The spent rule: an item that has used half a percent of the week or more
// (TP-44 to TP-47, TP-50, TP-51, TP-71)
// ---------------------------------------------------------------------------

// Ten finished tasks that cost 1 to 10 percent of the week of WEEK_CAL.
function percentTasks(): EstimateTask[] {
  return Array.from({ length: 10 }, (_, i) => task(WEEK_PER_PCT * (i + 1), null));
}

// The estimate of an item that has used `pct` percent of the week, or none.
function usedEstimate(history: readonly EstimateTask[], pct: number | undefined): SignalEstimate {
  return only(estimateFromSignals([item("A", null, {}, pct === undefined ? undefined : pct * WEEK_PER_PCT)], history, WEEK_CAL));
}

test("TP-44: an item that has used 6 percent is on the spent basis, with the costs of the tasks from 6 percent up", () => {
  const result = ranged(usedEstimate(percentTasks(), 6));
  assert.deepEqual(
    [result.basis, result.basisName, result.count, result.open, result.rough, result.label],
    ["wide", BASIS_SPENT, 5, false, true, "wide, low confidence"],
  );
  // The 10th, 50th, 80th and 90th percentile of 6, 7, 8, 9 and 10.
  ladderOf(result).forEach((value, index) => close(value, [6.4, 8, 9.2, 9.6][index] ?? Number.NaN));
  assert.ok(result.rawLow > 0);
});

test("TP-71: a spent row has a raw low end above 0, and the factor between its raw ends is the factor between its weighted ends", () => {
  const result = ranged(usedEstimate(percentTasks(), 6));
  assert.ok(result.rawLow > 0 && result.rawHigh > result.rawLow);
  close(result.rawHigh / result.rawLow, result.weightedHigh / result.weightedLow);
});

test("TP-71: the raw ratio of a spent row is the middle ratio of all finished tasks, not of the tasks over the cost so far", () => {
  // The five tasks under 6 percent have 1 raw token for each weighted token, the five over it have 10
  // (cache reads count 0.1 per token).
  const history = Array.from({ length: 10 }, (_, i) => {
    const weighted = WEEK_PER_PCT * (i + 1);
    return i < 5 ? taskFrom([weighted, 0, 0, 0, 0], null) : taskFrom([0, 0, 0, weighted * 10, 0], null);
  });
  const result = ranged(usedEstimate(history, 6));
  assert.equal(result.basisName, BASIS_SPENT);
  close(result.rawLow, result.weightedLow * 5.5);
  close(result.rawHigh, result.weightedHigh * 5.5);
});

test("the spent rule uses no floor: a history with every task under the floor still gives the spent basis", () => {
  const history = [task(FLOOR / 2, null), task(FLOOR / 3, null), task(FLOOR / 4, null)];
  assert.equal(usedEstimate(history, undefined).basis, "none", "the control: the fits leave out every task");
  const result = ranged(usedEstimate(history, 1));
  assert.deepEqual([result.basisName, result.count, result.open], [BASIS_SPENT, 0, true]);
});

test("the raw ratio of a spent row is the middle ratio of all finished tasks, also those under the floor", () => {
  // Six tasks under the floor have 10 raw tokens for each weighted token (cache reads count 0.1 per
  // token). Five tasks of 2 to 6 percent have 1. With a floor the middle ratio would be 1, and without
  // one it is 10.
  const small = [2, 3, 4, 5, 6, 7].map((divisor) => taskFrom([0, 0, 0, (FLOOR / divisor) * 10, 0], null));
  const large = [2, 3, 4, 5, 6].map((pct) => task(WEEK_PER_PCT * pct, null));
  const result = ranged(usedEstimate([...small, ...large], 1));
  assert.deepEqual([result.basisName, result.count, result.open], [BASIS_SPENT, 5, false]);
  close(result.rawLow, result.weightedLow * 10);
  close(result.rawHigh, result.weightedHigh * 10);
});

test("TP-45: with fewer than 5 tasks at or over the cost so far the range is open from the cost so far, with no typical and no budget", () => {
  const history = percentTasks();
  const nine = ranged(usedEstimate(history, 9.5));
  assert.deepEqual([nine.basis, nine.basisName, nine.count, nine.open], ["wide", BASIS_SPENT, 1, true]);
  close(nine.lowPct, 9.5);
  assert.deepEqual([nine.highPct, nine.weightedHigh, nine.rawHigh], [nine.lowPct, nine.weightedLow, nine.rawLow]);
  assert.deepEqual([nine.typicalPct, nine.budgetPct], [null, null]);
  // Four tasks are at or over 6.5 percent: still open. Five are at or over 6 percent: closed.
  assert.deepEqual([ranged(usedEstimate(history, 6.5)).open, ranged(usedEstimate(history, 6.5)).count], [true, 4]);
  assert.deepEqual([ranged(usedEstimate(history, 6)).open, ranged(usedEstimate(history, 6)).count], [false, 5]);
  // No task is at or over 11 percent: open, with a count of 0.
  const none = ranged(usedEstimate(history, 11));
  assert.deepEqual([none.basisName, none.count, none.open], [BASIS_SPENT, 0, true]);
});

test("TP-46: a cost so far of 0.4 percent changes nothing, and exactly 0.5 percent starts the rule over all ten tasks", () => {
  const history = percentTasks();
  assert.deepEqual(usedEstimate(history, 0.4), usedEstimate(history, undefined));
  const start = ranged(usedEstimate(history, 0.5));
  assert.deepEqual([start.basisName, start.count, start.open], [BASIS_SPENT, 10, false]);
  ladderOf(start).forEach((value, index) => close(value, [1.9, 5.5, 8.2, 9.1][index] ?? Number.NaN));
});

test("TP-46: a cost so far that is not a finite number changes nothing", () => {
  const history = percentTasks();
  const base = usedEstimate(history, undefined);
  for (const spent of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(only(estimateFromSignals([item("A", null, {}, spent)], history, WEEK_CAL)), base, String(spent));
  }
});

test("TP-47: a cost so far of 1 percent with no finished task keeps no basis, also with a ready week", () => {
  assert.equal(usedEstimate([], 1).basis, "none");
  // A task with no cost is not a checked task.
  assert.equal(usedEstimate([task(0, null), task(0, null), task(0, null)], 1).basis, "none");
});

test("TP-47: with two finished tasks and no fit, an item over the start value still gets the spent basis, open", () => {
  const result = ranged(usedEstimate([task(WEEK_PER_PCT, null), task(3 * WEEK_PER_PCT, null)], 2));
  assert.deepEqual([result.basisName, result.count, result.open], [BASIS_SPENT, 1, true]);
});

test("TP-50: the first spent pass writes one line with wide, spent and the stage run, and a larger cost so far writes none", () => {
  const history = percentTasks();
  const itemsAt = (pct: number): EstimateItem[] => [item("A", null, {}, pct * WEEK_PER_PCT)];
  const linesAt = (pct: number, written: readonly EstimateLogLine[], atMs: number): readonly EstimateLogLine[] =>
    newLogLines(itemsAt(pct), estimateFromSignals(itemsAt(pct), history, WEEK_CAL), written, atMs);
  const first = linesAt(0.4, [], 1_000);
  assert.deepEqual(first.map((line) => [line.basis, line.basisName, line.stage]), [["wide", BASIS_ALL, null]]);

  const started = linesAt(6, first, 2_000);
  assert.deepEqual(started.map((line) => [line.basis, line.basisName, line.stage]), [["wide", BASIS_SPENT, "run"]]);
  const [line] = started;
  assert.ok(line !== undefined && line.basis !== "none");
  close(line.low, 6.4 * WEEK_PER_PCT);
  close(line.high, 9.6 * WEEK_PER_PCT);

  const written = [...first, ...started];
  assert.deepEqual(linesAt(6.2, written, 3_000), [], "a larger cost so far");
  assert.deepEqual(linesAt(9.5, written, 4_000), [], "a larger cost so far, now an open range");
});

test("TP-51: an item with the stage tag plan, or with no stage tag, gets the stage run on its spent line", () => {
  const history = percentTasks();
  const stageOfLine = (candidate: EstimateItem): readonly (string | null)[] =>
    newLogLines([candidate], estimateFromSignals([candidate], history, WEEK_CAL), [], 1_000).map((line) => line.stage);
  assert.deepEqual(stageOfLine({ ...staged("A", "plan"), spent: 6 * WEEK_PER_PCT }), ["run"]);
  assert.deepEqual(stageOfLine({ ...item("A", null), spent: 6 * WEEK_PER_PCT }), ["run"]);
  // Under the start value the line keeps the stage tag of the item.
  assert.deepEqual(stageOfLine({ ...staged("A", "plan"), spent: 0.4 * WEEK_PER_PCT }), ["plan"]);
});

// ---------------------------------------------------------------------------
// TP-43, TP-65, TP-66: scores
// ---------------------------------------------------------------------------

test("TP-43: the all candidate scores exactly one", () => {
  const all = candidateOf(scoreCandidates(FIXTURE_TASKS, "claude"), { kind: "all" });
  assert.ok(all !== undefined);
  assert.equal(all.score, 1);
  assert.equal(all.count, 30);
});

test("TP-43: each candidate score is its leave-one-out error over the all error on its own tasks", () => {
  const candidates = scoreCandidates(FIXTURE_TASKS, "claude");
  const types = ["bug", "tech-debt", "feature", "documentation"];
  for (const type of types) {
    const indices = FIXTURE_TASKS.flatMap((t, i) => (t.tags["type"] === type ? [i] : []));
    const expected = bruteScore(FIXTURE_TASKS, indices, (rest) => median(rest.map((j) => logCost(at(FIXTURE_TASKS, j)))));
    const found = candidateOf(candidates, { kind: "type", type });
    assert.ok(found !== undefined, type);
    close(found.score, expected, 1e-9);
    assert.equal(found.count, indices.length);
  }
  assert.equal(candidateOf(candidates, { kind: "type", type: "testing" }), undefined);

  for (const feature of FIXTURE_FEATURES) {
    const indices = FIXTURE_TASKS.flatMap((t, i) => (Object.hasOwn(t.features, feature) ? [i] : []));
    const zOf = (i: number): number => Math.log1p(at(FIXTURE_TASKS, i).features[feature] ?? Number.NaN);
    const expected = bruteScore(FIXTURE_TASKS, indices, (rest, i) =>
      lineOf(rest.map(zOf), rest.map((j) => logCost(at(FIXTURE_TASKS, j))))(zOf(i)),
    );
    const found = candidateOf(candidates, { kind: "single", feature });
    assert.ok(found !== undefined, feature);
    close(found.score, expected, 1e-9);
    assert.equal(found.count, indices.length);
  }
  assert.ok(candidates.every((c) => Number.isFinite(c.score) && c.score >= 0));
});

test("TP-65: a type candidate is scored against the all prediction on its own tasks and wins when its group is tighter", () => {
  // Two types with costs far apart and tight inside each type.
  const history = [
    ...[100, 103, 98, 101, 99, 102].map((w) => task(w, "small")),
    ...[10_000, 10_300, 9_800, 10_100, 9_900, 10_200].map((w) => task(w, "large")),
  ];
  const candidates = scoreCandidates(history, "claude");
  const small = candidateOf(candidates, { kind: "type", type: "small" });
  assert.ok(small !== undefined);
  assert.ok(small.score < 0.1, `score ${small.score}`);
  const result = ranged(only(estimateFromSignals([item("A", "small")], history, CAL)));
  assert.equal(result.basisName, "type");
  assert.equal(result.count, 6);
  // The range is the 10th to 90th percentile of the group cost.
  assert.ok(result.rawLow >= 98 && result.rawHigh <= 103);
  // A type nobody has done falls back to all.
  assert.equal(only(estimateFromSignals([item("B", "other")], history, CAL)).basisName, "all");
});

test("TP-66: a candidate whose divisor is zero is dropped, and no score is NaN", () => {
  // Seven tasks cost the same, so the all error on them is zero. Three others differ.
  const history = [...Array.from({ length: 7 }, () => task(500, "flat")), task(50, "wild"), task(5_000, "wild"), task(90_000, "wild")];
  const candidates = scoreCandidates(history, "claude");
  assert.equal(candidateOf(candidates, { kind: "type", type: "flat" }), undefined);
  assert.ok(candidateOf(candidates, { kind: "type", type: "wild" }) !== undefined);
  assert.ok(candidates.every((c) => Number.isFinite(c.score)));
});

test("TP-66: when every task costs the same no candidate qualifies, and the item has no basis", () => {
  const history = Array.from({ length: 12 }, (_, i) => task(700, `t${i % 3}`, { size: 10 + i }));
  assert.deepEqual(scoreCandidates(history, "claude"), []);
  assert.equal(only(estimateFromSignals([item("A", "t0", { size: 50 })], history, CAL)).basis, "none");
});

test("TP-66: the all candidate needs a leave-one-out error above zero, so an item that no other candidate fits has no basis", () => {
  // Seven of ten tasks cost the same, so the middle all error is zero and the all score has no divisor.
  const history = [...Array.from({ length: 7 }, () => task(500, "flat")), task(50, "wild"), task(5_000, "wild"), task(90_000, "wild")];
  assert.equal(candidateOf(scoreCandidates(history, "claude"), { kind: "all" }), undefined);
  assert.equal(only(estimateFromSignals([item("A", "other")], history, CAL)).basis, "none");
});

test("TP-66: a score is null when its divisor is zero or not finite", () => {
  assert.equal(scoreRatio(1, 0), null);
  assert.equal(scoreRatio(0, 0), null);
  assert.equal(scoreRatio(1, Number.NaN), null);
  assert.equal(scoreRatio(1, Number.POSITIVE_INFINITY), null);
  assert.equal(scoreRatio(Number.NaN, 2), null);
  assert.equal(scoreRatio(1, 2), 0.5);
  assert.equal(scoreRatio(0, 2), 0);
});

// ---------------------------------------------------------------------------
// TP-51: no state between calls
// ---------------------------------------------------------------------------

test("TP-51: two estimate calls on the same input give the same result, whatever ran between them", () => {
  const history = [...sizeTasks(20, 91), ...plainTasks(5, 92)];
  const items = [item("A", "t0", { size: 300 }), item("B", "t1"), item("C", "t2", { size: 12_000 })];
  const before = JSON.stringify([items, history]);
  const first = estimateFromSignals(items, history, CAL);
  estimateFromSignals([item("Z", "t0", { f1: 5 })], pairTasks(45, 93, 0.6, 0.6, 0.1), CAL);
  const second = estimateFromSignals(items, history, CAL);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify([items, history]), before);
  assert.deepEqual(first.map((e) => e.key), ["A", "B", "C"]);
});

// ---------------------------------------------------------------------------
// The estimate log lines and the self-check: TP-23, TP-27, TP-28, TP-47, TP-63, TP-64
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const SEPTEMBER_1 = Date.UTC(2026, 8, 1);
const LOG_NOW = SEPTEMBER_1 + 70 * DAY_MS;

// The time `n` days after 1 September 2026, UTC.
function day(n: number): number {
  return SEPTEMBER_1 + n * DAY_MS;
}

// A log line with a wide range.
function logged(key: string, atMs: number, range: readonly [number, number] = [100, 400], over: Partial<RangedLogLine> = {}): RangedLogLine {
  return { at: atMs, key, basis: "wide", basisName: "all", features: [], stage: null, low: range[0], high: range[1], ...over };
}

// A log line with no basis.
function loggedNone(key: string, atMs: number, stage: string | null = null): NoBasisLogLine {
  return { at: atMs, key, basis: "none", basisName: "none", features: [], stage, low: null, high: null };
}

// An open item that carries a stage tag.
function staged(key: string, stage: string, features: Record<string, number> = {}): EstimateItem {
  return { key, tags: { stage }, features };
}

function finishedTask(label: string, start: number, end: number, weighted: number): FinishedTask {
  return { label, start, end, totals: { claude: totalsOf([weighted, 0, 0, 0, 0]), codex: totalsOf([0, 0, 0, 0, 0]) } };
}

// The estimate that the log line of a key would come from.
function estimateOf(key: string, basisName: string, low = 100, high = 400): SignalEstimate {
  if (basisName === "none") return { key, subscription: "claude", basis: "none", basisName: "none", label: "no basis yet" };
  const wide = basisName === "all" || basisName === "type";
  return {
    key,
    subscription: "claude",
    basis: wide ? "wide" : "similar",
    basisName,
    label: wide ? "wide, low confidence" : "similar",
    lowPct: low / PER_PCT,
    highPct: high / PER_PCT,
    rawLow: low,
    rawHigh: high,
    weightedLow: low,
    weightedHigh: high,
    count: 9,
    open: false,
    rough: false,
    typicalPct: low / PER_PCT,
    budgetPct: high / PER_PCT,
  };
}

test("TP-23: a line is written only when the key, the basis or the feature names change", () => {
  const items = [item("A", null, { size: 5 }), item("B", null)];
  const first = newLogLines(items, [estimateOf("A", "size", 100, 400), estimateOf("B", "all", 10, 20)], [], LOG_NOW);
  assert.deepEqual(first, [
    { at: LOG_NOW, key: "A", basis: "similar", basisName: "size", features: ["size"], stage: null, low: 100, high: 400 },
    { at: LOG_NOW, key: "B", basis: "wide", basisName: "all", features: [], stage: null, low: 10, high: 20 },
  ]);

  const same = [estimateOf("A", "size", 50, 900), estimateOf("B", "all", 10, 20)];
  assert.deepEqual(newLogLines(items, same, first, LOG_NOW + DAY_MS), [], "a moved range and moved values are no change");
  assert.deepEqual(newLogLines([item("A", null, { size: 9000 }), item("B", null)], same, first, LOG_NOW + DAY_MS), []);

  const renamed = newLogLines(items, [estimateOf("A", "type"), estimateOf("B", "all")], first, LOG_NOW + DAY_MS);
  assert.deepEqual(renamed.map((l) => [l.key, l.basis, l.basisName]), [["A", "wide", "type"]]);
  const lost = newLogLines(items, [estimateOf("A", "none"), estimateOf("B", "all")], first, LOG_NOW + DAY_MS);
  assert.deepEqual(lost, [{ at: LOG_NOW + DAY_MS, key: "A", basis: "none", basisName: "none", features: ["size"], stage: null, low: null, high: null }]);
  const moreNames = newLogLines([item("A", null, { size: 5, churn: 3 }), item("B", null)], same, first, LOG_NOW + DAY_MS);
  assert.deepEqual(moreNames.map((l) => [l.key, l.features]), [["A", ["churn", "size"]]]);
  const newKey = newLogLines([...items, item("C", null)], [...same, estimateOf("C", "all")], first, LOG_NOW + DAY_MS);
  assert.deepEqual(newKey.map((l) => l.key), ["C"]);
});

test("TP-23: a change of the basis name only, inside one basis word, writes one new line, and a repeat writes none", () => {
  const items = [item("A", null, { size: 5 })];
  const first = newLogLines(items, [estimateOf("A", "size")], [], LOG_NOW);
  assert.deepEqual(first.map((l) => [l.basis, l.basisName]), [["similar", "size"]]);

  const renamed = newLogLines(items, [estimateOf("A", "churn")], first, LOG_NOW + DAY_MS);
  assert.deepEqual(renamed.map((l) => [l.key, l.basis, l.basisName, l.features]), [["A", "similar", "churn", ["size"]]]);

  const repeat = newLogLines(items, [estimateOf("A", "churn")], [...first, ...renamed], LOG_NOW + 2 * DAY_MS);
  assert.deepEqual(repeat, []);
});

test("TP-23: a line is compared with the last line of its key in the log, and one key gets one line in a call", () => {
  const history = [logged("A", day(1), [1, 2], { basisName: "size", basis: "similar" }), logged("A", day(2), [1, 2])];
  const items = [item("A", null)];
  assert.deepEqual(newLogLines(items, [estimateOf("A", "all")], history, LOG_NOW), [], "the last line says all");
  assert.equal(newLogLines(items, [estimateOf("A", "size")], history, LOG_NOW).length, 1, "the first line is not the one to compare with");
  const twice = newLogLines([item("D", null), item("D", null)], [estimateOf("D", "all"), estimateOf("D", "all")], [], LOG_NOW);
  assert.equal(twice.length, 1);
});

test("a line stores the stage tag of its item on a ranged line and on a line with no basis, and stage null without a tag", () => {
  const items = [staged("A", "issue", { size: 5 }), staged("B", "plan"), item("C", null)];
  const estimates = [estimateOf("A", "size"), estimateOf("B", "none"), estimateOf("C", "all")];
  const lines = newLogLines(items, estimates, [], LOG_NOW);
  assert.deepEqual(lines.map((l) => [l.key, l.basis, l.stage]), [
    ["A", "similar", "issue"],
    ["B", "none", "plan"],
    ["C", "wide", null],
  ]);
});

test("a stage change with the same basis writes one new line, and a repeat in the same stage writes none", () => {
  const estimates = [estimateOf("A", "size")];
  const first = newLogLines([staged("A", "issue", { size: 5 })], estimates, [], LOG_NOW);
  assert.equal(first.length, 1);
  const moved = newLogLines([staged("A", "plan", { size: 5 })], estimates, first, LOG_NOW + DAY_MS);
  assert.deepEqual(moved.map((l) => [l.key, l.basisName, l.stage]), [["A", "size", "plan"]]);
  const repeat = newLogLines([staged("A", "plan", { size: 5 })], estimates, [...first, ...moved], LOG_NOW + 2 * DAY_MS);
  assert.deepEqual(repeat, []);
  const dropped = newLogLines([{ key: "A", tags: {}, features: { size: 5 } }], estimates, [...first, ...moved], LOG_NOW + 2 * DAY_MS);
  assert.deepEqual(dropped.map((l) => l.stage), [null], "an item that loses its tag is a stage change to null");
});

test("an item with no stage tag keeps its line when the log holds a line with stage null", () => {
  const first = newLogLines([item("A", null, { size: 5 })], [estimateOf("A", "size")], [], LOG_NOW);
  assert.deepEqual(newLogLines([item("A", null, { size: 5 })], [estimateOf("A", "size")], first, LOG_NOW + DAY_MS), []);
});

test("a stage that the tag object only inherits reads as stage null", () => {
  const tags: Record<string, string> = Object.create({ stage: "plan" }) as Record<string, string>;
  const [line] = newLogLines([{ key: "A", tags, features: {} }], [estimateOf("A", "all")], [], LOG_NOW);
  assert.equal(line?.stage, null);
});

test("the stage labels __proto__, constructor and toString are stored as the stage of the line and change no prototype", () => {
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  for (const label of ["__proto__", "constructor", "toString"]) {
    const [line] = newLogLines([staged("A", label)], [estimateOf("A", "all")], [], LOG_NOW);
    assert.equal(line?.stage, label);
    assert.ok(line !== undefined && Object.hasOwn(line, "stage"));
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

// Labels K0.. each with one window of the given cost and one line before it ends.
function checkedTasks(costs: readonly number[], range: readonly [number, number] = [100, 400]): { lines: EstimateLogLine[]; tasks: FinishedTask[] } {
  const lines = costs.map((_, i) => logged(`K${i}`, day(1 + i), range));
  const tasks = costs.map((cost, i) => finishedTask(`K${i}`, day(2 + i), day(3 + i), cost));
  return { lines, tasks };
}

test("TP-28: four scored tasks give nulls and five scored tasks give the hit rate and the error factor", () => {
  // Range 100 to 400 has the middle 200. The factors are 1, 4, 4, 2 and 2, so the median is 2.
  const { lines, tasks } = checkedTasks([200, 800, 50, 400, 100]);
  const five = selfCheck(lines, tasks);
  assert.equal(five.scored, 5);
  close(five.hitRate ?? Number.NaN, 3 / 5);
  close(five.errorFactor ?? Number.NaN, 2);

  const four = selfCheck(lines.slice(0, 4), tasks.slice(0, 4));
  assert.deepEqual([four.scored, four.hitRate, four.errorFactor], [4, null, null]);
  assert.deepEqual([selfCheck([], []).scored, selfCheck([], []).hitRate], [0, null]);
});

test("TP-28: the ends of the range are hits, and the error factor reads the same above and below the middle", () => {
  const { lines, tasks } = checkedTasks([100, 400, 100, 400, 100]);
  const result = selfCheck(lines, tasks);
  assert.equal(result.hitRate, 1);
  close(result.errorFactor ?? Number.NaN, 2);
  const out = checkedTasks([50, 50, 50, 800, 800]);
  const missed = selfCheck(out.lines, out.tasks);
  assert.equal(missed.hitRate, 0);
  close(missed.errorFactor ?? Number.NaN, 4);
});

test("TP-28: a line with no basis and a task with no cost are linked but not scored", () => {
  const { lines, tasks } = checkedTasks([200, 200, 200, 200, 200, 0, 200]);
  const withNone = lines.map((l, i) => (i === 6 ? loggedNone(l.key, l.at) : l));
  const result = selfCheck(withNone, tasks);
  assert.equal(result.scored, 5, "the zero cost and the line with no basis are left out");
  assert.equal(result.hitRate, 1);
});

test("TP-27: a line links to the first window with its label that ends after the log time, and each window counts once", () => {
  const lines: EstimateLogLine[] = [];
  const tasks: FinishedTask[] = [];
  for (let i = 0; i < 5; i += 1) {
    const key = `K${i}`;
    // Window one costs 200, window two costs 5000.
    tasks.push(finishedTask(key, day(2), day(3), 200), finishedTask(key, day(6), day(7), 5000));
    // Before window one ends: a wrong early line, then the right one. Between the windows: the same.
    lines.push(logged(key, day(0.5), [1, 2]), logged(key, day(1), [100, 400]));
    lines.push(logged(key, day(4), [1, 2]), logged(key, day(5), [4000, 6000]));
  }
  const result = selfCheck(lines, tasks);
  assert.equal(result.scored, 10, "twenty lines, ten windows");
  assert.equal(result.hitRate, 1, "the last line before a window ends is the one that counts");
});

test("TP-27: a line written after the last window of its label ended links to nothing", () => {
  const { tasks } = checkedTasks([200, 200, 200, 200, 200]);
  const late = tasks.map((task) => logged(task.label, task.end + 1));
  const result = selfCheck(late, tasks);
  assert.deepEqual([result.scored, result.hitRate], [0, null]);
});

test("TP-28: only the thirty most recent finished tasks are scored", () => {
  const { lines, tasks } = checkedTasks(Array.from({ length: 31 }, () => 200));
  const result = selfCheck(lines, tasks);
  assert.equal(result.scored, 30);
  const shuffled = selfCheck([...lines].reverse(), [...tasks].reverse());
  assert.deepEqual(shuffled, result, "the order of the input does not matter");
});

// The 2.5% and 97.5% quantiles of a Binomial(n, 4/5) count, from the probabilities as
// floating point numbers. It is an independent check of the exact integer rule.
function floatBand(n: number): { low: number; high: number } {
  let row = [1];
  for (let i = 0; i < n; i += 1) row = Array.from({ length: i + 2 }, (_, j) => (row[j - 1] ?? 0) + (row[j] ?? 0));
  let cumulative = 0;
  let low = -1;
  let high = -1;
  row.forEach((choose, k) => {
    cumulative += choose * 0.8 ** k * 0.2 ** (n - k);
    if (low < 0 && cumulative >= 0.025) low = k;
    if (high < 0 && cumulative >= 0.975) high = k;
  });
  return { low: low / n, high: high / n };
}

test("the band of the hit rate is the exact 2.5% and 97.5% quantile of a count with chance 4/5, divided by the tasks", () => {
  assert.deepEqual(hitRateBand(5), { low: 0.4, high: 1 });
  assert.deepEqual(hitRateBand(10), { low: 0.5, high: 1 });
  assert.deepEqual(hitRateBand(30), { low: 19 / 30, high: 28 / 30 });
});

test("the band of the hit rate agrees with a floating point count of the same chance for each size from 1 to 30", () => {
  for (let n = 1; n <= 30; n += 1) assert.deepEqual(hitRateBand(n), floatBand(n), `n ${n}`);
});

test("the band of the hit rate is null for a size that is not an integer from 1 to 30, and it never throws", () => {
  for (const n of [0, 31, 1.5, Number.NaN, -1, 2 ** 53, 2 ** 31, 1e9, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER]) {
    assert.equal(hitRateBand(n), null, String(n));
  }
});

// ---- bias, band and stages of the self-check ----

// A time `hours` before the task starts. Every such line is before the task ends.
function before(task: FinishedTask, hours: number): number {
  return task.start - hours * 3_600_000;
}

// Five tasks K0 to K4 that cost 200 each, with the lines that `make` gives for each of them.
function fiveWith(make: (task: FinishedTask) => EstimateLogLine[]): { lines: EstimateLogLine[]; tasks: FinishedTask[] } {
  const { tasks } = checkedTasks([200, 200, 200, 200, 200]);
  return { tasks, lines: tasks.flatMap(make) };
}

function stageCheck(result: SelfCheck, stage: string): StageCheck {
  const found = result.stages.get(stage);
  assert.ok(found !== undefined, `no stage ${stage}`);
  return found;
}

const EMPTY_CHECK: StageCheck = { scored: 0, hitRate: null, errorFactor: null, bias: null, bandLow: null, bandHigh: null, width: null, usefulRate: null };

test("the bias is exp of the median of log middle minus log cost: above 1 for a range above the cost, below 1 for one below", () => {
  const high = checkedTasks([100, 100, 100, 100, 100]);
  close(selfCheck(high.lines, high.tasks).bias ?? Number.NaN, 2);
  const low = checkedTasks([400, 400, 400, 400, 400]);
  close(selfCheck(low.lines, low.tasks).bias ?? Number.NaN, 0.5);
  // The middle of 100 to 400 is 200. The ratios are 4, 2, 2, 2 and 1/4, so the median log is log 2.
  const mixed = checkedTasks([50, 100, 100, 100, 800]);
  close(selfCheck(mixed.lines, mixed.tasks).bias ?? Number.NaN, 2);
  const exact = checkedTasks([200, 200, 200, 200, 200]);
  close(selfCheck(exact.lines, exact.tasks).bias ?? Number.NaN, 1);
});

test("the bias is null under five scored tasks", () => {
  const { lines, tasks } = checkedTasks([100, 100, 100, 100, 100]);
  const four = selfCheck(lines.slice(0, 4), tasks.slice(0, 4));
  assert.deepEqual([four.scored, four.bias], [4, null]);
});

test("a range so far above the cost that exp overflows, or so far below that exp underflows to zero, gives bias and error factor null, at the top level and for a stage", () => {
  const planned = (lines: readonly EstimateLogLine[]): EstimateLogLine[] => lines.map((line) => ({ ...line, stage: "plan" }));
  const over = checkedTasks(Array.from({ length: 5 }, () => 1e-300), [1e307, 1e308]);
  const above = selfCheck(planned(over.lines), over.tasks);
  assert.deepEqual([above.scored, above.bias, above.errorFactor], [5, null, null]);
  const abovePlan = stageCheck(above, "plan");
  assert.deepEqual([abovePlan.scored, abovePlan.bias, abovePlan.errorFactor], [5, null, null]);
  const under = checkedTasks(Array.from({ length: 5 }, () => 1e300), [1e-300, 1e-299]);
  const below = selfCheck(planned(under.lines), under.tasks);
  assert.deepEqual([below.scored, below.bias, below.errorFactor], [5, null, null]);
  const belowPlan = stageCheck(below, "plan");
  assert.deepEqual([belowPlan.scored, belowPlan.bias, belowPlan.errorFactor], [5, null, null]);
});

test("the band of the self-check is the helper band for the scored count, not for the hits, and null under five scored", () => {
  // Range 100 to 400 has the middle 200. The costs 400, 400, 400 and 200 are hits and 50 is a miss:
  // 4 hits of 5 scored. The offsets are -log 2 three times, 0 and log 4, so the bias is 1/2 and the error factor 2.
  const mixed = checkedTasks([400, 400, 400, 200, 50]);
  const result = selfCheck(mixed.lines, mixed.tasks);
  assert.equal(result.scored, 5);
  close(result.hitRate ?? Number.NaN, 0.8);
  close(result.errorFactor ?? Number.NaN, 2);
  close(result.bias ?? Number.NaN, 0.5);
  assert.notEqual(result.bias, result.errorFactor);
  const band = hitRateBand(5);
  assert.ok(band !== null);
  assert.notDeepEqual(hitRateBand(4), band, "the fixture must tell the scored count from the hit count");
  assert.deepEqual([result.bandLow, result.bandHigh], [band.low, band.high]);
  const four = selfCheck(mixed.lines.slice(0, 4), mixed.tasks.slice(0, 4));
  assert.deepEqual([four.bandLow, four.bandHigh], [null, null]);
});

test("a check over more scored tasks than the band covers gives no hit rate and no numbers, never a hit rate with no band", () => {
  const { tasks } = checkedTasks(Array.from({ length: SELF_CHECK_TASKS + 1 }, () => 200));
  const pairs = tasks.map((task) => ({ task, line: logged(task.label, task.start - 1) }));
  assert.equal(checkOf(pairs.slice(0, SELF_CHECK_TASKS), "claude").hitRate, 1);
  assert.deepEqual(checkOf(pairs, "claude"), {
    scored: SELF_CHECK_TASKS + 1,
    hitRate: null,
    errorFactor: null,
    bias: null,
    bandLow: null,
    bandHigh: null,
    width: null,
    usefulRate: null,
  });
});

// ---- width and useful rate of the self-check ----

// One scored pair for each (low, high, cost) row. Every task is its own label.
function pairsFrom(rows: ReadonlyArray<readonly [number, number, number]>): ScoredPair[] {
  return rows.map(([low, high, cost], i) => ({
    task: finishedTask(`W${i}`, day(2 + i), day(3 + i), cost),
    line: logged(`W${i}`, day(1 + i), [low, high]),
  }));
}

test("the width is the median of high over low and the useful rate counts the hits whose high end is at most four times the low end", () => {
  // Ratios 2, 4, 5, 3 and 1. The costs 150, 300 and 200 are hits, 400 and 300 are not.
  // The ratio 4 is useful at its bound (400 is 4 times 100); the ratio 5 is a hit that is too wide.
  const result = checkOf(
    pairsFrom([
      [100, 200, 150],
      [100, 400, 300],
      [100, 500, 200],
      [100, 300, 400],
      [200, 200, 300],
    ]),
    "claude",
  );
  assert.equal(result.scored, 5);
  assert.equal(result.width, 3);
  close(result.hitRate ?? Number.NaN, 0.6);
  close(result.usefulRate ?? Number.NaN, 0.4);
});

test("the width of six ranges with the ratios 1 to 6 is 3.5, and an open line with equal ends counts as ratio 1", () => {
  const rows = [1, 2, 3, 4, 5, 6].map((ratio): readonly [number, number, number] => [100, 100 * ratio, 100]);
  assert.deepEqual(rows[0], [100, 100, 100], "the ratio 1 line is an open line: its ends are equal");
  const result = checkOf(pairsFrom(rows), "claude");
  assert.equal(result.scored, 6);
  assert.equal(result.width, 3.5);
});

test("the width and the useful rate are null under five scored tasks, at the top level and in a stage", () => {
  const { lines, tasks } = checkedTasks([200, 200, 200, 200]);
  const planned = lines.map((line) => ({ ...line, stage: "plan" }));
  const four = selfCheck(planned, tasks);
  assert.deepEqual([four.scored, four.width, four.usefulRate], [4, null, null]);
  const plan = stageCheck(four, "plan");
  assert.deepEqual([plan.scored, plan.width, plan.usefulRate], [4, null, null]);
  assert.deepEqual(checkOf([], "claude"), EMPTY_CHECK);
});

test("a width that is not finite is null and the other numbers stay: a range from 1e-300 to 1e10 is a hit that is not useful", () => {
  const narrow: readonly [number, number, number] = [100, 200, 150];
  const huge: readonly [number, number, number] = [1e-300, 1e10, 150];
  const one = checkOf(pairsFrom([narrow, narrow, narrow, narrow, huge]), "claude");
  assert.equal(one.width, 2);
  assert.equal(one.hitRate, 1);
  close(one.usefulRate ?? Number.NaN, 0.8);
  // The median of 2, 2, infinity, infinity and infinity is infinity: no width, and the rest is kept.
  const three = checkOf(pairsFrom([narrow, narrow, huge, huge, huge]), "claude");
  assert.equal(three.width, null);
  assert.equal(three.hitRate, 1);
  close(three.usefulRate ?? Number.NaN, 0.4);
  assert.ok(three.errorFactor !== null && three.bias !== null && three.bandLow !== null && three.bandHigh !== null);
});

test("a scored task under the floor still counts in the self-check", () => {
  const tiny = checkedTasks([FLOOR / 10, FLOOR / 10, FLOOR / 10, FLOOR / 10, FLOOR / 10], [FLOOR / 20, FLOOR / 5]);
  const result = selfCheck(tiny.lines, tiny.tasks);
  assert.equal(result.scored, 5);
  assert.equal(result.hitRate, 1);
  assert.equal(result.width, 4);
});

test("selfCheck and keepTime change none of their inputs, and give the same answer twice", () => {
  const { lines, tasks } = checkedTasks(Array.from({ length: SELF_CHECK_TASKS }, () => 200));
  // Each task has a plan line and an older issue line. Every input is frozen, so a change throws.
  const frozenLines = Object.freeze(
    lines.flatMap((line) => [Object.freeze({ ...line, stage: "plan" }), Object.freeze({ ...line, at: line.at - 1, stage: "issue" })]),
  );
  const finished = Object.freeze(tasks.map((task) => Object.freeze({ ...task })));
  // A window of K0 that ended and is not among the finished tasks.
  const windows = Object.freeze([Object.freeze({ label: "K0", start: day(0), end: day(2) })]);
  const input = { lines: frozenLines, damaged: false, finished, openKeys: Object.freeze(["K1", "K2"]), windows };
  assert.deepEqual(selfCheck(frozenLines, finished), selfCheck(frozenLines, finished));
  assert.equal(keepTime(input), day(1) - 1);
  assert.equal(keepTime(input), keepTime(input));
});

test("each stage scores the latest line of that stage that links to the task, over the same thirty tasks, with the keys in text order", () => {
  // Plan comes first in the input. The issue line at 10 hours is the latest line, and it is a hit.
  const { lines, tasks } = fiveWith((task) => [
    logged(task.label, before(task, 15), [10, 20], { stage: "plan" }),
    logged(task.label, before(task, 20), [10, 20], { stage: "issue" }),
    logged(task.label, before(task, 10), [100, 400], { stage: "issue" }),
  ]);
  const result = selfCheck(lines, tasks);
  assert.deepEqual([...result.stages.keys()], ["issue", "plan"]);
  assert.deepEqual([stageCheck(result, "issue").scored, stageCheck(result, "issue").hitRate], [5, 1]);
  assert.deepEqual([stageCheck(result, "plan").scored, stageCheck(result, "plan").hitRate], [5, 0]);
  assert.equal(result.hitRate, 1, "the top level reads the latest line of any stage");

  // The 31st task is outside the thirty most recent, so its stage is not read.
  const many = checkedTasks(Array.from({ length: 31 }, () => 200));
  const oldest = many.lines.map((line) => (line.key === "K0" ? { ...line, stage: "ancient" } : line));
  const thirty = selfCheck(oldest, many.tasks);
  assert.equal(thirty.stages.size, 0);
  assert.equal(thirty.scored, 30);
});

test("a line with no stage counts at the top level only, and the top level still reads the latest line of any stage", () => {
  const { lines, tasks } = fiveWith((task) => [
    logged(task.label, before(task, 20), [10, 20], { stage: "issue" }),
    logged(task.label, before(task, 10), [100, 400]),
  ]);
  const result = selfCheck(lines, tasks);
  assert.deepEqual([...result.stages.keys()], ["issue"]);
  assert.equal(stageCheck(result, "issue").hitRate, 0);
  assert.equal(result.hitRate, 1, "the latest line has no stage");
  const plain = checkedTasks([200, 200, 200, 200, 200]);
  assert.equal(selfCheck(plain.lines, plain.tasks).stages.size, 0);
});

test("one task scores in both of its stages, so the stage counts can sum past the top level count", () => {
  const { lines, tasks } = fiveWith((task) => [
    logged(task.label, before(task, 20), [100, 400], { stage: "issue" }),
    logged(task.label, before(task, 10), [100, 400], { stage: "plan" }),
  ]);
  const result = selfCheck(lines, tasks);
  assert.equal(result.scored, 5);
  assert.deepEqual([stageCheck(result, "issue").scored, stageCheck(result, "plan").scored], [5, 5]);
});

test("a stage whose linked lines have no basis shows n 0 with null numbers, and a stage under five scored shows null numbers", () => {
  const { tasks } = checkedTasks([200, 200, 200, 200, 200]);
  const lines = [
    ...tasks.map((task) => loggedNone(task.label, before(task, 10), "blank")),
    ...tasks.slice(0, 4).map((task) => logged(task.label, before(task, 20), [100, 400], { stage: "few" })),
  ];
  const result = selfCheck(lines, tasks);
  assert.deepEqual(stageCheck(result, "blank"), EMPTY_CHECK);
  assert.deepEqual(stageCheck(result, "few"), { ...EMPTY_CHECK, scored: 4 });
});

test("of two lines of one stage with the same time, the later one in the input wins", () => {
  const { tasks } = checkedTasks([200, 200, 200, 200, 200]);
  const miss = tasks.map((task) => logged(task.label, before(task, 10), [10, 20], { stage: "plan" }));
  const hit = tasks.map((task) => logged(task.label, before(task, 10), [100, 400], { stage: "plan" }));
  const hitLast = selfCheck([...miss, ...hit], tasks);
  assert.deepEqual([stageCheck(hitLast, "plan").hitRate, hitLast.hitRate], [1, 1]);
  const missLast = selfCheck([...hit, ...miss], tasks);
  assert.deepEqual([stageCheck(missLast, "plan").hitRate, missLast.hitRate], [0, 0]);
});

test("a stage line written after its window ended links to the next window of the label, never back to the ended window", () => {
  const lines: EstimateLogLine[] = [];
  const tasks: FinishedTask[] = [];
  for (let i = 0; i < 5; i += 1) {
    const key = `K${i}`;
    // Window one costs 200 and window two costs 5000. The plan line falls between them.
    tasks.push(finishedTask(key, day(2), day(3), 200), finishedTask(key, day(6), day(7), 5000));
    lines.push(logged(key, day(1), [100, 400], { stage: "issue" }), logged(key, day(4), [4000, 6000], { stage: "plan" }));
  }
  const result = selfCheck(lines, tasks);
  assert.deepEqual([stageCheck(result, "issue").scored, stageCheck(result, "issue").hitRate], [5, 1]);
  assert.deepEqual([stageCheck(result, "plan").scored, stageCheck(result, "plan").hitRate], [5, 1]);
});

test("a stage line written after the last window of its label ended links to nothing, and its stage does not show", () => {
  const { lines, tasks } = fiveWith((task) => [logged(task.label, task.end + 1, [100, 400], { stage: "plan" })]);
  const result = selfCheck(lines, tasks);
  assert.deepEqual([result.scored, result.stages.size], [0, 0]);
});

test("a stage line written at exactly the end of a window does not link to it: it links to the next window of its label, or to nothing", () => {
  const last = fiveWith((task) => [logged(task.label, task.end, [100, 400], { stage: "plan" })]);
  const none = selfCheck(last.lines, last.tasks);
  assert.deepEqual([none.scored, none.stages.size], [0, 0]);

  const lines: EstimateLogLine[] = [];
  const tasks: FinishedTask[] = [];
  for (let i = 0; i < 5; i += 1) {
    const key = `K${i}`;
    // Window one costs 200 and window two costs 5000. The plan line is at the end of window one.
    tasks.push(finishedTask(key, day(2), day(3), 200), finishedTask(key, day(6), day(7), 5000));
    lines.push(logged(key, day(3), [4000, 6000], { stage: "plan" }));
  }
  const next = selfCheck(lines, tasks);
  assert.deepEqual([stageCheck(next, "plan").scored, stageCheck(next, "plan").hitRate], [5, 1]);
});

test("a task with an issue line before its end and a plan line after its end scores in issue only", () => {
  const { lines, tasks } = fiveWith((task) => [
    logged(task.label, before(task, 10), [100, 400], { stage: "issue" }),
    logged(task.label, task.end + 1, [10, 20], { stage: "plan" }),
  ]);
  const result = selfCheck(lines, tasks);
  assert.deepEqual([...result.stages.keys()], ["issue"]);
  assert.equal(stageCheck(result, "issue").scored, 5);
  assert.equal(result.hitRate, 1, "the line after the end is not the latest line that links");
});

test("fifty stages on thirty tasks keep eight in the snapshot: the most tasks first, ties by text, shown in text order", () => {
  const { lines: base, tasks } = checkedTasks(Array.from({ length: 30 }, () => 200));
  // Stage j is named s(49 - j), so the stages with the most tasks have the highest names.
  // The task count of stage j is 30 - ceil(j / 2): 30, 29, 29, 28, 28, and so on.
  const stageLines = Array.from({ length: 50 }, (_, j) => {
    const count = 30 - Math.ceil(j / 2);
    return tasks.slice(0, count).map((task, i) => logged(task.label, before(task, 100 - j) + i, [100, 400], { stage: `s${49 - j}` }));
  }).flat();
  const result = selfCheck([...base, ...stageLines], tasks);
  // s49 has 30 tasks. s48 and s47 have 29 and s46 and s45 have 28. s44 and s43 have 27.
  // s42 and s41 tie at 26, and one place is left: the lower name s41 takes it.
  assert.deepEqual([...result.stages.keys()], ["s41", "s43", "s44", "s45", "s46", "s47", "s48", "s49"]);
  assert.equal(stageCheck(result, "s49").scored, 30);
  assert.equal(stageCheck(result, "s41").scored, 26);
});

test("the stage labels __proto__, constructor and toString are own entries of the stage map and change no prototype", () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype).sort();
  const labels = ["toString", "constructor", "__proto__"];
  const { lines, tasks } = fiveWith((task) => labels.map((stage, i) => logged(task.label, before(task, i + 1), [100, 400], { stage })));
  const result = selfCheck(lines, tasks);
  assert.deepEqual([...result.stages.keys()], ["__proto__", "constructor", "toString"]);
  for (const label of labels) assert.equal(stageCheck(result, label).scored, 5, label);
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), prototypeNames);
});

// A line of the spent rule: the basis name spent and the stage run.
function spentLine(key: string, atMs: number, range: readonly [number, number] = [100, 400]): RangedLogLine {
  return logged(key, atMs, range, { basisName: BASIS_SPENT, stage: "run" });
}

test("TP-10: the top level skips spent lines: a fit line that hits and a later spent line that misses give a top hit rate of 1 and a run hit rate of 0", () => {
  // Each task costs 200. The fit line 100 to 400 hits it. The later spent line 10 to 20 misses it.
  const { lines, tasks } = fiveWith((task) => [logged(task.label, before(task, 2)), spentLine(task.label, before(task, 1), [10, 20])]);
  const result = selfCheck(lines, tasks);
  assert.deepEqual([result.scored, result.hitRate], [5, 1]);
  const run = stageCheck(result, "run");
  assert.deepEqual([run.scored, run.hitRate], [5, 0]);
});

test("TP-10: a task whose lines are all spent lines is not scored at the top level, and is scored in the run stage", () => {
  const { lines, tasks } = fiveWith((task) => [spentLine(task.label, before(task, 1))]);
  const result = selfCheck(lines, tasks);
  assert.deepEqual([result.scored, result.hitRate], [0, null]);
  assert.deepEqual([stageCheck(result, "run").scored, stageCheck(result, "run").hitRate], [5, 1]);
});

test("TP-69: with no spent line in the log the top level is the check of the latest line of each task", () => {
  // The older line of each task misses and the latest hits. A line of a stage in between changes nothing.
  const { lines, tasks } = fiveWith((task) => [
    logged(task.label, before(task, 3), [10, 20]),
    logged(task.label, before(task, 2), [10, 20], { stage: "plan" }),
    logged(task.label, before(task, 1), [100, 400]),
  ]);
  const { stages, ...top } = selfCheck(lines, tasks);
  assert.equal(stages.size, 1);
  assert.deepEqual(top, checkOf(tasks.map((task) => ({ task, line: logged(task.label, before(task, 1), [100, 400]) })), "claude"));
  assert.equal(top.hitRate, 1);
});

test("TP-53: a user item with the stage run and a spent item count in the one run stage row", () => {
  // K0 to K2 are items that carry the stage tag run. K3 and K4 are on the spent rule.
  const { lines, tasks } = fiveWith((task) =>
    Number(task.label.slice(1)) < 3
      ? [logged(task.label, before(task, 1), [100, 400], { stage: "run" })]
      : [spentLine(task.label, before(task, 1))],
  );
  const result = selfCheck(lines, tasks);
  assert.deepEqual([...result.stages.keys()], ["run"]);
  assert.equal(stageCheck(result, "run").scored, 5);
  assert.equal(result.scored, 3, "the two spent tasks are not scored at the top level");
});

// Thirty finished tasks that ended in November 2026 and have a line in October.
function thirtyTasks(): { lines: EstimateLogLine[]; tasks: FinishedTask[] } {
  const november = Date.UTC(2026, 10, 1);
  const october = Date.UTC(2026, 9, 15);
  const tasks = Array.from({ length: 30 }, (_, i) => finishedTask(`K${i}`, november + i * DAY_MS, november + i * DAY_MS + 3_600_000, 200));
  return { tasks, lines: tasks.map((task) => logged(task.label, october)) };
}

// The keep time of a state of the log, in a log that was read in full unless `damaged`.
function keepOf(
  lines: readonly EstimateLogLine[],
  finished: readonly FinishedTask[],
  openKeys: readonly string[] = [],
  damaged = false,
): number | null {
  return keepTime({ lines, damaged, finished, openKeys, windows: [] });
}

// The UTC month of the keep time: the oldest month file that the log must keep.
function keepMonthOf(
  lines: readonly EstimateLogLine[],
  finished: readonly FinishedTask[],
  openKeys: readonly string[] = [],
  damaged = false,
): string | null {
  const time = keepOf(lines, finished, openKeys, damaged);
  return time === null ? null : utcMonthOf(time);
}

test("TP-64: the keep time is the time of the oldest line linked to the thirty most recent finished tasks", () => {
  const { lines, tasks } = thirtyTasks();
  assert.equal(keepOf(lines, tasks), Date.UTC(2026, 9, 15));
  const olderAt = Date.UTC(2026, 8, 3, 7, 30);
  const older = lines.map((l) => (l.key === "K7" ? { ...l, at: olderAt } : l));
  assert.equal(keepOf(older, tasks), olderAt, "the time of the line, not the start of its month");
  assert.equal(keepMonthOf(older, tasks), "2026-09");
  // A line of a key with no finished window and no open item does not count.
  const stray = [...lines, logged("GONE", Date.UTC(2026, 0, 5))];
  assert.equal(keepMonthOf(stray, tasks), "2026-10");
  // Nor does a line that a later line of the same window replaced.
  const replaced = [...lines, logged("K3", Date.UTC(2026, 6, 5)), logged("K3", Date.UTC(2026, 9, 20))];
  assert.equal(keepMonthOf(replaced, tasks), "2026-10");
});

test("TP-64: a finished task outside the thirty most recent keeps no month", () => {
  const { lines, tasks } = thirtyTasks();
  const oldest = finishedTask("OLD", Date.UTC(2026, 9, 1), Date.UTC(2026, 9, 2), 200);
  const withOld = keepMonthOf([...lines, logged("OLD", Date.UTC(2026, 5, 5))], [oldest, ...tasks]);
  assert.equal(withOld, "2026-10", "the 31st task is not among the thirty most recent");
});

test("TP-64: the last line of each open item keeps its month", () => {
  const { lines, tasks } = thirtyTasks();
  const open = [logged("OPEN", Date.UTC(2026, 6, 20)), logged("OPEN", Date.UTC(2026, 7, 2)), logged("OTHER", Date.UTC(2026, 8, 9))];
  assert.equal(keepMonthOf([...lines, ...open], tasks, ["OPEN"]), "2026-08", "July holds an older line of the open item, not its last");
  assert.equal(keepMonthOf([...lines, ...open], tasks, ["OPEN", "OTHER"]), "2026-08");
  assert.equal(keepMonthOf([...lines, ...open], tasks, ["OTHER"]), "2026-09");
  assert.equal(keepMonthOf([...lines, ...open], tasks, []), "2026-10", "an item that is not open and has no window needs no line");
});

test("TP-63: an item logged two months before its window starts keeps that month while the window is among the thirty most recent", () => {
  const { lines, tasks } = thirtyTasks();
  const early = Date.UTC(2026, 6, 20);
  const long = tasks.map((task, i) => (i === 12 ? finishedTask(task.label, Date.UTC(2026, 8, 20), task.end, 200) : task));
  const withEarly = lines.map((l) => (l.key === "K12" ? { ...l, at: early } : l));
  assert.equal(keepMonthOf(withEarly, long), "2026-07");
  // The same task pushed out of the thirty most recent by newer ones.
  const newer = Array.from({ length: 30 }, (_, i) => finishedTask(`N${i}`, Date.UTC(2026, 11, 1 + i), Date.UTC(2026, 11, 1 + i, 1), 200));
  const pushed = keepMonthOf([...withEarly, ...newer.map((task) => logged(task.label, Date.UTC(2026, 10, 20)))], [...long, ...newer]);
  assert.equal(pushed, "2026-11");
});

test("TP-47: with fewer than thirty finished tasks there is no keep time", () => {
  const { lines, tasks } = thirtyTasks();
  assert.equal(keepOf(lines.slice(1), tasks.slice(1)), null);
  assert.equal(keepOf([], [], ["OPEN"]), null);
  assert.equal(keepMonthOf(lines, tasks), "2026-10");
});

test("TP-47: thirty finished tasks and no line to keep give no keep time", () => {
  const { tasks } = thirtyTasks();
  assert.equal(keepOf([], tasks), null);
});

test("TP-47: a log that was not read in full gives no keep time, whatever lines it showed", () => {
  const { lines, tasks } = thirtyTasks();
  assert.equal(keepMonthOf(lines, tasks), "2026-10", "the same state gives a keep time when the log is whole");
  assert.equal(keepOf(lines, tasks, [], true), null);
  assert.equal(keepOf(lines, tasks, ["K1"], true), null);
});

// The keep time of the windows of the last sync, with no open item and a log that was read in full.
function keepWithWindows(lines: readonly EstimateLogLine[], finished: readonly FinishedTask[], windows: readonly WindowSpan[]): number | null {
  return keepTime({ lines, damaged: false, finished, openKeys: [], windows });
}

// The lines of the thirty tasks of thirtyTasks, all in November: each at the start of its task.
function novemberLines(tasks: readonly FinishedTask[]): EstimateLogLine[] {
  return tasks.map((task) => logged(task.label, task.start));
}

test("TP-64: the latest line before the end of a window that ended and is not in the history keeps its time", () => {
  const { tasks } = thirtyTasks();
  const lines = [
    ...novemberLines(tasks),
    logged("LATE", Date.UTC(2026, 9, 5)),
    logged("LATE", Date.UTC(2026, 9, 15)),
    logged("LATE", Date.UTC(2026, 10, 3)),
  ];
  const late: WindowSpan = { label: "LATE", start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 2) };
  assert.equal(keepOf(lines, tasks), Date.UTC(2026, 10, 1), "without the window every needed line is in November");
  assert.equal(
    keepWithWindows(lines, tasks, [late]),
    Date.UTC(2026, 9, 15),
    "the latest line before the end: not the older line, and not the line after the end",
  );
});

test("TP-64: a window that is open, or has no line before its end, keeps no month", () => {
  const { tasks } = thirtyTasks();
  const lines = [...novemberLines(tasks), logged("LATE", Date.UTC(2026, 9, 15))];
  const open: WindowSpan = { label: "LATE", start: Date.UTC(2026, 9, 20), end: null };
  assert.equal(keepWithWindows(lines, tasks, [open]), Date.UTC(2026, 10, 1));
  const early: WindowSpan = { label: "LATE", start: Date.UTC(2026, 8, 1), end: Date.UTC(2026, 9, 10) };
  assert.equal(keepWithWindows(lines, tasks, [early]), Date.UTC(2026, 10, 1), "the only line is after the end");
});

test("TP-64: a window is in the history when its label and start match, and a reused label with a new start is a new window", () => {
  const { tasks } = thirtyTasks();
  const first = at(tasks, 0);
  // K0 has an October line, and a November line after the earlier end of the stored window.
  const lines = [...novemberLines(tasks).map((l) => (l.key === "K0" ? { ...l, at: first.start + 45 * 60_000 } : l)), logged("K0", Date.UTC(2026, 9, 15))];
  const earlierEnd = first.start + 30 * 60_000;
  const same: WindowSpan = { label: "K0", start: first.start, end: earlierEnd };
  const reused: WindowSpan = { label: "K0", start: Date.UTC(2026, 9, 1), end: earlierEnd };
  assert.equal(keepWithWindows(lines, tasks, [same]), first.start + 45 * 60_000, "the same label and start: the history has it");
  assert.equal(keepWithWindows(lines, tasks, [reused]), Date.UTC(2026, 9, 15), "a new start: not in the history yet");
});

test("TP-47: a window that ended does not undo a fail-closed rule", () => {
  const { tasks } = thirtyTasks();
  const lines = [...novemberLines(tasks), logged("LATE", Date.UTC(2026, 9, 15))];
  const late: WindowSpan = { label: "LATE", start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 2) };
  assert.equal(keepTime({ lines, damaged: true, finished: tasks, openKeys: [], windows: [late] }), null, "a damaged log");
  assert.equal(keepWithWindows(lines, tasks.slice(1), [late]), null, "fewer than thirty finished tasks");
});

// A line of an open item or a window, with a stage, in the middle of the road range.
function stagedLine(key: string, atMs: number, stage: string | null): RangedLogLine {
  return logged(key, atMs, [100, 400], { stage });
}

test("the latest line of every stage of an open item keeps its time, and an earlier line of a stage does not", () => {
  const { lines, tasks } = thirtyTasks();
  // Fifty stages, s00 to s49, each with one line a day apart. The last stage in text order, s49,
  // has the oldest line, 1 July, so a cap on the stages in text order or in rank order drops it.
  const july = Array.from({ length: 50 }, (_, j) => stagedLine("OPEN", Date.UTC(2026, 6, 50 - j), `s${String(j).padStart(2, "0")}`));
  assert.equal(keepOf([...lines, ...july], tasks, ["OPEN"]), Date.UTC(2026, 6, 1), "the oldest stage line, with no cap on the stages");
  // s49 moves on in August and the May line is not its latest, so the oldest needed line is s48.
  const moved = [...july, stagedLine("OPEN", Date.UTC(2026, 4, 3), "s49"), stagedLine("OPEN", Date.UTC(2026, 7, 20), "s49")];
  assert.equal(keepOf([...lines, ...moved], tasks, ["OPEN"]), Date.UTC(2026, 6, 2));
});

test("the oldest of more than eight stages on a recent finished task keeps its time, whichever stage sorts last", () => {
  const { lines, tasks } = thirtyTasks();
  // Twelve stages on K7, s00 to s11. The last in text order, s11, has the oldest line, 1 July.
  const stages = Array.from({ length: 12 }, (_, j) => stagedLine("K7", Date.UTC(2026, 6, 12 - j), `s${String(j).padStart(2, "0")}`));
  assert.equal(keepOf([...lines, ...stages], tasks), Date.UTC(2026, 6, 1));
  assert.equal(keepOf([...lines, ...stages.slice(0, 11)], tasks), Date.UTC(2026, 6, 2), "without s11 the next oldest stage is s10");
});

test("TP-11: the keep time keeps the latest line that is not spent of a recent task with no stage tag, when a newer spent line exists", () => {
  const { lines, tasks } = thirtyTasks();
  const july = Date.UTC(2026, 6, 20);
  const older = lines.map((l) => (l.key === "K7" ? { ...l, at: july } : l));
  assert.equal(keepOf([...older, spentLine("K7", Date.UTC(2026, 9, 20))], tasks), july);
  assert.equal(keepMonthOf([...older, spentLine("K7", Date.UTC(2026, 9, 20))], tasks), "2026-07");
  // The control: with no spent line the same log keeps the same month.
  assert.equal(keepMonthOf(older, tasks), "2026-07");
  // A task whose only line is a spent line keeps that line.
  const onlySpent = lines.map((l) => (l.key === "K7" ? spentLine("K7", july) : l));
  assert.equal(keepMonthOf(onlySpent, tasks), "2026-07");
});

test("TP-12: the keep time keeps the latest line that is not spent of an open item and of a window that ended, when a newer spent line exists", () => {
  const { lines, tasks } = thirtyTasks();
  const open = [logged("OPEN", Date.UTC(2026, 6, 20)), spentLine("OPEN", Date.UTC(2026, 7, 2))];
  assert.equal(keepMonthOf([...lines, ...open], tasks, ["OPEN"]), "2026-07");
  assert.equal(keepMonthOf([...lines, ...open], tasks, []), "2026-10", "an item that is not open and has no window needs no line");

  const ended = [
    logged("LATE", Date.UTC(2026, 9, 5)),
    spentLine("LATE", Date.UTC(2026, 9, 15)),
    // After the end of the window, so it does not belong to it.
    spentLine("LATE", Date.UTC(2026, 10, 3)),
  ];
  const late: WindowSpan = { label: "LATE", start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 2) };
  assert.equal(keepWithWindows([...novemberLines(tasks), ...ended], tasks, [late]), Date.UTC(2026, 9, 5));
});

test("an issue line in July and a later plan line of one recent finished task keep the July month", () => {
  const { lines, tasks } = thirtyTasks();
  const others = lines.filter((l) => l.key !== "K7");
  const both = [stagedLine("K7", Date.UTC(2026, 6, 5), "issue"), stagedLine("K7", Date.UTC(2026, 9, 15), "plan")];
  assert.equal(keepMonthOf([...others, ...both], tasks), "2026-07");
  const planOnly = [stagedLine("K7", Date.UTC(2026, 9, 15), "plan")];
  assert.equal(keepMonthOf([...others, ...planOnly], tasks), "2026-10");
});

test("an open item with an issue line in July and a plan line in October keeps July", () => {
  const { lines, tasks } = thirtyTasks();
  const open = [stagedLine("OPEN", Date.UTC(2026, 6, 20), "issue"), stagedLine("OPEN", Date.UTC(2026, 9, 20), "plan")];
  assert.equal(keepMonthOf([...lines, ...open], tasks, ["OPEN"]), "2026-07");
  assert.equal(keepMonthOf([...lines, ...open], tasks, []), "2026-10");
});

test("a stage that no finished task links still keeps the latest line of that stage on an open item", () => {
  const { tasks } = thirtyTasks();
  // Every finished task has a plan line in October. The open item has an issue line in August.
  const planned = tasks.map((task) => stagedLine(task.label, Date.UTC(2026, 9, 15), "plan"));
  const open = [stagedLine("OPEN", Date.UTC(2026, 7, 3), "issue"), stagedLine("OPEN", Date.UTC(2026, 9, 20), "plan")];
  assert.equal(keepMonthOf([...planned, ...open], tasks, ["OPEN"]), "2026-08");
});

test("the latest line of a stage is kept for each key, not once for all keys", () => {
  const { lines, tasks } = thirtyTasks();
  // B has a July plan line and a later October issue line. Only the stage map of B keeps the July line:
  // A has a later October plan line, and the issue line is the latest line of B.
  const open = [
    stagedLine("A", Date.UTC(2026, 9, 20), "plan"),
    stagedLine("B", Date.UTC(2026, 6, 8), "plan"),
    stagedLine("B", Date.UTC(2026, 9, 25), "issue"),
  ];
  assert.equal(keepMonthOf([...lines, ...open], tasks, ["A", "B"]), "2026-07");
  assert.equal(keepMonthOf([...lines, ...open], tasks, ["A"]), "2026-10");
});

test("a window that ended and is not in the history keeps the latest line overall and the latest line of each stage before its end", () => {
  const { tasks } = thirtyTasks();
  const lines = [
    ...novemberLines(tasks),
    stagedLine("LATE", Date.UTC(2026, 8, 5), "issue"),
    stagedLine("LATE", Date.UTC(2026, 8, 6), "issue"),
    stagedLine("LATE", Date.UTC(2026, 9, 15), "plan"),
    // After the end of the window: the issue line before it is still the latest of its stage that links.
    stagedLine("LATE", Date.UTC(2026, 10, 3), "issue"),
  ];
  const lateEnd = Date.UTC(2026, 10, 2);
  const late: WindowSpan = { label: "LATE", start: Date.UTC(2026, 9, 20), end: lateEnd };
  assert.equal(keepWithWindows(lines, tasks, [late]), Date.UTC(2026, 8, 6), "the issue line of 6 September, not the older one and not the one after the end");
  assert.equal(keepWithWindows([...lines, stagedLine("LATE", Date.UTC(2026, 7, 1), null)], tasks, [late]), Date.UTC(2026, 8, 6), "an older line with no stage is replaced by the later lines");
  assert.equal(
    keepWithWindows([...lines, stagedLine("LATE", lateEnd, "issue")], tasks, [late]),
    Date.UTC(2026, 8, 6),
    "a line at exactly the end of the window is not before the end, so it replaces no line",
  );
});

test("the oldest of more than eight stages before the end of a window that ended keeps its time, whichever stage sorts last", () => {
  const { tasks } = thirtyTasks();
  // Twelve stages on LATE, s00 to s11. The last in text order, s11, has the oldest line, 1 September.
  const stages = Array.from({ length: 12 }, (_, j) => stagedLine("LATE", Date.UTC(2026, 8, 12 - j), `s${String(j).padStart(2, "0")}`));
  const late: WindowSpan = { label: "LATE", start: Date.UTC(2026, 9, 20), end: Date.UTC(2026, 10, 2) };
  assert.equal(keepWithWindows([...novemberLines(tasks), ...stages], tasks, [late]), Date.UTC(2026, 8, 1));
  assert.equal(keepWithWindows([...novemberLines(tasks), ...stages.slice(0, 11)], tasks, [late]), Date.UTC(2026, 8, 2), "without s11 the next oldest stage is s10");
});

test("a very long list of needed lines gives the oldest time and no error", () => {
  const { lines, tasks } = thirtyTasks();
  const base = Date.UTC(2026, 6, 5);
  const count = 300_000;
  // The oldest line is on the last stage in text order, s299999.
  const stageLines = Array.from({ length: count }, (_, i) => stagedLine("OPEN", base + (count - 1 - i) * 1000, `s${String(i).padStart(6, "0")}`));
  assert.equal(keepOf([...lines, ...stageLines], tasks, ["OPEN"]), base);
});

test("the stage labels __proto__, constructor and toString each keep their latest line on an open item, and change no prototype", () => {
  const prototypeNames = Object.getOwnPropertyNames(Object.prototype).sort();
  const { lines, tasks } = thirtyTasks();
  const open = [
    stagedLine("OPEN", Date.UTC(2026, 6, 5), "__proto__"),
    stagedLine("OPEN", Date.UTC(2026, 7, 2), "constructor"),
    stagedLine("OPEN", Date.UTC(2026, 8, 9), "toString"),
  ];
  assert.equal(keepOf([...lines, ...open], tasks, ["OPEN"]), Date.UTC(2026, 6, 5));
  assert.equal(keepOf([...lines, ...open.slice(1)], tasks, ["OPEN"]), Date.UTC(2026, 7, 2));
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), prototypeNames);
});

// ---------------------------------------------------------------------------
// TP-12: imports
// ---------------------------------------------------------------------------

test("TP-12: the estimator source imports only core and type-only imports from analysis", () => {
  const source = readFileSync(new URL("../src/estimator.ts", import.meta.url), "utf8");
  // An import or a re-export on one line or many, and a bare import with no names. Each
  // match is the whole statement and its module name.
  const withNames = /^[ \t]*((?:import|export)\b[^;"'`]*?\bfrom\s*["']([^"']+)["'])/gm;
  const bare = /^[ \t]*(import\s*["']([^"']+)["'])/gm;
  const statements = [...source.matchAll(withNames), ...source.matchAll(bare)].map((match) => ({ text: at(match, 1), from: at(match, 2) }));
  assert.ok(statements.length >= 2);
  assert.doesNotMatch(source, /\bimport\s*\(|\brequire\s*\(/, "no dynamic import and no require");
  for (const { text, from } of statements) {
    if (from === "./core.ts") continue;
    assert.equal(from, "./analysis.ts", `unexpected import: ${text}`);
    assert.match(text, /^import type\b/, `the import from analysis must be type-only: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// TP-15: coverage on the 30-task fixture
// ---------------------------------------------------------------------------

test("TP-15: the range covers the cost of at least 78 percent of the thirty fixture tasks", (t) => {
  let hits = 0;
  const misses: string[] = [];
  FIXTURE.forEach((row, index) => {
    const others = FIXTURE_TASKS.filter((_, i) => i !== index);
    const features = at(FIXTURE_TASKS, index).features;
    const result = only(estimateFromSignals([{ key: row[0], tags: { type: row[2] }, features }], others, CAL));
    const cost = Math.round(row[1] * 1e6);
    if (result.basis !== "none" && result.rawLow <= cost && cost <= result.rawHigh) hits += 1;
    else misses.push(`${row[0]}:${result.basisName}`);
  });
  const coverage = hits / FIXTURE.length;
  t.diagnostic(`coverage ${hits} of ${FIXTURE.length} = ${(coverage * 100).toFixed(1)} percent; misses ${misses.join(" ")}`);
  assert.ok(coverage >= 0.78, `coverage ${coverage}; misses ${misses.join(" ")}`);
});

// ---------------------------------------------------------------------------
// TP-16: time
// ---------------------------------------------------------------------------

test("TP-16: five thousand rows and five hundred items finish in about two seconds", (t) => {
  const rand = lcg(101);
  const names = ["issue_bytes", "plan_bytes", "brief_bytes", "churn", "files", "commits"];
  const features = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const name of names) if (rand() < 0.7) out[name] = Math.floor(10 ** (1 + 4 * rand()));
    return out;
  };
  const history = Array.from({ length: 5000 }, (_, i) => {
    const own = features();
    const size = Object.values(own).reduce((a, b) => a + Math.log1p(b), 0);
    return task(Math.exp(4 + 0.3 * size + rand()), `type${i % 5}`, own);
  });
  const items = Array.from({ length: 500 }, (_, i) => item(`K${i}`, `type${i % 6}`, features()));
  const start = performance.now();
  const estimates = estimateFromSignals(items, history, CAL);
  const elapsed = performance.now() - start;
  t.diagnostic(`${elapsed.toFixed(0)} ms for ${history.length} rows and ${items.length} items`);
  assert.equal(estimates.length, 500);
  assert.ok(elapsed < 2000, `${elapsed} ms`);
});

// ---------------------------------------------------------------------------
// The queue: the sum of the costs of the open items (TP-19, TP-32 to TP-40)
// ---------------------------------------------------------------------------

const NO_WEEK: Record<"claude" | "codex", Calibration> = {
  claude: { ready: false, label: NOT_READY_LABEL },
  codex: { ready: false, label: NOT_READY_LABEL },
};

// The six sums of a queue, in the order that they are written.
const SUM_NAMES = ["expectedPct", "lowPct", "likelyLowPct", "likelyHighPct", "highPct", "spentPct"] as const;

// Items that have used the given percent of the week of WEEK_CAL each (undefined: no cost so far).
function queueItems(pcts: readonly (number | undefined)[]): EstimateItem[] {
  return pcts.map((pct, i) => item(`K${i}`, null, {}, pct === undefined ? undefined : pct * WEEK_PER_PCT));
}

function queueOf(pcts: readonly (number | undefined)[], history: readonly EstimateTask[] = percentTasks(), calibrations = WEEK_CAL): QueueSum {
  const queue = queueSum(queueItems(pcts), history, calibrations);
  assert.ok(queue !== null, "a queue was expected");
  return queue;
}

// The six sums in the order of SUM_NAMES, or null when the queue has none.
function sumsOf(queue: QueueSum): number[] | null {
  const { sums } = queue;
  return sums === null ? null : SUM_NAMES.map((name) => sums[name]);
}

function deepFrozen<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const inner of Object.values(value)) deepFrozen(inner);
    Object.freeze(value);
  }
  return value;
}

test("TP-32: the step of the generator from 4242 is 3779851977, the seed is 4242 and there are 4000 draws", () => {
  assert.equal(nextQueueState(4242), 3_779_851_977);
  assert.equal(QUEUE_SEED, 4242);
  assert.equal(QUEUE_DRAWS, 4000);
  // The step is exact for the largest state too, where the product is near the limit of a double.
  const top = 2 ** 32 - 1;
  assert.equal(nextQueueState(top), Number((BigInt(top) * 1664525n + 1013904223n) % 2n ** 32n));
});

test("TP-32: each draw takes the items in input order, with one step of the generator for each item that has a pool and none for an item that counts as its cost so far", () => {
  // The costs are 1 to 10 percent. In each round of four items, the first draws from all ten costs. The second
  // (20 percent) and the fourth (9.5 percent) count as their cost so far, because fewer than five tasks cost as
  // much. The third (6 percent) draws from the five tasks of 6 to 10 percent: its pool starts at index 5.
  // Five rounds make 10 draws in each sum. Each cost has its own change of up to 0.4 percent of the week, so
  // the sums are nearly all different, and a shift of one step of the generator shows in the percentiles.
  // The generator below is written with whole numbers and does not call nextQueueState.
  const round: readonly (readonly [number | undefined, readonly [number, number] | null])[] = [
    [undefined, [0, 10]],
    [20, null],
    [6, [5, 5]],
    [9.5, null],
  ];
  const plan = Array.from({ length: 5 }, () => round).flat();
  const change = lcg(7);
  const costs = Array.from({ length: 10 }, (_, i) => (i + 1) * WEEK_PER_PCT + Math.floor(change() * 0.4 * WEEK_PER_PCT));
  let state = 4242n;
  const draw = ([start, size]: readonly [number, number]): number => {
    state = (state * 1664525n + 1013904223n) % 4294967296n;
    return at(costs, start + Math.floor((Number(state) / 4294967296) * size));
  };
  const sums: number[] = [];
  let expected = 0;
  for (const [pct, pool] of plan) expected += pool === null ? (pct ?? 0) * WEEK_PER_PCT : costs.slice(pool[0], pool[0] + pool[1]).reduce((a, b) => a + b, 0) / pool[1];
  for (let i = 0; i < 4000; i += 1) {
    let total = 0;
    for (const [pct, pool] of plan) total += pool === null ? (pct ?? 0) * WEEK_PER_PCT : draw(pool);
    sums.push(total);
  }
  sums.sort((a, b) => a - b);

  const queue = queueOf(plan.map(([pct]) => pct), costs.map((cost) => task(cost, null)));
  const wanted = [expected, ...[0.1, 0.25, 0.75, 0.9].map((fraction) => percentile(sums, fraction)), 5 * 35.5 * WEEK_PER_PCT].map((value) => value / WEEK_PER_PCT);
  const actual = sumsOf(queue);
  assert.ok(actual !== null);
  actual.forEach((value, index) => close(value, at(wanted, index)));
  assert.ok(at(actual, 1) < at(actual, 4), "the draws differ");
});

test("TP-33: three items with no cost so far over four tasks of 2 percent give count 3, every sum 6 and spent 0", () => {
  const queue = queueOf([undefined, undefined, undefined], Array.from({ length: 4 }, () => task(2 * WEEK_PER_PCT, null)));
  assert.equal(queue.count, 3);
  assert.deepEqual(sumsOf(queue), [6, 6, 6, 6, 6, 0]);
});

test("TP-34: one item at 20 percent over costs of 1 to 10 percent counts as its cost so far: every sum is 20 and spent is 20", () => {
  const queue = queueOf([20]);
  assert.equal(queue.count, 1);
  assert.deepEqual(sumsOf(queue), [20, 20, 20, 20, 20, 20]);
});

test("TP-35: an item at 6 percent draws from the five tasks of 6 to 10 percent, and an item with no cost so far from all ten", () => {
  const used = queueOf([6]);
  const sums = sumsOf(used);
  assert.ok(sums !== null);
  const [expected, low, likelyLow, likelyHigh, high, spent] = sums;
  assert.equal(expected, 8);
  assert.equal(spent, 6);
  assert.ok(low !== undefined && likelyLow !== undefined && likelyHigh !== undefined && high !== undefined);
  assert.ok(6 <= low && low <= likelyLow && likelyLow <= likelyHigh && likelyHigh <= high && high <= 10, sums.join(" "));

  const fresh = sumsOf(queueOf([undefined]));
  assert.ok(fresh !== null);
  assert.equal(fresh[0], 5.5);
  assert.equal(fresh[5], 0);
});

test("TP-35: an item counts as its cost so far when fewer than 5 tasks cost as much, and draws when 5 do", () => {
  // Four tasks cost 7 percent or more: 6.5 percent counts as itself. Five cost 6 percent or more: it draws.
  assert.deepEqual(sumsOf(queueOf([6.5])), [6.5, 6.5, 6.5, 6.5, 6.5, 6.5]);
  const drawn = sumsOf(queueOf([6]));
  assert.ok(drawn !== null && drawn[1] !== drawn[4]);
});

test("TP-35: a cost so far that is 0, negative or not finite counts as no cost so far", () => {
  const base = queueOf([undefined]);
  for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.deepEqual(queueOf([bad]), base, String(bad));
  }
});

test("TP-36: no items give count 0 and six sums of 0, also with no calibration and no history", () => {
  const zeros = { count: 0, sums: { expectedPct: 0, lowPct: 0, likelyLowPct: 0, likelyHighPct: 0, highPct: 0, spentPct: 0 } };
  assert.deepEqual(queueSum([], percentTasks(), WEEK_CAL), zeros);
  assert.deepEqual(queueSum([], percentTasks(), NO_WEEK), zeros);
  assert.deepEqual(queueSum([], [], NO_WEEK), zeros);
});

test("TP-37: with items, no calibration, a week that is not a finite number above 0, or two usable costs keep the count and make the six sums null", () => {
  const items = queueItems([undefined, 3]);
  const history = percentTasks();
  const nullSums = { count: 2, sums: null };
  assert.deepEqual(queueSum(items, history, NO_WEEK), nullSums);
  for (const week of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) {
    assert.deepEqual(queueSum(items, history, { claude: ready(week), codex: ready(week) }), nullSums, String(week));
  }
  // Two tasks cost something: the third task costs 0, and a task of cost 0 is not usable.
  assert.deepEqual(queueSum(items, [task(WEEK_PER_PCT, null), task(2 * WEEK_PER_PCT, null), task(0, null)], WEEK_CAL), nullSums);
  assert.deepEqual(queueSum(items, [], WEEK_CAL), nullSums);
  // Three usable costs are enough.
  assert.notEqual(queueSum(items, [...history.slice(0, 3)], WEEK_CAL)?.sums, null);
  // The subscription decides which week and which tasks count: no task has tokens on codex.
  assert.deepEqual(queueSum(items, history, WEEK_CAL, "codex"), nullSums);
});

test("TP-37: a sum that is not a finite number makes the six sums null and keeps the count", () => {
  const huge = [task(1e308, null), task(1e308, null), task(1e308, null)];
  assert.deepEqual(queueSum(queueItems([undefined, undefined]), huge, WEEK_CAL), { count: 2, sums: null });
});

test("TP-38: five tasks of cost 0 and three tasks of 2 percent give every sum 2, so a cost of 0 is never drawn", () => {
  const history = [...Array.from({ length: 5 }, () => task(0, null)), ...Array.from({ length: 3 }, () => task(2 * WEEK_PER_PCT, null))];
  assert.deepEqual(sumsOf(queueOf([undefined], history)), [2, 2, 2, 2, 2, 0]);
});

test("TP-19: the queue gets no floor: over three tasks that are all under the floor its sums are not null, while the estimates have no basis", () => {
  const history = [1000, 2000, 3000].map((cost) => task(cost, null));
  assert.ok(3000 < FLOOR);
  assert.equal(usedEstimate(history, undefined).basis, "none");
  const sums = sumsOf(queueOf([undefined], history));
  assert.ok(sums !== null);
  close(at(sums, 0), 2000 / WEEK_PER_PCT);
  for (const value of sums.slice(0, 5)) assert.ok(value > 0 && value <= 3000 / WEEK_PER_PCT);
});

test("TP-39: 501 items give a null queue, 500 items give a queue, and 500 items with 4000 draws are quick", (t) => {
  const history = percentTasks();
  assert.equal(SYNC_MAX_OPEN_ITEMS, 500);
  assert.equal(queueSum(queueItems(Array.from({ length: SYNC_MAX_OPEN_ITEMS + 1 }, () => undefined)), history, WEEK_CAL), null);
  const pcts = Array.from({ length: SYNC_MAX_OPEN_ITEMS }, (_, i) => (i % 3 === 0 ? undefined : (i % 10) + 1));
  const start = performance.now();
  const queue = queueOf(pcts, history);
  const elapsed = performance.now() - start;
  t.diagnostic(`${elapsed.toFixed(0)} ms for ${SYNC_MAX_OPEN_ITEMS} items and ${QUEUE_DRAWS} draws`);
  assert.equal(queue.count, SYNC_MAX_OPEN_ITEMS);
  assert.ok(queue.sums !== null);
  assert.ok(elapsed < 2000, `${elapsed} ms`);
});

test("TP-40: two calls on one frozen input give the same queue, and the input is not changed", () => {
  const items = deepFrozen(queueItems([undefined, 3, 6, 20, 9.5]));
  const history = deepFrozen(percentTasks());
  const calibrations = deepFrozen({ claude: ready(WEEK_PER_PCT), codex: ready(WEEK_PER_PCT) });
  const before = JSON.stringify([items, history, calibrations]);
  const first = queueSum(items, history, calibrations);
  queueSum(queueItems([1, 2]), percentTasks(), WEEK_CAL);
  const second = queueSum(items, history, calibrations);
  assert.ok(first !== null && first.sums !== null);
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify([items, history, calibrations]), before);
});
