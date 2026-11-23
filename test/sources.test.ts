import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Result,
  type TokenRecord,
  TOKEN_BUCKETS,
  WEIGHTS,
  providerOfClaudeKey,
  rawTokens,
  weighted,
} from "../src/core.ts";
import { type Row, type RowScan, readRows } from "../src/lines.ts";
import {
  CODEX_INITIAL_STATE,
  type ClaudeEntry,
  type CodexEntry,
  type CodexFileState,
  type CodexQuotaSample,
  type CodexStep,
  type SkipReason,
  parseClaudeRow,
  stepCodexRow,
} from "../src/sources.ts";
import { installSuiteGuard } from "./helpers.ts";

installSuiteGuard();

const NOW = Date.parse("2026-11-03T12:00:00Z");
const CANARY = "CANARY-7f3e";
const FIXTURES = join(import.meta.dirname, "fixtures");

const AT_ISO = "2026-11-03T08:01:00.000Z";
const AT_MS = Date.parse(AT_ISO);
const AT_SECONDS = AT_MS / 1000;
// 2026-11-03T11:00:00Z and 2026-11-07T00:00:00Z, as epoch seconds.
const RESET_5H_SECONDS = 1793703600;
const RESET_WEEK_SECONDS = 1794009600;
const EIGHT_DAYS_SECONDS = 8 * 24 * 3600;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fixture(name: string): string {
  return join(FIXTURES, name);
}

function must<T, E>(result: Result<T, E>): T {
  if (!result.ok) assert.fail("expected an ok result");
  return result.value;
}

function bucketsOf(tokens: TokenRecord): number[] {
  return TOKEN_BUCKETS.map((bucket) => tokens[bucket]);
}

type Summary = SkipReason | readonly [string, readonly number[]];

function summarise(outcome: Result<ClaudeEntry, SkipReason>): Summary {
  return outcome.ok ? [outcome.value.key, bucketsOf(outcome.value.tokens)] : outcome.error;
}

interface ClaudeRun {
  readonly outcomes: readonly Result<ClaudeEntry, SkipReason>[];
  readonly scan: RowScan;
}

// The pre-filter is the one a caller uses: only lines that hold a usage object.
function runClaude(name: string): ClaudeRun {
  const outcomes: Result<ClaudeEntry, SkipReason>[] = [];
  const scan = must(
    readRows(fixture(name), { offset: 0, prefilter: ['"usage"'] }, (row) => {
      outcomes.push(parseClaudeRow(row, NOW));
    }),
  );
  return { outcomes, scan };
}

interface CodexRun {
  readonly steps: readonly CodexStep[];
  readonly final: CodexFileState;
  readonly entries: readonly CodexEntry[];
  readonly quota: readonly CodexQuotaSample[];
  readonly skips: readonly SkipReason[];
}

function runCodex(name: string): CodexRun {
  const steps: CodexStep[] = [];
  let state = CODEX_INITIAL_STATE;
  must(
    readRows(
      fixture(name),
      { offset: 0, prefilter: ["token_count", "session_meta", "turn_context"] },
      (row) => {
        const step = stepCodexRow(state, row, NOW);
        state = step.state;
        steps.push(step);
      },
    ),
  );
  return {
    steps,
    final: state,
    entries: steps.flatMap((step) => (step.entry === null ? [] : [step.entry])),
    quota: steps.flatMap((step) => step.quota),
    skips: steps.flatMap((step) => step.skips),
  };
}

// Inline Claude rows for the edge cases.
const BASE_USAGE = {
  input_tokens: 10,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 5,
};

