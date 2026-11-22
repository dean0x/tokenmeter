import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  ACCOUNT_MAX_AGE_MS, ACCOUNT_USAGE_FILE, USAGE_INTERVAL_MS, readAccountFile, writeAccountFile, type AccountFile,
} from "../src/account-usage.ts";
import { writeAppServerSetting } from "../src/config.ts";
import { STORE_VERSION } from "../src/core.ts";
import { defaultDeps } from "../src/fsafe.ts";
import { readRefreshState, REFRESH_INTERVAL_MS, writeRefreshState } from "../src/gate.ts";
import { readCodexLatest } from "../src/quota.ts";
import { refresh } from "../src/refresh.ts";
import { resolveCodex } from "../src/spawn.ts";
import type { StatusOutputData } from "../src/status.ts";
import { writeFakeCodex, type FakeMode } from "./fixtures/fake-codex.mjs";
import { installSuiteGuard, makeSandbox, type Sandbox } from "./helpers.ts";

installSuiteGuard();
const BIN = join(import.meta.dirname, "..", "bin", "tokenmeter.js");
const NOW = Date.now();
const posix = { skip: process.platform === "win32" };

function setup(t: TestContext, mode?: FakeMode) {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  const path = box.path("bin");
  const env = { ...box.env, PATH: path };
  if (mode !== undefined) {
    const fake = writeFakeCodex(path, mode);
    const binary = resolveCodex(env);
    assert.ok(binary.ok);
    assert.equal(binary.value.path, fake);
  }
  return { box, env };
}

function rollout(box: Sandbox, at: number, percent: number): void {
  const [year, month, day] = new Date(at).toISOString().slice(0, 10).split("-");
  assert.ok(year && month && day);
  const path = join(box.home, ".codex", "sessions", year, month, day, "rollout-test.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({
    timestamp: new Date(at).toISOString(), type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: {
      used_percent: percent, window_minutes: 300, resets_at: Math.floor(at / 1000) + 3600,
    } } },
  }) + "\n");
}

const LIMITS = { result: { rateLimits: { primary: {
  usedPercent: 33, windowDurationMins: 300, resetsAt: Math.floor(NOW / 1000) + 3600,
} } } };
const CANARY = "account-reply-canary";
const DATE = new Date(NOW - 86_400_000).toISOString().slice(0, 10);
const USAGE_OK = JSON.stringify({ id: 3, result: {
  dailyUsageBuckets: [{ startDate: DATE, tokens: 123, extra: CANARY }], threadUsage: [CANARY], summary: CANARY,
} });

interface ReplyOptions {
  readonly afterLimits?: "exit0" | "exit1" | undefined;
  readonly switchOffOn?: "account/rateLimits/read" | "account/usage/read";
}

function replies(box: Sandbox, result: object | null, usage?: readonly string[], options: ReplyOptions = {}): void {
  writeFileSync(join(box.dataDir, "rpc-replies.json"), JSON.stringify({
    initialize: ['{"id":1,"result":{}}'], limits: result === null ? [] : [JSON.stringify({ id: 2, ...result })],
    usage, ...options,
  }));
}

function runBin(env: NodeJS.ProcessEnv, arg = "refresh", t?: TestContext, now?: number) {
  const clock = now === undefined ? [] : [`--import=data:text/javascript,${encodeURIComponent(`Date.now = () => ${now};`)}`];
  const child = spawn(process.execPath, [...clock, BIN, arg], { env, stdio: ["pipe", "pipe", "pipe"] });
  t?.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM"); });
  const watchdog = setTimeout(() => child.kill("SIGKILL"), 12_000);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString("utf8", 0, 8_192 - stdout.length); });
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString("utf8", 0, 8_192 - stderr.length); });
  // An open input pipe must not delay refresh.
  const done = once(child, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }))
    .finally(() => clearTimeout(watchdog));
  return { child, done };
}

const depsAt = (now: number) => ({ ...defaultDeps(), nowMs: () => now });

function state(box: Sandbox, now = Date.now()) {
  const stored = readRefreshState(box.dataDir, depsAt(now));
  return stored.ok ? stored.value : null;
}

