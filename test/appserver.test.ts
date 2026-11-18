import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { readAppServerLimits } from "../src/appserver.ts";
import { asRow, err, ok, parseJson } from "../src/core.ts";
import { QUOTA_LATEST_FILE, quotaMonthFile, storeAppServerReading } from "../src/quota.ts";
import { resolveCodex } from "../src/spawn.ts";
import { writeFakeCodex } from "./fixtures/fake-codex.mjs";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();
const posix = { skip: process.platform === "win32" };
const AT = Date.UTC(2026, 0, 1);
const NOW = AT / 1_000;
const CANARY = "reply-text-canary";
const FIVE_HOUR = { usedPercent: 100, windowDurationMins: 300, resetsAt: NOW + 300 * 60 + 300 };
const WEEK = { usedPercent: 0, windowDurationMins: 10_080, resetsAt: NOW + 10_080 * 60 };
const FIVE_HOUR_SAMPLE = { window: "five_hour", at: AT, usedPercent: 100, resetsAt: FIVE_HOUR.resetsAt * 1_000 };
const WEEK_SAMPLE = { window: "week", at: AT, usedPercent: 0, resetsAt: WEEK.resetsAt * 1_000 };
const INIT = { id: 1, result: { userAgent: CANARY } };

function reply(snapshot: object = {}) {
  const rateLimits = { limitId: "codex", primary: WEEK, secondary: null, ...snapshot };
  return { id: 2, result: { rateLimits, rateLimitsByLimitId: { codex: rateLimits } } };
}

function fake(
  t: TestContext, limits: readonly unknown[], initialize: readonly unknown[] = [INIT], mode: "rpc" | "rpc-old" = "rpc",
) {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  const folder = box.path("codex-bin");
  const path = writeFakeCodex(folder, mode);
  const env = { ...box.env, PATH: folder };
  const codex = resolveCodex(env);
  assert.ok(codex.ok);
  assert.equal(codex.value.path, path);
  // Each entry is a wire line. Strings can supply malformed JSON.
  const lines = (values: readonly unknown[]) => values.map((value) => typeof value === "string" ? value : JSON.stringify(value));
  writeFileSync(box.path("data", "rpc-replies.json"), JSON.stringify({ initialize: lines(initialize), limits: lines(limits) }));
  return { box, codex: codex.value, options: { cwd: box.dataDir, env, now: () => AT } };
}

test("the client sends just the three allowed messages and waits for the matching replies", posix, async (t) => {
  const { box, codex, options } = fake(t, [
    { method: "configWarning", params: { summary: CANARY } },
    { method: "remoteControl/status/changed", params: {} },
    { id: 2, method: "server/request", params: {} },
    { id: 99, error: { code: -32600, message: CANARY } },
    reply(),
  ], [reply({ primary: FIVE_HOUR }), { id: 1, method: "server/request" }, INIT]);

  assert.deepEqual(await readAppServerLimits(codex, options), ok([{ ...WEEK_SAMPLE, reached: false }]));
  const sent = readFileSync(box.path("data", "rpc-input"), "utf8").trimEnd().split("\n").map((line): unknown => JSON.parse(line));
  const metadata = parseJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(metadata.ok);
  assert.deepEqual(sent, [
    { id: 1, method: "initialize", params: { clientInfo: { name: "tokenmeter", version: asRow(metadata.value)?.["version"] } } },
    { method: "initialized" },
    { id: 2, method: "account/rateLimits/read" },
  ]);
});

test("an old Codex receives no app-server start", posix, async (t) => {
  const { box, codex, options } = fake(t, [reply()], [INIT], "rpc-old");
  assert.deepEqual(await readAppServerLimits(codex, options), err("old"));
  assert.equal(existsSync(box.path("data", "rpc-input")), false);
});

test("a missing Codex returns a fixed outcome", async (t) => {
  const box = makeSandbox(t);
  assert.deepEqual(await readAppServerLimits(null, { cwd: box.dataDir, env: { PATH: "" } }), err("missing"));
});

test("only quota values and the reached flag pass to the store", posix, async (t) => {
  const { box, codex, options } = fake(t, [reply({
    primary: FIVE_HOUR, secondary: WEEK, rateLimitReachedType: CANARY,
    limitName: CANARY, planType: CANARY, accountId: CANARY, credits: { balance: CANARY },
  })]);
  const result = await readAppServerLimits(codex, options);
  assert.ok(result.ok);
  assert.deepEqual(result.value, [{ ...FIVE_HOUR_SAMPLE, reached: true }, { ...WEEK_SAMPLE, reached: true }]);
  assert.ok(storeAppServerReading(box.dataDir, result.value).ok);
  for (const file of [QUOTA_LATEST_FILE, quotaMonthFile(AT)]) {
    assert.equal(readFileSync(box.path("data", file), "utf8").includes(CANARY), false);
  }
});

for (const [name, primary] of [
  ["percent over 100", { ...FIVE_HOUR, usedPercent: 101 }],
  ["percent below zero", { ...FIVE_HOUR, usedPercent: -1 }],
  ["percent as text", { ...FIVE_HOUR, usedPercent: "50" }],
  ["unknown window length", { ...FIVE_HOUR, windowDurationMins: 60 }],
  ["reset ahead of the window and slack", { ...FIVE_HOUR, resetsAt: FIVE_HOUR.resetsAt + 1 }],
  ["reset at the sample time", { ...FIVE_HOUR, resetsAt: NOW }],
] as const) {
  test(`the client drops a window with ${name} and keeps a valid window`, posix, async (t) => {
    const { codex, options } = fake(t, [reply({ primary, secondary: WEEK, rateLimitReachedType: "" })]);
    assert.deepEqual(await readAppServerLimits(codex, options), ok([{ ...WEEK_SAMPLE, reached: false }]));
  });
}

test("a reply without a limit id can supply a quota window", posix, async (t) => {
  const { codex, options } = fake(t, [reply({ limitId: undefined })]);
  assert.deepEqual(await readAppServerLimits(codex, options), ok([{ ...WEEK_SAMPLE, reached: false }]));
});

for (const [name, message, outcome] of [
  ["another limit id", reply({ limitId: "other" }), "shape"],
  ["no usable window", reply({ primary: null }), "shape"],
  ["a malformed reply", "{", "shape"],
  ["an auth error", { id: 2, error: { code: -32600, message: CANARY } }, "auth"],
  ["another RPC error", { id: 2, error: { code: -32601, message: CANARY } }, "error"],
] as const) {
  test(`the client returns ${outcome} for ${name}`, posix, async (t) => {
    const { codex, options } = fake(t, [message]);
    assert.deepEqual(await readAppServerLimits(codex, options), err(outcome));
  });
}

test("a malformed initialize reply cannot open the rate limits read", posix, async (t) => {
  const { box, codex, options } = fake(t, [reply()], [{ id: 1, result: null }]);
  assert.deepEqual(await readAppServerLimits(codex, options), err("shape"));
  const sent = readFileSync(box.path("data", "rpc-input"), "utf8");
  assert.equal(sent.includes("account/rateLimits/read"), false);
});

test("a silent server returns timeout", posix, async (t) => {
  const { codex, options } = fake(t, []);
  assert.deepEqual(await readAppServerLimits(codex, options), err("timeout"));
});
