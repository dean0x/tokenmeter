// Tests for the commands (plan 3.5, 3.6, 3.10). TP-1 (the status side), TP-14,
// TP-17 (flags and the data folder) and TP-18 (the error and empty states). The
// estimate log and the self-check in collect: TP-19 to TP-22, TP-27 to TP-29,
// TP-44, TP-47, TP-48, TP-67 and TP-69.
//
// Most tests call runCli in this process, with a fixed clock, a sandbox for the
// data folder and the source roots, and fake streams. The bin tests start a
// child process with the sandbox env and the real clock, so the data they make
// is relative to the real now. No test reads or writes the real home.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs, {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import { ACCOUNT_DAY_TOKENS_MAX, ACCOUNT_KEEP_DAYS, ACCOUNT_MAX_AGE_MS, ACCOUNT_READ_CAP_BYTES, ACCOUNT_USAGE_FILE } from "../src/account-usage.ts";
import type { AccountFile, AccountRow } from "../src/account-usage.ts";
import { DAYS_HORIZON_DAYS, DAYS_MAX_MODELS, SCHEMA_ID, STATUS_OUTPUT_MAX_BYTES, STORE_VERSION, SYNC_MAX_BYTES, SYNC_MAX_OPEN_ITEMS, errorRecord, weighted } from "../src/core.ts";
import { type CliIo, parseArgs, runCli } from "../src/cli.ts";
import { DEFAULT_BUDGET } from "../src/collect.ts";
import { DEFAULT_APP_SERVER } from "../src/config.ts";
import { DayRows, cutoffDateOf, localDateOf, shiftDate } from "../src/days.ts";
import { ESTIMATE_LOG_CAP_BYTES, logLineText } from "../src/estimate-log.ts";
import type { EstimateLogLine, RangedLogLine } from "../src/estimator.ts";
import { type FsDeps, acquireLock, defaultDeps, prepareDataDir, releaseLock } from "../src/fsafe.ts";
import type { Zone } from "../src/periods.ts";
import {
  QUOTA_LATEST_FILE,
  QUOTA_MONTH_CAP_BYTES,
  type QuotaReading,
  type StatuslineQuota,
  recordStatuslineQuota,
} from "../src/quota.ts";
import { FILE_CAPS, loadDayRows } from "../src/store.ts";
import { RECORD_DEADLINE_MS, type RecordIo, runRecord } from "../src/record.ts";
import type { PeriodsJson } from "../src/rollup.ts";
import { readSnapshot, type PeriodTotalJson, type StatusData, type StatusOutputData } from "../src/status.ts";
import { NO_DATA_LINE, renderStatusline, runStatusline } from "../src/statusline.ts";
import { type Sandbox, assertGuarded, installSuiteGuard, makeSandbox } from "./helpers.ts";
import { TIMING_RUNS, judgeTiming, measurePaired, writeBaselineScript } from "./timing.ts";

installSuiteGuard();

const NOW = Date.parse("2026-11-03T12:00:00Z");
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MIB = 1024 * 1024;
const FIXTURES = join(import.meta.dirname, "fixtures");
const BIN = join(import.meta.dirname, "..", "bin", "tokenmeter.js");
const CANARY = "CANARY-7f3e";
const UTC: Zone = { offsetMs: () => 0 };
const DEPS: FsDeps = { ...defaultDeps(), nowMs: () => NOW };

const FIVE_RESET = NOW + 2 * HOUR_MS;
const WEEK_RESET = NOW + 3 * DAY_MS;
// The Codex week reset in the codex-basic fixture, and its 5 hour reset that is
// already over at NOW.
const CODEX_WEEK_RESET = Date.parse("2026-11-07T00:00:00Z");
const CODEX_WEEK_AT = Date.parse("2026-11-03T08:05:00Z");
const CODEX_WEEK_PCT = 42;

// Weighted tokens of the two Claude fixture rows (see collect.test.ts).
const SONNET_ALPHA_WEIGHTED = 655;
const OPUS_BETA_WEIGHTED = 2012;
const CLAUDE_FIXTURE_WEIGHTED = SONNET_ALPHA_WEIGHTED + OPUS_BETA_WEIGHTED;
// The same two tasks in raw tokens: the five columns added with no weight.
// Alpha: 100 + 200 + 0 + 300 + 55. Beta: 12 + 520 + 600 + 50 + 29.
const SONNET_ALPHA_RAW = 655;
const OPUS_BETA_RAW = 1211;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Envelope {
  readonly schema: string;
  readonly ok: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly data: any;
  readonly error: { readonly code: string; readonly hint: string };
}

interface Run {
  readonly code: number;
  readonly text: string;
  readonly stderr: string;
  readonly env: Envelope;
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  assert.ok(value !== undefined, `no element at ${index}`);
  return value;
}

interface World {
  readonly sb: Sandbox;
  readonly claude: string;
  readonly codex: string;
}

function makeWorld(t: TestContext): World {
  const sb = makeSandbox(t);
  const claude = sb.path("src-claude");
  const codex = sb.path("src-codex");
  mkdirSync(claude);
  mkdirSync(codex);
  return { sb, claude, codex };
}

interface CliOptions {
  readonly stdin?: string;
  readonly io?: Partial<CliIo>;
}

async function cli(w: World, args: readonly string[], options: CliOptions = {}): Promise<Run> {
  const out: string[] = [];
  const errs: string[] = [];
  const io: CliIo = {
    stdin: Readable.from(options.stdin === undefined ? [] : [Buffer.from(options.stdin, "utf8")]),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => errs.push(text) },
    env: w.sb.env,
    platform: "linux",
    homeDir: w.sb.home,
    deps: DEPS,
    zone: UTC,
    budget: DEFAULT_BUDGET,
    ...options.io,
  };
  const code = await runCli(args, io);
  const text = out.join("");
  return { code, text, stderr: errs.join(""), env: JSON.parse(text) as Envelope };
}

test("config reports the default without creating a data folder", async (t) => {
  const w = makeWorld(t);
  const run = await cli(w, ["config"]);
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data, { app_server: DEFAULT_APP_SERVER });
  assert.equal(existsSync(w.sb.dataDir), false);
});

test("config writes to the selected folder, reports it, and reads the saved value", async (t) => {
  const w = makeWorld(t);
  const dataDir = w.sb.path("selected-data");
  for (const app_server of ["off", "on"]) {
    const set = await cli(w, ["config", "app_server", app_server, "--data-dir", dataDir]);
    assert.equal(set.code, 0, set.text);
    assert.deepEqual(set.env.data, { app_server, data_dir: dataDir });
    const read = await cli(w, ["config", "--data-dir", dataDir]);
    assert.deepEqual(read.env.data, { app_server });
  }
  assert.equal(existsSync(w.sb.dataDir), false);
});

test("config rejects invalid keys and values without creating a data folder", async (t) => {
  const w = makeWorld(t);
  for (const args of [["other", "off"], ["app_server"], ["app_server", "true"], ["app_server", "off", "on"]]) {
    const run = await cli(w, ["config", ...args]);
    assert.equal(run.env.error?.code, "usage_error", run.text);
  }
  assert.equal(existsSync(w.sb.dataDir), false);
});

test("config reports off for a damaged, group-readable, or linked file", async (t) => {
  const w = makeWorld(t);
  mkdirSync(w.sb.dataDir, { mode: 0o700 });
  const config = join(w.sb.dataDir, "config.json");
  writeFileSync(config, "{", { mode: 0o600 });
  const expectOff = async () => {
    const run = await cli(w, ["config"]);
    assert.equal(run.code, 0, run.text);
    assert.deepEqual(run.env.data, { app_server: "off" });
  };
  await expectOff();
  writeFileSync(config, '{"version":1,"app_server":"on"}');
  chmodSync(config, 0o640);
  await expectOff();
  if (process.platform !== "win32") {
    const other = w.sb.path("other-config.json");
    writeFileSync(other, '{"version":1,"app_server":"on"}', { mode: 0o600 });
    fs.unlinkSync(config);
    symlinkSync(other, config);
    await expectOff();
  }
});

function collectArgs(w: World): string[] {
  return ["collect", "--claude-root", w.claude, "--codex-root", w.codex];
}

async function collectOk(w: World, options: CliOptions = {}): Promise<Envelope> {
  const run = await cli(w, collectArgs(w), options);
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.ok, true);
  return run.env;
}

async function dataOf(w: World, command: string, options: CliOptions = {}): Promise<Envelope["data"]> {
  const run = await cli(w, [command], options);
  assert.equal(run.code, 0, run.text);
  return run.env.data;
}

// The self_check of a log that was read, with `n` scored tasks and no number to show,
// and no line of any stage. The keys are in the order of the output.
function unscored(n: number | null, stages: object | null = {}): object {
  return { n, hit_rate: null, error_factor: null, bias: null, band_low: null, band_high: null, width: null, useful_rate: null, stages, projects: n === null ? null : {} };
}

// The queue of a status with no open item. The keys are in the order of the output.
const ZERO_QUEUE = { count: 0, expected_pct: 0, low_pct: 0, high_pct: 0, likely_low_pct: 0, likely_high_pct: 0, spent_pct: 0 };

function failureOf(run: Run): string {
  assert.equal(run.env.ok, false, run.text);
  assert.equal(run.env.schema, SCHEMA_ID);
  return run.env.error.code;
}

function put(path: string, text: string, mtimeMs: number = NOW - HOUR_MS): void {
  assertGuarded(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

function fixtureText(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function claudeFile(w: World, name: string): string {
  return join(w.claude, "-work-proj", `${name}.jsonl`);
}

function codexFile(w: World, name: string): string {
  return join(w.codex, "2026", "11", "03", `rollout-${name}.jsonl`);
}

function seedClaude(w: World): void {
  put(claudeFile(w, "sess-a"), fixtureText("claude-basic.jsonl"));
}

function seedFixtures(w: World): void {
  seedClaude(w);
  put(codexFile(w, "a-parent"), fixtureText("codex-basic.jsonl"), NOW - 5 * MINUTE_MS);
}

function dataDir(w: World): string {
  return w.sb.dataDir;
}

function point(pct: number, resetsAt: number): { usedPercent: number; resetsAt: number } {
  return { usedPercent: pct, resetsAt };
}

// The record side: the same call that `record` makes, at the fixed clock.
function recordQuota(w: World, quota: StatuslineQuota, nowMs: number = NOW): void {
  const dir = prepareDataDir(dataDir(w), DEPS);
  assert.ok(dir.ok);
  const stored = recordStatuslineQuota(dir.value, quota, nowMs, DEPS);
  assert.ok(stored.ok);
}

function recordPoints(w: World, five: number, week: number): void {
  recordQuota(w, { five_hour: point(five, FIVE_RESET), week: point(week, WEEK_RESET) });
}

// Every file of the data folder with a digest of its content and mode.
function folderState(dir: string): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const info = lstatSync(path);
    const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    out.set(name, `${info.mode & 0o777}:${digest}`);
  }
  return out;
}

function sameExcept(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>, except: string): void {
  const strip = (map: ReadonlyMap<string, string>): [string, string][] => [...map].filter(([name]) => name !== except);
  assert.deepEqual(strip(after), strip(before));
}

const BUCKET_FILE = /^buckets-\d{4}-\d{2}\.json$/;

// How often each bucket month file is opened while `run` runs. The count comes
// from the open calls that the loader makes, so it holds for any caller.
async function bucketOpens(t: TestContext, run: () => Promise<void>): Promise<ReadonlyMap<string, number>> {
  const opens = new Map<string, number>();
  const original = fs.openSync;
  const spy = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const name = basename(String(args[0]));
    if (BUCKET_FILE.test(name)) opens.set(name, (opens.get(name) ?? 0) + 1);
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    await run();
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
  return opens;
}

interface ClaudeRow {
  readonly id: string;
  readonly at: string;
  readonly model: string;
  readonly cwd?: string;
  readonly input?: number;
  readonly output?: number;
}

function claudeLine(row: ClaudeRow): string {
  const usage = {
    input_tokens: row.input ?? 1,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: row.output ?? 1,
  };
  return `${JSON.stringify({
    type: "assistant",
    timestamp: row.at,
    cwd: row.cwd ?? "/work/alpha",
    requestId: `req_${row.id}`,
    message: { id: `msg_${row.id}`, model: row.model, usage },
  })}\n`;
}

// --- the bin, as a child process ---

interface ChildRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

function runBin(args: readonly string[], env: Readonly<Record<string, string>>, input = "", bin: string = BIN): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    const child = spawn(bin, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errs.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("close", (code) =>
      resolve({
        code,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errs).toString("utf8"),
        ms: performance.now() - start,
      }),
    );
    child.stdin.end(input);
  });
}

function envelopeOf(run: ChildRun): Envelope {
  assert.equal(run.stderr, "");
  assert.equal(run.stdout.split("\n").length, 2, "one line of JSON");
  return JSON.parse(run.stdout) as Envelope;
}

// ---------------------------------------------------------------------------
// Arguments (TP-17)
// ---------------------------------------------------------------------------

test("arguments: flags in both forms, before or after the command, are accepted", () => {
  const a = parseArgs(["status", "--data-dir=/a"]);
  assert.ok(a.ok);
  assert.equal(a.value.command, "status");
  assert.equal(a.value.flags.get("--data-dir"), "/a");
  const b = parseArgs(["--data-dir", "/a", "tasks", "sync"]);
  assert.ok(b.ok);
  assert.equal(b.value.command, "tasks sync");
  const c = parseArgs(["doctor", "--claude-root", "/c", "--codex-root=/x"]);
  assert.ok(c.ok);
  assert.equal(c.value.flags.size, 2);
  for (const command of ["collect", "status", "usage", "tasks", "estimate", "doctor", "record", "statusline"]) {
    assert.ok(parseArgs([command]).ok, command);
  }
});

test("arguments: an unknown command or flag, or a bad shape, gives usage_error with the fixed hint and no input text", async (t) => {
  const w = makeWorld(t);
  const cases: readonly (readonly string[])[] = [
    [],
    ["bogus"],
    ["status", "extra"],
    ["tasks", "bogus"],
    ["tasks", "sync", "more"],
    ["status", "--bogus"],
    ["status", "--data-dir"],
    ["status", "--data-dir="],
    ["status", "--data-dir", "--data-dir", "x"],
    ["status", "--data-dir", "a", "--data-dir", "b"],
    ["status", "--claude-root", "/x"],
    ["usage", "--codex-root", "/x"],
    ["tasks", "sync", "--claude-root", "/x"],
    ["estimate", "--codex-root=/x"],
    ["record", "--data-dir", "/x"],
    ["statusline", "--data-dir", "/x"],
    ["statusline", "extra"],
    ["-h"],
    ["--help"],
    ["collect", "-x"],
    ["status", "--now", "5"],
    ["status", "--out", "x"],
    [`${CANARY}-command`],
    ["status", `--${CANARY}-flag`],
    ["status", `--${CANARY}-flag=1`],
    ["status", `--data-dir=${CANARY}`, `--data-dir=${CANARY}`],
    Array.from({ length: 17 }, () => "status"),
  ];
  for (const args of cases) {
    const run = await cli(w, args);
    assert.equal(run.code, 2, JSON.stringify(args));
    assert.deepEqual(run.env, { schema: SCHEMA_ID, ok: false, error: errorRecord("usage_error") }, JSON.stringify(args));
    assert.equal(run.text.includes(CANARY), false, "the input is not echoed");
  }
  assert.equal(existsSync(dataDir(w)), false, "a refused command makes no folder");
});

// ---------------------------------------------------------------------------
// The data folder (TP-17)
// ---------------------------------------------------------------------------

test("data folder: a symlink is refused by every command, and nothing is written through it", async (t) => {
  const w = makeWorld(t);
  const real = w.sb.path("real");
  mkdirSync(real, { mode: 0o700 });
  const link = w.sb.path("link");
  symlinkSync(real, link);
  const commands: readonly (readonly string[])[] = [
    [...collectArgs(w)],
    ["status"],
    ["usage"],
    ["tasks"],
    ["tasks", "sync"],
    ["estimate"],
    ["doctor"],
  ];
  for (const args of commands) {
    const run = await cli(w, [...args, "--data-dir", link], { stdin: '{"windows":[],"items":[]}' });
    assert.equal(run.code, 1, JSON.stringify(args));
    assert.equal(failureOf(run), "data_dir_unsafe", JSON.stringify(args));
  }
  assert.deepEqual(readdirSync(real), []);
});

test("data folder: a folder that others can write to, or that another user owns, is refused", async (t) => {
  const w = makeWorld(t);
  const open = w.sb.path("open");
  mkdirSync(open);
  chmodSync(open, 0o777);
  assert.equal(failureOf(await cli(w, ["collect", "--data-dir", open, "--claude-root", w.claude, "--codex-root", w.codex])), "data_dir_unsafe");
  const mine = w.sb.path("mine");
  mkdirSync(mine, { mode: 0o700 });
  const foreign = { ...DEPS, uid: DEPS.uid + 1 };
  assert.equal(failureOf(await cli(w, ["status", "--data-dir", mine], { io: { deps: foreign } })), "data_dir_unsafe");
  assert.deepEqual(readdirSync(open), []);
  assert.deepEqual(readdirSync(mine), []);
});

test("data folder: collect makes the folder 0700 and writes its files 0600", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  assert.equal(lstatSync(dataDir(w)).mode & 0o777, 0o700);
  for (const name of readdirSync(dataDir(w))) {
    assert.equal(lstatSync(join(dataDir(w), name)).mode & 0o077, 0, name);
  }
  assert.ok(existsSync(join(dataDir(w), "status.json")));
});

test("data folder: the flag wins over the environment", async (t) => {
  const w = makeWorld(t);
  const other = w.sb.path("other");
  const run = await cli(w, [...collectArgs(w), "--data-dir", other]);
  assert.equal(run.code, 0, run.text);
  assert.ok(existsSync(join(other, "status.json")));
  assert.equal(existsSync(dataDir(w)), false);
});

// ---------------------------------------------------------------------------
// Never collected (TP-18)
// ---------------------------------------------------------------------------

test("not collected: the read commands say not_collected and do not make the data folder", async (t) => {
  const w = makeWorld(t);
  const reads: readonly [readonly string[], string | undefined][] = [
    [["status"], undefined],
    [["usage"], undefined],
    [["tasks"], undefined],
    [["doctor"], undefined],
    [["estimate"], '{"items":[]}'],
  ];
  for (const [args, stdin] of reads) {
    const run = await cli(w, args, stdin === undefined ? {} : { stdin });
    assert.equal(run.code, 1, JSON.stringify(args));
    assert.deepEqual(run.env, { schema: SCHEMA_ID, ok: false, error: errorRecord("not_collected") });
  }
  assert.equal(existsSync(dataDir(w)), false);
});

test("not collected: an empty data folder says the same", async (t) => {
  const w = makeWorld(t);
  mkdirSync(dataDir(w), { mode: 0o700 });
  assert.equal(failureOf(await cli(w, ["status"])), "not_collected");
});

// ---------------------------------------------------------------------------
// TP-1: the quota in the status
// ---------------------------------------------------------------------------

test("TP-1: status shows the Claude and Codex week and 5 hour percent with the reset time", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  recordPoints(w, 12.5, 40);
  const status = await dataOf(w, "status");
  const [claude, codex] = status.subscriptions;
  assert.equal(claude.id, "claude");
  assert.deepEqual(claude.quota, {
    five_hour: { pct: 12.5, resets_at: FIVE_RESET, at: NOW },
    seven_day: { pct: 40, resets_at: WEEK_RESET, at: NOW },
    source: "record",
    unknown: { five_hour: null, seven_day: null },
  });
  assert.equal(codex.id, "codex");
  // The 5 hour window of the rollout ended at 11:00; the week is still open.
  assert.deepEqual(codex.quota, {
    five_hour: null,
    seven_day: { pct: CODEX_WEEK_PCT, resets_at: CODEX_WEEK_RESET, at: CODEX_WEEK_AT },
    source: "rollouts",
    unknown: { five_hour: "missing", seven_day: null },
  });
});

test("Codex: the same percent seen in a later pass moves the time of the quota and the forecast, and adds no sample line", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const month = join(dataDir(w), "quota-2026-11.jsonl");
  const lines = readFileSync(month, "utf8");
  const before = (await dataOf(w, "status")).subscriptions[1];
  assert.equal(before.quota.seven_day.at, CODEX_WEEK_AT);

  // A new event of the same rollout: the same percent and reset times, 25 minutes later.
  const seenAt = Date.parse("2026-11-03T08:30:00Z");
  const usage = { input_tokens: 400, cached_input_tokens: 100, output_tokens: 70, reasoning_output_tokens: 0, total_tokens: 470 };
  const limit = (pct: number, minutes: number, resetsAt: number): object => ({ used_percent: pct, window_minutes: minutes, resets_at: resetsAt });
  const row = {
    timestamp: new Date(seenAt).toISOString(),
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { ...usage, input_tokens: 2300, total_tokens: 2600 }, last_token_usage: usage },
      rate_limits: { limit_id: "codex", primary: limit(20, 300, 1793703600), secondary: limit(CODEX_WEEK_PCT, 10080, CODEX_WEEK_RESET / 1000) },
    },
  };
  appendFileSync(codexFile(w, "a-parent"), `${JSON.stringify(row)}\n`);
  utimesSync(codexFile(w, "a-parent"), (NOW - MINUTE_MS) / 1000, (NOW - MINUTE_MS) / 1000);
  await collectOk(w);

  assert.equal(readFileSync(month, "utf8"), lines, "the month file did not grow");
  const after = (await dataOf(w, "status")).subscriptions[1];
  assert.deepEqual(after.quota.seven_day, { pct: CODEX_WEEK_PCT, resets_at: CODEX_WEEK_RESET, at: seenAt });
  // The burn is the percent over the hours since the week start, as of the time it was last seen.
  const hoursAt = (at: number): number => (at - (CODEX_WEEK_RESET - 7 * DAY_MS)) / HOUR_MS;
  assert.ok(Math.abs(before.forecast.burn_pct_per_h - CODEX_WEEK_PCT / hoursAt(CODEX_WEEK_AT)) < 1e-9);
  assert.ok(Math.abs(after.forecast.burn_pct_per_h - CODEX_WEEK_PCT / hoursAt(seenAt)) < 1e-9);
});

