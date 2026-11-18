import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { writeAppServerSetting } from "../src/config.ts";
import { defaultDeps } from "../src/fsafe.ts";
import { readRefreshState, REFRESH_INTERVAL_MS, writeRefreshState } from "../src/gate.ts";
import { readCodexLatest } from "../src/quota.ts";
import { refresh } from "../src/refresh.ts";
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
  if (mode !== undefined) writeFakeCodex(path, mode);
  return { box, env: { ...box.env, PATH: path } };
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

function replies(box: Sandbox, result: object | null): void {
  writeFileSync(join(box.dataDir, "rpc-replies.json"), JSON.stringify({
    initialize: ['{"id":1,"result":{}}'], limits: result === null ? [] : [JSON.stringify({ id: 2, ...result })],
  }));
}

function runBin(env: NodeJS.ProcessEnv, arg = "refresh", t?: TestContext) {
  const child = spawn(process.execPath, [BIN, arg], { env, stdio: ["pipe", "pipe", "pipe"] });
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

function state(box: Sandbox) {
  const stored = readRefreshState(box.dataDir);
  return stored.ok ? stored.value : null;
}

async function pass(box: Sandbox, env: NodeJS.ProcessEnv, now = NOW) {
  const result = await refresh(box.dataDir, { homeDir: box.home, env }, { ...defaultDeps(), nowMs: () => now });
  assert.ok(result.ok);
}

function assertQuiet(run: Awaited<ReturnType<typeof runBin>["done"]>): void {
  assert.deepEqual(run, { code: 0, signal: null, stdout: "", stderr: "" });
}

test("refresh is silent and records a missing Codex but still stores the rollout time", posix, async (t) => {
  const { box, env } = setup(t);
  const at = NOW - 9 * REFRESH_INTERVAL_MS;
  rollout(box, at, 18);
  assertQuiet(await runBin(env, "refresh", t).done);
  assert.deepEqual([state(box)?.outcome, state(box)?.codexFound], ["missing", false]);
  assert.deepEqual(readCodexLatest(box.dataDir, NOW).map(({ at, src }) => [at, src]), [[at, "rollouts"]]);
});

test("off prevents all Codex starts from refresh and collect but admits a rollout next cycle", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  assert.ok(writeAppServerSetting(box.dataDir, "off").ok);
  await pass(box, env);
  rollout(box, NOW + 1, 32);
  await pass(box, env, NOW + REFRESH_INTERVAL_MS);
  const data = readCodexLatest(box.dataDir, NOW + REFRESH_INTERVAL_MS);
  assert.deepEqual(data.map(({ usedPercent, at, src }) => [usedPercent, at, src]), [[32, NOW + 1, "rollouts"]]);
  assert.equal(state(box)?.outcome, "off");
  assert.equal((await runBin(env, "collect", t).done).code, 0);
  assert.equal(existsSync(join(box.dataDir, "version-calls")), false);
});

test("a switch change after the version probe stops the app-server spawn", posix, async (t) => {
  const { box, env } = setup(t, "rpc-switch-off");
  replies(box, null);
  await pass(box, env);
  assert.equal(state(box)?.outcome, "off");
  assert.equal(readFileSync(join(box.dataDir, "version-calls"), "utf8"), "1\n");
  assert.equal(existsSync(join(box.dataDir, "rpc-input")), false);
});

test("the rollout read continues while sign-in backoff prevents a Codex start", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, { error: { code: -32600 } });
  await pass(box, env);
  const auth = state(box);
  assert.equal(auth?.outcome, "auth");
  assert.equal(auth?.nextAppServerAt, NOW + 15 * REFRESH_INTERVAL_MS);
  rollout(box, NOW, 43);
  await pass(box, env, NOW + REFRESH_INTERVAL_MS);
  assert.equal(readCodexLatest(box.dataDir, NOW)[0]?.usedPercent, 43);
  assert.equal(state(box)?.nextAppServerAt, auth?.nextAppServerAt);
  assert.equal(readFileSync(join(box.dataDir, "rpc-input"), "utf8").split("account/rateLimits/read").length - 1, 1);
});

test("two refreshes produce one app-server call and a fresh reading stops a new attempt", posix, async (t) => {
  const { box, env } = setup(t, "rpc");
  replies(box, { result: { rateLimits: { primary: {
    usedPercent: 33, windowDurationMins: 300, resetsAt: Math.floor(NOW / 1000) + 3600,
  } } } });
  const runs = await Promise.all([runBin(env, "refresh", t).done, runBin(env, "refresh", t).done]);
  for (const run of runs) assertQuiet(run);
  const previous = state(box);
  assert.ok(previous);
  assert.equal(previous.outcome, "ok");
  assert.equal(readCodexLatest(box.dataDir, Date.now())[0]?.src, "appserver");
  assert.equal(readFileSync(join(box.dataDir, "version-calls"), "utf8"), "1\n");
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
  assert.equal(state(box)?.outcome, "timeout");
  assert.equal(defaultDeps().isAlive(pid), false);
  assertQuiet(await runBin(env, "refresh", t).done);
  assert.equal(readFileSync(join(box.dataDir, "version-calls"), "utf8"), "1\n");
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
  for (const file of files) writeFileSync(join(box.dataDir, file), pendingDays, { mode: 0o600 });
  await pass(box, env);
  assert.equal(state(box)?.outcome, "missing");
  for (const file of files) assert.equal(readFileSync(join(box.dataDir, file), "utf8"), pendingDays);

  const empty = setup(t);
  rollout(empty.box, NOW, 18);
  await pass(empty.box, empty.env);
  assert.deepEqual(readdirSync(empty.box.dataDir).filter((name) => files.includes(name)), []);
  assert.equal(readCodexLatest(empty.box.dataDir, NOW)[0]?.usedPercent, 18);
});
