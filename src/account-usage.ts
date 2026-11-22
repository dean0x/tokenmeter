import { join } from "node:path";
import { FUTURE_SLACK_MS, STORE_VERSION, asRow, compareText, err, ok, parseJson, type Result } from "./core.ts";
import { isDateName, shiftDate } from "./days.ts";
import { defaultDeps, readOwnFile, writeOwnFile, type FsDeps, type FsError } from "./fsafe.ts";
import { BIN_KEY } from "./gate.ts";

export const ACCOUNT_USAGE_FILE = "account-usage.json";
export const ACCOUNT_READ_CAP_BYTES = 8 * 1024;
export const ACCOUNT_WRITE_CAP_BYTES = 4 * 1024;
export const ACCOUNT_MAX_ROWS = 100;
export const ACCOUNT_KEEP_DAYS = 62;
export const ACCOUNT_DAY_TOKENS_MAX = 1e13;
export const USAGE_INTERVAL_MS = 15 * 60_000;
export const ACCOUNT_MAX_AGE_MS = 24 * 60 * 60_000;
export const USAGE_LONG_BACKOFF_MS = ACCOUNT_MAX_AGE_MS;

export type UsageError = "unsupported" | "shape" | "too_large" | "timeout" | "error";
export type AccountRow = readonly [string, number];

export interface AccountFile {
  readonly version: typeof STORE_VERSION;
  readonly fetched_at: number | null;
  readonly attempt_at: number;
  readonly attempt: "ok" | UsageError;
  readonly bin_key: string | null;
  readonly rows: readonly AccountRow[];
}

export interface AccountUsage {
  readonly at: number;
  readonly rows: readonly AccountRow[];
}

const USAGE_WAIT_MS: Readonly<Record<AccountFile["attempt"], number>> = {
  ok: USAGE_INTERVAL_MS,
  error: USAGE_INTERVAL_MS,
  timeout: USAGE_INTERVAL_MS,
  unsupported: USAGE_LONG_BACKOFF_MS,
  shape: USAGE_LONG_BACKOFF_MS,
  too_large: USAGE_LONG_BACKOFF_MS,
};

type UncheckedPair = readonly [unknown, unknown];

function checkedRows(
  list: unknown, toPair: (item: unknown) => UncheckedPair | null, nowMs: number,
): Result<readonly AccountRow[], "shape"> {
  if (!Array.isArray(list) || list.length > ACCOUNT_MAX_ROWS) return err("shape");
  const now = new Date(nowMs);
  if (!Number.isFinite(now.getTime())) return err("shape");
  const today = now.toISOString().slice(0, 10);
  if (!isDateName(today)) return err("shape");
  const newest = shiftDate(today, 1);
  const oldest = shiftDate(today, 1 - ACCOUNT_KEEP_DAYS);
  const rows: AccountRow[] = [];
  const seen = new Set<string>();
  for (const item of list) {
    const pair = toPair(item);
    if (pair === null) return err("shape");
    const [date, tokens] = pair;
    if (typeof date !== "string" || !isDateName(date) || date > newest || seen.has(date)
      || typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0 || tokens > ACCOUNT_DAY_TOKENS_MAX) {
      return err("shape");
    }
    seen.add(date);
    if (date >= oldest) rows.push([date, tokens]);
  }
  rows.sort(([left], [right]) => compareText(left, right));
  return ok(rows);
}

function replyPair(item: unknown): UncheckedPair | null {
  const row = asRow(item);
  if (row === null || Object.hasOwn(row, "__proto__") || !Object.hasOwn(row, "startDate") || !Object.hasOwn(row, "tokens")) {
    return null;
  }
  return [row["startDate"], row["tokens"]];
}

export function replyRows(result: unknown, nowMs: number): Result<readonly AccountRow[], UsageError> {
  const row = asRow(result);
  if (row === null || Object.hasOwn(row, "__proto__") || !Object.hasOwn(row, "dailyUsageBuckets")) return err("shape");
  const buckets = row["dailyUsageBuckets"];
  return buckets === null ? err("error") : checkedRows(buckets, replyPair, nowMs);
}

function filePair(item: unknown): UncheckedPair | null {
  return Array.isArray(item) && item.length === 2 ? [item[0], item[1]] : null;
}

function isAttempt(value: unknown): value is AccountFile["attempt"] {
  return typeof value === "string" && Object.hasOwn(USAGE_WAIT_MS, value);
}

function isTime(value: unknown, nowMs: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= nowMs + FUTURE_SLACK_MS;
}

export function readAccountFile(dataDir: string, nowMs: number, deps: FsDeps = defaultDeps()): AccountFile | null {
  const text = readOwnFile(join(dataDir, ACCOUNT_USAGE_FILE), ACCOUNT_READ_CAP_BYTES, deps, 0o600);
  if (!text.ok) return null;
  const parsed = parseJson(text.value);
  const row = parsed.ok ? asRow(parsed.value) : null;
  if (row === null || Object.hasOwn(row, "__proto__")) return null;
  const { version, fetched_at, attempt_at, attempt, bin_key, rows } = row;
  if (version !== STORE_VERSION || !isTime(attempt_at, nowMs) || !isAttempt(attempt)
    || (fetched_at !== null && !isTime(fetched_at, nowMs))
    || (bin_key !== null && (typeof bin_key !== "string" || !BIN_KEY.test(bin_key)))) return null;
  if (fetched_at === null && (!Array.isArray(rows) || rows.length !== 0)) return null;
  const checked = checkedRows(rows, filePair, nowMs);
  if (!checked.ok) return null;
  return { version, fetched_at, attempt_at, attempt, bin_key, rows: checked.value };
}

// The refresher holds refresh.lock before it calls this writer.
export function writeAccountFile(dataDir: string, file: AccountFile, deps: FsDeps = defaultDeps()): Result<null, FsError> {
  const { version, fetched_at, attempt_at, attempt, bin_key, rows } = file;
  const text = JSON.stringify({ version, fetched_at, attempt_at, attempt, bin_key, rows });
  if (Buffer.byteLength(text) > ACCOUNT_WRITE_CAP_BYTES) return err({ code: "too_large", sys: null });
  return writeOwnFile(join(dataDir, ACCOUNT_USAGE_FILE), text, deps);
}

export function usageDue(file: AccountFile | null, binKey: string, nowMs: number): boolean {
  if (file === null) return true;
  const wait = file.bin_key === binKey ? USAGE_WAIT_MS[file.attempt] : USAGE_INTERVAL_MS;
  return nowMs - file.attempt_at >= wait;
}

export function freshAccount(file: AccountFile | null, nowMs: number): AccountUsage | null {
  const at = file?.fetched_at ?? null;
  if (file === null || at === null || nowMs - at >= ACCOUNT_MAX_AGE_MS) return null;
  return { at, rows: file.rows };
}

export function readAccountUsage(dataDir: string, nowMs: number, deps: FsDeps = defaultDeps()): AccountUsage | null {
  return freshAccount(readAccountFile(dataDir, nowMs, deps), nowMs);
}

// No covered date gives null. A covered date with zero tokens gives zero.
export function accountSum(account: AccountUsage, from: string, until: string): number | null {
  let total: number | null = null;
  for (const [date, tokens] of account.rows) {
    if (date >= from && date < until) total = (total ?? 0) + tokens;
  }
  return total;
}
