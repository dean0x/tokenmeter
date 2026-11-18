// Core types, constants and sanitisers for tokenmeter.
// Erasable syntax only: no enums, namespaces or parameter properties.

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const ERROR_CODES = [
  "node_too_old",
  "usage_error",
  "internal_error",
  "not_installed",
  "not_collected",
  "store_corrupt",
  "store_newer",
  "store_too_large",
  "data_dir_unsafe",
  "root_missing",
  "lock_held",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorRecord {
  readonly code: ErrorCode;
  readonly hint: string;
}

// One fixed hint per code. A hint never holds input text.
const ERROR_HINTS: Readonly<Record<ErrorCode, string>> = {
  node_too_old: "Node 22.18 or newer is required.",
  usage_error: "The command or a flag is not valid.",
  internal_error: "An internal error occurred.",
  not_installed: "The tokenmeter command was not found.",
  not_collected: "No collect has run yet. Run tokenmeter collect.",
  store_corrupt: "A store file is damaged. Counting stopped and nothing was written.",
  store_newer: "The store was written by a newer tokenmeter. Update tokenmeter.",
  store_too_large: "A store file would pass its size limit. Counting stopped and nothing was written.",
  data_dir_unsafe: "The data folder is not safe to use. It was refused.",
  root_missing: "The source folder does not exist yet.",
  lock_held: "Another collect is running. Nothing was changed.",
};

export function errorRecord(code: ErrorCode): ErrorRecord {
  return { code, hint: ERROR_HINTS[code] };
}

// ---------------------------------------------------------------------------
// Tokens and weights
// ---------------------------------------------------------------------------

// Bucket order is the stored array order: [input, cw5m, cw1h, cacheRead, output].
export const TOKEN_BUCKETS = [
  "input",
  "cacheWrite5m",
  "cacheWrite1h",
  "cacheRead",
  "output",
] as const;

export type TokenBucket = (typeof TOKEN_BUCKETS)[number];

export type TokenRecord = { readonly [B in TokenBucket]: number };

export const WEIGHTS: TokenRecord = {
  input: 1,
  cacheWrite5m: 1.25,
  cacheWrite1h: 2,
  cacheRead: 0.1,
  output: 5,
};

// Every model has factor 1. This is the one place to change that.
export const MODEL_FACTOR = 1;

export function weighted(tokens: TokenRecord): number {
  return (
    MODEL_FACTOR *
    (tokens.input * WEIGHTS.input +
      tokens.cacheWrite5m * WEIGHTS.cacheWrite5m +
      tokens.cacheWrite1h * WEIGHTS.cacheWrite1h +
      tokens.cacheRead * WEIGHTS.cacheRead +
      tokens.output * WEIGHTS.output)
  );
}

// The five columns added with no weight.
export function rawTokens(tokens: TokenRecord): number {
  return tokens.input + tokens.cacheWrite5m + tokens.cacheWrite1h + tokens.cacheRead + tokens.output;
}

// ---------------------------------------------------------------------------
// Schema and bounds
// ---------------------------------------------------------------------------

export const SCHEMA_ID = "tokenmeter.v1";
export const STORE_VERSION = 1;

const KIB = 1024;
const MIB = 1024 * KIB;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

// Line reader (3.3)
export const CHUNK_BYTES = 64 * KIB;
export const LINE_CAP_BYTES = MIB;
export const TOKEN_MAX = 1e8;
export const FOLDER_KEY_MAX = 200;
export const EARLIEST_TIME_MS = Date.UTC(2020, 0, 1);
export const FUTURE_SLACK_MS = MINUTE_MS;

// Scan and locks (3.4)
export const SCAN_BUDGET_BYTES = 200 * MIB;
export const SCAN_BUDGET_MS = 20_000;
export const MAX_ENTRIES_PER_FOLDER = 5000;
// A lock that was not refreshed for this long is stale, also when its pid is alive.
export const LOCK_STALE_MS = 120_000;
// A pass refreshes its lock between files when the last refresh is this old.
export const LOCK_REFRESH_MS = LOCK_STALE_MS / 4;
export const LOCK_BODY_CAP_BYTES = 4096;
export const MAX_LOCK_ATTEMPTS = 2;
export const MAX_TEMP_ATTEMPTS = 8;

// Status output (3.5)
export const STATUS_TOP_MODELS = 8;
export const STATUS_FINISHED_TASKS = 8;
// Open tasks in the status: one for each parallel session, and a few more.
export const STATUS_OPEN_TASKS = 20;
// The snapshot keeps every model up to this many; `usage` shows them all.
export const SNAPSHOT_MAX_MODELS = 200;

// The per-day totals. The 15 minute rows keep their short horizon; a day row
// lives this many local days, today included, then it is pruned.
export const DAYS_HORIZON_DAYS = 400;
// Models kept in one day row, and in one row of the status periods: the ones with
// the most weighted tokens. The provider totals of a row keep every model.
export const DAYS_MAX_MODELS = 40;
// The one-time backfill of the day rows from the logs reads at most this many
// bytes, for at most this long, and keeps at most this many message keys in
// memory. Past one of them the backfill ends and the older days stay as they are.
export const BACKFILL_BUDGET_BYTES = 1024 * MIB;
export const BACKFILL_BUDGET_MS = 120_000;
export const BACKFILL_MAX_KEYS = 500_000;

// The periods of the status output: rows kept of each kind (the newest). A week
// row and a month row keep this many models; a day row keeps DAYS_MAX_MODELS.
export const PERIODS_MAX_DAYS = 410;
export const PERIODS_MAX_WEEKS = 60;
export const PERIODS_MAX_MONTHS = 15;
export const PERIODS_LONG_ROW_MODELS = 20;
// The whole output of `status` and `usage` stays under this many bytes: the reader
// caps its input at 1 MiB. The periods get what the other fields leave. The months
// come first, then the weeks, then the days; a list drops its oldest rows first.
export const STATUS_OUTPUT_MAX_BYTES = 900 * KIB;

// Tasks sync (3.7)
export const SYNC_MAX_BYTES = MIB;
export const SYNC_MAX_WINDOWS = 500;
export const SYNC_MAX_OPEN_ITEMS = 500;
export const MAX_TAGS = 8;
// A feature is a name and a number. A window, an open item and a finished task
// each keep at most this many.
export const MAX_FEATURES = 16;
export const FEATURE_NAME_MAX = 16;
export const FEATURE_VALUE_MAX = 1e12;
const FEATURE_DECIMALS = 6;
export const SYNC_MAX_FOLDERS = 16;
export const SYNC_PATH_MAX_CHARS = 4096;
export const TASK_FREEZE_DELAY_MS = HOUR_MS;
// The task history keeps the newest entries; older ones drop out.
export const TASK_HISTORY_MAX = 5000;

// Store (3.8)
export const SLOT_MS = 15 * MINUTE_MS;
export const HORIZON_DAYS = 7;

// ---------------------------------------------------------------------------
// Sanitisers (3.3, 3.7)
// ---------------------------------------------------------------------------

export type RejectReason = "bad_token" | "bad_time";

const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;
const LABEL_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const ISO_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const ISO_TIME_MAX_CHARS = 40;

export function sanitizeModel(value: unknown): string {
  return typeof value === "string" && MODEL_PATTERN.test(value) ? value : "other";
}

// Cut first: the output length is the same, and the work stays bounded.
export function folderKey(path: string): string {
  return path.slice(0, FOLDER_KEY_MAX).replace(/[^A-Za-z0-9]/g, "-");
}

export function sanitizeTokens(value: unknown): Result<number, "bad_token"> {
  if (typeof value !== "number" || !Number.isInteger(value)) return err("bad_token");
  if (value < 0 || value > TOKEN_MAX) return err("bad_token");
  return ok(value);
}

// Input is an ISO 8601 string. `nowMs` is injected so tests control the clock.
// Returns epoch milliseconds.
export function sanitizeTime(value: unknown, nowMs: number): Result<number, "bad_time"> {
  if (typeof value !== "string" || value.length > ISO_TIME_MAX_CHARS) return err("bad_time");
  if (!ISO_TIME_PATTERN.test(value)) return err("bad_time");
  const ms = Date.parse(value);
  if (!(ms >= EARLIEST_TIME_MS && ms <= nowMs + FUTURE_SLACK_MS)) return err("bad_time");
  return ok(ms);
}

// The UTC month of an epoch time as "YYYY-MM", or null for a time that a date
// cannot hold. The one place that names a month: the estimate log files and the
// choice of the files to keep both go through it.
export function utcMonthOf(atMs: number): string | null {
  const date = new Date(atMs);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 7);
}