test("TP-1: a stale reading and an out of range reading show as unknown with a reason", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const stored = (pct: number, resetsAt: number, at: number): object => ({ usedPercent: pct, resetsAt, at });
  writeFileSync(
    join(dataDir(w), QUOTA_LATEST_FILE),
    JSON.stringify({
      version: 1,
      claude: { five_hour: stored(80, NOW - 1, NOW - 5 * HOUR_MS), week: stored(140, WEEK_RESET, NOW) },
    }),
    { mode: 0o600 },
  );
  const claude = (await dataOf(w, "status")).subscriptions[0];
  assert.deepEqual(claude.quota, {
    five_hour: null,
    seven_day: null,
    source: "none",
    unknown: { five_hour: "stale", seven_day: "out_of_range" },
  });
  assert.equal(claude.forecast, null);
});

test("TP-1: a damaged, over-size or foreign quota file shows as unknown, not as an error", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), QUOTA_LATEST_FILE);
  writeFileSync(path, "{not json", { mode: 0o600 });
  assert.equal((await dataOf(w, "status")).subscriptions[0].quota.unknown.five_hour, "bad_shape");
  writeFileSync(path, "x".repeat(8192), { mode: 0o600 });
  assert.equal((await dataOf(w, "status")).subscriptions[0].quota.unknown.five_hour, "too_large");
  writeFileSync(path, "{}", { mode: 0o644 });
  chmodSync(path, 0o644);
  assert.equal((await dataOf(w, "status")).subscriptions[0].quota.unknown.five_hour, "unsafe");
});

test("reason codes: a window that record found absent, or with a bad percent or reset time, shows with that reason", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  recordQuota(w, { five_hour: { reason: "absent" }, week: point(40, WEEK_RESET) });
  let quota = (await dataOf(w, "status")).subscriptions[0].quota;
  assert.equal(quota.five_hour, null);
  assert.equal(quota.unknown.five_hour, "absent");
  assert.equal(quota.seven_day.pct, 40);
  assert.equal(quota.source, "record");

  recordQuota(w, { five_hour: { reason: "bad_percent" }, week: { reason: "bad_reset" } }, NOW + 1000);
  quota = (await dataOf(w, "status")).subscriptions[0].quota;
  // The stored week value is still open, so it stays; the 5 hour reason is new.
  assert.equal(quota.unknown.five_hour, "bad_percent");
  assert.equal(quota.seven_day.pct, 40);
});

test("the Claude forecast is worked out again from the latest reading, with no new collect", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  // The week started 4 days ago: 96 h.
  recordPoints(w, 10, 30);
  let forecast = (await dataOf(w, "status")).subscriptions[0].forecast;
  assert.equal(forecast.basis, "latest sample");
  assert.ok(Math.abs(forecast.burn_pct_per_h - 30 / 96) < 1e-9);
  assert.ok(Math.abs(forecast.at_reset_pct - 52.5) < 1e-9);
  assert.equal(forecast.runs_out_at, null);

  recordPoints(w, 10, 60);
  forecast = (await dataOf(w, "status")).subscriptions[0].forecast;
  assert.ok(Math.abs(forecast.at_reset_pct - 105) < 1e-9);
  assert.equal(forecast.runs_out_at, NOW + 64 * HOUR_MS);
});

test("status reports a Claude week drop and updates the forecast without a new collect", async (t) => {
  const w = makeWorld(t);
  const quota = (pct: number): StatuslineQuota => ({ five_hour: { reason: "absent" }, week: point(pct, WEEK_RESET) });
  for (const [minutesAgo, pct] of [[180, 98], [120, 99], [20, 100]] as const) {
    recordQuota(w, quota(pct), NOW - minutesAgo * MINUTE_MS);
  }
  await collectOk(w);
  recordQuota(w, quota(36));

  const claude = (await dataOf(w, "status")).subscriptions[0];
  assert.deepEqual(claude.quota.seven_day, { pct: 36, resets_at: WEEK_RESET, at: NOW });
  assert.equal(claude.forecast.at, NOW);
  assert.equal(claude.forecast.at_reset_pct, 63);
  assert.equal(claude.forecast.runs_out_at, null);
});

test("the forecast of each subscription says the time of the reading that it used", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  recordPoints(w, 10, 30);
  const [claude, codex] = (await dataOf(w, "status")).subscriptions;
  assert.equal(claude.forecast.at, NOW);
  assert.equal(codex.forecast.at, CODEX_WEEK_AT);
});

test("status never scans: a source file added after collect is not counted", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const before = (await dataOf(w, "status")).subscriptions[0].tokens;
  put(claudeFile(w, "sess-late"), claudeLine({ id: "late", at: "2026-11-03T09:00:00Z", model: "claude-sonnet-5-5", input: 5000 }));
  assert.deepEqual((await dataOf(w, "status")).subscriptions[0].tokens, before);
  await collectOk(w);
  assert.equal((await dataOf(w, "status")).subscriptions[0].tokens.today.input, before.today.input + 5000);
});

// ---------------------------------------------------------------------------
// The shape of the status
// ---------------------------------------------------------------------------

test("status: the top level fields, the subscriptions and the token columns", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const run = await cli(w, ["status"]);
  assert.equal(run.code, 0);
  assert.equal(run.env.schema, SCHEMA_ID);
  const data = run.env.data;
  assert.deepEqual(Object.keys(data), ["version", "written_at", "collect", "subscriptions", "models", "tasks", "estimates", "self_check", "pool", "queue", "periods", "periods_error"]);
  assert.deepEqual(data.queue, ZERO_QUEUE, "no open item: a queue of count 0 and sums of 0");
  assert.equal(data.periods_error, null);
  assert.deepEqual(data.self_check, unscored(0), "no estimate log yet: nothing was scored, and no stage line");
  assert.equal(data.version, 1);
  assert.equal(data.written_at, NOW);
  assert.deepEqual(data.collect, { at: NOW, state: "ok", progress_pct: 100 });
  assert.deepEqual(data.subscriptions.map((s: { id: string; label: string }) => [s.id, s.label]), [
    ["claude", "Claude"],
    ["codex", "Codex"],
  ]);
  const [claude, codex] = data.subscriptions;
  assert.equal(claude.endpoint, null);
  assert.equal(claude.root, "ok");
  assert.deepEqual(Object.keys(claude), ["id", "label", "endpoint", "root", "quota", "week", "tokens", "forecast", "calibration", "account"]);
  for (const sub of [claude, codex]) {
    assert.equal(sub.account, null);
    for (const period of ["today", "week", "month"]) {
      const row = sub.tokens[period];
      assert.deepEqual(Object.keys(row), ["input", "cache_write", "cache_write_1h", "cache_read", "output", "weighted", "total", "source"]);
      assert.equal(row.source, "logs");
      assert.equal(row.total, row.input + (row.cache_write ?? 0) + (row.cache_write_1h ?? 0) + row.cache_read + row.output);
    }
  }
  assert.equal(claude.week.kind, "rolling");
  assert.deepEqual(
    { ...claude.tokens.today, weighted: Math.round(claude.tokens.today.weighted) },
    { input: 112, cache_write: 720, cache_write_1h: 600, cache_read: 350, output: 84, weighted: CLAUDE_FIXTURE_WEIGHTED, total: 1866, source: "logs" },
  );
  // Codex has no cache write columns; its input and output are counted.
  assert.equal(codex.tokens.week.cache_write, null);
  assert.equal(codex.tokens.week.cache_write_1h, null);
  assert.ok(codex.tokens.week.input > 0 && codex.tokens.week.output > 0);
  assert.deepEqual(
    data.models.map((m: { name: string; subscription: string }) => [m.subscription, m.name]).filter(([s]: string[]) => s === "claude"),
    [
      ["claude", "claude-opus-4-5"],
      ["claude", "claude-sonnet-5-5"],
    ],
  );
  assert.deepEqual(data.tasks, []);
  assert.deepEqual(data.estimates, []);
});

test("status keeps the top 8 models by week, and usage lists all of them", async (t) => {
  const w = makeWorld(t);
  const rows = Array.from({ length: 10 }, (_, i) =>
    claudeLine({ id: `m${i}`, at: `2026-11-03T08:0${i}:00Z`, model: `claude-model-${i}`, output: i + 1 }),
  );
  put(claudeFile(w, "sess-many"), rows.join(""));
  await collectOk(w);
  const status = await dataOf(w, "status");
  assert.deepEqual(
    status.models.map((m: { name: string }) => m.name),
    [9, 8, 7, 6, 5, 4, 3, 2].map((i) => `claude-model-${i}`),
  );
  const usage = await dataOf(w, "usage");
  assert.equal(usage.models.length, 10);
  assert.deepEqual(usage.subscriptions, status.subscriptions);
});

// ---------------------------------------------------------------------------
// Codex account totals on snapshot reads
// ---------------------------------------------------------------------------

const ACCOUNT_ROWS: readonly AccountRow[] = [["2026-11-01", 7], ["2026-11-02", 11], ["2026-11-03", 13]];

function accountText(rows: readonly AccountRow[] = ACCOUNT_ROWS, fetchedAt = NOW): string {
  return JSON.stringify({ version: STORE_VERSION, fetched_at: fetchedAt, attempt_at: fetchedAt, attempt: "ok", bin_key: null, rows } satisfies AccountFile);
}

function logColumns({ total, source, ...columns }: PeriodTotalJson) {
  return columns;
}

test("TP-32: snapshot queries read the account once, add its totals and preserve the snapshot and tasks", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  assert.equal((await cli(w, ["tasks", "sync"], { stdin: SYNC_BODY })).code, 0);
  await collectOk(w);
  const snapshotPath = join(dataDir(w), "status.json");
  const snapshot = readFileSync(snapshotPath, "utf8");
  const legacy = (JSON.parse(snapshot) as { data: StatusData }).data;
  const accountPath = join(dataDir(w), ACCOUNT_USAGE_FILE);
  writeFileSync(accountPath, accountText(), { mode: 0o600 });

  const open = fs.openSync;
  const spy = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => open(...args));
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });

  const accountOpens = () => spy.mock.calls.filter(({ arguments: [path] }) => path === accountPath).length;
  const tasks = (await dataOf(w, "tasks")).tasks;
  assert.equal(accountOpens(), 1, "tasks");
  assert.ok(tasks.length > 0);
  for (const command of ["status", "usage"] as const) {
    const before = accountOpens();
    const run = await cli(w, [command, "--week-start", "sun"]);
    assert.equal(run.code, 0, run.text);
    assert.equal(accountOpens() - before, 1, command);
    const { subscriptions: [, codex], periods } = run.env.data;
    assert.equal(codex.label, "Codex (account)");
    assert.deepEqual(codex.account, { at: NOW, through: "2026-11-03" });
    assert.equal(codex.tokens.today.source, "logs");
    assert.deepEqual([codex.tokens.week.source, codex.tokens.month.source], ["account", "account"]);
    assert.deepEqual([codex.tokens.week.total, codex.tokens.month.total], [31, 31]);
    assert.deepEqual(logColumns(codex.tokens.week), legacy.subscriptions[1]?.tokens.week);
    assert.deepEqual([periods.days[0].subs.codex.account, periods.weeks[0].subs.codex.account, periods.months[0].subs.codex.account], [13, 31, 31]);
    assert.deepEqual(run.env.data.tasks, tasks);
  }
  assert.equal(readFileSync(snapshotPath, "utf8"), snapshot);
});

test("proxy tokens reach Codex models and task shares, and count only once on each account date", async (t) => {
  const w = makeWorld(t);
  seedClaude(w);
  const firstUsage = '"last_token_usage":{"input_tokens":1000,"cached_input_tokens":400';
  put(codexFile(w, "a-parent"), fixtureText("codex-basic.jsonl")
    .replace(firstUsage, `${firstUsage},"cache_write_input_tokens":30`), NOW - 5 * MINUTE_MS);
  const proxy = fixtureText("claude-proxy.jsonl").replaceAll("/work/beta", "/work/proxy");
  put(claudeFile(w, "proxy"), proxy + proxy.replaceAll("2026-11-03T", "2026-11-02T"));
  recordPoints(w, 5, 10);
  const options = { io: withEnv(w, POOL_ENV) };
  const stdin = JSON.stringify({ windows: [{ label: "T-PROXY", start: "2026-11-03T07:00:00Z", match: { folders: ["/work/proxy"] }, tags: {} }], open: [] });
  assert.equal((await cli(w, ["tasks", "sync"], { ...options, stdin })).code, 0);
  await collectOk(w, options);

  const logs: StatusOutputData & { periods: PeriodsJson | null } = await dataOf(w, "status", options);
  const before = at(logs.subscriptions, 1);
  const read = readSnapshot(dataDir(w), DEPS);
  assert.ok(read.ok && read.value?.data);
  assert.deepEqual(read.value.data.codex_raw, {
    today: 2630, week: 2855, month: 2855, utc_days: { "2026-11-02": 225, "2026-11-03": 2630 },
  });
  assert.deepEqual([before.tokens.today.total, before.tokens.week.total, before.tokens.month.total], [2630, 2855, 2855]);
  assert.equal(before.tokens.today.input, 1420);
  assert.equal(before.tokens.today.cache_write, null);
  assert.equal(before.tokens.today.source, "logs");
  const claude = at(logs.subscriptions, 0);
  assert.equal(claude.tokens.month.total, SONNET_ALPHA_RAW + OPUS_BETA_RAW);
  const model = logs.models.find(({ name }) => name === "gpt-9-test");
  assert.equal(model?.subscription, "codex");
  assert.equal(model?.month.weighted, 658);
  assert.ok(before.calibration !== null);
  assert.equal(before.calibration.confidence, "rough");
  // Only the previous day's proxy tokens precede the latest quota sample's slot.
  near(before.calibration.per_pct_weighted, 329 / CODEX_WEEK_PCT, "Codex calibration includes proxy tokens");
  const task = logs.tasks.find(({ label }) => label === "T-PROXY");
  assert.ok(task !== undefined && task.pool_pct !== null);
  const share = task.shares.find(({ subscription }) => subscription === "codex");
  assert.equal(share?.raw, 65);
  assert.equal(share?.weighted, 76);

  const localMonth = logs.periods?.months.find(({ current }) => current);
  assert.ok(localMonth !== undefined);
  assert.equal(localMonth.subs.codex.account, null);
  writeFileSync(join(dataDir(w), ACCOUNT_USAGE_FILE), accountText(ACCOUNT_ROWS.slice(0, 2)), { mode: 0o600 });
  for (const command of ["status", "usage"] as const) {
    const over: StatusOutputData & { periods: PeriodsJson | null } = await dataOf(w, command, options);
    const after = at(over.subscriptions, 1);
    assert.equal(after.label, "Codex (account)");
    assert.deepEqual(after.tokens.today, before.tokens.today);
    for (const period of ["week", "month"] as const) {
      assert.equal(after.tokens[period].total, 2648, `${command}: ${period}`);
      assert.equal(after.tokens[period].source, "mixed");
      assert.deepEqual(logColumns(after.tokens[period]), logColumns(before.tokens[period]));
    }
    assert.deepEqual(after.calibration, before.calibration);
    assert.deepEqual(over.tasks, logs.tasks);
    assert.equal(Object.hasOwn(over, "codex_raw"), false);
    const month = over.periods?.months.find(({ current }) => current);
    assert.ok(month !== undefined);
    assert.equal(month.subs.codex.account, 18);
    assert.notEqual(month.subs.codex.account, after.tokens.month.total);
    assert.deepEqual(month.subs.total, localMonth.subs.total);
    assert.equal(month.subs.total.in + month.subs.total.out, SONNET_ALPHA_RAW + OPUS_BETA_RAW + 2855);
  }
  const tasks: { tasks: StatusData["tasks"] } = await dataOf(w, "tasks", options);
  assert.deepEqual(tasks, { tasks: logs.tasks });
});

test("an optional Codex raw field does not change the version 1 snapshot check", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  writeFileSync(join(dataDir(w), ACCOUNT_USAGE_FILE), accountText(), { mode: 0o600 });
  const path = join(dataDir(w), "status.json");
  const { data: { codex_raw, ...snapshotData }, ...body } = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(body.version, 1);

  for (const raw of [undefined, { ...codex_raw, utc_days: [] }]) {
    writeFileSync(path, JSON.stringify({ ...body, data: { ...snapshotData, codex_raw: raw } }));
    const read = readSnapshot(dataDir(w), DEPS);
    assert.ok(read.ok && read.value?.data);
    const { subscriptions: [, codex], ...output } = await dataOf(w, "status");
    assert.deepEqual([codex.tokens.week.source, codex.tokens.month.source, codex.label], ["logs", "logs", "Codex"]);
    assert.deepEqual(codex.account, { at: NOW, through: "2026-11-03" });
    assert.equal(Object.hasOwn(output, "codex_raw"), false);
  }
});

function mockForeignAccountOwner(t: TestContext, path: string): void {
  const account = statSync(path);
  const fstat = fs.fstatSync;
  const spy = t.mock.method(fs, "fstatSync", (fd: number) => {
    const info = fstat(fd);
    return info.dev === account.dev && info.ino === account.ino ? Object.assign(info, { uid: info.uid + 1 }) : info;
  });
  syncBuiltinESMExports();
  t.after(() => {
    spy.mock.restore();
    syncBuiltinESMExports();
  });
}

const ACCOUNT_FAULTS = ["missing", "damaged", "newer", "over cap", "linked", "loose mode", "foreign owner", "stale"] as const;

for (const fault of ACCOUNT_FAULTS) {
  test(`TP-21/40: ${fault} account data leaves status and usage on the logs`, { skip: fault === "linked" && process.platform === "win32" }, async (t) => {
    const w = makeWorld(t);
    seedFixtures(w);
    await collectOk(w);
    const path = join(dataDir(w), ACCOUNT_USAGE_FILE);
    const good = accountText();
    const mode = { mode: 0o600 };
    switch (fault) {
      case "missing": break;
      case "damaged": writeFileSync(path, "{", mode); break;
      case "newer": writeFileSync(path, JSON.stringify({ ...JSON.parse(good), version: STORE_VERSION + 1 }), mode); break;
      case "over cap": writeFileSync(path, good.padEnd(ACCOUNT_READ_CAP_BYTES + 1), mode); break;
      case "loose mode": writeFileSync(path, good); chmodSync(path, 0o644); break;
      case "stale": writeFileSync(path, accountText(ACCOUNT_ROWS, NOW - ACCOUNT_MAX_AGE_MS), mode); break;
      case "foreign owner": writeFileSync(path, good, mode); mockForeignAccountOwner(t, path); break;
      case "linked": {
        const target = w.sb.path("other-account.json");
        writeFileSync(target, good, mode);
        symlinkSync(target, path);
        break;
      }
    }

    for (const command of ["status", "usage"] as const) {
      const run = await cli(w, [command]);
      assert.equal(run.code, 0, run.text);
      assert.equal(run.env.ok, true);
      const { subscriptions: [, codex], periods } = run.env.data;
      assert.equal(codex.label, "Codex");
      assert.equal(codex.account, null);
      const week: PeriodTotalJson = codex.tokens.week;
      assert.equal(week.source, "logs");
      assert.equal(codex.tokens.month.source, "logs");
      assert.equal(week.total, week.input + (week.cache_write ?? 0) + (week.cache_write_1h ?? 0) + week.cache_read + week.output);
      assert.deepEqual([periods.days[0].subs.codex.account, periods.weeks[0].subs.codex.account, periods.months[0].subs.codex.account], [null, null, null]);
    }
  });
}

// ---------------------------------------------------------------------------
// The periods: days, weeks and months from the day rows
// ---------------------------------------------------------------------------

test("periods: the day, the week and the month of the collected rows agree with the period tokens of the subscriptions", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const run = await cli(w, ["status"], { io: { locale: "en-US" } });
  assert.equal(run.code, 0, run.text);
  const { periods, subscriptions } = run.env.data;
  assert.deepEqual(Object.keys(periods), ["week_start", "days", "weeks", "months", "cut"]);
  assert.equal(periods.week_start, "sun");
  assert.deepEqual(periods.cut, { days: 0, weeks: 0, months: 0 });
  const [day] = periods.days;
  const [week] = periods.weeks;
  const [month] = periods.months;
  assert.equal(periods.days.length, 1);
  assert.deepEqual(Object.keys(day), ["start", "start_ms", "end_ms", "full", "current", "subs", "models"]);
  assert.equal(day.start, "2026-11-03");
  assert.equal(day.start_ms, Date.parse("2026-11-03T00:00:00Z"));
  assert.equal(day.end_ms, Date.parse("2026-11-04T00:00:00Z"));
  assert.equal(day.current, true);
  assert.equal(day.full, false, "the first day with data is never full");
  const claudeToday = logColumns(subscriptions[0].tokens.today);
  assert.deepEqual(day.subs.codex.raw, logColumns(subscriptions[1].tokens.today));
  assert.deepEqual(day.subs.claude, { raw: claudeToday, in: 1782, out: 84 });
  assert.equal(day.subs.total.out, day.subs.claude.out + day.subs.codex.out);
  assert.deepEqual(Object.keys(day.models).sort(), ["claude-opus-4-5", "claude-sonnet-5-5", "gpt-5-codex", "gpt-5.1"]);
  // Nov 3 2026 is a Tuesday: the week starts on Sunday Nov 1, and the month on Nov 1.
  assert.equal(week.start, "2026-11-01");
  assert.deepEqual(week.subs.claude.raw, day.subs.claude.raw);
  assert.equal(month.start, "2026-11-01");
  assert.deepEqual(month.subs.claude.raw, logColumns(subscriptions[0].tokens.month));
  assert.deepEqual(month.subs.codex.raw, logColumns(subscriptions[1].tokens.month));
  assert.equal(month.current, true);
  assert.equal(month.full, false);
});

test("periods: collect tells the one-time backfill of the day rows in days_backfill", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  const first = await collectOk(w);
  // The Codex fixture sits in a folder of this month, so the backfill leaves it to the normal scan.
  assert.deepEqual(first.data.days_backfill, { ran: true, files: 1, rows: 0, cut: false });
  const second = await collectOk(w);
  assert.deepEqual(second.data.days_backfill, { ran: false, files: 0, rows: 0, cut: false });
});

