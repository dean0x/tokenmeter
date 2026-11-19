// Estimates for open items from finished tasks (B1 of section 4).
//
// Pure code: no file, no clock and no module state. It imports core.ts and, for
// types only, analysis.ts. The inputs are plain values that a task window, an
// open item and a history entry already match.
//
// The signal estimate (`estimateFromSignals`) fits the log of the weighted
// tokens of the finished tasks. A candidate is the history as a whole ("all"),
// the tasks of one type, a line on one feature, or a plane on two features.
// Each candidate is scored on its own tasks by its leave-one-out error divided by
// the leave-one-out error of "all" on the same tasks. The lowest score wins. Its
// range comes from its own leave-one-out errors.
//
// The queue sum (`queueSum`) adds up the costs of all open items by draws from the
// costs of the finished tasks.
//
// The estimate log (estimate-log.ts) holds the ranges that were shown. Here are
// the lines to write (`newLogLines`), the self-check that compares the lines
// with the cost of the finished tasks (`selfCheck`) and the time of the oldest
// line that the log must keep (`keepTime`).

import type { Calibration, TokenTotals } from "./analysis.ts";
import { BASIS_ALL, BASIS_NONE, BASIS_SPENT, BASIS_TYPE, SYNC_MAX_OPEN_ITEMS, compareText, percentile, rawTokens } from "./core.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// The same names as Provider in store.ts. This module imports no store code.
export type Subscription = "claude" | "codex";

// The tag that names the type of a task.
const TYPE_TAG = "type";
const PROJECT_TAG = "project";
const REPO_TAG = "repo";
const MIN_PROJECT_TASKS = 9;
export const MAX_PROJECTS = 8;
const PROJECT_BLEND_TASKS = 9;
const PROJECT_GAIN = 0.9;
// The tag that names the work stage of an open item.
const STAGE_TAG = "stage";

// A finished task as the estimator reads it.
export interface EstimateTask {
  readonly tags: Readonly<Record<string, string>>;
  readonly features: Readonly<Record<string, number>>;
  readonly totals: Readonly<Record<Subscription, TokenTotals>>;
}

