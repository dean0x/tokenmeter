// The status snapshot (plan 3.5, 3.8).
//
//   status.json   { version, stopped, data, report }, written by collect only
//
// `data` is the status JSON as collect saw it, with every model. `report` holds
// the counters of the last pass, for the doctor. `stopped` is null, or the code
// of the store error that ended the last collect: then `data` and `report` are
// null and every read of the snapshot answers with that code.
//
// `status` reads the snapshot, replaces the Claude quota by the reading of
// quota-latest.json (a stale or out of range reading shows as unknown), and
// works the Claude forecast, the week percent of each task share and the pool out
// again from that reading. It never scans.
//
// All JSON field names here are the output format: snake_case. Times are epoch
// milliseconds. The cache write columns of Codex are null.

import { join } from "node:path";
import {
  type Result,
  SLOT_MS,
  SNAPSHOT_MAX_MODELS,
  STATUS_FINISHED_TASKS,
  STATUS_OPEN_TASKS,
  STATUS_TOP_MODELS,
  STORE_VERSION,
  SYNC_MAX_OPEN_ITEMS,
  asRow,
  compareText,
  isLabel,
  ok,
  rawTokens,
} from "./core.ts";
import {
  type Analysis,
  type Calibration,
  type CollectState,
  type Confidence,
  type Forecast,
  type PeriodName,
  type PeriodSlots,
  type SubscriptionUsage,
  type TokenTotals,
  CALIBRATION_LABEL,
  NOT_READY_LABEL,
  RESET_TOLERANCE_MS,
  forecastFrom,
  periodSlots,
} from "./analysis.ts";
import { ACCOUNT_MAX_ROWS, isFreshAccount, type AccountUsage } from "./account-usage.ts";
import type { CollectReport, RootState } from "./collect.ts";
import { isDateName, localDateOf, monthStartDate, nextMonthStartDate, shiftDate } from "./days.ts";
import {
  type EstimateItem,
  type EstimateLogLine,
  type QueueSum,
  type SelfCheck,
  type SignalEstimate,
  type StageCheck,
  MAX_PROJECTS,
  MAX_STAGES,
  SELF_CHECK_MIN_SCORED,
  SELF_CHECK_TASKS,
  estimateFromSignals,
  hitRateBand,
  newLogLines,
  queueSum,
  selfCheck,
} from "./estimator.ts";
import { type FsDeps, defaultDeps, writeAtomic } from "./fsafe.ts";
import { currentWeek, type WeekKind, type Zone } from "./periods.ts";
import type { LatestQuota, QuotaSample, QuotaWriteReport, UnknownReason } from "./quota.ts";
import type { PoolConfig } from "./pool.ts";
import { DAY_MS, FILE_CAPS, type Provider, type StoreError, failure, openVersioned, readJson } from "./store.ts";
import {
  type FreezeReport,
  type OpenItem,
  type SubscriptionTotals,
  type Tags,
  type TaskEntry,
  type WindowUsage,
  taskShares,
  windowId,
} from "./tasks.ts";

export const STATUS_FILE = "status.json";

const LABELS: Readonly<Record<Provider, string>> = { claude: "Claude", codex: "Codex" };
const PROVIDERS: readonly Provider[] = ["claude", "codex"];
const COLLECT_STATES: readonly string[] = ["ok", "counting", "never", "stopped"];
const ROOT_STATES: readonly string[] = ["scanned", "missing", "skipped", "unsafe"];
const STOPPED_BY: readonly string[] = ["none", "bytes", "time"];
const PERCENT_FULL = 100;
const SKIP_CODE = /^[a-z0-9_]{1,40}$/;
const MAX_SKIP_CODES = 64;

// ---------------------------------------------------------------------------
// The output shape
// ---------------------------------------------------------------------------

export interface TokenColumnsJson {
  readonly input: number;
  readonly cache_write: number | null;
  readonly cache_write_1h: number | null;
  readonly cache_read: number;
  readonly output: number;
  readonly weighted: number;
}

export interface PeriodTokensJson {
  readonly today: TokenColumnsJson;
  readonly week: TokenColumnsJson;
  readonly month: TokenColumnsJson;
}

export interface QuotaPointJson {
  readonly pct: number;
  readonly resets_at: number;
  readonly at: number;
}

export type QuotaSource = "record" | "rollouts" | "none";

// `unknown` holds the reason code of each window that has no usable value.
export interface QuotaJson {
  readonly five_hour: QuotaPointJson | null;
  readonly seven_day: QuotaPointJson | null;
  readonly source: QuotaSource;
  readonly unknown: {
    readonly five_hour: UnknownReason | null;
    readonly seven_day: UnknownReason | null;
  };
}

export interface ForecastJson {
  readonly burn_pct_per_h: number;
  readonly at_reset_pct: number;
  readonly runs_out_at: number | null;
  readonly at: number;
  readonly basis: "latest sample";
}

export interface CalibrationJson {
  readonly per_pct_weighted: number;
  readonly confidence: Confidence;
  readonly intervals: number;
  readonly label: typeof CALIBRATION_LABEL;
}

export type RootName = "ok" | "root_missing" | "unsafe" | "skipped";

export interface SubscriptionJson {
  readonly id: Provider;
  readonly label: string;
  readonly endpoint: string | null;
  readonly root: RootName;
  readonly quota: QuotaJson;
  readonly week: { readonly start: number; readonly end: number; readonly kind: WeekKind };
  readonly tokens: PeriodTokensJson;
  readonly forecast: ForecastJson | null;
  readonly calibration: CalibrationJson | null;
}

export type TokenSource = "logs" | "account" | "mixed";

export interface PeriodTotalJson extends TokenColumnsJson {
  readonly total: number;
  readonly source: TokenSource;
}

export interface AccountJson {
  readonly at: number;
  readonly through: string;
}

export interface SubscriptionOutputJson extends SubscriptionJson {
  readonly tokens: Readonly<Record<PeriodName, PeriodTotalJson>>;
  readonly account: AccountJson | null;
}

export interface ModelJson {
  readonly name: string;
  readonly subscription: Provider;
  readonly today: TokenColumnsJson;
  readonly week: TokenColumnsJson;
  readonly month: TokenColumnsJson;
}

export interface ShareJson {
  readonly subscription: Provider;
  // Weighted tokens since the start of the task: the five columns with the weights.
  readonly weighted: number;
  // Raw tokens since the start of the task: the same five columns added with no weight.
  readonly raw: number;
  readonly pct: number | null;
  // Weighted tokens of the task inside the today, week and month of the subscription
  // (the periods of `subscriptions[].tokens`), with the same even split of shared hours.
  // Null when the task is finished, its window is gone and it ended inside the period.
  readonly today_weighted: number | null;
  readonly week_weighted: number | null;
  readonly month_weighted: number | null;
  // The part of the seven day percent that the task used in the current week. It is
  // never more than that percent. Null when the percent is unknown, its week has ended, it
  // is not of the week of the tokens, the week has no tokens or the tokens of the task are unknown.
  readonly week_pct: number | null;
}