test("periods: the week starts on the flag, else on the first weekday of the locale", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const weekOf = async (args: readonly string[], locale: string): Promise<[string, string]> => {
    const run = await cli(w, ["status", ...args], { io: { locale } });
    assert.equal(run.code, 0, run.text);
    return [run.env.data.periods.week_start, run.env.data.periods.weeks[0].start];
  };
  assert.deepEqual(await weekOf([], "en-US"), ["sun", "2026-11-01"]);
  assert.deepEqual(await weekOf([], "de-DE"), ["mon", "2026-11-02"]);
  assert.deepEqual(await weekOf(["--week-start", "fri"], "en-US"), ["fri", "2026-10-30"]);
  assert.deepEqual(await weekOf(["--week-start=sat"], "de-DE"), ["sat", "2026-10-31"]);
  const usage = await cli(w, ["usage", "--week-start", "mon"]);
  assert.equal(usage.code, 0, usage.text);
  assert.equal(usage.env.data.periods.week_start, "mon");
  assert.equal(usage.env.data.models.length, 4);
});

test("periods: a week start that is not a weekday, and the flag on another command, are usage errors", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  for (const args of [
    ["status", "--week-start", "funday"],
    ["status", "--week-start", "Mon"],
    ["usage", "--week-start", "1"],
    ["tasks", "--week-start", "sun"],
    ["doctor", "--week-start", "sun"],
    [...collectArgs(w), "--week-start", "sun"],
  ]) {
    const run = await cli(w, args);
    assert.equal(run.code, 2, args.join(" "));
    assert.equal(failureOf(run), "usage_error");
  }
});

test("periods: a status before any collect keeps its not_collected answer, also with a bad week start flag checked first", async (t) => {
  const w = makeWorld(t);
  assert.equal(failureOf(await cli(w, ["status"])), "not_collected");
  assert.equal(failureOf(await cli(w, ["status", "--week-start", "xyz"])), "usage_error");
});

test("periods: a folder with no days file gives empty lists", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  fs.unlinkSync(join(dataDir(w), "days.json"));
  const missing = await cli(w, ["status"], { io: { locale: "en-US" } });
  assert.equal(missing.code, 0, missing.text);
  assert.deepEqual(missing.env.data.periods, { week_start: "sun", days: [], weeks: [], months: [], cut: { days: 0, weeks: 0, months: 0 } });
  assert.equal(missing.env.data.periods_error, null);
});

function withoutPeriods(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== "periods" && key !== "periods_error"));
}

const DAYS_FAULTS: readonly (readonly [string, string, string])[] = [
  ["a damaged days file", "{not json", "store_corrupt"],
  ["a days file with a body of the wrong shape", JSON.stringify({ version: 1, backfilled: true, cutThrough: null, days: [] }), "store_corrupt"],
  ["a days file of a newer version", JSON.stringify({ version: 2, backfilled: true, cutThrough: null, days: {} }), "store_newer"],
  // A read counts a file over its cap as damaged.
  ["a days file over its size cap", " ".repeat(FILE_CAPS.days + 1), "store_corrupt"],
];

for (const [name, text, code] of DAYS_FAULTS) {
  test(`periods: ${name} does not fail status or usage: periods is null and periods_error is ${code}`, async (t) => {
    const w = makeWorld(t);
    seedFixtures(w);
    await collectOk(w);
    const whole = { status: await dataOf(w, "status"), usage: await dataOf(w, "usage") };
    writeFileSync(join(dataDir(w), "days.json"), text, { mode: 0o600 });

    for (const command of ["status", "usage"] as const) {
      const run = await cli(w, [command]);
      assert.equal(run.code, 0, run.text);
      assert.equal(run.env.ok, true);
      assert.equal(run.env.data.periods, null);
      assert.equal(run.env.data.periods_error, code);
      assert.deepEqual(withoutPeriods(run.env.data), withoutPeriods(whole[command]), `${command} keeps all its other fields`);
    }
  });
}

test("periods: the days follow the zone of the collect and the status", async (t) => {
  const w = makeWorld(t);
  // The row is at 16:30 UTC on Nov 2, which is 01:30 on Nov 3 in Tokyo.
  put(claudeFile(w, "sess-a"), claudeLine({ id: "z1", at: "2026-11-02T16:30:00Z", model: "claude-sonnet-5-5", input: 5, output: 6 }));
  const tokyo: Zone = { offsetMs: () => 9 * HOUR_MS };
  await collectOk(w, { io: { zone: tokyo } });
  const run = await cli(w, ["status"], { io: { zone: tokyo, locale: "en-US" } });
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.periods.days[0].start, "2026-11-03");
  assert.equal(run.env.data.periods.days[0].start_ms, Date.parse("2026-11-02T15:00:00Z"));
  assert.equal(run.env.data.periods.days[0].subs.claude.in, 5);
  // A stored day keeps the date of the zone of the collect; a read in another zone only places its midnight.
  const utc = await cli(w, ["status"], { io: { locale: "en-US" } });
  assert.equal(utc.env.data.periods.days[0].start, "2026-11-03");
  assert.equal(utc.env.data.periods.days[0].start_ms, Date.parse("2026-11-03T00:00:00Z"));
});

// Every day of the horizon with the most models, and the full account span at the token cap.
function plantWorstPeriods(w: World): void {
  const rows = new DayRows(true);
  const first = cutoffDateOf(UTC, NOW);
  for (let offset = 0; offset < DAYS_HORIZON_DAYS; offset += 1) {
    for (let model = 0; model < DAYS_MAX_MODELS; model += 1) {
      const name = `model-number-${model}`.padEnd(64, "x");
      rows.add(shiftDate(first, offset), "claude", name, [1_000_000 + model, 20_000, 3_000, 400_000_000, 5_000 + offset], 1);
      rows.add(shiftDate(first, offset), "codex", name, [2_000_000 + model, 0, 0, 300_000_000, 7_000 + offset], 1);
    }
  }
  const today = localDateOf(UTC, NOW);
  const account = Array.from({ length: ACCOUNT_KEEP_DAYS + 1 }, (_, i): AccountRow => [
    shiftDate(today, i + 1 - ACCOUNT_KEEP_DAYS), ACCOUNT_DAY_TOKENS_MAX,
  ]);
  writeFileSync(join(dataDir(w), "days.json"), JSON.stringify(rows.toJson()), { mode: 0o600 });
  writeFileSync(join(dataDir(w), ACCOUNT_USAGE_FILE), accountText(account), { mode: 0o600 });
}

for (const command of ["status", "usage"] as const) {
  test(`TP-41: ${command} of the worst store with full account usage stays under the output budget`, async (t) => {
    const w = makeWorld(t);
    seedFixtures(w);
    await collectOk(w);
    plantWorstPeriods(w);

    const run = await cli(w, [command]);

    assert.equal(run.code, 0, run.text.slice(0, 200));
    assert.ok(Buffer.byteLength(run.text) <= STATUS_OUTPUT_MAX_BYTES, `${Buffer.byteLength(run.text)} bytes`);
    assert.ok(STATUS_OUTPUT_MAX_BYTES < MIB);
    const { periods } = run.env.data;
    assert.equal(periods.days.at(-1)?.subs.codex.account, ACCOUNT_DAY_TOKENS_MAX);
    assert.equal(periods.cut.weeks, 0);
    assert.equal(periods.cut.months, 0);
    assert.ok(periods.months.length >= 13, `${periods.months.length} months`);
    assert.ok(periods.weeks.length >= 57, `${periods.weeks.length} weeks`);
    assert.ok(periods.days.length > 0 && periods.days.length < DAYS_HORIZON_DAYS, `${periods.days.length} days`);
    assert.equal(at(periods.days as { start: string }[], periods.days.length - 1).start, "2026-11-03", "the newest day stays");
  });
}

// A key of the longest size (64 characters) that is different for each index.
function longKey(index: number): string {
  return String(index).padStart(4, "0").padEnd(64, "k");
}

// A raise to this ceiling needs a reason in its PR.
// Codex account fields (total, source, account) add about 300 bytes to the worst-case fixed part.
const FIXED_OUTPUT_CEILING_BYTES = 13 * 16 * 1024 + 256;
const MIN_PERIOD_ROOM_BYTES = 60 * 1024;
const LONG_PROJECTS = Array.from({ length: 8 }, (_, i) => `alpha${i}`.padEnd(64, "a"));

function plantProjectChecks(path: string): object {
  const snapshot = JSON.parse(readFileSync(path, "utf8"));
  const check = {
    n: 5, hit_rate: 0.8123456789123456, error_factor: 2.123456789123456, bias: 1.123456789123456,
    band_low: 0.4, band_high: 1, width: 2.123456789123456, useful_rate: 0.6123456789123456,
  };
  const projects = Object.fromEntries(LONG_PROJECTS.map((project) => [project, check]));
  snapshot.data.self_check = { ...snapshot.data.self_check, n: 30, projects };
  writeFileSync(path, JSON.stringify(snapshot), { mode: 0o600 });
  return projects;
}

test("TP-64/132: 500 long project estimates keep the snapshot and output within their byte budgets", async (t) => {
  const w = makeWorld(t);
  const alpha = "alpha".padEnd(64, "a");
  const beta = "beta".padEnd(64, "b");
  const tags = Object.fromEntries(LONG_PROJECTS.slice(1).map((value, i) => [`alpha${i}`, value]));
  const open = Array.from({ length: SYNC_MAX_OPEN_ITEMS }, (_, index) => ({
    key: longKey(index), tags: { ...tags, project: index % 2 === 0 ? alpha : beta },
  }));
  await syncCostTasks(w, projectCosts(alpha, beta), open, 100);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const collected = statSync(path).size;
  const projects = plantProjectChecks(path);
  const stored = statSync(path).size;
  t.diagnostic(`status.json: ${collected} bytes collected, ${stored} bytes with project checks`);
  assert.ok(collected <= MIB && stored <= MIB, `status.json is ${stored} bytes`);
  plantWorstPeriods(w);

  let maxFixed = 0;
  for (const command of ["status", "usage"] as const) {
    const run = await cli(w, [command]);
    assert.equal(run.code, 0, run.text.slice(0, 200));
    const { periods, estimates, queue, self_check, subscriptions: [, codex] } = run.env.data;
    assert.equal(codex.tokens.month.total, 3 * ACCOUNT_DAY_TOKENS_MAX);
    assert.equal(periods.days.at(-1)?.subs.codex.account, ACCOUNT_DAY_TOKENS_MAX);
    const fixed = Buffer.byteLength(JSON.stringify({ ...run.env, data: { ...run.env.data, periods: null, periods_error: null } })) + 1;
    maxFixed = Math.max(maxFixed, fixed);
    const output = Buffer.byteLength(run.text);
    t.diagnostic(`${command}: fixed=${fixed}, output=${output}, rows=${[periods.days.length, periods.weeks.length, periods.months.length]}, cut=${JSON.stringify(periods.cut)}`);
    assert.ok(output <= STATUS_OUTPUT_MAX_BYTES, `${command}: ${output} bytes`);
    assert.ok(periods.days.length > 0 && periods.days.length < DAYS_HORIZON_DAYS);
    assert.deepEqual(periods.cut, { days: DAYS_HORIZON_DAYS - periods.days.length, weeks: 0, months: 0 });
    assert.ok(STATUS_OUTPUT_MAX_BYTES - fixed >= MIN_PERIOD_ROOM_BYTES, `${command} period room: ${STATUS_OUTPUT_MAX_BYTES - fixed} bytes`);
    assert.deepEqual(self_check.projects, projects);
    assert.deepEqual(estimates.map((row: Record<string, unknown>) => [row.key, row.basis_project]), open.map((item) => [item.key, item.tags.project]));
    assert.equal(queue.count, SYNC_MAX_OPEN_ITEMS, "the queue counts every item");
  }
  assert.ok(maxFixed <= FIXED_OUTPUT_CEILING_BYTES, `largest fixed part: ${maxFixed} bytes`);
});

// Days 2026-11-01 and 2026-11-02 beside the collected 2026-11-03.
function plantEarlierDays(w: World): void {
  const rows = loadDayRows(dataDir(w), DEPS);
  assert.ok(rows.ok);
  for (const date of ["2026-11-01", "2026-11-02"]) rows.value.add(date, "claude", "claude-sonnet-5-5", [1, 0, 0, 0, 1], 1);
  writeFileSync(join(dataDir(w), "days.json"), JSON.stringify(rows.value.toJson()), { mode: 0o600 });
}

function fullFlags(run: Run): [string, boolean][] {
  return run.env.data.periods.days.map((day: { start: string; full: boolean }) => [day.start, day.full]);
}

test("periods: a day that ended after the last collect is not full, though it ended before the status", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  plantEarlierDays(w);
  const later: FsDeps = { ...DEPS, nowMs: () => NOW + 2 * DAY_MS };

  const run = await cli(w, ["status"], { io: { deps: later } });

  assert.equal(run.code, 0, run.text);
  // The collect ended on Nov 3 at 12:00: Nov 2 was over by then, Nov 3 was not.
  assert.deepEqual(fullFlags(run), [
    ["2026-11-01", false],
    ["2026-11-02", true],
    ["2026-11-03", false],
    ["2026-11-04", false],
    ["2026-11-05", false],
  ]);
});

test("periods: no row is full while the last collect left a backlog", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  const partial = await cli(w, collectArgs(w), { io: { budget: { bytes: 1, ms: DEFAULT_BUDGET.ms } } });
  assert.equal(partial.code, 0, partial.text);
  assert.equal(partial.env.data.state, "counting");
  plantEarlierDays(w);
  const later: FsDeps = { ...DEPS, nowMs: () => NOW + 2 * DAY_MS };

  const run = await cli(w, ["status"], { io: { deps: later } });

  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.collect.state, "counting");
  assert.deepEqual(fullFlags(run).map(([, full]) => full), [false, false, false, false, false]);
});

// ---------------------------------------------------------------------------
// Empty states (TP-18)
// ---------------------------------------------------------------------------

test("empty states: no Claude samples, a missing Codex root and no calibration all answer ok", async (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-a"), fixtureText("claude-basic.jsonl"));
  const run = await cli(w, ["collect", "--claude-root", w.claude, "--codex-root", w.sb.path("no-codex")]);
  assert.equal(run.code, 0, run.text);
  const [claude, codex] = (await dataOf(w, "status")).subscriptions;
  assert.equal(claude.root, "ok");
  assert.equal(codex.root, "root_missing");
  assert.equal(claude.quota.source, "none");
  assert.deepEqual(claude.quota.unknown, { five_hour: "missing", seven_day: "missing" });
  assert.equal(claude.calibration, null);
  assert.equal(codex.calibration, null);
  assert.equal(claude.forecast, null);
});

test("empty states: both roots missing is still ok", async (t) => {
  const w = makeWorld(t);
  const run = await cli(w, ["collect", "--claude-root", w.sb.path("none-a"), "--codex-root", w.sb.path("none-b")]);
  assert.equal(run.code, 0, run.text);
  const status = await dataOf(w, "status");
  assert.deepEqual(status.subscriptions.map((s: { root: string }) => s.root), ["root_missing", "root_missing"]);
  assert.equal(status.collect.state, "ok");
});

test("the default roots come from the home folder", async (t) => {
  const w = makeWorld(t);
  put(join(w.sb.home, ".claude", "projects", "-work-proj", "sess-a.jsonl"), fixtureText("claude-basic.jsonl"));
  put(join(w.sb.home, ".codex", "sessions", "2026", "11", "03", "rollout-a.jsonl"), fixtureText("codex-basic.jsonl"));
  const run = await cli(w, ["collect"]);
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.counters.files, 2);
  assert.deepEqual(run.env.data.counters.roots, { claude: "scanned", codex: "scanned" });
});

test("a scan that stops at its budget shows counting with the progress, and a later pass finishes", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  const first = await collectOk(w, { io: { budget: { bytes: 1500, ms: 20_000 } } });
  assert.equal(first.data.state, "counting");
  assert.ok(first.data.progress_pct > 0 && first.data.progress_pct < 100, String(first.data.progress_pct));
  const counting = (await dataOf(w, "status")).collect;
  assert.deepEqual(counting, { at: NOW, state: "counting", progress_pct: first.data.progress_pct });
  for (let pass = 0; pass < 20 && (await dataOf(w, "status")).collect.state === "counting"; pass += 1) {
    await collectOk(w, { io: { budget: { bytes: 1500, ms: 20_000 } } });
  }
  assert.deepEqual((await dataOf(w, "status")).collect, { at: NOW, state: "ok", progress_pct: 100 });
});

// ---------------------------------------------------------------------------
// Calibration, tasks and estimates
// ---------------------------------------------------------------------------

test("a rough calibration shows with its confidence and the label", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  recordPoints(w, 5, 10);
  await collectOk(w);
  const calibration = (await dataOf(w, "status")).subscriptions[0].calibration;
  assert.equal(calibration.confidence, "rough");
  assert.equal(calibration.intervals, 0);
  assert.equal(calibration.label, "local use only");
  assert.ok(Math.abs(calibration.per_pct_weighted - CLAUDE_FIXTURE_WEIGHTED / 10) < 1e-6);
});

const SYNC_BODY = JSON.stringify({
  windows: [
    { label: "T-DONE", start: "2026-11-03T07:00:00Z", end: "2026-11-03T09:00:00Z", match: { folders: ["/work/alpha"] }, tags: { type: "feature" } },
    { label: "T-OPEN", start: "2026-11-03T07:30:00Z", match: { folders: ["/work/beta"] }, tags: { type: "bug" } },
  ],
  open: [
    { key: "I-1", tags: { type: "feature" } },
    { key: "I-2", tags: {} },
  ],
});

const COLLISION_BODY = JSON.stringify({
  windows: [
    { label: "T-1", start: "2026-11-03T07:00:00Z", end: "2026-11-03T09:00:00Z", match: { folders: ["/work/a-b"] }, tags: {} },
    { label: "T-2", start: "2026-11-03T07:00:00Z", match: { folders: ["/work/a/b"] }, tags: {} },
  ],
  open: [],
});
const COLLISION_WARNING =
  'tokenmeter: warning: 1 folder key comes from 2 or more different paths (windows T-1, T-2). Their rows merge. See "The folder match" in the README.\n';

test("tasks sync: a folder collision gives the collisions field, one warning line on stderr, and exit 0", async (t) => {
  const w = makeWorld(t);
  const synced = await cli(w, ["tasks", "sync"], { stdin: COLLISION_BODY });
  assert.equal(synced.code, 0, synced.text);
  assert.equal(synced.text.split("\n").length, 2, "one line of JSON on stdout");
  assert.deepEqual(synced.env.data.collisions, { keys: 1, windows: ["T-1", "T-2"] });
  assert.equal(synced.stderr, COLLISION_WARNING);
});

test("tasks sync: the bin writes the collision warning to stderr and keeps stdout one line of JSON", async (t) => {
  const w = makeWorld(t);
  const run = await runBin(["tasks", "sync"], w.sb.env, COLLISION_BODY);
  assert.equal(run.code, 0, run.stdout);
  assert.equal(run.stderr, COLLISION_WARNING);
  assert.equal(run.stdout.split("\n").length, 2, "one line of JSON on stdout");
  const env = JSON.parse(run.stdout) as Envelope;
  assert.deepEqual(env.data.collisions, { keys: 1, windows: ["T-1", "T-2"] });
  const clean = await runBin(["tasks", "sync"], w.sb.env, SYNC_BODY);
  assert.equal(envelopeOf(clean).data.collisions.keys, 0);
});

test("tasks: sync, then collect, then status shows the open and the finished task with shares", async (t) => {
  const w = makeWorld(t);
  seedClaude(w);
  recordPoints(w, 5, 10);
  const synced = await cli(w, ["tasks", "sync"], { stdin: SYNC_BODY });
  assert.equal(synced.code, 0, synced.text);
  assert.deepEqual(synced.env.data, { windows: 2, open: 2, refused: { windows: 0, open: 0, features: 0 }, expired: 0, collisions: { keys: 0, windows: [] } });
  assert.equal(synced.stderr, "", "no warning without a collision");
  const done = await collectOk(w);
  assert.equal(done.data.counters.tasks_frozen, 1);

  const status = await dataOf(w, "status");
  const perPct = CLAUDE_FIXTURE_WEIGHTED / 10;
  assert.deepEqual(status.tasks.map((task: { label: string; open: boolean }) => [task.label, task.open]), [
    ["T-OPEN", true],
    ["T-DONE", false],
  ]);
  const [open, finished] = status.tasks;
  assert.equal(open.end, null);
  assert.equal(open.start, Date.parse("2026-11-03T07:30:00Z"));
  assert.deepEqual(open.tags, { type: "bug" });
  assert.equal(open.shared, false);
  assert.equal(open.shares.length, 1);
  assert.equal(open.shares[0].subscription, "claude");
  assert.ok(Math.abs(open.shares[0].weighted - OPUS_BETA_WEIGHTED) < 1e-6);
  assert.ok(Math.abs(open.shares[0].pct - OPUS_BETA_WEIGHTED / perPct) < 1e-6);
  assert.equal(finished.end, Date.parse("2026-11-03T09:00:00Z"));
  assert.ok(Math.abs(finished.shares[0].pct - SONNET_ALPHA_WEIGHTED / perPct) < 1e-6);
  // Under 3 finished tasks there is no basis for an estimate.
  assert.deepEqual(status.estimates, [
    { key: "I-1", subscription: "claude", basis: "none", basis_name: "none" },
    { key: "I-2", subscription: "claude", basis: "none", basis_name: "none" },
  ]);
  assert.deepEqual((await dataOf(w, "tasks")).tasks, status.tasks);
});

test("tasks: without a calibration a share has no percent", async (t) => {
  const w = makeWorld(t);
  seedClaude(w);
  await cli(w, ["tasks", "sync"], { stdin: SYNC_BODY });
  await collectOk(w);
  const tasks = (await dataOf(w, "tasks")).tasks;
  assert.equal(tasks.length, 2);
  for (const task of tasks) {
    assert.equal(task.shares[0].pct, null);
    assert.ok(task.shares[0].weighted > 0);
  }
});

// --- the shares of a task inside the periods, and the pool ---

const POOL_ENV = { TOKENMETER_POOL: "combined", TOKENMETER_POOL_WEIGHTS: "claude=0.5,codex=1" };

function withEnv(w: World, extra: Readonly<Record<string, string>>): Partial<CliIo> {
  return { env: { ...w.sb.env, ...extra } };
}

async function collectedTasks(t: TestContext): Promise<World> {
  const w = makeWorld(t);
  seedClaude(w);
  recordPoints(w, 5, 10);
  const synced = await cli(w, ["tasks", "sync"], { stdin: SYNC_BODY });
  assert.equal(synced.code, 0, synced.text);
  await collectOk(w);
  return w;
}

