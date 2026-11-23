// Tests for the store and the collect pass (plan 3.3, 3.4, 3.8, 3.10).
// TP-3, TP-4, TP-13 and the store part of TP-18.
//
// Every source root, data folder and write is inside a sandbox with a fixed
// clock. No test reads or writes the real home.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  LOCK_REFRESH_MS,
  LOCK_STALE_MS,
  type Result,
  SCAN_BUDGET_BYTES,
  SCAN_BUDGET_MS,
  SLOT_MS,
  weighted,
} from "../src/core.ts";
import { JOURNAL_FILE } from "../src/commit.ts";
import { type FsDeps, acquireLock, defaultDeps, listDir, lstatEntry, prepareDataDir, removeFile } from "../src/fsafe.ts";
import {
  type CollectError,
  type CollectInput,
  type CollectReport,
  DEFAULT_BUDGET,
  collect,
} from "../src/collect.ts";
import {
  DAY_MS,
  FILE_CAPS,
  LEDGER_FILE,
  SLOTS_PER_DAY,
  STORE_FILE,
  bucketKey,
  bucketsFileName,
  crossDayClaudeKeys,
  dayName,
  dayOfSlot,
  dedupeFileName,
  horizonStartMs,
  loadBucketMonth,
  loadDayRows,
  monthName,
  slotOf,
} from "../src/store.ts";
import { zoneNamed } from "../src/periods.ts";
import { quotaMonthFile, storeCodexQuota } from "../src/quota.ts";
import { CLAUDE_PARSER_REV, CODEX_INITIAL_STATE, type CodexQuotaSample, stepCodexRow } from "../src/sources.ts";
import { type Sandbox, assertGuarded, installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const MIB = 1024 * 1024;
const FIXTURES = join(import.meta.dirname, "fixtures");
const DEPS: FsDeps = { ...defaultDeps(), nowMs: () => NOW };
const BIG_BUDGET = { bytes: SCAN_BUDGET_BYTES, ms: SCAN_BUDGET_MS };
const MONTHS = ["2026-10", "2026-11"] as const;
// Old enough to be inside the horizon and older than the lines under test.
const DEFAULT_MTIME = NOW - HOUR_MS;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function must<T, E>(result: Result<T, E>): T {
  if (!result.ok) assert.fail(`expected an ok result, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function mustFail<T, E>(result: Result<T, E>): E {
  if (result.ok) assert.fail("expected an error result");
  return result.error;
}

interface World {
  readonly sb: Sandbox;
  readonly data: string;
  readonly claude: string;
  readonly codex: string;
}

function makeWorld(t: TestContext): World {
  const sb = makeSandbox(t);
  const data = must(prepareDataDir(sb.dataDir, DEPS));
  const claude = sb.path("src-claude");
  const codex = sb.path("src-codex");
  mkdirSync(claude);
  mkdirSync(codex);
  return { sb, data, claude, codex };
}

function inputOf(w: World, patch: Partial<CollectInput> = {}): CollectInput {
  return { dataDir: w.data, roots: { claude: w.claude, codex: w.codex }, budget: BIG_BUDGET, ...patch };
}

function pass(w: World, patch: Partial<CollectInput> = {}, deps: FsDeps = DEPS): Result<CollectReport, CollectError> {
  return collect(inputOf(w, patch), deps);
}

function passOk(w: World, patch: Partial<CollectInput> = {}, deps: FsDeps = DEPS): CollectReport {
  return must(pass(w, patch, deps));
}

function touch(path: string, mtimeMs: number): void {
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

function put(path: string, text: string, mtimeMs: number = DEFAULT_MTIME): void {
  assertGuarded(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  touch(path, mtimeMs);
}

function append(path: string, text: string, mtimeMs: number = DEFAULT_MTIME + 5 * MINUTE_MS): void {
  assertGuarded(path);
  appendFileSync(path, text);
  touch(path, mtimeMs);
}

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

type Totals = Readonly<Record<string, readonly number[]>>;

function totals(w: World): Totals {
  const out: Record<string, readonly number[]> = {};
  for (const month of MONTHS) {
    for (const [key, value] of must(loadBucketMonth(w.data, month, DEPS))) out[key] = value;
  }
  return out;
}

function rowKey(iso: string, provider: "claude" | "codex", model: string, folder: string): string {
  return bucketKey(slotOf(Date.parse(iso)), provider, model, folder);
}

function fileKeyOf(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Facts of every entry in a folder, to prove that a pass wrote nothing.
interface FileFacts {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ino: number;
  readonly link: boolean;
  readonly body: string | null;
}

function snapshot(dir: string): ReadonlyMap<string, FileFacts> {
  const out = new Map<string, FileFacts>();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const info = lstatSync(path);
    const small = info.isFile() && info.size <= MIB;
    out.set(name, {
      size: info.size,
      mtimeMs: info.mtimeMs,
      ino: info.ino,
      link: info.isSymbolicLink(),
      body: small ? readFileSync(path, "utf8") : null,
    });
  }
  return out;
}

// --- Claude rows ---

interface ClaudeSpec {
  readonly id: string;
  readonly at: string;
  readonly output?: number;
  readonly input?: number;
  readonly cw5m?: number;
  readonly cw1h?: number;
  readonly cacheRead?: number;
  readonly cwd?: string;
  readonly model?: string;
}

function claudeLine(spec: ClaudeSpec): string {
  const oneHour = spec.cw1h ?? 0;
  const fiveMinutes = spec.cw5m ?? 0;
  const usage: Record<string, unknown> = {
    input_tokens: spec.input ?? 1,
    cache_creation_input_tokens: fiveMinutes + oneHour,
    cache_read_input_tokens: spec.cacheRead ?? 0,
    output_tokens: spec.output ?? 1,
  };
  if (oneHour > 0) {
    usage["cache_creation"] = { ephemeral_5m_input_tokens: fiveMinutes, ephemeral_1h_input_tokens: oneHour };
  }
  return JSON.stringify({
    type: "assistant",
    timestamp: spec.at,
    cwd: spec.cwd ?? "/work/alpha",
    requestId: `req_${spec.id}`,
    message: { id: `msg_${spec.id}`, model: spec.model ?? "claude-sonnet-5-5", usage },
  });
}

function claudeLines(...specs: readonly ClaudeSpec[]): string {
  return specs.map((spec) => `${claudeLine(spec)}\n`).join("");
}

const PROXY_MODEL = "gpt-9-test";

function proxyLine(id: string, at: string, output: number): string {
  return `${JSON.stringify({
    type: "assistant",
    timestamp: at,
    cwd: "/work/alpha",
    message: {
      id: `resp_${id}`,
      model: PROXY_MODEL,
      usage: { input_tokens: 100, cache_read_input_tokens: 30, output_tokens: output },
    },
  })}\n`;
}

// --- Codex rows ---

const RESET_5H_SECONDS = 1793703600;
const RESET_WEEK_SECONDS = 1794009600;

function codexMeta(at: string, id: string, cwd: string): string {
  return `${JSON.stringify({ timestamp: at, type: "session_meta", payload: { id, cwd } })}\n`;
}

function codexTurn(at: string, model: string): string {
  return `${JSON.stringify({ timestamp: at, type: "turn_context", payload: { model } })}\n`;
}

interface CodexSpec {
  readonly at: string;
  readonly n: number;
  readonly percent?: { readonly five: number; readonly week: number };
}

// Event n has its own last and total usage, so its key is its own.
function codexEvent(spec: CodexSpec): string {
  const last = {
    input_tokens: 100 + spec.n,
    cached_input_tokens: 10,
    output_tokens: 5,
    reasoning_output_tokens: 0,
    total_tokens: 105 + spec.n,
  };
  const total = { ...last, input_tokens: 1000 + spec.n, total_tokens: 1005 + spec.n };
  const payload: Record<string, unknown> = {
    type: "token_count",
    info: { total_token_usage: total, last_token_usage: last },
  };
  if (spec.percent !== undefined) {
    payload["rate_limits"] = {
      limit_id: "codex",
      primary: { used_percent: spec.percent.five, window_minutes: 300, resets_at: RESET_5H_SECONDS },
      secondary: { used_percent: spec.percent.week, window_minutes: 10080, resets_at: RESET_WEEK_SECONDS },
    };
  }
  return `${JSON.stringify({ timestamp: spec.at, type: "event_msg", payload })}\n`;
}

function minuteIso(base: string, minutes: number): string {
  return new Date(Date.parse(base) + minutes * MINUTE_MS).toISOString();
}

const PROJECT = "-work-alpha";

function claudeFile(w: World, name: string, project: string = PROJECT): string {
  return join(w.claude, project, `${name}.jsonl`);
}

function codexFile(w: World, name: string, day: string = "2026/11/03"): string {
  return join(w.codex, ...day.split("/"), `rollout-${name}.jsonl`);
}

// A mixed corpus: many Claude files (with cross-file repeats), the three Codex
// fixtures and one big Codex file with a model change in the middle.
function seedMixed(w: World): void {
  for (let i = 0; i < 8; i += 1) {
    const specs: ClaudeSpec[] = [];
    for (let j = 0; j < 25; j += 1) {
      specs.push({
        id: `f${i}m${j}`,
        at: minuteIso("2026-11-02T06:00:00Z", i * 40 + j),
        output: 10 + j,
        cwd: `/work/p${i % 3}`,
        model: i % 2 === 0 ? "claude-sonnet-5-5" : "claude-opus-4-5",
      });
    }
    if (i > 0) {
      // The first message of the file before it, as a copy with a larger output.
      specs.push({
        id: `f${i - 1}m0`,
        at: minuteIso("2026-11-02T06:00:00Z", (i - 1) * 40 + 0),
        output: 99,
        cwd: `/work/p${(i - 1) % 3}`,
        model: (i - 1) % 2 === 0 ? "claude-sonnet-5-5" : "claude-opus-4-5",
      });
    }
    put(claudeFile(w, `s${i}`, `-work-p${i % 3}`), claudeLines(...specs), NOW - (i + 3) * 10 * MINUTE_MS);
  }
  put(codexFile(w, "a-parent"), fixtureText("codex-basic.jsonl"), NOW - 5 * MINUTE_MS);
  put(codexFile(w, "b-child"), fixtureText("codex-child.jsonl"), NOW - 25 * MINUTE_MS);
  put(codexFile(w, "c-child-own"), fixtureText("codex-child-own-meta.jsonl"), NOW - 45 * MINUTE_MS);
  let big = codexMeta("2026-11-02T20:00:00.000Z", "sess-big", "/work/big");
  big += codexTurn("2026-11-02T20:00:01.000Z", "gpt-5-codex");
  for (let n = 0; n < 60; n += 1) {
    if (n === 30) big += codexTurn(minuteIso("2026-11-02T20:00:00Z", 30), "gpt-5.1");
    big += codexEvent({ at: minuteIso("2026-11-02T20:01:00Z", n), n: 1000 + n });
  }
  put(codexFile(w, "d-big", "2026/11/02"), big, NOW - 65 * MINUTE_MS);
}

// ---------------------------------------------------------------------------
// Time helpers and file names
// ---------------------------------------------------------------------------

test("time helpers: 15 minute slots, whole days, horizon at month start minus 7 days", () => {
  assert.equal(DAY_MS % SLOT_MS, 0);
  assert.equal(SLOTS_PER_DAY, DAY_MS / SLOT_MS);
  const eight = slotOf(Date.parse("2026-11-03T08:00:00Z"));
  assert.equal(slotOf(Date.parse("2026-11-03T08:14:59.999Z")), eight);
  assert.equal(slotOf(Date.parse("2026-11-03T08:15:00Z")), eight + 1);
  assert.equal(dayName(dayOfSlot(eight)), "2026-11-03");
  assert.equal(monthName(eight), "2026-11");
  assert.equal(monthName(slotOf(Date.parse("2026-10-31T23:59:59Z"))), "2026-10");
  assert.equal(new Date(horizonStartMs(NOW)).toISOString(), "2026-10-25T00:00:00.000Z");
  assert.equal(new Date(horizonStartMs(Date.parse("2026-03-02T00:00:00Z"))).toISOString(), "2026-02-22T00:00:00.000Z");
});

test("file names: claude and codex dedupe days, bucket months, bucket keys", () => {
  const day = dayOfSlot(slotOf(Date.parse("2026-11-03T08:00:00Z")));
  assert.equal(dedupeFileName("claude", day), "dedupe-2026-11-03.json");
  assert.equal(dedupeFileName("codex", day), "codex-dedupe-2026-11-03.json");
  assert.equal(bucketsFileName("2026-11"), "buckets-2026-11.json");
  assert.equal(bucketKey(7, "claude", "claude-sonnet-5-5", "-work-alpha"), "7|claude|claude-sonnet-5-5|-work-alpha");
});

test("default budget is 200 MiB and 20 s", () => {
  assert.deepEqual(DEFAULT_BUDGET, { bytes: 200 * MIB, ms: 20_000 });
});

// ---------------------------------------------------------------------------
// TP-3: Claude totals, repeats and the 1 hour cache write
// ---------------------------------------------------------------------------

const SONNET_ALPHA = rowKey("2026-11-03T08:01:00Z", "claude", "claude-sonnet-5-5", "-work-alpha");
const OPUS_BETA = rowKey("2026-11-03T08:03:00Z", "claude", "claude-opus-4-5", "-work-beta");

test("claude fixture: a repeated message counts once with its largest output", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), fixtureText("claude-basic.jsonl"));
  const report = passOk(w);
  assert.deepEqual(totals(w), {
    // msg_A: four rows, outputs 10, 30, 55, 55. Counted once, with 55.
    [SONNET_ALPHA]: [100, 200, 0, 300, 55],
    // msg_B and msg_C share a slot, model and folder.
    [OPUS_BETA]: [12, 520, 600, 50, 29],
  });
  assert.equal(report.rows.counted, 3);
  assert.equal(report.rows.replaced, 2);
  assert.equal(report.rows.repeats, 1);
  assert.equal(report.rows.badJson, 1);
  assert.equal(report.rows.notObject, 1);
  assert.deepEqual(report.rows.skipped, {
    not_assistant: 1,
    synthetic: 1,
    api_error: 1,
    missing_id: 1,
    bad_token: 1,
    bad_time: 1,
  });
});

test("claude fixture: the 1 hour cache write sits in its own column and weighs 2", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), fixtureText("claude-basic.jsonl"));
  passOk(w);
  const row = totals(w)[OPUS_BETA] as readonly number[];
  const [input = 0, cw5m = 0, cw1h = 0, cacheRead = 0, output = 0] = row;
  assert.equal(cw1h, 600);
  assert.equal(weighted({ input, cacheWrite5m: cw5m, cacheWrite1h: cw1h, cacheRead, output }), 12 + 650 + 1200 + 5 + 145);
});

test("claude: one subscription and model sum five columns across files", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "one"), claudeLines({ id: "a", at: "2026-11-03T08:01:00Z", input: 3, cw5m: 4, cacheRead: 5, output: 6 }));
  put(claudeFile(w, "two"), claudeLines({ id: "b", at: "2026-11-03T08:05:00Z", input: 10, cw1h: 20, output: 30 }));
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [13, 4, 20, 5, 36] });
});

interface RepeatCase {
  readonly name: string;
  readonly early: { readonly output: number };
  readonly late: { readonly output: number };
  readonly expectOutput: number;
  readonly replaced: number;
}

const REPEAT_CASES: readonly RepeatCase[] = [
  { name: "a smaller output in the earlier slot moves the larger counted values", early: { output: 10 }, late: { output: 30 }, expectOutput: 30, replaced: 0 },
  { name: "a larger output in the earlier slot replaces the row and moves it", early: { output: 40 }, late: { output: 30 }, expectOutput: 40, replaced: 1 },
];

for (const c of REPEAT_CASES) {
  test(`claude repeat across files, newest first: ${c.name}`, (t) => {
    const w = makeWorld(t);
    // The newer file holds the later copy, so the scan sees the copy first.
    put(claudeFile(w, "older"), claudeLines({ id: "X", at: "2026-11-03T08:14:59Z", output: c.early.output, cwd: "/work/early" }), NOW - 2 * HOUR_MS);
    put(claudeFile(w, "newer"), claudeLines({ id: "X", at: "2026-11-03T08:15:01Z", output: c.late.output, cwd: "/work/late" }), NOW - HOUR_MS);
    const report = passOk(w);
    assert.deepEqual(totals(w), {
      [rowKey("2026-11-03T08:00:00Z", "claude", "claude-sonnet-5-5", "-work-early")]: [1, 0, 0, 0, c.expectOutput],
    });
    assert.equal(report.rows.moved, 1);
    assert.equal(report.rows.replaced, c.replaced);
    assert.equal(report.rows.counted, 1);
  });
}

test("claude repeat in a subagent file: counted once", (t) => {
  const w = makeWorld(t);
  const line = claudeLines({ id: "S", at: "2026-11-03T08:01:00Z", output: 7 });
  put(claudeFile(w, "sess-1"), line);
  put(join(w.claude, PROJECT, "sess-1", "subagents", "agent-1.jsonl"), line);
  const report = passOk(w);
  assert.equal(report.files, 2);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 7] });
});

test("claude repeat across passes: a larger output replaces, a smaller one is ignored", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "grow");
  put(path, claudeLines({ id: "G", at: "2026-11-03T08:01:00Z", output: 10 }));
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 10] });
  append(path, claudeLines({ id: "G", at: "2026-11-03T08:01:05Z", output: 55 }));
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 55] });
  append(path, claudeLines({ id: "G", at: "2026-11-03T08:01:09Z", output: 20 }), DEFAULT_MTIME + 10 * MINUTE_MS);
  const report = passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 55] });
  assert.equal(report.rows.repeats, 1);
});

test("proxy usage keeps its model and counts only as Codex in buckets and days", (t) => {
  const w = makeWorld(t);
  const at = "2026-11-03T08:01:00Z";
  put(
    claudeFile(w, "proxy"),
    proxyLine("A", at, 10) + claudeLines({ id: "native", at, model: PROXY_MODEL, output: 2 }),
  );

  passOk(w, { zone: must(zoneNamed("UTC")) });

  assert.deepEqual(totals(w), {
    [rowKey(at, "codex", PROXY_MODEL, PROJECT)]: [100, 0, 0, 30, 10],
    [rowKey(at, "claude", PROXY_MODEL, PROJECT)]: [1, 0, 0, 0, 2],
  });
  assert.deepEqual(must(loadDayRows(w.data, DEPS)).get("2026-11-03"), {
    codex: [100, 0, 0, 30, 10],
    claude: [1, 0, 0, 0, 2],
    models: new Map([
      [`codex|${PROXY_MODEL}`, [100, 0, 0, 30, 10]],
      [`claude|${PROXY_MODEL}`, [1, 0, 0, 0, 2]],
    ]),
  });
});

test("proxy repeats keep the largest output and earliest slot per UTC day without bucket underflow", (t) => {
  const w = makeWorld(t);
  const file = claudeFile(w, "proxy");
  const id = "x".repeat(123);
  const early = "2026-11-02T23:29:00Z";
  const nextDay = "2026-11-03T00:01:00Z";
  put(file, proxyLine(id, "2026-11-02T23:59:00Z", 10));
  passOk(w);
  append(file, proxyLine(id, early, 30) + proxyLine(id, "2026-11-02T23:59:05Z", 55) + proxyLine(id, nextDay, 10));

  const report = passOk(w);

  assert.equal(report.bucketUnderflow, 0);
  assert.deepEqual(totals(w), {
    [rowKey(early, "codex", PROXY_MODEL, PROJECT)]: [100, 0, 0, 30, 55],
    [rowKey(nextDay, "codex", PROXY_MODEL, PROJECT)]: [100, 0, 0, 30, 10],
  });
});

// ---------------------------------------------------------------------------
// TP-4: Codex child rollouts
// ---------------------------------------------------------------------------

const CODEX_PARENT_0800 = rowKey("2026-11-03T08:00:00Z", "codex", "gpt-5-codex", "-work-alpha");
const CODEX_PARENT_NEW_MODEL = rowKey("2026-11-03T08:00:00Z", "codex", "gpt-5.1", "-work-alpha");
const CODEX_CHILD_OWN = rowKey("2026-11-03T09:00:00Z", "codex", "gpt-5-codex", "-work-alpha");
const CODEX_GAMMA_OWN = rowKey("2026-11-03T09:00:00Z", "codex", "gpt-5-codex", "-work-gamma");

const CODEX_FINAL: Totals = {
  // Events 1 and 2 of the parent: input excludes cached input.
  [CODEX_PARENT_0800]: [800, 0, 0, 700, 150],
  // Event 3 (gpt-5.1) and event 4 (no total, so no key).
  [CODEX_PARENT_NEW_MODEL]: [500, 0, 0, 150, 105],
  // The own events of the two child rollouts.
  [CODEX_CHILD_OWN]: [200, 0, 0, 100, 40],
  [CODEX_GAMMA_OWN]: [150, 0, 0, 50, 30],
};

function seedCodexFamily(w: World, parentMtime: number): void {
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"), parentMtime);
  put(codexFile(w, "child"), fixtureText("codex-child.jsonl"), NOW - 2 * HOUR_MS);
  put(codexFile(w, "child-own"), fixtureText("codex-child-own-meta.jsonl"), NOW - HOUR_MS);
}

test("codex child rollouts count only their own events, with the parent last in the scan", (t) => {
  const w = makeWorld(t);
  seedCodexFamily(w, NOW - 3 * HOUR_MS);
  const report = passOk(w);
  assert.deepEqual(totals(w), CODEX_FINAL);
  // Copies are counted first (children are newer), then moved by the parent.
  assert.equal(report.rows.moved, 2);
});

test("codex child rollouts give the same totals with the parent first in the scan", (t) => {
  const w = makeWorld(t);
  seedCodexFamily(w, NOW - 10 * MINUTE_MS);
  const report = passOk(w);
  assert.deepEqual(totals(w), CODEX_FINAL);
  assert.equal(report.rows.moved, 0);
  assert.ok(report.rows.repeats >= 4, "the copied events of both children are repeats");
});

test("codex copies move to the earlier parent slots and folder when the parent shows up later", (t) => {
  const w = makeWorld(t);
  put(codexFile(w, "child"), fixtureText("codex-child.jsonl"), NOW - 2 * HOUR_MS);
  put(codexFile(w, "child-own"), fixtureText("codex-child-own-meta.jsonl"), NOW - HOUR_MS);
  passOk(w);
  // The copies sit at the restamped slot, under the folder of the newest child.
  assert.deepEqual(totals(w), {
    [CODEX_CHILD_OWN]: [200, 0, 0, 100, 40],
    [CODEX_GAMMA_OWN]: [950, 0, 0, 750, 180],
  });
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"), NOW - 3 * HOUR_MS);
  const report = passOk(w);
  assert.deepEqual(totals(w), CODEX_FINAL);
  assert.equal(report.rows.moved, 2);
});

test("codex input excludes cached input and cache write is 0", (t) => {
  const w = makeWorld(t);
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"));
  passOk(w);
  const rows = Object.values(totals(w));
  const sum = (index: number): number => rows.reduce((acc, row) => acc + (row[index] ?? 0), 0);
  // input 1000/500/400/250 less cached 400/300/100/50.
  assert.equal(sum(0), 1000 + 500 + 400 + 250 - (400 + 300 + 100 + 50));
  assert.equal(sum(1), 0);
  assert.equal(sum(2), 0);
  assert.equal(sum(3), 400 + 300 + 100 + 50);
});

function sampleOf(clock: string, window: "five_hour" | "week", usedPercent: number): CodexQuotaSample {
  return {
    window,
    at: Date.parse(`2026-11-03T${clock}.000Z`),
    usedPercent,
    resetsAt: (window === "five_hour" ? RESET_5H_SECONDS : RESET_WEEK_SECONDS) * 1000,
    reached: false,
  };
}

test("codex quota samples come back in time order for the caller to store", (t) => {
  const w = makeWorld(t);
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"));
  const report = passOk(w);
  assert.deepEqual(report.codexQuota, [
    sampleOf("08:01:00", "five_hour", 12.5),
    sampleOf("08:01:00", "week", 40),
    sampleOf("08:02:00", "five_hour", 15),
    sampleOf("08:02:00", "week", 41),
    sampleOf("08:03:00", "five_hour", 16),
    sampleOf("08:03:00", "week", 41),
    sampleOf("08:05:00", "five_hour", 20),
    sampleOf("08:05:00", "week", 42),
  ]);
});

test("codex quota: a run of equal samples keeps its first and last sample", (t) => {
  const w = makeWorld(t);
  const base = "2026-11-03T08:00:00Z";
  let text = codexMeta(base, "sess-q", "/work/q") + codexTurn(base, "gpt-5-codex");
  for (let n = 0; n < 5; n += 1) text += codexEvent({ at: minuteIso(base, n + 1), n, percent: { five: 10, week: 30 } });
  text += codexEvent({ at: minuteIso(base, 6), n: 5, percent: { five: 20, week: 30 } });
  put(codexFile(w, "quota"), text);
  const report = passOk(w);
  const view = report.codexQuota.map((s) => [s.window, (s.at - Date.parse(base)) / MINUTE_MS, s.usedPercent]);
  assert.deepEqual(view, [
    ["five_hour", 1, 10],
    ["week", 1, 30],
    ["five_hour", 5, 10],
    ["five_hour", 6, 20],
    ["week", 6, 30],
  ]);
});

test("codex quota: later passes over a growing rollout store a sample only when the percent changes", (t) => {
  const w = makeWorld(t);
  const base = "2026-11-03T08:00:00Z";
  const path = codexFile(w, "quota");
  const events = (from: number, count: number, percent: { five: number; week: number }): string => {
    let text = "";
    for (let n = from; n < from + count; n += 1) text += codexEvent({ at: minuteIso(base, n + 1), n, percent });
    return text;
  };
  const stored = (): number => {
    const month = join(w.data, quotaMonthFile(Date.parse(base)));
    return existsSync(month) ? readFileSync(month, "utf8").split("\n").filter((line) => line !== "").length : 0;
  };
  const store = (): { readonly appended: number; readonly skipped: number } => {
    const report = must(storeCodexQuota(w.data, passOk(w).codexQuota, DEPS));
    return { appended: report.appended, skipped: report.skipped };
  };

  put(path, codexMeta(base, "sess-q", "/work/q") + codexTurn(base, "gpt-5-codex") + events(0, 2, { five: 10, week: 30 }));
  assert.deepEqual(store(), { appended: 2, skipped: 2 });
  assert.equal(stored(), 2);

  // Each later pass reads new events with the same percent: their sample times are new, their numbers are not.
  for (let pass = 1; pass <= 3; pass += 1) {
    append(path, events(pass * 10, 3, { five: 10, week: 30 }));
    assert.deepEqual(store(), { appended: 0, skipped: 4 }, `pass ${pass}`);
    assert.equal(stored(), 2, `pass ${pass}`);
  }

  // A new percent in one window adds one sample; the window that did not change adds none.
  append(path, events(50, 2, { five: 15, week: 30 }));
  assert.deepEqual(store(), { appended: 1, skipped: 3 });
  assert.equal(stored(), 3);
});

// ---------------------------------------------------------------------------
// Store files
// ---------------------------------------------------------------------------

test("store files: names, version, format and mode after a pass", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "sess-a");
  put(path, fixtureText("claude-basic.jsonl"));
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"));
  const report = passOk(w);
  assert.deepEqual(readdirSync(w.data).sort(), [
    "buckets-2026-11.json",
    "codex-dedupe-2026-11-03.json",
    "days.json",
    "dedupe-2026-11-03.json",
    LEDGER_FILE,
    STORE_FILE,
  ]);
  assert.equal(report.filesWritten, 6);
  for (const name of readdirSync(w.data)) {
    assert.equal(statSync(join(w.data, name)).mode & 0o777, 0o600, name);
  }
  assert.deepEqual(readJson(join(w.data, STORE_FILE)), { version: 1 });

  const dedupe = readJson(join(w.data, "dedupe-2026-11-03.json")) as { version: number; entries: Record<string, unknown> };
  assert.equal(dedupe.version, 1);
  const eight = slotOf(Date.parse("2026-11-03T08:00:00Z"));
  assert.deepEqual(dedupe.entries["msg_A|req_A"], [eight, "claude-sonnet-5-5", "-work-alpha", 100, 200, 0, 300, 55]);

  const buckets = readJson(join(w.data, "buckets-2026-11.json")) as { version: number; rows: Record<string, unknown> };
  assert.equal(buckets.version, 1);
  assert.deepEqual(buckets.rows[SONNET_ALPHA], [100, 200, 0, 300, 55]);

  const ledger = readJson(join(w.data, LEDGER_FILE)) as { version: number; files: Record<string, Record<string, unknown>> };
  assert.equal(ledger.version, 1);
  const entry = ledger.files[fileKeyOf(path)];
  assert.ok(entry !== undefined, "the ledger is keyed by the sha256 of the path");
  assert.equal(entry["provider"], "claude");
  assert.equal(entry["offset"], statSync(path).size);
  assert.equal(entry["size"], statSync(path).size);
  assert.equal(entry["ino"], statSync(path).ino);
  assert.equal(entry["dev"], statSync(path).dev);
  assert.equal(entry["codex"], null);
  assert.equal(Object.keys(ledger.files).length, 2);

  const codexDedupe = readJson(join(w.data, "codex-dedupe-2026-11-03.json")) as { entries: Record<string, unknown> };
  assert.equal(Object.keys(codexDedupe.entries).length, 3);
  for (const key of Object.keys(codexDedupe.entries)) assert.match(key, /^[0-9a-f]{32}$/);
});

test("store: an absent bucket month loads as empty", (t) => {
  const w = makeWorld(t);
  assert.equal(must(loadBucketMonth(w.data, "2026-11", DEPS)).size, 0);
});

test("store: no lock or temp file stays after a pass", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), claudeLines({ id: "A", at: "2026-11-03T08:01:00Z" }));
  passOk(w);
  assert.ok(!existsSync(join(w.data, "collect.lock")));
  assert.ok(readdirSync(w.data).every((name) => !name.endsWith(".tmp")));
});

test("a pass with nothing new writes nothing", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), fixtureText("claude-basic.jsonl"));
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"));
  passOk(w);
  const before = snapshot(w.data);
  const report = passOk(w);
  assert.equal(report.filesWritten, 0);
  assert.equal(report.bytesRead, 0);
  assert.equal(report.backlogBytes, 0);
  assert.deepEqual(snapshot(w.data), before);
});

// ---------------------------------------------------------------------------
// TP-13: budget, progress and the warm pass
// ---------------------------------------------------------------------------

function onePassTotals(t: TestContext): Totals {
  const ref = makeWorld(t);
  seedMixed(ref);
  const report = passOk(ref);
  assert.equal(report.stoppedBy, "none");
  assert.equal(report.backlogBytes, 0);
  return totals(ref);
}

test("cold scan stops at its byte budget and later passes reach the one pass totals", (t) => {
  const reference = onePassTotals(t);
  const w = makeWorld(t);
  seedMixed(w);
  const budget = { bytes: 14_000, ms: SCAN_BUDGET_MS };
  const first = passOk(w, { budget });
  assert.equal(first.stoppedBy, "bytes");
  assert.ok(first.bytesRead <= budget.bytes);
  assert.equal(first.bytesRead + first.backlogBytes, first.totalBytes, "progress comes from the backlog bytes");
  assert.ok(first.backlogBytes > 0);
  assert.notDeepEqual(totals(w), reference);

  let backlog = first.backlogBytes;
  let passes = 1;
  for (; passes < 60 && backlog > 0; passes += 1) {
    const next = passOk(w, { budget });
    assert.ok(next.bytesRead <= budget.bytes);
    assert.ok(next.backlogBytes < backlog, "every pass makes progress");
    backlog = next.backlogBytes;
  }
  assert.equal(backlog, 0);
  assert.ok(passes > 2, "the budget was small enough to need several passes");
  assert.deepEqual(totals(w), reference);
});

test("cold scan stops at its time budget and later passes reach the one pass totals", (t) => {
  const reference = onePassTotals(t);
  const w = makeWorld(t);
  seedMixed(w);
  let clock = NOW;
  const ticking: FsDeps = {
    ...DEPS,
    nowMs: () => {
      const value = clock;
      clock += 1000;
      return value;
    },
  };
  // Five clock reads come before the first file: the start, the lock, and three
  // folders of the walk. They count against the budget, one second each.
  const budget = { bytes: SCAN_BUDGET_BYTES, ms: 8500 };
  const first = passOk(w, { budget }, ticking);
  assert.equal(first.stoppedBy, "time");
  assert.ok(first.filesRead >= 1, "a pass always reads at least one file");
  assert.ok(first.filesRead < first.files);
  assert.ok(first.backlogBytes > 0);

  let backlog = first.backlogBytes;
  for (let passes = 1; passes < 60 && backlog > 0; passes += 1) {
    const next = passOk(w, { budget }, ticking);
    assert.ok(next.backlogBytes < backlog);
    backlog = next.backlogBytes;
  }
  assert.equal(backlog, 0);
  assert.deepEqual(totals(w), reference);
});

test("a Codex file read in several slices keeps its model and its repeat check across the cuts", (t) => {
  // Every event line is written twice in a row: the second one is a direct repeat.
  // A slice can start between the two, so the saved state must carry the repeat check.
  let text = codexMeta("2026-11-02T20:00:00.000Z", "sess-slices", "/work/slices");
  text += codexTurn("2026-11-02T20:00:01.000Z", "gpt-5-codex");
  for (let n = 0; n < 40; n += 1) {
    if (n === 20) text += codexTurn("2026-11-02T20:20:00.000Z", "gpt-5.1");
    const event = codexEvent({ at: minuteIso("2026-11-02T20:01:00Z", n), n: 2000 + n });
    text += event + event;
  }
  const reference = makeWorld(t);
  put(codexFile(reference, "slices", "2026/11/02"), text);
  passOk(reference);
  const expected = totals(reference);
  const models = new Set(Object.keys(expected).map((key) => key.split("|")[2]));
  assert.deepEqual([...models].sort(), ["gpt-5-codex", "gpt-5.1"]);

  const w = makeWorld(t);
  put(codexFile(w, "slices", "2026/11/02"), text);
  let passes = 0;
  for (let backlog = 1; passes < 80 && backlog > 0; passes += 1) {
    backlog = passOk(w, { budget: { bytes: 4000, ms: SCAN_BUDGET_MS } }).backlogBytes;
  }
  assert.ok(passes >= 5, "the file needed several slices");
  assert.deepEqual(totals(w), expected);
});

// ---------------------------------------------------------------------------
// Input, folder helpers and store drift
// ---------------------------------------------------------------------------

test("collect refuses an unusable budget, entry cap or data folder", (t) => {
  const w = makeWorld(t);
  const bad: readonly Partial<CollectInput>[] = [
    { budget: { bytes: 0, ms: 1000 } },
    { budget: { bytes: 1.5, ms: 1000 } },
    { budget: { bytes: 1000, ms: -1 } },
    { maxEntriesPerFolder: 0 },
    { maxFilesPerPass: 0 },
    { maxFilesPerPass: 1.5 },
    { dataDir: "relative/data" },
  ];
  for (const patch of bad) {
    assert.equal(mustFail(pass(w, patch)).code, "internal_error", JSON.stringify(patch));
  }
  assert.deepEqual(readdirSync(w.data), []);
});

test("folder helpers: a capped listing, relative paths, links and a missing file", (t) => {
  const sb = makeSandbox(t);
  const dir = sb.path("list");
  for (const name of ["a", "b", "c", "d"]) put(join(dir, name), "x");
  const listing = must(listDir(dir, 3));
  assert.equal(listing.names.length, 3);
  assert.equal(listing.capped, true);
  const whole = must(listDir(dir, 4));
  assert.equal(whole.names.length, 4);
  assert.equal(whole.capped, false);
  assert.equal(mustFail(listDir("relative", 3)).code, "bad_input");
  assert.equal(mustFail(listDir(dir, -1)).code, "bad_input");
  assert.equal(mustFail(listDir(sb.path("absent"), 3)).code, "not_found");

  symlinkSync(join(dir, "a"), join(dir, "link"));
  assert.equal(must(lstatEntry(join(dir, "link"))).isSymbolicLink(), true);
  assert.equal(mustFail(lstatEntry("relative")).code, "bad_input");

  assert.equal(must(removeFile(join(dir, "a"))), null);
  assert.equal(must(removeFile(join(dir, "a"))), null, "a missing file counts as removed");
  assert.ok(!existsSync(join(dir, "a")));
  assert.equal(mustFail(removeFile("relative")).code, "bad_input");
});

test("a bucket total that would go below 0 stops at 0 and is counted", (t) => {
  const w = makeWorld(t);
  put(codexFile(w, "child"), fixtureText("codex-child.jsonl"), NOW - 2 * HOUR_MS);
  passOk(w);
  // The bucket file is lost while the dedupe days stay.
  unlinkSync(join(w.data, "buckets-2026-11.json"));
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"), NOW - 3 * HOUR_MS);
  const report = passOk(w);
  assert.ok(report.bucketUnderflow >= 1);
  for (const row of Object.values(totals(w))) assert.ok(row.every((value) => value >= 0));
});

const SYNTHETIC_DAYS_FIRST = Date.parse("2026-10-25T00:00:00Z") / DAY_MS;
const SYNTHETIC_DAYS = 9;
const ENTRIES_PER_DAY = 28_000;

// Valid dedupe entries with keys that no real row will carry.
function syntheticDay(provider: "claude" | "codex", day: number, extra: Record<string, unknown> = {}): string {
  const entries: Record<string, unknown> = { ...extra };
  const baseSlot = day * SLOTS_PER_DAY;
  for (let i = 0; i < ENTRIES_PER_DAY; i += 1) {
    const model = provider === "claude" ? "claude-sonnet-5-5" : "gpt-5-codex";
    const key =
      provider === "claude"
        ? `syn_${day}_${i}|req_${i}`
        : `${day.toString(16).padStart(6, "0")}${i.toString(16).padStart(26, "0")}`;
    entries[key] = [baseSlot + (i % SLOTS_PER_DAY), model, "-work-syn", 1, 2, 3, 4, 5];
  }
  return JSON.stringify({ version: 1, entries });
}

test("a warm pass with a 500 thousand entry dedupe store takes under 2 s and loads only the days it needs", (t) => {
  const w = makeWorld(t);
  const claudePath = claudeFile(w, "warm");
  const codexPath = codexFile(w, "warm");
  put(claudePath, claudeLines({ id: "W0", at: "2026-11-03T08:01:00Z", output: 3 }));
  const codexHead = codexMeta("2026-11-03T08:00:00.000Z", "sess-warm", "/work/warm") + codexTurn("2026-11-03T08:00:01.000Z", "gpt-5-codex");
  put(codexPath, codexHead + codexEvent({ at: "2026-11-03T08:02:00.000Z", n: 1 }));
  passOk(w);
  const afterCold = totals(w);

  // Plant nine days of Claude and Codex dedupe files before today. One Claude day
  // is damaged after its valid entries: a read of it gives store_corrupt.
  const damagedClaudeDay = SYNTHETIC_DAYS_FIRST + 3;
  const plantedClaude: string[] = [];
  const plantedCodex: string[] = [];
  const duplicate = stepCodexRow(
    stepCodexRow(CODEX_INITIAL_STATE, JSON.parse(codexTurn("2026-11-03T08:00:01.000Z", "gpt-5-codex")), NOW).state,
    JSON.parse(codexEvent({ at: "2026-11-03T10:05:00.000Z", n: 77 })),
    NOW,
  ).entry;
  assert.ok(duplicate !== null && duplicate.key !== null);
  const duplicateDay = SYNTHETIC_DAYS_FIRST + 5;
  const duplicateEntry = [duplicateDay * SLOTS_PER_DAY, "gpt-5-codex", "-work-warm", 106, 0, 0, 10, 5];
  for (let d = 0; d < SYNTHETIC_DAYS; d += 1) {
    const day = SYNTHETIC_DAYS_FIRST + d;
    const claudeName = dedupeFileName("claude", day);
    const codexName = dedupeFileName("codex", day);
    writeFileSync(join(w.data, claudeName), syntheticDay("claude", day) + (day === damagedClaudeDay ? "{" : ""), { mode: 0o600 });
    writeFileSync(join(w.data, codexName), syntheticDay("codex", day, d === 5 ? { [duplicate.key]: duplicateEntry } : {}), { mode: 0o600 });
    plantedClaude.push(claudeName);
    plantedCodex.push(codexName);
  }
  const untouchedBefore = snapshot(w.data);

  // New lines: one Claude message today, one new Codex event, and one Codex event
  // whose key was first seen on an earlier day.
  append(claudePath, claudeLines({ id: "W1", at: "2026-11-03T10:00:00Z", output: 4 }));
  append(
    codexPath,
    codexEvent({ at: "2026-11-03T10:00:00.000Z", n: 2 }) + codexEvent({ at: "2026-11-03T10:05:00.000Z", n: 77 }),
  );

  const started = performance.now();
  const result = pass(w);
  const elapsedMs = performance.now() - started;
  t.diagnostic(`warm pass with ${ENTRIES_PER_DAY * SYNTHETIC_DAYS * 2} planted dedupe entries: ${elapsedMs.toFixed(0)} ms`);
  const report = must(result);
  assert.ok(elapsedMs < 2000, `the warm pass took ${elapsedMs.toFixed(0)} ms`);

  // The key from an earlier Codex day was found: not counted again.
  assert.ok(report.rows.repeats >= 1);
  assert.equal(report.rows.counted, 2);
  const ten = slotOf(Date.parse("2026-11-03T10:00:00Z"));
  assert.deepEqual(totals(w), {
    ...afterCold,
    [bucketKey(ten, "claude", "claude-sonnet-5-5", "-work-alpha")]: [1, 0, 0, 0, 4],
    // Event 2: input 102 less 10 cached. Event 77 was found in the planted day and not counted.
    [bucketKey(ten, "codex", "gpt-5-codex", "-work-warm")]: [92, 0, 0, 10, 5],
  });

  // Claude days that no new line touched were not written. They were not read
  // either: the damaged day would have stopped the pass with store_corrupt.
  const after = snapshot(w.data);
  for (const name of plantedClaude) assert.deepEqual(after.get(name), untouchedBefore.get(name), name);
  // Codex days were read but only the changed day files are written.
  for (const name of plantedCodex) assert.deepEqual(after.get(name), untouchedBefore.get(name), name);
});

// ---------------------------------------------------------------------------
// TP-18 (part): damaged and newer store files stop collect with no write
// ---------------------------------------------------------------------------

const STORE_FILES = [
  { name: STORE_FILE, cap: FILE_CAPS.store, shape: '{"version":"1"}' },
  { name: LEDGER_FILE, cap: FILE_CAPS.ledger, shape: '{"version":1,"files":[]}' },
  { name: "buckets-2026-11.json", cap: FILE_CAPS.buckets, shape: '{"version":1,"rows":{"bad key":[1,2,3,4,5]}}' },
  { name: "dedupe-2026-11-03.json", cap: FILE_CAPS.dedupe, shape: '{"version":1,"entries":{"k":[1,2]}}' },
  { name: "codex-dedupe-2026-11-03.json", cap: FILE_CAPS.dedupe, shape: '{"version":1,"entries":{"k":[1,2]}}' },
  { name: "days.json", cap: FILE_CAPS.days, shape: '{"version":1,"backfilled":"yes","days":{}}' },
] as const;

// A populated store, plus new source lines that make the next pass touch every store file.
function populated(t: TestContext): World {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), fixtureText("claude-basic.jsonl"));
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"));
  passOk(w);
  return w;
}

function addFreshLines(w: World): void {
  append(claudeFile(w, "sess-a"), claudeLines({ id: "N1", at: "2026-11-03T10:00:00Z", output: 8 }));
  append(codexFile(w, "parent"), codexEvent({ at: "2026-11-03T10:00:00.000Z", n: 900 }));
}

function setVersion(path: string, version: number): void {
  const parsed = readJson(path) as Record<string, unknown>;
  writeFileSync(path, JSON.stringify({ ...parsed, version }));
}

function assertStopsWithNoWrite(w: World, expected: { code: CollectError["code"]; file: string }): void {
  const before = snapshot(w.data);
  const error = mustFail(pass(w));
  assert.equal(error.code, expected.code);
  assert.equal(error.file, expected.file);
  assert.deepEqual(snapshot(w.data), before, "no store file was written, created or removed");
}

for (const file of STORE_FILES) {
  test(`damaged store: ${file.name} that is not JSON gives store_corrupt and no write`, (t) => {
    const w = populated(t);
    addFreshLines(w);
    writeFileSync(join(w.data, file.name), "{ not json");
    assertStopsWithNoWrite(w, { code: "store_corrupt", file: file.name });
  });

  test(`damaged store: ${file.name} with a wrong shape gives store_corrupt and no write`, (t) => {
    const w = populated(t);
    addFreshLines(w);
    writeFileSync(join(w.data, file.name), file.shape);
    assertStopsWithNoWrite(w, { code: "store_corrupt", file: file.name });
  });

  test(`damaged store: ${file.name} over its cap gives store_corrupt and no write`, (t) => {
    const w = populated(t);
    addFreshLines(w);
    truncateSync(join(w.data, file.name), file.cap + 1);
    assertStopsWithNoWrite(w, { code: "store_corrupt", file: file.name });
  });

  test(`newer store: ${file.name} with a newer version gives store_newer and no write`, (t) => {
    const w = populated(t);
    addFreshLines(w);
    setVersion(join(w.data, file.name), 2);
    assertStopsWithNoWrite(w, { code: "store_newer", file: file.name });
  });
}

test("damaged store: a link in place of a store file gives store_corrupt and no write", (t) => {
  const w = populated(t);
  addFreshLines(w);
  unlinkSync(join(w.data, LEDGER_FILE));
  symlinkSync(join(w.data, STORE_FILE), join(w.data, LEDGER_FILE));
  assertStopsWithNoWrite(w, { code: "store_corrupt", file: LEDGER_FILE });
});

test("damaged store: a damaged file on the first pass stops it with nothing created", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), fixtureText("claude-basic.jsonl"));
  writeFileSync(join(w.data, STORE_FILE), "garbage");
  assertStopsWithNoWrite(w, { code: "store_corrupt", file: STORE_FILE });
});

test("damaged store: a day file that no new line touches is not read", (t) => {
  const w = populated(t);
  addFreshLines(w);
  writeFileSync(join(w.data, "dedupe-2026-10-28.json"), "{ not json");
  const report = passOk(w);
  assert.equal(report.rows.counted, 2);
  assert.equal(readFileSync(join(w.data, "dedupe-2026-10-28.json"), "utf8"), "{ not json");
});

test("pruning: dedupe days before the horizon are deleted and never read", (t) => {
  const w = populated(t);
  addFreshLines(w);
  writeFileSync(join(w.data, "dedupe-2026-10-24.json"), "{ not json");
  writeFileSync(join(w.data, "codex-dedupe-2026-09-01.json"), "{ not json");
  writeFileSync(join(w.data, "dedupe-2026-10-25.json"), '{"version":1,"entries":{}}');
  const report = passOk(w);
  assert.equal(report.prunedFiles, 2);
  assert.ok(!existsSync(join(w.data, "dedupe-2026-10-24.json")));
  assert.ok(!existsSync(join(w.data, "codex-dedupe-2026-09-01.json")));
  assert.ok(existsSync(join(w.data, "dedupe-2026-10-25.json")), "the first day of the horizon stays");
});

test("a held lock gives lock_held with no write, and the other holder's file stays", (t) => {
  const w = populated(t);
  addFreshLines(w);
  const lockPath = join(w.data, "collect.lock");
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs: NOW, token: "other-holder" }), { mode: 0o600 });
  const before = snapshot(w.data);
  const error = mustFail(pass(w));
  assert.equal(error.code, "lock_held");
  assert.deepEqual(snapshot(w.data), before);
});

// A clock that moves by `step` at each read. `onRead` runs before the value is returned.
function steppingClock(step: number, onRead: (value: number, read: number) => void): { readonly deps: FsDeps; readonly reads: () => number } {
  let clock = NOW;
  let reads = 0;
  const deps: FsDeps = {
    ...DEPS,
    nowMs: () => {
      const value = clock;
      clock += step;
      reads += 1;
      onRead(value, reads);
      return value;
    },
  };
  return { deps, reads: () => reads };
}

// Files in one project folder. The walk reads the clock only between folders, so
// the clock reads of a pass over this corpus are: the start, the lock body, one for
// each file after the first, and the checks of the lock.
function seedFlat(w: World, count: number): void {
  for (let i = 0; i < count; i += 1) {
    const at = minuteIso("2026-11-03T06:00:00Z", i);
    put(claudeFile(w, `s${i}`), claudeLines({ id: `L${i}`, at, output: 5 + i }), NOW - (i + 3) * 10 * MINUTE_MS);
  }
}

test("a pass that keeps working keeps its lock: a second pass cannot take it, however long the pass runs", (t) => {
  const files = 14;
  const ref = makeWorld(t);
  seedFlat(ref, files);
  passOk(ref);
  const reference = totals(ref);
  const w = makeWorld(t);
  seedFlat(w, files);
  const lockPath = join(w.data, "collect.lock");
  const probes: string[] = [];
  const clock = steppingClock(20_000, (value) => {
    if (!existsSync(lockPath)) return;
    const rival = acquireLock(lockPath, { ...DEPS, nowMs: () => value });
    probes.push(rival.ok ? "taken" : rival.error.code);
  });
  const report = passOk(w, { budget: { bytes: SCAN_BUDGET_BYTES, ms: 1e9 } }, clock.deps);
  assert.equal(report.stoppedBy, "none");
  assert.ok(clock.reads() * 20_000 > 2 * LOCK_STALE_MS, "the pass lasted longer than the stale limit, by the clock");
  assert.ok(probes.length >= files - 1, "the lock was tried at every file after the first");
  assert.deepEqual([...new Set(probes)], ["lock_held"]);
  assert.deepEqual(totals(w), reference);
  assert.ok(!existsSync(lockPath));
});

// The third clock read of a pass over seedFlat: the check before the second file.
const FIRST_FILE_CHECK = 3;

function takeOver(lockPath: string, startedAtMs: number): void {
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAtMs, token: "other-holder" }), { mode: 0o600 });
}

test("a pass whose lock was taken over writes nothing, and leaves the other holder's lock", (t) => {
  const w = makeWorld(t);
  seedFlat(w, 4);
  const lockPath = join(w.data, "collect.lock");
  // The clock stands still, so no refresh is due between files: the check before the flush must find it.
  const clock = steppingClock(0, (value, read) => {
    if (read === FIRST_FILE_CHECK) takeOver(lockPath, value);
  });
  const error = mustFail(pass(w, {}, clock.deps));
  assert.deepEqual({ code: error.code, file: error.file }, { code: "lock_held", file: null });
  assert.deepEqual(readdirSync(w.data), ["collect.lock"], "no store file, temp file or journal is written");
  assert.equal((readJson(lockPath) as { token: string }).token, "other-holder");
});

test("a refresh between files finds a lost lock and stops the pass before the next file", (t) => {
  const w = makeWorld(t);
  seedFlat(w, 4);
  const lockPath = join(w.data, "collect.lock");
  const clock = steppingClock(LOCK_REFRESH_MS, (value, read) => {
    if (read === FIRST_FILE_CHECK) takeOver(lockPath, value);
  });
  const error = mustFail(pass(w, { budget: { bytes: SCAN_BUDGET_BYTES, ms: 1e9 } }, clock.deps));
  assert.equal(error.code, "lock_held");
  assert.equal(clock.reads(), FIRST_FILE_CHECK, "the first check after the take over stopped the pass");
  assert.deepEqual(readdirSync(w.data), ["collect.lock"]);
});

// ---------------------------------------------------------------------------
// Doctor-only counter
// ---------------------------------------------------------------------------

test("doctor counter: a key in more than one Claude day file is counted, and collect does not merge it", (t) => {
  const w = makeWorld(t);
  const forkedA = claudeLines({ id: "F", at: "2026-11-02T23:59:00Z", output: 5 });
  const forkedB = claudeLines({ id: "F", at: "2026-11-03T00:01:00Z", output: 5 }, { id: "U", at: "2026-11-03T00:02:00Z" });
  put(claudeFile(w, "fork-a"), forkedA);
  put(claudeFile(w, "fork-b"), forkedB);
  passOk(w);
  assert.equal(must(crossDayClaudeKeys(w.data, NOW, DEPS)), 1);
  const rows = Object.values(totals(w));
  assert.equal(rows.reduce((acc, row) => acc + (row[4] ?? 0), 0), 5 + 5 + 1, "both copies of the fork are counted");
});

test("doctor counter ignores a proxy key across UTC days but counts a Claude fork", (t) => {
  const w = makeWorld(t);
  const before = "2026-11-02T23:59:00Z";
  const after = "2026-11-03T00:01:00Z";
  put(claudeFile(w, "proxy"), proxyLine("A", before, 10) + proxyLine("A", after, 10));
  passOk(w);
  assert.equal(must(crossDayClaudeKeys(w.data, NOW, DEPS)), 0);

  put(claudeFile(w, "fork"), claudeLines({ id: "F", at: before }, { id: "F", at: after }));
  passOk(w);
  assert.equal(must(crossDayClaudeKeys(w.data, NOW, DEPS)), 1);
});

test("doctor counter: zero when no key repeats across days, and zero for an empty store", (t) => {
  const w = makeWorld(t);
  assert.equal(must(crossDayClaudeKeys(w.data, NOW, DEPS)), 0);
  put(claudeFile(w, "one"), claudeLines({ id: "A", at: "2026-11-02T08:00:00Z" }, { id: "B", at: "2026-11-03T08:00:00Z" }));
  passOk(w);
  assert.equal(must(crossDayClaudeKeys(w.data, NOW, DEPS)), 0);
});

test("doctor counter: a damaged day file gives store_corrupt", (t) => {
  const w = populated(t);
  writeFileSync(join(w.data, "dedupe-2026-11-03.json"), "{ not json");
  assert.equal(mustFail(crossDayClaudeKeys(w.data, NOW, DEPS)).code, "store_corrupt");
});

// ---------------------------------------------------------------------------
// Scan rules
// ---------------------------------------------------------------------------

function ledgerOffset(w: World, path: string): number | undefined {
  if (!existsSync(join(w.data, LEDGER_FILE))) return undefined;
  const ledger = readJson(join(w.data, LEDGER_FILE)) as { files: Record<string, { offset: number }> };
  return ledger.files[fileKeyOf(path)]?.offset;
}

test("a partial last line is not counted until its newline arrives, then counted once", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "partial");
  const first = claudeLines({ id: "P1", at: "2026-11-03T08:01:00Z", output: 4 });
  const second = claudeLine({ id: "P2", at: "2026-11-03T08:02:00Z", output: 6 });
  put(path, first + second.slice(0, 40));
  passOk(w);
  assert.equal(ledgerOffset(w, path), Buffer.byteLength(first));
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 4] });
  append(path, `${second.slice(40)}\n`);
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [2, 0, 0, 0, 10] });
  assert.equal(ledgerOffset(w, path), statSync(path).size);
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [2, 0, 0, 0, 10] });
});

test("a truncated file is scanned again from the start and counts nothing twice", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "trunc");
  const pad = "x".repeat(200);
  const a = claudeLine({ id: "T1", at: "2026-11-03T08:01:00Z", output: 4 });
  const b = claudeLine({ id: "T2", at: "2026-11-03T08:02:00Z", output: 6 });
  put(path, `${a.slice(0, -1)},"pad":"${pad}"}\n${b.slice(0, -1)},"pad":"${pad}"}\n`);
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [2, 0, 0, 0, 10] });
  const savedOffset = ledgerOffset(w, path) ?? 0;

  // The same file is rewritten shorter: one old line and one new line.
  const c = claudeLine({ id: "T3", at: "2026-11-03T08:03:00Z", output: 9 });
  const rewritten = `${a}\n${c}\n`;
  assert.ok(Buffer.byteLength(rewritten) < savedOffset);
  writeFileSync(path, rewritten);
  touch(path, DEFAULT_MTIME + 10 * MINUTE_MS);
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [3, 0, 0, 0, 19] });
  assert.equal(ledgerOffset(w, path), Buffer.byteLength(rewritten));
});

test("a rotated file with a new inode is scanned again from the start", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "rotate");
  const a = claudeLines({ id: "R1", at: "2026-11-03T08:01:00Z", output: 4 });
  put(path, a);
  passOk(w);
  const oldInode = statSync(path).ino;

  // The old file stays under another name, so the new file cannot reuse its inode.
  renameSync(path, `${path}.old`);
  const fresh = claudeLines({ id: "R2", at: "2026-11-03T08:02:00Z", output: 6 }) + a + claudeLines({ id: "R3", at: "2026-11-03T08:03:00Z", output: 7 });
  put(path, fresh, DEFAULT_MTIME + 10 * MINUTE_MS);
  assert.notEqual(statSync(path).ino, oldInode);
  assert.ok(Buffer.byteLength(fresh) > Buffer.byteLength(a), "a size check alone would not catch the rotation");
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [3, 0, 0, 0, 17] });
});

test("linked files and linked folders are skipped, a linked root is followed", (t) => {
  const w = makeWorld(t);
  const outside = w.sb.path("outside");
  put(join(outside, "elsewhere.jsonl"), claudeLines({ id: "L1", at: "2026-11-03T08:01:00Z", output: 100 }));
  put(join(outside, "dir", "inside.jsonl"), claudeLines({ id: "L2", at: "2026-11-03T08:01:00Z", output: 200 }));
  put(claudeFile(w, "real"), claudeLines({ id: "L3", at: "2026-11-03T08:01:00Z", output: 3 }));
  symlinkSync(join(outside, "elsewhere.jsonl"), claudeFile(w, "linked-file"));
  symlinkSync(join(outside, "dir"), join(w.claude, "-linked-folder"));
  const report = passOk(w);
  assert.equal(report.skippedLinks, 2);
  assert.equal(report.files, 1);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 3] });

  const viaLink = makeWorld(t);
  const target = viaLink.sb.path("real-root");
  put(join(target, PROJECT, "a.jsonl"), claudeLines({ id: "L4", at: "2026-11-03T08:01:00Z", output: 4 }));
  const linkedRoot = viaLink.sb.path("linked-root");
  symlinkSync(target, linkedRoot);
  const followed = passOk(viaLink, { roots: { claude: linkedRoot, codex: null } });
  assert.equal(followed.roots.claude, "scanned");
  assert.deepEqual(totals(viaLink), { [SONNET_ALPHA]: [1, 0, 0, 0, 4] });
});

test("a 5 MiB line is skipped and its neighbours are counted", (t) => {
  const w = makeWorld(t);
  const huge = `{"type":"assistant","usage":"${"x".repeat(5 * MIB)}"}\n`;
  const text = claudeLines({ id: "H1", at: "2026-11-03T08:01:00Z", output: 4 }) + huge + claudeLines({ id: "H2", at: "2026-11-03T08:02:00Z", output: 6 });
  put(claudeFile(w, "huge"), text);
  const report = passOk(w);
  assert.equal(report.rows.skippedLong, 1);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [2, 0, 0, 0, 10] });
  assert.equal(report.backlogBytes, 0);
});

test("discovery: subagent files, name filters, old files and old day folders", (t) => {
  const w = makeWorld(t);
  const line = (id: string): string => claudeLines({ id, at: "2026-11-03T08:01:00Z", output: 1 });
  put(claudeFile(w, "main"), line("D1"));
  put(join(w.claude, PROJECT, "sess-1", "subagents", "agent-1.jsonl"), line("D2"));
  put(join(w.claude, PROJECT, "sess-1", "subagents", "agent-1.txt"), line("D3"));
  put(join(w.claude, PROJECT, "sess-1", "other", "x.jsonl"), line("D4"));
  put(join(w.claude, PROJECT, "notes.txt"), line("D5"));
  put(claudeFile(w, "old"), line("D6"), Date.parse("2026-10-20T00:00:00Z"));
  put(codexFile(w, "today"), codexMeta("2026-11-03T08:00:00.000Z", "s", "/w") + codexTurn("2026-11-03T08:00:01.000Z", "gpt-5-codex") + codexEvent({ at: "2026-11-03T08:01:00.000Z", n: 1 }));
  put(codexFile(w, "stale", "2026/10/01"), codexMeta("2026-10-01T08:00:00.000Z", "s", "/w") + codexEvent({ at: "2026-10-01T08:01:00.000Z", n: 2 }));
  put(join(w.codex, "2026", "11", "03", "other-name.jsonl"), codexEvent({ at: "2026-11-03T08:01:00.000Z", n: 3 }));
  const report = passOk(w);
  // main, agent-1, today.
  assert.equal(report.files, 3);
  assert.equal(Object.keys(totals(w)).length, 2);
});

test("rows before the horizon are skipped, rows after it are counted", (t) => {
  const w = makeWorld(t);
  put(
    claudeFile(w, "edge"),
    claudeLines(
      { id: "E1", at: "2026-10-24T23:59:59Z", output: 1 },
      { id: "E2", at: "2026-10-25T00:00:00Z", output: 2 },
    ),
  );
  const report = passOk(w);
  assert.equal(report.rows.beforeHorizon, 1);
  assert.equal(report.rows.counted, 1);
  assert.deepEqual(totals(w), { [rowKey("2026-10-25T00:00:00Z", "claude", "claude-sonnet-5-5", "-work-alpha")]: [1, 0, 0, 0, 2] });
});

test("a folder over the entry cap is cut, counted, and does not prune the ledger", (t) => {
  const w = makeWorld(t);
  for (let i = 0; i < 5; i += 1) {
    put(claudeFile(w, `s${i}`), claudeLines({ id: `C${i}`, at: "2026-11-03T08:01:00Z", output: 1 }));
  }
  passOk(w);
  const ledgerBefore = readJson(join(w.data, LEDGER_FILE)) as { files: Record<string, unknown> };
  assert.equal(Object.keys(ledgerBefore.files).length, 5);
  const report = passOk(w, { maxEntriesPerFolder: 3 });
  assert.equal(report.cappedFolders, 1);
  assert.equal(report.files, 3);
  const ledgerAfter = readJson(join(w.data, LEDGER_FILE)) as { files: Record<string, unknown> };
  assert.equal(Object.keys(ledgerAfter.files).length, 5, "files that were not listed keep their offsets");
});

// Three project folders with four files each.
function seedProjects(w: World): void {
  for (const project of ["-work-a", "-work-b", "-work-c"]) {
    for (let i = 0; i < 4; i += 1) {
      put(claudeFile(w, `s${i}`, project), claudeLines({ id: `${project}${i}`, at: "2026-11-03T08:01:00Z" }));
    }
  }
}

function ledgerSize(w: World): number {
  return Object.keys((readJson(join(w.data, LEDGER_FILE)) as { files: Record<string, unknown> }).files).length;
}

test("the walk stops at the file cap: the other folders are not listed, and the listing counts as incomplete", (t) => {
  const w = makeWorld(t);
  seedProjects(w);
  passOk(w);
  assert.equal(ledgerSize(w), 12);
  // The first project listing is cut at 3 of its 4 names. A walk that goes on would list all three projects.
  const report = passOk(w, { maxFilesPerPass: 1, maxEntriesPerFolder: 3 });
  assert.equal(report.files, 1);
  assert.equal(report.cappedFolders, 1);
  assert.equal(ledgerSize(w), 12, "the files the walk did not reach keep their offsets");
});

test("the walk stops at its deadline once it has a file, and the listing counts as incomplete", (t) => {
  const w = makeWorld(t);
  seedProjects(w);
  passOk(w);
  // A file that left the root: a complete listing would drop its entry.
  unlinkSync(claudeFile(w, "s0", "-work-c"));
  const late = steppingClock(10 * MINUTE_MS, () => undefined);
  const report = passOk(w, { budget: { bytes: SCAN_BUDGET_BYTES, ms: 1000 } }, late.deps);
  assert.ok(report.files >= 1 && report.files <= 4, `the walk stopped after one project folder, found ${report.files}`);
  assert.equal(ledgerSize(w), 12, "the entry of the missing file stays, because the listing was cut short");
});

test("a deadline that has passed stops the walk of each provider only after it found one file of that provider", (t) => {
  const w = makeWorld(t);
  for (const project of ["-work-a", "-work-b", "-work-c"]) put(claudeFile(w, "s0", project), claudeLines({ id: project, at: "2026-11-03T08:01:00Z" }));
  for (const day of ["2026/11/03", "2026/11/02", "2026/11/01"]) {
    put(codexFile(w, `r-${day.slice(-2)}`, day), codexMeta("2026-11-02T20:00:00.000Z", `sess-${day}`, "/work/x"));
  }
  const late = steppingClock(10 * MINUTE_MS, () => undefined);
  const report = passOk(w, { budget: { bytes: SCAN_BUDGET_BYTES, ms: 0 } }, late.deps);
  assert.equal(report.files, 2, "one Claude file and one Codex file");
  assert.equal(report.filesRead, 1, "the pass still reads one file");
});

test("the ledger drops a file that left the root", (t) => {
  const w = makeWorld(t);
  const keep = claudeFile(w, "keep");
  const gone = claudeFile(w, "gone");
  put(keep, claudeLines({ id: "K1", at: "2026-11-03T08:01:00Z" }));
  put(gone, claudeLines({ id: "K2", at: "2026-11-03T08:01:00Z" }));
  passOk(w);
  unlinkSync(gone);
  passOk(w);
  assert.equal(ledgerOffset(w, gone), undefined);
  assert.equal(ledgerOffset(w, keep), statSync(keep).size);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [2, 0, 0, 0, 2] });
});

test("roots: a missing root and a skipped root are reported, and the pass still works", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "only"), claudeLines({ id: "M1", at: "2026-11-03T08:01:00Z" }));
  const report = passOk(w, { roots: { claude: w.claude, codex: w.sb.path("no-such-codex") } });
  assert.deepEqual(report.roots, { claude: "scanned", codex: "missing" });
  const skipped = passOk(w, { roots: { claude: null, codex: null } });
  assert.deepEqual(skipped.roots, { claude: "skipped", codex: "skipped" });
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 1] });
});

test("a root that is a file is unsafe, not scanned", (t) => {
  const w = makeWorld(t);
  const notFolder = w.sb.path("a-file");
  writeFileSync(notFolder, "x");
  const report = passOk(w, { roots: { claude: notFolder, codex: null } });
  assert.equal(report.roots.claude, "unsafe");
});

test("an unreadable file is counted, left out of the backlog, and read again later", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "locked");
  put(path, claudeLines({ id: "U1", at: "2026-11-03T08:01:00Z", output: 3 }));
  chmodSync(path, 0o000);
  const report = passOk(w);
  assert.equal(report.unreadable, 1);
  assert.equal(report.backlogBytes, 0);
  assert.equal(ledgerOffset(w, path), undefined);
  chmodSync(path, 0o600);
  passOk(w);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 3] });
});

// ---------------------------------------------------------------------------
// One commit for the store files: a stop in the middle of a flush
// ---------------------------------------------------------------------------

// Two Claude days and one Codex day, so that a flush writes several day files,
// a bucket month, the ledger and store.json.
function seedCommitCorpus(w: World): void {
  put(
    claudeFile(w, "sess-a"),
    claudeLines(
      { id: "A1", at: "2026-11-03T08:01:00Z", output: 11 },
      { id: "A2", at: "2026-11-02T09:01:00Z", output: 12 },
    ),
  );
  put(codexFile(w, "parent"), fixtureText("codex-basic.jsonl"), NOW - 5 * MINUTE_MS);
}

// Stops the process the way a kill does: the call after `stopAt` temp names
// throws and nothing runs after it. Every file write asks for one temp name.
function stoppingDeps(stopAt: number): { readonly deps: FsDeps; readonly calls: () => number } {
  let calls = 0;
  const deps: FsDeps = {
    ...DEPS,
    suffix: () => {
      if (calls >= stopAt) throw new Error("flush stopped");
      calls += 1;
      return defaultDeps().suffix();
    },
  };
  return { deps, calls: () => calls };
}

// The owner of the lock of a stopped pass is gone.
const AFTER_STOP: FsDeps = { ...DEPS, isAlive: () => false };

test("a stop at any point of a flush loses no tokens: the next pass counts every row once", (t) => {
  const reference = makeWorld(t);
  seedCommitCorpus(reference);
  const counter = stoppingDeps(Number.POSITIVE_INFINITY);
  passOk(reference, {}, counter.deps);
  const expected = totals(reference);
  const writes = counter.calls();
  assert.ok(writes >= 5, "the corpus makes a flush of several files");

  for (let stopAt = 0; stopAt < writes; stopAt += 1) {
    const w = makeWorld(t);
    seedCommitCorpus(w);
    assert.throws(() => pass(w, {}, stoppingDeps(stopAt).deps), /flush stopped/);
    passOk(w, {}, AFTER_STOP);
    assert.deepEqual(totals(w), expected, `stopped after ${stopAt} writes`);
  }
});

// The target of a temp name: ".dedupe-2026-11-03.json.123-abc.tmp" gives "dedupe-2026-11-03.json".
function targetOfTemp(temp: string): string {
  const match = /^\.([A-Za-z0-9-]+\.jsonl?)\.[A-Za-z0-9._-]+\.tmp$/.exec(temp);
  assert.ok(match !== null, `${temp} is a temp name`);
  return match[1] ?? "";
}

test("a flush stopped after the dedupe days moved and before the bucket months moved is completed by the next pass", (t) => {
  const reference = makeWorld(t);
  seedCommitCorpus(reference);
  const counter = stoppingDeps(Number.POSITIVE_INFINITY);
  passOk(reference, {}, counter.deps);
  const expected = totals(reference);
  const writes = counter.calls();

  // Stop before the journal is written: every new body sits in a temp file.
  const w = makeWorld(t);
  seedCommitCorpus(w);
  assert.throws(() => pass(w, {}, stoppingDeps(writes - 1).deps), /flush stopped/);
  // The first temp name went to the refresh of the lock before the flush. Its file is the lock now.
  const temps = readdirSync(w.data).filter((name) => name.endsWith(".tmp")).sort();
  assert.equal(temps.length, writes - 2);

  // The stop that matters: the journal is in place and the dedupe days are
  // renamed, but the bucket month, the ledger and store.json are not.
  const renames = temps.map((temp) => ({ temp, target: targetOfTemp(temp) }));
  for (const rename of renames.filter((r) => r.target.includes("dedupe-"))) {
    renameSync(join(w.data, rename.temp), join(w.data, rename.target));
  }
  writeFileSync(join(w.data, JOURNAL_FILE), JSON.stringify({ version: 1, renames }), { mode: 0o600 });
  assert.ok(existsSync(join(w.data, "dedupe-2026-11-03.json")));
  assert.ok(!existsSync(join(w.data, "buckets-2026-11.json")));
  assert.ok(!existsSync(join(w.data, LEDGER_FILE)));

  const healed = passOk(w, {}, AFTER_STOP);
  assert.deepEqual(totals(w), expected);
  assert.equal(healed.rows.counted, 0, "the ledger came with the commit, so no row is read twice");
  assert.deepEqual(readdirSync(w.data).filter((name) => name.endsWith(".tmp") || name === JOURNAL_FILE), []);
  const ledger = readJson(join(w.data, LEDGER_FILE)) as { files: Record<string, unknown> };
  assert.equal(Object.keys(ledger.files).length, 2, "the ledger lists the Claude and the Codex file");
  assert.equal(passOk(w).filesWritten, 0);
});

test("a journal that is damaged, names a foreign file or has a newer version stops the pass with no write", (t) => {
  const w = populated(t);
  const own = ".ledger.json.1-aa.tmp";
  const cases: readonly { readonly text: string; readonly code: string }[] = [
    { text: "{not json", code: "store_corrupt" },
    { text: "[]", code: "store_corrupt" },
    { text: JSON.stringify({ version: 0, renames: [] }), code: "store_corrupt" },
    { text: JSON.stringify({ version: 1, renames: "x" }), code: "store_corrupt" },
    { text: JSON.stringify({ version: 1, renames: [{ temp: ".status.json.1-aa.tmp", target: "status.json" }] }), code: "store_corrupt" },
    { text: JSON.stringify({ version: 1, renames: [{ temp: ".store.json.1-aa.tmp", target: LEDGER_FILE }] }), code: "store_corrupt" },
    { text: JSON.stringify({ version: 1, renames: [{ temp: "../.ledger.json.1-aa.tmp", target: LEDGER_FILE }] }), code: "store_corrupt" },
    { text: JSON.stringify({ version: 1, renames: [{ temp: own, target: "../ledger.json" }] }), code: "store_corrupt" },
    { text: JSON.stringify({ version: 1, renames: [{ temp: own, target: LEDGER_FILE }, { temp: ".ledger.json.2-bb.tmp", target: LEDGER_FILE }] }), code: "store_corrupt" },
    { text: JSON.stringify({ version: 2, renames: [] }), code: "store_newer" },
  ];
  for (const { text, code } of cases) {
    writeFileSync(join(w.data, JOURNAL_FILE), text, { mode: 0o600 });
    const before = snapshot(w.data);
    const error = mustFail(pass(w));
    assert.deepEqual({ code: error.code, file: error.file }, { code, file: JOURNAL_FILE }, text);
    assert.deepEqual(snapshot(w.data), before, `no write for ${text}`);
  }
});

test("a newer store.json is refused before a journal is completed", (t) => {
  const w = populated(t);
  const temp = ".ledger.json.1-aa.tmp";
  writeFileSync(join(w.data, temp), JSON.stringify({ version: 1, files: {} }), { mode: 0o600 });
  writeFileSync(join(w.data, JOURNAL_FILE), JSON.stringify({ version: 1, renames: [{ temp, target: LEDGER_FILE }] }), { mode: 0o600 });
  writeFileSync(join(w.data, STORE_FILE), JSON.stringify({ version: 2 }), { mode: 0o600 });
  const before = snapshot(w.data);
  assert.equal(mustFail(pass(w)).code, "store_newer");
  assert.deepEqual(snapshot(w.data), before);
});

// ---------------------------------------------------------------------------
// Temp files of killed writes
// ---------------------------------------------------------------------------

test("a pass removes the temp files of killed writes that are older than the stale age, and nothing else", (t) => {
  const w = populated(t);
  const old = NOW - LOCK_STALE_MS - 1000;
  const stale = [
    ".buckets-2026-11.json.111-aaaa.tmp",
    ".quota-latest.json.222-bbbb.tmp",
    ".tasks.jsonl.333-cccc.tmp",
    ".collect.lock.777-gggg.tmp",
  ];
  const fresh = [".ledger.json.444-dddd.tmp"];
  const others = ["notes.tmp", ".hidden.tmp", ".note.txt.1-x.tmp", ".ledger.json.tmp", "keep.json", ".keep.json"];
  for (const name of [...stale, ...fresh, ...others]) {
    const path = join(w.data, name);
    writeFileSync(path, "x", { mode: 0o600 });
    touch(path, fresh.includes(name) ? NOW - LOCK_STALE_MS / 4 : old);
  }
  const link = join(w.data, ".dedupe-2026-11-03.json.555-eeee.tmp");
  symlinkSync(join(w.data, "keep.json"), link);
  mkdirSync(join(w.data, ".folder.json.666-ffff.tmp"));

  passOk(w);
  for (const name of stale) assert.ok(!existsSync(join(w.data, name)), `${name} is removed`);
  for (const name of [...fresh, ...others]) assert.ok(existsSync(join(w.data, name)), `${name} stays`);
  assert.ok(lstatSync(link).isSymbolicLink(), "a link with a temp name stays");
  assert.ok(lstatSync(join(w.data, ".folder.json.666-ffff.tmp")).isDirectory(), "a folder with a temp name stays");
});

test("temp files cannot fill the data folder up to its name cap", (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), claudeLines({ id: "T1", at: "2026-11-03T08:01:00Z" }));
  const old = NOW - 10 * MINUTE_MS;
  for (let i = 0; i < 1005; i += 1) {
    const path = join(w.data, `.dedupe-2026-11-03.json.${i}-x.tmp`);
    writeFileSync(path, "x", { mode: 0o600 });
    touch(path, old);
  }
  passOk(w);
  passOk(w);
  assert.deepEqual(readdirSync(w.data).filter((name) => name.endsWith(".tmp")), []);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 1] });
});

// ---------------------------------------------------------------------------
// The ledger: parser revision, file time, pruning and the size cap
// ---------------------------------------------------------------------------

type LedgerFile = { version: number; files: Record<string, Record<string, unknown>> };

function rewriteLedgerEntry(
  w: World, path: string, update: (entry: Readonly<Record<string, unknown>>) => Record<string, unknown>,
): void {
  const ledgerPath = join(w.data, LEDGER_FILE);
  const ledger = readJson(ledgerPath) as LedgerFile;
  const key = fileKeyOf(path);
  const entry = ledger.files[key];
  assert.ok(entry !== undefined);
  ledger.files[key] = update(entry);
  writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
}

test("a legacy offset at EOF resumes a budget-cut re-read and counts each proxy row once", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "legacy");
  const at = "2026-11-03T08:01:00Z";
  const native = ["A", "B"].map((id) => claudeLines({ id, at }));
  const proxy = [
    proxyLine("old", "2026-10-24T08:01:00Z", 40),
    proxyLine("new1", at, 10),
    proxyLine("new2", at, 20),
  ];
  put(path, native.join(""));
  assert.equal(passOk(w).rows.counted, 2);
  append(path, proxy.join(""));
  const { size, mtimeMs } = statSync(path);
  rewriteLedgerEntry(w, path, ({ rev, ...legacy }) => ({ ...legacy, size, mtimeMs, offset: size }));
  const lines = [...native, ...proxy];
  const budget = { bytes: Math.max(...lines.map((line) => Buffer.byteLength(line))), ms: SCAN_BUDGET_MS };

  let backlog = size;
  const reports: CollectReport[] = [];
  for (let i = 0; i < lines.length && backlog > 0; i += 1) {
    const report = passOk(w, { budget });
    assert.ok(report.bytesRead > 0 && report.bytesRead <= budget.bytes);
    assert.ok(report.backlogBytes < backlog, "each pass advances from its saved offset");
    if (report.backlogBytes > 0) assert.equal(report.stoppedBy, "bytes");
    reports.push(report);
    backlog = report.backlogBytes;
  }

  assert.equal(backlog, 0);
  assert.ok(reports.length > 2);
  assert.equal(ledgerOffset(w, path), size);
  assert.equal(reports.reduce((n, report) => n + report.rows.repeats, 0), 2);
  assert.equal(reports.reduce((n, report) => n + report.rows.beforeHorizon, 0), 1);
  assert.equal(reports.reduce((n, report) => n + report.rows.counted, 0), 2);
  assert.deepEqual(totals(w), {
    [SONNET_ALPHA]: [2, 0, 0, 0, 2],
    [rowKey(at, "codex", PROXY_MODEL, PROJECT)]: [200, 0, 0, 60, 30],
  });
  const warm = passOk(w, { budget });
  assert.equal(warm.bytesRead, 0);
  assert.equal(warm.filesWritten, 0);
});

test("a legacy ledger rewrite accepts the extended store and adds no rows on re-read", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "legacy");
  const at = "2026-11-03T08:01:00Z";
  const id = "x".repeat(123);
  put(path, claudeLines({ id: "A", at }) + proxyLine(id, at, 10));
  passOk(w);
  const before = totals(w);

  // The 0.3.0 dedupe pattern accepts the complete 128-character response ID.
  const legacyClaudeKey = /^[A-Za-z0-9_.:-]{1,128}\|[A-Za-z0-9_.:-]{1,128}$/;
  const dedupe = readJson(join(w.data, "dedupe-2026-11-03.json")) as { entries: Record<string, unknown> };
  const key = `resp_${id}|codex`;
  assert.ok(Object.hasOwn(dedupe.entries, key));
  assert.match(key, legacyClaudeKey);

  // Version 1 checks only the known ledger fields. The old writer drops rev.
  const ledger = readJson(join(w.data, LEDGER_FILE)) as LedgerFile;
  assert.equal(ledger.version, 1);
  rewriteLedgerEntry(w, path, ({ rev, ...legacy }) => {
    const { dev, ino, size, mtimeMs } = statSync(path);
    assert.deepEqual(legacy, { provider: "claude", dev, ino, size, offset: size, mtimeMs, codex: null });
    assert.equal(rev, CLAUDE_PARSER_REV);
    return legacy;
  });
  const reread = passOk(w);
  assert.equal(reread.rows.repeats, 2);
  assert.equal(reread.rows.counted, 0);
  assert.deepEqual(totals(w), before);
});

test("a null parser revision requests a re-read", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "legacy");
  put(path, claudeLines({ id: "A", at: "2026-11-03T08:01:00Z" }));
  passOk(w);
  rewriteLedgerEntry(w, path, (entry) => ({ ...entry, rev: null }));

  const report = passOk(w);
  assert.equal(report.rows.repeats, 1);
  assert.equal(report.rows.counted, 0);
});

test("the Claude ledger records the parser revision even when the file has no bytes", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "empty");
  put(path, "");
  passOk(w);
  rewriteLedgerEntry(w, path, ({ rev, ...legacy }) => legacy);

  const upgraded = passOk(w);
  assert.equal(upgraded.bytesRead, 0);
  assert.equal(upgraded.filesWritten, 1);
  assert.equal(passOk(w).filesWritten, 0);
});

test("a future parser revision keeps the offset and the next write records the current revision", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "future");
  const at = "2026-11-03T08:01:00Z";
  put(path, claudeLines({ id: "A", at }));
  passOk(w);
  rewriteLedgerEntry(w, path, (entry) => ({ ...entry, rev: CLAUDE_PARSER_REV + 1 }));
  append(path, proxyLine("new", at, 10));

  const report = passOk(w);
  assert.equal(report.rows.counted, 1);
  assert.equal(report.rows.repeats, 0);
  const ledger = readJson(join(w.data, LEDGER_FILE)) as LedgerFile;
  assert.equal(ledger.files[fileKeyOf(path)]?.["rev"], CLAUDE_PARSER_REV);
});

test("the Codex ledger keeps its offset without a parser revision", (t) => {
  const w = makeWorld(t);
  const path = codexFile(w, "parent");
  put(path, fixtureText("codex-basic.jsonl"));
  passOk(w);

  const ledger = readJson(join(w.data, LEDGER_FILE)) as LedgerFile;
  const entry = ledger.files[fileKeyOf(path)];
  assert.ok(entry !== undefined && !Object.hasOwn(entry, "rev"));
  assert.equal(passOk(w).bytesRead, 0);
});

test("the ledger rejects a parser revision that is not a count", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "legacy");
  put(path, claudeLines({ id: "A", at: "2026-11-03T08:01:00Z" }));
  passOk(w);

  for (const rev of ["1", -1, 0.5, Number.MAX_SAFE_INTEGER + 1, true, []]) {
    rewriteLedgerEntry(w, path, (entry) => ({ ...entry, rev }));
    assertStopsWithNoWrite(w, { code: "store_corrupt", file: LEDGER_FILE });
  }
});

test("the ledger keeps the file time of each source, and a ledger without it is read and upgraded", (t) => {
  const w = makeWorld(t);
  const path = claudeFile(w, "sess-a");
  put(path, claudeLines({ id: "L1", at: "2026-11-03T08:01:00Z" }));
  passOk(w);
  const ledgerPath = join(w.data, LEDGER_FILE);
  const saved = readJson(ledgerPath) as LedgerFile;
  assert.equal(saved.files[fileKeyOf(path)]?.["mtimeMs"], statSync(path).mtimeMs);

  for (const entry of Object.values(saved.files)) delete entry["mtimeMs"];
  writeFileSync(ledgerPath, JSON.stringify(saved), { mode: 0o600 });
  const upgraded = passOk(w);
  assert.equal(upgraded.rows.counted, 0);
  assert.equal(upgraded.filesWritten, 1, "only the ledger is written");
  assert.equal((readJson(ledgerPath) as LedgerFile).files[fileKeyOf(path)]?.["mtimeMs"], statSync(path).mtimeMs);
  assert.deepEqual(totals(w), { [SONNET_ALPHA]: [1, 0, 0, 0, 1] });

  for (const bad of ["x", -1, [], true]) {
    const broken = readJson(ledgerPath) as LedgerFile;
    const entry = broken.files[fileKeyOf(path)];
    assert.ok(entry !== undefined);
    entry["mtimeMs"] = bad;
    writeFileSync(ledgerPath, JSON.stringify(broken), { mode: 0o600 });
    assert.equal(mustFail(pass(w)).code, "store_corrupt", String(bad));
  }
});

test("a listing that stays incomplete still drops the ledger entries of files older than the horizon", (t) => {
  const w = makeWorld(t);
  for (let i = 0; i < 5; i += 1) {
    put(claudeFile(w, `s${i}`), claudeLines({ id: `P${i}`, at: "2026-11-03T08:01:00Z" }));
  }
  passOk(w);
  const ledgerPath = join(w.data, LEDGER_FILE);
  const ledger = readJson(ledgerPath) as { files: Record<string, unknown> };
  const horizon = horizonStartMs(NOW);
  const entry = (mtimeMs: number | null): unknown => ({
    provider: "claude",
    dev: 1,
    ino: 1,
    size: 10,
    offset: 10,
    mtimeMs,
    codex: null,
  });
  const [older, recent, unknown] = ["a", "b", "c"].map((c) => c.repeat(64)) as [string, string, string];
  ledger.files[older] = entry(horizon - HOUR_MS);
  ledger.files[recent] = entry(horizon + HOUR_MS);
  ledger.files[unknown] = entry(null);
  writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });

  const report = passOk(w, { maxEntriesPerFolder: 3 });
  assert.equal(report.cappedFolders, 1);
  const kept = Object.keys((readJson(ledgerPath) as { files: Record<string, unknown> }).files);
  assert.ok(!kept.includes(older), "a file older than the horizon is dropped");
  assert.ok(kept.includes(recent) && kept.includes(unknown), "a file the listing may have missed is kept");
  assert.equal(kept.length, 7, "the files the listing did not reach keep their offsets");

  passOk(w);
  assert.equal(Object.keys((readJson(ledgerPath) as { files: Record<string, unknown> }).files).length, 5);
});

test("a ledger that would pass its read cap stops the flush with store_too_large and writes nothing", (t) => {
  const w = makeWorld(t);
  for (let i = 0; i < 3; i += 1) {
    put(claudeFile(w, `s${i}`), claudeLines({ id: `Z${i}`, at: "2026-11-03T08:01:00Z" }));
  }
  // A ledger just under its cap, of entries that no scan can drop: they have no file time.
  const row = '{"provider":"claude","dev":1,"ino":1,"size":1,"offset":1,"mtimeMs":null,"codex":null}';
  const head = '{"version":1,"files":{';
  const tail = "}}";
  const each = 64 + 4 + row.length;
  const count = Math.floor((FILE_CAPS.ledger - head.length - tail.length) / each);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) parts.push(`"${i.toString(16).padStart(64, "0")}":${row}`);
  const body = `${head}${parts.join(",")}${tail}`;
  assert.ok(body.length <= FILE_CAPS.ledger && FILE_CAPS.ledger - body.length < each, "less room than one entry");
  writeFileSync(join(w.data, LEDGER_FILE), body, { mode: 0o600 });
  writeFileSync(join(w.data, STORE_FILE), '{"version":1}', { mode: 0o600 });
  const before = snapshot(w.data);

  // The folder holds 3 files and the entry cap is 2, so the listing is incomplete and keeps the ledger whole.
  const error = mustFail(pass(w, { maxEntriesPerFolder: 2 }));
  assert.deepEqual({ code: error.code, file: error.file }, { code: "store_too_large", file: LEDGER_FILE });
  assert.deepEqual(snapshot(w.data), before, "no file, no temp file and no journal is written");
});
