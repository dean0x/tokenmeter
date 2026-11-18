import assert from "node:assert/strict";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { ok } from "../src/core.ts";
import { defaultDeps, releaseLock } from "../src/fsafe.ts";
import { acquireRefreshLock, appServerGate, backoffMs, readRefreshState, refreshGate, writeRefreshState, type RefreshOutcome, type RefreshState } from "../src/gate.ts";
import { resolveCodex } from "../src/spawn.ts";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();
const AT = Date.UTC(2026, 0, 1);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const KEY = "a".repeat(64);
const NO_BINARY_CHECK = () => assert.fail("the gate must not resolve Codex for this state");
const posix = { skip: process.platform === "win32" };
const depsAt = (now: number) => ({ ...defaultDeps(), nowMs: () => now });

function state(fields: Partial<RefreshState> = {}): RefreshState {
  return { lastAttemptAt: AT, nextRefreshAt: AT + MINUTE, nextAppServerAt: AT + MINUTE,
    outcome: "ok", binKey: KEY, codexFound: true, ...fields };
}

function setup(t: TestContext) {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  return { box, dir: box.dataDir };
}

function enableAppServer(dir: string): void {
  writeFileSync(`${dir}/config.json`, '{"version":1,"app_server":"on"}', { mode: 0o600 });
}

test("the refresh gate waits for the reading and refresh time but ignores config and app-server backoff", (t) => {
  const { box, dir } = setup(t);
  const config = box.path("data", "config.json");
  writeFileSync(config, '{"version":1,"app_server":"off"}', { mode: 0o600 });
  const stored = ok(state({ nextAppServerAt: AT + DAY, outcome: "auth" }));
  assert.equal(refreshGate(dir, null, stored, NO_BINARY_CHECK, depsAt(AT + MINUTE - 1)), false);
  assert.equal(refreshGate(dir, AT + 1, stored, NO_BINARY_CHECK, depsAt(AT + MINUTE)), false);
  assert.equal(refreshGate(dir, AT, stored, NO_BINARY_CHECK, depsAt(AT + MINUTE)), true);
  assert.equal(refreshGate(dir, null, ok(null), NO_BINARY_CHECK, depsAt(AT)), true);
  assert.equal(existsSync(box.path("data", "refresh.lock")), false);
});

test("the app-server gate reads the config again before it admits an attempt", (t) => {
  const { box, dir } = setup(t);
  const config = box.path("data", "config.json");
  const deps = depsAt(AT + MINUTE);
  enableAppServer(dir);
  assert.equal(appServerGate(dir, null, KEY, deps), "open");
  writeFileSync(config, '{"version":1,"app_server":"off"}', { mode: 0o600 });
  assert.equal(appServerGate(dir, null, KEY, deps), "off");
  writeFileSync(config, "{", { mode: 0o600 });
  assert.equal(appServerGate(dir, null, KEY, deps), "off");
});

const backoffs: Readonly<Record<RefreshOutcome, number>> = {
  auth: 15 * MINUTE, missing: 10 * MINUTE, old: DAY, shape: DAY,
  ok: MINUTE, timeout: MINUTE, error: MINUTE, off: MINUTE,
};
for (const outcome of Object.keys(backoffs) as RefreshOutcome[]) {
  test(`the app-server gate waits out the ${outcome} backoff`, (t) => {
    const { dir } = setup(t);
    enableAppServer(dir);
    assert.equal(backoffMs(outcome), backoffs[outcome]);
    const due = AT + backoffMs(outcome);
    const key = outcome === "missing" ? null : KEY;
    const saved = state({ outcome, nextAppServerAt: due, binKey: key, codexFound: key !== null });
    assert.equal(appServerGate(dir, saved, key, depsAt(due - 1)), "backoff");
    assert.equal(appServerGate(dir, saved, key, depsAt(due)), "open");
  });
}

for (const [outcome, change] of [["old", "size"], ["shape", "mtime"]] as const) {
  test(`a ${change} change ends the ${outcome} backoff after the one-minute floor without a spawn`, posix, (t) => {
    const { box, dir } = setup(t);
    enableAppServer(dir);
    const path = box.path("codex");
    const marker = box.path("started");
    // The executable cannot be a version probe: it records any start in its own folder.
    writeFileSync(path, '#!/bin/sh\nprintf started > "${0%/*}/started"\n', { mode: 0o700 });
    const getKey = () => {
      const result = resolveCodex({ PATH: box.path() });
      assert.ok(result.ok);
      return result.value.binKey;
    };
    const finishedAt = AT + 1_000;
    const saved = state({ outcome, binKey: getKey(), nextRefreshAt: AT + 2 * MINUTE, nextAppServerAt: finishedAt + DAY });
    const early = depsAt(AT + MINUTE - 1);
    assert.equal(refreshGate(dir, null, ok(saved), getKey, early), false);
    assert.equal(refreshGate(dir, null, ok(saved), () => null, early), false);
    assert.equal(appServerGate(dir, saved, null, early), "backoff");
    if (change === "size") appendFileSync(path, "# updated\n");
    else utimesSync(path, new Date(AT), new Date(AT));
    assert.equal(refreshGate(dir, null, ok(saved), getKey, early), false);
    assert.equal(refreshGate(dir, null, ok(saved), getKey, depsAt(finishedAt + MINUTE)), true);
    assert.equal(appServerGate(dir, saved, getKey(), depsAt(finishedAt + MINUTE - 1)), "backoff");
    assert.equal(appServerGate(dir, saved, getKey(), depsAt(finishedAt + MINUTE)), "open");
    assert.equal(existsSync(marker), false);
  });
}

