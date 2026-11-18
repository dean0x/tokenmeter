// Token totals, calibration and the forecast (plan 3.5, section 4).
//
// `analyze` is a pure function of the clock, the zone, the bucket rows, the
// quota samples and the times the samples were last seen. `readAnalysis` reads
// them from the data folder and calls it. The result holds plain read-only records for the status JSON.
//
// A bucket row counts in a period when its slot is in the slot range of the
// period (see periods.ts). The values that leave this module are fresh and
// read-only. The accumulators inside `analyze` are private and mutated in place.

import {
  PERCENT_MAX,
  type Result,
  TOKEN_BUCKETS,
  type TokenRecord,
  compareText,
  ok,
  percentile,
  weighted,
} from "./core.ts";
import { type FsDeps, defaultDeps } from "./fsafe.ts";
import {
  HOUR_MS,
  type Period,
  WEEK_MS,
  type WeekPeriod,
  type Zone,
  monthPeriod,
  slotRange,
  todayPeriod,
  weekPeriod,
} from "./periods.ts";
import { type QuotaSample, pickLatestSample, readObservations, readQuotaSamples } from "./quota.ts";
import type { QuotaWindow } from "./sources.ts";
import {
  type Provider,
  type StoreError,
  horizonStartMs,
  loadBucketMonth,
  monthName,
  parseBucketKey,
  slotOf,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CollectState = "ok" | "counting" | "never" | "stopped";

export type Confidence = "rough" | "low" | "medium" | "high";

export const CALIBRATION_LABEL = "local use only";
export const NOT_READY_LABEL = "not ready";

export interface BucketRow {
  readonly slot: number;
  readonly provider: Provider;
  readonly model: string;
  readonly folderKey: string;
  readonly tokens: TokenRecord;
}

// Five raw columns and their weighted value. Codex never has a 1 hour cache write.
export interface TokenTotals extends TokenRecord {
  readonly weighted: number;
}

export interface PeriodTotals {
  readonly today: TokenTotals;
  readonly week: TokenTotals;
  readonly month: TokenTotals;
}

export interface ModelUsage {
  readonly provider: Provider;
  readonly name: string;
  readonly tokens: PeriodTotals;
}

// Weighted tokens for 1 percent of the week. `intervals` is the number of valid
// intervals that were found, also when the rough value is used.
export type Calibration =
  | {
      readonly ready: true;
      readonly perPctWeighted: number;
      readonly confidence: Confidence;
      readonly intervals: number;
      readonly label: typeof CALIBRATION_LABEL;
    }
  | { readonly ready: false; readonly label: typeof NOT_READY_LABEL };

export interface ForecastPoint {
  readonly usedPercent: number;
  readonly resetsAt: number;
  readonly at: number;
}

export interface Forecast {
  readonly burnPctPerHour: number;
  // The projected percent at the reset. It is not capped at 100.
  readonly atResetPct: number;
  // Epoch milliseconds, or null for "not before reset".
  readonly runsOutAt: number | null;
  // Epoch milliseconds: the time of the reading that the burn and the run-out time use.
  readonly at: number;
  readonly basis: "latest sample";
}

export interface SubscriptionUsage {
  readonly provider: Provider;
  readonly week: WeekPeriod;
  readonly tokens: PeriodTotals;
  // The latest sample of each window whose reset time is after `nowMs`.
  readonly latest: Readonly<Record<QuotaWindow, QuotaSample | null>>;
  readonly forecast: Forecast | null;
  readonly calibration: Calibration;
}

export interface Analysis {
  readonly today: Period;
  readonly month: Period;
  // Always claude, then codex.
  readonly subscriptions: readonly SubscriptionUsage[];
  // Every model with tokens in a period, the largest week first.
  readonly models: readonly ModelUsage[];
}

export interface AnalysisInput {
  readonly nowMs: number;
  readonly zone: Zone;
  readonly rows: readonly BucketRow[];
  readonly samples: readonly QuotaSample[];
  // The last time the numbers of a sample were seen, where that is later than the sample.
  // A repeat is not stored as a sample (see storeCodexQuota and recordStatuslineQuota). See lastSeen.
  readonly observations: readonly QuotaSample[];
  readonly collectState: CollectState;
}

// ---------------------------------------------------------------------------
// Constants (section 4)
// ---------------------------------------------------------------------------

const PROVIDERS: readonly Provider[] = ["claude", "codex"];

// No burn in the first 3 percent of the week.
const BURN_FREE_FRACTION = 0.03;
// Two reset times this close are the same reset period.
export const RESET_TOLERANCE_MS = 60_000;

const MIN_INTERVAL_MS = HOUR_MS;
const MIN_INTERVAL_POINTS = 5;
const MIN_INTERVALS = 2;
const MIN_ROUGH_PERCENT = 5;
const HIGH_INTERVALS = 6;
const HIGH_SPREAD = 0.25;
const MEDIUM_INTERVALS = 3;
const MEDIUM_SPREAD = 0.5;
const MEDIAN = 0.5;
const LOWER_QUARTILE = 0.25;
const UPPER_QUARTILE = 0.75;

// ---------------------------------------------------------------------------
// Token totals
// ---------------------------------------------------------------------------

interface PeriodAcc {
  readonly today: number[];
  readonly week: number[];
  readonly month: number[];
}

export function newColumns(): number[] {
  return TOKEN_BUCKETS.map(() => 0);
}

function newAcc(): PeriodAcc {
  return { today: newColumns(), week: newColumns(), month: newColumns() };
}

export function addColumns(columns: number[], tokens: TokenRecord): void {
  TOKEN_BUCKETS.forEach((bucket, index) => {
    columns[index] = (columns[index] ?? 0) + tokens[bucket];
  });
}

export function totalsOf(columns: readonly number[]): TokenTotals {
  const record: TokenRecord = {
    input: columns[0] ?? 0,
    cacheWrite5m: columns[1] ?? 0,
    cacheWrite1h: columns[2] ?? 0,
    cacheRead: columns[3] ?? 0,
    output: columns[4] ?? 0,
  };
  return { ...record, weighted: weighted(record) };
}

function periodTotals(acc: PeriodAcc): PeriodTotals {
  return { today: totalsOf(acc.today), week: totalsOf(acc.week), month: totalsOf(acc.month) };
}

export interface SlotRange {
  readonly from: number;
  readonly to: number;
}

export function within(slot: number, range: SlotRange): boolean {
  return slot >= range.from && slot < range.to;
}

export type PeriodName = "today" | "week" | "month";

export const PERIOD_NAMES: readonly PeriodName[] = ["today", "week", "month"];

// The slots of the three periods of each subscription. Today and the month are
// the same for both; the week is the week of the subscription.
export type PeriodSlots = Readonly<Record<Provider, Readonly<Record<PeriodName, SlotRange>>>>;

const NO_SLOTS: SlotRange = { from: 0, to: 0 };
const NO_PERIODS = { today: NO_SLOTS, week: NO_SLOTS, month: NO_SLOTS };

// Periods that hold no slot.
export const NO_PERIOD_SLOTS: PeriodSlots = { claude: NO_PERIODS, codex: NO_PERIODS };

export function periodSlots(analysis: Analysis): PeriodSlots {
  const today = slotRange(analysis.today);
  const month = slotRange(analysis.month);
  const of = (provider: Provider): Readonly<Record<PeriodName, SlotRange>> => {
    const week = analysis.subscriptions.find((s) => s.provider === provider)?.week;
    return { today, week: week === undefined ? NO_SLOTS : slotRange(week), month };
  };
  return { claude: of("claude"), codex: of("codex") };
}

function compareModels(a: ModelUsage, b: ModelUsage): number {
  const byWeek = b.tokens.week.weighted - a.tokens.week.weighted;
  if (byWeek !== 0) return byWeek;
  return compareText(`${a.provider}/${a.name}`, `${b.provider}/${b.name}`);
}

// ---------------------------------------------------------------------------
// Forecast
// ---------------------------------------------------------------------------

// Arithmetic only. The week starts 7 days before the reset time of the sample.
// Burn is percent per hour since the week start, up to the time of the reading.
// No burn in the first 3 percent of the week.
export function forecastFrom(point: ForecastPoint): Forecast | null {
  const elapsedMs = point.at - (point.resetsAt - WEEK_MS);
  if (!(elapsedMs >= BURN_FREE_FRACTION * WEEK_MS)) return null;
  const burn = point.usedPercent / (elapsedMs / HOUR_MS);
  const atResetPct = point.usedPercent + burn * ((point.resetsAt - point.at) / HOUR_MS);
  const runsOut = burn > 0 ? point.at + ((PERCENT_MAX - point.usedPercent) / burn) * HOUR_MS : Number.POSITIVE_INFINITY;
  return {
    burnPctPerHour: burn,
    atResetPct,
    runsOutAt: runsOut <= point.resetsAt ? Math.round(runsOut) : null,
    at: point.at,
    basis: "latest sample",
  };
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

// The week samples of the current reset period: the same reset time within a
// minute, and taken inside the week.
function samplesOfPeriod(samples: readonly QuotaSample[], provider: Provider, week: WeekPeriod): QuotaSample[] {
  return samples.filter(
    (s) =>
      s.provider === provider &&
      s.window === "week" &&
      Math.abs(s.resetsAt - week.end) <= RESET_TOLERANCE_MS &&
      s.at >= week.start - RESET_TOLERANCE_MS,
  );
}

// The sample with the time its numbers were last seen. A sample line holds the
// time of the change, the observation holds the time of the last repeat. The
// forecast and the shown sample use the later time. The calibration does not: it
// needs the time of the change.
function lastSeen(sample: QuotaSample, observations: readonly QuotaSample[]): QuotaSample {
  let at = sample.at;
  for (const seen of observations) {
    const same =
      seen.provider === sample.provider &&
      seen.window === sample.window &&
      seen.usedPercent === sample.usedPercent &&
      seen.resetsAt === sample.resetsAt;
    if (same && seen.at > at) at = seen.at;
  }
  return at === sample.at ? sample : { ...sample, at };
}

function lastSeenOrNull(sample: QuotaSample | null, observations: readonly QuotaSample[]): QuotaSample | null {
  return sample === null ? null : lastSeen(sample, observations);
}

// A percent only grows inside one reset period, so the latest sample is the
// highest percent, and of those the later one. A restamped copy with an older
// percent does not win.
function latestOf(samples: readonly QuotaSample[]): QuotaSample | null {
  let best: QuotaSample | null = null;
  for (const sample of samples) {
    const wins =
      best === null ||
      sample.usedPercent > best.usedPercent ||
      (sample.usedPercent === best.usedPercent && sample.at > best.at);
    if (wins) best = sample;
  }
  return best;
}

// Weighted tokens of one subscription for each slot of the week, as running
// sums. The slot of the week end is included, so a sample just before the reset
// is inside.
interface SlotSums {
  readonly from: number;
  readonly prefix: readonly number[];
}

function slotSums(rows: readonly BucketRow[], provider: Provider, week: WeekPeriod): SlotSums {
  const range = slotRange(week);
  const length = range.to - range.from + 1;
  const perSlot = new Array<number>(length).fill(0);
  for (const row of rows) {
    if (row.provider !== provider || row.slot < range.from || row.slot - range.from >= length) continue;
    perSlot[row.slot - range.from] = (perSlot[row.slot - range.from] ?? 0) + weighted(row.tokens);
  }
  const prefix = [0];
  perSlot.forEach((value, index) => prefix.push((prefix[index] ?? 0) + value));
  return { from: range.from, prefix };
}

// Weighted tokens in the slots [fromSlot, toSlot).
function weightedBetween(sums: SlotSums, fromSlot: number, toSlot: number): number {
  const last = sums.prefix.length - 1;
  const low = Math.min(Math.max(fromSlot - sums.from, 0), last);
  const high = Math.min(Math.max(toSlot - sums.from, 0), last);
  return high > low ? (sums.prefix[high] ?? 0) - (sums.prefix[low] ?? 0) : 0;
}

interface Level {
  readonly percent: number;
  readonly at: number;
}

// Each percent level with the time of its first sample. The record pass writes
// a sample when the percent changes, so the first sample of a level is the
// change. A later copy of a sample, restamped, does not move the level.
function levelsOf(samples: readonly QuotaSample[]): Level[] {
  const firstAt = new Map<number, number>();
  for (const sample of samples) {
    const seen = firstAt.get(sample.usedPercent);
    if (seen === undefined || sample.at < seen) firstAt.set(sample.usedPercent, sample.at);
  }
  return [...firstAt].map(([percent, at]) => ({ percent, at })).sort((a, b) => a.percent - b.percent);
}

// Weighted tokens for 1 percent, one value for each interval. An interval goes
// from one level to the first later level that is at least 1 hour later and
// 5 points higher. The next interval starts there, so intervals do not overlap.
// An interval with no tokens gives no value.
function intervalValues(samples: readonly QuotaSample[], sums: SlotSums): number[] {
  const values: number[] = [];
  let anchor: Level | null = null;
  for (const level of levelsOf(samples)) {
    if (anchor === null) {
      anchor = level;
      continue;
    }
    const elapsedMs = level.at - anchor.at;
    const points = level.percent - anchor.percent;
    if (elapsedMs < MIN_INTERVAL_MS || points < MIN_INTERVAL_POINTS) continue;
    const tokens = weightedBetween(sums, slotOf(anchor.at), slotOf(level.at));
    if (tokens > 0) values.push(tokens / points);
    anchor = level;
  }
  return values;
}

function confidenceOf(count: number, spread: number): Confidence {
  if (count >= HIGH_INTERVALS && spread <= HIGH_SPREAD) return "high";
  if (count >= MEDIUM_INTERVALS && spread <= MEDIUM_SPREAD) return "medium";
  return "low";
}

const NOT_READY: Calibration = { ready: false, label: NOT_READY_LABEL };

function ready(perPctWeighted: number, confidence: Confidence, intervals: number): Calibration {
  return { ready: true, perPctWeighted, confidence, intervals, label: CALIBRATION_LABEL };
}

interface CalibrationInput {
  readonly week: WeekPeriod;
  readonly inPeriod: readonly QuotaSample[];
  readonly latest: QuotaSample | null;
  readonly sums: SlotSums;
  readonly collectState: CollectState;
}

// The interval method from two intervals on: the median, with a confidence from
// the count and the spread. Else the day-one rough value: the weighted tokens
// from the week start to the latest sample, divided by its percent. It needs
// 5 percent and a finished scan (no backlog).
function calibrate(input: CalibrationInput): Calibration {
  const values = intervalValues(input.inPeriod, input.sums);
  if (values.length >= MIN_INTERVALS) {
    const sorted = [...values].sort((a, b) => a - b);
    const median = percentile(sorted, MEDIAN);
    const spread = (percentile(sorted, UPPER_QUARTILE) - percentile(sorted, LOWER_QUARTILE)) / median;
    return ready(median, confidenceOf(sorted.length, spread), sorted.length);
  }
  const { latest, week, sums, collectState } = input;
  if (latest === null || collectState !== "ok" || latest.usedPercent < MIN_ROUGH_PERCENT) return NOT_READY;
  const tokens = weightedBetween(sums, slotOf(week.start), slotOf(latest.at));
  return tokens > 0 ? ready(tokens / latest.usedPercent, "rough", values.length) : NOT_READY;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

function perProvider<T>(make: (provider: Provider) => T): Record<Provider, T> {
  return { claude: make("claude"), codex: make("codex") };
}

export function analyze(input: AnalysisInput): Analysis {
  const { nowMs, zone, rows, samples, observations, collectState } = input;
  const today = todayPeriod(zone, nowMs);
  const month = monthPeriod(zone, nowMs);
  const weeks = perProvider((provider) => weekPeriod(samples, provider, nowMs));
  const todaySlots = slotRange(today);
  const monthSlots = slotRange(month);
  const weekSlots = perProvider((provider) => slotRange(weeks[provider]));

  const bySubscription = perProvider(newAcc);
  const byModel = new Map<string, { readonly provider: Provider; readonly name: string; readonly acc: PeriodAcc }>();
  for (const row of rows) {
    const inToday = within(row.slot, todaySlots);
    const inWeek = within(row.slot, weekSlots[row.provider]);
    const inMonth = within(row.slot, monthSlots);
    if (!inToday && !inWeek && !inMonth) continue;
    const key = `${row.provider}|${row.model}`;
    const model = byModel.get(key) ?? { provider: row.provider, name: row.model, acc: newAcc() };
    byModel.set(key, model);
    for (const acc of [bySubscription[row.provider], model.acc]) {
      if (inToday) addColumns(acc.today, row.tokens);
      if (inWeek) addColumns(acc.week, row.tokens);
      if (inMonth) addColumns(acc.month, row.tokens);
    }
  }

  const subscriptions = PROVIDERS.map((provider): SubscriptionUsage => {
    const week = weeks[provider];
    const inPeriod = samplesOfPeriod(samples, provider, week);
    const latest = latestOf(inPeriod);
    const calibration =
      inPeriod.length === 0
        ? NOT_READY
        : calibrate({ week, inPeriod, latest, sums: slotSums(rows, provider, week), collectState });
    return {
      provider,
      week,
      tokens: periodTotals(bySubscription[provider]),
      latest: {
        five_hour: lastSeenOrNull(pickLatestSample(samples, provider, "five_hour", nowMs), observations),
        week: lastSeenOrNull(pickLatestSample(samples, provider, "week", nowMs), observations),
      },
      forecast: latest === null ? null : forecastFrom(lastSeen(latest, observations)),
      calibration,
    };
  });

  const models = [...byModel.values()]
    .map((m): ModelUsage => ({ provider: m.provider, name: m.name, tokens: periodTotals(m.acc) }))
    .sort(compareModels);
  return { today, month, subscriptions, models };
}

// ---------------------------------------------------------------------------
// Reading the data folder
// ---------------------------------------------------------------------------

// The store keeps rows from the horizon: seven days before the UTC month start.
// So the rows and samples of every period are in the UTC month before the
// current one and in the current one.
function horizonMonths(nowMs: number): readonly string[] {
  return [monthName(slotOf(horizonStartMs(nowMs))), monthName(slotOf(nowMs))];
}

export function loadBucketRows(
  dataDir: string,
  nowMs: number,
  deps: FsDeps = defaultDeps(),
): Result<readonly BucketRow[], StoreError> {
  const rows: BucketRow[] = [];
  for (const month of horizonMonths(nowMs)) {
    const loaded = loadBucketMonth(dataDir, month, deps);
    if (!loaded.ok) return loaded;
    for (const [key, columns] of loaded.value) {
      const parts = parseBucketKey(key);
      if (parts === null) continue;
      const [input, cacheWrite5m, cacheWrite1h, cacheRead, output] = columns;
      rows.push({
        ...parts,
        tokens: {
          input: input ?? 0,
          cacheWrite5m: cacheWrite5m ?? 0,
          cacheWrite1h: cacheWrite1h ?? 0,
          cacheRead: cacheRead ?? 0,
          output: output ?? 0,
        },
      });
    }
  }
  return ok(rows);
}

// `rows` are the bucket rows of `nowMs` from `loadBucketRows`, so that the caller
// reads them once. Unreadable quota samples read as none.
export function readAnalysis(
  dataDir: string,
  nowMs: number,
  zone: Zone,
  collectState: CollectState,
  rows: readonly BucketRow[],
  deps: FsDeps = defaultDeps(),
): Analysis {
  const samples = readQuotaSamples(dataDir, horizonMonths(nowMs), nowMs, deps);
  const observations = readObservations(dataDir, nowMs, deps);
  return analyze({ nowMs, zone, rows, samples, observations, collectState });
}