async function pass(box: Sandbox, env: NodeJS.ProcessEnv, now = NOW) {
  const result = await refresh(box.dataDir, { homeDir: box.home, env }, depsAt(now));
  assert.ok(result.ok);
}

function assertQuiet(run: Awaited<ReturnType<typeof runBin>["done"]>): void {
  assert.deepEqual(run, { code: 0, signal: null, stdout: "", stderr: "" });
}

function accountFile(binKey: string | null, attempt: AccountFile["attempt"] = "error", now = NOW): AccountFile {
  return { version: STORE_VERSION, fetched_at: null, attempt_at: now, attempt, bin_key: binKey, rows: [] };
}

function assertLimits(box: Sandbox): void {
  const stored = state(box, NOW);
  assert.ok(stored?.binKey);
  assert.deepEqual(JSON.parse(readFileSync(join(box.dataDir, "refresh-state.json"), "utf8")), {
    lastAttemptAt: NOW, nextRefreshAt: NOW + REFRESH_INTERVAL_MS, nextAppServerAt: NOW + REFRESH_INTERVAL_MS,
    outcome: "ok", binKey: stored.binKey, codexFound: true,
  });
  assert.deepEqual(readCodexLatest(box.dataDir, NOW), [{
    at: NOW, src: "appserver", window: "five_hour", usedPercent: 33,
    resetsAt: LIMITS.result.rateLimits.primary.resetsAt * 1_000, reached: false,
  }]);
}

const NOTIFICATION = JSON.stringify({ method: "note", params: "x".repeat(32_768) });
const USAGE_ERROR = JSON.stringify({ id: 3, error: { code: -32600, message: CANARY } });
const USAGE_CASES = [
  ["valid rows", [USAGE_OK], "ok"],
  ["code -32601", ['{"id":3,"error":{"code":-32601}}'], "unsupported"],
  ["code -32600", [USAGE_ERROR], "error"],
  ["another error code", ['{"id":3,"error":{"code":-32602}}'], "error"],
  ["a malformed error", ['{"id":3,"error":{"code":"-32601"}}'], "shape"],
  ["a bad result shape", ['{"id":3,"result":{}}'], "shape"],
  ["null buckets", ['{"id":3,"result":{"dailyUsageBuckets":null}}'], "error"],
  ["a non-JSON line", ["{"], "shape"],
  ["a line over 64 KiB", ["x".repeat(65_537)], "too_large"],
  ["total output over 256 KiB", Array<string>(8).fill(NOTIFICATION), "too_large"],
  ["no reply", [], "timeout"],
  ["exit 0", [], "error", "exit0"],
  ["exit 1", [], "error", "exit1"],
] as const;

for (const [name, messages, attempt, afterLimits] of USAGE_CASES) {
  test(`refresh keeps the limits and their schedule with ${name} from usage`, posix, async (t) => {
    const { box, env } = setup(t, "rpc");
    replies(box, LIMITS, messages, { afterLimits });
    await pass(box, env);
    const file = accountFile(state(box)?.binKey ?? null, attempt);
    assertLimits(box);
    assert.deepEqual(readAccountFile(box.dataDir, NOW), attempt === "ok"
      ? { ...file, fetched_at: NOW, rows: [[DATE, 123]] } : file);
  });
}

for (const usage of [USAGE_OK, USAGE_ERROR]) {
  const label = usage === USAGE_OK ? "result" : "error";
  test(`refresh keeps usage ${label} text out of the data folder and command output`, posix, async (t) => {
    const { box, env } = setup(t, "rpc");
    replies(box, LIMITS, [usage]);
    await pass(box, env);
    unlinkSync(join(box.dataDir, "rpc-replies.json"));
    const path = join(box.dataDir, ACCOUNT_USAGE_FILE);
    assert.equal(existsSync(path), true);
    const before = readFileSync(path, "utf8");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal((await runBin(env, "collect", t).done).code, 0);
    assert.equal(readFileSync(path, "utf8"), before);
    for (const name of readdirSync(box.dataDir)) {
      const file = join(box.dataDir, name);
      if (statSync(file).isFile()) assert.equal(readFileSync(file, "utf8").includes(CANARY), false, name);
    }
    for (const command of ["status", "usage"]) {
      const result = await runBin(env, command, t).done;
      assert.equal(result.code, 0);
      assert.equal((result.stdout + result.stderr).includes(CANARY), false, command);
    }
  });
}