test("tasks: a share has its tokens inside today, the week and the month, and its part of the seven day percent", async (t) => {
  const w = await collectedTasks(t);
  const [open, finished] = (await dataOf(w, "status")).tasks;
  assert.deepEqual(Object.keys(open.shares[0]), [
    "subscription",
    "weighted",
    "raw",
    "pct",
    "today_weighted",
    "week_weighted",
    "month_weighted",
    "week_pct",
  ]);
  assert.equal(open.shares[0].raw, OPUS_BETA_RAW);
  assert.equal(finished.shares[0].raw, SONNET_ALPHA_RAW);
  for (const field of ["today_weighted", "week_weighted", "month_weighted"]) {
    assert.ok(Math.abs(open.shares[0][field] - OPUS_BETA_WEIGHTED) < 1e-6, field);
    assert.ok(Math.abs(finished.shares[0][field] - SONNET_ALPHA_WEIGHTED) < 1e-6, `finished ${field}`);
  }
  // The seven day percent is 10 and the week holds both fixture rows.
  assert.ok(Math.abs(open.shares[0].week_pct - (OPUS_BETA_WEIGHTED / CLAUDE_FIXTURE_WEIGHTED) * 10) < 1e-6);
  assert.ok(Math.abs(finished.shares[0].week_pct - (SONNET_ALPHA_WEIGHTED / CLAUDE_FIXTURE_WEIGHTED) * 10) < 1e-6);
  assert.ok(open.shares[0].week_pct + finished.shares[0].week_pct <= 10 + 1e-9);
  assert.equal(open.pool_pct, null);
});

test("tasks: a finished task with no open window still has its tokens inside the periods", async (t) => {
  const w = makeWorld(t);
  seedClaude(w);
  recordPoints(w, 5, 10);
  const body = JSON.stringify({ windows: [JSON.parse(SYNC_BODY).windows[0]], open: [] });
  assert.equal((await cli(w, ["tasks", "sync"], { stdin: body })).code, 0);
  await collectOk(w);
  const [finished] = (await dataOf(w, "status")).tasks;
  assert.equal(finished.open, false);
  assert.ok(Math.abs(finished.shares[0].week_weighted - SONNET_ALPHA_WEIGHTED) < 1e-6);
  assert.ok(Math.abs(finished.shares[0].today_weighted - SONNET_ALPHA_WEIGHTED) < 1e-6);
});

test("tasks: rows from today, from earlier in the week and from last month give a share three different period totals", async (t) => {
  const w = makeWorld(t);
  // NOW is 2026-11-03T12:00Z. The Claude week is 10-30T12:00 to 11-06T12:00 and the month starts on 11-01.
  // So the last row is inside the week, but outside the month.
  put(
    claudeFile(w, "sess-periods"),
    [
      claudeLine({ id: "today", at: "2026-11-03T08:00:00Z", model: "claude-sonnet-5-5", input: 1000 }),
      claudeLine({ id: "yesterday", at: "2026-11-02T10:00:00Z", model: "claude-sonnet-5-5", input: 200 }),
      claudeLine({ id: "last-month", at: "2026-10-31T10:00:00Z", model: "claude-sonnet-5-5", input: 30 }),
    ].join(""),
  );
  recordPoints(w, 5, 10);
  const window = { label: "T-ALL", start: "2026-10-30T13:00:00Z", end: "2026-11-03T09:00:00Z", match: { folders: ["/work/alpha"] }, tags: {} };
  const synced = await cli(w, ["tasks", "sync"], { stdin: JSON.stringify({ windows: [window], open: [] }) });
  assert.equal(synced.code, 0, synced.text);
  await collectOk(w);

  const status = await dataOf(w, "status");
  const { today, week, month } = status.subscriptions[0].tokens;
  const expected = [today.weighted, week.weighted, month.weighted];
  assert.equal(new Set(expected).size, 3, "the three periods hold different totals");
  const [finished] = status.tasks;
  assert.equal(finished.open, false);
  const share = finished.shares[0];
  // The task holds every row, so each period of the share is the period of the subscription.
  assert.deepEqual([share.today_weighted, share.week_weighted, share.month_weighted], expected);
  assert.equal(share.week_weighted, share.weighted);
  assert.deepEqual((await dataOf(w, "tasks")).tasks, status.tasks);
});

test("tasks: the week percent follows the latest Claude reading, with no new collect, and tasks agrees with status", async (t) => {
  const w = await collectedTasks(t);
  recordPoints(w, 5, 20);
  const status = await dataOf(w, "status");
  assert.ok(Math.abs(status.tasks[0].shares[0].week_pct - (OPUS_BETA_WEIGHTED / CLAUDE_FIXTURE_WEIGHTED) * 20) < 1e-6);
  assert.deepEqual((await dataOf(w, "tasks")).tasks, status.tasks);
});

test("tasks: a Claude reading of the next week gives no week percent until a collect reads that week", async (t) => {
  const w = await collectedTasks(t);
  // The week of the snapshot has ended. The new reading is of the next week, with other tokens.
  const later = WEEK_RESET + HOUR_MS;
  const io = { deps: { ...DEPS, nowMs: () => later } };
  recordQuota(w, { five_hour: point(5, later + 2 * HOUR_MS), week: point(20, WEEK_RESET + 7 * DAY_MS) }, later);
  const status = await cli(w, ["status"], { io });
  assert.equal(status.code, 0, status.text);
  assert.equal(status.env.data.subscriptions[0].quota.seven_day.pct, 20);
  for (const task of status.env.data.tasks) assert.equal(task.shares[0].week_pct, null);
  assert.deepEqual((await cli(w, ["tasks"], { io })).env.data.tasks, status.env.data.tasks);
});

test("pool: a Codex seven day percent of a week that has ended does not count in used_pct", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  recordPoints(w, 5, 10);
  await collectOk(w);
  const later = CODEX_WEEK_RESET + HOUR_MS;
  recordQuota(w, { five_hour: point(5, later + 2 * HOUR_MS), week: point(10, later + 3 * DAY_MS) }, later);
  const run = await cli(w, ["status"], { io: { ...withEnv(w, POOL_ENV), deps: { ...DEPS, nowMs: () => later } } });
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data.pool, { mode: "combined", weights: { claude: 0.5, codex: 1 }, used_pct: null });
});

test("tasks: a finished task whose window a later sync left out has no period tokens and no week percent", async (t) => {
  const w = makeWorld(t);
  seedClaude(w);
  // A task that ended before the month began, with its own tokens.
  put(claudeFile(w, "sess-old"), claudeLine({ id: "old", at: "2026-10-26T10:00:00Z", model: "claude-sonnet-5-5", input: 1000 }));
  recordPoints(w, 5, 10);
  const { windows } = JSON.parse(SYNC_BODY);
  const old = { label: "T-OLD", start: "2026-10-26T09:00:00Z", end: "2026-10-26T11:00:00Z", match: { folders: ["/work/alpha"] }, tags: {} };
  const first = await cli(w, ["tasks", "sync"], { stdin: JSON.stringify({ windows: [windows[0], old], open: [] }) });
  assert.equal(first.code, 0, first.text);
  await collectOk(w);
  const kept = (await dataOf(w, "status")).tasks;
  assert.deepEqual(kept.map((task: { label: string }) => task.label), ["T-DONE", "T-OLD"]);
  assert.ok(kept[0].shares[0].week_pct > 0, "the window is known: the task has its part of the week");

  // The next sync leaves both finished windows out. The history keeps their totals only.
  const second = await cli(w, ["tasks", "sync"], { stdin: JSON.stringify({ windows: [], open: [] }) });
  assert.equal(second.code, 0, second.text);
  await collectOk(w);
  const gone = (await dataOf(w, "status")).tasks;
  assert.deepEqual(gone.map((task: { label: string }) => task.label), ["T-DONE", "T-OLD"]);
  // T-DONE ended today: its tokens inside the periods are not known any more, and 0 would be false.
  const [done, oldest] = gone.map((task: { shares: Array<Record<string, unknown>> }) => task.shares[0]);
  assert.deepEqual([done.today_weighted, done.week_weighted, done.month_weighted, done.week_pct], [null, null, null, null]);
  assert.equal(done.weighted, kept[0].shares[0].weighted);
  assert.equal(done.pct, kept[0].shares[0].pct);
  // T-OLD ended before today, the week and the month: its tokens inside them are 0 whatever the window.
  assert.deepEqual([oldest.today_weighted, oldest.week_weighted, oldest.month_weighted, oldest.week_pct], [0, 0, 0, 0]);
  assert.deepEqual((await dataOf(w, "tasks")).tasks, gone);
});

test("tasks: a snapshot from an older build has no period tokens, and status still answers", async (t) => {
  const w = await collectedTasks(t);
  const path = join(dataDir(w), "status.json");
  const body = JSON.parse(readFileSync(path, "utf8"));
  delete body.data.pool;
  for (const task of body.data.tasks) {
    delete task.pool_pct;
    for (const share of task.shares) for (const field of ["raw", "today_weighted", "week_weighted", "month_weighted", "week_pct"]) delete share[field];
  }
  writeFileSync(path, JSON.stringify(body));
  const status = await dataOf(w, "status");
  assert.deepEqual(status.pool, { mode: "separate" });
  const share = status.tasks[0].shares[0];
  assert.deepEqual([share.raw, share.today_weighted, share.week_weighted, share.month_weighted, share.week_pct], [0, 0, 0, 0, null]);
});

// --- estimates from tasks of different costs ---

interface CostTask {
  readonly label: string;
  // The input tokens of its one Claude row. The row has one output token as
  // well, so the weighted tokens of the task are cost + ROW_OUTPUT_WEIGHTED.
  readonly cost: number;
  readonly tags?: Readonly<Record<string, string>>;
  readonly features?: Readonly<Record<string, number>>;
  // A running task has an open window.
  readonly running?: boolean;
  // When the window ends, if not at 09:00. A window that ended less than the
  // freeze delay before NOW is not frozen by the collect.
  readonly endAt?: string;
}

const ROW_OUTPUT_WEIGHTED = 5;

function weightedOf(task: CostTask): number {
  return task.cost + ROW_OUTPUT_WEIGHTED;
}

// One Claude row and one window for each task, each in its own folder, so the
// tasks share no tokens. Returns the windows to sync.
function seedCostTasks(w: World, tasks: readonly CostTask[]): object[] {
  const rows = tasks.map((task, index) =>
    claudeLine({ id: `cost${index}`, at: "2026-11-03T08:00:00Z", model: "claude-sonnet-5-5", cwd: `/work/c${index}`, input: task.cost }),
  );
  put(claudeFile(w, "sess-costs"), rows.join(""));
  return tasks.map((task, index) => ({
    label: task.label,
    start: "2026-11-03T07:00:00Z",
    ...(task.running === true ? {} : { end: task.endAt ?? "2026-11-03T09:00:00Z" }),
    match: { folders: [`/work/c${index}`] },
    tags: task.tags ?? {},
    features: task.features ?? {},
  }));
}

// Seeds the rows and the quota, then syncs the windows and the open items.
async function syncCostTasks(w: World, tasks: readonly CostTask[], open: readonly object[], weekPct = 10): Promise<void> {
  const windows = seedCostTasks(w, tasks);
  recordPoints(w, 5, weekPct);
  const stdin = JSON.stringify({ windows, open });
  assert.ok(Buffer.byteLength(stdin) <= SYNC_MAX_BYTES);
  const synced = await cli(w, ["tasks", "sync"], { stdin });
  assert.equal(synced.code, 0, synced.text);
  assert.equal(synced.env.data.windows, tasks.length);
}

const THREE_COSTS: readonly CostTask[] = [1000, 2000, 4000].map((cost, index): CostTask => ({ label: `T${index + 1}`, cost }));

function projectCosts(alpha: string, beta: string): readonly CostTask[] {
  return [alpha, beta].flatMap((project, group) => Array.from({ length: 9 }, (_, index) => ({
    label: `T${group}-${index}`, cost: (1_000 + 10 * index) * (group === 0 ? 1 : 100), tags: { project },
  })));
}

test("TP-116/118/123: status and estimate show the project basis, and an unchanged collect does not log it again", async (t) => {
  const w = makeWorld(t);
  const items = [{ key: "A", tags: { project: "alpha" } }, { key: "B", tags: { repo: "beta" } }, { key: "C", tags: {} }];
  await syncCostTasks(w, projectCosts("alpha", "beta"), items, 100);
  await collectOk(w);

  const status = await dataOf(w, "status");
  const estimate = await cli(w, ["estimate"], { stdin: JSON.stringify({ items }) });
  assert.equal(estimate.code, 0, estimate.text);
  assert.deepEqual(estimate.env.data.estimates, status.estimates);
  assert.deepEqual(
    status.estimates.map((row: Record<string, unknown>) => [row.key, row.basis, row.basis_name, Object.entries(row).at(-1)]),
    items.map(({ key }, i) => [key, "wide", "all", ["basis_project", ["alpha", "beta", null][i]]]),
  );
  const lines = storedLines(w);
  assert.deepEqual(lines.map((line) => line["basis_project"]), ["alpha", "beta", null]);
  await collectOk(w);
  assert.deepEqual(storedLines(w), lines);
});

function near(actual: number, expected: number, message: string): void {
  assert.ok(Math.abs(actual - expected) < 1e-6, `${message}: ${actual} is not near ${expected}`);
}

async function perPctOf(w: World): Promise<number> {
  return (await dataOf(w, "status")).subscriptions[0].calibration.per_pct_weighted;
}

test("tasks: an estimate from an older snapshot has no raw range and no basis name, and status shows them as null", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, [{ key: "A", tags: { type: "bug" } }, { key: "B", tags: { type: "doc" } }]);
  await collectOk(w);
  const current = (await dataOf(w, "status")).estimates;
  assert.deepEqual(current.map((e: { basis: string; basis_name: string }) => [e.basis, e.basis_name]), [["wide", "all"], ["wide", "all"]]);
  assert.ok(current.every((row: Record<string, unknown>) => row.basis_project === null && !Object.hasOwn(row, "folder")));
  assert.ok(current[0].raw_low > 0 && current[0].raw_high >= current[0].raw_low);

  const path = join(dataDir(w), "status.json");
  const body = JSON.parse(readFileSync(path, "utf8"));
  for (const item of body.data.estimates) {
    delete item.raw_low;
    delete item.raw_high;
    delete item.basis_name;
  }
  writeFileSync(path, JSON.stringify(body));
  const older = (await dataOf(w, "status")).estimates;
  for (const [index, item] of older.entries()) {
    assert.deepEqual([item.raw_low, item.raw_high, item.basis_name], [null, null, null], item.key);
    assert.deepEqual(Object.keys(item), Object.keys(current[index]), item.key);
    assert.equal(item.basis, current[index].basis, item.key);
    assert.equal(item.low_pct, current[index].low_pct, item.key);
    assert.equal(item.count, current[index].count, item.key);
  }
});

// --- the compatibility pin: what a reader of the status written before the estimator change still finds ---

// The keys of the status before the change, in order. The change adds keys and moves none.
const OLD_TOP_KEYS = ["version", "written_at", "collect", "subscriptions", "models", "tasks", "estimates", "self_check", "pool", "periods", "periods_error"];
const OLD_ESTIMATE_KEYS = ["key", "subscription", "basis", "basis_name", "low_pct", "high_pct", "raw_low", "raw_high", "count"];
const OLD_SELF_CHECK_KEYS = ["n", "hit_rate", "error_factor", "bias", "band_low", "band_high", "stages"];
const NEW_SELF_CHECK_KEYS = ["width", "useful_rate", "projects"];
const QUEUE_KEYS = ["count", "expected_pct", "low_pct", "high_pct", "likely_low_pct", "likely_high_pct", "spent_pct"];

test("TP-60: three finished tasks and two open items: each row keeps its old keys and values in order, then gets typical_pct and budget_pct", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await collectOk(w);
  const perPct = await perPctOf(w);
  const { estimates } = await dataOf(w, "status");

  // The three costs are 1005, 2005 and 4005 weighted tokens (the cost plus 5 for the output token). The percentile
  // is linear at the place p * (n - 1), here 2p. P10 is at 0.2: 1005 + 0.2 * 1000 = 1205. P90 is at 1.8: 2005 + 0.8 * 2000
  // = 3605. P50 is at 1: 2005. P80 is at 1.6: 2005 + 0.6 * 2000 = 3205.
  assert.deepEqual(estimates.map((row: { key: string }) => row.key), ["A", "B"]);
  for (const row of estimates) {
    assert.deepEqual(Object.keys(row), [...OLD_ESTIMATE_KEYS, "typical_pct", "budget_pct", "basis_project"], row.key);
    assert.deepEqual([row.subscription, row.basis, row.basis_name, row.count], ["claude", "wide", "all", 3], row.key);
    near(row.low_pct, 1205 / perPct, `${row.key} low`);
    near(row.high_pct, 3605 / perPct, `${row.key} high`);
    assert.ok(row.raw_high >= row.raw_low && row.raw_low > 0, `${row.key} raw`);
    near(row.typical_pct, 2005 / perPct, `${row.key} typical`);
    near(row.budget_pct, 3205 / perPct, `${row.key} budget`);
  }
});

test("TP-61: the top level and the self_check keep the keys of the earlier status in order, and the new keys are only added", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await collectOk(w);
  const perPct = await perPctOf(w);
  const data = await dataOf(w, "status");

  const top = Object.keys(data);
  assert.deepEqual(top.filter((key) => key !== "queue"), OLD_TOP_KEYS);
  assert.equal(top.indexOf("queue"), top.indexOf("pool") + 1, "queue comes right after pool");
  assert.deepEqual([data.version, data.written_at, data.collect, data.pool, data.periods_error], [1, NOW, { at: NOW, state: "ok", progress_pct: 100 }, { mode: "separate" }, null]);

  const checkKeys = Object.keys(data.self_check);
  assert.deepEqual(checkKeys.filter((key) => !NEW_SELF_CHECK_KEYS.includes(key)), OLD_SELF_CHECK_KEYS);
  assert.deepEqual(checkKeys, ["n", "hit_rate", "error_factor", "bias", "band_low", "band_high", "width", "useful_rate", "stages", "projects"]);
  assert.deepEqual(data.self_check, unscored(0), "no task was scored yet: the old numbers and the two new ones are null, the stages are empty");

  // Two items with no cost so far, each one drawn from the three costs: the mean of the pool is 7015 / 3, and the
  // items sum to 14030 / 3. No item has a cost so far.
  const { queue } = data;
  assert.deepEqual(Object.keys(queue), QUEUE_KEYS);
  assert.equal(queue.count, 2);
  near(queue.expected_pct, 14030 / 3 / perPct, "expected_pct");
  near(queue.spent_pct, 0, "spent_pct");
  assert.ok(queue.low_pct >= (2 * 1005) / perPct - 1e-9 && queue.high_pct <= (2 * 4005) / perPct + 1e-9, "the range lies between two cheapest and two dearest");

  // The file on disk holds the same order.
  const stored = JSON.parse(readFileSync(join(dataDir(w), "status.json"), "utf8")) as { data: { queue: object; self_check: object } };
  assert.deepEqual(Object.keys(stored.data.queue), QUEUE_KEYS);
  assert.deepEqual(Object.keys(stored.data.self_check), Object.keys(data.self_check));
});

test("TP-62: an older snapshot with every new key deleted reads queue null and null new numbers, keeps its stages, and every command exits 0", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { data: { estimates: Record<string, unknown>[]; self_check: unknown; queue?: unknown } };
  const stage = { n: 5, hit_rate: 0.5, error_factor: 2, bias: 1.5, band_low: 0.4, band_high: 1 };
  const older = structuredClone(saved);
  delete older.data.queue;
  for (const row of older.data.estimates) {
    delete row["typical_pct"];
    delete row["budget_pct"];
  }
  older.data.self_check = { ...stage, stages: { plan: stage } };
  writeFileSync(path, JSON.stringify(older), { mode: 0o600 });

  for (const command of ["status", "usage", "tasks", "doctor", "estimate"]) {
    const run = await cli(w, [command], { stdin: JSON.stringify({ items: [] }) });
    assert.equal(run.code, 0, `${command}: ${run.text}`);
  }
  const read = await dataOf(w, "status");
  assert.equal(read.queue, null);
  assert.equal(Object.keys(read).indexOf("queue"), Object.keys(read).indexOf("pool") + 1, "the queue key is there, after pool");
  for (const [index, row] of read.estimates.entries()) {
    assert.deepEqual([row.typical_pct, row.budget_pct], [null, null], row.key);
    for (const key of OLD_ESTIMATE_KEYS) assert.deepEqual(row[key], saved.data.estimates[index]?.[key], `${row.key} ${key}`);
  }
  assert.deepEqual(read.self_check, { ...stage, width: null, useful_rate: null, stages: { plan: { ...stage, width: null, useful_rate: null } }, projects: null });
  assert.deepEqual(Object.keys(read.self_check), ["n", "hit_rate", "error_factor", "bias", "band_low", "band_high", "width", "useful_rate", "stages", "projects"]);
});

test("TP-19: a snapshot with the new estimate fields and one without them both read, with no store corrupt flag", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, [{ key: "A", tags: {} }, { key: "B", tags: {} }]);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const readsAll = async (): Promise<void> => {
    for (const command of ["status", "usage", "tasks", "doctor", "estimate"]) {
      const run = await cli(w, [command], { stdin: JSON.stringify({ items: [] }) });
      assert.equal(run.code, 0, `${command}: ${run.text}`);
    }
  };
  await readsAll();
  assert.deepEqual((await dataOf(w, "status")).estimates.map((e: { basis_name: string }) => e.basis_name), ["all", "all"]);

  const without = structuredClone(saved);
  for (const item of without.data.estimates) delete item.basis_name;
  writeFileSync(path, JSON.stringify(without), { mode: 0o600 });
  await readsAll();
  assert.deepEqual((await dataOf(w, "status")).estimates.map((e: { basis_name: null }) => e.basis_name), [null, null]);

  const odd = structuredClone(saved);
  for (const item of odd.data.estimates) item.basis_name = 7;
  writeFileSync(path, JSON.stringify(odd), { mode: 0o600 });
  await readsAll();
  assert.deepEqual((await dataOf(w, "status")).estimates.map((e: { basis_name: null }) => e.basis_name), [null, null]);
});

