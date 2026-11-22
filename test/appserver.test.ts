import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
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
const LIMITS = [{ ...WEEK_SAMPLE, reached: false }];
const USAGE = { id: 3, method: "account/usage/read" };

function usageReply(dailyUsageBuckets: unknown) {
  return { id: 3, result: { dailyUsageBuckets, threadUsage: [CANARY], summary: CANARY } };
}

function reply(snapshot: object = {}) {
  const rateLimits = { limitId: "codex", primary: WEEK, secondary: null, ...snapshot };
  return { id: 2, result: { rateLimits, rateLimitsByLimitId: { codex: rateLimits } } };
}

interface Replies {
  readonly initialize?: readonly unknown[];
  readonly limits: readonly unknown[];
  readonly usage?: readonly unknown[];
  readonly afterLimits?: "exit0" | "exit1";
}

function fake(t: TestContext, replies: Replies, mode: "rpc" | "rpc-old" = "rpc") {
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
  writeFileSync(box.path("data", "rpc-replies.json"), JSON.stringify({
    initialize: lines(replies.initialize ?? [INIT]), limits: lines(replies.limits), usage: lines(replies.usage ?? []),
    afterLimits: replies.afterLimits,
  }));
  return {
    box, codex: codex.value, options: { cwd: box.dataDir, env, now: () => AT },
    usageCalls: box.path("data", "usage-calls"),
  };
}

function sentMessages(path: string): readonly unknown[] {
  return readFileSync(path, "utf8").trimEnd().split("\n").map((line): unknown => JSON.parse(line));
}

function limitsRequests(): readonly unknown[] {
  const metadata = parseJson(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(metadata.ok);
  return [
    { id: 1, method: "initialize", params: { clientInfo: { name: "tokenmeter", version: asRow(metadata.value)?.["version"] } } },
    { method: "initialized" },
    { id: 2, method: "account/rateLimits/read" },
  ];
}

test("the client sends just the three allowed messages when usage is not due", posix, async (t) => {
  const { box, codex, options, usageCalls } = fake(t, {
    initialize: [reply({ primary: FIVE_HOUR }), { id: 1, method: "server/request" }, INIT],
    limits: [
      { method: "configWarning", params: { summary: CANARY } },
      { method: "remoteControl/status/changed", params: {} },
      { id: 2, method: "server/request", params: {} },
      { id: 99, error: { code: -32600, message: CANARY } },
      reply(),
    ],
  });

  assert.deepEqual(await readAppServerLimits(codex, options), ok({ limits: LIMITS, usage: null }));
  assert.deepEqual(sentMessages(box.path("data", "rpc-input")), limitsRequests());
  assert.equal(existsSync(usageCalls), false);
});

test("the client asks for usage in the same session only after valid limits", posix, async (t) => {
  const { box, codex, options, usageCalls } = fake(t, {
    limits: [usageReply([{ startDate: "2025-12-31", tokens: 99 }]), reply()],
    usage: [{ id: 3, method: "server/request" }, usageReply([{ startDate: "2025-12-31", tokens: 12, extra: CANARY }])],
  });

  assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: true }), ok({
    limits: LIMITS, usage: ok([["2025-12-31", 12]]),
  }));
  assert.deepEqual(sentMessages(box.path("data", "rpc-input")), [...limitsRequests(), USAGE]);
  assert.equal(readFileSync(box.path("data", "app-server-calls"), "utf8"), "1\n");
  assert.equal(readFileSync(usageCalls, "utf8"), "1\n");
});

test("a switch change after initialize permits the limits request but stops the usage request", posix, async (t) => {
  const { box, codex, options } = fake(t, { limits: [reply()] });
  const input = box.path("data", "rpc-input");
  const result = await readAppServerLimits(codex, { ...options, usage: true, mayStart: () => !existsSync(input) });
  assert.deepEqual(sentMessages(input), limitsRequests());
  assert.deepEqual(result, ok({ limits: LIMITS, usage: null }));
});

test("an old Codex receives no app-server start", posix, async (t) => {
  const { box, codex, options } = fake(t, { limits: [reply()] }, "rpc-old");
  assert.deepEqual(await readAppServerLimits(codex, options), err("old"));
  assert.equal(existsSync(box.path("data", "rpc-input")), false);
});

test("a missing Codex returns a fixed outcome", async (t) => {
  const box = makeSandbox(t);
  assert.deepEqual(await readAppServerLimits(null, { cwd: box.dataDir, env: { PATH: "" } }), err("missing"));
});

test("only quota values and the reached flag pass to the store", posix, async (t) => {
  const { box, codex, options } = fake(t, {
    limits: [reply({
      primary: FIVE_HOUR, secondary: WEEK, rateLimitReachedType: CANARY,
      limitName: CANARY, planType: CANARY, accountId: CANARY, credits: { balance: CANARY },
    })],
    usage: [{ id: 3, error: { code: -32601, message: CANARY } }],
  });
  const result = await readAppServerLimits(codex, { ...options, usage: true });
  assert.ok(result.ok);
  assert.deepEqual(result.value, {
    limits: [{ ...FIVE_HOUR_SAMPLE, reached: true }, { ...WEEK_SAMPLE, reached: true }],
    usage: err("unsupported"),
  });
  assert.ok(storeAppServerReading(box.dataDir, result.value.limits).ok);
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
    const { codex, options } = fake(t, { limits: [reply({ primary, secondary: WEEK, rateLimitReachedType: "" })] });
    assert.deepEqual(await readAppServerLimits(codex, options), ok({ limits: LIMITS, usage: null }));
  });
}