// An open item as the estimator reads it.
export interface EstimateItem {
  readonly key: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly features: Readonly<Record<string, number>>;
  // The weighted tokens that a running item has used so far. Its low end is
  // never below this. From SPENT_START_PCT of the week up, the item takes the
  // spent basis.
  readonly spent?: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

// An estimate needs this many finished tasks, of the same type or in all.
const MIN_GROUP_TASKS = 3;
// A finished task under this part of the week, in percent, is out of every fit:
// its cost says little about the cost of a task that is worth a plan.
const FIT_FLOOR_PCT = 0.1;
// A running item that has used this part of the week, in percent, or more is on
// the spent basis: its range comes from the finished tasks that cost as much.
const SPENT_START_PCT = 0.5;
// The spent range is closed, from the 10th to the 90th percentile of those costs,
// when this many finished tasks cost as much as the item has used. With fewer the
// range is open from the cost so far.
const SPENT_MIN_TASKS = 5;
// The stage of the log lines on the spent basis, whatever stage tag the item has.
const SPENT_STAGE = "run";

// The weighted tokens of 1 percent of the week. Null while the calibration of
// the subscription is not ready, and null unless the value is a finite number
// above 0: every share of the week divides by it.
function perPctOf(calibration: Calibration): number | null {
  if (!calibration.ready) return null;
  const { perPctWeighted } = calibration;
  return Number.isFinite(perPctWeighted) && perPctWeighted > 0 ? perPctWeighted : null;
}

// The part of the week, in percent, that some weighted tokens are. Null while
// the calibration of the subscription is not ready.
export function pctOfWeek(calibration: Calibration, weightedTokens: number): number | null {
  const perPct = perPctOf(calibration);
  return perPct === null ? null : weightedTokens / perPct;
}

function typeOf(tags: Readonly<Record<string, string>>): string | null {
  return Object.hasOwn(tags, TYPE_TAG) ? (tags[TYPE_TAG] ?? null) : null;
}

export function projectOf(tags: Readonly<Record<string, string>>): string | null {
  if (Object.hasOwn(tags, PROJECT_TAG)) return tags[PROJECT_TAG] ?? null;
  return Object.hasOwn(tags, REPO_TAG) ? (tags[REPO_TAG] ?? null) : null;
}

// The stage tag of an item, read as an own entry only: a stage label such as
// "constructor" must not find a member that every object already has.
function stageOf(tags: Readonly<Record<string, string>>): string | null {
  return Object.hasOwn(tags, STAGE_TAG) ? (tags[STAGE_TAG] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Signal estimate: models
// ---------------------------------------------------------------------------

// A line with 2 numbers to learn needs a third task to leave one out. A plane
// with 3 numbers needs a fourth.
const MIN_LINE_TASKS = 3;
const MIN_PLANE_TASKS = 4;
// A feature fit needs this many finished tasks that carry the feature.
const MIN_FEATURE_TASKS = 8;
// A pair needs this many finished tasks that carry both features.
const MIN_PAIR_TASKS = 40;
// A pair counts only when its ratio is at most this part of the lower ratio of
// its two single fits, on the tasks of the pair.
const PAIR_GAIN = 0.95;
// A pair of columns is too close to a line when their centered 2 by 2
// determinant is below this part of the product of their variances.
const PAIR_DETERMINANT_FLOOR = 1e-9;
// The scored feature names, and the best of them that form pairs.
const MAX_FEATURE_NAMES = 16;
const MAX_PAIR_NAMES = 3;
// A leave-one-out error divides by the room that the other tasks leave. With
// less room than this the fit has nothing to learn from without that task.
const LEAVE_OUT_ROOM = 1e-9;
const MEDIAN = 0.5;
const RANGE_LOW = 0.1;
const RANGE_HIGH = 0.9;
// The budget cost of an item is this percentile of the costs or errors of its basis.
const BUDGET_FRACTION = 0.8;
// An end of the range that falls outside the sample moves outward by this part
// of the extreme error.
const WIDEN = 0.5;

export type RankedModel =
  | { readonly kind: "all" }
  | { readonly kind: "type"; readonly type: string }
  | { readonly kind: "single"; readonly feature: string }
  | { readonly kind: "pair"; readonly features: readonly [string, string] };

interface Scored {
  readonly model: RankedModel;
  // The leave-one-out error over the error of "all" on the same tasks. Lower is better.
  readonly score: number;
}

// A low end and a high end.
interface Span {
  readonly low: number;
  readonly high: number;
}

// The range of weighted tokens that a model gives an item, with the middle cost
// and the budget cost inside it.
interface ItemRange extends Span {
  // The median of the costs of the basis.
  readonly typical: number;
  // The 80th percentile of the costs of the basis.
  readonly budget: number;
  // True when a feature value of the item lay outside the values of the tasks
  // that the fit learned from, and the range is that at the nearest value.
  readonly clamped: boolean;
}

export interface Candidate extends Scored {
  // The finished tasks that the candidate was scored on.
  readonly count: number;
  // The middle raw tokens for each weighted token on those tasks.
  readonly rawRatio: number;
  // The range of weighted tokens for an item, or null when the item lacks what
  // the model needs.
  readonly rangeFor: (item: EstimateItem) => ItemRange | null;
}

// A switch over a model ends here, so a new kind fails to compile until each
// switch handles it.
function exhaustive(value: never): never {
  return value;
}

// Position in the tie order: all, type, single, pair.
function rankOf(model: RankedModel): number {
  switch (model.kind) {
    case "all":
      return 0;
    case "type":
      return 1;
    case "single":
      return 2;
    case "pair":
      return 3;
    default:
      return exhaustive(model);
  }
}

// The name that an estimate shows for its basis: a feature name, type or all. A
// pair shows both feature names.
function basisNameOf(model: RankedModel): string {
  switch (model.kind) {
    case "all":
      return BASIS_ALL;
    case "type":
      return BASIS_TYPE;
    case "single":
      return model.feature;
    case "pair":
      return `${model.features[0]}+${model.features[1]}`;
    default:
      return exhaustive(model);
  }
}

// A type or all range is wide, and reads rough. A fit range is similar.
function basisOf(model: RankedModel): "similar" | "wide" {
  switch (model.kind) {
    case "all":
    case "type":
      return "wide";
    case "single":
    case "pair":
      return "similar";
    default:
      return exhaustive(model);
  }
}

// The lower score first. Equal scores follow the tie order, then the name.
function compareScored(a: Scored, b: Scored): number {
  return (
    a.score - b.score || rankOf(a.model) - rankOf(b.model) || compareText(basisNameOf(a.model), basisNameOf(b.model))
  );
}

// The item with the lowest score, or null for no item.
function lowest<T>(items: readonly T[], scoredOf: (item: T) => Scored): T | null {
  let best: T | null = null;
  for (const item of items) {
    if (best === null || compareScored(scoredOf(item), scoredOf(best)) < 0) best = item;
  }
  return best;
}

// A score is an error over the error of "all". It is null when that divisor is
// zero or not finite, or when the result is not finite.
export function scoreRatio(error: number, baseline: number): number | null {
  if (!(baseline > 0) || !Number.isFinite(baseline)) return null;
  const score = error / baseline;
  return Number.isFinite(score) ? score : null;
}

// ---------------------------------------------------------------------------
// Signal estimate: fits and the range
// ---------------------------------------------------------------------------

function allFinite(values: readonly number[]): boolean {
  return values.every((value) => Number.isFinite(value));
}

function isConstant(values: readonly number[]): boolean {
  return values.every((value) => value === values[0]);
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function sortedAscending(values: readonly number[]): number[] {
  return [...values].sort((a, b) => a - b);
}

function medianOf(values: readonly number[]): number {
  return percentile(sortedAscending(values), MEDIAN);
}

export interface LineFit {
  readonly intercept: number;
  readonly slope: number;
  // The error of each task when the line is fitted without it: actual minus
  // predicted, in the input order.
  readonly errors: readonly number[];
}

// Least squares y = intercept + slope z, with the leave-one-out errors in closed
// form. Null for fewer than 3 tasks, all-equal z values, or a result that is
// not finite. It never throws.
export function fitLine(zs: readonly number[], ys: readonly number[]): LineFit | null {
  const count = zs.length;
  if (count < MIN_LINE_TASKS || ys.length !== count || !allFinite(zs) || !allFinite(ys) || isConstant(zs)) return null;
  const meanZ = sum(zs) / count;
  const meanY = sum(ys) / count;
  let spreadZ = 0;
  let covariance = 0;
  for (let index = 0; index < count; index += 1) {
    const dz = (zs[index] ?? Number.NaN) - meanZ;
    spreadZ += dz * dz;
    covariance += dz * ((ys[index] ?? Number.NaN) - meanY);
  }
  const slope = covariance / spreadZ;
  const intercept = meanY - slope * meanZ;
  if (!(spreadZ > 0) || !Number.isFinite(slope) || !Number.isFinite(intercept)) return null;
  const errors: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const z = zs[index] ?? Number.NaN;
    const dz = z - meanZ;
    const room = 1 - 1 / count - (dz * dz) / spreadZ;
    const error = ((ys[index] ?? Number.NaN) - intercept - slope * z) / room;
    if (!(room > LEAVE_OUT_ROOM) || !Number.isFinite(error)) return null;
    errors.push(error);
  }
  return { intercept, slope, errors };
}

export interface PlaneFit {
  readonly intercept: number;
  readonly slopes: readonly [number, number];
  // As in LineFit.
  readonly errors: readonly number[];
}

// Least squares y = intercept + s1 z1 + s2 z2. Null for fewer than 4 tasks, an
// all-equal column, a centered 2 by 2 determinant below PAIR_DETERMINANT_FLOOR
// times the product of the two variances (a relative floor, so the decision
// does not change when both columns are scaled by one factor), or a result that
// is not finite. It never throws.
export function fitPlane(z1s: readonly number[], z2s: readonly number[], ys: readonly number[]): PlaneFit | null {
  const count = ys.length;
  if (count < MIN_PLANE_TASKS || z1s.length !== count || z2s.length !== count) return null;
  if (!allFinite(z1s) || !allFinite(z2s) || !allFinite(ys) || isConstant(z1s) || isConstant(z2s)) return null;
  const mean1 = sum(z1s) / count;
  const mean2 = sum(z2s) / count;
  const meanY = sum(ys) / count;
  let s11 = 0;
  let s22 = 0;
  let s12 = 0;
  let s1y = 0;
  let s2y = 0;
  for (let index = 0; index < count; index += 1) {
    const d1 = (z1s[index] ?? Number.NaN) - mean1;
    const d2 = (z2s[index] ?? Number.NaN) - mean2;
    const dy = (ys[index] ?? Number.NaN) - meanY;
    s11 += d1 * d1;
    s22 += d2 * d2;
    s12 += d1 * d2;
    s1y += d1 * dy;
    s2y += d2 * dy;
  }
  const product = s11 * s22;
  const determinant = product - s12 * s12;
  if (!(s11 > 0) || !(s22 > 0) || !(determinant >= PAIR_DETERMINANT_FLOOR * product)) return null;
  const slope1 = (s22 * s1y - s12 * s2y) / determinant;
  const slope2 = (s11 * s2y - s12 * s1y) / determinant;
  const intercept = meanY - slope1 * mean1 - slope2 * mean2;
  if (!Number.isFinite(slope1) || !Number.isFinite(slope2) || !Number.isFinite(intercept)) return null;
  const errors: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const z1 = z1s[index] ?? Number.NaN;
    const z2 = z2s[index] ?? Number.NaN;
    const d1 = z1 - mean1;
    const d2 = z2 - mean2;
    const room = 1 - 1 / count - (s22 * d1 * d1 - 2 * s12 * d1 * d2 + s11 * d2 * d2) / determinant;
    const error = ((ys[index] ?? Number.NaN) - intercept - slope1 * z1 - slope2 * z2) / room;
    if (!(room > LEAVE_OUT_ROOM) || !Number.isFinite(error)) return null;
    errors.push(error);
  }
  return { intercept, slopes: [slope1, slope2], errors };
}

// The two ends of the honest 80% range, as shifts of a log prediction, from the
// leave-one-out errors sorted ascending. The 1-based indexes are
// floor(0.1 (n + 1)) and ceil(0.9 (n + 1)), worked out in whole numbers so that
// no rounding error moves one. An index outside 1 to n moves that end outward by
// half the extreme error.
export function rangeShifts(sortedErrors: readonly number[]): Span {
  const count = sortedErrors.length;
  if (count === 0) return { low: 0, high: 0 };
  const lowIndex = Math.floor((count + 1) / 10);
  const highIndex = Math.ceil((9 * (count + 1)) / 10);
  const first = sortedErrors[0] ?? 0;
  const last = sortedErrors[count - 1] ?? 0;
  return {
    low: lowIndex >= 1 ? (sortedErrors[lowIndex - 1] ?? first) : first - WIDEN * Math.abs(first),
    high: highIndex <= count ? (sortedErrors[highIndex - 1] ?? last) : last + WIDEN * Math.abs(last),
  };
}

// ---------------------------------------------------------------------------
// Signal estimate: scoring
// ---------------------------------------------------------------------------

// A finished task with tokens on the subscription.
interface Observed {
  // The log of its weighted tokens.
  readonly y: number;
  readonly weighted: number;
  // Raw tokens for each weighted token.
  readonly ratio: number;
  readonly type: string | null;
  readonly project: string | null;
  // log(1 + value) of each feature that the task carries.
  readonly z: ReadonlyMap<string, number>;
}

// A finished task with the error of the "all" prediction of it: the distance of
// its cost from the middle of the other tasks. A score divides by the middle of
// these errors on its own tasks.
interface Sample extends Observed {
  readonly baseline: number;
}

// The leave-one-out errors have the same order as the samples in the group.
interface Fitted {
  readonly candidate: Candidate;
  readonly group: readonly Sample[];
  readonly errors: readonly number[];
}

function isFeatureValue(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// The finished tasks that a fit can learn from: a finite cost above 0 and, with a
// floor, at least the floor. A NaN floor leaves every task out.
function observedOf(history: readonly EstimateTask[], subscription: Subscription, floor = 0): Observed[] {
  const observed: Observed[] = [];
  for (const entry of history) {
    const totals = entry.totals[subscription];
    const weightedTokens = totals.weighted;
    if (!(weightedTokens > 0) || !Number.isFinite(weightedTokens) || !(weightedTokens >= floor)) continue;
    const z = new Map<string, number>();
    for (const [name, value] of Object.entries(entry.features)) {
      if (isFeatureValue(value)) z.set(name, Math.log1p(value));
    }
    observed.push({
      y: Math.log(weightedTokens),
      weighted: weightedTokens,
      ratio: rawTokens(totals) / weightedTokens,
      type: typeOf(entry.tags),
      project: projectOf(entry.tags),
      z,
    });
  }
  return observed;
}

// Each item with its leave-one-out error: the distance of its y from the median
// of the y of the other items. Needs 3 or more items.
function leaveOneOut<T extends { readonly y: number }>(items: readonly T[]): Array<{ readonly item: T; readonly error: number }> {
  const values = items.map((item) => item.y);
  const order = values.map((_, index) => index).sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
  const sorted = order.map((index) => values[index] ?? 0);
  const rank = new Array<number>(values.length).fill(0);
  order.forEach((index, position) => {
    rank[index] = position;
  });
  // The median of the other values sits at this position of the sorted others.
  const position = MEDIAN * (values.length - 2);
  const below = Math.floor(position);
  const above = Math.ceil(position);
  return items.map((item, index) => {
    const skip = rank[index] ?? 0;
    const pick = (at: number): number => sorted[at < skip ? at : at + 1] ?? 0;
    const low = pick(below);
    return { item, error: Math.abs(item.y - (low + (pick(above) - low) * (position - below))) };
  });
}

function withBaseline(observed: readonly Observed[]): Sample[] {
  return leaveOneOut(observed).map(({ item, error }) => ({ ...item, baseline: error }));
}

function ysOf(group: readonly Sample[]): number[] {
  return group.map((sample) => sample.y);
}

// The middle baseline of a group: the divisor of every score on its tasks.
function baselineOf(group: readonly Sample[]): number {
  return medianOf(group.map((sample) => sample.baseline));
}

// The score of the errors on the tasks of a group, or null when the divisor is
// zero or not finite.
function scoreOf(group: readonly Sample[], errors: readonly number[]): number | null {
  return scoreRatio(medianOf(errors.map(Math.abs)), baselineOf(group));
}

// What every candidate reports about its own tasks.
type Standing = Pick<Candidate, "score" | "count" | "rawRatio">;

// The score, the task count and the middle raw tokens for each weighted token of
// a group, or null when the score is null.
function standingOf(group: readonly Sample[], errors: readonly number[]): Standing | null {
  const score = scoreOf(group, errors);
  if (score === null) return null;
  return { score, count: group.length, rawRatio: medianOf(group.map((sample) => sample.ratio)) };
}

// The tasks that carry the feature, and its value on each.
function carrying(samples: readonly Sample[], feature: string): { group: Sample[]; zs: number[] } {
  const group: Sample[] = [];
  const zs: number[] = [];
  for (const sample of samples) {
    const z = sample.z.get(feature);
    if (z === undefined) continue;
    group.push(sample);
    zs.push(z);
  }
  return { group, zs };
}

// The tasks that carry both features, and the values on each.
function carryingBoth(samples: readonly Sample[], first: string, second: string): { group: Sample[]; z1s: number[]; z2s: number[] } {
  const group: Sample[] = [];
  const z1s: number[] = [];
  const z2s: number[] = [];
  for (const sample of samples) {
    const z1 = sample.z.get(first);
    const z2 = sample.z.get(second);
    if (z1 === undefined || z2 === undefined) continue;
    group.push(sample);
    z1s.push(z1);
    z2s.push(z2);
  }
  return { group, z1s, z2s };
}

// The values that are not null, in order.
function kept<T>(values: readonly (T | null)[]): T[] {
  return values.filter((value): value is T => value !== null);
}

function featureValue(features: Readonly<Record<string, number>>, name: string): number | null {
  const value = Object.hasOwn(features, name) ? features[name] : undefined;
  return isFeatureValue(value) ? Math.log1p(value) : null;
}

// The shifts of a log prediction that give the ends of the range, the typical
// cost and the budget cost of a fit.
interface Shifts extends Span {
  readonly typical: number;
  readonly budget: number;
}

// The shifts from the leave-one-out errors of a fit. The errors are sorted once.
function shiftsOf(errors: readonly number[]): Shifts {
  const sorted = sortedAscending(errors);
  return { ...rangeShifts(sorted), typical: percentile(sorted, MEDIAN), budget: percentile(sorted, BUDGET_FRACTION) };
}

// The smallest and the largest of the values.
function boundsOf(values: readonly number[]): Span {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return { low, high };
}

function clampTo(value: number, bounds: Span): number {
  return Math.min(Math.max(value, bounds.low), bounds.high);
}

// The range at a prediction, or null unless its low end is above 0 and its high
// end is finite.
function rangeAt(prediction: number, shifts: Shifts, clamped: boolean): ItemRange | null {
  const low = Math.exp(prediction + shifts.low);
  const high = Math.exp(prediction + shifts.high);
  if (!(low > 0) || !Number.isFinite(high)) return null;
  return { low, high, typical: Math.exp(prediction + shifts.typical), budget: Math.exp(prediction + shifts.budget), clamped };
}

// Type and all: the 10th, 50th, 80th and 90th percentile of the weighted tokens of the group.
function groupCandidate(model: RankedModel, group: readonly Sample[]): Fitted | null {
  if (group.length < MIN_GROUP_TASKS) return null;
  const errors = leaveOneOut(group).map(({ error }) => error);
  const standing = standingOf(group, errors);
  if (standing === null) return null;
  const costs = sortedAscending(group.map((sample) => sample.weighted));
  const range: ItemRange = {
    low: percentile(costs, RANGE_LOW),
    high: percentile(costs, RANGE_HIGH),
    typical: percentile(costs, MEDIAN),
    budget: percentile(costs, BUDGET_FRACTION),
    clamped: false,
  };
  const type = model.kind === "type" ? model.type : null;
  const candidate: Candidate = {
    ...standing,
    model,
    rangeFor: (item) => (type === null || typeOf(item.tags) === type ? range : null),
  };
  return { candidate, group, errors };
}

function singleCandidate(feature: string, samples: readonly Sample[]): Fitted | null {
  const { group, zs } = carrying(samples, feature);
  const fit = fitLine(zs, ysOf(group));
  if (fit === null) return null;
  const standing = standingOf(group, fit.errors);
  if (standing === null) return null;
  const shifts = shiftsOf(fit.errors);
  const bounds = boundsOf(zs);
  const candidate: Candidate = {
    ...standing,
    model: { kind: "single", feature },
    rangeFor: (item) => {
      const z = featureValue(item.features, feature);
      if (z === null) return null;
      // The fit does not predict outside the values that it learned from.
      const inside = clampTo(z, bounds);
      return rangeAt(fit.intercept + fit.slope * inside, shifts, inside !== z);
    },
  };
  return { candidate, group, errors: fit.errors };
}

// The score of one line fitted to a group, or null.
function lineScore(group: readonly Sample[], zs: readonly number[]): number | null {
  const fit = fitLine(zs, ysOf(group));
  return fit === null ? null : scoreOf(group, fit.errors);
}

function pairCandidate(names: readonly [string, string], samples: readonly Sample[]): Fitted | null {
  const [first, second] = names;
  const { group, z1s, z2s } = carryingBoth(samples, first, second);
  if (group.length < MIN_PAIR_TASKS) return null;
  const fit = fitPlane(z1s, z2s, ysOf(group));
  if (fit === null) return null;
  const standing = standingOf(group, fit.errors);
  if (standing === null) return null;
  // A single fit that cannot be scored on these tasks does not stand in the way.
  const better = Math.min(lineScore(group, z1s) ?? Number.POSITIVE_INFINITY, lineScore(group, z2s) ?? Number.POSITIVE_INFINITY);
  if (standing.score > PAIR_GAIN * better) return null;
  const shifts = shiftsOf(fit.errors);
  const bounds1 = boundsOf(z1s);
  const bounds2 = boundsOf(z2s);
  const candidate: Candidate = {
    ...standing,
    model: { kind: "pair", features: names },
    rangeFor: (item) => {
      const z1 = featureValue(item.features, first);
      const z2 = featureValue(item.features, second);
      if (z1 === null || z2 === null) return null;
      const inside1 = clampTo(z1, bounds1);
      const inside2 = clampTo(z2, bounds2);
      return rangeAt(fit.intercept + fit.slopes[0] * inside1 + fit.slopes[1] * inside2, shifts, inside1 !== z1 || inside2 !== z2);
    },
  };
  return { candidate, group, errors: fit.errors };
}

// The names of the features that tasks carry, with their task counts: at most
// MAX_FEATURE_NAMES names with enough tasks, the most tasks first, ties by name.
function scoredFeatureNames(samples: readonly Sample[]): string[] {
  const counts = new Map<string, number>();
  for (const sample of samples) {
    for (const name of sample.z.keys()) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count >= MIN_FEATURE_TASKS)
    .sort(([nameA, countA], [nameB, countB]) => countB - countA || compareText(nameA, nameB))
    .slice(0, MAX_FEATURE_NAMES)
    .map(([name]) => name);
}

// The candidate on the whole history.
function allCandidates(samples: readonly Sample[]): Fitted[] {
  return kept([groupCandidate({ kind: "all" }, samples)]);
}

// One candidate for each type with enough tasks, by type name.
function typeCandidates(samples: readonly Sample[]): Fitted[] {
  const byType = new Map<string, Sample[]>();
  for (const sample of samples) {
    if (sample.type === null) continue;
    const group = byType.get(sample.type);
    if (group === undefined) byType.set(sample.type, [sample]);
    else group.push(sample);
  }
  const types = [...byType].sort(([a], [b]) => compareText(a, b));
  return kept(types.map(([type, group]) => groupCandidate({ kind: "type", type }, group)));
}

// One candidate for each scored feature name, by name.
function singleCandidates(samples: readonly Sample[]): Fitted[] {
  return kept(scoredFeatureNames(samples).sort(compareText).map((name) => singleCandidate(name, samples)));
}

// One candidate for each pair of the MAX_PAIR_NAMES features with the best single
// scores, by name.
function pairCandidates(samples: readonly Sample[], singles: readonly Fitted[]): Fitted[] {
  const best = singles.map(({ candidate }) => candidate).sort(compareScored).slice(0, MAX_PAIR_NAMES);
  const names = best.flatMap((candidate) => (candidate.model.kind === "single" ? [candidate.model.feature] : [])).sort(compareText);
  return kept(names.flatMap((first, at) => names.slice(at + 1).map((second) => pairCandidate([first, second], samples))));
}

function groupByProject<T extends Observed>(tasks: readonly T[]): ReadonlyMap<string, readonly T[]> {
  const groups = new Map<string, T[]>();
  for (const task of tasks) {
    if (task.project === null) continue;
    const group = groups.get(task.project);
    if (group === undefined) groups.set(task.project, [task]);
    else group.push(task);
  }
  return groups;
}

interface FitPass {
  readonly samples: readonly Sample[];
  readonly fitted: readonly Fitted[];
  readonly observed: readonly Observed[];
  readonly projectGroups: {
    readonly fit: ReadonlyMap<string, readonly Sample[]>;
    readonly rank: ReadonlyMap<string, readonly Observed[]>;
  };
}

function fitAll(history: readonly EstimateTask[], subscription: Subscription, floor: number): FitPass {
  const observed = observedOf(history, subscription);
  const forFit = floor === 0 ? observed : observedOf(history, subscription, floor);
  const samples = forFit.length < MIN_GROUP_TASKS ? [] : withBaseline(forFit);
  const singles = singleCandidates(samples);
  const fitted = [...allCandidates(samples), ...typeCandidates(samples), ...singles, ...pairCandidates(samples, singles)];
  return { samples, fitted, observed, projectGroups: { fit: groupByProject(samples), rank: groupByProject(observed) } };
}

// A project task gets the shared weight k plus the project weight N. When one
// task is left out, both N and the project count exclude it.
function weightedPoint(
  sorted: readonly Sample[], project: string, count: number, tenths: 5 | 8, omit?: Sample,
): number | null {
  const size = sorted.length - (omit === undefined ? 0 : 1);
  const target = tenths * size * (count + PROJECT_BLEND_TASKS);
  let weight = 0;
  for (const sample of sorted) {
    if (sample === omit) continue;
    weight += sample.project === project ? size + PROJECT_BLEND_TASKS : PROJECT_BLEND_TASKS;
    if (10 * weight >= target) return sample.weighted;
  }
  return null;
}

// Exact order statistics in weighted tokens. With a task left out, an index
// outside the remaining list takes the nearest end.
function rankRange(sorted: readonly number[], omit = sorted.length): Span | null {
  const leftOut = omit < sorted.length;
  const count = sorted.length - (leftOut ? 1 : 0);
  const lowRank = Math.floor((count + 1) / 10);
  const highRank = Math.ceil(9 * (count + 1) / 10);
  const pick = (rank: number) => sorted[rank <= omit ? rank - 1 : rank] ?? Number.NaN;
  const low = pick(leftOut ? Math.max(1, lowRank) : lowRank);
  const high = pick(leftOut ? Math.min(count, highRank) : highRank);
  return low > 0 && Number.isFinite(low) && Number.isFinite(high) && low <= high ? { low, high } : null;
}

function projectErrors(
  sorted: readonly Sample[], costs: readonly number[], project: string, group: readonly Sample[],
): ReadonlyMap<Sample, number> | null {
  const errors = new Map<Sample, number>();
  for (const sample of group) {
    // Equal costs are interchangeable for the rank ends, not for the fit sample.
    const span = rankRange(costs, firstAtOrAbove(costs, sample.weighted));
    const center = weightedPoint(sorted, project, group.length - 1, 5, sample);
    if (span === null || center === null) return null;
    errors.set(sample, Math.abs(sample.y - Math.log(clampTo(center, span))));
  }
  return errors;
}

interface ProjectFit {
  readonly candidate: Candidate;
  readonly wins: boolean;
  readonly kept: readonly Candidate[];
}

function projectGate(fitted: readonly Fitted[], errors: ReadonlyMap<Sample, number>): Omit<ProjectFit, "candidate"> {
  let eligible = false;
  const kept: Candidate[] = [];
  for (const fit of fitted) {
    const group: Sample[] = [];
    const blendErrors: number[] = [];
    const sharedErrors: number[] = [];
    fit.group.forEach((sample, i) => {
      const error = errors.get(sample);
      if (error === undefined) return;
      group.push(sample);
      blendErrors.push(error);
      sharedErrors.push(fit.errors[i] ?? Number.NaN);
    });
    const { candidate } = fit;
    const feature = candidate.model.kind === "single" || candidate.model.kind === "pair";
    if (group.length === 0 || (!feature && group.length < MIN_PROJECT_TASKS)) continue;
    const blendScore = scoreOf(group, blendErrors);
    const sharedScore = scoreOf(group, sharedErrors);
    if (blendScore === null || sharedScore === null) continue;
    if (group.length >= MIN_PROJECT_TASKS) {
      eligible = true;
      if (blendScore > PROJECT_GAIN * sharedScore) return { wins: false, kept: [] };
    }
    if (feature && sharedScore < blendScore) kept.push(candidate);
  }
  return { wins: eligible, kept: eligible ? kept : [] };
}

function blendFit(
  project: string, group: readonly Sample[], observed: readonly Observed[], sorted: readonly Sample[], fitted: readonly Fitted[],
): ProjectFit | null {
  const costs = sortedCostsOf(observed);
  const span = rankRange(costs);
  if (span === null) return null;
  const errors = projectErrors(sorted, costs, project, group);
  if (errors === null) return null;
  const score = scoreOf(group, [...errors.values()]);
  if (score === null) return null;
  const middle = weightedPoint(sorted, project, group.length, 5);
  const upper = weightedPoint(sorted, project, group.length, 8);
  if (middle === null || upper === null) return null;
  const typical = clampTo(middle, span);
  const budget = Math.max(typical, clampTo(upper, span));
  const range = { ...span, typical, budget, clamped: false };
  return {
    candidate: {
      model: { kind: "all" },
      score,
      count: group.length,
      rawRatio: medianOf(observed.map((sample) => sample.ratio)),
      rangeFor: (item) => projectOf(item.tags) === project ? range : null,
    },
    ...projectGate(fitted, errors),
  };
}

function projectFitsOf({ samples, fitted, projectGroups }: FitPass): ReadonlyMap<string, ProjectFit> {
  const qualified = [...projectGroups.fit]
    .filter(([, group]) => group.length >= MIN_PROJECT_TASKS)
    .sort(([a, groupA], [b, groupB]) => groupB.length - groupA.length || compareText(a, b))
    .slice(0, MAX_PROJECTS);
  const blends = new Map<string, ProjectFit>();
  if (qualified.length === 0) return blends;
  const sorted = [...samples].sort((a, b) => a.weighted - b.weighted);
  for (const [project, group] of qualified) {
    const observed = projectGroups.rank.get(project);
    if (observed === undefined) continue;
    const blend = blendFit(project, group, observed, sorted, fitted);
    if (blend !== null) blends.set(project, blend);
  }
  return blends;
}

// The bounded project candidates and their verdicts on the shared score scale.
export function projectFits(history: readonly EstimateTask[], subscription: Subscription, floor = 0): ReadonlyMap<string, ProjectFit> {
  return projectFitsOf(fitAll(history, subscription, floor));
}

// Every candidate that qualifies, scored on its own tasks. The score table
// belongs to this call: nothing is kept between calls. A candidate whose
// divisor is zero or not finite is dropped, and so is a fit that is null. A task
// under `floor` weighted tokens is left out of every candidate; with no floor
// every task with a cost counts.
export function scoreCandidates(history: readonly EstimateTask[], subscription: Subscription, floor = 0): readonly Candidate[] {
  return fitAll(history, subscription, floor).fitted.map(({ candidate }) => candidate);
}

// ---------------------------------------------------------------------------
// Signal estimate
// ---------------------------------------------------------------------------

export type SignalEstimate =
  | {
      readonly key: string;
      readonly subscription: Subscription;
      readonly basis: "similar" | "wide";
      // A feature name (two for a pair), type, all or spent.
      readonly basisName: string;
      readonly label: "similar" | "wide, low confidence";
      readonly lowPct: number;
      readonly highPct: number;
      // The same range in raw tokens. It has the same factors as the percent range.
      readonly rawLow: number;
      readonly rawHigh: number;
      // The same range in weighted tokens, the unit of the fit and of the estimate log.
      readonly weightedLow: number;
      readonly weightedHigh: number;
      readonly count: number;
      // True when a running item has used more than the high end of the range of
      // its basis. The range is then open from the cost so far: it has no high
      // end, and it reads rough whatever its basis. The high fields then hold the
      // low end, and the basis stays: these are the values of the estimate log.
      readonly open: boolean;
      // True when the range is open, or when a feature value of the item lay
      // outside the values of the fit and the range is that at the nearest value.
      // A rough range reads wide. The basis stays, so the log writes no new line.
      readonly rough: boolean;
      // The median cost and the 80th percentile cost of the basis, in percent of
      // the week. Both are null for an open range, or when one of them is not a
      // finite number above 0. Low end <= typical <= budget <= high end.
      readonly typicalPct: number | null;
      readonly budgetPct: number | null;
      readonly basisProject?: string;
    }
  | {
      readonly key: string;
      readonly subscription: Subscription;
      readonly basis: "none";
      readonly basisName: "none";
      readonly label: "no basis yet";
    };

interface Applied {
  readonly candidate: Candidate;
  readonly range: ItemRange;
}

function noBasis(key: string, subscription: Subscription): SignalEstimate {
  return { key, subscription, basis: "none", basisName: BASIS_NONE, label: "no basis yet" };
}

// What an estimate with a range is made of.
interface Shown {
  readonly basis: "similar" | "wide";
  readonly basisName: string;
  readonly count: number;
  // The middle raw tokens for each weighted token.
  readonly rawRatio: number;
  // The range of the basis, with its typical and budget costs.
  readonly range: ItemRange;
  // The ends in weighted tokens that the estimate shows. The low end may be raised
  // to the cost so far, and an open range has its high end equal to its low end.
  readonly low: number;
  readonly high: number;
  readonly open: boolean;
  readonly rough: boolean;
  readonly basisProject?: string;
}

function rangedEstimate(key: string, subscription: Subscription, perPct: number, shown: Shown): SignalEstimate {
  const { basis, rawRatio, low, high, open, rough } = shown;
  return {
    key,
    subscription,
    basis,
    basisName: shown.basisName,
    label: basis === "similar" && !rough ? "similar" : "wide, low confidence",
    lowPct: low / perPct,
    highPct: high / perPct,
    rawLow: low * rawRatio,
    rawHigh: high * rawRatio,
    weightedLow: low,
    weightedHigh: high,
    count: shown.count,
    open,
    rough,
    ...costsOf(shown.range, low, open, perPct),
    ...(shown.basisProject === undefined ? {} : { basisProject: shown.basisProject }),
  };
}

function bestApplied(item: EstimateItem, candidates: readonly Candidate[]): Applied | null {
  const applied: Applied[] = [];
  for (const candidate of candidates) {
    const range = candidate.rangeFor(item);
    if (range !== null) applied.push({ candidate, range });
  }
  return lowest(applied, ({ candidate }) => candidate);
}

function estimateOne(
  item: EstimateItem,
  subscription: Subscription,
  perPct: number,
  candidates: readonly Candidate[],
  projects: ReadonlyMap<string, ProjectFit>,
  spentBase: SpentBase,
): SignalEstimate {
  const started = spentRange(item, perPct, spentBase);
  if (started !== null) return rangedEstimate(item.key, subscription, perPct, { ...started, rough: true });
  const project = projectOf(item.tags);
  const blend = project === null ? undefined : projects.get(project);
  let basisProject: string | undefined;
  let best: Applied | null;
  if (blend?.wins && project !== null) {
    best = bestApplied(item, blend.kept);
    if (best === null) {
      best = bestApplied(item, [blend.candidate]);
      basisProject = project;
    }
  } else {
    best = bestApplied(item, candidates);
  }
  if (best === null) return noBasis(item.key, subscription);
  // A running item has used some tokens already, so its low end cannot be less.
  const spent = item.spent ?? 0;
  const low = Number.isFinite(spent) && spent > best.range.low ? spent : best.range.low;
  // Past the high end, the range is open: one exact number would be false precision.
  const open = low > best.range.high;
  return rangedEstimate(item.key, subscription, perPct, {
    basis: basisOf(best.candidate.model),
    basisName: basisNameOf(best.candidate.model),
    count: best.candidate.count,
    rawRatio: best.candidate.rawRatio,
    range: best.range,
    low,
    high: Math.max(best.range.high, low),
    open,
    rough: open || best.range.clamped,
    ...(basisProject === undefined ? {} : { basisProject }),
  });
}

// The typical and budget costs in percent of the week, raised to the low end and
// to the typical cost. Both are null for an open range, and when one of them is
// not a finite number above 0.
function costsOf(range: ItemRange, low: number, open: boolean, perPct: number): { typicalPct: number | null; budgetPct: number | null } {
  if (open) return { typicalPct: null, budgetPct: null };
  const typical = Math.max(range.typical, low);
  const budget = Math.max(range.budget, typical);
  const typicalPct = finitePositive(typical / perPct);
  const budgetPct = finitePositive(budget / perPct);
  return typicalPct === null || budgetPct === null ? { typicalPct: null, budgetPct: null } : { typicalPct, budgetPct };
}

// The weighted tokens of the finished tasks, smallest first.
function sortedCostsOf(observed: readonly Observed[]): number[] {
  return sortedAscending(observed.map((entry) => entry.weighted));
}

// The index of the first cost in `sorted` that is at or above `value`: the length
// of the list when no cost is. A binary search over at most log2(length) steps.
function firstAtOrAbove(sorted: readonly number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? Number.NEGATIVE_INFINITY) >= value) high = middle;
    else low = middle + 1;
  }
  return low;
}