test("pool: the default is separate, and every task has pool_pct null", async (t) => {
  const w = await collectedTasks(t);
  const status = await dataOf(w, "status");
  assert.deepEqual(status.pool, { mode: "separate" });
  for (const task of status.tasks) assert.equal(task.pool_pct, null);
});

test("pool: combined with weights gives the weighted sum of the week percents of each task", async (t) => {
  const w = await collectedTasks(t);
  const run = await cli(w, ["status"], { io: withEnv(w, POOL_ENV) });
  assert.equal(run.code, 0, run.text);
  const { pool, tasks } = run.env.data;
  // The Codex percent is unknown in this folder, so the sum is unknown.
  assert.deepEqual(pool, { mode: "combined", weights: { claude: 0.5, codex: 1 }, used_pct: null });
  // A null would count as 0 in the arithmetic, so the known values are compared directly.
  const weekPct = (OPUS_BETA_WEIGHTED / CLAUDE_FIXTURE_WEIGHTED) * 10;
  assert.equal(typeof tasks[0].shares[0].week_pct, "number");
  assert.equal(typeof tasks[0].pool_pct, "number");
  assert.ok(Math.abs(tasks[0].shares[0].week_pct - weekPct) < 1e-9);
  assert.ok(Math.abs(tasks[0].pool_pct - 0.5 * weekPct) < 1e-9);
  assert.deepEqual((await cli(w, ["tasks"], { io: withEnv(w, POOL_ENV) })).env.data.tasks, tasks);
});

test("pool: used_pct is the weighted sum of the two seven day percents", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  recordPoints(w, 5, 10);
  await collectOk(w);
  const { pool } = (await cli(w, ["status"], { io: withEnv(w, POOL_ENV) })).env.data;
  assert.equal(pool.mode, "combined");
  assert.ok(Math.abs(pool.used_pct - (0.5 * 10 + 1 * CODEX_WEEK_PCT)) < 1e-9);
});

test("pool: combined with missing or bad weights falls back to separate, and the doctor says why", async (t) => {
  const w = await collectedTasks(t);
  const cases: ReadonlyArray<readonly [Record<string, string>, string | null]> = [
    [{}, null],
    [{ TOKENMETER_POOL: "combined" }, "pool_weights_missing"],
    [{ TOKENMETER_POOL: "combined", TOKENMETER_POOL_WEIGHTS: "claude=2,codex=1" }, "pool_weights_bad"],
    [{ TOKENMETER_POOL: "joint" }, "pool_mode_bad"],
  ];
  for (const [extra, reason] of cases) {
    const status = await cli(w, ["status"], { io: withEnv(w, extra) });
    assert.deepEqual(status.env.data.pool, { mode: "separate" }, JSON.stringify(extra));
    const doctor = await cli(w, ["doctor"], { io: withEnv(w, extra) });
    assert.deepEqual(doctor.env.data.pool, { mode: "separate", reason }, JSON.stringify(extra));
  }
  const combined = await cli(w, ["doctor"], { io: withEnv(w, POOL_ENV) });
  assert.deepEqual(combined.env.data.pool, { mode: "combined", reason: null });
});

test("estimate: three finished tasks of different costs give a wide range over all; bad items are refused and counted", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, []);
  await collectOk(w);
  const perPct = await perPctOf(w);

  const items = [
    { key: "A", tags: { type: "bug" } },
    { key: "B", tags: { type: "doc" } },
    { key: "C", tags: {} },
    { key: "bad key!", tags: {} },
  ];
  const run = await cli(w, ["estimate"], { stdin: JSON.stringify({ items }) });
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.refused, 1);
  assert.equal(run.env.data.refused_features, 0);
  assert.equal(run.env.data.estimates.length, 3);
  // No task has a type or a feature, so every item reads the 10th to 90th
  // percentile of the three costs, 1005, 2005 and 4005 weighted tokens.
  const [low, high] = [1005 + 0.2 * 1000, 2005 + 0.8 * 2000];
  for (const estimate of run.env.data.estimates) {
    assert.deepEqual([estimate.subscription, estimate.basis, estimate.basis_name, estimate.count], ["claude", "wide", "all", 3], estimate.key);
    near(estimate.low_pct, low / perPct, estimate.key);
    near(estimate.high_pct, high / perPct, estimate.key);
    assert.ok(estimate.raw_low > 0 && estimate.raw_high > estimate.raw_low, estimate.key);
    // The median and the 80th percentile of the three costs.
    near(estimate.typical_pct, 2005 / perPct, `${estimate.key} typical`);
    near(estimate.budget_pct, 3205 / perPct, `${estimate.key} budget`);
    assert.deepEqual(
      Object.keys(estimate),
      ["key", "subscription", "basis", "basis_name", "low_pct", "high_pct", "raw_low", "raw_high", "count", "typical_pct", "budget_pct", "basis_project"],
      estimate.key,
    );
  }

  const codex = await cli(w, ["estimate"], { stdin: JSON.stringify({ subscription: "codex", items: [{ key: "A", tags: {} }] }) });
  assert.deepEqual(codex.env.data.estimates, [{ key: "A", subscription: "codex", basis: "none", basis_name: "none" }]);
});

test("estimate: a week size in the snapshot that is past the double range gives no basis to every row, and the command exits 0", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, []);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const body = JSON.parse(readFileSync(path, "utf8"));
  for (const subscription of body.data.subscriptions) {
    if (subscription.calibration !== null) subscription.calibration.per_pct_weighted = 0.123456789;
  }
  // JSON.stringify cannot write a number past the double range, so the number is written as text.
  const text = JSON.stringify(body).replaceAll("0.123456789", "1e400");
  assert.ok(text.includes('"per_pct_weighted":1e400'), "the fixture holds the number");
  writeFileSync(path, text, { mode: 0o600 });

  const items = [
    { key: "A", tags: { type: "bug" } },
    { key: "B", tags: {} },
  ];
  const run = await cli(w, ["estimate"], { stdin: JSON.stringify({ items }) });
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data.estimates, [
    { key: "A", subscription: "claude", basis: "none", basis_name: "none" },
    { key: "B", subscription: "claude", basis: "none", basis_name: "none" },
  ]);
});

test("TP-52: estimate never shows the basis name spent, even for an item that carries a cost so far", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, []);
  await collectOk(w);
  const items = [
    { key: "A", tags: {} },
    { key: "B", tags: { stage: "plan" }, spent: 1e12 },
  ];
  const run = await cli(w, ["estimate"], { stdin: JSON.stringify({ items }) });
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data.estimates.map((estimate: { basis_name: string }) => estimate.basis_name), ["all", "all"]);
  assert.ok(!run.text.includes("spent"), "the output does not hold the word spent");
});

test("AC-11: the estimate names the feature that its range rests on, and an item without it falls back to all", async (t) => {
  const w = makeWorld(t);
  // Cost grows with the size, with a small change from task to task. The sizes grow
  // slowly, so even the smallest task stays well over the floor of the fits (0.1
  // percent of the week, which is about 1 percent of the cost of all nine tasks).
  const tasks = Array.from({ length: 9 }, (_, index): CostTask => {
    const size = 100 * (index + 1);
    return { label: `S${index}`, cost: Math.round(10 * size * (1 + 0.02 * (index % 3))), features: { size } };
  });
  await syncCostTasks(w, tasks, []);
  await collectOk(w);
  const floor = 0.1 * (await perPctOf(w));
  assert.ok(weightedOf(tasks[0] as CostTask) >= 2 * floor, `the smallest task ${weightedOf(tasks[0] as CostTask)} is under twice the floor ${floor}`);
  const items = [
    { key: "WITH", tags: {}, features: { size: 600 } },
    { key: "WITHOUT", tags: {} },
  ];
  const run = await cli(w, ["estimate"], { stdin: JSON.stringify({ items }) });
  assert.equal(run.code, 0, run.text);
  const [withSize, without] = run.env.data.estimates;
  assert.deepEqual([withSize.basis, withSize.basis_name, withSize.count], ["similar", "size", 9]);
  assert.deepEqual([without.basis, without.basis_name, without.count], ["wide", "all", 9]);
  assert.ok(withSize.high_pct / withSize.low_pct < without.high_pct / without.low_pct, "the feature range is the tighter one");
});

test("estimate: a bad feature is refused alone and counted in refused_features; the item still gets its estimate", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, []);
  await collectOk(w);
  const items = [
    { key: "A", tags: {}, features: { size: -1 } },
    { key: "B", tags: {}, features: { size: 5 } },
  ];
  const run = await cli(w, ["estimate"], { stdin: JSON.stringify({ items }) });
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.refused, 0);
  assert.equal(run.env.data.refused_features, 1);
  assert.deepEqual(run.env.data.estimates.map((estimate: { key: string }) => estimate.key), ["A", "B"]);
});

test("TP-32: estimate takes no lock and writes nothing, and the commands and their flags are the same", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, []);
  await collectOk(w);
  const lock = acquireLock(join(dataDir(w), "collect.lock"), DEPS);
  assert.ok(lock.ok);
  const before = folderState(dataDir(w));
  const run = await cli(w, ["estimate"], { stdin: JSON.stringify({ items: [{ key: "A", tags: {} }] }) });
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.estimates.length, 1);
  assert.deepEqual(folderState(dataDir(w)), before, "estimate changes no file");
  releaseLock(lock.value, DEPS);

  const DATA = ["--data-dir"];
  const ROOTS = ["--data-dir", "--claude-root", "--codex-root"];
  const takes: Readonly<Record<string, readonly string[]>> = {
    collect: ROOTS,
    doctor: ROOTS,
    status: DATA,
    usage: DATA,
    tasks: DATA,
    "tasks sync": DATA,
    estimate: DATA,
    record: [],
    statusline: [],
  };
  for (const [command, allowed] of Object.entries(takes)) {
    for (const flag of ROOTS) {
      assert.equal(parseArgs([...command.split(" "), flag, "/x"]).ok, allowed.includes(flag), `${command} ${flag}`);
    }
  }
  for (const other of ["estimate-log", "self-check", "log", "recost", "unfreeze"]) {
    assert.equal(parseArgs([other]).ok, false, other);
  }
});

test("TP-14, TP-49: a running item past the start of the spent rule reads spent and open from its cost so far; one under the start changes nothing", async (t) => {
  const w = makeWorld(t);
  const bigTask: CostTask = { label: "BIG", cost: 90_000, running: true };
  const tinyTask: CostTask = { label: "TINY", cost: 100, running: true };
  const open = ["BIG", "TINY", "NEW"].map((key) => ({ key, tags: {} }));
  await syncCostTasks(w, [...THREE_COSTS, bigTask, tinyTask], open);
  await collectOk(w);
  const perPct = await perPctOf(w);
  const start = 0.5 * perPct;
  assert.ok(weightedOf(bigTask) >= start && weightedOf(tinyTask) < start, `the start value ${start} is between the two costs so far`);

  const [big, tiny, fresh] = (await dataOf(w, "status")).estimates;
  // The range of the history is 1205 to 3605 weighted tokens. NEW has no window.
  near(fresh.low_pct, 1205 / perPct, "NEW low");
  near(fresh.high_pct, 3605 / perPct, "NEW high");
  // BIG has used far more than that range, and no finished task cost as much: its
  // low end is its cost so far, and the range is open. It has no high end, so it
  // does not read as one exact number. It rests on the spent basis.
  near(big.low_pct, weightedOf(bigTask) / perPct, "BIG low");
  assert.equal(big.high_pct, null, "an open range has no high end");
  assert.equal(big.raw_high, null, "an open range has no raw high end");
  // The raw ratio of each finished task is (cost + 1) / (cost + 5). The middle of
  // the three is that of the cost 2000.
  near(big.raw_low / weightedOf(bigTask), 2001 / 2005, "an open range keeps its raw low end, at the middle raw ratio");
  assert.deepEqual([big.typical_pct, big.budget_pct, big.count], [null, null, 0]);
  // TINY has used less than the low end of the range and less than the start value:
  // nothing changes.
  assert.ok(weightedOf(tinyTask) < 1205);
  near(tiny.low_pct, fresh.low_pct, "TINY low");
  near(tiny.high_pct, fresh.high_pct, "TINY high");
  assert.deepEqual([big.basis, big.basis_name, tiny.basis_name, fresh.basis_name], ["wide", "spent", "all", "all"]);
});

test("TP-71: a running item on the spent basis with a closed range has a raw low end above 0, and the factor of its weighted ends between its raw ends", async (t) => {
  const w = makeWorld(t);
  const finished: readonly CostTask[] = [1000, 2000, 3000, 4000, 5000, 6000, 7000].map((cost, index): CostTask => ({ label: `F${index + 1}`, cost }));
  const running: CostTask = { label: "RUN", cost: 1500, running: true };
  await syncCostTasks(w, [...finished, running], [{ key: "RUN", tags: {} }]);
  await collectOk(w);
  const perPct = await perPctOf(w);
  assert.ok(weightedOf(running) >= 0.5 * perPct, `the cost so far ${weightedOf(running)} is at the start of the spent rule, ${0.5 * perPct}`);

  const [row] = (await dataOf(w, "status")).estimates;
  // Six finished tasks cost at least 1505 weighted tokens: 2005, 3005, 4005, 5005, 6005 and 7005. The percentile is
  // linear at the place p * 5. P10 is at 0.5: 2005 + 0.5 * 1000 = 2505. P90 is at 4.5: 6005 + 0.5 * 1000 = 6505.
  // P50 is at 2.5: 4005 + 0.5 * 1000 = 4505. P80 is at 4: 6005.
  assert.deepEqual([row.basis, row.basis_name, row.count], ["wide", "spent", 6]);
  near(row.low_pct, 2505 / perPct, "low");
  near(row.high_pct, 6505 / perPct, "high");
  near(row.typical_pct, 4505 / perPct, "typical");
  near(row.budget_pct, 6005 / perPct, "budget");
  assert.ok(row.raw_low > 0, "the raw low end is above 0");
  near(row.raw_high / row.raw_low, 6505 / 2505, "the factor between the raw ends is the factor between the weighted ends");
});

const QUEUE_SUMS = ["expected_pct", "low_pct", "high_pct", "likely_low_pct", "likely_high_pct", "spent_pct"] as const;

test("TP-70: after collect with one running item, queue.spent_pct is the cost so far of that item over the week size", async (t) => {
  const w = makeWorld(t);
  const running: CostTask = { label: "RUN", cost: 90_000, running: true };
  await syncCostTasks(w, [...THREE_COSTS, running], [{ key: "RUN", tags: {} }]);
  await collectOk(w);
  const perPct = await perPctOf(w);
  const { queue } = await dataOf(w, "status");
  assert.deepEqual(Object.keys(queue), ["count", ...QUEUE_SUMS]);
  assert.equal(queue.count, 1);
  const spent = weightedOf(running) / perPct;
  near(queue.spent_pct, spent, "spent_pct");
  // The finished tasks cost 1005, 2005 and 4005 weighted tokens: none costs as much as the item has used, so the
  // item counts as its cost so far and every sum is that cost.
  for (const sum of QUEUE_SUMS) near(queue[sum], spent, sum);
});

test("TP-70: the queue counts every open item, and an item with no window draws from the cost of the finished tasks", async (t) => {
  const w = makeWorld(t);
  const running: CostTask = { label: "RUN", cost: 90_000, running: true };
  await syncCostTasks(w, [...THREE_COSTS, running], [{ key: "RUN", tags: {} }, { key: "NEW", tags: {} }]);
  await collectOk(w);
  const perPct = await perPctOf(w);
  const { queue } = await dataOf(w, "status");
  assert.equal(queue.count, 2);
  const spent = weightedOf(running) / perPct;
  near(queue.spent_pct, spent, "spent_pct");
  // NEW takes any one of the three costs: its mean is (1005 + 2005 + 4005) / 3.
  near(queue.expected_pct, spent + 7015 / 3 / perPct, "expected_pct");
  assert.ok(queue.low_pct >= spent + 1005 / perPct - 1e-9, "low_pct is at least RUN plus the smallest cost");
  assert.ok(queue.high_pct <= spent + 4005 / perPct + 1e-9, "high_pct is at most RUN plus the largest cost");
  assert.ok(queue.low_pct <= queue.likely_low_pct && queue.likely_low_pct <= queue.likely_high_pct && queue.likely_high_pct <= queue.high_pct);
});

test("TP-17: a collect loads the bucket rows once, whether or not task windows are known", async (t) => {
  const w = makeWorld(t);
  seedClaude(w);
  recordPoints(w, 5, 10);
  await collectOk(w);
  // A later pass finds nothing new to scan, so the loads it counts are the ones of its own analysis.
  const without = await bucketOpens(t, async () => void (await collectOk(w)));
  assert.ok(without.size > 0, "the pass loads the bucket rows");
  assert.deepEqual([...without.values()].filter((count) => count !== 1), [], "each bucket month file is opened once");

  const window = { label: "T-OPEN", start: "2026-11-03T07:00:00Z", match: { folders: ["/work/alpha"] }, tags: {} };
  const synced = await cli(w, ["tasks", "sync"], { stdin: JSON.stringify({ windows: [window], open: [{ key: "T-OPEN", tags: {} }] }) });
  assert.equal(synced.code, 0, synced.text);
  const withWindows = await bucketOpens(t, async () => void (await collectOk(w)));
  assert.deepEqual(withWindows, without, "known windows add no second load");
});

test("tasks sync: a bad label or tag is refused and counted; a bad envelope is usage_error", async (t) => {
  const w = makeWorld(t);
  const body = JSON.stringify({
    windows: [
      { label: "bad label!", start: "2026-11-03T07:00:00Z", match: { folders: ["/work/alpha"] }, tags: {} },
      { label: "ok-1", start: "2026-11-03T07:00:00Z", match: { folders: ["/work/alpha"] }, tags: { type: "no spaces allowed" } },
      { label: "ok-2", start: "2026-11-03T07:00:00Z", match: { folders: ["/work/alpha"] }, tags: { type: "fine" } },
    ],
    open: [{ key: "x y", tags: {} }],
  });
  const run = await cli(w, ["tasks", "sync"], { stdin: body });
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data, { windows: 1, open: 0, refused: { windows: 2, open: 1, features: 0 }, expired: 0, collisions: { keys: 0, windows: [] } });

  const before = folderState(dataDir(w));
  for (const stdin of ["{", "[]", "", JSON.stringify({ windows: "x" }), `{"pad":"${"x".repeat(SYNC_MAX_BYTES)}"}`]) {
    const bad = await cli(w, ["tasks", "sync"], { stdin });
    assert.equal(bad.code, 2, stdin.slice(0, 20));
    assert.equal(failureOf(bad), "usage_error");
  }
  assert.deepEqual(folderState(dataDir(w)), before, "a refused input writes nothing");
});

test("TP-42: tasks sync counts a bad feature on its own; collect counts the bad features of the stored files in features_refused", async (t) => {
  const w = makeWorld(t);
  seedClaude(w);
  const body = JSON.stringify({
    windows: [
      {
        label: "T-DONE",
        start: "2026-11-03T07:00:00Z",
        end: "2026-11-03T09:00:00Z",
        match: { folders: ["/work/alpha"] },
        tags: { type: "feature" },
        features: { files: 4, Bad: 1, elapsed_hours: 2 },
      },
    ],
    open: [{ key: "I-1", tags: {}, features: { churn: -1, commits: 3 } }],
  });
  const synced = await cli(w, ["tasks", "sync"], { stdin: body });
  assert.equal(synced.code, 0, synced.text);
  assert.deepEqual(synced.env.data, { windows: 1, open: 1, refused: { windows: 0, open: 0, features: 3 }, expired: 0, collisions: { keys: 0, windows: [] } });
  const clean = await collectOk(w);
  assert.equal(clean.data.counters.features_refused, 0, "sync kept only good features, so the files hold none");

  // A stored window file and a stored history line that hold bad features.
  const windowsPath = join(dataDir(w), "windows.json");
  const stored = JSON.parse(readFileSync(windowsPath, "utf8")) as { open: Array<{ features: Record<string, unknown> }> };
  at(stored.open, 0).features = { Bad: 1, commits: 3 };
  writeFileSync(windowsPath, JSON.stringify(stored), { mode: 0o600 });
  const historyPath = join(dataDir(w), "tasks.jsonl");
  const lines = readFileSync(historyPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const line = JSON.parse(at(lines, 0)) as Record<string, unknown>;
  writeFileSync(historyPath, `${JSON.stringify({ ...line, features: { files: 4, churn: -2, plan_bytes: 1e400 } })}\n`, { mode: 0o600 });

  const again = await collectOk(w);
  assert.equal(again.data.counters.features_refused, 3);
  assert.equal((await cli(w, ["doctor"])).env.data.counters.features_refused, 3);
});

test("AC-12: a snapshot from an older build reads features_refused as 0, and a bad value still fails closed", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { report: Record<string, unknown> };
  assert.ok("features_refused" in saved.report);

  const older = { ...saved.report };
  delete older["features_refused"];
  writeFileSync(path, JSON.stringify({ ...saved, report: older }), { mode: 0o600 });
  assert.equal((await cli(w, ["status"])).code, 0);
  const doctor = await cli(w, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.text);
  assert.equal(doctor.env.data.counters.features_refused, 0);

  for (const bad of ["x", -1, 1.5, null]) {
    writeFileSync(path, JSON.stringify({ ...saved, report: { ...saved.report, features_refused: bad } }), { mode: 0o600 });
    assert.equal(failureOf(await cli(w, ["status"])), "store_corrupt", String(bad));
  }
});

// ---------------------------------------------------------------------------
// Codex cache write (TP-31, TP-19, TP-20)
// ---------------------------------------------------------------------------

const BAD_CACHE_LAST = { input_tokens: 1000, cached_input_tokens: 400, cache_write_input_tokens: "many", output_tokens: 100, total_tokens: 1100 };
const GOOD_CACHE_LAST = { input_tokens: 800, cached_input_tokens: 100, cache_write_input_tokens: 300, output_tokens: 50, total_tokens: 850 };

function cacheEvent(at: string, last: object): string {
  const info = { last_token_usage: last, total_token_usage: last };
  return `${JSON.stringify({ timestamp: at, type: "event_msg", payload: { type: "token_count", info } })}\n`;
}

// An invented rollout with a session_meta and a turn_context, then the given event lines.
function cacheRollout(...events: string[]): string {
  const meta = { timestamp: "2026-11-03T08:00:00.000Z", type: "session_meta", payload: { session_id: "sess-cache", cwd: "/work/cache" } };
  const context = { timestamp: "2026-11-03T08:00:01.000Z", type: "turn_context", payload: { model: "gpt-5-codex" } };
  return `${JSON.stringify(meta)}\n${JSON.stringify(context)}\n${events.join("")}`;
}