test("a reply without a limit id can supply a quota window", posix, async (t) => {
  const { codex, options } = fake(t, { limits: [reply({ limitId: undefined })] });
  assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: false }), ok({ limits: LIMITS, usage: null }));
});

for (const [name, message, outcome] of [
  ["another limit id", reply({ limitId: "other" }), "shape"],
  ["no usable window", reply({ primary: null }), "shape"],
  ["a malformed reply", "{", "shape"],
  ["an unsupported JSON-RPC version", { ...reply(), jsonrpc: "1.0" }, "shape"],
  ["an error with a result", { ...reply(), error: { code: -32600 } }, "shape"],
  ["a non-integer error code", { id: 2, error: { code: 1.5 } }, "shape"],
  ["an auth error", { id: 2, error: { code: -32600, message: CANARY } }, "auth"],
  ["another RPC error", { id: 2, error: { code: -32601, message: CANARY } }, "error"],
] as const) {
  test(`the client returns ${outcome} for ${name}`, posix, async (t) => {
    const { box, codex, options, usageCalls } = fake(t, { limits: [message] });
    assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: true }), err(outcome));
    assert.deepEqual(sentMessages(box.path("data", "rpc-input")), limitsRequests());
    assert.equal(existsSync(usageCalls), false);
  });
}

test("a malformed initialize reply cannot open the rate limits read", posix, async (t) => {
  const { box, codex, options, usageCalls } = fake(t, { limits: [reply()], initialize: [{ id: 1, result: null }] });
  assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: true }), err("shape"));
  assert.deepEqual(sentMessages(box.path("data", "rpc-input")), limitsRequests().slice(0, 1));
  assert.equal(existsSync(usageCalls), false);
});

test("an initialize error with code -32600 returns auth", posix, async (t) => {
  const { codex, options } = fake(t, { limits: [reply()], initialize: [{ id: 1, error: { code: -32600 } }] });
  assert.deepEqual(await readAppServerLimits(codex, options), err("auth"));
});

test("a silent limits request returns timeout", posix, async (t) => {
  const { codex, options } = fake(t, { limits: [] });
  assert.deepEqual(await readAppServerLimits(codex, options), err("timeout"));
});

for (const [name, message, error] of [
  ["code -32600", { id: 3, error: { code: -32600, message: CANARY } }, "error"],
  ["another RPC code", { id: 3, error: { code: -32602, message: CANARY } }, "error"],
  ["a malformed RPC error", { id: 3, error: { code: "-32601", message: CANARY } }, "shape"],
  ["an error with a result", { ...usageReply([]), error: { code: -32601 } }, "shape"],
  ["an unsupported JSON-RPC version", { ...usageReply([]), jsonrpc: "1.0" }, "shape"],
  ["a bad result shape", { id: 3, result: {} }, "shape"],
  ["an invalid bucket", usageReply([{ startDate: "2025-12-31", tokens: -1 }]), "shape"],
  ["null buckets", usageReply(null), "error"],
  ["a non-JSON line", "{", "shape"],
  ["a non-object line", "null", "shape"],
  ["a line over 64 KiB", JSON.stringify({ method: "note", params: "é".repeat(32_769) }), "too_large"],
] as const) {
  test(`the client keeps limits and returns usage ${error} for ${name}`, posix, async (t) => {
    const { codex, options } = fake(t, { limits: [reply()], usage: [message] });
    assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: true }), ok({ limits: LIMITS, usage: err(error) }));
  });
}

test("the client keeps limits when usage output exceeds 256 KiB", posix, async (t) => {
  const note = { method: "note", params: "x".repeat(32_768) };
  const { codex, options } = fake(t, { limits: [reply()], usage: Array.from({ length: 8 }, () => note) });
  assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: true }), ok({ limits: LIMITS, usage: err("too_large") }));
});

test("the client keeps limits when the usage request times out", posix, async (t) => {
  const { codex, options, usageCalls } = fake(t, { limits: [reply()] });
  assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: true }), ok({ limits: LIMITS, usage: err("timeout") }));
  assert.equal(readFileSync(usageCalls, "utf8"), "1\n");
});

for (const afterLimits of ["exit0", "exit1"] as const) {
  test(`the client keeps limits when the server ends with ${afterLimits}`, posix, async (t) => {
    const { codex, options } = fake(t, { limits: [reply()], afterLimits });
    assert.deepEqual(await readAppServerLimits(codex, { ...options, usage: true }), ok({ limits: LIMITS, usage: err("error") }));
  });
}

test("the client keeps limits when an abort ends the usage wait", posix, async (t) => {
  const { codex, options, usageCalls } = fake(t, { limits: [reply()] });
  const controller = new AbortController();
  const result = readAppServerLimits(codex, { ...options, usage: true, signal: controller.signal });
  for (let tries = 0; tries < 150 && !existsSync(usageCalls); tries++) await delay(20);
  const sent = existsSync(usageCalls);
  controller.abort();
  assert.deepEqual(await result, ok({ limits: LIMITS, usage: err("error") }));
  assert.equal(sent, true);
});