export interface TaskJson {
  readonly label: string;
  readonly tags: Tags;
  readonly open: boolean;
  readonly start: number;
  readonly end: number | null;
  readonly shared: boolean;
  readonly shares: readonly ShareJson[];
  // The pool part of the task: the weighted sum of its week percents. Null in the
  // separate mode, and when a week percent of the task is unknown.
  readonly pool_pct: number | null;
}

export type PoolJson =
  | { readonly mode: "separate" }
  | {
      readonly mode: "combined";
      readonly weights: { readonly claude: number; readonly codex: number };
      // The weighted sum of the two seven day percents, or null when one is unknown.
      readonly used_pct: number | null;
    };

// `basis` is the word: similar, wide or none. `basis_name` says what the range
// rests on: a feature name, type, all, spent or none. It is null in a snapshot
// from an older build. `high_pct` and `raw_high` are null for an open range: a
// running item that has used more than the high end, or a range on the spent
// basis with fewer than 5 finished tasks that cost as much. Read it as `low_pct`
// and more. An open range reads rough: its basis is wide, and `basis_name` keeps
// its name. So
// does a range that was clamped, because a feature value of the item lay outside
// the values of the fit: its ends stay. `typical_pct` (the median cost of the
// basis) and `budget_pct` (its 80th percentile cost) are in percent of the week,
// with low_pct <= typical_pct <= budget_pct <= high_pct. Both are null for an
// open range, and in a snapshot from an older build.
export type EstimateJson =
  | {
      readonly key: string;
      readonly subscription: Provider;
      readonly basis: "similar" | "wide";
      readonly basis_name: string | null;
      readonly low_pct: number;
      readonly high_pct: number | null;
      // The same range in raw tokens. Null in a snapshot from an older build.
      readonly raw_low: number | null;
      readonly raw_high: number | null;
      readonly count: number;
      readonly typical_pct: number | null;
      readonly budget_pct: number | null;
      readonly basis_project: string | null;
    }
  | { readonly key: string; readonly subscription: Provider; readonly basis: "none"; readonly basis_name: string | null };

// How the estimates in the estimate log did against the cost of the last 30
// finished tasks. `n` counts the tasks that had a range in the log before they
// ended. `hit_rate` (0 to 1) is the part of them whose cost fell inside that
// range: an honest 80% range hits about 0.8. `error_factor` is the median factor
// between the cost and the middle of the range, 1 or more. `bias` is the median
// factor from the cost to the middle of the range: above 1 the ranges sit above
// the cost, below 1 below it. `band_low` and `band_high` (0 to 1) are the band
// that the hit rate falls in when the ranges hold what they claim. `width` is the
// median of the high end over the low end of the ranges (1 or more): how wide
// they are. `useful_rate` (0 to 1, at most `hit_rate`) is the part of the tasks
// whose cost fell inside the range and whose high end was at most 4 times its low
// end. These seven show from 5 tasks, else they are null; `width` is also null
// when it is not finite, and both are null in a snapshot from an older build.
// `stages` has the same eight values for each work stage that a line of those
// tasks names, at most 8 stages, in text order (an object puts a label of only
// digits first, in number order): it is an empty object when no line of those
// tasks has a stage, and null when the log could not be read or the snapshot is
// from an older build. `projects` has the same eight values for up to 8
// projects of scored tasks. It is empty when none of those tasks has a project.
// All fields are null when the log could not be read.
export interface StageCheckJson {
  readonly n: number;
  readonly hit_rate: number | null;
  readonly error_factor: number | null;
  readonly bias: number | null;
  readonly band_low: number | null;
  readonly band_high: number | null;
  readonly width: number | null;
  readonly useful_rate: number | null;
}

export interface SelfCheckJson {
  readonly n: number | null;
  readonly hit_rate: number | null;
  readonly error_factor: number | null;
  readonly bias: number | null;
  readonly band_low: number | null;
  readonly band_high: number | null;
  readonly width: number | null;
  readonly useful_rate: number | null;
  readonly stages: Readonly<Record<string, StageCheckJson>> | null;
  readonly projects: Readonly<Record<string, StageCheckJson>> | null;
}

// The sum of the costs of the open items, in percent of the week, as draws from the
// costs of the finished tasks. `count` is the number of open items (0 to 500).
// `expected_pct` is the sum of the mean costs of the items. `low_pct` and `high_pct`
// are the 10th and the 90th percentile of the drawn sums, `likely_low_pct` and
// `likely_high_pct` the 25th and the 75th, so low <= likely_low <= likely_high <=
// high. `spent_pct` is the sum of the costs so far of the running items. The six
// sums are all null while they can not be worked out: no known week size, fewer
// than 3 finished tasks that have a cost, or a sum that is not finite. The sum
// depends on the open items that the input sends.
export interface QueueJson {
  readonly count: number;
  readonly expected_pct: number | null;
  readonly low_pct: number | null;
  readonly high_pct: number | null;
  readonly likely_low_pct: number | null;
  readonly likely_high_pct: number | null;
  readonly spent_pct: number | null;
}

interface CodexRawJson extends Readonly<Record<PeriodName, number>> {
  readonly utc_days: Readonly<Record<string, number>>;
}

export interface StatusData {
  readonly version: number;
  readonly written_at: number;
  readonly collect: { readonly at: number; readonly state: CollectState; readonly progress_pct: number };
  readonly subscriptions: readonly SubscriptionJson[];
  readonly models: readonly ModelJson[];
  readonly tasks: readonly TaskJson[];
  readonly estimates: readonly EstimateJson[];
  // Null in a snapshot from an older build, or when the object is not valid.
  readonly self_check: SelfCheckJson | null;
  readonly pool: PoolJson;
  // Null in a snapshot from an older build, when the object is not valid, and for
  // more than 500 open items. It is not part of the check of a snapshot: a bad
  // queue reads as null and never makes the snapshot corrupt.
  readonly queue: QueueJson | null;
  // The output overlay checks this optional field, not the snapshot reader.
  readonly codex_raw?: CodexRawJson;
}

export interface StatusOutputData extends Omit<StatusData, "codex_raw"> {
  readonly subscriptions: readonly SubscriptionOutputJson[];
}

// ---------------------------------------------------------------------------
// Building the snapshot data
// ---------------------------------------------------------------------------

export function tokensJson(totals: TokenTotals, provider: Provider): TokenColumnsJson {
  const codex = provider === "codex";
  return {
    input: totals.input,
    cache_write: codex ? null : totals.cacheWrite5m,
    cache_write_1h: codex ? null : totals.cacheWrite1h,
    cache_read: totals.cacheRead,
    output: totals.output,
    weighted: totals.weighted,
  };
}