function assistantRow(
  usage: Record<string, unknown>,
  message: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Row {
  return {
    type: "assistant",
    timestamp: AT_ISO,
    cwd: "/work/alpha",
    requestId: "req_X",
    message: { id: "msg_X", model: "claude-sonnet-5-5", usage, ...message },
    ...extra,
  };
}

// Inline Codex rows.
const LAST_USAGE = {
  input_tokens: 1000,
  cached_input_tokens: 400,
  output_tokens: 100,
  reasoning_output_tokens: 30,
  total_tokens: 1100,
};

function countRow(info: unknown, rateLimits?: unknown, timestamp: string = AT_ISO): Row {
  const payload: Record<string, unknown> = { type: "token_count", info };
  if (rateLimits !== undefined) payload["rate_limits"] = rateLimits;
  return { timestamp, type: "event_msg", payload };
}

function windowOf(minutes: unknown, percent: unknown, resets: unknown): Record<string, unknown> {
  return { used_percent: percent, window_minutes: minutes, resets_at: resets };
}

function stepFrom(state: CodexFileState, row: Row): CodexStep {
  return stepCodexRow(state, row, NOW);
}

function quotaStep(rateLimits: unknown): CodexStep {
  return stepFrom(CODEX_INITIAL_STATE, countRow(null, rateLimits));
}

function metaRow(payload: Record<string, unknown>): Row {
  return { timestamp: AT_ISO, type: "session_meta", payload };
}

function contextRow(payload: Record<string, unknown>): Row {
  return { timestamp: AT_ISO, type: "turn_context", payload };
}

// ---------------------------------------------------------------------------
// Claude rows (TP-3 part)
// ---------------------------------------------------------------------------

test("claude fixture: each row gives its five buckets or a skip reason", () => {
  const { outcomes } = runClaude("claude-basic.jsonl");
  // Rows that pass the pre-filter, in file order. The array row and the broken
  // line never reach the parser.
  const expected: Summary[] = [
    ["msg_A|req_A", [100, 200, 0, 300, 10]],
    ["msg_A|req_A", [100, 200, 0, 300, 30]],
    "not_assistant",
    ["msg_A|req_A", [100, 200, 0, 300, 55]],
    ["msg_A|req_A", [100, 200, 0, 300, 55]],
    "synthetic",
    "api_error",
    ["msg_B|req_B", [5, 400, 600, 50, 20]],
    ["msg_C|req_C", [7, 120, 0, 0, 9]],
    "missing_id",
    "bad_token",
    "bad_time",
  ];
  assert.deepEqual(outcomes.map(summarise), expected);
});

test("claude proxy fixture: only valid proxy rows keep their model, key and token counts", () => {
  const { outcomes } = runClaude("claude-proxy.jsonl");
  const actual = outcomes.map((outcome) => {
    if (!outcome.ok) return outcome.error;
    const { key, model, tokens } = outcome.value;
    return [key, model, bucketsOf(tokens)];
  });
  assert.deepEqual(actual, [
    ["resp_A|codex", "gpt-9-test", [100, 0, 0, 30, 10]],
    ["resp_A|codex", "gpt-9-test", [100, 0, 0, 30, 20]],
    ["resp_A|codex", "gpt-9-test", [100, 0, 0, 30, 30]],
    ["resp_B|codex", "gpt-9-test", [50, 0, 0, 10, 5]],
    "missing_id",
    "missing_id",
    "missing_id",
  ]);
});

test("claude proxy: the key preserves a 128-character message id", () => {
  const id = `resp_${"x".repeat(123)}`;
  const row = assistantRow(BASE_USAGE, { id, model: "gpt-9-test" }, { requestId: undefined });
  const outcome = parseClaudeRow(row, NOW);
  assert.equal(outcome.ok ? outcome.value.key : outcome.error, `${id}|codex`);
});

test("claude keys: only the reserved suffix marks a row as Codex", () => {
  const message = { id: "resp_X", model: "gpt-9-test" };
  const proxy = must(parseClaudeRow(assistantRow(BASE_USAGE, message, { requestId: undefined }), NOW));
  const native = must(parseClaudeRow(assistantRow(BASE_USAGE, message, { requestId: "codex_other" }), NOW));
  assert.equal(providerOfClaudeKey(proxy.key), "codex");
  assert.equal(providerOfClaudeKey(native.key), "claude");
});

test("claude fixture: the line reader counts the bad lines by reason", () => {
  const { scan } = runClaude("claude-basic.jsonl");
  assert.equal(scan.lines, 16);
  assert.equal(scan.filtered, 2);
  assert.equal(scan.badJson, 1);
  assert.equal(scan.notObject, 1);
  assert.equal(scan.rows, 12);
});

test("claude fixture: model, folder key and time come from the named fields", () => {
  const { outcomes } = runClaude("claude-basic.jsonl");
  const first = must(outcomes[0] as Result<ClaudeEntry, SkipReason>);
  assert.equal(first.model, "claude-sonnet-5-5");
  assert.equal(first.folderKey, "-work-alpha");
  assert.equal(first.at, Date.parse("2026-11-03T08:01:00.000Z"));
  const oneHour = must(outcomes[7] as Result<ClaudeEntry, SkipReason>);
  assert.equal(oneHour.model, "claude-opus-4-5");
  assert.equal(oneHour.folderKey, "-work-beta");
});

test("claude fixture: a subagent copy gives the same key and values as its source row", () => {
  const { outcomes } = runClaude("claude-basic.jsonl");
  const source = must(outcomes[3] as Result<ClaudeEntry, SkipReason>);
  const copy = must(outcomes[4] as Result<ClaudeEntry, SkipReason>);
  assert.deepEqual(copy, source);
});

test("claude fixture: the 1 hour cache write sits in its own bucket and weighs 2", () => {
  const { outcomes } = runClaude("claude-basic.jsonl");
  const entry = must(outcomes[7] as Result<ClaudeEntry, SkipReason>);
  assert.equal(entry.tokens.cacheWrite1h, 600);
  assert.equal(entry.tokens.cacheWrite5m, 400);
  assert.equal(weighted(entry.tokens), 5 * 1 + 400 * 1.25 + 600 * 2 + 50 * 0.1 + 20 * 5);
  const zero: TokenRecord = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
  assert.equal(weighted({ ...zero, cacheWrite1h: 600 }), 1200);
});

test("claude: the 5 minute write is the total minus the 1 hour write, never below 0", () => {
  const aggregateOnly = parseClaudeRow(
    assistantRow({ ...BASE_USAGE, cache_creation_input_tokens: 300 }),
    NOW,
  );
  assert.deepEqual(bucketsOf(must(aggregateOnly).tokens), [10, 300, 0, 0, 5]);

  const oneHourLarger = parseClaudeRow(
    assistantRow({
      ...BASE_USAGE,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 250 },
    }),
    NOW,
  );
  assert.deepEqual(bucketsOf(must(oneHourLarger).tokens), [10, 0, 250, 0, 5]);
});

test("claude: absent or null cache fields count as 0", () => {
  const outcome = parseClaudeRow(
    assistantRow({
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: null,
      cache_creation: null,
    }),
    NOW,
  );
  assert.deepEqual(bucketsOf(must(outcome).tokens), [3, 0, 0, 0, 4]);
});

test("claude: a bad number in any bucket skips the row", () => {
  const bad: unknown[] = [-1, 1.5, "7", true, 1e8 + 1, Number.NaN, {}];
  for (const value of bad) {
    for (const field of [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ]) {
      const outcome = parseClaudeRow(assistantRow({ ...BASE_USAGE, [field]: value }), NOW);
      assert.deepEqual(outcome, { ok: false, error: "bad_token" });
    }
  }
  const nested = parseClaudeRow(
    assistantRow({ ...BASE_USAGE, cache_creation: { ephemeral_1h_input_tokens: -4 } }),
    NOW,
  );
  assert.deepEqual(nested, { ok: false, error: "bad_token" });
  const notObject = parseClaudeRow(assistantRow({ ...BASE_USAGE, cache_creation: 7 }), NOW);
  assert.deepEqual(notObject, { ok: false, error: "bad_token" });
  const missingInput = parseClaudeRow(assistantRow({ output_tokens: 1 }), NOW);
  assert.deepEqual(missingInput, { ok: false, error: "bad_token" });
});