test("TP-31: an invalid Codex cache write counts as 0 and stays one event; a repeat in the file or a copy in a child file counts once", async (t) => {
  const w = makeWorld(t);
  const bad = cacheEvent("2026-11-03T08:01:00.000Z", BAD_CACHE_LAST);
  const good = cacheEvent("2026-11-03T08:02:00.000Z", GOOD_CACHE_LAST);
  // The newer file is read first, so the child copy comes after its source.
  put(codexFile(w, "a-parent"), cacheRollout(bad, bad, good), NOW - 4 * MINUTE_MS);
  put(codexFile(w, "b-child"), cacheRollout(cacheEvent("2026-11-03T09:00:00.000Z", BAD_CACHE_LAST)), NOW - 5 * MINUTE_MS);

  const first = await collectOk(w);
  const counters = first.data.counters;
  assert.equal(counters.codex_cache_invalid, 1, "the bad value is counted once for the event");
  assert.equal(counters.counted, 2, "the bad event and the good event are both counted");
  assert.equal(counters.repeats, 1, "the copy in the child file is a repeat");
  assert.equal(counters.skipped.repeat_event, 1, "the direct repeat is skipped");
  assert.equal(counters.skipped.bad_token, undefined, "the bad cache write is not a skipped event");

  // The bad event counts with a cache write of 0. The good event moves 300 of its 700 uncached input.
  const columns = { cacheWrite1h: 0 };
  const expected =
    weighted({ ...columns, input: 600, cacheWrite5m: 0, cacheRead: 400, output: 100 }) +
    weighted({ ...columns, input: 400, cacheWrite5m: 300, cacheRead: 100, output: 50 });
  const today = (await dataOf(w, "status")).subscriptions[1].tokens.today;
  assert.equal(today.weighted, expected);
  assert.equal(today.input, 1000);
  assert.equal(today.cache_read, 500);

  // A later copy of the bad event, after the good one, is a repeat in the store: it adds nothing.
  appendFileSync(codexFile(w, "a-parent"), bad);
  utimesSync(codexFile(w, "a-parent"), (NOW - MINUTE_MS) / 1000, (NOW - MINUTE_MS) / 1000);
  const second = await collectOk(w);
  assert.equal(second.data.counters.codex_cache_invalid, 0);
  assert.equal(second.data.counters.counted, 0);
  assert.equal(second.data.counters.repeats, 1);
  assert.equal((await dataOf(w, "status")).subscriptions[1].tokens.today.weighted, expected);
  assert.equal((await cli(w, ["doctor"])).env.data.counters.codex_cache_invalid, 0);
});

test("TP-19: a snapshot from an older build reads codex_cache_invalid as 0 and sets no store corrupt flag", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { report: Record<string, unknown> };
  assert.ok("codex_cache_invalid" in saved.report);

  const older = { ...saved.report };
  delete older["codex_cache_invalid"];
  writeFileSync(path, JSON.stringify({ ...saved, report: older }), { mode: 0o600 });
  assert.equal((await cli(w, ["status"])).code, 0);
  const doctor = await cli(w, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.text);
  assert.equal(doctor.env.data.counters.codex_cache_invalid, 0);
  assert.equal(doctor.env.data.counters.counted, saved.report["counted"], "the other counters are as saved");
});

test("TP-20: a codex_cache_invalid that is present but not a count fails closed", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { report: Record<string, unknown> };
  for (const bad of ["x", -1, 1.5, null]) {
    writeFileSync(path, JSON.stringify({ ...saved, report: { ...saved.report, codex_cache_invalid: bad } }), { mode: 0o600 });
    assert.equal(failureOf(await cli(w, ["status"])), "store_corrupt", String(bad));
    assert.equal(failureOf(await cli(w, ["doctor"])), "store_corrupt", String(bad));
  }
});

// ---------------------------------------------------------------------------
// The estimate log and the self-check
// ---------------------------------------------------------------------------

const LOG_MONTH = "2026-11";
const LOG_COUNTERS = ["estimate_log_damaged", "estimate_log_at_cap"] as const;
const TWO_OPEN: readonly object[] = [{ key: "A", tags: {} }, { key: "B", tags: {} }];

function logFile(w: World, month: string = LOG_MONTH): string {
  return join(dataDir(w), `estimates-${month}.jsonl`);
}

// The lines of a month file as they are stored.
function storedLines(w: World, month: string = LOG_MONTH): Record<string, unknown>[] {
  return readFileSync(logFile(w, month), "utf8")
    .split("\n")
    .filter((text) => text !== "")
    .map((text) => JSON.parse(text) as Record<string, unknown>);
}

function logNames(w: World): string[] {
  return readdirSync(dataDir(w)).filter((name) => name.startsWith("estimates-")).sort();
}

function oldLine(key: string, at: string, range: readonly [number, number] = [100, 400], over: Partial<RangedLogLine> = {}): RangedLogLine {
  return { at: Date.parse(at), key, basis: "wide", basisName: "all", features: [], stage: null, low: range[0], high: range[1], ...over };
}

// Writes a month file of the estimate log, as an earlier collect would have.
function seedLog(w: World, month: string, lines: readonly EstimateLogLine[]): void {
  const dir = prepareDataDir(dataDir(w), DEPS);
  assert.ok(dir.ok);
  writeFileSync(join(dir.value, `estimates-${month}.jsonl`), lines.map((line) => `${logLineText(line)}\n`).join(""), { mode: 0o600 });
}

// Runs `run` while the estimate log meets a failing file call: EIO on the open of a
// month file for an append (`append`), or on the removal of one (`remove`). Returns
// the log calls in the order they were made, with the value of `run`.
async function watchLog<T>(
  t: TestContext,
  failing: readonly ("append" | "remove")[],
  run: () => Promise<T>,
): Promise<{ readonly events: string[]; readonly value: T }> {
  const events: string[] = [];
  const open = fs.openSync;
  const unlink = fs.unlinkSync;
  const eio = (): never => {
    throw Object.assign(new Error("EIO"), { code: "EIO" });
  };
  const openSpy = t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    const name = basename(String(args[0]));
    if (name.startsWith("estimates-") && (Number(args[1]) & fs.constants.O_APPEND) !== 0) {
      events.push(`append ${name}`);
      if (failing.includes("append")) return eio();
    }
    return open(...args);
  });
  const unlinkSpy = t.mock.method(fs, "unlinkSync", (...args: Parameters<typeof fs.unlinkSync>) => {
    const name = basename(String(args[0]));
    if (name.startsWith("estimates-")) {
      events.push(`remove ${name}`);
      if (failing.includes("remove")) return eio();
    }
    return unlink(...args);
  });
  syncBuiltinESMExports();
  try {
    return { events, value: await run() };
  } finally {
    openSpy.mock.restore();
    unlinkSpy.mock.restore();
    syncBuiltinESMExports();
  }
}

test("TP-19: a snapshot without the estimate log counters or the self-check reads with no store corrupt flag", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  const first = await collectOk(w);
  assert.deepEqual(first.data.counters.estimate_log_damaged, 0);
  assert.deepEqual(first.data.counters.estimate_log_at_cap, 0);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { data: Record<string, unknown>; report: Record<string, unknown> };
  for (const counter of LOG_COUNTERS) assert.ok(counter in saved.report, counter);
  assert.deepEqual(saved.data["self_check"], unscored(0));

  const older = structuredClone(saved);
  for (const counter of LOG_COUNTERS) delete older.report[counter];
  delete older.data["self_check"];
  writeFileSync(path, JSON.stringify(older), { mode: 0o600 });
  for (const command of ["status", "usage", "tasks", "doctor"]) {
    const run = await cli(w, [command]);
    assert.equal(run.code, 0, `${command}: ${run.text}`);
  }
  assert.equal((await dataOf(w, "status")).self_check, null, "an older snapshot has no self-check");
  const doctor = await cli(w, ["doctor"]);
  for (const counter of LOG_COUNTERS) assert.equal(doctor.env.data.counters[counter], 0, counter);
  assert.equal(doctor.env.data.counters.counted, saved.report["counted"], "the other counters are as saved");

  writeFileSync(path, JSON.stringify(saved), { mode: 0o600 });
  assert.deepEqual((await dataOf(w, "status")).self_check, unscored(0));
});

test("TP-20: an estimate log counter that is present but not a count fails closed as store corrupt", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { report: Record<string, unknown> };
  for (const counter of LOG_COUNTERS) {
    for (const bad of ["x", -1, 1.5, null]) {
      writeFileSync(path, JSON.stringify({ ...saved, report: { ...saved.report, [counter]: bad } }), { mode: 0o600 });
      assert.equal(failureOf(await cli(w, ["status"])), "store_corrupt", `${counter} ${String(bad)}`);
      assert.equal(failureOf(await cli(w, ["doctor"])), "store_corrupt", `${counter} ${String(bad)}`);
    }
  }
});

test("TP-48: a snapshot with a bad self_check object reads it as null and sets no store corrupt flag", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { data: Record<string, unknown> };
  const full = { n: 5, hit_rate: 0.5, error_factor: 2, bias: 1.5, band_low: 0.4, band_high: 1, width: 2, useful_rate: 0.5, stages: {} };
  const badSelfChecks = [
    "x",
    7,
    [],
    { n: "many", hit_rate: 0.5, error_factor: 2 },
    { n: 5, hit_rate: 7, error_factor: 2 },
    { ...full, bias: 0 },
    { ...full, bias: "high" },
    { ...full, band_low: 0.9, band_high: 0.5 },
    { ...full, band_high: null },
    { ...full, n: 4 },
    { ...full, width: 0.5 },
    { ...full, width: "wide" },
    { ...full, useful_rate: 0.9 },
  ];
  for (const bad of badSelfChecks) {
    writeFileSync(path, JSON.stringify({ ...saved, data: { ...saved.data, self_check: bad } }), { mode: 0o600 });
    for (const command of ["status", "usage"]) {
      const run = await cli(w, [command]);
      assert.equal(run.code, 0, `${command} ${JSON.stringify(bad)}: ${run.text}`);
      assert.equal(run.env.data.self_check, null, `${command} ${JSON.stringify(bad)}`);
    }
    assert.equal((await cli(w, ["doctor"])).code, 0);
  }
});

test("TP-43: a snapshot on disk with a bad queue, or with none, reads queue null and sets no store corrupt flag", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { data: Record<string, unknown> };
  assert.equal((saved.data["queue"] as { count: number }).count, 2, "the collect wrote the queue");
  const full = { count: 2, expected_pct: 6, low_pct: 4, high_pct: 8, likely_low_pct: 5, likely_high_pct: 7, spent_pct: 2 };
  const badQueues: readonly unknown[] = [
    "x",
    7,
    [],
    { ...full, count: 501 },
    { ...full, count: -1 },
    { ...full, count: 1.5 },
    { ...full, count: "2" },
    { ...full, expected_pct: -1 },
    { ...full, low_pct: "4" },
    { ...full, low_pct: 9 },
    { ...full, likely_high_pct: 9 },
    { ...full, expected_pct: null },
    { count: 2 },
  ];
  const absent = { ...saved.data };
  delete absent["queue"];
  for (const queue of [...badQueues, undefined]) {
    const data = queue === undefined ? absent : { ...saved.data, queue };
    writeFileSync(path, JSON.stringify({ ...saved, data }), { mode: 0o600 });
    for (const command of ["status", "usage"]) {
      const run = await cli(w, [command]);
      assert.equal(run.code, 0, `${command} ${JSON.stringify(queue)}: ${run.text}`);
      assert.equal(run.env.data.queue, null, `${command} ${JSON.stringify(queue)}`);
    }
    for (const command of ["tasks", "doctor"]) assert.equal((await cli(w, [command])).code, 0, command);
  }
  writeFileSync(path, JSON.stringify({ ...saved, data: { ...saved.data, queue: full } }), { mode: 0o600 });
  assert.deepEqual((await dataOf(w, "status")).queue, full, "a valid queue is kept");
});

test("a snapshot on disk with a bad stage entry reads with stages null and the rest kept, and sets no store corrupt flag", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { data: Record<string, unknown> };
  const stage = { n: 6, hit_rate: 0.5, error_factor: 2, bias: 1.5, band_low: 0.5, band_high: 1, width: 2, useful_rate: 0.5 };
  const top = { ...stage };
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`s${i}`, stage]));
  const badStages: readonly unknown[] = [
    { plan: { ...stage, bias: -1 } },
    { plan: { ...stage, n: 31 } },
    { plan: { ...stage, n: 4 } },
    { "bad label": stage },
    { plan: "x" },
    nine,
    "x",
    [],
  ];
  const write = (stages: unknown): void => {
    writeFileSync(path, JSON.stringify({ ...saved, data: { ...saved.data, self_check: { ...top, stages } } }), { mode: 0o600 });
  };
  for (const bad of badStages) {
    write(bad);
    for (const command of ["status", "usage"]) {
      const run = await cli(w, [command]);
      assert.equal(run.code, 0, `${command} ${JSON.stringify(bad)}: ${run.text}`);
      assert.deepEqual(run.env.data.self_check, { ...top, stages: null, projects: null }, `${command} ${JSON.stringify(bad)}`);
    }
    assert.equal((await cli(w, ["doctor"])).code, 0, JSON.stringify(bad));
  }

  // The labels that name a property of every object are valid stages and read as data.
  const before = Object.getOwnPropertyNames(Object.prototype).sort();
  const labels = JSON.parse(
    `{"__proto__":${JSON.stringify(stage)},"constructor":${JSON.stringify(stage)},"toString":${JSON.stringify(stage)}}`,
  ) as object;
  write(labels);
  for (const command of ["status", "usage"]) {
    const read = (await cli(w, [command])).env.data.self_check;
    assert.deepEqual(Object.keys(read.stages), ["__proto__", "constructor", "toString"], command);
    assert.equal(Object.getPrototypeOf(read.stages), Object.prototype, command);
  }
  assert.deepEqual(Object.getOwnPropertyNames(Object.prototype).sort(), before);
});

test("TP-21: a failed snapshot write appends no log line, and the next collect writes the change", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  // A folder in place of status.json makes the write of the snapshot fail.
  mkdirSync(join(dataDir(w), "status.json"));
  const failed = await cli(w, collectArgs(w));
  assert.equal(failureOf(failed), "internal_error");
  assert.deepEqual(logNames(w), [], "no line without a snapshot");

  rmdirSync(join(dataDir(w), "status.json"));
  const next = await collectOk(w);
  assert.deepEqual(next.data.estimate_log, { appended: 2, refused_at_cap: 0, append_failed: 0, pruned: 0, prune_failed: 0 });
  assert.deepEqual(
    storedLines(w).map((line) => [line["key"], line["basis"], line["basis_name"], line["features"]]),
    [["A", "wide", "all", []], ["B", "wide", "all", []]],
  );
});

test("TP-22: a failed log append is reported in the collect result, the snapshot stays, and collect still succeeds", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  const { events, value: run } = await watchLog(t, ["append"], () => cli(w, collectArgs(w)));
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data.estimate_log, { appended: 0, refused_at_cap: 0, append_failed: 2, pruned: 0, prune_failed: 0 });
  assert.equal(events.length, 2, "one try for each line");
  assert.deepEqual(logNames(w), []);
  const status = await dataOf(w, "status");
  assert.deepEqual(status.estimates.map((e: { key: string }) => e.key), ["A", "B"], "the snapshot was written");
  assert.equal(status.collect.at, NOW);
});

test("TP-44: after a failed log append the next collect writes the same lines again, and the one after writes none", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  await watchLog(t, ["append"], () => cli(w, collectArgs(w)));
  // The snapshot already holds these estimates. The comparison is with the log.
  const again = await collectOk(w);
  assert.equal(again.data.estimate_log.appended, 2);
  const lines = storedLines(w);
  assert.deepEqual(lines.map((line) => line["key"]), ["A", "B"]);
  const third = await collectOk(w);
  assert.deepEqual(third.data.estimate_log, { appended: 0, refused_at_cap: 0, append_failed: 0, pruned: 0, prune_failed: 0 });
  assert.deepEqual(storedLines(w), lines);
});

test("a change of the feature names of an open item writes a new line, and a change of its values does not", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, [{ key: "A", tags: {}, features: { size: 10 } }]);
  await collectOk(w);
  assert.deepEqual(storedLines(w).map((line) => line["features"]), [["size"]]);
  const sync = async (features: object): Promise<void> => {
    const windows = seedCostTasks(w, THREE_COSTS);
    const synced = await cli(w, ["tasks", "sync"], { stdin: JSON.stringify({ windows, open: [{ key: "A", tags: {}, features }] }) });
    assert.equal(synced.code, 0, synced.text);
  };
  await sync({ size: 99 });
  assert.equal((await collectOk(w)).data.estimate_log.appended, 0);
  await sync({ size: 99, churn: 4 });
  assert.equal((await collectOk(w)).data.estimate_log.appended, 1);
  assert.deepEqual(storedLines(w).map((line) => line["features"]), [["size"], ["churn", "size"]]);
});

test("an open item tagged with a stage stores a line with that stage, a later sync with another stage stores a second line, and a repeat stores none", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, [{ key: "A", tags: { stage: "issue" } }, { key: "B", tags: {} }]);
  await collectOk(w);
  assert.deepEqual(storedLines(w).map((line) => [line["key"], line["stage"]]), [["A", "issue"], ["B", null]]);

  const syncStage = async (tags: object): Promise<void> => {
    const windows = seedCostTasks(w, THREE_COSTS);
    const open = [{ key: "A", tags }, { key: "B", tags: {} }];
    const synced = await cli(w, ["tasks", "sync"], { stdin: JSON.stringify({ windows, open }) });
    assert.equal(synced.code, 0, synced.text);
  };
  await syncStage({ stage: "issue" });
  assert.equal((await collectOk(w)).data.estimate_log.appended, 0, "the same stage writes no line");
  await syncStage({ stage: "plan" });
  assert.equal((await collectOk(w)).data.estimate_log.appended, 1, "the new stage writes one line");
  assert.deepEqual(
    storedLines(w).map((line) => [line["key"], line["stage"]]),
    [["A", "issue"], ["B", null], ["A", "plan"]],
  );
});

// Three labels with two windows each. Window one has a row of 1000 input tokens, window
// two a row of 3000. Both windows end before NOW.
async function syncTwoWindowTasks(w: World): Promise<void> {
  const labels = ["X0", "X1", "X2"];
  const rows = labels.flatMap((_, i) => [
    claudeLine({ id: `a${i}`, at: "2026-11-03T06:30:00Z", model: "claude-sonnet-5-5", cwd: `/work/a${i}`, input: 1000 }),
    claudeLine({ id: `b${i}`, at: "2026-11-03T08:00:00Z", model: "claude-sonnet-5-5", cwd: `/work/b${i}`, input: 3000 }),
  ]);
  put(claudeFile(w, "sess-links"), rows.join(""));
  const windows = labels.flatMap((label, i) => [
    { label, start: "2026-11-03T06:00:00Z", end: "2026-11-03T07:00:00Z", match: { folders: [`/work/a${i}`] }, tags: {} },
    { label, start: "2026-11-03T07:30:00Z", end: "2026-11-03T09:00:00Z", match: { folders: [`/work/b${i}`] }, tags: {} },
  ]);
  recordPoints(w, 5, 10);
  const synced = await cli(w, ["tasks", "sync"], { stdin: JSON.stringify({ windows, open: [] }) });
  assert.equal(synced.code, 0, synced.text);
  assert.equal(synced.env.data.windows, 6);
}

test("TP-27: a log line written after window one ends links to window two, and each window counts once", async (t) => {
  const w = makeWorld(t);
  await syncTwoWindowTasks(w);
  // Window one costs 1005 weighted tokens, window two 3005. For each label: an early
  // line that misses window one, then the line that hits it, then the line that hits
  // window two. Each line differs from the one before it in its basis.
  const onSize: Partial<RangedLogLine> = { basis: "similar", basisName: "size", features: ["size"] };
  const lines = ["X0", "X1", "X2"].flatMap((key) => [
    oldLine(key, "2026-11-03T06:15:00Z", [1, 2], onSize),
    oldLine(key, "2026-11-03T06:45:00Z", [900, 1200]),
    oldLine(key, "2026-11-03T07:15:00Z", [2500, 3500], onSize),
  ]);
  seedLog(w, LOG_MONTH, lines);
  await collectOk(w);
  const check = (await dataOf(w, "status")).self_check;
  assert.equal(check.n, 6, "six windows, not nine lines");
  assert.equal(check.hit_rate, 1, "the last line before a window ends is the one that counts");
  // Three factors of window one and three of window two: the median is the mean of the middle pair.
  const factor = (weighted: number, low: number, high: number): number => Math.exp(Math.abs(Math.log(weighted) - (Math.log(low) + Math.log(high)) / 2));
  near(check.error_factor, (factor(1005, 900, 1200) + factor(3005, 2500, 3500)) / 2, "error factor");
});

test("TP-28: the status shows the hit rate, the error factor, the bias and the band from five scored tasks, and nulls from four", async (t) => {
  const w = makeWorld(t);
  const tasks = [1000, 2000, 3000, 4000, 5000, 6000].map((cost, i): CostTask => ({ label: `S${i}`, cost }));
  await syncCostTasks(w, tasks, []);
  const ranges: ReadonlyArray<readonly [number, number]> = [[900, 1200], [900, 1200], [2500, 3500], [3000, 5000], [4500, 5200], [6500, 9000]];
  const linesFor = (count: number): EstimateLogLine[] => ranges.slice(0, count).map((range, i) => oldLine(`S${i}`, "2026-10-15T08:00:00Z", range));
  const offsets = ranges.map(([low, high], i) => (Math.log(low) + Math.log(high)) / 2 - Math.log(weightedOf(at(tasks, i))));
  const factors = offsets.map((offset) => Math.exp(Math.abs(offset)));
  const median = (values: readonly number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length / 2;
    return sorted.length % 2 === 1 ? at(sorted, (sorted.length - 1) / 2) : (at(sorted, middle - 1) + at(sorted, middle)) / 2;
  };

  seedLog(w, "2026-10", linesFor(4));
  await collectOk(w);
  assert.deepEqual((await dataOf(w, "status")).self_check, unscored(4));

  seedLog(w, "2026-10", linesFor(5));
  await collectOk(w);
  const five = (await dataOf(w, "status")).self_check;
  assert.equal(five.n, 5);
  near(five.hit_rate, 4 / 5, "four of the five costs are inside their range");
  near(five.error_factor, median(factors.slice(0, 5)), "error factor");
  near(five.bias, Math.exp(median(offsets.slice(0, 5))), "bias");
  assert.notEqual(five.bias.toFixed(3), five.error_factor.toFixed(3), "the bias is not the error factor");
  assert.deepEqual([five.band_low, five.band_high], [0.4, 1], "the band of five tasks");

  seedLog(w, "2026-10", linesFor(6));
  await collectOk(w);
  const six = (await dataOf(w, "status")).self_check;
  assert.equal(six.n, 6);
  near(six.hit_rate, 4 / 6, "four of the six");
  near(six.error_factor, median(factors), "error factor of six");
  near(six.bias, Math.exp(median(offsets)), "bias of six");
  assert.deepEqual([six.band_low, six.band_high], [0.5, 1], "the band of six tasks");
});

