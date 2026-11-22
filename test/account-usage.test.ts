import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import {
  ACCOUNT_DAY_TOKENS_MAX, ACCOUNT_MAX_AGE_MS, ACCOUNT_MAX_ROWS, ACCOUNT_READ_CAP_BYTES,
  ACCOUNT_USAGE_FILE, USAGE_INTERVAL_MS, USAGE_LONG_BACKOFF_MS, accountSum, freshAccount,
  readAccountFile, readAccountUsage, replyRows, usageDue, writeAccountFile,
  type AccountFile, type AccountRow,
} from "../src/account-usage.ts";
import { FUTURE_SLACK_MS, STORE_VERSION, err, ok } from "../src/core.ts";
import { shiftDate } from "../src/days.ts";
import { defaultDeps } from "../src/fsafe.ts";
import { isStoreFileName } from "../src/store.ts";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();
const TODAY = "2026-11-22";
const NOW = Date.parse(`${TODAY}T00:01:00Z`);
const KEY = "a".repeat(64);
const NEW_KEY = "b".repeat(64);
const FILE: AccountFile = {
  version: STORE_VERSION, fetched_at: NOW, attempt_at: NOW, attempt: "ok", bin_key: KEY,
  rows: [[TODAY, 12]],
};
const DEPS = { ...defaultDeps(), nowMs: () => NOW };

function fixture(t: TestContext) {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  const path = box.path("data", ACCOUNT_USAGE_FILE);
  const put = (value: unknown) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return { box, path, put };
}

const posix = { skip: process.platform === "win32" };

test("a reply copies only date and token pairs without reading extra fields", () => {
  const result = {
    dailyUsageBuckets: [{
      startDate: TODAY, tokens: 12,
      get extra() { return assert.fail("extra field was read"); },
    }],
    get threadUsage() { return assert.fail("threadUsage was read"); },
    get summary() { return assert.fail("summary was read"); },
  };
  assert.deepEqual(replyRows(result, NOW), ok(FILE.rows));
});

for (const [name, body, code] of [
  ["null buckets", { dailyUsageBuckets: null }, "error"],
  ["missing buckets", {}, "shape"],
  ["non-array buckets", { dailyUsageBuckets: 1 }, "shape"],
] as const) {
  test(`a reply with ${name} gives ${code}`, () => {
    assert.deepEqual(replyRows(body, NOW), err(code));
  });
}

const BAD_PAIRS: readonly (readonly [string, unknown, unknown])[] = [
  ["malformed date", "2026-1-02", 1],
  ["unreal date", "2026-11-31", 1],
  ["date after tomorrow", shiftDate(TODAY, 2), 1],
  ["proto key as date", "__proto__", 1],
  ["negative count", TODAY, -1],
  ["fractional count", TODAY, 1.5],
  ["unsafe count", TODAY, Number.MAX_SAFE_INTEGER + 1],
  ["count over cap", TODAY, ACCOUNT_DAY_TOKENS_MAX + 1],
  ["text count", TODAY, "12"],
];

for (const [name, date, tokens] of BAD_PAIRS) {
  test(`a ${name} refuses the whole row set in a reply and a file`, posix, (t) => {
    const { box, put } = fixture(t);
    const yesterday = shiftDate(TODAY, -1);
    put({ ...FILE, rows: [[yesterday, 2], [date, tokens]] });
    assert.deepEqual(replyRows({ dailyUsageBuckets: [{ startDate: yesterday, tokens: 2 }, { startDate: date, tokens }] }, NOW), err("shape"));
    assert.equal(readAccountFile(box.dataDir, NOW, DEPS), null);
  });
}

const AT_CAP: readonly AccountRow[] = Array.from({ length: ACCOUNT_MAX_ROWS }, (_, i) => [shiftDate(TODAY, -i), ACCOUNT_DAY_TOKENS_MAX]);
for (const [name, rows] of [
  ["duplicate date", [[TODAY, 12], [TODAY, 1]]],
  ["row count over cap", [...AT_CAP, [shiftDate(TODAY, 1), 0]]],
] as const) {
  test(`a ${name} refuses the whole row set in a reply and a file`, posix, (t) => {
    const { box, put } = fixture(t);
    put({ ...FILE, rows });
    assert.deepEqual(replyRows({ dailyUsageBuckets: rows.map(([startDate, tokens]) => ({ startDate, tokens })) }, NOW), err("shape"));
    assert.equal(readAccountFile(box.dataDir, NOW, DEPS), null);
  });
}