test("refresh keeps older rows and their fetch time when the usage read fails", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  const old = { ...accountFile(null, "ok", NOW - USAGE_INTERVAL_MS), fetched_at: NOW - USAGE_INTERVAL_MS,
    rows: [[DATE, 456]] } as const;
  assert.ok(writeAccountFile(box.dataDir, old).ok);
  replies(box, LIMITS, [USAGE_ERROR]);
  await pass(box, env);
  assert.deepEqual(readAccountFile(box.dataDir, NOW), {
    ...old, attempt_at: NOW, attempt: "error", bin_key: state(box)?.binKey,
  });
});

test("refresh reads just limits when it cannot record the usage attempt", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  const path = join(box.dataDir, ACCOUNT_USAGE_FILE);
  writeFileSync(path, "loose account file");
  chmodSync(path, 0o644);
  replies(box, LIMITS, [USAGE_OK]);
  await pass(box, env);
  assertLimits(box);
  assert.equal(existsSync(join(box.dataDir, "usage-calls")), false);
  assert.equal(readFileSync(path, "utf8"), "loose account file");
});

test("a failed final account write leaves the limits and their schedule intact", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, LIMITS, [USAGE_OK]);
  const deps = depsAt(NOW);
  const result = await refresh(box.dataDir, { homeDir: box.home, env }, {
    ...deps, suffix: () => state(box)?.outcome === "ok" ? "" : deps.suffix(),
  });
  assert.ok(result.ok);
  assertLimits(box);
  assert.equal(readFileSync(join(box.dataDir, "usage-calls"), "utf8"), "1\n");
  assert.deepEqual(readAccountFile(box.dataDir, NOW), accountFile(state(box)?.binKey ?? null));
});

test("separate refresh processes retry failed usage at 15 minutes, not before", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, LIMITS, [USAGE_ERROR]);
  // At 14:59 the limits from 14:00 are fresh. At 15:00 both reads are due.
  for (const [elapsed, limits, usage] of [
    [0, 1, 1], [61_000, 2, 1], [USAGE_INTERVAL_MS - REFRESH_INTERVAL_MS, 3, 1],
    [USAGE_INTERVAL_MS - 1_000, 3, 1], [USAGE_INTERVAL_MS, 4, 2],
  ] as const) {
    assertQuiet(await runBin(env, "refresh", t, NOW + elapsed).done);
    assert.equal(readFileSync(join(box.dataDir, "app-server-calls"), "utf8"), "1\n".repeat(limits));
    assert.equal(readFileSync(join(box.dataDir, "usage-calls"), "utf8"), "1\n".repeat(usage));
  }
});

test("refresh is silent and records a missing Codex but still stores the rollout time", posix, async (t) => {
  const { box, env } = setup(t);
  const at = NOW - 9 * REFRESH_INTERVAL_MS;
  rollout(box, at, 18);
  assertQuiet(await runBin(env, "refresh", t).done);
  assert.deepEqual([state(box)?.outcome, state(box)?.codexFound], ["missing", false]);
  assert.deepEqual(readCodexLatest(box.dataDir, NOW).map(({ at, src }) => [at, src]), [[at, "rollouts"]]);
});

test("refresh repairs malformed private state and stores a new rollout reading", posix, async (t) => {
  const { box, env } = setup(t);
  const at = NOW - REFRESH_INTERVAL_MS;
  writeFileSync(join(box.dataDir, "refresh-state.json"), "{", { mode: 0o600 });
  rollout(box, at, 18);
  await pass(box, env);
  assert.equal(state(box)?.lastAttemptAt, NOW);
  assert.equal(state(box)?.outcome, "missing");
  assert.equal(readCodexLatest(box.dataDir, NOW)[0]?.usedPercent, 18);
});