test("TP-29: a damaged estimate log gives nulls and a counter, collect still succeeds, and nothing is deleted", async (t) => {
  const w = makeWorld(t);
  await thirtyTasksWithLog(w);
  // October stays readable: its lines give a keep time, so only the damage gate stops the
  // prune. The August file is open to others. It is damage, and the prune would delete it.
  const august = logFile(w, "2026-08");
  chmodSync(august, 0o644);

  const run = await cli(w, collectArgs(w));
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.counters.estimate_log_damaged, 1);
  assert.equal(run.env.data.counters.estimate_log_at_cap, 0);
  assert.equal(run.env.data.estimate_log.appended, 1, "a line is still written to a month file that is safe");
  assert.equal(run.env.data.estimate_log.pruned, 0);
  assert.deepEqual((await dataOf(w, "status")).self_check, unscored(null, null), "a damaged log: all seven values are null, stages included");
  assert.equal((await cli(w, ["doctor"])).env.data.counters.estimate_log_damaged, 1);
  assert.deepEqual(logNames(w), ["estimates-2026-06.jsonl", "estimates-2026-08.jsonl", "estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);

  chmodSync(august, 0o600);
  const healed = await collectOk(w);
  assert.equal(healed.data.counters.estimate_log_damaged, 0);
  const check = (await dataOf(w, "status")).self_check;
  assert.deepEqual([check.n, check.hit_rate], [30, 0], "every cost is above its logged range");
  assert.equal(healed.data.estimate_log.pruned, 2);
});

test("TP-29: a month file that others can read takes no line, so two collects change nothing and a repair writes each line once", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  // The month file of NOW holds an old line and is open to others: the read refuses it.
  seedLog(w, LOG_MONTH, [oldLine("OLD", "2026-11-01T08:00:00Z")]);
  chmodSync(logFile(w), 0o644);
  const size = statSync(logFile(w)).size;

  for (const pass of [1, 2]) {
    const run = await collectOk(w);
    assert.equal(run.data.counters.estimate_log_damaged, 1, `pass ${pass}`);
    assert.deepEqual(run.data.estimate_log, { appended: 0, refused_at_cap: 0, append_failed: 2, pruned: 0, prune_failed: 0 }, `pass ${pass}`);
    assert.equal(statSync(logFile(w)).size, size, `pass ${pass}: the file does not grow`);
  }

  chmodSync(logFile(w), 0o600);
  const repaired = await collectOk(w);
  assert.equal(repaired.data.counters.estimate_log_damaged, 0);
  assert.equal(repaired.data.estimate_log.appended, 2);
  assert.deepEqual(storedLines(w).map((line) => line["key"]), ["OLD", "A", "B"], "each line once");
});

test("TP-67: a task that ended and is not frozen yet keeps the month file of its line", async (t) => {
  const w = makeWorld(t);
  // Thirty tasks that the collect freezes, and one that ended 30 minutes before NOW. The
  // freeze delay is one hour, so that task is not in the history. No item is open.
  const frozen = Array.from({ length: 30 }, (_, i): CostTask => ({ label: `K${i}`, cost: 1000 + 50 * i }));
  await syncCostTasks(w, [...frozen, { label: "LATE", cost: 900, endAt: "2026-11-03T11:30:00Z" }], []);
  seedLog(w, "2026-11", frozen.map((task) => oldLine(task.label, "2026-11-02T08:00:00Z")));
  seedLog(w, "2026-10", [oldLine("LATE", "2026-10-15T08:00:00Z")]);
  seedLog(w, "2026-06", [oldLine("GONE", "2026-06-05T08:00:00Z")]);

  const run = await collectOk(w);
  assert.equal(run.data.counters.tasks_frozen, 30, "the task that ended 30 minutes ago is not frozen");
  assert.equal(run.data.estimate_log.pruned, 1, "only the file of the task that is gone");
  assert.deepEqual(logNames(w), ["estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);
});

test("TP-69: the next collect counts each month file at or above the cap, and the lines for a full month file are refused", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  const dir = prepareDataDir(dataDir(w), DEPS);
  assert.ok(dir.ok);
  const filler = "x".repeat(ESTIMATE_LOG_CAP_BYTES);
  writeFileSync(join(dir.value, "estimates-2026-10.jsonl"), filler, { mode: 0o600 });
  writeFileSync(join(dir.value, "estimates-2026-11.jsonl"), filler, { mode: 0o600 });
  writeFileSync(join(dir.value, "estimates-2026-09.jsonl"), filler.slice(1), { mode: 0o600 });

  const run = await collectOk(w);
  assert.equal(run.data.counters.estimate_log_at_cap, 2, "October and November, not September");
  assert.equal(run.data.counters.estimate_log_damaged, 0);
  assert.deepEqual(run.data.estimate_log, { appended: 0, refused_at_cap: 2, append_failed: 0, pruned: 0, prune_failed: 0 });
  assert.equal(statSync(logFile(w)).size, ESTIMATE_LOG_CAP_BYTES, "a refused line changes nothing");
  assert.equal((await cli(w, ["doctor"])).env.data.counters.estimate_log_at_cap, 2);
  assert.equal((await collectOk(w)).data.counters.estimate_log_at_cap, 2, "the next collect counts them again");
});

// Thirty finished tasks K0 to K29 and one open item. The log holds a line for each task in
// October, an old month file for a task that is gone, and an older one.
async function thirtyTasksWithLog(w: World): Promise<readonly CostTask[]> {
  const tasks = Array.from({ length: 30 }, (_, i): CostTask => ({ label: `K${i}`, cost: 1000 + 50 * i }));
  await syncCostTasks(w, tasks, [{ key: "OPEN1", tags: {} }]);
  seedLog(w, "2026-10", tasks.map((task) => oldLine(task.label, "2026-10-15T08:00:00Z")));
  seedLog(w, "2026-08", [oldLine("GONE", "2026-08-05T08:00:00Z")]);
  seedLog(w, "2026-06", [oldLine("GONE", "2026-06-05T08:00:00Z")]);
  return tasks;
}

test("TP-67: collect prunes after its append, and the files older than the cut month go", async (t) => {
  const w = makeWorld(t);
  await thirtyTasksWithLog(w);
  const { events, value: run } = await watchLog(t, [], () => cli(w, collectArgs(w)));
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data.estimate_log, { appended: 1, refused_at_cap: 0, append_failed: 0, pruned: 2, prune_failed: 0 });
  assert.equal(events[0], "append estimates-2026-11.jsonl", "the append comes first");
  assert.deepEqual(events.slice(1).sort(), ["remove estimates-2026-06.jsonl", "remove estimates-2026-08.jsonl"]);
  assert.deepEqual(logNames(w), ["estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);
});

test("TP-67: a month file removal failure is reported in the collect result, and collect still succeeds", async (t) => {
  const w = makeWorld(t);
  await thirtyTasksWithLog(w);
  const { value: run } = await watchLog(t, ["remove"], () => cli(w, collectArgs(w)));
  assert.equal(run.code, 0, run.text);
  assert.deepEqual(run.env.data.estimate_log, { appended: 1, refused_at_cap: 0, append_failed: 0, pruned: 0, prune_failed: 2 });
  assert.deepEqual(logNames(w), ["estimates-2026-06.jsonl", "estimates-2026-08.jsonl", "estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);
  assert.equal((await dataOf(w, "status")).collect.at, NOW, "the snapshot was written");
  for (const name of ["appended", "refused_at_cap", "append_failed", "pruned", "prune_failed"]) {
    assert.equal(name in run.env.data.counters, false, `${name} is in the collect result only`);
  }
  const retry = await collectOk(w);
  assert.equal(retry.data.estimate_log.pruned, 2, "the next collect deletes them");
});

test("TP-47: with fewer than thirty finished tasks collect deletes no month file", async (t) => {
  const w = makeWorld(t);
  await syncCostTasks(w, THREE_COSTS, TWO_OPEN);
  seedLog(w, "2026-01", [oldLine("OLD", "2026-01-05T08:00:00Z")]);
  seedLog(w, "2026-10", THREE_COSTS.map((task) => oldLine(task.label, "2026-10-15T08:00:00Z")));
  const run = await collectOk(w);
  assert.equal(run.data.estimate_log.pruned, 0);
  assert.deepEqual(logNames(w), ["estimates-2026-01.jsonl", "estimates-2026-10.jsonl", "estimates-2026-11.jsonl"]);
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

test("doctor: counters, roots, quota reason codes and task counts, with no text from a source", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  recordQuota(w, { five_hour: { reason: "absent" }, week: point(40, WEEK_RESET) });
  await cli(w, ["tasks", "sync"], { stdin: SYNC_BODY });
  await collectOk(w);
  const run = await cli(w, ["doctor", "--claude-root", w.claude, "--codex-root", w.sb.path("no-codex")]);
  assert.equal(run.code, 0, run.text);
  const doctor = run.env.data;
  assert.deepEqual(Object.keys(doctor), ["store", "snapshot", "counters", "roots", "quota", "tasks", "cross_day_claude_keys", "pool"]);
  assert.deepEqual(doctor.pool, { mode: "separate", reason: null });
  assert.deepEqual(doctor.store, { version: 1 });
  assert.deepEqual(doctor.snapshot, { state: "ok", stopped: null, at: NOW });
  assert.equal(doctor.counters.stopped_by, "none");
  assert.equal(doctor.counters.files, 2);
  assert.equal(doctor.counters.counted >= 5, true);
  assert.equal(doctor.counters.skipped.synthetic, 1);
  assert.equal(doctor.counters.tasks_frozen, 1);
  assert.deepEqual(doctor.roots, { claude: "scanned", codex: "missing" });
  assert.equal(doctor.quota.claude.unknown.five_hour, "absent");
  assert.equal(doctor.quota.claude.seven_day.pct, 40);
  assert.equal(doctor.quota.codex.source, "rollouts");
  assert.deepEqual(doctor.tasks, { windows: 2, open: 2, finished: 1 });
  assert.equal(doctor.cross_day_claude_keys, 0);
  for (const text of [CANARY, w.sb.root, "/work/", "alpha"]) assert.equal(run.text.includes(text), false, text);
  assert.equal(doctor.counters.codex_quota_appended, 7);
  assert.equal(doctor.counters.codex_quota_skipped, 1);
  assert.equal(doctor.counters.codex_quota_full, 0);
});

test("doctor: a quota month file at its cap shows in codex_quota_full, apart from the repeats", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  const dir = prepareDataDir(dataDir(w), DEPS);
  assert.ok(dir.ok);
  const month = join(dir.value, "quota-2026-11.jsonl");
  writeFileSync(month, `${"x".repeat(QUOTA_MONTH_CAP_BYTES - 40)}\n`, { mode: 0o600 });
  const collected = await collectOk(w);
  assert.equal(collected.data.counters.codex_quota_full, 7);
  const run = await cli(w, ["doctor", "--claude-root", w.claude, "--codex-root", w.codex]);
  assert.equal(run.code, 0, run.text);
  assert.equal(run.env.data.counters.codex_quota_appended, 0);
  assert.equal(run.env.data.counters.codex_quota_skipped, 1);
  assert.equal(run.env.data.counters.codex_quota_full, 7);
});

// ---------------------------------------------------------------------------
// Store errors (TP-18)
// ---------------------------------------------------------------------------

test("a damaged store file stops collect with no store write, and status tells it", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const damaged = join(dataDir(w), "buckets-2026-11.json");
  writeFileSync(damaged, "{not json", { mode: 0o600 });
  put(claudeFile(w, "sess-late"), claudeLine({ id: "late", at: "2026-11-03T09:00:00Z", model: "claude-sonnet-5-5" }));
  const before = folderState(dataDir(w));

  const run = await cli(w, collectArgs(w));
  assert.equal(run.code, 1);
  assert.deepEqual(run.env, { schema: SCHEMA_ID, ok: false, error: errorRecord("store_corrupt") });
  const after = folderState(dataDir(w));
  sameExcept(before, after, "status.json");
  assert.deepEqual(JSON.parse(readFileSync(join(dataDir(w), "status.json"), "utf8")), {
    version: 1,
    stopped: "store_corrupt",
    data: null,
    report: null,
  });
  for (const command of ["status", "usage", "tasks"]) {
    assert.equal(failureOf(await cli(w, [command])), "store_corrupt", command);
  }
  // The doctor still answers, and shows the stop.
  const doctor = await cli(w, ["doctor"]);
  assert.equal(doctor.code, 0);
  assert.deepEqual(doctor.env.data.snapshot, { state: "stopped", stopped: "store_corrupt", at: null });
  assert.equal(doctor.env.data.counters, null);

  // Repaired: the next collect clears the stop.
  writeFileSync(damaged, JSON.stringify({ version: 1, rows: {} }), { mode: 0o600 });
  await collectOk(w);
  assert.equal((await dataOf(w, "status")).collect.state, "ok");
});

test("a damaged task window file stops collect the same way", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  writeFileSync(join(dataDir(w), "windows.json"), '{"version":1,"windows":"x","open":[]}', { mode: 0o600 });
  assert.equal(failureOf(await cli(w, collectArgs(w))), "store_corrupt");
  assert.equal(failureOf(await cli(w, ["status"])), "store_corrupt");
});

test("a store newer than the CLI is refused, with no write at all", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  writeFileSync(join(dataDir(w), "store.json"), JSON.stringify({ version: 2 }), { mode: 0o600 });
  const before = folderState(dataDir(w));
  const run = await cli(w, collectArgs(w));
  assert.equal(run.code, 1);
  assert.deepEqual(run.env, { schema: SCHEMA_ID, ok: false, error: errorRecord("store_newer") });
  assert.deepEqual(folderState(dataDir(w)), before);
});

test("a snapshot that a newer tokenmeter wrote is refused by every read, and never overwritten", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  writeFileSync(path, JSON.stringify({ version: 2, anything: true }), { mode: 0o600 });
  for (const command of ["status", "usage", "tasks", "doctor"]) {
    assert.equal(failureOf(await cli(w, [command])), "store_newer", command);
  }
  assert.equal(failureOf(await cli(w, ["estimate"], { stdin: '{"items":[]}' })), "store_newer");
  // Damage somewhere else: collect stops, and the newer snapshot stays as it is.
  writeFileSync(join(dataDir(w), "buckets-2026-11.json"), "{not json", { mode: 0o600 });
  put(claudeFile(w, "sess-late"), claudeLine({ id: "late", at: "2026-11-03T09:00:00Z", model: "claude-sonnet-5-5" }));
  const before = folderState(dataDir(w));
  assert.equal(failureOf(await cli(w, collectArgs(w))), "store_corrupt");
  assert.deepEqual(folderState(dataDir(w)), before);
});

test("a damaged, over-size or wrongly shaped snapshot gives store_corrupt", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const good = readFileSync(path, "utf8");
  const parsed = JSON.parse(good) as { data: { subscriptions: unknown[] } };
  const cases: readonly string[] = [
    "{not json",
    "x".repeat(MIB + 1),
    JSON.stringify({ version: 1, stopped: null, data: null, report: null }),
    JSON.stringify({ version: 1, stopped: "store_corrupt", data: parsed.data, report: null }),
    JSON.stringify({ ...parsed, data: { ...parsed.data, subscriptions: [] } }),
    JSON.stringify({ ...JSON.parse(good), report: { files: -1 } }),
  ];
  for (const text of cases) {
    writeFileSync(path, text, { mode: 0o600 });
    assert.equal(failureOf(await cli(w, ["status"])), "store_corrupt", text.slice(0, 40));
  }
  writeFileSync(path, good, { mode: 0o600 });
  assert.equal((await cli(w, ["status"])).code, 0);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Damage = (data: any) => void;

test("a snapshot with a damaged task, share, estimate or token row gives store_corrupt for status and tasks", async (t) => {
  const w = await collectedTasks(t);
  const path = join(dataDir(w), "status.json");
  const good = readFileSync(path, "utf8");
  const damages: ReadonlyArray<readonly [string, Damage]> = [
    ["a null task row", (data) => { data.tasks[0] = null; }],
    ["shares that are not a list", (data) => { data.tasks[0].shares = "x"; }],
    ["a null share row", (data) => { data.tasks[0].shares[0] = null; }],
    ["a share of an unknown subscription", (data) => { data.tasks[0].shares[0].subscription = "gemini"; }],
    ["tokens with no week", (data) => { data.subscriptions[0].tokens = {}; }],
    ["a null week of tokens", (data) => { data.subscriptions[1].tokens.week = null; }],
    ["a week total that is not a number", (data) => { data.subscriptions[0].tokens.week.weighted = "many"; }],
    ["a null estimate row", (data) => { data.estimates[0] = null; }],
  ];
  for (const [name, damage] of damages) {
    const body = JSON.parse(good);
    damage(body.data);
    writeFileSync(path, JSON.stringify(body), { mode: 0o600 });
    for (const command of ["status", "tasks"]) {
      assert.equal(failureOf(await cli(w, [command])), "store_corrupt", `${name}: ${command}`);
    }
  }
  writeFileSync(path, good, { mode: 0o600 });
  assert.equal((await cli(w, ["tasks"])).code, 0);
});

test("a snapshot from an older build reads a counter it lacks as 0, and still refuses a bad value", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const saved = JSON.parse(readFileSync(path, "utf8")) as { report: Record<string, unknown> };
  assert.ok("codex_quota_full" in saved.report);

  const older = { ...saved.report };
  delete older["codex_quota_full"];
  writeFileSync(path, JSON.stringify({ ...saved, report: older }), { mode: 0o600 });
  const status = await cli(w, ["status"]);
  assert.equal(status.code, 0, status.text);
  const doctor = await cli(w, ["doctor"]);
  assert.equal(doctor.code, 0, doctor.text);
  assert.equal(doctor.env.data.counters.codex_quota_full, 0);
  assert.equal(doctor.env.data.counters.counted, saved.report["counted"], "the other counters are as saved");

  for (const bad of ["x", -1, 1.5, null]) {
    writeFileSync(path, JSON.stringify({ ...saved, report: { ...saved.report, codex_quota_full: bad } }), { mode: 0o600 });
    assert.equal(failureOf(await cli(w, ["status"])), "store_corrupt", String(bad));
  }
  // A counter that every build has is still required.
  const lacking = { ...saved.report };
  delete lacking["counted"];
  writeFileSync(path, JSON.stringify({ ...saved, report: lacking }), { mode: 0o600 });
  assert.equal(failureOf(await cli(w, ["status"])), "store_corrupt");
});

test("a collect that is already running gives lock_held and changes nothing", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const lock = acquireLock(join(dataDir(w), "collect.lock"), DEPS);
  assert.ok(lock.ok);
  const before = folderState(dataDir(w));
  const run = await cli(w, collectArgs(w));
  assert.deepEqual(run.env, { schema: SCHEMA_ID, ok: false, error: errorRecord("lock_held") });
  assert.equal(run.code, 1);
  assert.deepEqual(folderState(dataDir(w)), before);
  releaseLock(lock.value, DEPS);
  assert.equal((await cli(w, collectArgs(w))).code, 0);
});

test("main catches everything: an unexpected failure gives internal_error with no message text", async (t) => {
  const w = makeWorld(t);
  const boom: FsDeps = {
    ...DEPS,
    nowMs: () => {
      throw new Error(`${CANARY} secret failure text`);
    },
  };
  const run = await cli(w, collectArgs(w), { io: { deps: boom } });
  assert.equal(run.code, 1);
  assert.deepEqual(run.env, { schema: SCHEMA_ID, ok: false, error: errorRecord("internal_error") });
  assert.equal(run.text.includes(CANARY), false);
});

// ---------------------------------------------------------------------------
// The bin, as a child process (real clock)
// ---------------------------------------------------------------------------

// A Claude row ten minutes old, so that the child finds it inside every period.
function recentClaudeRow(id: string): string {
  return claudeLine({ id, at: new Date(Date.now() - 10 * MINUTE_MS).toISOString(), model: "claude-sonnet-5-5", input: 1234, output: 56 });
}

function childCollect(w: World): Promise<ChildRun> {
  return runBin(["collect", "--claude-root", w.claude, "--codex-root", w.sb.path("no-codex")], w.sb.env);
}

test("bin: one JSON line on stdout, nothing on stderr, and the exit codes 0, 1 and 2", async (t) => {
  const w = makeWorld(t);
  const missing = await runBin(["status"], w.sb.env);
  assert.equal(missing.code, 1);
  assert.equal(envelopeOf(missing).error.code, "not_collected");
  const usage = await runBin(["status", "--bogus"], w.sb.env);
  assert.equal(usage.code, 2);
  assert.equal(envelopeOf(usage).error.code, "usage_error");
  const none = await runBin([], w.sb.env);
  assert.equal(none.code, 2);
  const ok = await childCollect(w);
  assert.equal(ok.code, 0, ok.stdout);
  assert.equal(envelopeOf(ok).ok, true);
  const status = await runBin(["status"], w.sb.env);
  assert.equal(status.code, 0);
  assert.equal(envelopeOf(status).data.subscriptions[1].root, "root_missing");
});