// The finished tasks as the spent rule reads them, with no floor: their costs in
// weighted tokens, smallest first, and the middle raw tokens for each weighted token.
interface SpentBase {
  readonly costs: readonly number[];
  readonly rawRatio: number;
}

function spentBaseOf(observed: readonly Observed[]): SpentBase {
  return { costs: sortedCostsOf(observed), rawRatio: medianOf(observed.map((entry) => entry.ratio)) };
}

// The estimate of a running item that has used SPENT_START_PCT of the week or
// more, or null for any other item and for a history with no finished task. Its
// range is the 10th to the 90th percentile of the costs of the finished tasks that
// cost as much as the item has used, with their median and 80th percentile as the
// typical and budget costs. With fewer than SPENT_MIN_TASKS such tasks the range is
// open from the cost so far. The rule has no memory: it reads the cost so far only.
function spentRange(item: EstimateItem, perPct: number, base: SpentBase): Omit<Shown, "rough" | "basisProject"> | null {
  const { spent } = item;
  if (spent === undefined || !Number.isFinite(spent) || !(spent >= SPENT_START_PCT * perPct) || base.costs.length === 0) return null;
  const costs = base.costs.slice(firstAtOrAbove(base.costs, spent));
  const open = costs.length < SPENT_MIN_TASKS;
  const range: ItemRange = open
    ? { low: spent, high: spent, typical: spent, budget: spent, clamped: false }
    : {
        low: percentile(costs, RANGE_LOW),
        high: percentile(costs, RANGE_HIGH),
        typical: percentile(costs, MEDIAN),
        budget: percentile(costs, BUDGET_FRACTION),
        clamped: false,
      };
  return {
    basis: "wide",
    basisName: BASIS_SPENT,
    count: costs.length,
    rawRatio: base.rawRatio,
    range,
    low: range.low,
    high: range.high,
    open,
  };
}