function forecastJson(forecast: Forecast): ForecastJson {
  return {
    burn_pct_per_h: forecast.burnPctPerHour,
    at_reset_pct: forecast.atResetPct,
    runs_out_at: forecast.runsOutAt,
    at: forecast.at,
    basis: forecast.basis,
  };
}

function calibrationJson(calibration: Calibration): CalibrationJson | null {
  if (!calibration.ready) return null;
  return {
    per_pct_weighted: calibration.perPctWeighted,
    confidence: calibration.confidence,
    intervals: calibration.intervals,
    label: calibration.label,
  };
}

function rootName(state: RootState): RootName {
  if (state === "scanned") return "ok";
  return state === "missing" ? "root_missing" : state;
}

function sampleJson(sample: QuotaSample | null): QuotaPointJson | null {
  return sample === null ? null : { pct: sample.usedPercent, resets_at: sample.resetsAt, at: sample.at };
}

// The quota of a subscription from its stored samples: the latest sample of each
// window whose period is still open. A window with none is unknown (missing).
function quotaFromSamples(latest: SubscriptionUsage["latest"], source: QuotaSource): QuotaJson {
  const five = sampleJson(latest.five_hour);
  const week = sampleJson(latest.week);
  return {
    five_hour: five,
    seven_day: week,
    source: five === null && week === null ? "none" : source,
    unknown: { five_hour: five === null ? "missing" : null, seven_day: week === null ? "missing" : null },
  };
}

function subscriptionJson(usage: SubscriptionUsage, root: RootState): SubscriptionJson {
  const id = usage.provider;
  return {
    id,
    label: LABELS[id],
    endpoint: null,
    root: rootName(root),
    quota: quotaFromSamples(usage.latest, id === "claude" ? "record" : "rollouts"),
    week: { start: usage.week.start, end: usage.week.end, kind: usage.week.kind },
    tokens: {
      today: tokensJson(usage.tokens.today, id),
      week: tokensJson(usage.tokens.week, id),
      month: tokensJson(usage.tokens.month, id),
    },
    forecast: usage.forecast === null ? null : forecastJson(usage.forecast),
    calibration: calibrationJson(usage.calibration),
  };
}

// The weighted tokens of a task inside the periods. Null: not known.
type KnownPeriods = Readonly<Record<Provider, Readonly<Record<PeriodName, number | null>>>>;

// The tokens of a finished task inside the periods when its window is gone. The
// history keeps the totals only. A period that began when the task was already over
// holds none of its tokens: 0. For any other period the tokens are not known.
function periodsOfGoneWindow(end: number, slots: PeriodSlots): KnownPeriods {
  const of = (provider: Provider): Readonly<Record<PeriodName, number | null>> => {
    const known = (period: PeriodName): number | null => (end <= slots[provider][period].from * SLOT_MS ? 0 : null);
    return { today: known("today"), week: known("week"), month: known("month") };
  };
  return { claude: of("claude"), codex: of("codex") };
}

// The week percent of a share is worked out in refreshShares: it needs the
// seven day percent, which the status command reads again.
function sharesJson(
  totals: SubscriptionTotals,
  calibrations: Readonly<Record<Provider, Calibration>>,
  periods: KnownPeriods,
): ShareJson[] {
  return taskShares(totals, calibrations)
    .filter((share) => share.shown)
    .map((share) => ({
      subscription: share.provider,
      weighted: share.weighted,
      raw: share.raw,
      pct: share.share.ready ? share.share.pct : null,
      today_weighted: periods[share.provider].today,
      week_weighted: periods[share.provider].week,
      month_weighted: periods[share.provider].month,
      week_pct: null,
    }));
}

export function estimateJson(item: SignalEstimate): EstimateJson {
  if (item.basis === "none") {
    return { key: item.key, subscription: item.subscription, basis: "none", basis_name: item.basisName };
  }
  return {
    key: item.key,
    subscription: item.subscription,
    basis: item.rough ? "wide" : item.basis,
    basis_name: item.basisName,
    low_pct: item.lowPct,
    high_pct: item.open ? null : item.highPct,
    raw_low: item.rawLow,
    raw_high: item.open ? null : item.rawHigh,
    count: item.count,
    typical_pct: item.typicalPct,
    budget_pct: item.budgetPct,
    basis_project: item.basisProject ?? null,
  };
}

export interface BuildInput {
  readonly nowMs: number;
  readonly analysis: Analysis;
  readonly collectState: CollectState;
  readonly progressPct: number;
  readonly roots: { readonly claude: RootState; readonly codex: RootState };
  // The usage of every known window, split against every other known window.
  readonly usage: readonly WindowUsage[];
  readonly history: readonly TaskEntry[];
  readonly openItems: readonly OpenItem[];
  readonly pool: PoolConfig;
  // The estimate log as collect read it. A damaged log gives no self-check.
  readonly estimateLog: { readonly lines: readonly EstimateLogLine[]; readonly damaged: boolean };
}

export interface BuiltStatus {
  readonly data: StatusData;
  // The lines for the estimate log. The caller appends them after the snapshot is written.
  readonly logLines: readonly EstimateLogLine[];
}

function calibrationsOfAnalysis(analysis: Analysis): Readonly<Record<Provider, Calibration>> {
  const find = (provider: Provider): Calibration =>
    analysis.subscriptions.find((s) => s.provider === provider)?.calibration ?? {
      ready: false,
      label: NOT_READY_LABEL,
    };
  return { claude: find("claude"), codex: find("codex") };
}

function tasksJson(input: BuildInput, calibrations: Readonly<Record<Provider, Calibration>>): TaskJson[] {
  const open = input.usage
    .filter((usage) => usage.window.end === null)
    .sort((a, b) => b.window.start - a.window.start)
    .slice(0, STATUS_OPEN_TASKS)
    .map((usage): TaskJson => ({
      label: usage.window.label,
      tags: usage.window.tags,
      open: true,
      start: usage.window.start,
      end: null,
      shared: usage.shared,
      shares: sharesJson(usage.totals, calibrations, usage.periods),
      pool_pct: null,
    }));
  // The history keeps the totals only. The tokens of a finished task inside the
  // periods come from its window, while the window is still known. A sync drops the
  // windows that it does not send again, so a window can be gone while its task ended
  // inside a period: then those tokens are not known (see periodsOfGoneWindow).
  const windows = new Map(input.usage.map((usage) => [windowId(usage.window.label, usage.window.start), usage] as const));
  const slots = periodSlots(input.analysis);
  const finished = [...input.history]
    .sort((a, b) => b.end - a.end)
    .slice(0, STATUS_FINISHED_TASKS)
    .map((entry): TaskJson => ({
      label: entry.label,
      tags: entry.tags,
      open: false,
      start: entry.start,
      end: entry.end,
      shared: entry.shared,
      shares: sharesJson(
        entry.totals,
        calibrations,
        windows.get(windowId(entry.label, entry.start))?.periods ?? periodsOfGoneWindow(entry.end, slots),
      ),
      pool_pct: null,
    }));
  return [...open, ...finished];
}

