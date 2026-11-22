import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { USAGE_INTERVAL_MS, writeAccountFile } from "../src/account-usage.ts";
import { writeAppServerSetting } from "../src/config.ts";
import { SCHEMA_ID, STORE_VERSION, asRow, parseJson } from "../src/core.ts";
import { readRefreshState, writeRefreshState, type RefreshOutcome } from "../src/gate.ts";
import { storeAppServerReading, storeCodexQuota } from "../src/quota.ts";
import { resolveCodex } from "../src/spawn.ts";
import { writeFakeCodex } from "./fixtures/fake-codex.mjs";
import { installSuiteGuard, makeSandbox, type Sandbox } from "./helpers.ts";
import { observeStarts, probeStarts } from "./spawn-probe.ts";

installSuiteGuard();
const ROOT = resolve(import.meta.dirname, "..");
const BIN = join(ROOT, "bin", "tokenmeter.js");
const NOW = Date.now();
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ROLLOUT_RESET = Math.floor((NOW + MINUTE) / 1000);
const POSIX = { skip: process.platform === "win32" };
const EMPTY = { schema: SCHEMA_ID, ok: true, data: { hud: 1, codex: null } };

function preload(source: string): string {
  return `--import=data:text/javascript,${encodeURIComponent(source)}`;
}

const CLOCK = preload(`Date.now = () => ${NOW};`);

function setup(t: TestContext) {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  return { box, env: { ...box.env, PATH: box.path("bin") } };
}

function envelope(stdout: string): Record<string, unknown> {
  const parsed = parseJson(stdout);
  const value = parsed.ok ? asRow(parsed.value) : null;
  assert.ok(value !== null, stdout);
  assert.equal(value.schema, SCHEMA_ID);
  assert.equal(value.ok, true, stdout);
  return value;
}