export function isLabel(value: unknown): value is string {
  return typeof value === "string" && LABEL_PATTERN.test(value);
}

const FEATURE_NAME_PATTERN = new RegExp(`^[a-z][a-z0-9_]{0,${FEATURE_NAME_MAX - 1}}$`);
// "elapsed_hours" is not an input: a running item has no elapsed time here.
// "constructor" is a name that every object already has, so a lookup of a
// feature that is absent would find it. The basis names are the names of the
// estimate models that are not a feature fit, so a feature with one of these
// names would give a basis name that means another model. "spent" is the name
// of the model for an item whose cost so far is past the start of its range.
export const BASIS_TYPE = "type";
export const BASIS_ALL = "all";
export const BASIS_NONE = "none";
export const BASIS_SPENT = "spent";
export const MODEL_BASIS_NAMES: ReadonlySet<string> = new Set([BASIS_TYPE, BASIS_ALL, BASIS_NONE, BASIS_SPENT]);
const RESERVED_FEATURE_NAMES: ReadonlySet<string> = new Set(["elapsed_hours", "constructor", ...MODEL_BASIS_NAMES]);

export function isFeatureName(value: unknown): value is string {
  return typeof value === "string" && FEATURE_NAME_PATTERN.test(value) && !RESERVED_FEATURE_NAMES.has(value);
}

