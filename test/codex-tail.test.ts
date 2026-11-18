import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { readCodexTail } from "../src/codex-tail.ts";
import { findCodexFiles } from "../src/collect.ts";
import { defaultDeps } from "../src/fsafe.ts";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();
const NOW = Date.UTC(2026, 10, 18, 12);
const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;

function quota(percent: number): string {
  return `${JSON.stringify({
    timestamp: new Date(NOW).toISOString(), type: "event_msg",
    payload: { type: "token_count", rate_limits: { primary: {
      used_percent: percent, window_minutes: 300, resets_at: NOW / 1000 + 3600,
    } } },
  })}\n`;
}

function setup(t: TestContext) {
  const box = makeSandbox(t);
  return {
    root: box.path("sessions"),
    rollout(day: string, name: string, mtime: number, text = "") {
      const path = box.path("sessions", "2026", "11", day, `rollout-${name}.jsonl`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      utimesSync(path, mtime / 1000, mtime / 1000);
      return path;
    },
  };
}

function samples(root: string, deps = { ...defaultDeps(), nowMs: () => NOW }) {
  const result = readCodexTail(root, NOW, deps);
  assert.ok(result.ok);
  return result.value.map((sample) => sample.usedPercent).sort((a, b) => a - b);
}

test("reads at most the three newest rollouts by mtime, and skips files older than eight days", (t) => {
  const { root, rollout } = setup(t);
  rollout("18", "stale", NOW - 9 * DAY_MS, quota(99));
  rollout("18", "fourth", NOW - 4_000, quota(4));
  rollout("18", "third", NOW - 3_000, quota(3));
  rollout("17", "second", NOW - 2_000, quota(2));
  rollout("16", "first", NOW - 1_000, quota(1));
  assert.deepEqual(samples(root), [1, 2, 3]);
});

test("selects by day folder first and keeps a fresh file in a twelve-day-old folder", (t) => {
  const { root, rollout } = setup(t);
  for (let index = 0; index < 250; index += 1) rollout("01", String(index), NOW, quota(99));
  for (let day = 17; day >= 5; day -= 1) mkdirSync(join(root, "2026", "11", String(day).padStart(2, "0")), { recursive: true });
  rollout("18", "today", NOW - 1000, quota(2));
  rollout("06", "old-folder", NOW - 2000, quota(1));
  assert.deepEqual(samples(root), [1, 2]);
});

test("keeps a one-MiB result and retries a four-MiB tail only for an empty result", (t) => {
  const { root, rollout } = setup(t);
  const padding = " \n".repeat(MIB / 2 + 1);
  rollout("18", "short", NOW - 1_000, quota(99) + padding + quota(1));
  rollout("18", "retry", NOW - 2_000, quota(2) + padding);
  rollout("18", "outside", NOW - 3_000, quota(98) + padding.repeat(4));
  assert.deepEqual(samples(root), [1, 2]);
});

test("rejects a partial first line even when its suffix parses as a quota row", (t) => {
  const { root, rollout } = setup(t);
  const forged = quota(99);
  rollout("18", "partial", NOW, "broken:" + forged + " ".repeat(MIB - forged.length));
  rollout("18", "valid", NOW - 1000, quota(1));
  assert.deepEqual(samples(root), [1]);
});

test("ignores linked files and linked day folders", { skip: process.platform === "win32" }, (t) => {
  const { root, rollout } = setup(t);
  const file = rollout("18", "real", NOW, quota(1));
  const target = rollout("01", "target", NOW, quota(99));
  symlinkSync(target, join(dirname(file), "rollout-linked.jsonl"));
  symlinkSync(dirname(target), join(dirname(dirname(file)), "17"));
  assert.deepEqual(samples(root), [1, 99]);
  const found = findCodexFiles(root, NOW);
  assert.ok(found.ok);
  assert.deepEqual(found.value.map(({ path }) => path).sort(), [file, target].sort());
});

test("stops the walk at its deadline even when it has not found a file", (t) => {
  const { root, rollout } = setup(t);
  rollout("18", "unvisited", NOW, quota(1));
  assert.deepEqual(samples(root), [1]);
  let calls = 0;
  const deps = { ...defaultDeps(), nowMs: () => NOW + (calls++ === 0 ? 0 : 1_000) };
  assert.deepEqual(samples(root, deps), []);
});

test("checks at most two hundred rollout entries in one day", (t) => {
  const { root, rollout } = setup(t);
  for (let index = 0; index < 205; index += 1) rollout("18", String(index), NOW);
  const found = findCodexFiles(root, NOW);
  assert.ok(found.ok);
  assert.equal(found.value.length, 200);
});