test("an own proto key refuses a bucket or an account file", posix, (t) => {
  const { box, put } = fixture(t);
  put({ ...FILE, ["__proto__"]: {} });
  const bucket = { startDate: TODAY, tokens: 1, ["__proto__"]: {} };
  assert.deepEqual(replyRows({ dailyUsageBuckets: [bucket] }, NOW), err("shape"));
  assert.equal(readAccountFile(box.dataDir, NOW, DEPS), null);
});

test("an own proto key refuses a reply even when its buckets are valid", () => {
  const body = { dailyUsageBuckets: [{ startDate: TODAY, tokens: 12 }], ["__proto__"]: {} };
  assert.deepEqual(replyRows(body, NOW), err("shape"));
});

test("a file row with more than two fields is absent", posix, (t) => {
  const { box, put } = fixture(t);
  put({ ...FILE, rows: [[TODAY, 12, "extra"]] });
  assert.equal(readAccountFile(box.dataDir, NOW, DEPS), null);
});

test("a reply and file sort dates, keep 62 days through today, and accept tomorrow", posix, (t) => {
  const { box, put } = fixture(t);
  const rows = [[shiftDate(TODAY, 1), 0], ...AT_CAP.slice(0, -1)] as const;
  const expected = [...AT_CAP.slice(0, 62).reverse(), rows[0]];
  put({ ...FILE, rows });
  assert.deepEqual(replyRows({ dailyUsageBuckets: rows.map(([startDate, tokens]) => ({ startDate, tokens })) }, NOW), ok(expected));
  assert.deepEqual(readAccountFile(box.dataDir, NOW, DEPS)?.rows, expected);
});

test("100 rows at the day cap sum to a safe integer", () => {
  const total = ACCOUNT_DAY_TOKENS_MAX * ACCOUNT_MAX_ROWS;
  assert.ok(Number.isSafeInteger(total));
  assert.equal(accountSum({ at: NOW, rows: AT_CAP }, shiftDate(TODAY, -99), shiftDate(TODAY, 1)), total);
});

test("an account sum uses a half-open date range and separates zero from no covered date", () => {
  const zero = shiftDate(TODAY, -2);
  const from = shiftDate(TODAY, -1);
  const next = shiftDate(TODAY, 1);
  const account = { at: NOW, rows: [[zero, 0], [from, 4], [TODAY, 12]] as const };
  assert.deepEqual([
    accountSum(account, zero, from), accountSum(account, from, TODAY),
    accountSum(account, from, next), accountSum(account, next, shiftDate(next, 1)),
  ], [0, 4, 16, null]);
});

test("no attempt file is due", () => {
  assert.equal(usageDue(null, KEY, NOW), true);
});

for (const attempt of ["ok", "error", "timeout", "unsupported", "shape", "too_large"] as const) {
  test(`the ${attempt} attempt holds its wait and the binary change respects the floor`, () => {
    const file: AccountFile = { ...FILE, attempt };
    const long = attempt === "unsupported" || attempt === "shape" || attempt === "too_large";
    const delay = long ? USAGE_LONG_BACKOFF_MS : USAGE_INTERVAL_MS;
    assert.deepEqual([
      usageDue(file, KEY, NOW + delay - 1), usageDue(file, KEY, NOW + delay),
      usageDue(file, NEW_KEY, NOW + USAGE_INTERVAL_MS - 1), usageDue(file, NEW_KEY, NOW + USAGE_INTERVAL_MS),
    ], [false, true, false, true]);
  });
}

test("an attempt-only file holds the wait without fresh data", posix, (t) => {
  const { box } = fixture(t);
  const attempt: AccountFile = { ...FILE, fetched_at: null, attempt: "error", rows: [] };
  assert.deepEqual(writeAccountFile(box.dataDir, attempt, DEPS), ok(null));
  const read = readAccountFile(box.dataDir, NOW, DEPS);
  assert.deepEqual(read, attempt);
  assert.equal(freshAccount(read, NOW), null);
  assert.equal(usageDue(read, KEY, NOW + USAGE_INTERVAL_MS - 1), false);
});