test("TP-14: status answers within 3 s from the snapshot alone, whatever the rest of the store holds", async (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-now"), recentClaudeRow("now"), Date.now());
  const collected = await childCollect(w);
  assert.equal(collected.code, 0, collected.stdout);

  // Files that any read would reject or take long over: status must not open them.
  const month = new Date().toISOString().slice(0, 7);
  writeFileSync(join(dataDir(w), "ledger.json"), "x".repeat(34 * MIB), { mode: 0o600 });
  for (const name of [`buckets-${month}.json`, "dedupe-2026-01-01.json", "windows.json", "tasks.jsonl"]) {
    writeFileSync(join(dataDir(w), name), "{not json", { mode: 0o600 });
  }
  const times: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    const run = await runBin(["status"], w.sb.env);
    assert.equal(run.code, 0, run.stdout.slice(0, 200));
    assert.equal(envelopeOf(run).data.subscriptions[0].tokens.week.input, 1234);
    times.push(run.ms);
  }
  t.diagnostic(`status ms: ${times.map((ms) => ms.toFixed(0)).join(", ")}`);
  assert.ok(Math.max(...times) < 3000, `status took ${Math.max(...times).toFixed(0)} ms`);
});

function statuslineJson(sevenDayPct: number, resetSeconds: number): string {
  return JSON.stringify({ model: { id: `m-${CANARY}` }, rate_limits: { seven_day: { used_percentage: sevenDayPct, resets_at: resetSeconds } } });
}

test("bin record then status: a lower percent from a second session does not win, and the missing 5 hour window shows absent", async (t) => {
  const w = makeWorld(t);
  const collected = await childCollect(w);
  assert.equal(collected.code, 0, collected.stdout);
  // Real statusline input today has a seven_day window and no five_hour window.
  const reset = Math.round((Date.now() + 3 * DAY_MS) / 1000);
  for (const pct of [6, 6, 4, 6]) {
    const run = await runBin(["record"], w.sb.env, statuslineJson(pct, reset));
    assert.equal(run.code, 0);
    assert.equal(run.stderr, "");
  }
  const claude = envelopeOf(await runBin(["status"], w.sb.env)).data.subscriptions[0];
  assert.equal(claude.quota.seven_day.pct, 6);
  assert.equal(claude.quota.seven_day.resets_at, reset * 1000);
  assert.equal(claude.quota.five_hour, null);
  assert.equal(claude.quota.unknown.five_hour, "absent");
  assert.equal(claude.quota.source, "record");

  // A lower reading in the next period, with a new reset time, does replace it.
  const next = await runBin(["record"], w.sb.env, statuslineJson(2, reset + 4 * 24 * 3600));
  assert.equal(next.code, 0);
  assert.equal(envelopeOf(await runBin(["status"], w.sb.env)).data.subscriptions[0].quota.seven_day.pct, 2);
});

// ---------------------------------------------------------------------------
// statusline: the line (pure)
// ---------------------------------------------------------------------------

const WEEK_MS = 7 * DAY_MS;
const AGE_3M = { weighted: 2667, writtenAt: NOW - 3 * MINUTE_MS };
const LINE_ASCII = /^[\x20-\x7e]+$/;

function reading(pct: number, resetsAt: number, at: number = NOW): QuotaReading {
  return { known: true, usedPercent: pct, resetsAt, at };
}

test("statusline line: week percent, forecast at the reset, and today's tokens with the snapshot age", () => {
  const week = reading(40, NOW + 3 * DAY_MS);
  assert.equal(
    renderStatusline({ nowMs: NOW, week, today: AGE_3M }),
    "Claude wk 40% | 70% by reset | today 2.7k, 3m ago",
  );
});

test("statusline line: a forecast that runs out before the reset says when", () => {
  const week = reading(80, NOW + 3 * DAY_MS);
  assert.equal(
    renderStatusline({ nowMs: NOW, week, today: AGE_3M }),
    "Claude wk 80% | 140% by reset, runs out in 24h | today 2.7k, 3m ago",
  );
  assert.equal(renderStatusline({ nowMs: NOW, week: reading(95, NOW + 3 * DAY_MS), today: null }), "Claude wk 95% | 166% by reset, runs out in 5h");
  assert.equal(renderStatusline({ nowMs: NOW, week: reading(60, NOW + 68 * HOUR_MS), today: null }), "Claude wk 60% | 101% by reset, runs out in 2d");
  assert.equal(renderStatusline({ nowMs: NOW, week: reading(99.9, NOW + WEEK_MS - 128 * HOUR_MS), today: null }), "Claude wk 100% | 131% by reset, runs out in 7m");
});

test("statusline line: with no snapshot only the quota and the forecast show", () => {
  const week = reading(40, NOW + 3 * DAY_MS);
  assert.equal(renderStatusline({ nowMs: NOW, week, today: null }), "Claude wk 40% | 70% by reset");
});

test("statusline line: no forecast in the first 3 percent of the week", () => {
  const week = reading(2, NOW + WEEK_MS - HOUR_MS);
  assert.equal(renderStatusline({ nowMs: NOW, week, today: AGE_3M }), "Claude wk 2% | today 2.7k, 3m ago");
  assert.equal(renderStatusline({ nowMs: NOW, week, today: null }), "Claude wk 2%");
});

test("statusline line: a window with a reason code shows unknown, whatever the reason", () => {
  const reasons = ["missing", "unsafe", "too_large", "bad_shape", "out_of_range", "stale", "absent", "bad_percent", "bad_reset"] as const;
  for (const reason of reasons) {
    const week: QuotaReading = { known: false, reason };
    assert.equal(renderStatusline({ nowMs: NOW, week, today: null }), "Claude wk ?", reason);
    assert.equal(renderStatusline({ nowMs: NOW, week, today: AGE_3M }), "Claude wk ? | today 2.7k, 3m ago", reason);
  }
});

test("statusline line: token counts are short, and the age uses minutes, hours or days", () => {
  const week: QuotaReading = { known: false, reason: "missing" };
  const counts: readonly [number, string][] = [
    [0, "0"],
    [842, "842"],
    [1000, "1k"],
    [1500, "1.5k"],
    [12_345, "12.3k"],
    [123_456, "123k"],
    [1_000_000, "1M"],
    [45_600_000, "45.6M"],
    [5_500_000_000, "5.5B"],
  ];
  for (const [weighted, text] of counts) {
    const line = renderStatusline({ nowMs: NOW, week, today: { weighted, writtenAt: NOW - 5 * MINUTE_MS } });
    assert.equal(line, `Claude wk ? | today ${text}, 5m ago`);
  }
  const ages: readonly [number, string][] = [
    [0, "<1m ago"],
    [59_000, "<1m ago"],
    [MINUTE_MS, "1m ago"],
    [59 * MINUTE_MS, "59m ago"],
    [HOUR_MS, "1h ago"],
    [47 * HOUR_MS, "47h ago"],
    [2 * DAY_MS, "2d ago"],
    [-5 * MINUTE_MS, "<1m ago"],
  ];
  for (const [age, text] of ages) {
    const line = renderStatusline({ nowMs: NOW, week, today: { weighted: 5, writtenAt: NOW - age } });
    assert.equal(line, `Claude wk ? | today 5, ${text}`);
  }
});

test("statusline line: the worst case is plain ASCII and at most 80 characters", () => {
  const extreme = renderStatusline({
    nowMs: NOW,
    week: reading(100, NOW + WEEK_MS - 6 * HOUR_MS),
    today: { weighted: 123_456_789_012, writtenAt: NOW - 3 * DAY_MS },
  });
  assert.equal(extreme, "Claude wk 100% | >999% by reset, runs out in <1m | today 123B, 3d ago");
  const cases = [
    extreme,
    renderStatusline({ nowMs: NOW, week: reading(40, NOW + 3 * DAY_MS), today: AGE_3M }),
    renderStatusline({ nowMs: NOW, week: reading(100, NOW + 3 * DAY_MS), today: { weighted: 9.99e11, writtenAt: NOW - 400 * DAY_MS } }),
    renderStatusline({ nowMs: NOW, week: { known: false, reason: "stale" }, today: null }),
  ];
  for (const line of cases) {
    assert.match(line, LINE_ASCII);
    assert.ok(line.length <= 80, `${line.length} characters: ${line}`);
  }
});

// ---------------------------------------------------------------------------
// statusline: the command, in this process
// ---------------------------------------------------------------------------

function fullStatusline(weekPct: number, weekResetSeconds: number, fiveResetSeconds: number = Math.round((NOW + 2 * HOUR_MS) / 1000)): string {
  return JSON.stringify({
    session_id: `sess-${CANARY}`,
    transcript_path: `/home/${CANARY}/t.jsonl`,
    cwd: `/work/${CANARY}`,
    model: { id: `m-${CANARY}`, display_name: `Model ${CANARY}` },
    workspace: { current_dir: `/w/${CANARY}`, project_dir: `/p/${CANARY}` },
    version: `1.${CANARY}`,
    output_style: { name: `style ${CANARY}` },
    cost: { total_cost_usd: 1.25, note: CANARY },
    rate_limits: {
      plan_label: CANARY,
      five_hour: { used_percentage: 10, resets_at: fiveResetSeconds, note: CANARY },
      seven_day: { used_percentage: weekPct, resets_at: weekResetSeconds, note: CANARY },
    },
  });
}

const WEEK_RESET_SECONDS = Math.round((NOW + 3 * DAY_MS) / 1000);

function lineIo(w: World, stdin: PassThrough, stdout: Writable, nowMs: number, patch: Partial<RecordIo> = {}): RecordIo {
  return {
    stdin,
    stdout,
    env: w.sb.env,
    platform: "linux",
    homeDir: w.sb.home,
    deps: { ...DEPS, nowMs: () => nowMs },
    deadlineMs: RECORD_DEADLINE_MS,
    ...patch,
  };
}

interface Printed {
  readonly text: string;
  readonly ended: boolean;
}

async function statuslineWith(w: World, stdin: string, nowMs: number = NOW, patch: Partial<RecordIo> = {}): Promise<Printed> {
  const input = new PassThrough();
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      chunks.push(chunk);
      callback();
    },
  });
  const done = runStatusline(lineIo(w, input, sink, nowMs, patch));
  input.end(stdin);
  await done;
  return { text: Buffer.concat(chunks).toString("utf8"), ended: sink.writableEnded };
}

async function recordWith(w: World, stdin: string, nowMs: number = NOW): Promise<void> {
  const input = new PassThrough();
  const sink = new Writable({
    write(_chunk: Buffer, _encoding, callback): void {
      callback();
    },
  });
  const done = runRecord(lineIo(w, input, sink, nowMs));
  input.end(stdin);
  await done;
}

function filesOf(dir: string): readonly [string, string][] {
  return readdirSync(dir)
    .sort()
    .map((name): [string, string] => [name, readFileSync(join(dir, name), "utf8")]);
}

test("statusline: one line and one newline, the output is ended, and the week and forecast come from the stdin limits", async (t) => {
  const w = makeWorld(t);
  const printed = await statuslineWith(w, fullStatusline(40, WEEK_RESET_SECONDS));
  assert.equal(printed.text, "Claude wk 40% | 70% by reset\n");
  assert.equal(printed.ended, true);
});

test("statusline: the rate limits are stored exactly as record stores them", async (t) => {
  const byRecord = makeWorld(t);
  const byLine = makeWorld(t);
  const input = fullStatusline(40, WEEK_RESET_SECONDS);
  await recordWith(byRecord, input);
  await statuslineWith(byLine, input);
  const stored = folderState(dataDir(byLine));
  assert.ok(stored.has(QUOTA_LATEST_FILE), "the latest quota file is there");
  assert.ok([...stored.keys()].some((name) => /^quota-\d{4}-\d{2}\.jsonl$/.test(name)), "a sample file is there");
  assert.deepEqual([...stored], [...folderState(dataDir(byRecord))]);
  assert.equal(lstatSync(dataDir(byLine)).mode & 0o777, 0o700);
});

test("statusline: with a snapshot the line adds today's tokens and the age of the snapshot", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const printed = await statuslineWith(w, fullStatusline(40, WEEK_RESET_SECONDS), NOW + 3 * MINUTE_MS);
  assert.equal(printed.text, "Claude wk 40% | 70% by reset | today 2.7k, 3m ago\n");
});

test("statusline: it reads the quota file when stdin carries no limits", async (t) => {
  const w = makeWorld(t);
  recordPoints(w, 12, 40);
  const printed = await statuslineWith(w, JSON.stringify({ model: { id: `m-${CANARY}` } }), NOW + MINUTE_MS);
  assert.match(printed.text, /^Claude wk 40% \| 7\d% by reset\n$/);
});

test("statusline: a stale quota or no quota shows unknown", async (t) => {
  const w = makeWorld(t);
  recordPoints(w, 12, 40);
  const later = await statuslineWith(w, "", WEEK_RESET + MINUTE_MS);
  assert.equal(later.text, "Claude wk ?\n");
  const empty = makeWorld(t);
  mkdirSync(dataDir(empty), { mode: 0o700 });
  assert.equal((await statuslineWith(empty, "")).text, "Claude wk ?\n");
});

test("statusline: a damaged or wrongly shaped snapshot is left out of the line", async (t) => {
  const w = makeWorld(t);
  seedFixtures(w);
  await collectOk(w);
  const path = join(dataDir(w), "status.json");
  const good = readFileSync(path, "utf8");
  const stdin = fullStatusline(40, WEEK_RESET_SECONDS);
  const bad = [
    "{not json",
    good.replace(/"weighted":[0-9.e+-]+/, '"weighted":"x"'),
    good.replace(/"weighted":[0-9.e+-]+/, '"weighted":-5'),
    JSON.stringify({ version: 1, stopped: "store_corrupt", data: null, report: null }),
  ];
  for (const text of bad) {
    assert.notEqual(text, good);
    writeFileSync(path, text, { mode: 0o600 });
    const printed = await statuslineWith(w, stdin);
    assert.equal(printed.text, "Claude wk 40% | 70% by reset\n", text.slice(0, 40));
  }
});

test("statusline: a missing data folder prints a short line, stores nothing and makes no folder", async (t) => {
  const w = makeWorld(t);
  const printed = await statuslineWith(w, JSON.stringify({ model: { id: `m-${CANARY}` } }));
  assert.equal(printed.text, `${NO_DATA_LINE}\n`);
  assert.equal(printed.ended, true);
  assert.equal(existsSync(dataDir(w)), false);
  const nothing = await statuslineWith(w, "");
  assert.equal(nothing.text, `${NO_DATA_LINE}\n`);
  assert.equal(existsSync(dataDir(w)), false);
});

test("statusline: an unsafe data folder (open to others, a link, a foreign owner) prints a short line and writes nothing", async (t) => {
  const w = makeWorld(t);
  const input = fullStatusline(40, WEEK_RESET_SECONDS);

  const open = w.sb.path("open");
  mkdirSync(open, { mode: 0o700 });
  chmodSync(open, 0o777);
  const real = w.sb.path("real");
  mkdirSync(real, { mode: 0o700 });
  const link = w.sb.path("link");
  symlinkSync(real, link);
  const mine = w.sb.path("mine");
  mkdirSync(mine, { mode: 0o700 });

  const cases: readonly [string, string, Partial<RecordIo>][] = [
    ["open", open, {}],
    ["link", link, {}],
    ["foreign", mine, { deps: { ...DEPS, uid: DEPS.uid + 1 } }],
  ];
  for (const [name, folder, patch] of cases) {
    const printed = await statuslineWith(w, input, NOW, { env: { ...w.sb.env, TOKENMETER_DATA_DIR: folder }, ...patch });
    assert.equal(printed.text, `${NO_DATA_LINE}\n`, name);
  }
  assert.deepEqual(readdirSync(open), []);
  assert.deepEqual(readdirSync(real), []);
  assert.deepEqual(readdirSync(mine), []);
});

test("statusline: it does not collect, even when sources sit in the default roots", async (t) => {
  const w = makeWorld(t);
  put(join(w.sb.home, ".claude", "projects", "-work-proj", "sess-a.jsonl"), fixtureText("claude-basic.jsonl"));
  put(join(w.sb.home, ".codex", "sessions", "2026", "11", "03", "rollout-a.jsonl"), fixtureText("codex-basic.jsonl"));
  const printed = await statuslineWith(w, fullStatusline(40, WEEK_RESET_SECONDS));
  assert.equal(printed.text, "Claude wk 40% | 70% by reset\n");
  const names = readdirSync(dataDir(w));
  assert.ok(names.length > 0);
  assert.ok(names.every((name) => name === QUOTA_LATEST_FILE || /^quota-\d{4}-\d{2}\.jsonl$/.test(name)), names.join(","));
});

test("statusline: input that is not JSON, empty or over 64 KiB still gives one line", async (t) => {
  const w = makeWorld(t);
  recordPoints(w, 12, 40);
  const inputs = ["", "not json at all", "[1,2,3]", `{"pad":"${"p".repeat(70 * 1024)}"}`];
  for (const stdin of inputs) {
    const printed = await statuslineWith(w, stdin, NOW + MINUTE_MS);
    assert.match(printed.text, /^Claude wk 40% \| 7\d% by reset\n$/, stdin.slice(0, 20));
  }
});

test("statusline: a canary in the other stdin fields is not printed and not stored", async (t) => {
  const w = makeWorld(t);
  const printed = await statuslineWith(w, fullStatusline(40, WEEK_RESET_SECONDS));
  assert.ok(printed.text.length > 0);
  assert.equal(printed.text.includes(CANARY), false);
  const files = filesOf(dataDir(w));
  assert.ok(files.length >= 2);
  for (const [name, text] of files) {
    assert.equal(text.includes(CANARY), false, name);
    for (const word of ["sess-", "transcript", "display_name", "/work/", "current_dir", "output_style"]) {
      assert.equal(text.includes(word), false, `${name} holds ${word}`);
    }
  }
});

// ---------------------------------------------------------------------------
// statusline: the bin, as a child process (real clock)
// ---------------------------------------------------------------------------

function realStatusline(weekPct: number): string {
  const now = Date.now();
  return fullStatusline(weekPct, Math.round((now + 3 * DAY_MS) / 1000), Math.round((now + 2 * HOUR_MS) / 1000));
}

test("bin statusline: one line, exit 0, nothing on stderr, and the limits are stored", async (t) => {
  const w = makeWorld(t);
  const run = await runBin(["statusline"], w.sb.env, realStatusline(40));
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /^Claude wk 40% \| \d+% by reset(?:, runs out in \d+[mhd])?\n$/);
  assert.match(run.stdout.trimEnd(), LINE_ASCII);
  assert.ok(run.stdout.trimEnd().length <= 80);
  assert.equal(run.stdout.includes(CANARY), false);
  assert.ok(existsSync(join(dataDir(w), QUOTA_LATEST_FILE)));
  assert.equal(lstatSync(dataDir(w)).mode & 0o777, 0o700);
  assert.deepEqual(readdirSync(w.sb.home), [], "nothing is written under the sandbox home");
});

test("bin statusline: with a snapshot from collect the line adds today's tokens", async (t) => {
  const w = makeWorld(t);
  put(claudeFile(w, "sess-now"), recentClaudeRow("now"), Date.now());
  assert.equal((await childCollect(w)).code, 0);
  const run = await runBin(["statusline"], w.sb.env, realStatusline(40));
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, / \| today \d+(?:\.\d)?[kMB]?, <1m ago\n$/);
});

test("bin statusline: a missing data folder and an empty stdin print a short line and exit 0", async (t) => {
  const w = makeWorld(t);
  const run = await runBin(["statusline"], w.sb.env);
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, `${NO_DATA_LINE}\n`);
  assert.equal(existsSync(dataDir(w)), false);
});

test("bin statusline: an unsafe data folder prints a short line, exits 0 and writes nothing", async (t) => {
  const w = makeWorld(t);
  mkdirSync(dataDir(w), { mode: 0o700 });
  chmodSync(dataDir(w), 0o777);
  const run = await runBin(["statusline"], w.sb.env, realStatusline(40));
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, `${NO_DATA_LINE}\n`);
  assert.deepEqual(readdirSync(dataDir(w)), []);

  const blocker = w.sb.path("blocker");
  writeFileSync(blocker, "a file, not a folder");
  const blocked = await runBin(["statusline"], { ...w.sb.env, TOKENMETER_DATA_DIR: join(blocker, "data") }, realStatusline(40));
  assert.equal(blocked.code, 0);
  assert.equal(blocked.stderr, "");
  assert.equal(blocked.stdout, `${NO_DATA_LINE}\n`);
});

test("bin statusline: extra arguments are ignored and the exit code stays 0", async (t) => {
  const w = makeWorld(t);
  const run = await runBin(["statusline", "--bogus", "x"], w.sb.env, realStatusline(40));
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.match(run.stdout, /^Claude wk 40% /);
});

test("bin statusline: with Node too old it still prints a short line, exits 0 and leaves stderr empty", async (t) => {
  const w = makeWorld(t);
  const preload = w.sb.path("old-node.cjs");
  writeFileSync(
    preload,
    'Object.defineProperty(process, "versions", { value: { ...process.versions, node: "20.11.0" }, configurable: true });\n',
  );
  const run = await runBin(["statusline"], { ...w.sb.env, NODE_OPTIONS: `--require=${preload}` }, realStatusline(40));
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, "tokenmeter: needs Node 22.0\n");
  assert.equal(existsSync(dataDir(w)), false, "no store work on an old Node");
});

test("bin statusline: when the module cannot be imported it still prints a short line and exits 0", async (t) => {
  const w = makeWorld(t);
  const shimDir = w.sb.path("shim", "bin");
  mkdirSync(shimDir, { recursive: true });
  const shim = join(shimDir, "tokenmeter.js");
  copyFileSync(BIN, shim);
  chmodSync(shim, 0o755);
  const run = await runBin(["statusline"], w.sb.env, realStatusline(40), shim);
  assert.equal(run.code, 0);
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, "tokenmeter: unavailable\n");
});

test("bin statusline: the median start stays near a bare Node start", async (t) => {
  const w = makeWorld(t);
  const baseline = writeBaselineScript(w.sb.path("baseline.js"));
  const { baselineMs, commandMs } = await measurePaired(
    TIMING_RUNS,
    async () => {
      const run = await runBin([], w.sb.env, "", baseline);
      assert.equal(run.code, 0);
      return run.ms;
    },
    async (i) => {
      const run = await runBin(["statusline"], w.sb.env, realStatusline(30 + i / 4));
      assert.equal(run.code, 0);
      assert.equal(run.stderr, "");
      return run.ms;
    },
  );
  const verdict = judgeTiming(commandMs, baselineMs);
  t.diagnostic(verdict.detail);
  assert.ok(verdict.ok, verdict.detail);
});