test("claude: bad or out of range times skip the row", () => {
  const times: unknown[] = [undefined, "yesterday", 1793692860, "2019-12-31T23:59:59Z", "2026-11-03T12:02:00Z"];
  for (const timestamp of times) {
    const outcome = parseClaudeRow(assistantRow(BASE_USAGE, {}, { timestamp }), NOW);
    assert.deepEqual(outcome, { ok: false, error: "bad_time" });
  }
});

test("claude: an invalid or reserved request id skips even a proxy-shaped message", () => {
  const ids = [null, 7, "", "req with space", "req|pipe", "r".repeat(129), "codex"];
  for (const requestId of ids) {
    const row = assistantRow(
      { output_tokens: -1 },
      { id: "resp_X", model: "gpt-9-test" },
      { requestId, timestamp: undefined },
    );
    assert.deepEqual(parseClaudeRow(row, NOW), { ok: false, error: "missing_id" });
  }
});

test("claude: a missing request id requires a safe proxy message id and model", () => {
  const cases: Row[] = [
    assistantRow(BASE_USAGE, {}, { requestId: undefined }),
    assistantRow(BASE_USAGE, { id: "resp_X", model: "other-test" }, { requestId: undefined }),
    assistantRow(BASE_USAGE, { id: "resp_X", model: "gpt-unsafe model" }, { requestId: undefined }),
    assistantRow(BASE_USAGE, { model: "gpt-9-test" }, { requestId: undefined }),
    assistantRow(BASE_USAGE, { id: "resp_X|other", model: "gpt-9-test" }, { requestId: undefined }),
  ];
  for (const row of cases) {
    assert.deepEqual(parseClaudeRow(row, NOW), { ok: false, error: "missing_id" });
  }
});

test("claude: a missing or unsafe message id skips the row", () => {
  for (const id of [undefined, "msg\nline"]) {
    const row = assistantRow(BASE_USAGE, { id });
    assert.deepEqual(parseClaudeRow(row, NOW), { ok: false, error: "missing_id" });
  }
});

test("claude: rows that are not usage-bearing assistant rows give their reason", () => {
  const user: Row = { type: "user", timestamp: AT_ISO, message: { content: "x", usage: BASE_USAGE } };
  assert.deepEqual(parseClaudeRow(user, NOW), { ok: false, error: "not_assistant" });
  assert.deepEqual(parseClaudeRow({ timestamp: AT_ISO }, NOW), { ok: false, error: "not_assistant" });

  const noMessage: Row = { type: "assistant", timestamp: AT_ISO };
  assert.deepEqual(parseClaudeRow(noMessage, NOW), { ok: false, error: "no_usage" });
  const noUsage: Row = { type: "assistant", timestamp: AT_ISO, message: { id: "m", model: "x" } };
  assert.deepEqual(parseClaudeRow(noUsage, NOW), { ok: false, error: "no_usage" });

  const apiError = assistantRow(BASE_USAGE, {}, { isApiErrorMessage: true });
  assert.deepEqual(parseClaudeRow(apiError, NOW), { ok: false, error: "api_error" });
  const synthetic = assistantRow(BASE_USAGE, { model: "<synthetic>" });
  assert.deepEqual(parseClaudeRow(synthetic, NOW), { ok: false, error: "synthetic" });
  // Only the value true marks an API error.
  const notTrue = assistantRow(BASE_USAGE, {}, { isApiErrorMessage: false });
  assert.ok(parseClaudeRow(notTrue, NOW).ok);
});

test("claude: an unsafe model becomes other and a missing cwd becomes unknown", () => {
  const unsafeModel = must(parseClaudeRow(assistantRow(BASE_USAGE, { model: "bad model\n" }), NOW));
  assert.equal(unsafeModel.model, "other");
  const noModel = must(parseClaudeRow(assistantRow(BASE_USAGE, { model: undefined }), NOW));
  assert.equal(noModel.model, "other");
  const noCwd = must(parseClaudeRow(assistantRow(BASE_USAGE, {}, { cwd: undefined }), NOW));
  assert.equal(noCwd.folderKey, "unknown");
  const emptyCwd = must(parseClaudeRow(assistantRow(BASE_USAGE, {}, { cwd: "" }), NOW));
  assert.equal(emptyCwd.folderKey, "unknown");
  const longCwd = must(parseClaudeRow(assistantRow(BASE_USAGE, {}, { cwd: `/${"d".repeat(500)}` }), NOW));
  assert.equal(longCwd.folderKey.length, 200);
});

test("claude: the entry holds only the fixed fields", () => {
  const entry = must(parseClaudeRow(assistantRow(BASE_USAGE, {}, { extraText: "kept?" }), NOW));
  assert.deepEqual(Object.keys(entry).sort(), ["at", "folderKey", "key", "model", "tokens"]);
  assert.deepEqual(Object.keys(entry.tokens).sort(), [...TOKEN_BUCKETS].sort());
});

// ---------------------------------------------------------------------------
// Codex rows (TP-3 part, TP-4 part)
// ---------------------------------------------------------------------------

const KEY_FORMAT = /^[0-9a-f]{32}$/;

test("codex fixture: counted events, skip reasons and the final file state", () => {
  const run = runCodex("codex-basic.jsonl");
  assert.deepEqual(
    run.entries.map((entry) => [entry.model, entry.folderKey, bucketsOf(entry.tokens)]),
    [
      ["gpt-5-codex", "-work-alpha", [600, 0, 0, 400, 100]],
      ["gpt-5-codex", "-work-alpha", [200, 0, 0, 300, 50]],
      ["gpt-5.1", "-work-alpha", [300, 0, 0, 100, 80]],
      ["gpt-5.1", "-work-alpha", [200, 0, 0, 50, 25]],
    ],
  );
  assert.deepEqual(run.skips, ["ignored_type", "repeat_event", "no_usage", "no_usage", "other_limit"]);
  assert.equal(run.final.sessionId, "sess-parent-0001");
  assert.equal(run.final.folderKey, "-work-alpha");
  assert.equal(run.final.model, "gpt-5.1");
});

