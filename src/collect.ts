// One collect pass (plan 3.3, 3.4, 3.8).
//
// Finds the Claude and Codex files inside the horizon, newest first, reads the
// new lines of each within a byte and time budget, and counts them into the
// store. The roots, the budget, the clock and the data folder are parameters:
// nothing here reads a default home path.
//
// The pass keeps its changes in memory and writes them at the end. An error
// before that point (a damaged or newer store file, a held lock) writes nothing.
// The pass refreshes its lock while it works. It checks that it still holds the
// lock right before the write: a lock that another pass took over writes nothing.

import { realpathSync } from "node:fs";
import { isAbsolute, join, sep } from "node:path";
import {
  BACKFILL_BUDGET_BYTES,
  BACKFILL_BUDGET_MS,
  BACKFILL_MAX_KEYS,
  LOCK_REFRESH_MS,
  type Result,
  MAX_ENTRIES_PER_FOLDER,
  SCAN_BUDGET_BYTES,
  SCAN_BUDGET_MS,
  err,
  ok,
} from "./core.ts";
import { cutoffDateOf } from "./days.ts";
import {
  type FsDeps,
  type FsError,
  type Lock,
  acquireLock,
  attemptFs,
  defaultDeps,
  lstatEntry,
  listDir,
  refreshLock,
  releaseLock,
} from "./fsafe.ts";
import { type RowScan, readRows } from "./lines.ts";
import { type Zone, localZone } from "./periods.ts";
import {
  CLAUDE_PARSER_REV,
  CODEX_INITIAL_STATE,
  type CodexFileState,
  type CodexQuotaSample,
  type QuotaWindow,
  parseClaudeRow,
  stepCodexRow,
} from "./sources.ts";
import {
  DAY_MS,
  type Applied,
  type CodexSnapshot,
  type DedupeEntry,
  type LedgerEntry,
  type Provider,
  Store,
  type StoreError,
  fileKeyOf,
  horizonStartMs,
  slotOf,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RootState = "scanned" | "missing" | "skipped" | "unsafe";

export interface CollectRoots {
  // Absolute path of the Claude projects folder, or null to skip it.
  readonly claude: string | null;
  // Absolute path of the Codex sessions folder, or null to skip it.
  readonly codex: string | null;
}

export interface CollectBudget {
  // Bytes read from source files in one pass. At least 1.
  readonly bytes: number;
  // Wall time of one pass. The walk over the source folders checks it between
  // folders, and the scan checks it between files. A pass always reads one file.
  readonly ms: number;
}

export interface CollectInput {
  // A data folder that prepareDataDir has accepted.
  readonly dataDir: string;
  readonly roots: CollectRoots;
  readonly budget: CollectBudget;
  // Entries read per folder. Defaults to MAX_ENTRIES_PER_FOLDER.
  readonly maxEntriesPerFolder?: number;
  // Files found in one pass, both providers together. Defaults to MAX_FILES_PER_PASS.
  readonly maxFilesPerPass?: number;
  // The zone of the local days in the day rows. Defaults to the zone of this process.
  readonly zone?: Zone;
  // The limits of the one-time backfill of the day rows: bytes read, wall time in
  // ms, and message keys held in memory. They default to BACKFILL_BUDGET_BYTES,
  // BACKFILL_BUDGET_MS and BACKFILL_MAX_KEYS.
  readonly maxBackfillBytes?: number;
  readonly maxBackfillMs?: number;
  readonly maxBackfillKeys?: number;
}

export interface CollectError {
  readonly code: "store_corrupt" | "store_newer" | "store_too_large" | "lock_held" | "internal_error";
  // The store file name when a store file is the cause, else null.
  readonly file: string | null;
}

export interface RowCounts {
  // Messages and events counted for the first time.
  readonly counted: number;
  // Found again with nothing to change.
  readonly repeats: number;
  // A Claude repeat with a larger output replaced the counted values.
  readonly replaced: number;
  // A repeat with an earlier time moved the counted values to the earlier slot.
  readonly moved: number;
  readonly beforeHorizon: number;
  // Skipped rows by reason code.
  readonly skipped: Readonly<Record<string, number>>;
  readonly badJson: number;
  readonly notObject: number;
  readonly skippedLong: number;
  // Codex events counted for the first time whose cache write count was not valid.
  // The count was taken as 0 and the event stays counted.
  readonly codexCacheInvalid: number;
}

// The one-time backfill of the day rows from the logs. It runs in the first
// pass that finds no mark of it in the days file.
export interface BackfillReport {
  readonly ran: boolean;
  // Files it read, and entries it added to the day rows.
  readonly files: number;
  readonly rows: number;
  // True when a limit ended it before it had read everything.
  readonly cut: boolean;
}

export interface CollectReport {
  readonly stoppedBy: "none" | "bytes" | "time";
  readonly roots: { readonly claude: RootState; readonly codex: RootState };
  // Files inside the horizon.
  readonly files: number;
  readonly filesRead: number;
  readonly bytesRead: number;
  // Bytes of those files, and the part not read yet. Progress is 1 - backlog / total.
  readonly totalBytes: number;
  readonly backlogBytes: number;
  readonly rows: RowCounts;
  readonly skippedLinks: number;
  readonly unreadable: number;
  readonly cappedFolders: number;
  readonly prunedFiles: number;
  // Stays 0 unless the store files disagree. For the doctor.
  readonly bucketUnderflow: number;
  readonly filesWritten: number;
  readonly backfill: BackfillReport;
  // Codex limit samples of this pass, in time order, for the caller to store.
  readonly codexQuota: readonly CodexQuotaSample[];
}

export const DEFAULT_BUDGET: CollectBudget = { bytes: SCAN_BUDGET_BYTES, ms: SCAN_BUDGET_MS };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_FILE = "collect.lock";
const CLAUDE_PREFILTER: readonly string[] = ['"usage"'];
export const CODEX_PREFILTER: readonly string[] = ["token_count", "session_meta", "turn_context"];
const MAX_FILES_PER_PASS = 100_000;
const SUBAGENTS_FOLDER = "subagents";
const JSONL_SUFFIX = ".jsonl";
const CODEX_FILE = /^rollout-.*\.jsonl$/;
const FOUR_DIGITS = /^\d{4}$/;
const TWO_DIGITS = /^\d{2}$/;

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

interface Candidate {
  readonly path: string;
  readonly provider: Provider;
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}

// The time the walk may take: it ends at the first folder after `deadlineMs`.
interface WalkClock {
  readonly nowMs: () => number;
  readonly deadlineMs: number;
}

interface Finder {
  readonly allowFirstFile: boolean;
  readonly horizonMs: number;
  readonly maxEntries: number;
  readonly maxFiles: number;
  readonly clock: WalkClock;
  readonly found: Candidate[];
  // Files found for each provider.
  readonly foundBy: Record<Provider, number>;
  skippedLinks: number;
  cappedFolders: number;
  // True when the listing of a provider may have missed files. Its ledger is then kept whole.
  readonly incomplete: Record<Provider, boolean>;
  // True when the walk of a provider ended early, at the file cap or at the deadline.
  readonly halted: Record<Provider, boolean>;
}

interface OpenedRoot {
  readonly state: RootState;
  // The canonical path of the root, when it can be scanned.
  readonly real: string | null;
}

function openRoot(root: string | null): OpenedRoot {
  if (root === null) return { state: "skipped", real: null };
  if (!isAbsolute(root)) return { state: "unsafe", real: null };
  const resolved = attemptFs(() => realpathSync.native(root));
  if (!resolved.ok) return { state: resolved.error.code === "not_found" ? "missing" : "unsafe", real: null };
  const info = lstatEntry(resolved.value);
  if (!info.ok || !info.value.isDirectory()) return { state: "unsafe", real: null };
  return { state: "scanned", real: resolved.value };
}

// What a collect would find at the root: the doctor looks at it without a scan.
export function rootStateOf(root: string | null): RootState {
  return openRoot(root).state;
}

function isInside(realRoot: string, path: string): boolean {
  const resolved = attemptFs(() => realpathSync.native(path));
  return resolved.ok && (resolved.value === realRoot || resolved.value.startsWith(`${realRoot}${sep}`));
}

function haltWalk(finder: Finder, provider: Provider): void {
  finder.halted[provider] = true;
  finder.incomplete[provider] = true;
}

// Collect checks its deadline only after it finds a file for this provider.
function walkStopped(finder: Finder, provider: Provider): boolean {
  if (!finder.halted[provider] && (!finder.allowFirstFile || finder.foundBy[provider] > 0)
    && finder.clock.nowMs() >= finder.clock.deadlineMs) haltWalk(finder, provider);
  return finder.halted[provider];
}

function listFolder(finder: Finder, provider: Provider, path: string): readonly string[] {
  if (walkStopped(finder, provider)) return [];
  const listing = listDir(path, finder.maxEntries);
  if (!listing.ok) {
    finder.incomplete[provider] = true;
    return [];
  }
  if (listing.value.capped) {
    finder.cappedFolders += 1;
    finder.incomplete[provider] = true;
  }
  return listing.value.names;
}

// A real folder under the root: not a link, and its realpath is inside the root.
function enterFolder(finder: Finder, provider: Provider, realRoot: string, path: string): boolean {
  const info = lstatEntry(path);
  if (!info.ok) {
    if (info.error.code !== "not_found") finder.incomplete[provider] = true;
    return false;
  }
  if (info.value.isSymbolicLink()) {
    finder.skippedLinks += 1;
    return false;
  }
  return info.value.isDirectory() && isInside(realRoot, path);
}

// A regular file that is not a link. A link is counted and skipped. At the file
// cap the walk ends, before it looks at the file.
function addFile(finder: Finder, provider: Provider, path: string, checkAge: boolean, realRoot?: string): void {
  if (finder.found.length >= finder.maxFiles) {
    haltWalk(finder, provider);
    return;
  }
  const info = lstatEntry(path);
  if (!info.ok) {
    if (info.error.code !== "not_found") finder.incomplete[provider] = true;
    return;
  }
  const stats = info.value;
  if (stats.isSymbolicLink()) {
    finder.skippedLinks += 1;
    return;
  }
  if (!stats.isFile() || (checkAge && stats.mtimeMs < finder.horizonMs)) return;
  if (realRoot !== undefined && !isInside(realRoot, path)) return;
  finder.found.push({ path, provider, size: stats.size, mtimeMs: stats.mtimeMs, dev: stats.dev, ino: stats.ino });
  finder.foundBy[provider] += 1;
}

function addFolderFiles(finder: Finder, provider: Provider, folder: string, wanted: (name: string) => boolean): void {
  for (const name of listFolder(finder, provider, folder)) {
    if (finder.halted[provider]) return;
    if (wanted(name)) addFile(finder, provider, join(folder, name), provider === "claude");
  }
}

function isClaudeFile(name: string): boolean {
  return name.endsWith(JSONL_SUFFIX);
}

function findClaude(finder: Finder, realRoot: string): void {
  for (const project of listFolder(finder, "claude", realRoot)) {
    if (finder.halted.claude) return;
    const projectPath = join(realRoot, project);
    if (!enterFolder(finder, "claude", realRoot, projectPath)) continue;
    for (const name of listFolder(finder, "claude", projectPath)) {
      if (finder.halted.claude) return;
      const path = join(projectPath, name);
      if (isClaudeFile(name)) {
        addFile(finder, "claude", path, true);
        continue;
      }
      // A session folder may hold subagents/*.jsonl. The session folder is
      // checked first: a path through a link would be followed otherwise.
      if (!enterFolder(finder, "claude", realRoot, path)) continue;
      const subagents = join(path, SUBAGENTS_FOLDER);
      if (enterFolder(finder, "claude", realRoot, subagents)) addFolderFiles(finder, "claude", subagents, isClaudeFile);
    }
  }
}

function numbered(names: readonly string[], pattern: RegExp): readonly (readonly [string, number])[] {
  return names.filter((name) => pattern.test(name)).map((name): [string, number] => [name, Number(name)]);
}

// Folders are YYYY/MM/DD in local time, so the first day of the horizon is
// read with one day of slack.
function findCodex(finder: Finder, realRoot: string): void {
  const floor = new Date(finder.horizonMs - DAY_MS);
  const floorStamp = floor.getUTCFullYear() * 10_000 + (floor.getUTCMonth() + 1) * 100 + floor.getUTCDate();
  for (const [year, y] of numbered(listFolder(finder, "codex", realRoot), FOUR_DIGITS)) {
    if (finder.halted.codex) return;
    if (y * 10_000 + 1231 < floorStamp) continue;
    const yearPath = join(realRoot, year);
    if (!enterFolder(finder, "codex", realRoot, yearPath)) continue;
    for (const [month, m] of numbered(listFolder(finder, "codex", yearPath), TWO_DIGITS)) {
      if (finder.halted.codex) return;
      if (y * 10_000 + m * 100 + 31 < floorStamp) continue;
      const monthPath = join(yearPath, month);
      if (!enterFolder(finder, "codex", realRoot, monthPath)) continue;
      for (const [day, d] of numbered(listFolder(finder, "codex", monthPath), TWO_DIGITS)) {
        if (finder.halted.codex) return;
        if (y * 10_000 + m * 100 + d < floorStamp) continue;
        const dayPath = join(monthPath, day);
        if (!enterFolder(finder, "codex", realRoot, dayPath)) continue;
        addFolderFiles(finder, "codex", dayPath, (name) => CODEX_FILE.test(name));
      }
    }
  }
}

function newestFirst(a: Candidate, b: Candidate): number {
  if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

const CODEX_WALK_LIMITS = { maxDays: 14, maxFilesPerDay: 200, walkMs: 1000 };
const CODEX_MTIME_AGE_MS = 8 * DAY_MS;

type CodexWalkLimits = Readonly<typeof CODEX_WALK_LIMITS>;

function descendingNames(finder: Finder, path: string, pattern: RegExp): string[] {
  return listFolder(finder, "codex", path).filter((name) => pattern.test(name)).sort().reverse();
}

// A rollout folder gives its start day, not its last use. Search the newest day
// folders by name, then rank the recent files by mtime. Do not floor by day date.
export function findCodexFiles(
  root: string,
  nowMs: number,
  limits: CodexWalkLimits = CODEX_WALK_LIMITS,
  deps: FsDeps = defaultDeps(),
): Result<readonly Candidate[], FsError> {
  const { maxDays, maxFilesPerDay, walkMs } = limits;
  if (!Number.isSafeInteger(nowMs) || nowMs < 0
    || !isCount(maxDays) || maxDays > CODEX_WALK_LIMITS.maxDays
    || !isCount(maxFilesPerDay) || maxFilesPerDay > CODEX_WALK_LIMITS.maxFilesPerDay
    || !isCount(walkMs) || walkMs > CODEX_WALK_LIMITS.walkMs) return err({ code: "bad_input", sys: null });
  const clock = { nowMs: deps.nowMs, deadlineMs: deps.nowMs() + walkMs };
  const { state, real } = openRoot(root);
  if (state === "unsafe") return err({ code: "unsafe_file", sys: null });
  if (real === null || maxDays === 0 || maxFilesPerDay === 0) return ok([]);
  const finder = makeFinder(nowMs - CODEX_MTIME_AGE_MS, MAX_ENTRIES_PER_FOLDER, maxDays * maxFilesPerDay, clock, false);
  findCodexByMtime(finder, real, maxDays, maxFilesPerDay);
  return ok(finder.found.sort(newestFirst));
}

function findCodexByMtime(finder: Finder, real: string, maxDays: number, maxFilesPerDay: number): void {
  let days = 0;
  for (const year of descendingNames(finder, real, FOUR_DIGITS)) {
    if (walkStopped(finder, "codex")) return;
    const yearPath = join(real, year);
    if (!enterFolder(finder, "codex", real, yearPath)) continue;
    for (const month of descendingNames(finder, yearPath, TWO_DIGITS)) {
      if (walkStopped(finder, "codex")) return;
      const monthPath = join(yearPath, month);
      if (!enterFolder(finder, "codex", real, monthPath)) continue;
      for (const day of descendingNames(finder, monthPath, TWO_DIGITS)) {
        if (walkStopped(finder, "codex")) return;
        const dayPath = join(monthPath, day);
        if (!enterFolder(finder, "codex", real, dayPath)) continue;
        days += 1;
        for (const name of descendingNames(finder, dayPath, CODEX_FILE).slice(0, maxFilesPerDay)) {
          if (walkStopped(finder, "codex")) return;
          addFile(finder, "codex", join(dayPath, name), true, real);
        }
        if (days >= maxDays) return;
      }
    }
  }
}

interface Discovery {
  readonly candidates: readonly Candidate[];
  readonly roots: { readonly claude: RootState; readonly codex: RootState };
  readonly finder: Finder;
}

function makeFinder(horizonMs: number, maxEntries: number, maxFiles: number, clock: WalkClock, allowFirstFile: boolean): Finder {
  return {
    horizonMs,
    maxEntries,
    maxFiles,
    clock,
    allowFirstFile,
    found: [],
    foundBy: { claude: 0, codex: 0 },
    skippedLinks: 0,
    cappedFolders: 0,
    incomplete: { claude: false, codex: false },
    halted: { claude: false, codex: false },
  };
}

function discover(input: CollectInput, horizonMs: number, clock: WalkClock): Discovery {
  const finder = makeFinder(
    horizonMs, input.maxEntriesPerFolder ?? MAX_ENTRIES_PER_FOLDER, input.maxFilesPerPass ?? MAX_FILES_PER_PASS, clock, true,
  );
  const claude = openRoot(input.roots.claude);
  const codex = openRoot(input.roots.codex);
  if (claude.real !== null) findClaude(finder, claude.real);
  if (codex.real !== null) findCodex(finder, codex.real);
  return {
    candidates: [...finder.found].sort(newestFirst),
    roots: { claude: claude.state, codex: codex.state },
    finder,
  };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

interface Tally {
  counted: number;
  repeats: number;
  replaced: number;
  moved: number;
  beforeHorizon: number;
  badJson: number;
  notObject: number;
  skippedLong: number;
  codexCacheInvalid: number;
  readonly skipped: Record<string, number>;
}

function newTally(): Tally {
  return {
    counted: 0,
    repeats: 0,
    replaced: 0,
    moved: 0,
    beforeHorizon: 0,
    badJson: 0,
    notObject: 0,
    skippedLong: 0,
    codexCacheInvalid: 0,
    skipped: {},
  };
}

function noteApplied(tally: Tally, applied: Applied): void {
  if (applied === "added") tally.counted += 1;
  else if (applied === "repeat") tally.repeats += 1;
  else if (applied === "replaced") tally.replaced += 1;
  else if (applied === "moved") tally.moved += 1;
  else {
    tally.replaced += 1;
    tally.moved += 1;
  }
}

function noteSkip(tally: Tally, reason: string): void {
  tally.skipped[reason] = (tally.skipped[reason] ?? 0) + 1;
}

function noteScan(tally: Tally, scan: RowScan): void {
  tally.badJson += scan.badJson;
  tally.notObject += scan.notObject;
  tally.skippedLong += scan.skippedLong;
}

interface TokenColumns {
  readonly input: number;
  readonly cacheWrite5m: number;
  readonly cacheWrite1h: number;
  readonly cacheRead: number;
  readonly output: number;
}

function entryOf(at: number, model: string, folderKey: string, tokens: TokenColumns): DedupeEntry {
  return [
    slotOf(at),
    model,
    folderKey,
    tokens.input,
    tokens.cacheWrite5m,
    tokens.cacheWrite1h,
    tokens.cacheRead,
    tokens.output,
  ];
}

// Keeps the first and the last sample of each run of equal samples per window,
// so a long quiet stretch does not fill the list.
interface Run {
  readonly first: CodexQuotaSample;
  last: CodexQuotaSample;
}

class QuotaRuns {
  readonly #out: CodexQuotaSample[];
  readonly #runs = new Map<QuotaWindow, Run>();

  constructor(out: CodexQuotaSample[]) {
    this.#out = out;
  }

  add(sample: CodexQuotaSample): void {
    const run = this.#runs.get(sample.window);
    if (run !== undefined && run.first.usedPercent === sample.usedPercent && run.first.resetsAt === sample.resetsAt) {
      run.last = sample;
      return;
    }
    if (run !== undefined) this.#close(run);
    this.#runs.set(sample.window, { first: sample, last: sample });
  }

  finish(): void {
    for (const run of this.#runs.values()) this.#close(run);
    this.#runs.clear();
  }

  #close(run: Run): void {
    this.#out.push(run.first);
    if (run.last !== run.first) this.#out.push(run.last);
  }
}

function sampleOrder(a: CodexQuotaSample, b: CodexQuotaSample): number {
  if (a.at !== b.at) return a.at - b.at;
  if (a.window === b.window) return 0;
  return a.window < b.window ? -1 : 1;
}

function restoreState(snapshot: CodexSnapshot): CodexFileState {
  return { ...snapshot, sessionId: null };
}

function snapshotOf(state: CodexFileState): CodexSnapshot {
  return { metaSeen: state.metaSeen, folderKey: state.folderKey, model: state.model, previous: state.previous };
}

// ---------------------------------------------------------------------------
// The pass
// ---------------------------------------------------------------------------

interface Pass {
  readonly store: Store;
  readonly deps: FsDeps;
  readonly nowMs: number;
  readonly horizonMs: number;
  readonly tally: Tally;
  readonly quota: CodexQuotaSample[];
  // True for the scan of the backfill: it keeps the rows before the horizon for
  // the day rows and ignores the rest. The normal scan counts the rows from the
  // horizon on.
  readonly backfill: boolean;
  // The first store error. Once set, the rest of the rows are not counted.
  failure: StoreError | null;
}

interface FileScan {
  readonly scan: RowScan;
  // The Codex state after the last line read. Unused for a Claude file.
  readonly codex: CodexFileState;
}

function scanClaude(pass: Pass, file: Candidate, start: number, maxBytes: number): Result<FileScan, FsError> {
  const scanned = readRows(file.path, { offset: start, maxBytes, prefilter: CLAUDE_PREFILTER }, (row) => {
    if (pass.failure !== null) return;
    const parsed = parseClaudeRow(row, pass.nowMs);
    if (!parsed.ok) {
      noteSkip(pass.tally, parsed.error);
      return;
    }
    const entry = parsed.value;
    if (pass.backfill) {
      if (entry.at < pass.horizonMs) pass.store.backfillClaude(entry.key, entryOf(entry.at, entry.model, entry.folderKey, entry.tokens));
      return;
    }
    if (entry.at < pass.horizonMs) {
      pass.tally.beforeHorizon += 1;
      return;
    }
    const applied = pass.store.applyClaude(entry.key, entryOf(entry.at, entry.model, entry.folderKey, entry.tokens));
    if (!applied.ok) {
      pass.failure = applied.error;
      return;
    }
    noteApplied(pass.tally, applied.value);
  }, pass.deps);
  return scanned.ok ? ok({ scan: scanned.value, codex: CODEX_INITIAL_STATE }) : scanned;
}

function scanCodex(
  pass: Pass,
  file: Candidate,
  start: number,
  maxBytes: number,
  initial: CodexFileState,
): Result<FileScan, FsError> {
  let state = initial;
  const runs = new QuotaRuns(pass.quota);
  const scanned = readRows(file.path, { offset: start, maxBytes, prefilter: CODEX_PREFILTER }, (row) => {
    if (pass.failure !== null) return;
    const step = stepCodexRow(state, row, pass.nowMs);
    state = step.state;
    for (const reason of step.skips) noteSkip(pass.tally, reason);
    for (const sample of step.quota) runs.add(sample);
    const entry = step.entry;
    if (entry === null) return;
    if (pass.backfill) {
      if (entry.at < pass.horizonMs) pass.store.backfillCodex(entry.key, entryOf(entry.at, entry.model, entry.folderKey, entry.tokens));
      return;
    }
    if (entry.at < pass.horizonMs) {
      pass.tally.beforeHorizon += 1;
      return;
    }
    const applied = pass.store.applyCodex(entry.key, entryOf(entry.at, entry.model, entry.folderKey, entry.tokens));
    if (!applied.ok) {
      pass.failure = applied.error;
      return;
    }
    noteApplied(pass.tally, applied.value);
    // Only the first count of an event: a copy in another file or a later pass is a repeat.
    if (entry.cacheInvalid && applied.value === "added") pass.tally.codexCacheInvalid += 1;
  }, pass.deps);
  runs.finish();
  return scanned.ok ? ok({ scan: scanned.value, codex: state }) : scanned;
}

// A file is read again from 0 after a change in identity or a shrink past the
// saved offset. A Claude file also restarts after a parser revision increase.
function startOffset(saved: LedgerEntry | undefined, file: Candidate): number {
  if (saved === undefined) return 0;
  if (file.provider === "claude" && (saved.rev ?? 0) < CLAUDE_PARSER_REV) return 0;
  const replaced = saved.dev !== file.dev || saved.ino !== file.ino || file.size < saved.offset;
  return replaced ? 0 : saved.offset;
}

interface Position {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly offset: number;
}

function ledgerEntryFor(file: Candidate, at: Position, codex: CodexFileState): LedgerEntry {
  // The file shrank between the stat and the open: read it again from 0 next time.
  const lost = at.offset > at.size;
  const position = {
    dev: at.dev,
    ino: at.ino,
    size: at.size,
    offset: lost ? 0 : at.offset,
    mtimeMs: file.mtimeMs,
  };
  return file.provider === "claude"
    ? { ...position, provider: "claude", rev: CLAUDE_PARSER_REV, codex: null }
    : { ...position, provider: "codex", codex: snapshotOf(lost ? CODEX_INITIAL_STATE : codex) };
}

// The Codex state to go on with: the saved one, or a fresh one when the file starts at 0.
function codexStateAt(saved: LedgerEntry | undefined, start: number): CodexFileState {
  return saved !== undefined && saved.codex !== null && start > 0 ? restoreState(saved.codex) : CODEX_INITIAL_STATE;
}

function toCollectError(error: StoreError): CollectError {
  return { code: error.code, file: error.file };
}

function isCount(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 1);
}

function validInput(input: CollectInput): boolean {
  const { bytes, ms } = input.budget;
  return (
    Number.isInteger(bytes) &&
    bytes >= 1 &&
    Number.isFinite(ms) &&
    ms >= 0 &&
    isCount(input.maxEntriesPerFolder) &&
    isCount(input.maxFilesPerPass) &&
    isCount(input.maxBackfillBytes) &&
    isCount(input.maxBackfillMs) &&
    isCount(input.maxBackfillKeys) &&
    isAbsolute(input.dataDir)
  );
}

// The collect lock of a pass, and the time of the last write into it.
interface LockHold {
  readonly lock: Lock;
  refreshedMs: number;
}

function lockError(error: FsError): CollectError {
  return { code: error.code === "lock_held" ? "lock_held" : "internal_error", file: null };
}

// Refreshes the lock when its last write is LOCK_REFRESH_MS old, or at once when
// `force` is set. A lock that another pass took over ends the pass: lock_held.
function holdLock(hold: LockHold, deps: FsDeps, nowMs: number, force: boolean): Result<null, CollectError> {
  const age = nowMs - hold.refreshedMs;
  if (!force && age >= 0 && age < LOCK_REFRESH_MS) return ok(null);
  const refreshed = refreshLock(hold.lock, deps);
  if (!refreshed.ok) return err(lockError(refreshed.error));
  hold.refreshedMs = nowMs;
  return ok(null);
}

const NO_BACKFILL: BackfillReport = { ran: false, files: 0, rows: 0, cut: false };

interface BackfillTimes {
  readonly startMs: number;
  // The horizon of the 15 minute rows: the backfill takes the rows before it.
  readonly horizonMs: number;
  readonly zone: Zone;
}

// The files whose lines can lie before the horizon, the ones that most surely do
// first. A file with a file time before the horizon holds no line after it, so it
// is all old lines. A file with a later time is mostly new lines, which the normal
// scan counts; it is read last, within what is left of the limits. Each group
// stays newest first. A Codex file sits in a folder of the day its session began,
// in local time, and holds no line before that day less a day of zone slack: a
// folder more than one day after the horizon day has no old line, so it is left out.
function backfillOrder(candidates: readonly Candidate[], horizonMs: number): Candidate[] {
  const lastFolder = dayStampOf(horizonMs + DAY_MS);
  const wanted = candidates.filter((file) => file.provider === "claude" || folderStampOf(file.path) <= lastFolder);
  return [...wanted.filter((file) => file.mtimeMs < horizonMs), ...wanted.filter((file) => file.mtimeMs >= horizonMs)];
}

// YYYYMMDD of the UTC day of an instant, as a number that sorts by date.
function dayStampOf(ms: number): number {
  const day = new Date(ms);
  return day.getUTCFullYear() * 10_000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate();
}

// The YYYYMMDD of the folders YYYY/MM/DD above a Codex file. Discovery lists only
// files in such folders.
function folderStampOf(path: string): number {
  const [year, month, day] = path.split(sep).slice(-4, -1).map(Number);
  return (year ?? 0) * 10_000 + (month ?? 0) * 100 + (day ?? 0);
}

// The one-time backfill of the day rows. It reads the files of the last
// DAYS_HORIZON_DAYS days from the start, in the order of backfillOrder, and keeps
// the rows before the horizon (see Store.backfillClaude). It stops at the byte
// limit, at the time limit or at the key limit of the store; then `cut` is set.
// The byte and time limits are checked between files, and a file is read in one
// call, up to SCAN_BUDGET_BYTES, so that a pass can run past the time limit by the
// read of one file. The pass writes nothing before its flush, so a failed pass
// runs it again.
function runBackfill(
  input: CollectInput,
  deps: FsDeps,
  { startMs, horizonMs, zone }: BackfillTimes,
  hold: LockHold,
  store: Store,
): Result<BackfillReport, CollectError> {
  const limitMs = input.maxBackfillMs ?? BACKFILL_BUDGET_MS;
  // A day of slack: a local day starts at most 14 hours from UTC midnight.
  const floorMs = Date.parse(`${cutoffDateOf(zone, startMs)}T00:00:00Z`) - DAY_MS;
  const found = discover(input, floorMs, { nowMs: deps.nowMs, deadlineMs: startMs + limitMs });
  const pass: Pass = { store, deps, nowMs: startMs, horizonMs, tally: newTally(), quota: [], backfill: true, failure: null };
  let cut = found.finder.incomplete.claude || found.finder.incomplete.codex;
  let bytesLeft = input.maxBackfillBytes ?? BACKFILL_BUDGET_BYTES;
  let files = 0;
  for (const file of backfillOrder(found.candidates, horizonMs)) {
    if (file.size === 0) continue;
    if (files > 0) {
      const nowMs = deps.nowMs();
      if (bytesLeft <= 0 || nowMs - startMs >= limitMs) {
        cut = true;
        break;
      }
      const held = holdLock(hold, deps, nowMs, false);
      if (!held.ok) return held;
    }
    const allowed = Math.min(file.size, bytesLeft, SCAN_BUDGET_BYTES);
    if (allowed < file.size) cut = true;
    const scanned =
      file.provider === "claude"
        ? scanClaude(pass, file, 0, allowed)
        : scanCodex(pass, file, 0, allowed, CODEX_INITIAL_STATE);
    if (!scanned.ok) {
      cut = true;
      continue;
    }
    files += 1;
    bytesLeft -= allowed;
  }
  const done = store.finishBackfill(cut);
  if (!done.ok) return err(toCollectError(done.error));
  return ok({ ran: true, files, rows: done.value.rows, cut: done.value.cut });
}

function runPass(
  input: CollectInput,
  deps: FsDeps,
  startMs: number,
  hold: LockHold,
): Result<CollectReport, CollectError> {
  const zone = input.zone ?? localZone();
  const opened = Store.open(input.dataDir, { zone, nowMs: startMs, backfillKeys: input.maxBackfillKeys ?? BACKFILL_MAX_KEYS }, deps);
  if (!opened.ok) return err(toCollectError(opened.error));
  const store = opened.value;

  const horizonMs = horizonStartMs(startMs);
  let backfill = NO_BACKFILL;
  if (store.needsBackfill) {
    const done = runBackfill(input, deps, { startMs, horizonMs, zone }, hold, store);
    if (!done.ok) return done;
    backfill = done.value;
  }

  // The normal scan starts after the backfill: its budget and the latest time of a
  // row it accepts count from this moment, not from the start of the pass.
  const scanStartMs = deps.nowMs();
  const found = discover(input, horizonMs, { nowMs: deps.nowMs, deadlineMs: scanStartMs + input.budget.ms });
  const pass: Pass = { store, deps, nowMs: scanStartMs, horizonMs, tally: newTally(), quota: [], backfill: false, failure: null };
  const seen: Record<Provider, Set<string>> = { claude: new Set(), codex: new Set() };

  let stoppedBy: CollectReport["stoppedBy"] = "none";
  let bytesLeft = input.budget.bytes;
  let bytesRead = 0;
  let filesRead = 0;
  let unreadable = 0;
  let totalBytes = 0;
  let backlogBytes = 0;

  for (const file of found.candidates) {
    const fileKey = fileKeyOf(file.path);
    seen[file.provider].add(fileKey);
    const saved = store.ledgerGet(fileKey);
    const start = startOffset(saved, file);
    const remaining = file.size - start;
    totalBytes += file.size;

    if (stoppedBy !== "none") {
      backlogBytes += remaining;
      continue;
    }
    const codexStart = codexStateAt(saved, start);
    if (remaining === 0) {
      store.ledgerSet(fileKey, ledgerEntryFor(file, { dev: file.dev, ino: file.ino, size: file.size, offset: start }, codexStart));
      continue;
    }
    if (bytesLeft <= 0) {
      stoppedBy = "bytes";
      backlogBytes += remaining;
      continue;
    }
    if (filesRead > 0) {
      const nowMs = deps.nowMs();
      if (nowMs - scanStartMs >= input.budget.ms) {
        stoppedBy = "time";
        backlogBytes += remaining;
        continue;
      }
      const held = holdLock(hold, deps, nowMs, false);
      if (!held.ok) return held;
    }

    const allowed = Math.min(remaining, bytesLeft);
    const scanned =
      file.provider === "claude"
        ? scanClaude(pass, file, start, allowed)
        : scanCodex(pass, file, start, allowed, codexStart);
    if (pass.failure !== null) return err(toCollectError(pass.failure));
    if (!scanned.ok) {
      unreadable += 1;
      continue;
    }
    filesRead += 1;
    bytesRead += allowed;
    bytesLeft -= allowed;
    backlogBytes += remaining - allowed;
    noteScan(pass.tally, scanned.value.scan);
    store.ledgerSet(fileKey, ledgerEntryFor(file, scanned.value.scan, scanned.value.codex));
  }

  // A provider's ledger drops every file that left the root when its whole
  // listing was seen. Otherwise it drops only the files that are older than the
  // horizon, so that a listing which stays incomplete cannot grow the ledger
  // without end.
  for (const provider of ["claude", "codex"] as const) {
    if (found.roots[provider] === "scanned" && !found.finder.incomplete[provider]) {
      store.ledgerRetain(provider, seen[provider]);
    } else {
      store.ledgerDropOlder(provider, seen[provider], horizonMs);
    }
  }

  // Right before the write: the pass must still hold the lock, or it writes nothing.
  const held = holdLock(hold, deps, deps.nowMs(), true);
  if (!held.ok) return held;
  const flushed = store.flush();
  if (!flushed.ok) return err(toCollectError(flushed.error));

  const { tally } = pass;
  return ok({
    // A budget cut in the last file leaves backlog without a next file to stop at.
    stoppedBy: stoppedBy === "none" && backlogBytes > 0 ? "bytes" : stoppedBy,
    roots: found.roots,
    files: found.candidates.length,
    filesRead,
    bytesRead,
    totalBytes,
    backlogBytes,
    rows: {
      counted: tally.counted,
      repeats: tally.repeats,
      replaced: tally.replaced,
      moved: tally.moved,
      beforeHorizon: tally.beforeHorizon,
      skipped: tally.skipped,
      badJson: tally.badJson,
      notObject: tally.notObject,
      skippedLong: tally.skippedLong,
      codexCacheInvalid: tally.codexCacheInvalid,
    },
    skippedLinks: found.finder.skippedLinks,
    unreadable,
    cappedFolders: found.finder.cappedFolders,
    prunedFiles: flushed.value.pruned,
    bucketUnderflow: store.bucketUnderflow,
    filesWritten: flushed.value.written,
    backfill,
    codexQuota: [...pass.quota].sort(sampleOrder),
  });
}

// Takes collect.lock for the whole pass. A held lock gives lock_held and writes nothing.
export function collect(input: CollectInput, deps: FsDeps = defaultDeps()): Result<CollectReport, CollectError> {
  if (!validInput(input)) return err({ code: "internal_error", file: null });
  const startMs = deps.nowMs();
  const lock = acquireLock(join(input.dataDir, LOCK_FILE), deps);
  if (!lock.ok) return err(lockError(lock.error));
  const result = runPass(input, deps, startMs, { lock: lock.value, refreshedMs: startMs });
  releaseLock(lock.value, deps);
  return result;
}