test("the state round-trips codexFound and the outcome at mode 0600", (t) => {
  const { box, dir } = setup(t);
  const deps = depsAt(AT);
  assert.deepEqual(readRefreshState(dir, deps), ok(null));
  const saved = state({ outcome: "off", binKey: null, codexFound: false });
  assert.equal(writeRefreshState(dir, saved, deps).ok, true);
  assert.deepEqual(readRefreshState(dir, deps), ok(saved));
  assert.equal(statSync(box.path("data", "refresh-state.json")).mode & 0o777, 0o600);
});

test("a malformed private state opens the refresh gate when the reading is absent or stale", (t) => {
  const { box, dir } = setup(t);
  const deps = depsAt(AT + MINUTE);
  const path = box.path("data", "refresh-state.json");
  const invalidFields = [{ codexFound: "false" }, { outcome: "unknown" }, { nextAppServerAt: -1 }, { binKey: "unknown" }];
  for (const text of ["{", ...invalidFields.map((patch) => JSON.stringify({ ...state(), ...patch }))]) {
    writeFileSync(path, text, { mode: 0o600 });
    const stored = readRefreshState(dir, deps);
    assert.equal(refreshGate(dir, null, stored, NO_BINARY_CHECK, deps), true);
    assert.equal(refreshGate(dir, AT, stored, NO_BINARY_CHECK, deps), true);
    assert.equal(refreshGate(dir, AT + 1, stored, NO_BINARY_CHECK, deps), false);
    assert.deepEqual(stored, ok(null));
  }
});

test("a malformed state with a different owner, over the cap or at mode 0400 keeps the gate closed", posix, (t) => {
  const { box, dir } = setup(t);
  const deps = depsAt(AT);
  const path = box.path("data", "refresh-state.json");
  const opens = (fsDeps: typeof deps) => refreshGate(dir, null, readRefreshState(dir, fsDeps), NO_BINARY_CHECK, fsDeps);
  writeFileSync(path, "{", { mode: 0o600 });
  assert.equal(opens({ ...deps, uid: deps.uid + 1 }), false, "different owner");
  writeFileSync(path, "{".repeat(4 * 1024 + 1));
  assert.equal(opens(deps), false, "over the cap");
  writeFileSync(path, "{");
  chmodSync(path, 0o400);
  assert.equal(opens(deps), false, "mode 0400");
});

test("a live refresh lock blocks the gate and a second acquire; a stale lock does not", (t) => {
  const { box, dir } = setup(t);
  const deps = { ...depsAt(AT), isAlive: () => true };
  const lock = acquireRefreshLock(dir, deps);
  assert.ok(lock.ok);
  const path = box.path("data", "refresh.lock");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(acquireRefreshLock(dir, deps).ok, false);
  assert.equal(refreshGate(dir, null, ok(null), NO_BINARY_CHECK, deps), false);
  const later = { ...deps, nowMs: () => AT + 3 * MINUTE };
  const before = readFileSync(path, "utf8");
  assert.equal(refreshGate(dir, null, ok(null), NO_BINARY_CHECK, later), true);
  assert.equal(readFileSync(path, "utf8"), before);
  const next = acquireRefreshLock(dir, later);
  assert.ok(next.ok);
  assert.deepEqual(releaseLock(next.value, later), ok(true));
});

for (const kind of ["symlink", "0644"]) {
  test(`refresh state and lock refuse a ${kind} file`, posix, (t) => {
    const { box, dir } = setup(t);
    const deps = depsAt(AT + DAY);
    const saved = state();
    const lockPath = box.path("data", "refresh.lock");
    const statePath = box.path("data", "refresh-state.json");
    for (const [path, text] of [[lockPath, '{"pid":1,"startedAtMs":0,"token":"stale"}'], [statePath, JSON.stringify(saved)]] as const) {
      if (kind === "symlink") {
        const target = `${path}.target`;
        writeFileSync(target, text, { mode: 0o600 });
        symlinkSync(target, path);
      } else {
        writeFileSync(path, text);
        chmodSync(path, 0o644);
      }
    }
    assert.equal(readRefreshState(dir, deps).ok, false);
    assert.equal(writeRefreshState(dir, saved, deps).ok, false);
    assert.equal(acquireRefreshLock(dir, deps).ok, false);
    assert.equal(refreshGate(dir, null, ok(null), NO_BINARY_CHECK, deps), false);
    assert.equal(lstatSync(lockPath).isSymbolicLink(), kind === "symlink");
    assert.equal(lstatSync(statePath).isSymbolicLink(), kind === "symlink");
  });
}