test("codex fixture: input excludes cached input, and cache write is 0", () => {
  const run = runCodex("codex-basic.jsonl");
  const first = run.entries[0] as CodexEntry;
  // input_tokens 1000 with cached_input_tokens 400.
  assert.equal(first.tokens.input, 600);
  assert.equal(first.tokens.cacheRead, 400);
  assert.equal(first.tokens.output, 100);
  assert.equal(first.tokens.cacheWrite5m, 0);
  assert.equal(first.tokens.cacheWrite1h, 0);
});

test("codex fixture: a repeat of the event before it is skipped", () => {
  const run = runCodex("codex-basic.jsonl");
  // Two token_count rows hold the same event; one entry is counted.
  const counted = run.entries.filter((entry) => entry.tokens.output === 50);
  assert.equal(counted.length, 1);
  assert.equal(run.skips.filter((reason) => reason === "repeat_event").length, 1);
});

test("codex fixture: keys are fixed length hashes, and a missing total gives no key", () => {
  const run = runCodex("codex-basic.jsonl");
  const keys = run.entries.map((entry) => entry.key);
  assert.equal(keys[3], null);
  const withKey = keys.slice(0, 3);
  for (const key of withKey) assert.match(key ?? "", KEY_FORMAT);
  assert.equal(new Set(withKey).size, 3);
});

// Stored keys must stay valid, so the key format is pinned. The value is the first
// 32 hex characters of sha256 over
// "k|gpt-5-codex|1000,400,100,30,1100|1000,400,100,30,1100".
test("codex: the key of the first fixture event is pinned", () => {
  const run = runCodex("codex-basic.jsonl");
  assert.equal((run.entries[0] as CodexEntry).key, "126271951f72dd4fd2d026d314bfa170");
});

test("codex: the key depends on the model, the last usage and the total", () => {
  const info = { last_token_usage: LAST_USAGE, total_token_usage: LAST_USAGE };
  const base = { ...CODEX_INITIAL_STATE, model: "gpt-5-codex" };
  const key = (state: CodexFileState, i: Record<string, unknown>): string | null =>
    stepFrom(state, countRow(i)).entry?.key ?? null;
  const reference = key(base, info);
  assert.match(reference ?? "", KEY_FORMAT);
  assert.notEqual(key({ ...base, model: "gpt-5.1" }, info), reference);
  assert.notEqual(
    key(base, { ...info, last_token_usage: { ...LAST_USAGE, output_tokens: 101 } }),
    reference,
  );
  assert.notEqual(
    key(base, { ...info, total_token_usage: { ...LAST_USAGE, output_tokens: 101 } }),
    reference,
  );
  // Session id, folder and time are not part of the key.
  const moved = { ...base, sessionId: "other-session", folderKey: "-elsewhere" };
  assert.equal(stepFrom(moved, countRow(info, undefined, "2026-11-03T09:30:00.000Z")).entry?.key, reference);
});

test("codex: reasoning tokens are a part of output and are not added", () => {
  const info = { last_token_usage: { ...LAST_USAGE, reasoning_output_tokens: 90 } };
  const entry = stepFrom(CODEX_INITIAL_STATE, countRow(info)).entry as CodexEntry;
  assert.equal(entry.tokens.output, 100);
});

test("codex: cached input above input gives input 0, never negative", () => {
  const info = { last_token_usage: { input_tokens: 50, cached_input_tokens: 80, output_tokens: 7 } };
  const entry = stepFrom(CODEX_INITIAL_STATE, countRow(info)).entry as CodexEntry;
  assert.deepEqual(bucketsOf(entry.tokens), [0, 0, 0, 80, 7]);
});

test("codex: an absent cached count is 0", () => {
  const info = { last_token_usage: { input_tokens: 50, output_tokens: 7 } };
  const entry = stepFrom(CODEX_INITIAL_STATE, countRow(info)).entry as CodexEntry;
  assert.deepEqual(bucketsOf(entry.tokens), [50, 0, 0, 0, 7]);
});

const CODEX_BASE = { ...CODEX_INITIAL_STATE, model: "gpt-5-codex" };

function cacheWriteEvent(cacheWrite: Record<string, unknown>): Record<string, unknown> {
  return { last_token_usage: { ...LAST_USAGE, ...cacheWrite }, total_token_usage: LAST_USAGE };
}

test("TP-30: a valid cache write moves from input to the five minute column; the raw total and the key stay as they were", () => {
  const plain = stepFrom(CODEX_BASE, countRow(cacheWriteEvent({}))).entry as CodexEntry;
  const written = stepFrom(CODEX_BASE, countRow(cacheWriteEvent({ cache_write_input_tokens: 300 }))).entry as CodexEntry;
  // input_tokens 1000 holds cached 400 and cache write 300; 300 is left as plain input.
  assert.deepEqual(bucketsOf(plain.tokens), [600, 0, 0, 400, 100]);
  assert.deepEqual(bucketsOf(written.tokens), [300, 300, 0, 400, 100]);
  assert.equal(rawTokens(written.tokens), rawTokens(plain.tokens));
  assert.equal(weighted(written.tokens) - weighted(plain.tokens), 300 * (WEIGHTS.cacheWrite5m - WEIGHTS.input));
  assert.equal(written.cacheInvalid, false);
  assert.equal(written.key, plain.key, "the dedupe text does not hold the cache write");
});

