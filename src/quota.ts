// Quota samples (plan 3.8, section 6).
//
//   quota-YYYY-MM.jsonl   one sample per line, in the UTC month of the sample
//   quota-latest.json     { version, claude: { five_hour, week }, codex?: { five_hour, week } }
//
// A sample line is {"p","w","at","pct","reset"}: provider, window, sample time,
// used percent and reset time, the times in epoch milliseconds. Nothing else
// from the statusline JSON or from a rollout is stored: only these numbers.
//
// The Claude writer (record) appends a line only when the percent or the reset
// time changed, and rewrites the latest file on a change or when its time is 60 s
// old. Both Codex sources use the same append path and skip a sample whose
// percent and reset time are already in the file, whatever its sample time.
// A month file stops growing at 1 MiB.
//
// The latest file holds the time each window was last seen. Codex windows also
// hold their source and reached flag. A repeat adds no line to the month file.
// Each writer keeps the other provider's section. The forecast uses the time
// of the last repeat (see readObservations).
//
// A window that the statusline did not carry, or carried with a bad percent or a
// bad reset time, is stored as a reason code: absent, bad_percent or bad_reset.
// A stored value whose period is still open is kept instead. A percent only
// grows inside one reset period: a lower percent with the same reset time (a
// second session that is a step behind) does not replace the stored one.
//
// The readers check owner, mode, a byte cap and the ranges. Anything else reads
// as unknown, with a reason code; the display shows "?".
//
// Latest sample of a Codex or Claude window: a restamped copy in a Codex child
// rollout can give a later sample with an older percent. So the readers do not
// take the sample with the latest time. See pickLatestSample.

import { join } from "node:path";
import {
  EARLIEST_TIME_MS,
  FUTURE_SLACK_MS,
  type QuotaPoint,
  type Result,
  STORE_VERSION,
  asRow,
  checkQuotaPoint,
  err,
  ok,
  parseJson,
  quotaPoint,
} from "./core.ts";
import {
  type FsDeps,
  type FsError,
  appendLine,
  defaultDeps,
  lstatEntry,
  readOwnFile,
  writeAtomic,
} from "./fsafe.ts";
import type { CodexQuotaSample, QuotaWindow } from "./sources.ts";

// ---------------------------------------------------------------------------
// Names, caps and types
// ---------------------------------------------------------------------------

const KIB = 1024;

export const QUOTA_LATEST_FILE = "quota-latest.json";
export const QUOTA_LATEST_REFRESH_MS = 60_000;
export const QUOTA_LATEST_CAP_BYTES = 4 * KIB;
export const QUOTA_MONTH_CAP_BYTES = KIB * KIB;
// The writers check the size before they append, with no lock, so appenders that run at
// the same time can pass the write cap by a few lines. The readers take that overshoot.
export const QUOTA_MONTH_READ_CAP_BYTES = QUOTA_MONTH_CAP_BYTES + 64 * KIB;

// One call stores at most this many samples. A pass holds far fewer.
const MAX_STORE_SAMPLES = 20_000;
const MAX_READ_MONTHS = 24;
const MONTH_NAME = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const CODEX_LATEST_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1_000;

export type QuotaProvider = "claude" | "codex";
type CodexSource = "appserver" | "rollouts";
type RolloutQuotaSample = Omit<CodexQuotaSample, "reached"> & { readonly reached?: boolean };

export interface CodexLatestWindow extends CodexQuotaSample {
  readonly src: CodexSource;
}

export const QUOTA_WINDOWS: readonly QuotaWindow[] = ["five_hour", "week"];

export interface QuotaSample extends QuotaPoint {
  readonly provider: QuotaProvider;
  readonly window: QuotaWindow;
  // Sample time, epoch milliseconds.
  readonly at: number;
}

export type WindowReason = "absent" | "bad_percent" | "bad_reset";

const WINDOW_REASONS: readonly WindowReason[] = ["absent", "bad_percent", "bad_reset"];