// A finite number from 0 to 1e12, kept to six decimal places.
export function sanitizeFeature(value: unknown): Result<number, "bad_feature"> {
  if (typeof value !== "number" || !Number.isFinite(value)) return err("bad_feature");
  if (value < 0 || value > FEATURE_VALUE_MAX) return err("bad_feature");
  return ok(Number(value.toFixed(FEATURE_DECIMALS)));
}

// ---------------------------------------------------------------------------
// Percentile
// ---------------------------------------------------------------------------

// Linear interpolation between the closest ranks, on a sorted list. An empty
// list gives 0.
export function percentile(sorted: readonly number[], fraction: number): number {
  const position = fraction * (sorted.length - 1);
  const low = sorted[Math.floor(position)] ?? 0;
  const high = sorted[Math.ceil(position)] ?? low;
  return low + (high - low) * (position - Math.floor(position));
}

// ---------------------------------------------------------------------------
// Text order
// ---------------------------------------------------------------------------

// By code unit, with no locale, so the order is the same on every machine.
export function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Rows and quota readings (3.3)
// ---------------------------------------------------------------------------

export function parseJson(text: string): Result<unknown, "bad_json"> {
  try {
    return ok(JSON.parse(text));
  } catch {
    return err("bad_json");
  }
}

export function asRow(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export const PERCENT_MAX = 100;
export const QUOTA_MAX_AHEAD_MS = 8 * 24 * HOUR_MS;
// Epoch values from this size up are milliseconds; smaller ones are seconds.
const MILLISECOND_EPOCH_FLOOR = 1e11;
const MS_PER_SECOND = 1000;

// A reset time in epoch seconds or milliseconds, as epoch milliseconds.
export function epochMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value >= MILLISECOND_EPOCH_FLOOR ? value : value * MS_PER_SECOND);
}

export interface QuotaPoint {
  readonly usedPercent: number;
  // Epoch milliseconds.
  readonly resetsAt: number;
}

// The one range rule for a quota reading taken at `atMs`: a percent from 0 to
// 100, and a reset time after the sample and at most 8 days later.
export function checkQuotaPoint(
  percent: unknown,
  resetsAtMs: number | null,
  atMs: number,
): Result<QuotaPoint, "bad_percent" | "bad_reset"> {
  if (typeof percent !== "number" || !(percent >= 0 && percent <= PERCENT_MAX)) return err("bad_percent");
  if (resetsAtMs === null || !Number.isFinite(resetsAtMs)) return err("bad_reset");
  if (resetsAtMs <= atMs || resetsAtMs > atMs + QUOTA_MAX_AHEAD_MS) return err("bad_reset");
  return ok({ usedPercent: percent, resetsAt: resetsAtMs });
}

// Same rule for a reading whose reset time is in epoch seconds or milliseconds.
export function quotaPoint(
  percent: unknown,
  resetsAt: unknown,
  atMs: number,
): Result<QuotaPoint, "bad_percent" | "bad_reset"> {
  return checkQuotaPoint(percent, epochMs(resetsAt), atMs);
}