function runHud(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const child = spawnSync(process.execPath, [CLOCK, BIN, "hud"], { env, encoding: "utf8", timeout: 2_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(child.stderr, "");
  return envelope(child.stdout);
}

function deferRefresh(box: Sandbox, outcome: RefreshOutcome, codexFound: boolean, now = NOW): void {
  assert.ok(writeRefreshState(box.dataDir, {
    lastAttemptAt: now, nextRefreshAt: now + MINUTE, nextAppServerAt: now + MINUTE,
    outcome, binKey: null, codexFound,
  }).ok);
}

function storeRollout(box: Sandbox, at: number, reached = false): void {
  assert.ok(storeCodexQuota(box.dataDir, [{
    window: "five_hour", at, usedPercent: 24, resetsAt: at + MINUTE, reached,
  }]).ok);
}

function expectedRollout(at: number, limit_reached = false, resets_at = at + MINUTE) {
  return { schema: SCHEMA_ID, ok: true, data: { hud: 1, codex: {
    at, limit_reached, windows: [{ window_minutes: 300, pct: 24, resets_at, at, source: "rollouts" }],
  } } };
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 8_000;
  for (let i = 0; i < 800 && performance.now() < deadline; i += 1) {
    if (check()) return;
    await delay(10);
  }
  assert.fail("The detached refresh did not reach the expected state");
}

function finished(box: Sandbox, outcome: RefreshOutcome): boolean {
  const state = readRefreshState(box.dataDir);
  return state.ok && state.value?.outcome === outcome && !existsSync(join(box.dataDir, "refresh.lock"));
}

test("hud starts one refresher but does not create the missing data folder itself", (t) => {
  const box = makeSandbox(t);
  const { stdout, starts } = probeStarts(box, "hud", { ...box.env, PATH: box.path("bin") });
  const bin = realpathSync.native(BIN);
  assert.deepEqual(envelope(stdout), EMPTY);
  assert.equal(existsSync(box.dataDir), false);
  assert.deepEqual(starts, [
    ["spawn", process.execPath, [bin, "refresh"], dirname(bin), true, "ignore", "",
      ["HOME", "PATH", "TMPDIR", "TOKENMETER_DATA_DIR"]],
  ]);
});

test("hud can start a refresher when several parent folders are missing", POSIX, (t) => {
  const box = makeSandbox(t);
  const env = { ...box.env, PATH: box.path("bin"), TOKENMETER_DATA_DIR: box.path("new", "parent", "data") };
  const { stdout, starts } = probeStarts(box, "hud", env);
  assert.deepEqual(envelope(stdout), EMPTY);
  assert.equal(starts.length, 1);
  assert.equal(existsSync(box.path("new")), false);
});

test("repeated HUD calls start no refresher when the data folder has a group-writable parent", POSIX, (t) => {
  const box = makeSandbox(t);
  const parent = box.path("shared");
  mkdirSync(parent);
  chmodSync(parent, 0o770);
  const env = { ...box.env, PATH: box.path("bin"), TOKENMETER_DATA_DIR: join(parent, "data") };
  const first = probeStarts(box, "hud", env);
  const second = probeStarts(box, "hud", env);
  assert.deepEqual(envelope(first.stdout), EMPTY);
  assert.deepEqual(envelope(second.stdout), EMPTY);
  assert.deepEqual([first.starts.length, second.starts.length], [0, 0]);
  assert.equal(existsSync(env.TOKENMETER_DATA_DIR), false);
});

for (const kind of ["data folder", "nearest existing ancestor"] as const) {
  test(`hud starts no refresher when the ${kind} is read-only`, {
    skip: process.platform === "win32" || process.getuid?.() === 0,
  }, (t) => {
    const { box, env } = setup(t);
    const path = kind === "data folder" ? box.dataDir : box.path("ancestor");
    if (kind === "nearest existing ancestor") mkdirSync(path, { mode: 0o700 });
    const dataDir = kind === "data folder" ? path : join(path, "missing", "data");
    chmodSync(path, 0o500);
    try {
      const { stdout, starts } = probeStarts(box, "hud", { ...env, TOKENMETER_DATA_DIR: dataDir });
      assert.deepEqual(envelope(stdout), EMPTY);
      assert.deepEqual(starts, []);
    } finally {
      chmodSync(path, 0o700);
    }
  });
}

test("hud returns an error envelope when its main function throws", (t) => {
  const box = makeSandbox(t);
  const failHome = preload(`
    import os from 'node:os';
    import { syncBuiltinESMExports } from 'node:module';
    os.homedir = () => { throw new Error('No home folder'); };
    syncBuiltinESMExports();
  `);
  const child = spawnSync(process.execPath, [failHome, BIN, "hud"], { env: box.env, encoding: "utf8", timeout: 2_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 1);
  assert.deepEqual(parseJson(child.stdout), { ok: true, value: {
    schema: SCHEMA_ID, ok: false, error: { code: "internal_error", hint: "An internal error occurred." },
  } });
  assert.equal(child.stderr, "");
});

test("hud rejects extra arguments instead of starting a refresh", (t) => {
  const box = makeSandbox(t);
  const child = spawnSync(process.execPath, [BIN, "hud", "--unknown"], {
    env: { ...box.env, PATH: box.path("bin") }, encoding: "utf8", timeout: 2_000,
  });
  assert.equal(child.status, 2);
  const parsed = parseJson(child.stdout);
  assert.ok(parsed.ok);
  assert.equal(asRow(asRow(parsed.value)?.error)?.code, "usage_error");
  assert.equal(existsSync(box.dataDir), false);
});

test("hud ignores a linked data folder and starts no refresher", POSIX, (t) => {
  const { box, env } = setup(t);
  storeRollout(box, NOW - MINUTE);
  const linked = box.path("linked-data");
  symlinkSync(box.dataDir, linked);
  const { stdout, starts } = probeStarts(box, "hud", { ...env, TOKENMETER_DATA_DIR: linked });
  assert.deepEqual(envelope(stdout), EMPTY);
  assert.deepEqual(starts, []);
});

test("hud keeps a nine-minute rollout and drops it at ten minutes when Codex is missing", (t) => {
  const { box, env } = setup(t);
  const boundary = NOW - 10 * MINUTE;
  deferRefresh(box, "missing", false);
  storeRollout(box, boundary);
  assert.deepEqual(runHud(env), EMPTY);
  storeRollout(box, NOW - 9 * MINUTE);
  assert.deepEqual(runHud(env), expectedRollout(NOW - 9 * MINUTE));
});

test("hud drops a ten-minute rollout with the switch off and Codex missing", (t) => {
  const { box, env } = setup(t);
  assert.ok(writeAppServerSetting(box.dataDir, "off").ok);
  deferRefresh(box, "off", false);
  storeRollout(box, NOW - 10 * MINUTE);
  assert.deepEqual(runHud(env), EMPTY);
});

for (const outcome of ["ok", "auth", "old", "shape", "timeout", "error", "off"] as const) {
  test(`hud keeps a ten-minute rollout when Codex is found and the outcome is ${outcome}`, (t) => {
    const { box, env } = setup(t);
    if (outcome === "off") assert.ok(writeAppServerSetting(box.dataDir, "off").ok);
    deferRefresh(box, outcome, true);
    const at = NOW - 10 * MINUTE;
    storeRollout(box, at);
    assert.deepEqual(runHud(env), expectedRollout(at));
    assert.equal(existsSync(join(box.dataDir, "refresh.lock")), false);
  });
}

for (const [age, starts] of [[MINUTE, 1], [0, 0]] as const) {
  test(`hud starts ${starts} refresh when usage is due and limits are ${age === 0 ? "fresh" : "due"}`, POSIX, (t) => {
    const { box, env } = setup(t);
    assert.ok(writeAccountFile(box.dataDir, {
      version: STORE_VERSION, fetched_at: null, attempt_at: NOW - USAGE_INTERVAL_MS,
      attempt: "error", bin_key: null, rows: [],
    }).ok);
    assert.ok(storeAppServerReading(box.dataDir, [{
      window: "week", at: NOW - age, usedPercent: 82, resetsAt: NOW + DAY, reached: false,
    }]).ok);
    const observed = observeStarts(box, "hud", (observer) =>
      spawnSync(process.execPath, [observer, CLOCK, BIN, "hud"], { env, encoding: "utf8", timeout: 2_000 }));
    assert.ifError(observed.result.error);
    assert.equal(observed.result.status, 0, observed.result.stderr);
    assert.equal(observed.starts.length, starts);
  });
}

test("hud omits a window older than eight days and keeps a reached flag from the rollouts", (t) => {
  const { box, env } = setup(t);
  const old = NOW - 8 * DAY - 1;
  assert.ok(storeAppServerReading(box.dataDir, [{
    window: "week", at: old, usedPercent: 82, resetsAt: old + DAY, reached: false,
  }]).ok);
  storeRollout(box, NOW, true);
  assert.deepEqual(runHud(env), expectedRollout(NOW, true));
});

test("hud keeps both sources in window order and uses only the newest time for the reached flag", (t) => {
  const { box, env } = setup(t);
  storeRollout(box, NOW - MINUTE, true);
  const base = { window: "week", at: NOW, usedPercent: 82, resetsAt: NOW + DAY } as const;
  const windows = [
    { window_minutes: 300, pct: 24, resets_at: NOW, at: NOW - MINUTE, source: "rollouts" },
    { window_minutes: 10080, pct: 82, resets_at: NOW + DAY, at: NOW, source: "appserver" },
  ];
  for (const reached of [false, true]) {
    assert.ok(storeAppServerReading(box.dataDir, [{ ...base, reached }]).ok);
    assert.deepEqual(runHud(env), { schema: SCHEMA_ID, ok: true, data: { hud: 1, codex: {
      at: NOW, limit_reached: reached, windows,
    } } });
  }
});

function writeRollout(box: Sandbox): void {
  const day = new Date(NOW).toISOString().slice(0, 10).split("-");
  const sessions = join(box.home, ".codex", "sessions", ...day);
  mkdirSync(sessions, { recursive: true });
  writeFileSync(join(sessions, "rollout-test.jsonl"), JSON.stringify({
    timestamp: new Date(NOW).toISOString(), type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: {
      used_percent: 24, window_minutes: 300, resets_at: ROLLOUT_RESET,
    } } },
  }) + "\n");
}

test("the first detached refresh creates a private data folder and stores the rollout reading", POSIX, async (t) => {
  const box = makeSandbox(t);
  const env = { ...box.env, PATH: box.path("bin") };
  writeRollout(box);
  assert.deepEqual(runHud(env), EMPTY);
  await waitFor(() => finished(box, "missing"));
  assert.equal(statSync(box.dataDir).mode & 0o777, 0o700);
  assert.deepEqual(runHud(env), expectedRollout(NOW, false, ROLLOUT_RESET * 1000));
});

test("hud returns stored data and refreshes rollouts without starting Codex when the switch is off", POSIX, async (t) => {
  const { box, env } = setup(t);
  const fake = writeFakeCodex(env.PATH, "rpc");
  assert.equal(resolveCodexPath(env), fake);
  assert.ok(writeAppServerSetting(box.dataDir, "off").ok);
  writeRollout(box);
  assert.deepEqual(runHud(env), EMPTY);
  await waitFor(() => finished(box, "off"));
  assert.equal(existsSync(join(box.dataDir, "version-calls")), false);
  assert.deepEqual(runHud(env), expectedRollout(NOW, false, ROLLOUT_RESET * 1000));
});

function resolveCodexPath(env: NodeJS.ProcessEnv): string | null {
  const binary = resolveCodex(env);
  return binary.ok ? binary.value.path : null;
}

test("hud closes stdout within 300 ms with stdin open and a detached refresh still active", POSIX, async (t) => {
  const { box, env } = setup(t);
  const fake = writeFakeCodex(env.PATH, "rpc");
  assert.equal(resolveCodexPath(env), fake);
  writeFileSync(join(box.dataDir, "rpc-replies.json"), JSON.stringify({
    initialize: [JSON.stringify({ id: 1, result: {} })], limits: [],
  }));
  const start = performance.now();
  const child = spawn(process.execPath, [BIN, "hud"], { env, stdio: ["pipe", "pipe", "pipe"], signal: AbortSignal.timeout(2_000) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (bytes: Buffer) => { stdout += bytes.toString("utf8", 0, 4_097 - stdout.length); });
  child.stderr.on("data", (bytes: Buffer) => { stderr += bytes.toString("utf8", 0, 4_097 - stderr.length); });
  const [code, signal] = await once(child, "close");
  const elapsed = performance.now() - start;
  try {
    assert.deepEqual({ code, signal, stderr }, { code: 0, signal: null, stderr: "" });
    assert.ok(elapsed < 300, `HUD stdout took ${elapsed.toFixed(0)} ms to close`);
    assert.ok(Buffer.byteLength(stdout) <= 4_096);
    assert.equal(stdout, `${JSON.stringify(EMPTY)}\n`);
    await waitFor(() => existsSync(join(box.dataDir, "rpc-pid")));
    assert.equal(existsSync(join(box.dataDir, "refresh.lock")), true);
  } finally {
    if (existsSync(join(box.dataDir, "refresh.lock"))) await waitFor(() => finished(box, "timeout"));
  }
});

test("doctor, status and hud emit envelopes from the installed tarball", POSIX, (t) => {
  const { box } = setup(t);
  // This fixture is already due on the wall clock. Use its own clock for the packed binary.
  const packedNow = NOW - 2 * MINUTE;
  const packedClock = preload(`Date.now = () => ${packedNow};`);
  deferRefresh(box, "missing", false, packedNow);
  const env = { ...box.env, npm_config_cache: box.path("npm-cache"), npm_config_offline: "true" };
  const npm = (args: string[], cwd: string): void => {
    const result = spawnSync("npm", args, { cwd, env, encoding: "utf8", timeout: 8_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  npm(["pack", "--ignore-scripts", "--pack-destination", box.tmp], ROOT);
  const archives = readdirSync(box.tmp).filter((name) => name.endsWith(".tgz"));
  const archive = archives[0];
  assert.ok(archives.length === 1 && archive !== undefined);
  const install = box.path("install");
  mkdirSync(install);
  npm(["install", "--prefix", install, "--no-save", "--ignore-scripts", "--no-audit", "--no-fund", join(box.tmp, archive)], install);
  const bin = join(install, "node_modules", ".bin", "tokenmeter");
  const expected = [
    ["doctor", 0, true, undefined],
    ["status", 1, false, "not_collected"],
    ["hud", 0, true, undefined],
  ] as const;
  for (const [command, code, okValue, errorCode] of expected) {
    const { result: child, starts } = observeStarts(box, command, (observer) =>
      spawnSync(process.execPath, [observer, packedClock, bin, command], {
        cwd: install, env: { ...box.env, PATH: box.path("bin") }, encoding: "utf8", timeout: 2_000,
      }));
    assert.ifError(child.error);
    assert.equal(child.signal, null);
    assert.equal(child.stderr, "");
    const parsed = parseJson(child.stdout);
    assert.ok(parsed.ok, child.stdout);
    const value = asRow(parsed.value);
    assert.deepEqual(
      [child.status, value?.schema, value?.ok, asRow(value?.error)?.code],
      [code, SCHEMA_ID, okValue, errorCode],
      command,
    );
    if (command === "hud") {
      assert.deepEqual(value, EMPTY);
      assert.equal(starts.length, 0, "The installed HUD must not start a refresher");
    }
  }
});