test("refresh leaves malformed state at mode 0644 intact and skips the rollout", posix, async (t) => {
  const { box, env } = setup(t);
  const path = join(box.dataDir, "refresh-state.json");
  writeFileSync(path, "{");
  chmodSync(path, 0o644);
  rollout(box, NOW, 18);
  const result = await refresh(box.dataDir, { homeDir: box.home, env });
  assert.deepEqual(result, { ok: false, error: "unsafe" });
  assert.equal(readFileSync(path, "utf8"), "{");
  assert.deepEqual(readCodexLatest(box.dataDir, NOW), []);
});

test("off prevents all Codex starts from refresh and collect but admits a rollout next cycle", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  assert.ok(writeAppServerSetting(box.dataDir, "off").ok);
  await pass(box, env);
  rollout(box, NOW + 1, 32);
  const next = NOW + REFRESH_INTERVAL_MS;
  await pass(box, env, next);
  const data = readCodexLatest(box.dataDir, next);
  assert.deepEqual(data.map(({ usedPercent, at, src }) => [usedPercent, at, src]), [[32, NOW + 1, "rollouts"]]);
  assert.equal(state(box, next)?.outcome, "off");
  assert.equal((await runBin(env, "collect", t).done).code, 0);
  assert.equal(existsSync(join(box.dataDir, "version-calls")), false);
  assert.equal(existsSync(join(box.dataDir, "usage-calls")), false);
  assert.equal(existsSync(join(box.dataDir, ACCOUNT_USAGE_FILE)), false);
});

test("a switch change after the version probe stops the app-server spawn", posix, async (t) => {
  const { box, env } = setup(t, "rpc-switch-off");
  replies(box, null);
  await pass(box, env);
  assert.equal(state(box)?.outcome, "off");
  assert.equal(readFileSync(join(box.dataDir, "version-calls"), "utf8"), "1\n");
  assert.equal(existsSync(join(box.dataDir, "rpc-input")), false);
});

for (const switchOffOn of ["account/rateLimits/read", "account/usage/read"] as const) {
  test(`a switch change during ${switchOffOn} keeps limits but does not save new usage`, posix, async (t) => {
    const { box, env } = setup(t, "rpc");
    replies(box, LIMITS, [USAGE_OK], { switchOffOn });
    await pass(box, env);
    assertLimits(box);
    assert.equal(existsSync(join(box.dataDir, "usage-calls")), switchOffOn === "account/usage/read");
    assert.deepEqual(readAccountFile(box.dataDir, NOW), accountFile(state(box)?.binKey ?? null));
  });
}

test("with the switch off, status uses the last good account fetch only until it expires", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, LIMITS, [USAGE_OK]);
  await pass(box, env);
  assert.ok(writeAppServerSetting(box.dataDir, "off").ok);
  assert.equal((await runBin(env, "collect", t, NOW).done).code, 0);
  for (const [age, source, total] of [[ACCOUNT_MAX_AGE_MS - 1, "account", 123], [ACCOUNT_MAX_AGE_MS, "logs", 0]] as const) {
    const run = await runBin(env, "status", t, NOW + age).done;
    assert.equal(run.code, 0);
    const { data } = JSON.parse(run.stdout) as { data: StatusOutputData };
    const week = data.subscriptions.find((sub) => sub.id === "codex")?.tokens.week;
    assert.deepEqual([week?.source, week?.total], [source, total]);
  }
  assert.equal(readFileSync(join(box.dataDir, "usage-calls"), "utf8"), "1\n");
});

test("the rollout read continues while sign-in backoff prevents a Codex start", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, { error: { code: -32600 } });
  await pass(box, env);
  const auth = state(box);
  assert.equal(auth?.outcome, "auth");
  assert.equal(auth?.nextAppServerAt, NOW + 15 * REFRESH_INTERVAL_MS);
  rollout(box, NOW, 43);
  const next = NOW + REFRESH_INTERVAL_MS;
  await pass(box, env, next);
  assert.equal(readCodexLatest(box.dataDir, next)[0]?.usedPercent, 43);
  assert.equal(state(box, next)?.nextAppServerAt, auth?.nextAppServerAt);
  assert.equal(readFileSync(join(box.dataDir, "app-server-calls"), "utf8"), "1\n");
  assert.equal(existsSync(join(box.dataDir, "usage-calls")), false);
  assert.deepEqual(readAccountFile(box.dataDir, next), accountFile(auth?.binKey ?? null));
});