// One estimate for each open item, in the order given. Each item takes the
// candidate with the lowest score among those it can use. The range of a fit is
// its prediction shifted by its leave-one-out errors, at the feature values of
// the item moved to the nearest value that the fit learned from. The range of
// type and all is the 10th to 90th percentile of their costs. Each range has a
// typical cost (the median) and a budget cost (the 80th percentile). The percent range and the raw
// range have the same factors. With no ready calibration there is no basis. A
// finished task under FIT_FLOOR_PCT of the week is left out of every fit. A project
// that wins the gate uses its rank range or a better shared feature fit. A running
// item that has used SPENT_START_PCT of the week or more takes the spent basis.
export function estimateFromSignals(
  items: readonly EstimateItem[],
  history: readonly EstimateTask[],
  calibrations: Readonly<Record<Subscription, Calibration>>,
  subscription: Subscription = "claude",
): readonly SignalEstimate[] {
  const perPct = perPctOf(calibrations[subscription]);
  if (perPct === null || items.length === 0) return items.map((item) => noBasis(item.key, subscription));
  const pass = fitAll(history, subscription, perPct * FIT_FLOOR_PCT);
  const candidates = pass.fitted.map(({ candidate }) => candidate);
  const projects = projectFitsOf(pass);
  const spentBase = spentBaseOf(pass.observed);
  return items.map((item) => estimateOne(item, subscription, perPct, candidates, projects, spentBase));
}