test("TP-30: a cache write above the uncached input moves only what the input holds, so the raw total never grows", () => {
  const room = stepFrom(CODEX_BASE, countRow(cacheWriteEvent({ cache_write_input_tokens: 900 }))).entry as CodexEntry;
  assert.deepEqual(bucketsOf(room.tokens), [0, 600, 0, 400, 100]);
  assert.equal(room.cacheInvalid, false);
  const noRoom = { last_token_usage: { input_tokens: 50, cached_input_tokens: 80, cache_write_input_tokens: 10, output_tokens: 7 } };
  const cachedAbove = stepFrom(CODEX_BASE, countRow(noRoom)).entry as CodexEntry;
  assert.deepEqual(bucketsOf(cachedAbove.tokens), [0, 0, 0, 80, 7]);
});

test("TP-30: an absent or null cache write is 0 and is not invalid", () => {
  for (const value of [undefined, null, 0]) {
    const entry = stepFrom(CODEX_BASE, countRow(cacheWriteEvent({ cache_write_input_tokens: value }))).entry as CodexEntry;
    assert.deepEqual(bucketsOf(entry.tokens), [600, 0, 0, 400, 100], String(value));
    assert.equal(entry.cacheInvalid, false, String(value));
  }
});

test("TP-31: an invalid cache write counts as 0, flags the entry, and the event stays", () => {
  const plain = stepFrom(CODEX_BASE, countRow(cacheWriteEvent({}))).entry as CodexEntry;
  const bad: unknown[] = [-1, 2.5, "300", true, 1e8 + 1, {}, [300]];
  for (const value of bad) {
    const step = stepFrom(CODEX_BASE, countRow(cacheWriteEvent({ cache_write_input_tokens: value })));
    assert.ok(step.entry !== null, JSON.stringify(value));
    const entry = step.entry;
    assert.deepEqual(bucketsOf(entry.tokens), bucketsOf(plain.tokens), JSON.stringify(value));
    assert.equal(entry.cacheInvalid, true, JSON.stringify(value));
    assert.equal(entry.key, plain.key, JSON.stringify(value));
    assert.deepEqual(step.skips, [], "an invalid cache write is counted on its own, not as a skip");
  }
});

test("TP-31: a repeat of an event with an invalid cache write is skipped, so it is counted once", () => {
  const row = countRow(cacheWriteEvent({ cache_write_input_tokens: -5 }));
  const first = stepFrom(CODEX_BASE, row);
  assert.equal(first.entry?.cacheInvalid, true);
  const repeat = stepFrom(first.state, row);
  assert.equal(repeat.entry, null);
  assert.deepEqual(repeat.skips, ["repeat_event"]);
});

test("codex: bad numbers skip the event and leave the state alone", () => {
  const bad: unknown[] = [-1, 2.5, "9", true, 1e8 + 1, null];
  for (const value of bad) {
    for (const field of ["input_tokens", "cached_input_tokens", "output_tokens"]) {
      const last = { ...LAST_USAGE, [field]: value };
      // null is an absent optional field, so only the required ones fail on null.
      const optionalNull = value === null && field === "cached_input_tokens";
      const step = stepFrom(CODEX_INITIAL_STATE, countRow({ last_token_usage: last }));
      if (optionalNull) {
        assert.ok(step.entry !== null);
        continue;
      }
      assert.equal(step.entry, null);
      assert.deepEqual(step.skips, ["bad_token"]);
      assert.deepEqual(step.state, CODEX_INITIAL_STATE);
    }
  }
  const badTotal = stepFrom(
    CODEX_INITIAL_STATE,
    countRow({ last_token_usage: LAST_USAGE, total_token_usage: { ...LAST_USAGE, input_tokens: -3 } }),
  );
  assert.equal(badTotal.entry, null);
  assert.deepEqual(badTotal.skips, ["bad_token"]);
  const totalNotObject = stepFrom(
    CODEX_INITIAL_STATE,
    countRow({ last_token_usage: LAST_USAGE, total_token_usage: 12 }),
  );
  assert.equal(totalNotObject.entry, null);
  assert.deepEqual(totalNotObject.skips, ["bad_token"]);
});

test("codex: a cumulative total above the per-event cap is still a valid key input", () => {
  const total = { ...LAST_USAGE, input_tokens: 5e9, cached_input_tokens: 4e9, total_tokens: 5.1e9 };
  const step = stepFrom(CODEX_INITIAL_STATE, countRow({ last_token_usage: LAST_USAGE, total_token_usage: total }));
  assert.match(step.entry?.key ?? "", KEY_FORMAT);
  assert.deepEqual(step.skips, []);
});

test("codex: a bad time skips the event, quota included", () => {
  const rate = { primary: windowOf(300, 10, RESET_5H_SECONDS) };
  for (const timestamp of ["nope", "2019-01-01T00:00:00Z", "2026-11-03T12:05:00Z"]) {
    const step = stepFrom(CODEX_INITIAL_STATE, countRow({ last_token_usage: LAST_USAGE }, rate, timestamp));
    assert.equal(step.entry, null);
    assert.deepEqual(step.quota, []);
    assert.deepEqual(step.skips, ["bad_time"]);
  }
});

test("codex: no usage object gives no entry and the reason", () => {
  for (const info of [null, undefined, "text", 3, {}, { last_token_usage: null }, { total_token_usage: LAST_USAGE }]) {
    const step = stepFrom(CODEX_INITIAL_STATE, countRow(info));
    assert.equal(step.entry, null);
    assert.deepEqual(step.skips, ["no_usage"]);
  }
});

test("codex: rows of other types are ignored and change nothing", () => {
  const rows: Row[] = [
    { timestamp: AT_ISO, type: "response_item", payload: { type: "message" } },
    { timestamp: AT_ISO, type: "event_msg", payload: { type: "user_message", message: "x" } },
    { timestamp: AT_ISO, type: "event_msg" },
    { timestamp: AT_ISO },
  ];
  for (const row of rows) {
    const step = stepFrom(CODEX_INITIAL_STATE, row);
    assert.deepEqual(step, { state: CODEX_INITIAL_STATE, entry: null, quota: [], skips: ["ignored_type"] });
  }
});