test("a new refresher reuses the version result for the same binary", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, { error: { code: -32600 } });
  assertQuiet(await runBin(env, "refresh", t).done);
  const prior = state(box);
  assert.ok(prior && prior.outcome === "auth");
  assert.ok(writeRefreshState(box.dataDir, { ...prior, nextRefreshAt: 0, nextAppServerAt: 0 }).ok);
  replies(box, { error: { code: -32601 } });
  assertQuiet(await runBin(env, "refresh", t).done);
  assert.equal(state(box)?.outcome, "error");
  assert.equal(readFileSync(join(box.dataDir, "version-calls"), "utf8"), "1\n");
});

test("a rollout read error stays visible after the app-server gate completes", posix, async (t) => {
  const { box, env } = setup(t);
  mkdirSync(join(box.home, ".codex"), { recursive: true });
  writeFileSync(join(box.home, ".codex", "sessions"), "");
  const result = await refresh(box.dataDir, { homeDir: box.home, env });
  assert.ok(!result.ok);
  assert.equal(state(box)?.outcome, "missing");
  assert.equal(existsSync(join(box.dataDir, "refresh.lock")), false);
});

test("the off switch replaces a long backoff with the normal wait", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, { error: { code: -32600 } });
  await pass(box, env);
  assert.ok(writeAppServerSetting(box.dataDir, "off").ok);
  const next = NOW + REFRESH_INTERVAL_MS;
  await pass(box, env, next);
  assert.equal(state(box, next)?.outcome, "off");
  assert.ok(writeAppServerSetting(box.dataDir, "on").ok);
  const later = next + REFRESH_INTERVAL_MS;
  await pass(box, env, later);
  assert.equal(state(box, later)?.outcome, "auth");
});

test("two refreshes produce one app-server call and one usage read", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, LIMITS, [USAGE_OK]);
  const runs = await Promise.all([runBin(env, "refresh", t).done, runBin(env, "refresh", t).done]);
  for (const run of runs) assertQuiet(run);
  const previous = state(box);
  assert.ok(previous);
  assert.equal(previous.outcome, "ok");
  assert.equal(readCodexLatest(box.dataDir, Date.now())[0]?.src, "appserver");
  assert.equal(readFileSync(join(box.dataDir, "app-server-calls"), "utf8"), "1\n");
  assert.equal(readFileSync(join(box.dataDir, "usage-calls"), "utf8"), "1\n");
  assert.ok(writeRefreshState(box.dataDir, { ...previous, nextRefreshAt: 0, nextAppServerAt: 0 }).ok);
  assertQuiet(await runBin(env, "refresh", t).done);
  assert.equal(state(box)?.nextRefreshAt, 0);
});

test("stores the rollout before a hung Codex times out and kills the Codex process", { ...posix, timeout: 10_000 }, async (t) => {
  const { box, env } = setup(t, "rpc");
  rollout(box, NOW - REFRESH_INTERVAL_MS, 55);
  replies(box, null);
  const run = runBin(env, "refresh", t);
  const pid = await waitForServer(box);
  assert.equal(readCodexLatest(box.dataDir, Date.now())[0]?.usedPercent, 55);
  const attempt = state(box);
  assert.ok(attempt && attempt.nextAppServerAt >= attempt.lastAttemptAt + REFRESH_INTERVAL_MS);
  assertQuiet(await run.done);
  const timedOut = state(box);
  assert.ok(timedOut && timedOut.outcome === "timeout");
  assert.equal(defaultDeps().isAlive(pid), false);
  const early = timedOut.lastAttemptAt + REFRESH_INTERVAL_MS - 1;
  await pass(box, env, early);
  assert.equal(readFileSync(join(box.dataDir, "app-server-calls"), "utf8"), "1\n");
  assert.deepEqual(state(box, early), timedOut);
});