export interface UnusableWindow {
  readonly reason: WindowReason;
}

export type StatuslineWindow = QuotaPoint | UnusableWindow;

// The two windows of one statusline JSON. A window that was absent or invalid
// holds its reason.
export type StatuslineQuota = { readonly [W in QuotaWindow]: StatuslineWindow };

function isReason(value: unknown): value is WindowReason {
  return WINDOW_REASONS.some((reason) => reason === value);
}

// False when both windows are absent: the statusline carries no rate limits, and
// there is nothing to store.
export function hasLimits(quota: StatuslineQuota): boolean {
  return QUOTA_WINDOWS.some((window) => {
    const entry = quota[window];
    return !("reason" in entry) || entry.reason !== "absent";
  });
}

export interface QuotaWriteReport {
  readonly appended: number;
  // Samples not appended because the same percent and reset time are already stored.
  readonly skipped: number;
  // Samples not appended because the month file is at its cap.
  readonly full: number;
  readonly latestWritten: boolean;
}

// ---------------------------------------------------------------------------
// Parse the statusline JSON (a trust boundary)
// ---------------------------------------------------------------------------

function windowOf(value: unknown, nowMs: number): StatuslineWindow {
  const row = asRow(value);
  if (row === null) return { reason: "absent" };
  const point = quotaPoint(row["used_percentage"], row["resets_at"], nowMs);
  return point.ok ? point.value : { reason: point.error };
}

// Copies `rate_limits.five_hour` and `rate_limits.seven_day`, two fields each,
// or the reason why a window is not usable. The parsed object, and every other
// field in it, is dropped.
export function parseStatusline(text: string, nowMs: number): Result<StatuslineQuota, "bad_json"> {
  const parsed = parseJson(text);
  if (!parsed.ok) return parsed;
  const root = asRow(parsed.value);
  if (root === null) return err("bad_json");
  const limits = asRow(root["rate_limits"]);
  return ok({
    five_hour: windowOf(limits?.["five_hour"], nowMs),
    week: windowOf(limits?.["seven_day"], nowMs),
  });
}

// ---------------------------------------------------------------------------
// Sample lines and files
// ---------------------------------------------------------------------------

function monthFile(month: string): string {
  return `quota-${month}.jsonl`;
}

// The file of a sample time: its UTC month. `atMs` is a finite epoch time.
export function quotaMonthFile(atMs: number): string {
  return monthFile(new Date(atMs).toISOString().slice(0, 7));
}

export function sampleLine(sample: QuotaSample): string {
  return JSON.stringify({
    p: sample.provider,
    w: sample.window,
    at: sample.at,
    pct: sample.usedPercent,
    reset: sample.resetsAt,
  });
}

function parseSampleLine(line: string, nowMs: number): QuotaSample | null {
  const parsed = parseJson(line);
  if (!parsed.ok) return null;
  const row = asRow(parsed.value);
  if (row === null) return null;
  const provider = row["p"];
  const window = row["w"];
  if (provider !== "claude" && provider !== "codex") return null;
  if (window !== "five_hour" && window !== "week") return null;
  const at = row["at"];
  if (typeof at !== "number" || !(at >= EARLIEST_TIME_MS && at <= nowMs + FUTURE_SLACK_MS)) return null;
  const reset = row["reset"];
  const point = checkQuotaPoint(row["pct"], typeof reset === "number" ? reset : null, at);
  if (!point.ok) return null;
  return { provider, window, at, usedPercent: point.value.usedPercent, resetsAt: point.value.resetsAt };
}

// ---------------------------------------------------------------------------
// Safe reads
// ---------------------------------------------------------------------------

export type UnknownReason =
  | "missing"
  | "unsafe"
  | "too_large"
  | "bad_shape"
  | "out_of_range"
  | "stale"
  | WindowReason;