test("codex: an event equal to the one before it is skipped, not one after another event", () => {
  const info = { last_token_usage: LAST_USAGE, total_token_usage: LAST_USAGE };
  const other = { last_token_usage: { ...LAST_USAGE, output_tokens: 5 }, total_token_usage: LAST_USAGE };
  const first = stepFrom(CODEX_INITIAL_STATE, countRow(info));
  assert.ok(first.entry !== null);
  const repeat = stepFrom(first.state, countRow(info));
  assert.equal(repeat.entry, null);
  assert.deepEqual(repeat.skips, ["repeat_event"]);
  assert.deepEqual(repeat.state, first.state);

  const between = stepFrom(first.state, countRow(other));
  assert.ok(between.entry !== null);
  const again = stepFrom(between.state, countRow(info));
  assert.ok(again.entry !== null, "an equal event that is not next to its twin is left to the key dedupe");
});

test("codex: without a total the time is part of the identity", () => {
  const info = { last_token_usage: LAST_USAGE };
  const first = stepFrom(CODEX_INITIAL_STATE, countRow(info));
  const sameTime = stepFrom(first.state, countRow(info));
  assert.deepEqual(sameTime.skips, ["repeat_event"]);
  const later = stepFrom(first.state, countRow(info, undefined, "2026-11-03T08:02:00.000Z"));
  assert.ok(later.entry !== null);
  assert.equal(later.entry.key, null);
});

test("codex: a rate limit only event does not break the repeat check", () => {
  const info = { last_token_usage: LAST_USAGE, total_token_usage: LAST_USAGE };
  const first = stepFrom(CODEX_INITIAL_STATE, countRow(info));
  const limitOnly = stepFrom(first.state, countRow(null, { primary: windowOf(300, 10, RESET_5H_SECONDS) }));
  assert.deepEqual(limitOnly.state, first.state);
  const repeat = stepFrom(limitOnly.state, countRow(info));
  assert.deepEqual(repeat.skips, ["repeat_event"]);
});

test("codex: the entry holds only the fixed fields", () => {
  const step = stepFrom(CODEX_INITIAL_STATE, countRow({ last_token_usage: LAST_USAGE, total_token_usage: LAST_USAGE }));
  assert.deepEqual(Object.keys(step.entry as CodexEntry).sort(), ["at", "cacheInvalid", "folderKey", "key", "model", "tokens"]);
  assert.deepEqual(Object.keys(step.state).sort(), ["folderKey", "metaSeen", "model", "previous", "sessionId"]);
});

test("codex: a step does not change the state or the row it was given", () => {
  const state = Object.freeze({ ...CODEX_INITIAL_STATE });
  const row = countRow(
    { last_token_usage: LAST_USAGE, total_token_usage: LAST_USAGE },
    { primary: windowOf(300, 10, RESET_5H_SECONDS) },
  );
  const before = structuredClone(row);
  const step = stepFrom(state, row);
  assert.deepEqual(row, before);
  assert.notEqual(step.state, state);
  assert.deepEqual(state, CODEX_INITIAL_STATE);
});

// Session meta and turn context

test("codex: the session id is session_id, else id, and must be a safe id", () => {
  const both = stepFrom(CODEX_INITIAL_STATE, metaRow({ session_id: "sid-1", id: "id-2", cwd: "/a" }));
  assert.equal(both.state.sessionId, "sid-1");
  const onlyId = stepFrom(CODEX_INITIAL_STATE, metaRow({ id: "id-2", cwd: "/a/b" }));
  assert.equal(onlyId.state.sessionId, "id-2");
  assert.equal(onlyId.state.folderKey, "-a-b");
  const unsafe = stepFrom(CODEX_INITIAL_STATE, metaRow({ session_id: "bad id", id: "id-3" }));
  assert.equal(unsafe.state.sessionId, "id-3");
  const none = stepFrom(CODEX_INITIAL_STATE, metaRow({ cwd: 12 }));
  assert.equal(none.state.sessionId, null);
  assert.equal(none.state.folderKey, "unknown");
  assert.equal(none.state.metaSeen, true);
});

test("codex: only the first session_meta of a file counts, even when it is empty", () => {
  const first = stepFrom(CODEX_INITIAL_STATE, metaRow({}));
  const second = stepFrom(first.state, metaRow({ id: "later", cwd: "/later" }));
  assert.equal(second.state.sessionId, null);
  assert.equal(second.state.folderKey, "unknown");
  assert.deepEqual(second.skips, []);
});

test("codex: the model is the latest turn_context model, else other", () => {
  const one = stepFrom(CODEX_INITIAL_STATE, contextRow({ model: "gpt-5-codex" }));
  assert.equal(one.state.model, "gpt-5-codex");
  const two = stepFrom(one.state, contextRow({ model: "gpt-5.1" }));
  assert.equal(two.state.model, "gpt-5.1");
  const bad = stepFrom(two.state, contextRow({ model: "bad model" }));
  assert.equal(bad.state.model, "other");
  const missing = stepFrom(two.state, contextRow({}));
  assert.equal(missing.state.model, "other");
  const noPayload = stepFrom(two.state, { timestamp: AT_ISO, type: "turn_context" });
  assert.equal(noPayload.state.model, "other");
});

// Child rollouts (TP-4 part)

test("codex child: the first session_meta wins over a later one", () => {
  const run = runCodex("codex-child.jsonl");
  // The copied parent prefix comes first, so its id and folder win.
  assert.equal(run.final.sessionId, "sess-parent-0001");
  assert.equal(run.final.folderKey, "-work-alpha");
  assert.ok(run.entries.every((entry) => entry.folderKey === "-work-alpha"));
});

