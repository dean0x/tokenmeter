// The tokenmeter commands (plan 3.5, 3.6, 3.10).
//
//   collect       the only scan: lock, scan, Codex samples, task freeze, status.json
//   status        the snapshot plus the latest Claude quota, and the days, weeks
//                 and months of days.json; no scan
//   usage         the same, with every model
//   tasks sync    task windows and open items from stdin; a folder collision
//                 also gives one fixed warning line on stderr
//   tasks         the tasks of the snapshot
//   estimate      estimates for the open items on stdin
//   doctor        counters only: no text from a source reaches the output
//   config        reads or sets the Codex app-server switch
//   record        the statusline filter (the bin runs it without this module)
//   statusline    stores the rate limits as record does, then prints one short
//                 line (the bin runs it without this module)
//
// Every command prints one JSON envelope: {schema, ok, data} or
// {schema, ok:false, error:{code, hint}}. The hints are fixed. Exit code: 0 for
// ok, 2 for usage_error, 1 for any other error. Only a config write prints its
// data folder. No command prints source text or the text of a failure.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ErrorCode,
  type ErrorRecord,
  type Result,
  SCHEMA_ID,
  STATUS_OUTPUT_MAX_BYTES,
  SYNC_MAX_BYTES,
  err,
  errorRecord,
  ok,
} from "./core.ts";
import { type CollectState, loadBucketRows, periodSlots, readAnalysis } from "./analysis.ts";
import { DEFAULT_APP_SERVER, isAppServerSetting, readAppServerSetting, writeAppServerSetting, type AppServerSetting } from "./config.ts";
import {
  type CollectBudget,
  type CollectError,
  type CollectRoots,
  DEFAULT_BUDGET,
  collect,
  rootStateOf,
} from "./collect.ts";
import {
  type EstimateLogRead,
  type MonthAccess,
  appendEstimateLines,
  pruneEstimateLog,
  readEstimateLog,
} from "./estimate-log.ts";
import { type EstimateLogLine, estimateFromSignals, keepTime } from "./estimator.ts";
import {
  type FsDeps,
  defaultDeps,
  existingDataDir,
  prepareDataDir,
  resolveDataDirPath,
} from "./fsafe.ts";
import { type Zone, localZone } from "./periods.ts";
import { poolFromEnv } from "./pool.ts";
import { readLatestQuota, storeCodexQuota } from "./quota.ts";
import { recordMain } from "./record.ts";
import { type PeriodsJson, type Weekday, firstWeekdayOf, isWeekday, periodsOf, systemLocale } from "./rollup.ts";
import { statuslineMain } from "./statusline.ts";
import {
  type BuiltStatus,
  type Counters,
  type Snapshot,
  type StatusData,
  buildStatus,
  calibrationsOf,
  claudeQuotaJson,
  countersOf,
  estimateJson,
  overlayClaudeQuota,
  progressPercent,
  readSnapshot,
  withTopModels,
  writeSnapshot,
} from "./status.ts";
import {
  FILE_CAPS,
  STORE_FILE,
  type StoreError,
  crossDayClaudeKeys,
  loadDayRows,
  openVersioned,
  readJson,
} from "./store.ts";
import {
  type StoredTasks,
  type TaskEntry,
  attribute,
  collisionWarning,
  freezeTasks,
  loadTaskHistory,
  loadTaskWindows,
  parseEstimateInput,
  sync,
} from "./tasks.ts";

// ---------------------------------------------------------------------------
// Input and output
// ---------------------------------------------------------------------------

export interface CliOutput {
  write(text: string): unknown;
}

// Everything the commands touch from outside. Tests pass fakes.
export interface CliIo {
  readonly stdin: AsyncIterable<Buffer | string>;
  readonly stdout: CliOutput;
  // Only for a warning line of fixed text. Errors go to stdout as JSON.
  readonly stderr: CliOutput;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly homeDir: string;
  readonly deps: FsDeps;
  readonly zone: Zone;
  readonly budget: CollectBudget;
  // The locale that sets the first day of the week when no flag does. Defaults to
  // the locale of the process.
  readonly locale?: string;
}

const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

// The one place that prints.
function emit(out: CliOutput, result: Result<unknown, ErrorRecord>): number {
  const body = result.ok
    ? { schema: SCHEMA_ID, ok: true, data: result.value }
    : { schema: SCHEMA_ID, ok: false, error: { code: result.error.code, hint: result.error.hint } };
  out.write(`${JSON.stringify(body)}\n`);
  if (result.ok) return 0;
  return result.error.code === "usage_error" ? EXIT_USAGE : EXIT_ERROR;
}

