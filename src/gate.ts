import { join } from "node:path";
import type { AppServerError } from "./appserver.ts";
import { readAppServerSetting } from "./config.ts";
import { FUTURE_SLACK_MS, asRow, err, ok, parseJson, type Result } from "./core.ts";
import {
  acquireLock, defaultDeps, lockAvailable, readOwnFile, writeOwnFile,
  type FsDeps, type FsError, type Lock,
} from "./fsafe.ts";

const REFRESH_STATE_FILE = "refresh-state.json";
const REFRESH_LOCK_FILE = "refresh.lock";
const STATE_CAP_BYTES = 4 * 1024;
export const BIN_KEY = /^[a-f0-9]{64}$/;
export const REFRESH_INTERVAL_MS = 60_000;
const MAX_BACKOFF_MS = 24 * 60 * REFRESH_INTERVAL_MS;
export type RefreshOutcome = AppServerError | "ok" | "off";

const BACKOFF_MS: Readonly<Record<RefreshOutcome, number>> = {
  ok: REFRESH_INTERVAL_MS,
  off: REFRESH_INTERVAL_MS,
  timeout: REFRESH_INTERVAL_MS,
  error: REFRESH_INTERVAL_MS,
  missing: 10 * REFRESH_INTERVAL_MS,
  auth: 15 * REFRESH_INTERVAL_MS,
  old: MAX_BACKOFF_MS,
  shape: MAX_BACKOFF_MS,
};

export interface RefreshState {
  readonly lastAttemptAt: number;
  readonly nextRefreshAt: number;
  readonly nextAppServerAt: number;
  readonly outcome: RefreshOutcome;
  readonly binKey: string | null;
  readonly codexFound: boolean;
}

type StoredState = Result<RefreshState | null, "unsafe" | "too_large">;

function isOutcome(value: unknown): value is RefreshOutcome {
  return typeof value === "string" && Object.hasOwn(BACKOFF_MS, value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readRefreshState(dataDir: string, deps: FsDeps = defaultDeps()): StoredState {
  const text = readOwnFile(join(dataDir, REFRESH_STATE_FILE), STATE_CAP_BYTES, deps, 0o600);
  if (!text.ok) return text.error === "missing" ? ok(null) : err(text.error);
  // Treat malformed content as absent so the next refresh can repair it.
  const parsed = parseJson(text.value);
  const row = parsed.ok ? asRow(parsed.value) : null;
  if (row === null) return ok(null);
  const { lastAttemptAt, nextRefreshAt, nextAppServerAt, outcome, binKey, codexFound } = row;
  if (!isTime(lastAttemptAt) || !isTime(nextRefreshAt) || !isTime(nextAppServerAt) || !isOutcome(outcome)
    || (binKey !== null && (typeof binKey !== "string" || !BIN_KEY.test(binKey))) || typeof codexFound !== "boolean") {
    return ok(null);
  }
  const now = deps.nowMs();
  if (lastAttemptAt > now + FUTURE_SLACK_MS || nextRefreshAt > now + REFRESH_INTERVAL_MS
    || nextAppServerAt > now + MAX_BACKOFF_MS) return ok(null);
  return ok({ lastAttemptAt, nextRefreshAt, nextAppServerAt, outcome, binKey, codexFound });
}

export function writeRefreshState(dataDir: string, state: RefreshState, deps: FsDeps = defaultDeps()): Result<null, FsError> {
  return writeOwnFile(join(dataDir, REFRESH_STATE_FILE), JSON.stringify(state), deps);
}

export function acquireRefreshLock(dataDir: string, deps: FsDeps = defaultDeps()): Result<Lock, FsError> {
  return acquireLock(join(dataDir, REFRESH_LOCK_FILE), deps);
}

export function backoffMs(outcome: RefreshOutcome): number {
  return BACKOFF_MS[outcome];
}

function binaryBackoff(state: RefreshState): boolean {
  return state.outcome === "old" || state.outcome === "shape";
}

function binaryRetryDue(state: RefreshState, now: number, resolveKey: () => string | null): boolean {
  if (!binaryBackoff(state)) return false;
  const retryFloor = state.nextAppServerAt - backoffMs(state.outcome) + REFRESH_INTERVAL_MS;
  if (now < retryFloor) return false;
  const key = resolveKey();
  return key !== null && key !== state.binKey;
}

// Reuse this check under the lock with a fresh state read and before any state write.
export function refreshDue(readingAt: number | null, state: RefreshState | null, now: number, resolveBinKey: () => string | null): boolean {
  if (readingAt !== null && readingAt <= now + FUTURE_SLACK_MS && now - readingAt < REFRESH_INTERVAL_MS) return false;
  if (state === null) return true;
  return now >= state.nextRefreshAt || binaryRetryDue(state, now, resolveBinKey);
}

export function refreshGate(
  dataDir: string, readingAt: number | null, state: StoredState, resolveBinKey: () => string | null, deps: FsDeps = defaultDeps(),
): boolean {
  return state.ok && lockAvailable(join(dataDir, REFRESH_LOCK_FILE), deps)
    && refreshDue(readingAt, state.value, deps.nowMs(), resolveBinKey);
}

// Call under the lock with the prior snapshot, before the attempt record changes.
export function appServerGate(
  dataDir: string, state: RefreshState | null, binKey: string | null, deps: FsDeps = defaultDeps(),
): "open" | "off" | "backoff" {
  if (readAppServerSetting(dataDir, deps) === "off") return "off";
  const now = deps.nowMs();
  if (state === null || now >= state.nextAppServerAt) return "open";
  return binaryRetryDue(state, now, () => binKey) ? "open" : "backoff";
}