test("codex child: copied events give the same keys as the parent events", () => {
  const parent = runCodex("codex-basic.jsonl");
  const child = runCodex("codex-child.jsonl");
  const parentKeys = parent.entries.slice(0, 2).map((entry) => entry.key);
  const childKeys = child.entries.map((entry) => entry.key);
  assert.deepEqual(childKeys.slice(0, 2), parentKeys);
  // The child's own event has a key no parent event has.
  assert.equal(child.entries.length, 3);
  assert.ok(!parent.entries.some((entry) => entry.key === childKeys[2]));
  assert.match(childKeys[2] ?? "", KEY_FORMAT);
});

test("codex child: copied events carry the same buckets and a later restamped time", () => {
  const parent = runCodex("codex-basic.jsonl");
  const child = runCodex("codex-child.jsonl");
  for (const index of [0, 1]) {
    const original = parent.entries[index] as CodexEntry;
    const copy = child.entries[index] as CodexEntry;
    assert.deepEqual(copy.tokens, original.tokens);
    assert.equal(copy.model, original.model);
    assert.ok(copy.at > original.at, "the copy is restamped later than its source");
  }
  assert.deepEqual(bucketsOf((child.entries[2] as CodexEntry).tokens), [200, 0, 0, 100, 40]);
});

test("codex child with its own first meta: its id and folder win, copies keep the parent keys", () => {
  const parent = runCodex("codex-basic.jsonl");
  const child = runCodex("codex-child-own-meta.jsonl");
  assert.equal(child.final.sessionId, "sess-child-0003");
  assert.equal(child.final.folderKey, "-work-gamma");
  assert.ok(child.entries.every((entry) => entry.folderKey === "-work-gamma"));
  assert.deepEqual(
    child.entries.slice(0, 2).map((entry) => entry.key),
    parent.entries.slice(0, 2).map((entry) => entry.key),
  );
  assert.equal(child.entries.length, 3);
  assert.deepEqual(bucketsOf((child.entries[2] as CodexEntry).tokens), [150, 0, 0, 50, 30]);
  assert.ok(!parent.entries.some((entry) => entry.key === child.entries[2]?.key));
});

test("codex child files: the two child files hold different own events", () => {
  const one = runCodex("codex-child.jsonl");
  const two = runCodex("codex-child-own-meta.jsonl");
  assert.notEqual(one.entries[2]?.key, two.entries[2]?.key);
});

// ---------------------------------------------------------------------------
// Codex quota
// ---------------------------------------------------------------------------

test("codex fixture: quota samples come in event order with percent and reset time", () => {
  const run = runCodex("codex-basic.jsonl");
  const sample = (clock: string, window: "five_hour" | "week", usedPercent: number): CodexQuotaSample => ({
    window,
    at: Date.parse(`2026-11-03T${clock}.000Z`),
    usedPercent,
    resetsAt: (window === "five_hour" ? RESET_5H_SECONDS : RESET_WEEK_SECONDS) * 1000,
    reached: false,
  });
  assert.deepEqual(run.quota, [
    sample("08:01:00", "five_hour", 12.5),
    sample("08:01:00", "week", 40),
    sample("08:02:00", "five_hour", 15),
    sample("08:02:00", "week", 41),
    sample("08:03:00", "five_hour", 16),
    sample("08:03:00", "week", 41),
    sample("08:05:00", "five_hour", 20),
    sample("08:05:00", "week", 42),
  ]);
});

test("codex quota: the window comes from window_minutes, not from the slot name", () => {
  const swapped = quotaStep({
    limit_id: "codex",
    primary: windowOf(10080, 30, RESET_WEEK_SECONDS),
    secondary: windowOf(300, 5, RESET_5H_SECONDS),
  });
  assert.deepEqual(
    swapped.quota.map((q) => [q.window, q.usedPercent]),
    [
      ["week", 30],
      ["five_hour", 5],
    ],
  );
});

test("codex quota: a missing limit_id counts, another limit_id does not", () => {
  const absent = quotaStep({ primary: windowOf(300, 5, RESET_5H_SECONDS) });
  assert.equal(absent.quota.length, 1);
  const named = quotaStep({ limit_id: "codex", primary: windowOf(300, 5, RESET_5H_SECONDS) });
  assert.equal(named.quota.length, 1);
  const other = quotaStep({ limit_id: "codex_other", primary: windowOf(300, 5, RESET_5H_SECONDS) });
  assert.deepEqual(other.quota, []);
  assert.ok(other.skips.includes("other_limit"));
});

test("codex quota: used percent must be a number from 0 to 100", () => {
  for (const percent of [0, 100, 0.5]) {
    assert.equal(quotaStep({ primary: windowOf(300, percent, RESET_5H_SECONDS) }).quota.length, 1);
  }
  for (const percent of [-0.1, 100.1, "50", null, undefined, true, {}]) {
    const step = quotaStep({ primary: windowOf(300, percent, RESET_5H_SECONDS) });
    assert.deepEqual(step.quota, []);
    assert.ok(step.skips.includes("bad_percent"));
  }
});

test("codex quota: only 300 and 10080 minutes are known windows", () => {
  for (const minutes of [60, 299, 301, 10079, "300", null, undefined, 0]) {
    const step = quotaStep({ primary: windowOf(minutes, 10, RESET_5H_SECONDS) });
    assert.deepEqual(step.quota, []);
    assert.ok(step.skips.includes("bad_window"));
  }
});

test("codex quota: the reset time is after the event and within 8 days", () => {
  const accepted = [AT_SECONDS + 1, AT_SECONDS + EIGHT_DAYS_SECONDS, RESET_5H_SECONDS + 0.5];
  for (const resets of accepted) {
    assert.equal(quotaStep({ primary: windowOf(300, 10, resets) }).quota.length, 1);
  }
  const rejected = [AT_SECONDS, AT_SECONDS - 60, AT_SECONDS + EIGHT_DAYS_SECONDS + 1, -5, 0, "1793703600", null, undefined, true];
  for (const resets of rejected) {
    const step = quotaStep({ primary: windowOf(300, 10, resets) });
    assert.deepEqual(step.quota, []);
    assert.ok(step.skips.includes("bad_reset"));
  }
});