function fail(code: ErrorCode): Result<never, ErrorRecord> {
  return err(errorRecord(code));
}

// Reads stdin to its end, up to `capBytes`. More than that is a usage error.
async function readBounded(stream: AsyncIterable<Buffer | string>, capBytes: number): Promise<Result<string, ErrorRecord>> {
  const parts: Buffer[] = [];
  let size = 0;
  let chunks = 0;
  try {
    for await (const chunk of stream) {
      const part = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += part.length;
      chunks += 1;
      // A chunk is at least one byte, so the loop ends within the cap.
      if (size > capBytes || chunks > capBytes + 1) return fail("usage_error");
      parts.push(part);
    }
  } catch {
    return fail("internal_error");
  }
  return ok(Buffer.concat(parts, size).toString("utf8"));
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

type CommandName =
  | "collect"
  | "status"
  | "usage"
  | "tasks sync"
  | "tasks"
  | "estimate"
  | "doctor"
  | "config"
  | "record"
  | "statusline";
type FlagName = "--data-dir" | "--claude-root" | "--codex-root" | "--week-start";

const SINGLE_WORD_COMMANDS: readonly string[] = ["collect", "status", "usage", "estimate", "doctor", "record", "statusline"];
const FLAG_NAMES: readonly string[] = ["--data-dir", "--claude-root", "--codex-root", "--week-start"];
const DATA_FLAGS: readonly FlagName[] = ["--data-dir"];
const ROOT_FLAGS: readonly FlagName[] = ["--data-dir", "--claude-root", "--codex-root"];
// The periods of status and usage take the first day of the week.
const PERIOD_FLAGS: readonly FlagName[] = ["--data-dir", "--week-start"];
// Root flags are for the two commands that look at the sources.
const COMMAND_FLAGS: Readonly<Record<CommandName, readonly FlagName[]>> = {
  collect: ROOT_FLAGS,
  doctor: ROOT_FLAGS,
  status: PERIOD_FLAGS,
  usage: PERIOD_FLAGS,
  tasks: DATA_FLAGS,
  "tasks sync": DATA_FLAGS,
  estimate: DATA_FLAGS,
  config: DATA_FLAGS,
  record: [],
  statusline: [],
};
const MAX_ARGS = 16;

type Command =
  | { readonly command: "config"; readonly setting: AppServerSetting | null }
  | { readonly command: Exclude<CommandName, "config"> };
type Parsed = Command & { readonly flags: ReadonlyMap<string, string> };

function commandOf(words: readonly string[]): Command | null {
  const [first, second, value] = words;
  if (first === "config") {
    if (words.length === 1) return { command: "config", setting: null };
    if (words.length !== 3 || second !== "app_server" || !isAppServerSetting(value)) return null;
    return { command: "config", setting: value };
  }
  if (first === undefined || words.length > 2) return null;
  if (first === "tasks") {
    if (second === undefined) return { command: "tasks" };
    return second === "sync" ? { command: "tasks sync" } : null;
  }
  if (second !== undefined || !SINGLE_WORD_COMMANDS.includes(first)) return null;
  return { command: first as Exclude<CommandName, "config"> };
}

// Strict: an unknown command or flag, a flag without a value, a repeated flag
// or a flag that the command does not take gives usage_error.
export function parseArgs(argv: readonly string[]): Result<Parsed, ErrorRecord> {
  if (argv.length > MAX_ARGS) return fail("usage_error");
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const value = equals === -1 ? argv[index + 1] : token.slice(equals + 1);
    if (equals === -1) index += 1;
    if (!FLAG_NAMES.includes(name) || flags.has(name)) return fail("usage_error");
    if (value === undefined || value === "" || (equals === -1 && value.startsWith("--"))) return fail("usage_error");
    flags.set(name, value);
  }
  const command = commandOf(words);
  if (command === null) return fail("usage_error");
  const allowed: readonly string[] = COMMAND_FLAGS[command.command];
  if (![...flags.keys()].every((name) => allowed.includes(name))) return fail("usage_error");
  return ok({ ...command, flags });
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface Ctx {
  readonly io: CliIo;
  readonly flags: ReadonlyMap<string, string>;
}

function rootsOf(ctx: Ctx): CollectRoots {
  const claude = ctx.flags.get("--claude-root");
  const codex = ctx.flags.get("--codex-root");
  return {
    claude: resolve(claude ?? join(ctx.io.homeDir, ".claude", "projects")),
    codex: resolve(codex ?? join(ctx.io.homeDir, ".codex", "sessions")),
  };
}

// The data folder, checked. A command that only reads does not create it: a
// folder that is not there yet means nothing was collected.
function dataDirOf(ctx: Ctx, create: boolean): Result<string, ErrorRecord> {
  const { io } = ctx;
  const path = resolveDataDirPath({
    flag: ctx.flags.get("--data-dir") ?? null,
    env: io.env,
    platform: io.platform,
    homeDir: io.homeDir,
  });
  const prepared = create ? prepareDataDir(path, io.deps) : existingDataDir(path, io.deps);
  if (prepared.ok) return prepared;
  if (!create && prepared.error.code === "not_found") return fail("not_collected");
  const unsafe = prepared.error.code === "data_dir_unsafe" || prepared.error.code === "bad_input";
  return fail(unsafe ? "data_dir_unsafe" : "internal_error");
}

// A store error ends the command with its code. A damaged store file also marks
// the snapshot as stopped, so that `status` tells it. That is the only write: no
// store data file changes. A newer store gets no write at all.
function markStopped(dataDir: string, deps: FsDeps): void {
  const current = readSnapshot(dataDir, deps);
  // A snapshot of a newer tokenmeter is left alone.
  if (!current.ok && current.error.code === "store_newer") return;
  // A failed write changes nothing: the command ends with the same error.
  writeSnapshot(dataDir, { stopped: "store_corrupt", data: null, report: null }, deps);
}

function stopOn(dataDir: string, error: StoreError | CollectError, deps: FsDeps): ErrorRecord {
  if (error.code === "store_corrupt") markStopped(dataDir, deps);
  return errorRecord(error.code);
}

// ---------------------------------------------------------------------------
// collect
// ---------------------------------------------------------------------------

function collectCommand(ctx: Ctx): Result<unknown, ErrorRecord> {
  const { deps, zone, budget } = ctx.io;
  const dir = dataDirOf(ctx, true);
  if (!dir.ok) return dir;
  const dataDir = dir.value;

  const scanned = collect({ dataDir, roots: rootsOf(ctx), budget, zone }, deps);
  if (!scanned.ok) return err(stopOn(dataDir, scanned.error, deps));
  const report = scanned.value;
  const nowMs = deps.nowMs();

  const quota = storeCodexQuota(dataDir, report.codexQuota, deps);
  if (!quota.ok) return fail("internal_error");
  const complete = report.backlogBytes === 0;
  const frozen = freezeTasks(dataDir, nowMs, complete, deps);
  if (!frozen.ok) return err(stopOn(dataDir, frozen.error, deps));

  const state: CollectState = complete ? "ok" : "counting";
  // The bucket rows are read once, for the analysis and for the task windows.
  const rows = loadBucketRows(dataDir, nowMs, deps);
  if (!rows.ok) return err(stopOn(dataDir, rows.error, deps));
  const analysis = readAnalysis(dataDir, nowMs, zone, state, rows.value, deps);
  const tasks = loadTaskWindows(dataDir, deps);
  if (!tasks.ok) return err(stopOn(dataDir, tasks.error, deps));
  const history = loadTaskHistory(dataDir, deps);
  if (!history.ok) return err(stopOn(dataDir, history.error, deps));
  // Every known window splits its rows with every other known window. The
  // finished windows give the tokens of a finished task inside the periods.
  const usage = tasks.value.windows.length > 0 ? attribute(tasks.value.windows, rows.value, periodSlots(analysis)) : [];

  const progressPct = progressPercent(report.totalBytes, report.backlogBytes);
  const log = readEstimateLog(dataDir, nowMs, deps);
  const built = buildStatus({
    nowMs,
    analysis,
    collectState: state,
    progressPct,
    roots: report.roots,
    usage,
    history: history.value.entries,
    openItems: tasks.value.open,
    pool: poolFromEnv(ctx.io.env),
    estimateLog: { lines: log.lines, damaged: log.damaged > 0 },
  });
  const featuresRefused = tasks.value.featuresRefused + history.value.featuresRefused;
  const counters = countersOf({ report, quota: quota.value, freeze: frozen.value, featuresRefused, estimateLog: log });
  const published = publishCollect(dataDir, { built, counters, log, finished: history.value.entries, tasks: tasks.value }, deps);
  if (!published.ok) return published;
  return ok({
    at: nowMs,
    state,
    progress_pct: progressPct,
    counters,
    estimate_log: published.value,
    days_backfill: report.backfill,
  });
}

// What the estimate log did in a collect: lines written, lines refused at the
// cap, lines that failed, month files deleted, and deletes that failed. This is in
// the result of collect only: the snapshot has no counter for it.
interface EstimateLogReport {
  readonly appended: number;
  readonly refused_at_cap: number;
  readonly append_failed: number;
  readonly pruned: number;
  readonly prune_failed: number;
}

interface EstimateLogUpdate {
  // The lines to write, and the read of this pass that says which months it read.
  readonly lines: readonly EstimateLogLine[];
  readonly read: MonthAccess;
  readonly keepAtMs: number | null;
}

// Appends the new lines to the months that this pass read, then prunes the month
// files older than the keep time. A log that could not be read safely has no keep
// time, so it is not pruned.
function updateEstimateLog(dataDir: string, { lines, read, keepAtMs }: EstimateLogUpdate, deps: FsDeps): EstimateLogReport {
  const appended = appendEstimateLines(dataDir, lines, read, deps);
  const pruned = pruneEstimateLog(dataDir, keepAtMs);
  return {
    appended: appended.appended,
    refused_at_cap: appended.full,
    append_failed: appended.failed,
    pruned: pruned.removed,
    prune_failed: pruned.failed,
  };
}

// What collect publishes after it built the status.
interface Publication {
  readonly built: BuiltStatus;
  readonly counters: Counters;
  // The read of the estimate log that the status was built with.
  readonly log: EstimateLogRead;
  // What the keep rule needs: the finished tasks, and the open items and windows
  // of the last sync.
  readonly finished: readonly TaskEntry[];
  readonly tasks: StoredTasks;
}

// Writes the snapshot, then appends the lines to the estimate log, then prunes it.
// The order matters: a failed snapshot write leaves the log as it was.
function publishCollect(
  dataDir: string,
  { built, counters, log, finished, tasks }: Publication,
  deps: FsDeps,
): Result<EstimateLogReport, ErrorRecord> {
  const written = writeSnapshot(dataDir, { stopped: null, data: built.data, report: counters }, deps);
  if (!written.ok) return fail("internal_error");
  const keepAtMs = keepTime({
    lines: log.lines,
    damaged: log.damaged > 0,
    finished,
    openKeys: tasks.open.map((item) => item.key),
    windows: tasks.windows,
  });
  // A failure here is told in this result only. The snapshot stays, and the next
  // collect writes the same lines again, because they are compared with the log.
  return ok(updateEstimateLog(dataDir, { lines: built.logLines, read: log, keepAtMs }, deps));
}

// ---------------------------------------------------------------------------
// status, usage, tasks, estimate
// ---------------------------------------------------------------------------

// The snapshot with data. A folder with no snapshot was never collected; a
// stopped snapshot answers with the code of the stop.
function loadData(ctx: Ctx): Result<{ readonly dataDir: string; readonly snapshot: Snapshot; readonly data: StatusData }, ErrorRecord> {
  const dir = dataDirOf(ctx, false);
  if (!dir.ok) return dir;
  const snapshot = readSnapshot(dir.value, ctx.io.deps);
  if (!snapshot.ok) return fail(snapshot.error.code);
  if (snapshot.value === null) return fail("not_collected");
  const { stopped, data } = snapshot.value;
  if (stopped !== null) return fail(stopped);
  if (data === null) return fail("store_corrupt");
  return ok({ dataDir: dir.value, snapshot: snapshot.value, data });
}

interface Current {
  readonly dataDir: string;
  readonly data: StatusData;
}

function currentStatus(ctx: Ctx): Result<Current, ErrorRecord> {
  const loaded = loadData(ctx);
  if (!loaded.ok) return loaded;
  const { dataDir } = loaded.value;
  const nowMs = ctx.io.deps.nowMs();
  const latest = readLatestQuota(dataDir, nowMs, ctx.io.deps);
  return ok({ dataDir, data: overlayClaudeQuota(loaded.value.data, latest, poolFromEnv(ctx.io.env), nowMs) });
}

// The first day of the week: the flag, else the first weekday of the locale.
function weekStartOf(ctx: Ctx): Result<Weekday, ErrorRecord> {
  const flag = ctx.flags.get("--week-start");
  if (flag === undefined) return ok(firstWeekdayOf(ctx.io.locale ?? systemLocale()));
  return isWeekday(flag) ? ok(flag) : fail("usage_error");
}

// The faults of days.json that status and usage tell in `periods_error` and do
// not fail on: the rest of their output does not depend on the file.
type DaysFault = Exclude<StoreError["code"], "internal_error">;

function isDaysFault(code: StoreError["code"]): code is DaysFault {
  return code !== "internal_error";
}

// The bytes that the periods may take: the budget of the whole output less the
// output without them.
function periodsBudget(rest: StatusData): number {
  const framed = JSON.stringify({ schema: SCHEMA_ID, ok: true, data: { ...rest, periods: null, periods_error: null } });
  // One more byte for the line end.
  return Math.max(0, STATUS_OUTPUT_MAX_BYTES - Buffer.byteLength(framed) - 1);
}

interface PeriodsPart {
  readonly periods: PeriodsJson | null;
  readonly periods_error: DaysFault | null;
}

// The days, weeks and months come from days.json, read when the command runs:
// the snapshot stays small, and a day row is as new as the last collect. A damaged,
// newer or too large file gives no periods and its code; any other fault fails.
function periodsPart(ctx: Ctx, dataDir: string, shaped: StatusData, weekStart: Weekday): Result<PeriodsPart, ErrorRecord> {
  const rows = loadDayRows(dataDir, ctx.io.deps);
  if (!rows.ok) {
    return isDaysFault(rows.error.code) ? ok({ periods: null, periods_error: rows.error.code }) : fail(rows.error.code);
  }
  const periods = periodsOf({
    rows: rows.value,
    zone: ctx.io.zone,
    nowMs: ctx.io.deps.nowMs(),
    weekStart,
    collect: { at: shaped.collect.at, complete: shaped.collect.state === "ok" },
    account: null,
    maxBytes: periodsBudget(shaped),
  });
  return ok({ periods, periods_error: null });
}

function withPeriods(ctx: Ctx, shape: (data: StatusData) => StatusData): Result<unknown, ErrorRecord> {
  const weekStart = weekStartOf(ctx);
  if (!weekStart.ok) return weekStart;
  const current = currentStatus(ctx);
  if (!current.ok) return current;
  const shaped = shape(current.value.data);
  const part = periodsPart(ctx, current.value.dataDir, shaped, weekStart.value);
  return part.ok ? ok({ ...shaped, ...part.value }) : part;
}

function statusCommand(ctx: Ctx): Result<unknown, ErrorRecord> {
  return withPeriods(ctx, withTopModels);
}

function usageCommand(ctx: Ctx): Result<unknown, ErrorRecord> {
  return withPeriods(ctx, (data) => data);
}

// The tasks of the snapshot, with the week percents of the latest Claude quota,
// so that they agree with `status`.
function tasksCommand(ctx: Ctx): Result<unknown, ErrorRecord> {
  const current = currentStatus(ctx);
  return current.ok ? ok({ tasks: current.value.data.tasks }) : current;
}

async function tasksSyncCommand(ctx: Ctx): Promise<Result<unknown, ErrorRecord>> {
  const text = await readBounded(ctx.io.stdin, SYNC_MAX_BYTES);
  if (!text.ok) return text;
  const dir = dataDirOf(ctx, true);
  if (!dir.ok) return dir;
  const synced = sync(dir.value, text.value, ctx.io.deps.nowMs(), ctx.io.deps);
  if (!synced.ok) return err(synced.error);
  const warning = collisionWarning(synced.value.collisions);
  if (warning !== null) ctx.io.stderr.write(warning);
  return ok(synced.value);
}

async function estimateCommand(ctx: Ctx): Promise<Result<unknown, ErrorRecord>> {
  const text = await readBounded(ctx.io.stdin, SYNC_MAX_BYTES);
  if (!text.ok) return text;
  const input = parseEstimateInput(text.value);
  if (!input.ok) return input;
  const loaded = loadData(ctx);
  if (!loaded.ok) return loaded;
  const history = loadTaskHistory(loaded.value.dataDir, ctx.io.deps);
  if (!history.ok) return err(stopOn(loaded.value.dataDir, history.error, ctx.io.deps));
  const estimates = estimateFromSignals(
    input.value.items,
    history.value.entries,
    calibrationsOf(loaded.value.data),
    input.value.subscription,
  );
  return ok({
    refused: input.value.refused,
    refused_features: input.value.featuresRefused,
    estimates: estimates.map(estimateJson),
  });
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

function storeVersion(dataDir: string, deps: FsDeps): Result<number | null, StoreError> {
  const read = readJson(dataDir, STORE_FILE, FILE_CAPS.store, deps);
  if (!read.ok) return read;
  if (read.value === undefined) return ok(null);
  const body = openVersioned(STORE_FILE, read.value);
  if (!body.ok) return body;
  const version = body.value["version"];
  return ok(typeof version === "number" ? version : null);
}

function doctorCommand(ctx: Ctx): Result<unknown, ErrorRecord> {
  const { deps } = ctx.io;
  const dir = dataDirOf(ctx, false);
  if (!dir.ok) return dir;
  const dataDir = dir.value;
  const nowMs = deps.nowMs();

  const version = storeVersion(dataDir, deps);
  if (!version.ok) return fail(version.error.code);
  const snapshot = readSnapshot(dataDir, deps);
  if (!snapshot.ok) return fail(snapshot.error.code);
  const tasks = loadTaskWindows(dataDir, deps);
  if (!tasks.ok) return fail(tasks.error.code);
  const history = loadTaskHistory(dataDir, deps);
  if (!history.ok) return fail(history.error.code);
  const crossDay = crossDayClaudeKeys(dataDir, nowMs, deps);
  if (!crossDay.ok) return fail(crossDay.error.code);

  const snap = snapshot.value;
  const roots = rootsOf(ctx);
  const codex = snap?.data?.subscriptions.find((sub) => sub.id === "codex") ?? null;
  const pool = poolFromEnv(ctx.io.env);
  return ok({
    store: { version: version.value },
    snapshot: {
      state: snap === null ? "missing" : snap.stopped === null ? "ok" : "stopped",
      stopped: snap?.stopped ?? null,
      at: snap?.data?.written_at ?? null,
    },
    counters: snap?.report ?? null,
    roots: { claude: rootStateOf(roots.claude), codex: rootStateOf(roots.codex) },
    quota: { claude: claudeQuotaJson(readLatestQuota(dataDir, nowMs, deps)), codex: codex?.quota ?? null },
    tasks: { windows: tasks.value.windows.length, open: tasks.value.open.length, finished: history.value.entries.length },
    cross_day_claude_keys: crossDay.value,
    pool: { mode: pool.mode, reason: pool.mode === "separate" ? pool.reason : null },
  });
}

function configCommand(ctx: Ctx, setting: AppServerSetting | null): Result<unknown, ErrorRecord> {
  const dir = dataDirOf(ctx, setting !== null);
  if (!dir.ok) {
    if (setting === null && dir.error.code === "not_collected") return ok({ app_server: DEFAULT_APP_SERVER });
    return dir;
  }
  const { deps } = ctx.io;
  if (setting === null) return ok({ app_server: readAppServerSetting(dir.value, deps) });
  const wrote = writeAppServerSetting(dir.value, setting, deps);
  return wrote.ok ? ok({ app_server: setting, data_dir: dir.value }) : fail("internal_error");
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

type Handler = (ctx: Ctx) => Result<unknown, ErrorRecord> | Promise<Result<unknown, ErrorRecord>>;

const HANDLERS: Readonly<Record<Exclude<CommandName, "record" | "statusline" | "config">, Handler>> = {
  collect: collectCommand,
  status: statusCommand,
  usage: usageCommand,
  tasks: tasksCommand,
  "tasks sync": tasksSyncCommand,
  estimate: estimateCommand,
  doctor: doctorCommand,
};

// Runs one command and returns the exit code. It catches everything: a failure
// that no command expected gives internal_error, with no message text.
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (!parsed.ok) return emit(io.stdout, parsed);
    const { command, flags } = parsed.value;
    if (command === "record") {
      await recordMain();
      return 0;
    }
    if (command === "statusline") {
      await statuslineMain();
      return 0;
    }
    if (command === "config") return emit(io.stdout, configCommand({ io, flags }, parsed.value.setting));
    return emit(io.stdout, await HANDLERS[command]({ io, flags }));
  } catch {
    return emit(io.stdout, fail("internal_error"));
  }
}

function processIo(): CliIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    platform: process.platform,
    homeDir: homedir(),
    deps: defaultDeps(),
    zone: localZone(),
    budget: DEFAULT_BUDGET,
  };
}

// The bin calls this. It sets the exit code and never calls process.exit, so
// the output is written in full before the process ends.
export async function cliMain(): Promise<void> {
  process.stdout.on("error", () => undefined);
  process.stderr.on("error", () => undefined);
  try {
    process.exitCode = await runCli(process.argv.slice(2), processIo());
  } catch {
    process.exitCode = emit(process.stdout, fail("internal_error"));
  }
}