// ---------------------------------------------------------------------------
// The queue: the sum of the costs of the open items
// ---------------------------------------------------------------------------

// The queue sum is drawn this many times. Each draw adds one cost of the finished
// tasks for every open item. The first state of the generator is QUEUE_SEED, so the
// same input always gives the same sums.
export const QUEUE_DRAWS = 4000;
export const QUEUE_SEED = 4242;
// The generator is a linear congruential one: state' = (state * MULTIPLIER +
// INCREMENT) mod MODULUS. A state under the modulus times the multiplier is under
// 2 ** 53, so every step is exact in a double.
const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const LCG_MODULUS = 2 ** 32;
// The likely range of the sum is from this to this percentile of the draws. Its low
// and high ends are RANGE_LOW and RANGE_HIGH, as for one item.
const QUEUE_LIKELY_LOW = 0.25;
const QUEUE_LIKELY_HIGH = 0.75;

export function nextQueueState(state: number): number {
  return (state * LCG_MULTIPLIER + LCG_INCREMENT) % LCG_MODULUS;
}

// The sums of the queue in percent of the week. `expectedPct` is the sum of the
// mean costs of the items. `lowPct` to `highPct` are percentiles of the drawn sums.
// `spentPct` is the sum of the costs so far.
export interface QueueSums {
  readonly expectedPct: number;
  readonly lowPct: number;
  readonly likelyLowPct: number;
  readonly likelyHighPct: number;
  readonly highPct: number;
  readonly spentPct: number;
}

