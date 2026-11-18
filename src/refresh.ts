import { homedir } from "node:os";
import { join } from "node:path";
import { readAppServerLimits } from "./appserver.ts";
import { readCodexTail } from "./codex-tail.ts";
import { readAppServerSetting } from "./config.ts";
import { ok, type Result } from "./core.ts";
import { defaultDeps, prepareDataDir, releaseLock, resolveDataDirPath, type FsDeps, type FsError } from "./fsafe.ts";
import {
  acquireRefreshLock, appServerGate, backoffMs, readRefreshState, refreshDue, REFRESH_INTERVAL_MS,
  writeRefreshState, type RefreshOutcome, type RefreshState,
} from "./gate.ts";
import { readCodexLatest, storeAppServerReading, storeCodexQuota } from "./quota.ts";
import { resolveCodex, type ResolvedCodex } from "./spawn.ts";

const DEADLINE_MS = 15_000;

type RefreshError = FsError | "unsafe" | "too_large" | "bad_state";

interface RefreshOptions {
  readonly homeDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
}

type ActiveOptions = RefreshOptions & { readonly signal: AbortSignal };

function startRecord(prior: RefreshState | null, now: number): RefreshState {
  return {
    nextAppServerAt: 0, outcome: "error", binKey: null, codexFound: false,
    ...prior, lastAttemptAt: now, nextRefreshAt: now + REFRESH_INTERVAL_MS,
  };
}

async function refreshAppServer(
  dataDir: string,
  prior: RefreshState | null,
  current: RefreshState,
  codex: ResolvedCodex | null,
  options: ActiveOptions,
  timeLeft: () => boolean,
  deps: FsDeps,
): Promise<Result<null, FsError>> {
  const binKey = codex?.binKey ?? null;
  const gate = appServerGate(dataDir, prior, binKey, deps);
  if (gate === "off") {
    const nextAppServerAt = Math.min(current.nextAppServerAt, deps.nowMs() + REFRESH_INTERVAL_MS);
    return writeRefreshState(dataDir, { ...current, outcome: "off", nextAppServerAt }, deps);
  }
  if (gate === "backoff" || !timeLeft()) return writeRefreshState(dataDir, current, deps);

  // The record must survive an interruption before or during either child start.
  const attempt: RefreshState = {
    ...current, binKey, outcome: "error", nextAppServerAt: deps.nowMs() + REFRESH_INTERVAL_MS,
  };
  const recorded = writeRefreshState(dataDir, attempt, deps);
  if (!recorded.ok) return recorded;

  let switchedOff = false;
  const reading = await readAppServerLimits(codex, {
    cwd: dataDir, env: options.env, now: deps.nowMs, signal: options.signal,
    mayStart: () => {
      switchedOff = readAppServerSetting(dataDir, deps) === "off";
      return !switchedOff && timeLeft();
    },
  });
  let outcome: RefreshOutcome;
  if (switchedOff) outcome = "off";
  else if (!reading.ok) outcome = reading.error;
  else outcome = storeAppServerReading(dataDir, reading.value, deps).ok ? "ok" : "error";
  return writeRefreshState(dataDir, { ...attempt, outcome, nextAppServerAt: deps.nowMs() + backoffMs(outcome) }, deps);
}

async function refreshLocked(
  dataDir: string, options: ActiveOptions, timeLeft: () => boolean, deps: FsDeps,
): Promise<Result<null, RefreshError>> {
  const prior = readRefreshState(dataDir, deps);
  if (!prior.ok) return prior;
  const now = deps.nowMs();
  let readingAt: number | null = null;
  for (const sample of readCodexLatest(dataDir, now, deps)) readingAt = Math.max(readingAt ?? 0, sample.at);
  let binary: ReturnType<typeof resolveCodex> | undefined;
  const resolveOnce = (): ResolvedCodex | null => {
    binary ??= resolveCodex(options.env);
    return binary.ok ? binary.value : null;
  };
  if (!timeLeft() || !refreshDue(readingAt, prior.value, now, () => resolveOnce()?.binKey ?? null)) return ok(null);

  const started = startRecord(prior.value, now);
  const marked = writeRefreshState(dataDir, started, deps);
  if (!marked.ok) return marked;
  const codex = resolveOnce();
  const current = { ...started, codexFound: codex !== null };

  // The log and app-server reads can succeed independently of each other.
  const tail = readCodexTail(join(options.homeDir, ".codex", "sessions"), now, deps);
  const logs = tail.ok && tail.value.length > 0 ? storeCodexQuota(dataDir, tail.value, deps) : tail;
  const server = await refreshAppServer(dataDir, prior.value, current, codex, options, timeLeft, deps);
  return logs.ok ? server : logs;
}

export async function refresh(
  path: string, options: RefreshOptions, deps: FsDeps = defaultDeps(),
): Promise<Result<null, RefreshError>> {
  const deadline = performance.now() + DEADLINE_MS;
  const timeout = AbortSignal.timeout(DEADLINE_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  const timeLeft = () => !signal.aborted && performance.now() < deadline;
  if (!timeLeft()) return ok(null);
  const dir = prepareDataDir(path, deps);
  if (!dir.ok) return dir;
  const lock = acquireRefreshLock(dir.value, deps);
  if (!lock.ok) return lock.error.code === "lock_held" ? ok(null) : lock;
  try {
    return await refreshLocked(dir.value, { ...options, signal }, timeLeft, deps);
  } finally {
    releaseLock(lock.value, deps);
  }
}

export async function refreshMain(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  try {
    const homeDir = homedir();
    const env = process.env;
    const path = resolveDataDirPath({ homeDir, env, platform: process.platform, flag: null });
    await refresh(path, { homeDir, env, signal: controller.signal });
  } finally {
    process.off("SIGTERM", stop);
    process.off("SIGINT", stop);
  }
}
