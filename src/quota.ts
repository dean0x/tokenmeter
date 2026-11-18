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
// old. The Codex writer (collect) uses the same append path and skips a sample
// whose percent and reset time are already in the file, whatever its sample time.
// A month file stops growing at 1 MiB.
//
// The latest file holds the time each window was last seen. For Claude, record
// writes it. For Codex, collect writes it. A repeat of the numbers adds no line to
// the month file, so the line holds the time of the change, and the latest file
// holds the later time of the last repeat. Each writer keeps the section of the
// other. The forecast of both uses the later time (see readObservations).
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

export type QuotaProvider = "claude" | "codex";

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
  const { usedPercent, resetsAt, at, reason } = row;
  if (reason !== undefined) return isReason(reason) && isNumber(at) ? ok({ reason, at }) : err("bad_shape");
  if (!isNumber(usedPercent) || !isNumber(resetsAt) || !isNumber(at)) return err("bad_shape");
  return ok({ usedPercent, resetsAt, at });
}

function storedSection(value: unknown): StoredSection {
  const section = asRow(value);
  return { five_hour: storedWindow(section?.["five_hour"]), week: storedWindow(section?.["week"]) };
}

function loadStored(dataDir: string, deps: FsDeps): Result<StoredFile, UnknownReason> {
  const text = readOwnFile(join(dataDir, QUOTA_LATEST_FILE), QUOTA_LATEST_CAP_BYTES, deps);
  if (!text.ok) return err(text.error);
  const parsed = parseJson(text.value);
  if (!parsed.ok) return err("bad_shape");
  const root = asRow(parsed.value);
  const version = root?.["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1 || version > STORE_VERSION) {
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
  if (!stored.ok) return { five_hour: unknown(stored.error), week: unknown(stored.error) };
  const { claude } = stored.value;
  return { five_hour: judge(claude.five_hour, nowMs), week: judge(claude.week, nowMs) };
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
      const entry = stored.value[provider][window];
      const point = entry.ok ? entry.value : null;
      if (point === null || isStoredReason(point)) continue;
      if (!(point.at >= EARLIEST_TIME_MS && point.at <= nowMs + FUTURE_SLACK_MS)) continue;
      if (!checkQuotaPoint(point.usedPercent, point.resetsAt, point.at).ok) continue;
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

function beats(a: QuotaSample, b: QuotaSample): boolean {
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

// The Codex window of the latest file after a pass: the sample that pickLatestSample
// takes from the stored point and the samples of the pass. So the highest percent
// of the newest reset time stays, and its time is the last time it was seen.
// A stored point out of range is not trusted. Null when there is nothing to keep.
function latestCodexPoint(window: QuotaWindow, old: StoredValue | null, samples: readonly QuotaSample[]): StoredPoint | null {
  const pool = samples.filter((sample) => sample.window === window);
  if (old !== null && !isStoredReason(old) && checkQuotaPoint(old.usedPercent, old.resetsAt, old.at).ok) {
    pool.push({ provider: "codex", window, at: old.at, usedPercent: old.usedPercent, resetsAt: old.resetsAt });
  }
  const best = pickLatestSample(pool, "codex", window, ANY_RESET);
  return best === null ? null : { usedPercent: best.usedPercent, resetsAt: best.resetsAt, at: best.at };
}

function samePoint(a: StoredValue | null, b: StoredPoint | null): boolean {
  if (a === null || b === null) return a === b;
  return !isStoredReason(a) && a.usedPercent === b.usedPercent && a.resetsAt === b.resetsAt && a.at === b.at;
}

// Rewrites the Codex section of the latest file when a window has a new point or a later
// time. The Claude section is written back as it was. Returns true when it wrote the file.
function refreshCodexLatest(dataDir: string, samples: readonly QuotaSample[], deps: FsDeps): Result<boolean, FsError> {
  const stored = loadStored(dataDir, deps);
  const old = valuesOf(stored.ok ? stored.value.codex : EMPTY_STORED);
  const next: LatestSection = { five_hour: old.five_hour, week: old.week };
  let write = false;
  for (const window of QUOTA_WINDOWS) {
    const point = latestCodexPoint(window, old[window], samples);
    if (point === null || samePoint(old[window], point)) continue;
    next[window] = point;
    write = true;
  }
  if (!write) return ok(false);
  const written = writeLatest(dataDir, valuesOf(stored.ok ? stored.value.claude : EMPTY_STORED), next, deps);
  return written.ok ? ok(true) : written;
}

// The collect side: the Codex samples of one pass (the `codexQuota` list of the
// collect report). A pass reads the new lines of a rollout, so it emits samples
// with new times and mostly old numbers. A sample whose percent and reset time
// are in the month file already, or earlier in the list, is not written again.
// The latest file takes the Codex window as the pass saw it, with the later time
// of a repeat, so that the month file does not grow.
export function storeCodexQuota(
  dataDir: string,
  samples: readonly CodexQuotaSample[],
  deps: FsDeps = defaultDeps(),
): Result<QuotaWriteReport, FsError> {
  // Per month file: the keys stored, and then the keys of this list as they are taken.
  const keysByPath = new Map<string, Set<string>>();
  const fresh: QuotaSample[] = [];
  const seen: QuotaSample[] = [];
  for (const source of samples.slice(0, MAX_STORE_SAMPLES)) {
    const sample: QuotaSample = {
      provider: "codex",
      window: source.window,
      at: source.at,
      usedPercent: source.usedPercent,
      resetsAt: source.resetsAt,
    };
    seen.push(sample);
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
  const latest = refreshCodexLatest(dataDir, seen, deps);
  if (!latest.ok) return latest;
  const { appended: count, full } = appended.value;
  return ok({ appended: count, skipped: samples.length - count - full, full, latestWritten: latest.value });
}