async function waitForUsage(box: Sandbox): Promise<boolean> {
  const path = join(box.dataDir, "usage-calls");
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (existsSync(path)) return true;
    await delay(10);
  }
  return false;
}

test("SIGTERM during usage keeps limits and the attempt, and releases the lock", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, LIMITS, []);
  const run = runBin(env, "refresh", t, NOW);
  const pid = await waitForServer(box);
  const requested = await waitForUsage(box);
  const attempt = readAccountFile(box.dataDir, NOW);
  const locked = existsSync(join(box.dataDir, "refresh.lock"));
  if (requested) assert.equal(run.child.kill("SIGTERM"), true);
  assertQuiet(await run.done);
  assert.equal(requested, true);
  assert.equal(locked, true);
  assert.deepEqual(attempt, accountFile(state(box)?.binKey ?? null));
  assertLimits(box);
  assert.equal(defaultDeps().isAlive(pid), false);
  assert.equal(existsSync(join(box.dataDir, "refresh.lock")), false);
  assertQuiet(await runBin(env, "refresh", t, NOW + 61_000).done);
  assert.equal(readFileSync(join(box.dataDir, "app-server-calls"), "utf8"), "1\n1\n");
  assert.equal(readFileSync(join(box.dataDir, "usage-calls"), "utf8"), "1\n");
  assert.deepEqual(readAccountFile(box.dataDir, NOW + 61_000), attempt);
});

test("time spent on usage does not move the next limits attempt", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, LIMITS, []);
  const controller = new AbortController();
  let now = NOW;
  const run = refresh(box.dataDir, { homeDir: box.home, env, signal: controller.signal }, {
    ...defaultDeps(), nowMs: () => now,
  });
  const requested = await waitForUsage(box);
  now += 2_000;
  controller.abort();
  assert.ok((await run).ok);
  assert.equal(requested, true);
  assertLimits(box);
});

async function waitForServer(box: Sandbox): Promise<number> {
  const marker = join(box.dataDir, "rpc-pid");
  for (let read = 0; read < 300; read += 1) {
    const pid = existsSync(marker) ? Number(readFileSync(marker, "utf8")) : 0;
    if (Number.isInteger(pid) && pid > 0) return pid;
    await delay(10);
  }
  assert.fail("the fake app-server did not start");
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  test(`${signal} ends the call and releases the refresh lock`, { ...posix, timeout: 8_000 }, async (t) => {
    const { box, env } = setup(t, "rpc");
    replies(box, null);
    const run = runBin(env, "refresh", t);
    const pid = await waitForServer(box);
    assert.equal(run.child.kill(signal), true);
    assertQuiet(await run.done);
    assert.equal(defaultDeps().isAlive(pid), false);
    assert.equal(state(box)?.outcome, "error");
    assert.equal(existsSync(join(box.dataDir, "refresh.lock")), false);
  });
}

test("refresh leaves an absent token store absent and preserves the pending backfill mark", posix, async (t) => {
  const { box, env } = setup(t);
  const pendingDays = '{"version":1,"backfilled":false,"cutThrough":null,"days":{}}\n';
  const files = ["days.json", "ledger.json", "store.json", "collect.lock"];
  const metadata = (file: string) => {
    const { ino, mtimeMs } = statSync(join(box.dataDir, file));
    return { ino, mtimeMs };
  };
  const initialTime = new Date("2020-01-01T00:00:00Z");
  for (const file of files) {
    const path = join(box.dataDir, file);
    writeFileSync(path, pendingDays, { mode: 0o600 });
    utimesSync(path, initialTime, initialTime);
  }
  const before = files.map(metadata);
  await pass(box, env);
  assert.equal(state(box)?.outcome, "missing");
  for (const file of files) assert.equal(readFileSync(join(box.dataDir, file), "utf8"), pendingDays);
  assert.deepEqual(files.map(metadata), before);

  const empty = setup(t);
  rollout(empty.box, NOW, 18);
  await pass(empty.box, empty.env);
  assert.deepEqual(readdirSync(empty.box.dataDir).filter((name) => files.includes(name)), []);
  assert.equal(readCodexLatest(empty.box.dataDir, NOW)[0]?.usedPercent, 18);
});