// `count` is the number of items. The sums are null when they can not be worked
// out: no ready week, fewer than MIN_GROUP_TASKS finished tasks with a cost, or a
// value that is not finite.
export interface QueueSum {
  readonly count: number;
  readonly sums: QueueSums | null;
}

const EMPTY_QUEUE_SUMS: QueueSums = { expectedPct: 0, lowPct: 0, likelyLowPct: 0, likelyHighPct: 0, highPct: 0, spentPct: 0 };

// What one item adds to a draw. A drawn item takes one of the sorted costs from
// index `start` up (`size` costs, with their mean). An item that counts as its
// cost so far adds that cost, and takes no draw.
type QueuePool =
  | { readonly kind: "drawn"; readonly start: number; readonly size: number; readonly mean: number }
  | { readonly kind: "spent"; readonly cost: number };

// The cost so far of an item when it counts: a finite number above 0.
function costSoFarOf(item: EstimateItem): number | null {
  const { spent } = item;
  return spent !== undefined && Number.isFinite(spent) && spent > 0 ? spent : null;
}

// Entry i is the sum of costs i and up. The last entry is 0.
function suffixSums(costs: readonly number[]): number[] {
  const suffix = new Array<number>(costs.length + 1).fill(0);
  for (let index = costs.length - 1; index >= 0; index -= 1) suffix[index] = (suffix[index + 1] ?? 0) + (costs[index] ?? 0);
  return suffix;
}

// The pool of each item, in the order given, over the sorted costs of the finished
// tasks (at least one). An item with no cost so far takes any cost. An item with a
// cost so far takes the costs at or over it, and counts as its cost so far when
// fewer than SPENT_MIN_TASKS tasks cost as much.
function queuePoolsOf(items: readonly EstimateItem[], costs: readonly number[]): QueuePool[] {
  const suffix = suffixSums(costs);
  return items.map((item): QueuePool => {
    const spent = costSoFarOf(item);
    const start = spent === null ? 0 : firstAtOrAbove(costs, spent);
    const size = costs.length - start;
    if (spent !== null && size < SPENT_MIN_TASKS) return { kind: "spent", cost: spent };
    return { kind: "drawn", start, size, mean: (suffix[start] ?? 0) / size };
  });
}

// QUEUE_DRAWS sums. Each draw takes the items in the order given. A drawn item
// first advances the one generator of the call, then takes the cost at index start
// + floor(state / MODULUS * size). An item that counts as its cost so far takes no
// state.
function queueDraws(pools: readonly QueuePool[], costs: readonly number[]): number[] {
  const draws = new Array<number>(QUEUE_DRAWS).fill(0);
  let state = QUEUE_SEED;
  for (let draw = 0; draw < QUEUE_DRAWS; draw += 1) {
    let total = 0;
    for (const pool of pools) {
      if (pool.kind === "spent") {
        total += pool.cost;
      } else {
        state = nextQueueState(state);
        total += costs[pool.start + Math.floor((state / LCG_MODULUS) * pool.size)] ?? Number.NaN;
      }
    }
    draws[draw] = total;
  }
  return draws;
}

// The sums of the queue in percent of the week, or null unless every draw and
// every sum is a finite number.
function queueSummary(draws: readonly number[], pools: readonly QueuePool[], spent: number, perPct: number): QueueSums | null {
  if (!allFinite(draws)) return null;
  const sorted = sortedAscending(draws);
  let expected = 0;
  for (const pool of pools) expected += pool.kind === "spent" ? pool.cost : pool.mean;
  const sums: QueueSums = {
    expectedPct: expected / perPct,
    lowPct: percentile(sorted, RANGE_LOW) / perPct,
    likelyLowPct: percentile(sorted, QUEUE_LIKELY_LOW) / perPct,
    likelyHighPct: percentile(sorted, QUEUE_LIKELY_HIGH) / perPct,
    highPct: percentile(sorted, RANGE_HIGH) / perPct,
    spentPct: spent / perPct,
  };
  return allFinite(Object.values(sums)) ? sums : null;
}

// The sum of the costs of the open items, as draws from the finished tasks. Each
// item takes a cost of a finished task at random: any cost, or, for a running item,
// one of the costs at or over its cost so far (see queuePoolsOf). No floor applies:
// every finished task with a cost counts. Null for more than SYNC_MAX_OPEN_ITEMS
// items. No items give zero sums, whatever the calibration. The sums depend on the
// items that the caller sends.
export function queueSum(
  items: readonly EstimateItem[],
  history: readonly EstimateTask[],
  calibrations: Readonly<Record<Subscription, Calibration>>,
  subscription: Subscription = "claude",
): QueueSum | null {
  const count = items.length;
  if (count > SYNC_MAX_OPEN_ITEMS) return null;
  if (count === 0) return { count, sums: EMPTY_QUEUE_SUMS };
  const perPct = perPctOf(calibrations[subscription]);
  const costs = sortedCostsOf(observedOf(history, subscription));
  if (perPct === null || costs.length < MIN_GROUP_TASKS) return { count, sums: null };
  const pools = queuePoolsOf(items, costs);
  let spent = 0;
  for (const item of items) spent += costSoFarOf(item) ?? 0;
  return { count, sums: queueSummary(queueDraws(pools, costs), pools, spent, perPct) };
}

// ---------------------------------------------------------------------------
// The estimate log and the self-check
// ---------------------------------------------------------------------------

// A self-check covers this many of the most recent finished tasks.
export const SELF_CHECK_TASKS = 30;
// Its hit rate, error factor, bias and band show from this many scored tasks.
export const SELF_CHECK_MIN_SCORED = 5;
// A range is useful for a week plan when its high end is at most this many times
// its low end. The bound is inclusive.
const USEFUL_WIDTH = 4;

// The band that the hit rate of `n` scored tasks should fall in when the range
// holds what it claims: the 2.5% and the 97.5% quantile of a count of hits with
// the chance 4/5 (RANGE_HIGH - RANGE_LOW), divided by n. The probabilities are
// C(n, j) 4^j / 5^n, so the quantiles compare as whole numbers and no rounding
// decides one. Null unless n is a whole number from 1 to SELF_CHECK_TASKS: the
// check comes before any BigInt, so no input makes the work large. Null too unless
// both quantiles were found and the low one is not above the high one. Never throws.
export function hitRateBand(n: number): { readonly low: number; readonly high: number } | null {
  if (!Number.isSafeInteger(n) || n < 1 || n > SELF_CHECK_TASKS) return null;
  const total = 5n ** BigInt(n);
  let choose = 1n;
  let power = 1n;
  let cumulative = 0n;
  let low = -1;
  let high = -1;
  // The chance of k or fewer hits is cumulative / total. The 2.5% quantile is the
  // first k where it reaches 1/40, and the 97.5% quantile the first where it reaches 39/40.
  for (let k = 0; k <= n; k += 1) {
    cumulative += choose * power;
    if (low < 0 && 40n * cumulative >= total) low = k;
    if (high < 0 && 40n * cumulative >= 39n * total) high = k;
    choose = (choose * BigInt(n - k)) / BigInt(k + 1);
    power *= 4n;
  }
  if (low < 0 || high < 0 || low > high) return null;
  return { low: low / n, high: high / n };
}

interface EstimateLogLineBase {
  // Epoch milliseconds.
  readonly at: number;
  readonly key: string;
  readonly basisName: string;
  // The names of the features that the item carried, sorted. Not their values.
  readonly features: readonly string[];
  // The stage tag of the item, or null when it had none.
  readonly stage: string | null;
  // The project of the basis, if any. An absent scope has the same meaning as null.
  readonly basisProject?: string | null;
}

// A line of an estimate with a basis, and the range that it showed in weighted tokens.
export interface RangedLogLine extends EstimateLogLineBase {
  readonly basis: "similar" | "wide";
  readonly low: number;
  readonly high: number;
}