test("the account writer stores only allowed fields in a private file outside the collect journal", posix, (t) => {
  const { box, path } = fixture(t);
  const file = { ...FILE, extra: "not stored" };
  assert.deepEqual(writeAccountFile(box.dataDir, file, DEPS), ok(null));
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), FILE);
  assert.equal(statSync(path).mode & 0o7777, 0o600);
  assert.equal(isStoreFileName(ACCOUNT_USAGE_FILE), false);
});

for (const kind of ["missing", "malformed", "over cap", "linked", "loose mode", "foreign owner"] as const) {
  test(`a ${kind} file reads as absent`, posix, (t) => {
    const { box, path, put } = fixture(t);
    if (kind === "malformed") writeFileSync(path, "{", { mode: 0o600 });
    else if (kind === "over cap") writeFileSync(path, JSON.stringify(FILE).padEnd(ACCOUNT_READ_CAP_BYTES + 1), { mode: 0o600 });
    else if (kind === "linked") {
      const target = box.path("target");
      writeFileSync(target, JSON.stringify(FILE), { mode: 0o600 });
      symlinkSync(target, path);
    } else if (kind !== "missing") put(FILE);
    if (kind === "loose mode") chmodSync(path, 0o644);
    const deps = kind === "foreign owner" ? { ...DEPS, uid: DEPS.uid + 1 } : DEPS;
    assert.equal(readAccountFile(box.dataDir, NOW, deps), null);
  });
}

for (const [name, patch] of [
  ["newer version", { version: STORE_VERSION + 1 }],
  ["unknown outcome", { attempt: "other" }],
  ["inherited outcome name", { attempt: "constructor" }],
  ["bad binary key", { bin_key: "unknown" }],
  ["unsafe time", { attempt_at: Number.MAX_SAFE_INTEGER + 1 }],
  ["text time", { fetched_at: String(NOW) }],
  ["negative time", { fetched_at: -1 }],
  ["null fetch time with rows", { fetched_at: null }],
  ["fetch time past the future slack", { fetched_at: NOW + FUTURE_SLACK_MS + 1 }],
  ["attempt time past the future slack", { attempt_at: NOW + FUTURE_SLACK_MS + 1 }],
] as const) {
  test(`a file with ${name} reads as absent`, posix, (t) => {
    const { box, put } = fixture(t);
    put({ ...FILE, ...patch });
    assert.equal(readAccountFile(box.dataDir, NOW, DEPS), null);
  });
}

for (const kind of ["linked", "loose mode", "foreign owner", "over cap"] as const) {
  test(`the writer refuses ${kind} and leaves the prior text intact`, posix, (t) => {
    const { box, path, put } = fixture(t);
    if (kind === "linked") {
      const target = box.path("target");
      writeFileSync(target, JSON.stringify(FILE), { mode: 0o600 });
      symlinkSync(target, path);
    } else put(FILE);
    if (kind === "loose mode") chmodSync(path, 0o644);
    const deps = kind === "foreign owner" ? { ...DEPS, uid: DEPS.uid + 1 } : DEPS;
    const rows = kind === "over cap" ? [...AT_CAP, ...AT_CAP] : [];
    const code = kind === "over cap" ? "too_large" : "unsafe_file";
    assert.deepEqual(writeAccountFile(box.dataDir, { ...FILE, rows }, deps), err({ code, sys: null }));
    assert.equal(readFileSync(path, "utf8"), JSON.stringify(FILE));
  });
}

test("account data is fresh until, but not at, 24 hours", posix, (t) => {
  const { box, put } = fixture(t);
  put(FILE);
  assert.deepEqual(readAccountUsage(box.dataDir, NOW + ACCOUNT_MAX_AGE_MS - 1, DEPS), { at: NOW, rows: FILE.rows });
  assert.equal(readAccountUsage(box.dataDir, NOW + ACCOUNT_MAX_AGE_MS, DEPS), null);
});

test("times at the future slack are accepted", posix, (t) => {
  const { box, put } = fixture(t);
  const at = NOW + FUTURE_SLACK_MS;
  put({ ...FILE, fetched_at: at, attempt_at: at, bin_key: null });
  assert.deepEqual(readAccountUsage(box.dataDir, NOW, DEPS), { at, rows: FILE.rows });
});