export type QuotaReading =
  | { readonly known: true; readonly usedPercent: number; readonly resetsAt: number; readonly at: number }
  | { readonly known: false; readonly reason: UnknownReason };

export type LatestQuota = { readonly [W in QuotaWindow]: QuotaReading };

interface StoredPoint extends QuotaPoint {
  // The last time the percent was confirmed, epoch milliseconds.
  readonly at: number;
  readonly src?: CodexSource;
  readonly reached?: boolean;
}

interface StoredReason {
  readonly reason: WindowReason;
  // When the reason was found, epoch milliseconds.
  readonly at: number;
}

type StoredValue = StoredPoint | StoredReason;

type StoredWindow = Result<StoredValue | null, "bad_shape">;

function isStoredReason(value: StoredValue): value is StoredReason {
  return "reason" in value;
}

type StoredSection = { readonly [W in QuotaWindow]: StoredWindow };

interface StoredFile {
  readonly claude: StoredSection;
  // A file that record wrote before Codex was seen has no Codex section: every window is null.
  readonly codex: StoredSection;
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function storedWindow(value: unknown): StoredWindow {
  if (value === null || value === undefined) return ok(null);
  const row = asRow(value);
  if (row === null) return err("bad_shape");
  const { usedPercent, resetsAt, at, reason, src, reached } = row;
  if (reason !== undefined) return isReason(reason) && isNumber(at) ? ok({ reason, at }) : err("bad_shape");
  if (!isNumber(usedPercent) || !isNumber(resetsAt) || !isNumber(at)) return err("bad_shape");
  if (src !== undefined && src !== "appserver" && src !== "rollouts") return err("bad_shape");
  if (reached !== undefined && typeof reached !== "boolean") return err("bad_shape");
  return ok({
    usedPercent, resetsAt, at,
    ...(src === undefined ? {} : { src }),
    ...(reached === undefined ? {} : { reached }),
  });
}

function storedSection(value: unknown): StoredSection {
  const section = asRow(value);
  return { five_hour: storedWindow(section?.["five_hour"]), week: storedWindow(section?.["week"]) };
}

type StoredFailure = UnknownReason | "newer_version";

function loadStored(dataDir: string, deps: FsDeps): Result<StoredFile, StoredFailure> {
  const text = readOwnFile(join(dataDir, QUOTA_LATEST_FILE), QUOTA_LATEST_CAP_BYTES, deps);
  if (!text.ok) return err(text.error);
  const parsed = parseJson(text.value);
  if (!parsed.ok) return err("bad_shape");
  const root = asRow(parsed.value);
  const version = root?.["version"];
  if (typeof version === "number" && Number.isInteger(version) && version > STORE_VERSION) return err("newer_version");
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return err("bad_shape");
  }
  if (asRow(root?.["claude"]) === null) return err("bad_shape");
  return ok({ claude: storedSection(root?.["claude"]), codex: storedSection(root?.["codex"]) });
}

function unknown(reason: UnknownReason): QuotaReading {
  return { known: false, reason };
}

function judge(stored: StoredWindow, nowMs: number): QuotaReading {
  if (!stored.ok) return unknown("bad_shape");
  const point = stored.value;
  if (point === null) return unknown("missing");
  if (isStoredReason(point)) return unknown(point.reason);
  if (!(point.at >= EARLIEST_TIME_MS && point.at <= nowMs + FUTURE_SLACK_MS)) return unknown("out_of_range");
  if (!checkQuotaPoint(point.usedPercent, point.resetsAt, point.at).ok) return unknown("out_of_range");
  // The window has ended: the percent belongs to a period that is over.
  if (point.resetsAt <= nowMs) return unknown("stale");
  return { known: true, usedPercent: point.usedPercent, resetsAt: point.resetsAt, at: point.at };
}