// A line of an estimate with no basis: it showed no range.
export interface NoBasisLogLine extends EstimateLogLineBase {
  readonly basis: "none";
  readonly basisProject?: null;
  readonly low: null;
  readonly high: null;
}

// One line of the estimate log: what the estimate of an item rested on when the
// line was written.
export type EstimateLogLine = RangedLogLine | NoBasisLogLine;

function logLineOf(item: EstimateItem, estimate: SignalEstimate, at: number): EstimateLogLine {
  const features = Object.keys(item.features).sort(compareText);
  const stage = stageOf(item.tags);
  if (estimate.basis === "none") {
    return { at, key: item.key, basis: "none", basisName: BASIS_NONE, features, stage, basisProject: null, low: null, high: null };
  }
  return {
    at,
    key: item.key,
    basis: estimate.basis,
    basisName: estimate.basisName,
    features,
    // A spent line has a fixed stage, so the stage tag of the item cannot start a new line.
    stage: estimate.basisName === BASIS_SPENT ? SPENT_STAGE : stage,
    basisProject: estimate.basisProject ?? null,
    low: estimate.weightedLow,
    // An open range logs its low end as its high end. The item has already used
    // more than the range of its basis, so the self-check scores the line a miss
    // unless the item stops at its cost so far.
    high: estimate.weightedHigh,
  };
}

// The same basis, basis name, project scope, feature names and stage. The
// range is not part of it: a range moves with every new finished task.
function sameBasis(a: EstimateLogLine, b: EstimateLogLine): boolean {
  return (
    a.basis === b.basis &&
    a.basisName === b.basisName &&
    (a.basisProject ?? null) === (b.basisProject ?? null) &&
    a.stage === b.stage &&
    a.features.length === b.features.length &&
    a.features.every((name, index) => name === b.features[index])
  );
}

// The lines in time order, each repeat of the latest state of its key left out:
// the log as the writer sees it, where a line is a change.
export function settledLines(lines: readonly EstimateLogLine[]): readonly EstimateLogLine[] {
  const last = new Map<string, EstimateLogLine>();
  const kept: EstimateLogLine[] = [];
  for (const line of [...lines].sort((a, b) => a.at - b.at)) {
    const before = last.get(line.key);
    if (before !== undefined && sameBasis(before, line)) continue;
    last.set(line.key, line);
    kept.push(line);
  }
  return kept;
}

// The latest line of each key. Of two lines with one time, the later one in the input wins.
function latestByKey(lines: readonly EstimateLogLine[]): Map<string, EstimateLogLine> {
  const latest = new Map<string, EstimateLogLine>();
  for (const line of lines) {
    const last = latest.get(line.key);
    if (last === undefined || line.at >= last.at) latest.set(line.key, line);
  }
  return latest;
}

// The lines to write for the estimates of a pass: one for each key that has no
// line yet, and one for each key whose basis, basis name, project scope, feature
// names or stage differ from its latest line. `estimates` is in the order of `items`.
export function newLogLines(
  items: readonly EstimateItem[],
  estimates: readonly SignalEstimate[],
  logged: readonly EstimateLogLine[],
  at: number,
): readonly EstimateLogLine[] {
  const last = latestByKey(logged);
  const fresh: EstimateLogLine[] = [];
  items.forEach((item, index) => {
    const estimate = estimates[index];
    if (estimate === undefined) return;
    const line = logLineOf(item, estimate, at);
    const before = last.get(line.key);
    if (before !== undefined && sameBasis(before, line)) return;
    last.set(line.key, line);
    fresh.push(line);
  });
  return fresh;
}

// A finished task as the self-check reads it.
export interface FinishedTask {
  readonly label: string;
  readonly start: number;
  readonly end: number;
  readonly totals: Readonly<Record<Subscription, TokenTotals>>;
}

// How the logged ranges did on a set of scored tasks: all of them, or those that
// a stage tag links to a line.
export interface StageCheck {
  // The tasks among the most recent finished ones that had a range in the log
  // before they ended and a cost to compare with it.
  readonly scored: number;
  // The part of the scored tasks whose cost fell inside the logged range. Null
  // under SELF_CHECK_MIN_SCORED tasks.
  readonly hitRate: number | null;
  // The median factor between the cost and the middle of the logged range, 1 or
  // more. Null under SELF_CHECK_MIN_SCORED tasks, and null when it is not finite
  // (the exp of a very large offset overflows).
  readonly errorFactor: number | null;
  // The median factor from the cost to the middle of the logged range: above 1
  // when the ranges sit above the cost (high), below 1 when they sit below it
  // (low). Null under SELF_CHECK_MIN_SCORED tasks, and null when it is not finite
  // or not above 0 (the exp of a very large offset overflows or underflows).
  readonly bias: number | null;
  // The band that the hit rate falls in when the ranges hold what they claim
  // (hitRateBand). Null under SELF_CHECK_MIN_SCORED tasks.
  readonly bandLow: number | null;
  readonly bandHigh: number | null;
  // The median of the high end over the low end of the logged ranges, 1 or more:
  // how wide the ranges are. An open line has equal ends, so its ratio is 1. Null
  // under SELF_CHECK_MIN_SCORED tasks, and null when it is not finite (a range
  // from a tiny low end to a huge high end).
  readonly width: number | null;
  // The part of the scored tasks whose cost fell inside the logged range and
  // whose high end was at most USEFUL_WIDTH times its low end: a hit that a week
  // plan can use. At most the hit rate. Null under SELF_CHECK_MIN_SCORED tasks.
  readonly usefulRate: number | null;
}

export interface SelfCheck extends StageCheck {
  // The same check for each stage tag that links to a task: the latest line of
  // the stage that links to the task. A line with no stage counts only above. The
  // lines on the spent basis have the stage run, so they count here and not above:
  // the top level reads the latest line that is not on the spent basis, and skips
  // a task that has none. At most MAX_STAGES stages, the ones with the most scored
  // tasks first (ties by text), then in text order. A task can count in several
  // stages. The map holds labels as keys only: a label is never a property name.
  readonly stages: ReadonlyMap<string, StageCheck>;
}

// The stages that a self-check shows. A stage past this is left out.
export const MAX_STAGES = 8;

function newestFirst(a: FinishedTask, b: FinishedTask): number {
  return b.end - a.end || b.start - a.start || compareText(a.label, b.label);
}

// The index of the first task that ends after `atMs`, in tasks sorted by end.
function firstEndingAfter(tasks: readonly FinishedTask[], atMs: number): number {
  let low = 0;
  let high = tasks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((tasks[middle]?.end ?? Number.NEGATIVE_INFINITY) > atMs) high = middle;
    else low = middle + 1;
  }
  return low;
}

// Of two lines with one time, the later one in the input wins.
function laterLine(before: EstimateLogLine | undefined, line: EstimateLogLine): EstimateLogLine {
  return before === undefined || line.at >= before.at ? line : before;
}

// The lines that link to one window: the latest line of any stage, the latest line
// that is not on the spent basis (null when every line is), and the latest line of
// each stage tag. A line with no stage counts in the first two only. With no spent
// line, the first two are the same line. A line is on the spent basis by its basis
// name alone, never by its stage.
interface Links {
  readonly latest: EstimateLogLine;
  readonly latestUnspent: EstimateLogLine | null;
  readonly byStage: ReadonlyMap<string, EstimateLogLine>;
}

// The links of one window while its lines come in. The builder owns its map: only
// `add` changes it, and `links` hands out a copy, made once for a window and not
// once for a line, so no later `add` shows in a value that was handed out. A stage
// label is only a key of the map.
interface LinkBuilder {
  add(line: EstimateLogLine): void;
  links(): Links;
}

function linkBuilder(first: EstimateLogLine): LinkBuilder {
  let latest = first;
  let latestUnspent: EstimateLogLine | null = null;
  const byStage = new Map<string, EstimateLogLine>();
  const add = (line: EstimateLogLine): void => {
    latest = laterLine(latest, line);
    if (line.basisName !== BASIS_SPENT) latestUnspent = laterLine(latestUnspent ?? undefined, line);
    if (line.stage !== null) byStage.set(line.stage, laterLine(byStage.get(line.stage), line));
  };
  add(first);
  return { add, links: () => ({ latest, latestUnspent, byStage: new Map(byStage) }) };
}

// Each line links to the first window with its label that ends strictly after the
// log time: the one link rule of the self-check and of the keep rule.
function linkedLines(lines: readonly EstimateLogLine[], finished: readonly FinishedTask[]): Map<FinishedTask, Links> {
  const byLabel = new Map<string, FinishedTask[]>();
  for (const task of finished) {
    const group = byLabel.get(task.label);
    if (group === undefined) byLabel.set(task.label, [task]);
    else group.push(task);
  }
  for (const group of byLabel.values()) group.sort((a, b) => a.end - b.end);
  const builders = new Map<FinishedTask, LinkBuilder>();
  for (const line of lines) {
    const group = byLabel.get(line.key);
    const task = group?.[firstEndingAfter(group, line.at)];
    if (task === undefined) continue;
    const builder = builders.get(task);
    if (builder === undefined) builders.set(task, linkBuilder(line));
    else builder.add(line);
  }
  return new Map([...builders].map(([task, builder]) => [task, builder.links()] as const));
}

