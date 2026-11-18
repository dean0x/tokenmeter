import { join } from "node:path";
import type { AppServerError } from "./appserver.ts";
import { readAppServerSetting } from "./config.ts";
import { asRow, err, ok, parseJson, type Result } from "./core.ts";
import {
  acquireLock, defaultDeps, lockAvailable, readOwnFile, writeOwnFile,
  type FsDeps, type FsError, type Lock,
} from "./fsafe.ts";

const REFRESH_STATE_FILE = "refresh-state.json";
const REFRESH_LOCK_FILE = "refresh.lock";
const STATE_CAP_BYTES = 4 * 1024;
const BIN_KEY = /^[a-f0-9]{64}$/;
export const REFRESH_INTERVAL_MS = 60_000;
export type RefreshOutcome = AppServerError | "ok" | "off";

const BACKOFF_MS: Readonly<Record<RefreshOutcome, number>> = {
  ok: REFRESH_INTERVAL_MS,
  off: REFRESH_INTERVAL_MS,
  timeout: REFRESH_INTERVAL_MS,
  error: REFRESH_INTERVAL_MS,
  missing: 10 * REFRESH_INTERVAL_MS,
  auth: 15 * REFRESH_INTERVAL_MS,
  old: 24 * 60 * REFRESH_INTERVAL_MS,
  shape: 24 * 60 * REFRESH_INTERVAL_MS,
};

export interface RefreshState {
  readonly lastAttemptAt: number;
  readonly nextRefreshAt: number;
  readonly nextAppServerAt: number;
  readonly outcome: RefreshOutcome;
  readonly binKey: string | null;
  readonly codexFound: boolean;
}

type StoredState = Result<RefreshState | null, "unsafe" | "too_large" | "bad_state">;

function isOutcome(value: unknown): value is RefreshOutcome {
  return typeof value === "string" && Object.hasOwn(BACKOFF_MS, value);
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function readRefreshState(dataDir: string, deps: FsDeps = defaultDeps()): StoredState {
  const text = readOwnFile(join(dataDir, REFRESH_STATE_FILE), STATE_CAP_BYTES, deps);
  if (!text.ok) return text.error === "missing" ? ok(null) : err(text.error);
  const parsed = parseJson(text.value);
  const row = parsed.ok ? asRow(parsed.value) : null;
  if (row === null) return err("bad_state");
  const { lastAttemptAt, nextRefreshAt, nextAppServerAt, outcome, binKey, codexFound } = row;
  if (!isTime(lastAttemptAt) || !isTime(nextRefreshAt) || !isTime(nextAppServerAt) || !isOutcome(outcome)
    || (binKey !== null && (typeof binKey !== "string" || !BIN_KEY.test(binKey))) || typeof codexFound !== "boolean") {
    return err("bad_state");
  }
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

function changedBinary(state: RefreshState, binKey: string | null): boolean {
  return binKey !== null && binKey !== state.binKey;
}

// Reuse this check under the lock with a fresh state read and before any state write.
export function refreshDue(readingAt: number | null, state: RefreshState | null, now: number, resolveBinKey: () => string | null): boolean {
  if (readingAt !== null && now - readingAt < REFRESH_INTERVAL_MS) return false;
  if (state === null) return true;
  return now >= state.nextRefreshAt || (binaryBackoff(state) && changedBinary(state, resolveBinKey()));
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
  // A new binary ends the long backoff, not the first minute after an attempt.
  const retryFloor = state.nextAppServerAt - backoffMs(state.outcome) + REFRESH_INTERVAL_MS;
  if (binaryBackoff(state) && now >= retryFloor && changedBinary(state, binKey)) return "open";
  return "backoff";
}