test("codex quota: a reset time in milliseconds is read as milliseconds", () => {
  const step = quotaStep({ primary: windowOf(300, 10, RESET_5H_SECONDS * 1000) });
  assert.equal(step.quota[0]?.resetsAt, RESET_5H_SECONDS * 1000);
});

test("codex quota: one bad window does not drop the other", () => {
  const step = quotaStep({
    primary: windowOf(300, 500, RESET_5H_SECONDS),
    secondary: windowOf(10080, 40, RESET_WEEK_SECONDS),
  });
  assert.deepEqual(step.quota.map((q) => q.window), ["week"]);
  assert.deepEqual(step.skips.filter((reason) => reason !== "no_usage"), ["bad_percent"]);
});

test("codex quota: missing windows and missing rate limits give no samples and no reasons", () => {
  for (const limits of [undefined, null, {}, { primary: null }, { primary: "x", secondary: [] }, [], 5]) {
    const step = quotaStep(limits);
    assert.deepEqual(step.quota, []);
    assert.deepEqual(step.skips, ["no_usage"]);
  }
});

test("codex quota: a reached type marks both windows and does not retain its text", () => {
  const step = quotaStep({
    primary: windowOf(300, 10, RESET_5H_SECONDS),
    secondary: windowOf(10080, 40, RESET_WEEK_SECONDS),
    rate_limit_reached_type: "rate_limit_reached",
  });
  assert.deepEqual(step.quota, [
    { window: "five_hour", at: AT_SECONDS * 1000, usedPercent: 10, resetsAt: RESET_5H_SECONDS * 1000, reached: true },
    { window: "week", at: AT_SECONDS * 1000, usedPercent: 40, resetsAt: RESET_WEEK_SECONDS * 1000, reached: true },
  ]);
});

test("codex quota: an empty or invalid reached type does not mark the reading", () => {
  for (const reachedType of [undefined, null, "", true, 1, {}]) {
    const step = quotaStep({
      primary: windowOf(300, 10, RESET_5H_SECONDS),
      rate_limit_reached_type: reachedType,
    });
    assert.equal(step.quota[0]?.reached, false);
  }
});

test("codex quota: a counted event carries its samples too", () => {
  const step = stepFrom(
    CODEX_INITIAL_STATE,
    countRow({ last_token_usage: LAST_USAGE }, { primary: windowOf(300, 10, RESET_5H_SECONDS) }),
  );
  assert.ok(step.entry !== null);
  assert.equal(step.quota.length, 1);
});

// ---------------------------------------------------------------------------
// Canary (TP-10 part)
// ---------------------------------------------------------------------------

const FIXTURE_NAMES = [
  "claude-basic.jsonl",
  "claude-proxy.jsonl",
  "codex-basic.jsonl",
  "codex-child.jsonl",
  "codex-child-own-meta.jsonl",
] as const;

const TEXT_KEYS = new Set([
  "text",
  "thinking",
  "content",
  "command",
  "instructions",
  "message",
  "summary",
  "stdout",
]);
const WALK_DEPTH_MAX = 16;

function textFields(value: unknown, key: string, depth: number, found: string[]): void {
  if (depth > WALK_DEPTH_MAX) return;
  if (typeof value === "string") {
    if (TEXT_KEYS.has(key)) found.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) textFields(item, key, depth + 1, found);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) textFields(child, childKey, depth + 1, found);
  }
}

test("canary fixtures: every text field of every fixture holds the canary", () => {
  for (const name of FIXTURE_NAMES) {
    const found: string[] = [];
    const lines = readFileSync(fixture(name), "utf8").split("\n").filter((line) => line.length > 0);
    for (const line of lines) {
      try {
        textFields(JSON.parse(line), "", 0, found);
      } catch {
        // A broken line is checked as raw text below.
      }
    }
    assert.ok(found.length > 0, `${name} has text fields`);
    for (const text of found) assert.ok(text.includes(CANARY), `${name}: a text field has no canary`);
    if (name.startsWith("claude")) {
      assert.ok(lines.every((line) => line.includes(CANARY)), `${name}: a line has no canary`);
    }
  }
});

test("canary: no parser output holds the canary", () => {
  for (const name of FIXTURE_NAMES) {
    const run = name.startsWith("claude") ? runClaude(name) : runCodex(name);
    const rows = "outcomes" in run ? run.outcomes : run.steps;
    assert.ok(rows.length > 0);
    assert.ok(!JSON.stringify(run).includes(CANARY), `${name}: output holds the canary`);
  }
});

test("canary: a canary in a model, id or quota text field never reaches the output", () => {
  const model = must(parseClaudeRow(assistantRow(BASE_USAGE, { model: `${CANARY} model text` }), NOW));
  assert.equal(model.model, "other");
  const id = parseClaudeRow(assistantRow(BASE_USAGE, { id: `${CANARY} id text` }), NOW);
  assert.ok(!JSON.stringify(id).includes(CANARY));
  const meta = stepFrom(CODEX_INITIAL_STATE, metaRow({ id: `${CANARY} id text`, cwd: 5, instructions: CANARY }));
  assert.ok(!JSON.stringify(meta).includes(CANARY));
  const context = stepFrom(CODEX_INITIAL_STATE, contextRow({ model: `${CANARY} model text`, instructions: CANARY }));
  assert.ok(!JSON.stringify(context).includes(CANARY));
  const limits = quotaStep({ limit_id: CANARY, primary: windowOf(CANARY, CANARY, CANARY) });
  assert.ok(!JSON.stringify(limits).includes(CANARY));
});