interface RecentTask {
  readonly task: FinishedTask;
  readonly latest: EstimateLogLine;
  readonly latestUnspent: EstimateLogLine | null;
  readonly byStage: ReadonlyMap<string, EstimateLogLine>;
}

// The lines of one key that the keep rule needs: the latest line of any stage, the
// latest line that is not on the spent basis (the line that the top level of the
// self-check reads), and the latest line of each stage. There is no cap on the
// stages here.
function neededOf({ latest, latestUnspent, byStage }: Links): readonly EstimateLogLine[] {
  return [latest, ...(latestUnspent === null ? [] : [latestUnspent]), ...byStage.values()];
}

// Each of the SELF_CHECK_TASKS most recent finished tasks that has a line, with
// its lines, the most recent task first.
function recentLinked(lines: readonly EstimateLogLine[], finished: readonly FinishedTask[]): readonly RecentTask[] {
  const linked = linkedLines(lines, finished);
  return [...finished]
    .sort(newestFirst)
    .slice(0, SELF_CHECK_TASKS)
    .flatMap((task) => {
      const links = linked.get(task);
      return links === undefined ? [] : [{ task, ...links }];
    });
}

export interface ScoredPair {
  readonly task: FinishedTask;
  readonly line: EstimateLogLine;
}

// The value, or null when it is not finite or not above 0: the exp of a very large
// offset overflows or underflows.
function finitePositive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

// Scores the lines against the cost of their tasks. A line with no basis and a
// task with no cost are not scored. The numbers show from SELF_CHECK_MIN_SCORED
// scored tasks, and only with a band: when hitRateBand has none (more scored tasks
// than it covers) every number is null.
export function checkOf(pairs: readonly ScoredPair[], subscription: Subscription): StageCheck {
  // The log of the middle of the range over the cost, for each scored task.
  const offsets: number[] = [];
  // The high end over the low end, for each scored task.
  const ratios: number[] = [];
  let hits = 0;
  let useful = 0;
  for (const { task, line } of pairs) {
    const cost = task.totals[subscription].weighted;
    if (line.basis === "none" || !(cost > 0) || !Number.isFinite(cost)) continue;
    const inside = line.low <= cost && cost <= line.high;
    if (inside) hits += 1;
    if (inside && line.high <= USEFUL_WIDTH * line.low) useful += 1;
    offsets.push((Math.log(line.low) + Math.log(line.high)) / 2 - Math.log(cost));
    ratios.push(line.high / line.low);
  }
  const scored = offsets.length;
  const band = scored < SELF_CHECK_MIN_SCORED ? null : hitRateBand(scored);
  if (band === null) {
    return { scored, hitRate: null, errorFactor: null, bias: null, bandLow: null, bandHigh: null, width: null, usefulRate: null };
  }
  return {
    scored,
    hitRate: hits / scored,
    errorFactor: finitePositive(medianOf(offsets.map((offset) => Math.exp(Math.abs(offset))))),
    bias: finitePositive(Math.exp(medianOf(offsets))),
    bandLow: band.low,
    bandHigh: band.high,
    width: finitePositive(medianOf(ratios)),
    usefulRate: useful / scored,
  };
}

// The MAX_STAGES stages with the most scored tasks, ties by text, in text order.
function keptStages(checks: readonly (readonly [string, StageCheck])[]): Map<string, StageCheck> {
  const ranked = [...checks]
    .sort(([nameA, checkA], [nameB, checkB]) => checkB.scored - checkA.scored || compareText(nameA, nameB))
    .slice(0, MAX_STAGES)
    .sort(([nameA], [nameB]) => compareText(nameA, nameB));
  return new Map(ranked);
}

// How the logged ranges did against the cost of the SELF_CHECK_TASKS most recent
// finished tasks: the latest line that is not on the spent basis that links to
// each task (a task with only spent lines is not scored here), and for each stage
// the latest line of that stage. This function has no file and no clock.
export function selfCheck(
  lines: readonly EstimateLogLine[],
  finished: readonly FinishedTask[],
  subscription: Subscription = "claude",
): SelfCheck {
  const recent = recentLinked(lines, finished);
  const pairsOfStage = new Map<string, ScoredPair[]>();
  for (const { task, byStage } of recent) {
    for (const [stage, line] of byStage) {
      const pairs = pairsOfStage.get(stage);
      if (pairs === undefined) pairsOfStage.set(stage, [{ task, line }]);
      else pairs.push({ task, line });
    }
  }
  const stages = keptStages([...pairsOfStage].map(([stage, pairs]) => [stage, checkOf(pairs, subscription)] as const));
  const top = recent.flatMap(({ task, latestUnspent }) => (latestUnspent === null ? [] : [{ task, line: latestUnspent }]));
  return { ...checkOf(top, subscription), stages };
}

// A window of the last sync, as the keep rule reads it.
export interface WindowSpan {
  readonly label: string;
  readonly start: number;
  // Null while the task is open.
  readonly end: number | null;
}

// What can still need a line of the estimate log.
export interface KeepInput {
  readonly lines: readonly EstimateLogLine[];
  // True when the log was not read in full: what it holds is not known.
  readonly damaged: boolean;
  readonly finished: readonly FinishedTask[];
  // The keys of the items that are open now.
  readonly openKeys: readonly string[];
  // The windows of the last sync. One that has ended and is not among `finished`
  // (the freeze waits for the delay and for a scan with no backlog) still needs
  // its line.
  readonly windows: readonly WindowSpan[];
}

// The lines that the self-check reads for the most recent finished tasks: the
// latest line of any stage, the latest line that is not on the spent basis, and
// the latest line of each stage.
function linesOfRecentTasks(input: KeepInput): readonly EstimateLogLine[] {
  return recentLinked(input.lines, input.finished).flatMap(neededOf);
}

// The latest line of each open item, its latest line that is not on the spent
// basis, and the latest line of each of its stages: its window is not in the
// history yet, and these are the lines that the score of the finished task will
// read.
function linesOfOpenItems(input: KeepInput): readonly EstimateLogLine[] {
  const open = new Set(input.openKeys);
  const builders = new Map<string, LinkBuilder>();
  for (const line of input.lines) {
    if (!open.has(line.key)) continue;
    const builder = builders.get(line.key);
    if (builder === undefined) builders.set(line.key, linkBuilder(line));
    else builder.add(line);
  }
  return [...builders.values()].flatMap((builder) => neededOf(builder.links()));
}

// A task is the same window when its label and start are the same.
function windowId(label: string, start: number): string {
  return `${start}:${label}`;
}

// For each window that has ended and has no entry in the history, the latest line
// of its label before its end, the latest such line that is not on the spent
// basis, and the latest line of each stage before its end: the lines that the
// score of the task will read once the freeze has run.
function linesOfEndedWindows(input: KeepInput): readonly EstimateLogLine[] {
  const frozen = new Set(input.finished.map((task) => windowId(task.label, task.start)));
  const ended = input.windows.flatMap((window) =>
    window.end !== null && !frozen.has(windowId(window.label, window.start)) ? [{ label: window.label, end: window.end }] : [],
  );
  if (ended.length === 0) return [];
  const byKey = new Map<string, EstimateLogLine[]>();
  for (const line of input.lines) {
    const group = byKey.get(line.key);
    if (group === undefined) byKey.set(line.key, [line]);
    else group.push(line);
  }
  return ended.flatMap(({ label, end }) => {
    let builder: LinkBuilder | undefined;
    for (const line of byKey.get(label) ?? []) {
      if (!(line.at < end)) continue;
      if (builder === undefined) builder = linkBuilder(line);
      else builder.add(line);
    }
    return builder === undefined ? [] : neededOf(builder.links());
  });
}

// The epoch time of the oldest line of the log that is still needed. A month file
// may go only when it is older than the month of this time. Null: no file may
// go. Three cases give null: the log was not read in full, fewer than
// SELF_CHECK_TASKS tasks have finished, or no line is needed. This function has
// no file and no clock.
export function keepTime(input: KeepInput): number | null {
  if (input.damaged || input.finished.length < SELF_CHECK_TASKS) return null;
  const needed = [...linesOfRecentTasks(input), ...linesOfOpenItems(input), ...linesOfEndedWindows(input)];
  // A loop, not Math.min(...times): the list can hold a line for each stage of each
  // key, and a spread of that many arguments overflows the stack.
  let oldest: number | null = null;
  for (const line of needed) {
    if (oldest === null || line.at < oldest) oldest = line.at;
  }
  return oldest;
}