// ---------------------------------------------------------------------------
// Week shares and the pool
// ---------------------------------------------------------------------------

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

// The seven day reading of a subscription, while its week has not ended at
// `nowMs`. The snapshot keeps the reading that collect saw: after its reset time
// the percent belongs to a week that is over.
function currentSevenDay(sub: SubscriptionJson | undefined, nowMs: number): QuotaPointJson | null {
  const reading = sub?.quota.seven_day ?? null;
  return reading !== null && reading.resets_at > nowMs ? reading : null;
}

function sevenDayPct(subscriptions: readonly SubscriptionJson[], id: Provider, nowMs: number): number | null {
  return currentSevenDay(subscriptions.find((sub) => sub.id === id), nowMs)?.pct ?? null;
}

// The part of the subscription's week that the task used, as a part of the seven
// day percent: tokens of the task / tokens of the week x percent. Rounding can
// put the tokens of one task a little over the tokens of the week, so the part
// stops at 1. Then the result is never more than the seven day percent.
// The percent and the tokens of the week must be of the same reset period: a new
// reading can come after the snapshot, with a week that its tokens do not cover yet.
function weekPctOf(share: ShareJson, subscriptions: readonly SubscriptionJson[], nowMs: number): number | null {
  const taskTokens = share.week_weighted;
  if (taskTokens === null || !Number.isFinite(taskTokens)) return null;
  const sub = subscriptions.find((entry) => entry.id === share.subscription);
  const reading = currentSevenDay(sub, nowMs);
  if (sub === undefined || reading === null) return null;
  if (Math.abs(reading.resets_at - sub.week.end) > RESET_TOLERANCE_MS) return null;
  const weekTotal = sub.tokens.week.weighted;
  if (!(weekTotal > 0)) return null;
  return Math.min(Math.max(taskTokens, 0) / weekTotal, 1) * reading.pct;
}

function poolJson(subscriptions: readonly SubscriptionJson[], pool: PoolConfig, nowMs: number): PoolJson {
  if (pool.mode === "separate") return { mode: "separate" };
  const claude = sevenDayPct(subscriptions, "claude", nowMs);
  const codex = sevenDayPct(subscriptions, "codex", nowMs);
  const used = claude === null || codex === null ? null : pool.weights.claude * claude + pool.weights.codex * codex;
  return { mode: "combined", weights: { claude: pool.weights.claude, codex: pool.weights.codex }, used_pct: used };
}

function poolPctOf(shares: readonly ShareJson[], pool: PoolConfig): number | null {
  if (pool.mode === "separate") return null;
  let sum = 0;
  for (const share of shares) {
    if (share.week_pct === null) return null;
    sum += pool.weights[share.subscription] * share.week_pct;
  }
  return sum;
}

const NO_COSTS = { typical_pct: null, budget_pct: null } as const;

// The typical and the budget cost of a row, or null for both unless the four
// values are finite numbers in the order low <= typical <= budget <= high and the
// typical cost is above 0.
function typicalBudgetOf(
  low: unknown,
  typical: unknown,
  budget: unknown,
  high: unknown,
): { typical_pct: number | null; budget_pct: number | null } {
  const valid =
    typeof low === "number" &&
    typeof typical === "number" &&
    typeof budget === "number" &&
    typeof high === "number" &&
    Number.isFinite(low) &&
    Number.isFinite(typical) &&
    Number.isFinite(budget) &&
    Number.isFinite(high) &&
    typical > 0 &&
    low <= typical &&
    typical <= budget &&
    budget <= high;
  return valid ? { typical_pct: typical, budget_pct: budget } : NO_COSTS;
}

// Fields from later builds read as null when absent. A name that is not text
// or a project that is not a label reads as null. Typical and budget costs read
// as null when invalid, outside the range, or part of an open range.
function withLaterFields(item: EstimateJson): EstimateJson {
  const basisName: unknown = item.basis_name;
  const name = typeof basisName === "string" ? basisName : null;
  if (item.basis === "none") return { key: item.key, subscription: item.subscription, basis: "none", basis_name: name };
  const costs = item.high_pct === null ? NO_COSTS : typicalBudgetOf(item.low_pct, item.typical_pct, item.budget_pct, item.high_pct);
  return {
    key: item.key,
    subscription: item.subscription,
    basis: item.basis,
    basis_name: name,
    low_pct: item.low_pct,
    high_pct: item.high_pct,
    raw_low: item.raw_low ?? null,
    raw_high: item.raw_high ?? null,
    count: item.count,
    typical_pct: costs.typical_pct,
    budget_pct: costs.budget_pct,
    basis_project: isLabel(item.basis_project) ? item.basis_project : null,
  };
}

function isShareOfOne(value: unknown): value is number {
  return typeof value === "number" && value >= 0 && value <= 1;
}

function isFactor(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1;
}