// The Claude quota of the latest file. Never fails: a missing, unsafe, over-size,
// damaged, out of range or ended reading is unknown.
export function readLatestQuota(dataDir: string, nowMs: number, deps: FsDeps = defaultDeps()): LatestQuota {
  const stored = loadStored(dataDir, deps);
  if (!stored.ok) {
    const reason = stored.error === "newer_version" ? "bad_shape" : stored.error;
    return { five_hour: unknown(reason), week: unknown(reason) };
  }
  const { claude } = stored.value;
  return { five_hour: judge(claude.five_hour, nowMs), week: judge(claude.week, nowMs) };
}

function observedPoint(entry: StoredWindow, nowMs: number): StoredPoint | null {
  const point = entry.ok ? entry.value : null;
  if (point === null || isStoredReason(point)) return null;
  if (!(point.at >= EARLIEST_TIME_MS && point.at <= nowMs + FUTURE_SLACK_MS)) return null;
  return checkQuotaPoint(point.usedPercent, point.resetsAt, point.at).ok ? point : null;
}

// The Codex windows for the HUD, in window order. A window can be past its reset.
export function readCodexLatest(dataDir: string, nowMs: number, deps: FsDeps = defaultDeps()): readonly CodexLatestWindow[] {
  const stored = loadStored(dataDir, deps);
  if (!stored.ok) return [];
  const windows: CodexLatestWindow[] = [];
  for (const window of QUOTA_WINDOWS) {
    const point = observedPoint(stored.value.codex[window], nowMs);
    if (point === null || point.at < nowMs - CODEX_LATEST_MAX_AGE_MS) continue;
    if (!Number.isSafeInteger(point.at) || !Number.isSafeInteger(point.resetsAt)) continue;
    windows.push({ window, ...point, src: point.src ?? "rollouts", reached: point.reached ?? false });
  }
  return windows;
}

const OBSERVED_PROVIDERS: readonly QuotaProvider[] = ["claude", "codex"];

// The windows of the latest file, Claude first and then Codex, as samples whose
// time is the last time the numbers were seen. A window with no value, a reason,
// a damaged shape or a value out of range gives none. Never fails.
export function readObservations(dataDir: string, nowMs: number, deps: FsDeps = defaultDeps()): readonly QuotaSample[] {
  const stored = loadStored(dataDir, deps);
  if (!stored.ok) return [];
  const seen: QuotaSample[] = [];
  for (const provider of OBSERVED_PROVIDERS) {
    for (const window of QUOTA_WINDOWS) {
      const point = observedPoint(stored.value[provider][window], nowMs);
      if (point === null) continue;
      seen.push({ provider, window, at: point.at, usedPercent: point.usedPercent, resetsAt: point.resetsAt });
    }
  }
  return seen;
}

// The valid samples of the named months ("YYYY-MM"), in file order. A month file
// that is missing, unsafe or over its cap gives none. A line that is not valid is skipped.
export function readQuotaSamples(
  dataDir: string,
  months: readonly string[],
  nowMs: number,
  deps: FsDeps = defaultDeps(),
): readonly QuotaSample[] {
  const samples: QuotaSample[] = [];
  for (const month of months.slice(0, MAX_READ_MONTHS)) {
    if (!MONTH_NAME.test(month)) continue;
    const text = readOwnFile(join(dataDir, monthFile(month)), QUOTA_MONTH_READ_CAP_BYTES, deps);
    if (!text.ok) continue;
    for (const line of text.value.split("\n")) {
      const sample = parseSampleLine(line, nowMs);
      if (sample !== null) samples.push(sample);
    }
  }
  return samples;
}

function beats(a: StoredPoint, b: StoredPoint): boolean {
  if (a.resetsAt !== b.resetsAt) return a.resetsAt > b.resetsAt;
  if (a.usedPercent !== b.usedPercent) return a.usedPercent > b.usedPercent;
  return a.at > b.at;
}

// No reset time is before this instant, so no sample is left out. Pass it as the
// `nowMs` of pickLatestSample to take the samples of ended periods too.
export const ANY_RESET = 0;