function isBias(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

type CheckNumbers = Pick<StageCheckJson, "hit_rate" | "error_factor" | "bias" | "band_low" | "band_high" | "width" | "useful_rate">;

// The seven numbers of a check, each null or a number that passes its guard, or
// null for the whole when one does not. An absent value (undefined) is not
// accepted here. The two ends of the band are both null or both numbers. A useful
// rate is part of the hits, so it needs a hit rate and is not above it.
function checkNumbersOf(
  hitRate: unknown,
  errorFactor: unknown,
  bias: unknown,
  bandLow: unknown,
  bandHigh: unknown,
  width: unknown,
  usefulRate: unknown,
): CheckNumbers | null {
  if (!(hitRate === null || isShareOfOne(hitRate))) return null;
  if (!(errorFactor === null || isFactor(errorFactor))) return null;
  if (!(bias === null || isBias(bias))) return null;
  const bandOk = (bandLow === null && bandHigh === null) || (isShareOfOne(bandLow) && isShareOfOne(bandHigh) && bandLow <= bandHigh);
  if (!bandOk) return null;
  if (!(width === null || isFactor(width))) return null;
  if (!(usefulRate === null || (isShareOfOne(usefulRate) && hitRate !== null && usefulRate <= hitRate))) return null;
  return { hit_rate: hitRate, error_factor: errorFactor, bias, band_low: bandLow, band_high: bandHigh, width, useful_rate: usefulRate };
}

// The band depends on the task count only: it is null or the band of `count`.
function bandMatchesCount(count: number, numbers: CheckNumbers): boolean {
  if (numbers.band_low === null) return true;
  const band = hitRateBand(count);
  return band !== null && numbers.band_low === band.low && numbers.band_high === band.high;
}

// A check shows no number when its task count is not known or is under
// SELF_CHECK_MIN_SCORED, and from there its band is the band of its count.
function numbersMatchCount(count: number | null, numbers: CheckNumbers): boolean {
  if (count === null || count < SELF_CHECK_MIN_SCORED) return Object.values(numbers).every((value) => value === null);
  return bandMatchesCount(count, numbers);
}

// A stage of a snapshot: the first six fields are there (width and useful_rate
// read as null when a snapshot from an older build has none), and `n` is a task
// count of the self-check.
function stageCheckOf(value: unknown): StageCheckJson | null {
  const row = asRow(value);
  if (row === null) return null;
  const { n } = row;
  if (!(typeof n === "number" && Number.isSafeInteger(n) && n >= 0 && n <= SELF_CHECK_TASKS)) return null;
  const numbers = checkNumbersOf(
    row["hit_rate"],
    row["error_factor"],
    row["bias"],
    row["band_low"],
    row["band_high"],
    row["width"] ?? null,
    row["useful_rate"] ?? null,
  );
  return numbers !== null && numbersMatchCount(n, numbers) ? { n, ...numbers } : null;
}

// Rebuild the map from its entries so all labels remain own data keys.
function checkMapOf(value: unknown, maxEntries: number): Readonly<Record<string, StageCheckJson>> | null {
  const row = asRow(value);
  if (row === null) return null;
  const entries = Object.entries(row);
  if (entries.length > maxEntries) return null;
  const checked: (readonly [string, StageCheckJson])[] = [];
  for (const [label, entry] of entries) {
    const stage = stageCheckOf(entry);
    if (!isLabel(label) || stage === null) return null;
    checked.push([label, stage]);
  }
  return Object.fromEntries(checked);
}

// The self-check of a snapshot. A snapshot from an older build has none, and an
// object with a wrong field reads as null: neither makes the snapshot corrupt.
// Fields from later builds read as null when absent. A bad map reads as null
// and keeps the rest of the check. With no task count, projects reads as null.
// In that case, a non-null number or stages value still invalidates the check.
function selfCheckOf(value: unknown): SelfCheckJson | null {
  const row = asRow(value);
  if (row === null) return null;
  const { n } = row;
  if (!(n === null || isCountValue(n))) return null;
  const numbers = checkNumbersOf(
    row["hit_rate"],
    row["error_factor"],
    row["bias"] ?? null,
    row["band_low"] ?? null,
    row["band_high"] ?? null,
    row["width"] ?? null,
    row["useful_rate"] ?? null,
  );
  if (numbers === null || !numbersMatchCount(n, numbers)) return null;
  if (n === null && (row["stages"] ?? null) !== null) return null;
  return {
    n, ...numbers,
    stages: checkMapOf(row["stages"], MAX_STAGES),
    projects: n === null ? null : checkMapOf(row["projects"], MAX_PROJECTS),
  };
}

const NO_QUEUE_SUMS = {
  expected_pct: null,
  low_pct: null,
  high_pct: null,
  likely_low_pct: null,
  likely_high_pct: null,
  spent_pct: null,
} as const;

function isQueueSum(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// The queue of a snapshot, or null when it is absent (a snapshot from an older
// build) or not valid. Each field is read by name. The count is a whole number from
// 0 to SYNC_MAX_OPEN_ITEMS. The six sums are all null, or all finite numbers of 0
// or more with low <= likely_low <= likely_high <= high. Anything else makes the
// whole object null.
function queueOf(value: unknown): QueueJson | null {
  const row = asRow(value);
  if (row === null) return null;
  const { count } = row;
  if (!(typeof count === "number" && Number.isSafeInteger(count) && count >= 0 && count <= SYNC_MAX_OPEN_ITEMS)) return null;
  const expected = row["expected_pct"];
  const low = row["low_pct"];
  const likelyLow = row["likely_low_pct"];
  const likelyHigh = row["likely_high_pct"];
  const high = row["high_pct"];
  const spent = row["spent_pct"];
  if ([expected, low, likelyLow, likelyHigh, high, spent].every((sum) => sum === null)) return { count, ...NO_QUEUE_SUMS };
  if (!(isQueueSum(expected) && isQueueSum(low) && isQueueSum(likelyLow) && isQueueSum(likelyHigh) && isQueueSum(high) && isQueueSum(spent))) return null;
  if (!(low <= likelyLow && likelyLow <= likelyHigh && likelyHigh <= high)) return null;
  return { count, expected_pct: expected, low_pct: low, high_pct: high, likely_low_pct: likelyLow, likely_high_pct: likelyHigh, spent_pct: spent };
}

function queueJson(queue: QueueSum | null): QueueJson | null {
  if (queue === null) return null;
  const { count, sums } = queue;
  if (sums === null) return { count, ...NO_QUEUE_SUMS };
  return {
    count,
    expected_pct: sums.expectedPct,
    low_pct: sums.lowPct,
    high_pct: sums.highPct,
    likely_low_pct: sums.likelyLowPct,
    likely_high_pct: sums.likelyHighPct,
    spent_pct: sums.spentPct,
  };
}

// The tokens of a task inside a period: null stays null (not known).
function periodTokens(value: number | null): number | null {
  return value === null ? null : finiteOrZero(value);
}

// Works the week percent of every share, the pool and the pool percent of every
// task out again from the data, at the time `nowMs`: the seven day percents may be
// newer than the snapshot, or over. A snapshot from an older build has no tokens
// for the periods: they read as 0 and the week percent as unknown, until the next collect.
export function refreshShares(data: StatusData, pool: PoolConfig, nowMs: number): StatusData {
  const tasks = data.tasks.map((task): TaskJson => {
    const shares = task.shares.map(
      (share): ShareJson => ({
        subscription: share.subscription,
        weighted: share.weighted,
        raw: finiteOrZero(share.raw),
        pct: share.pct,
        today_weighted: periodTokens(share.today_weighted),
        week_weighted: periodTokens(share.week_weighted),
        month_weighted: periodTokens(share.month_weighted),
        week_pct: weekPctOf(share, data.subscriptions, nowMs),
      }),
    );
    return {
      label: task.label,
      tags: task.tags,
      open: task.open,
      start: task.start,
      end: task.end,
      shared: task.shared,
      shares,
      pool_pct: poolPctOf(shares, pool),
    };
  });
  return {
    ...data,
    tasks,
    estimates: data.estimates.map(withLaterFields),
    self_check: selfCheckOf(data.self_check),
    pool: poolJson(data.subscriptions, pool, nowMs),
    queue: queueOf(data.queue),
  };
}

// The subscription that the snapshot estimates are for.
const ESTIMATE_SUBSCRIPTION: Provider = "claude";

// The open items, each with the weighted tokens that its running window has used
// so far. The window carries the key of the item as its label. An item with no
// open window has no cost so far. Several open windows with one label give the
// largest: each of them is a task of its own in the history.
function withCostSoFar(items: readonly OpenItem[], usage: readonly WindowUsage[]): readonly EstimateItem[] {
  const spentBy = new Map<string, number>();
  for (const { window, totals } of usage) {
    if (window.end !== null) continue;
    spentBy.set(window.label, Math.max(spentBy.get(window.label) ?? 0, totals[ESTIMATE_SUBSCRIPTION].weighted));
  }
  return items.map((item): EstimateItem => {
    const spent = spentBy.get(item.key);
    return spent === undefined ? item : { ...item, spent };
  });
}

const UNREADABLE_SELF_CHECK: SelfCheckJson = {
  n: null,
  hit_rate: null,
  error_factor: null,
  bias: null,
  band_low: null,
  band_high: null,
  width: null,
  useful_rate: null,
  stages: null,
  projects: null,
};

function stageCheckJson(check: StageCheck): StageCheckJson {
  return {
    n: check.scored,
    hit_rate: check.hitRate,
    error_factor: check.errorFactor,
    bias: check.bias,
    band_low: check.bandLow,
    band_high: check.bandHigh,
    width: check.width,
    useful_rate: check.usefulRate,
  };
}

// The stages are in text order in the map, and so in the object. A label is a
// key of the new object only, never a property that is set by name.
function checkMapJson(checks: ReadonlyMap<string, StageCheck>): Readonly<Record<string, StageCheckJson>> {
  return Object.fromEntries([...checks].map(([label, check]) => [label, stageCheckJson(check)]));
}

function selfCheckJson(check: SelfCheck): SelfCheckJson {
  return { ...stageCheckJson(check), stages: checkMapJson(check.stages), projects: checkMapJson(check.projects) };
}

export function buildStatus(input: BuildInput): BuiltStatus {
  const { analysis } = input;
  const calibrations = calibrationsOfAnalysis(analysis);
  const items = withCostSoFar(input.openItems, input.usage);
  const estimates = estimateFromSignals(items, input.history, calibrations, ESTIMATE_SUBSCRIPTION);
  const check = input.estimateLog.damaged ? null : selfCheck(input.estimateLog.lines, input.history, ESTIMATE_SUBSCRIPTION);
  const subscriptions = PROVIDERS.map((provider) => {
    const usage = analysis.subscriptions.find((s) => s.provider === provider);
    return usage === undefined ? null : subscriptionJson(usage, input.roots[provider]);
  }).filter((entry): entry is SubscriptionJson => entry !== null);
  const codex = analysis.subscriptions.find((sub) => sub.provider === "codex")?.tokens;
  const data: StatusData = {
    version: STORE_VERSION,
    written_at: input.nowMs,
    collect: { at: input.nowMs, state: input.collectState, progress_pct: input.progressPct },
    subscriptions,
    models: analysis.models.slice(0, SNAPSHOT_MAX_MODELS).map(
      (model): ModelJson => ({
        name: model.name,
        subscription: model.provider,
        today: tokensJson(model.tokens.today, model.provider),
        week: tokensJson(model.tokens.week, model.provider),
        month: tokensJson(model.tokens.month, model.provider),
      }),
    ),
    tasks: tasksJson(input, calibrations),
    estimates: estimates.map(estimateJson),
    self_check: check === null ? UNREADABLE_SELF_CHECK : selfCheckJson(check),
    pool: { mode: "separate" },
    queue: queueJson(queueSum(items, input.history, calibrations, ESTIMATE_SUBSCRIPTION)),
    codex_raw: {
      today: codex === undefined ? 0 : rawTokens(codex.today),
      week: codex === undefined ? 0 : rawTokens(codex.week),
      month: codex === undefined ? 0 : rawTokens(codex.month),
      utc_days: Object.fromEntries([...analysis.codexUtcDays].sort(([a], [b]) => compareText(a, b))),
    },
  };
  return {
    data: refreshShares(data, input.pool, input.nowMs),
    logLines: newLogLines(items, estimates, input.estimateLog.lines, input.nowMs),
  };
}

// The progress of the scan in whole percent. Nothing to read counts as done.
export function progressPercent(totalBytes: number, backlogBytes: number): number {
  if (totalBytes <= 0 || backlogBytes <= 0) return PERCENT_FULL;
  return Math.max(0, Math.min(PERCENT_FULL, Math.floor(PERCENT_FULL * (1 - backlogBytes / totalBytes))));
}

// ---------------------------------------------------------------------------
// Reading the status
// ---------------------------------------------------------------------------

function readingJson(reading: LatestQuota["five_hour"]): QuotaPointJson | null {
  return reading.known ? { pct: reading.usedPercent, resets_at: reading.resetsAt, at: reading.at } : null;
}

function readingReason(reading: LatestQuota["five_hour"]): UnknownReason | null {
  return reading.known ? null : reading.reason;
}

// The Claude quota of quota-latest.json, as the status JSON shows it.
export function claudeQuotaJson(latest: LatestQuota): QuotaJson {
  const five = readingJson(latest.five_hour);
  const week = readingJson(latest.week);
  return {
    five_hour: five,
    seven_day: week,
    source: five === null && week === null ? "none" : "record",
    unknown: { five_hour: readingReason(latest.five_hour), seven_day: readingReason(latest.week) },
  };
}

// The Claude subscription takes the quota of the latest file. The forecast is
// worked out again from its week reading: arithmetic only. So are the week
// percents of the shares and the pool, which depend on the seven day percents.
export function overlayClaudeQuota(data: StatusData, latest: LatestQuota, pool: PoolConfig, nowMs: number): StatusData {
  const week = latest.week;
  const forecast = week.known
    ? forecastFrom({ usedPercent: week.usedPercent, resetsAt: week.resetsAt, at: week.at })
    : null;
  return refreshShares(
    {
      ...data,
      subscriptions: data.subscriptions.map((sub) =>
        sub.id === "claude"
          ? { ...sub, quota: claudeQuotaJson(latest), forecast: forecast === null ? null : forecastJson(forecast) }
          : sub,
      ),
    },
    pool,
    nowMs,
  );
}

const CODEX_UTC_DAYS_MAX = 64;

type CodexRaw = Omit<CodexRawJson, "utc_days"> & { readonly utc_days: ReadonlyMap<string, number> };

function isRawCount(value: unknown): value is number {
  return isNumber(value) && value >= 0;
}

function codexRawOf(value: unknown): CodexRaw | null {
  const row = asRow(value);
  if (row === null) return null;
  const { today, week, month, utc_days } = row;
  const days = asRow(utc_days);
  if (!isRawCount(today) || !isRawCount(week) || !isRawCount(month) || days === null) return null;
  const entries = Object.entries(days);
  if (entries.length > CODEX_UTC_DAYS_MAX) return null;
  const parsed = new Map<string, number>();
  for (const [date, count] of entries) {
    if (!isDateName(date) || !isRawCount(count)) return null;
    parsed.set(date, count);
  }
  return { today, week, month, utc_days: parsed };
}

interface MergedSum {
  readonly total: number;
  readonly logs: boolean;
}

function periodTotal(columns: TokenColumnsJson, merged: MergedSum | null, raw: number | null): PeriodTotalJson {
  if (merged !== null) return { ...columns, total: merged.total, source: merged.logs ? "mixed" : "account" };
  if (raw !== null) return { ...columns, total: raw, source: "logs" };
  const values = [columns?.input, columns?.cache_write, columns?.cache_write_1h, columns?.cache_read, columns?.output];
  const total = values.reduce<number>((sum, value) => sum + finiteOrZero(value ?? 0), 0);
  return { ...columns, total: finiteOrZero(total), source: "logs" };
}

// Round each half-open week edge up to the first bucket midpoint at or after it.
function midpointDateAtOrAfter(ms: number): string | null {
  const date = new Date(Math.ceil((ms - DAY_MS / 2) / DAY_MS) * DAY_MS);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null;
}

// Account rows own their dates, even when a row reports zero tokens.
function mergedSum(
  account: AccountUsage, local: ReadonlyMap<string, number>, from: string, until: string,
): MergedSum | null {
  if (account.rows.length > ACCOUNT_MAX_ROWS || from >= until) return null;
  const accountDates = new Set<string>();
  let total = 0;
  for (const [date, count] of account.rows) {
    if (date < from || date >= until) continue;
    accountDates.add(date);
    total += count;
  }
  if (accountDates.size === 0) return null;
  let logs = false;
  for (const [date, count] of local) {
    if (date < from || date >= until || count <= 0 || accountDates.has(date)) continue;
    total += count;
    logs = true;
  }
  return { total: finiteOrZero(total), logs };
}

function weekMergedSum(
  account: AccountUsage, local: ReadonlyMap<string, number>, week: SubscriptionJson["week"], nowMs: number, tomorrow: string,
): MergedSum | null {
  const { start, end } = currentWeek(week.kind === "reset" ? week : null, nowMs);
  const from = midpointDateAtOrAfter(start);
  const until = midpointDateAtOrAfter(end);
  return from === null || until === null ? null : mergedSum(account, local, from, until < tomorrow ? until : tomorrow);
}

// Add output fields after the quota overlay. The snapshot and its weighted
// columns, shares, forecasts and windows still describe the local logs.
export function overlayCodexAccount(
  data: StatusData, account: AccountUsage | null, zone: Zone, nowMs: number,
): StatusOutputData {
  const { codex_raw, ...output } = data;
  const codexRaw = codexRawOf(codex_raw);
  const fresh = account !== null && isFreshAccount(account.at, nowMs) ? account : null;
  return {
    ...output,
    subscriptions: data.subscriptions.map((sub) => {
      const usage = sub.id === "codex" ? fresh : null;
      const raw = sub.id === "codex" ? codexRaw : null;
      const through = usage?.rows.at(-1)?.[0];
      const details = usage !== null && through !== undefined ? { at: usage.at, through } : null;
      let week = null;
      let month = null;
      if (usage !== null && details !== null && raw !== null) {
        const tomorrow = shiftDate(new Date(nowMs).toISOString().slice(0, 10), 1);
        week = weekMergedSum(usage, raw.utc_days, sub.week, nowMs, tomorrow);
        const first = monthStartDate(localDateOf(zone, nowMs));
        const next = nextMonthStartDate(first);
        month = mergedSum(usage, raw.utc_days, first, next < tomorrow ? next : tomorrow);
      }
      return {
        ...sub,
        label: week !== null || month !== null ? "Codex (account)" : sub.label,
        tokens: {
          today: periodTotal(sub.tokens.today, null, raw?.today ?? null),
          week: periodTotal(sub.tokens.week, week, raw?.week ?? null),
          month: periodTotal(sub.tokens.month, month, raw?.month ?? null),
        },
        account: details,
      };
    }),
  };
}

// The status keeps the busiest models only.
export function withTopModels(data: StatusData): StatusData {
  return { ...data, models: data.models.slice(0, STATUS_TOP_MODELS) };
}

// The calibrations of the snapshot, for the estimate command.
export function calibrationsOf(data: StatusData): Readonly<Record<Provider, Calibration>> {
  const find = (provider: Provider): Calibration => {
    const json = data.subscriptions.find((s) => s.id === provider)?.calibration ?? null;
    if (json === null) return { ready: false, label: NOT_READY_LABEL };
    return {
      ready: true,
      perPctWeighted: json.per_pct_weighted,
      confidence: json.confidence,
      intervals: json.intervals,
      label: json.label,
    };
  };
  return { claude: find("claude"), codex: find("codex") };
}

// ---------------------------------------------------------------------------
// Counters for the doctor
// ---------------------------------------------------------------------------

const COUNTER_FIELDS = [
  "files",
  "files_read",
  "bytes_read",
  "total_bytes",
  "backlog_bytes",
  "counted",
  "repeats",
  "replaced",
  "moved",
  "before_horizon",
  "bad_json",
  "not_object",
  "skipped_long",
  "skipped_links",
  "unreadable",
  "capped_folders",
  "pruned_files",
  "bucket_underflow",
  "files_written",
  "codex_quota_appended",
  "codex_quota_skipped",
  "codex_quota_full",
  "tasks_frozen",
  "tasks_total",
  "features_refused",
  "codex_cache_invalid",
  "estimate_log_damaged",
  "estimate_log_at_cap",
] as const;

type CounterField = (typeof COUNTER_FIELDS)[number];

// Numbers and fixed codes only: no path, no name and no text from a source.
export type Counters = { readonly [F in CounterField]: number } & {
  readonly stopped_by: CollectReport["stoppedBy"];
  readonly roots: { readonly claude: RootState; readonly codex: RootState };
  // Skipped rows by reason code.
  readonly skipped: Readonly<Record<string, number>>;
};

export interface CounterInput {
  readonly report: CollectReport;
  readonly quota: QuotaWriteReport;
  readonly freeze: FreezeReport;
  // The count of bad features in the stored windows, items and finished tasks.
  readonly featuresRefused: number;
  // What the read of the estimate log found: the month files that were not safe to
  // read, and the month files at the cap.
  readonly estimateLog: { readonly damaged: number; readonly atCap: number };
}

export function countersOf({ report, quota, freeze, featuresRefused, estimateLog }: CounterInput): Counters {
  const skipped = Object.entries(report.rows.skipped)
    .filter(([code]) => SKIP_CODE.test(code))
    .slice(0, MAX_SKIP_CODES);
  return {
    stopped_by: report.stoppedBy,
    roots: report.roots,
    skipped: Object.fromEntries(skipped),
    files: report.files,
    files_read: report.filesRead,
    bytes_read: report.bytesRead,
    total_bytes: report.totalBytes,
    backlog_bytes: report.backlogBytes,
    counted: report.rows.counted,
    repeats: report.rows.repeats,
    replaced: report.rows.replaced,
    moved: report.rows.moved,
    before_horizon: report.rows.beforeHorizon,
    bad_json: report.rows.badJson,
    not_object: report.rows.notObject,
    skipped_long: report.rows.skippedLong,
    skipped_links: report.skippedLinks,
    unreadable: report.unreadable,
    capped_folders: report.cappedFolders,
    pruned_files: report.prunedFiles,
    bucket_underflow: report.bucketUnderflow,
    files_written: report.filesWritten,
    codex_quota_appended: quota.appended,
    codex_quota_skipped: quota.skipped,
    codex_quota_full: quota.full,
    tasks_frozen: freeze.frozen,
    tasks_total: freeze.total,
    features_refused: featuresRefused,
    codex_cache_invalid: report.rows.codexCacheInvalid,
    estimate_log_damaged: estimateLog.damaged,
    estimate_log_at_cap: estimateLog.atCap,
  };
}

// ---------------------------------------------------------------------------
// The snapshot file
// ---------------------------------------------------------------------------

// The only stop that collect records. A store that a newer tokenmeter wrote is
// refused with no write at all: the newer tokenmeter writes a snapshot that this
// one reads as store_newer.
export type StopCode = "store_corrupt";

export interface Snapshot {
  readonly stopped: StopCode | null;
  readonly data: StatusData | null;
  readonly report: Counters | null;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isCountValue(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPointOrNull(value: unknown): boolean {
  if (value === null) return true;
  const row = asRow(value);
  return row !== null && isNumber(row["pct"]) && isNumber(row["resets_at"]) && isNumber(row["at"]);
}

function isSubscription(value: unknown, id: Provider): boolean {
  const row = asRow(value);
  if (row === null || row["id"] !== id) return false;
  const quota = asRow(row["quota"]);
  const week = asRow(row["week"]);
  const weekTokens = asRow(asRow(row["tokens"])?.["week"]);
  if (quota === null || week === null || weekTokens === null || !isNumber(weekTokens["weighted"])) return false;
  if (!isPointOrNull(quota["five_hour"]) || !isPointOrNull(quota["seven_day"]) || asRow(quota["unknown"]) === null) {
    return false;
  }
  return isNumber(week["start"]) && isNumber(week["end"]);
}

function isShare(value: unknown): boolean {
  const row = asRow(value);
  return row !== null && PROVIDERS.includes(row["subscription"] as Provider);
}

function isTask(value: unknown): boolean {
  const row = asRow(value);
  const shares = row?.["shares"];
  return Array.isArray(shares) && shares.every(isShare);
}

// The parts that the overlay and the reads depend on are checked; the rest is
// checked for its kind. The file is private to this user and written here.
function isStatusData(value: unknown): value is StatusData {
  const row = asRow(value);
  if (row === null || row["version"] !== STORE_VERSION || !isNumber(row["written_at"])) return false;
  const collect = asRow(row["collect"]);
  if (collect === null || !isNumber(collect["at"]) || !isNumber(collect["progress_pct"])) return false;
  if (!COLLECT_STATES.includes(String(collect["state"]))) return false;
  const subscriptions = row["subscriptions"];
  if (!Array.isArray(subscriptions) || subscriptions.length !== PROVIDERS.length) return false;
  if (!isSubscription(subscriptions[0], "claude") || !isSubscription(subscriptions[1], "codex")) return false;
  const { models, tasks, estimates } = row;
  return (
    Array.isArray(models) &&
    Array.isArray(tasks) &&
    tasks.every(isTask) &&
    Array.isArray(estimates) &&
    estimates.every((item) => asRow(item) !== null)
  );
}

function isCounters(value: unknown): value is Counters {
  const row = asRow(value);
  if (row === null || !COUNTER_FIELDS.every((field) => isCountValue(row[field]))) return false;
  if (!STOPPED_BY.includes(String(row["stopped_by"]))) return false;
  const roots = asRow(row["roots"]);
  if (roots === null || !ROOT_STATES.includes(String(roots["claude"])) || !ROOT_STATES.includes(String(roots["codex"]))) {
    return false;
  }
  const skipped = asRow(row["skipped"]);
  if (skipped === null) return false;
  const codes = Object.keys(skipped);
  return codes.length <= MAX_SKIP_CODES && codes.every((code) => SKIP_CODE.test(code) && isCountValue(skipped[code]));
}

// The counters that a build added after the snapshot format first shipped. A
// snapshot from an older build lacks them and reads them as 0; a value of the
// wrong type, or below 0, is still refused.
const COUNTERS_ADDED_LATER: readonly CounterField[] = [
  "codex_quota_full",
  "features_refused",
  "codex_cache_invalid",
  "estimate_log_damaged",
  "estimate_log_at_cap",
];

function readCounters(value: unknown): Counters | null {
  const row = asRow(value);
  if (row === null) return null;
  const filled: Record<string, unknown> = { ...row };
  for (const field of COUNTERS_ADDED_LATER) {
    if (!(field in filled)) filled[field] = 0;
  }
  return isCounters(filled) ? filled : null;
}

// A missing file is null. A file that cannot be read, has the wrong shape or
// holds both data and a stop gives store_corrupt; a newer version, store_newer.
// Only a plain snapshot or a stop is valid.
export function readSnapshot(dataDir: string, deps: FsDeps = defaultDeps()): Result<Snapshot | null, StoreError> {
  const read = readJson(dataDir, STATUS_FILE, FILE_CAPS.status, deps);
  if (!read.ok) return read;
  if (read.value === undefined) return ok(null);
  const body = openVersioned(STATUS_FILE, read.value);
  if (!body.ok) return body;
  const stopped = body.value["stopped"];
  const { data, report } = body.value;
  if (stopped === "store_corrupt") {
    return data === null && report === null ? ok({ stopped, data: null, report: null }) : failure("store_corrupt", STATUS_FILE);
  }
  const counters = readCounters(report);
  if (stopped !== null || !isStatusData(data) || counters === null) return failure("store_corrupt", STATUS_FILE);
  return ok({ stopped: null, data, report: counters });
}

export function writeSnapshot(dataDir: string, snapshot: Snapshot, deps: FsDeps = defaultDeps()): Result<null, StoreError> {
  const text = JSON.stringify({ version: STORE_VERSION, ...snapshot });
  if (Buffer.byteLength(text, "utf8") > FILE_CAPS.status) return failure("internal_error", STATUS_FILE);
  const wrote = writeAtomic(join(dataDir, STATUS_FILE), text, deps);
  return wrote.ok ? ok(null) : failure("internal_error", STATUS_FILE);
}