// The latest sample of a window whose period is still open (reset after `nowMs`).
// A percent only grows inside one reset period. A restamped copy in a Codex child
// rollout has a later time but an older percent. So: the newest reset period
// wins, then the highest percent in it, then the later time.
export function pickLatestSample(
  samples: readonly QuotaSample[],
  provider: QuotaProvider,
  window: QuotaWindow,
  nowMs: number,
): QuotaSample | null {
  let best: QuotaSample | null = null;
  for (const sample of samples) {
    if (sample.provider !== provider || sample.window !== window || sample.resetsAt <= nowMs) continue;
    if (best === null || beats(sample, best)) best = sample;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Writers
// ---------------------------------------------------------------------------

function fileSize(path: string): Result<number, FsError> {
  const stat = lstatEntry(path);
  if (stat.ok) return ok(stat.value.size);
  return stat.error.code === "not_found" ? ok(0) : stat;
}

interface AppendCount {
  readonly appended: number;
  // Samples left out because their month file is at its cap.
  readonly full: number;
}

// Appends each sample to the file of its month, while the file stays within its cap.
function appendSamples(dataDir: string, samples: readonly QuotaSample[], deps: FsDeps): Result<AppendCount, FsError> {
  const sizes = new Map<string, number>();
  let appended = 0;
  let full = 0;
  for (const sample of samples.slice(0, MAX_STORE_SAMPLES)) {
    const path = join(dataDir, quotaMonthFile(sample.at));
    const line = sampleLine(sample);
    const bytes = Buffer.byteLength(line, "utf8") + 1;
    let size = sizes.get(path);
    if (size === undefined) {
      const measured = fileSize(path);
      if (!measured.ok) return measured;
      size = measured.value;
      sizes.set(path, size);
    }
    if (size + bytes > QUOTA_MONTH_CAP_BYTES) {
      full += 1;
      continue;
    }
    const wrote = appendLine(path, line, deps);
    if (!wrote.ok) return wrote;
    sizes.set(path, size + bytes);
    appended += 1;
  }
  return ok({ appended, full });
}

type LatestSection = Record<QuotaWindow, StoredValue | null>;

const EMPTY_STORED: StoredSection = { five_hour: ok(null), week: ok(null) };

// What a stored section holds, to write it back. A window of a damaged shape is dropped.
function valuesOf(section: StoredSection): LatestSection {
  const value = (window: StoredWindow): StoredValue | null => (window.ok ? window.value : null);
  return { five_hour: value(section.five_hour), week: value(section.week) };
}

// Writes the whole latest file. The Codex section is left out while it holds nothing,
// so a folder that only record writes keeps the file it always had.
function writeLatest(dataDir: string, claude: LatestSection, codex: LatestSection, deps: FsDeps): Result<null, FsError> {
  const seen = QUOTA_WINDOWS.some((window) => codex[window] !== null);
  const body = { version: STORE_VERSION, claude, ...(seen ? { codex } : {}) };
  return writeAtomic(join(dataDir, QUOTA_LATEST_FILE), JSON.stringify(body), deps);
}

interface WindowPlan {
  // What the latest file holds for the window afterwards.
  readonly next: StoredValue;
  // The point to append as a sample, or null when nothing changed.
  readonly sample: QuotaPoint | null;
  // The latest file needs a rewrite.
  readonly write: boolean;
}

function planWindow(input: StatuslineWindow, old: StoredValue | null, nowMs: number): WindowPlan {
  const oldPoint = old === null || isStoredReason(old) ? null : old;
  const oldSane = oldPoint !== null && checkQuotaPoint(oldPoint.usedPercent, oldPoint.resetsAt, oldPoint.at).ok;

  if ("reason" in input) {
    if (oldPoint !== null && oldSane && oldPoint.resetsAt > nowMs) return { next: oldPoint, sample: null, write: false };
    const same = old !== null && isStoredReason(old) && old.reason === input.reason;
    return { next: { reason: input.reason, at: nowMs }, sample: null, write: !same };
  }

  const keepOld = oldPoint !== null && oldSane && oldPoint.resetsAt === input.resetsAt && oldPoint.usedPercent > input.usedPercent;
  const point: QuotaPoint = keepOld
    ? { usedPercent: oldPoint.usedPercent, resetsAt: oldPoint.resetsAt }
    : { usedPercent: input.usedPercent, resetsAt: input.resetsAt };
  const changed = oldPoint === null || oldPoint.usedPercent !== point.usedPercent || oldPoint.resetsAt !== point.resetsAt;
  // A stored time in the future (a clock that moved back) is refreshed too.
  const age = oldPoint === null ? 0 : nowMs - oldPoint.at;
  return {
    next: { ...point, at: nowMs },
    sample: changed ? point : null,
    write: changed || age < 0 || age >= QUOTA_LATEST_REFRESH_MS,
  };
}

// The record side. `quota` is a parsed statusline; `nowMs` is the sample time.
export function recordStatuslineQuota(
  dataDir: string,
  quota: StatuslineQuota,
  nowMs: number,
  deps: FsDeps = defaultDeps(),
): Result<QuotaWriteReport, FsError> {
  const stored = loadStored(dataDir, deps);
  if (!stored.ok && stored.error === "newer_version") return err({ code: "bad_input", sys: null });
  const before = valuesOf(stored.ok ? stored.value.claude : EMPTY_STORED);

  const fresh: QuotaSample[] = [];
  const next: Record<QuotaWindow, StoredValue | null> = { five_hour: null, week: null };
  let write = false;
  for (const window of QUOTA_WINDOWS) {
    const plan = planWindow(quota[window], before[window], nowMs);
    next[window] = plan.next;
    if (plan.sample !== null) fresh.push({ provider: "claude", window, at: nowMs, ...plan.sample });
    if (plan.write) write = true;
  }

  const appended = appendSamples(dataDir, fresh, deps);
  let latest: Result<null, FsError> = ok(null);
  if (write) {
    latest = writeLatest(dataDir, next, valuesOf(stored.ok ? stored.value.codex : EMPTY_STORED), deps);
  }
  if (!appended.ok) return appended;
  if (!latest.ok) return latest;
  return ok({ appended: appended.value.appended, skipped: 0, full: appended.value.full, latestWritten: write });
}

// A sample without its time: the same provider, window, percent and reset time
// say the same thing, whenever they were seen.
function sampleKey(provider: unknown, window: unknown, usedPercent: unknown, resetsAt: unknown): string {
  return JSON.stringify([provider, window, usedPercent, resetsAt]);
}

// The keys of the samples in a month file. A line that does not parse gives no key.
function storedKeys(path: string, deps: FsDeps): Set<string> {
  const keys = new Set<string>();
  const text = readOwnFile(path, QUOTA_MONTH_READ_CAP_BYTES, deps);
  if (!text.ok) return keys;
  for (const line of text.value.split("\n")) {
    const parsed = parseJson(line);
    const row = parsed.ok ? asRow(parsed.value) : null;
    if (row !== null) keys.add(sampleKey(row["p"], row["w"], row["pct"], row["reset"]));
  }
  return keys;
}

// Compare sources by time. The app-server wins a tie. Only two rollout points
// use the reset and percent rule, which keeps restamped child copies in order.
function replacesCodexPoint(old: StoredPoint, next: StoredPoint): boolean {
  if (next.src === "appserver") return next.at >= old.at;
  if (old.src === "appserver") return next.at > old.at;
  return !beats(old, next);
}

function latestCodexPoint(
  window: QuotaWindow,
  old: StoredValue | null,
  samples: readonly RolloutQuotaSample[],
  src: CodexSource,
): StoredPoint | null {
  let best: RolloutQuotaSample | null = null;
  for (const sample of samples) {
    if (sample.window !== window) continue;
    if (best === null || (src === "appserver" ? sample.at >= best.at : beats(sample, best))) best = sample;
  }
  if (best === null) return null;
  const { usedPercent, resetsAt, at, reached = false } = best;
  const next = { usedPercent, resetsAt, at, src, reached };
  if (old !== null && !isStoredReason(old) && checkQuotaPoint(old.usedPercent, old.resetsAt, old.at).ok) {
    if (!replacesCodexPoint(old, next)) return null;
  }
  return next;
}

function samePoint(a: StoredValue | null, b: StoredPoint): boolean {
  if (a === null || isStoredReason(a)) return false;
  return a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt && a.at === b.at
    && (a.src ?? "rollouts") === b.src && (a.reached ?? false) === b.reached;
}

// Rewrites the Codex section when a point changes. The Claude section stays.
function refreshCodexLatest(
  dataDir: string,
  samples: readonly RolloutQuotaSample[],
  src: CodexSource,
  deps: FsDeps,
): Result<boolean, FsError> {
  const stored = loadStored(dataDir, deps);
  if (!stored.ok && stored.error === "newer_version") return err({ code: "bad_input", sys: null });
  const old = valuesOf(stored.ok ? stored.value.codex : EMPTY_STORED);
  const next: LatestSection = { five_hour: old.five_hour, week: old.week };
  let write = false;
  for (const window of QUOTA_WINDOWS) {
    const point = latestCodexPoint(window, old[window], samples, src);
    if (point === null || samePoint(old[window], point)) continue;
    next[window] = point;
    write = true;
  }
  if (!write) return ok(false);
  const written = writeLatest(dataDir, valuesOf(stored.ok ? stored.value.claude : EMPTY_STORED), next, deps);
  return written.ok ? ok(true) : written;
}

// Both sources share the monthly dedupe keys. Repeats can update the latest file
// without an extra line in the month file.
function storeCodexSamples(
  dataDir: string,
  samples: readonly RolloutQuotaSample[],
  src: CodexSource,
  deps: FsDeps,
): Result<QuotaWriteReport, FsError> {
  const keysByPath = new Map<string, Set<string>>();
  const fresh: QuotaSample[] = [];
  const seen = samples.slice(0, MAX_STORE_SAMPLES);
  for (const { window, at, usedPercent, resetsAt } of seen) {
    const sample: QuotaSample = { provider: "codex", window, at, usedPercent, resetsAt };
    const path = join(dataDir, quotaMonthFile(sample.at));
    const key = sampleKey(sample.provider, sample.window, sample.usedPercent, sample.resetsAt);
    let keys = keysByPath.get(path);
    if (keys === undefined) {
      keys = storedKeys(path, deps);
      keysByPath.set(path, keys);
    }
    if (keys.has(key)) continue;
    keys.add(key);
    fresh.push(sample);
  }
  const appended = appendSamples(dataDir, fresh, deps);
  if (!appended.ok) return appended;
  const latest = refreshCodexLatest(dataDir, seen, src, deps);
  if (!latest.ok) return latest;
  const { appended: count, full } = appended.value;
  return ok({ appended: count, skipped: samples.length - count - full, full, latestWritten: latest.value });
}

// The rollout samples of one collect or refresh pass.
export function storeCodexQuota(
  dataDir: string,
  samples: readonly RolloutQuotaSample[],
  deps: FsDeps = defaultDeps(),
): Result<QuotaWriteReport, FsError> {
  return storeCodexSamples(dataDir, samples, "rollouts", deps);
}

// The parsed windows from one app-server reply.
export function storeAppServerReading(
  dataDir: string,
  samples: readonly CodexQuotaSample[],
  deps: FsDeps = defaultDeps(),
): Result<QuotaWriteReport, FsError> {
  return storeCodexSamples(dataDir, samples, "appserver", deps);
}
