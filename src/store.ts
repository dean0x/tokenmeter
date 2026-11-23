// The store (plan 3.8): the files in the data folder and the working set of one
// collect pass.
//
//   store.json                 { version }
//   ledger.json                { version, files: { sha256(path): offset record } }
//   flush-journal.json         { version, renames }, only while a flush is cut short
//   dedupe-YYYY-MM-DD.json     { version, entries } Claude-format rows, by UTC message day
//   codex-dedupe-YYYY-MM-DD.json  Codex, by the day of the first-seen event
//   buckets-YYYY-MM.json       { version, rows: { "slot|provider|model|folder": 5 buckets } }
//   days.json                  { version, backfilled, cutThrough, days }, the totals of each local day (days.ts)
//
// A dedupe entry is [slot, model, folderKey, input, cw5m, cw1h, cacheRead, output].
// A slot is the 15 minute UTC slot number (epoch ms / SLOT_MS). The slot of an
// entry always lies inside the day of the file that holds it.
//
// Every read goes through safeRead with a byte cap. A file that is missing is
// empty. A file that cannot be read, passes its cap, is not valid JSON or has
// the wrong shape gives store_corrupt. A newer version gives store_newer. The
// Store changes memory only, except that open() completes a flush that a stop
// cut short and removes old temp files; open() is called under the collect lock.
// Nothing else reaches the disk before flush(), and flush is called only after
// a pass has ended without an error. flush() replaces all its files in one
// commit (commit.ts).
//
// The working set (maps, dirty sets) is private to one Store and mutated in
// place for speed. The values that leave it are fresh or read-only.

import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  type CommitCode,
  type CommitError,
  type PendingFile,
  applyJournal,
  commitFiles,
  readJournal,
} from "./commit.ts";
import {
  DAYS_HORIZON_DAYS,
  DAYS_MAX_MODELS,
  HORIZON_DAYS,
  LOCK_STALE_MS,
  type Result,
  SLOT_MS,
  STORE_VERSION,
  TOKEN_BUCKETS,
  err,
  ok,
  providerOfClaudeKey,
} from "./core.ts";
import { DAYS_FILE, DayRows, type DayTotals, cutoffDateOf, isDateName, localDateOf } from "./days.ts";
import { type FsDeps, defaultDeps, listDir, removeFile, removeOldTemps, safeRead } from "./fsafe.ts";
import type { Zone } from "./periods.ts";

// ---------------------------------------------------------------------------
// Names, caps and time
// ---------------------------------------------------------------------------

export type Provider = "claude" | "codex";

const KIB = 1024;
const MIB = 1024 * KIB;

export const DAY_MS = 86_400_000;
export const SLOTS_PER_DAY = DAY_MS / SLOT_MS;
export const STORE_FILE = "store.json";
export const LEDGER_FILE = "ledger.json";

// A file over its cap is refused, not cut.
export const FILE_CAPS = {
  store: 4 * KIB,
  ledger: 32 * MIB,
  buckets: 32 * MIB,
  dedupe: 64 * MIB,
  windows: 4 * MIB,
  tasks: 16 * MIB,
  status: MIB,
  // 400 days of at most 40 models stay far under this.
  days: 4 * MIB,
} as const;

// The data folder holds a handful of files. More than this is not our folder.
const MAX_DATA_DIR_NAMES = 1000;
const BUCKET_COLUMNS = 5;
const ENTRY_LENGTH = 3 + BUCKET_COLUMNS;
const FIRST_BUCKET_INDEX = 3;
const SLOT_INDEX = 0;
const MODEL_INDEX = 1;
const FOLDER_INDEX = 2;
const OUTPUT_INDEX = 7;

const DEDUPE_NAME = /^(codex-)?dedupe-(\d{4}-\d{2}-\d{2})\.json$/;
const BUCKETS_NAME = /^buckets-\d{4}-(?:0[1-9]|1[0-2])\.json$/;
const DAY_NAME = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_NAME = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const LEDGER_KEY = /^[0-9a-f]{64}$/;
const CODEX_KEY = /^[0-9a-f]{32}$/;
const CLAUDE_KEY = /^[A-Za-z0-9_.:-]{1,128}\|[A-Za-z0-9_.:-]{1,128}$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;
const FOLDER_NAME = /^[A-Za-z0-9-]{1,200}$/;
const BUCKET_KEY = /^(\d{1,9})\|(claude|codex)\|([A-Za-z0-9][A-Za-z0-9._:@/-]{0,63})\|([A-Za-z0-9-]{1,200})$/;
const DAY_MODEL_KEY = /^(?:claude|codex)\|[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;
// A days file holds the horizon, with room for a few days that a change of zone adds.
const MAX_DAY_ROWS = 2 * DAYS_HORIZON_DAYS;

export function slotOf(ms: number): number {
  return Math.floor(ms / SLOT_MS);
}

export function dayOfSlot(slot: number): number {
  return Math.floor(slot / SLOTS_PER_DAY);
}

// Day number (days since the epoch) to "YYYY-MM-DD" in UTC.
export function dayName(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

// "YYYY-MM" in UTC of the slot start.
export function monthName(slot: number): string {
  return new Date(slot * SLOT_MS).toISOString().slice(0, 7);
}

// Month start minus 7 days, UTC. Older rows and older dedupe days are dropped.
export function horizonStartMs(nowMs: number): number {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - HORIZON_DAYS * DAY_MS;
}

// The horizon starts at midnight UTC, so it is a whole day number.
function horizonDayOf(nowMs: number): number {
  return Math.floor(horizonStartMs(nowMs) / DAY_MS);
}

function dayFromName(name: string): number | null {
  const match = DAY_NAME.exec(name);
  if (match === null) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const day = Math.floor(ms / DAY_MS);
  return dayName(day) === name ? day : null;
}

export function dedupeFileName(provider: Provider, day: number): string {
  return `${provider === "codex" ? "codex-" : ""}dedupe-${dayName(day)}.json`;
}

export function bucketsFileName(month: string): string {
  return `buckets-${month}.json`;
}

// The names that a flush writes. A journal names nothing else.
export function isStoreFileName(name: string): boolean {
  if (name === STORE_FILE || name === LEDGER_FILE || name === DAYS_FILE || BUCKETS_NAME.test(name)) return true;
  const match = DEDUPE_NAME.exec(name);
  return match !== null && dayFromName(match[2] ?? "") !== null;
}

export function bucketKey(slot: number, provider: Provider, model: string, folderKey: string): string {
  return `${slot}|${provider}|${model}|${folderKey}`;
}

export interface BucketKeyParts {
  readonly slot: number;
  readonly provider: Provider;
  readonly model: string;
  readonly folderKey: string;
}

// The inverse of bucketKey. Null for a key that bucketKey cannot have made.
export function parseBucketKey(key: string): BucketKeyParts | null {
  const match = BUCKET_KEY.exec(key);
  if (match === null) return null;
  const [, slot, provider, model, folderKey] = match;
  if (slot === undefined || model === undefined || folderKey === undefined) return null;
  if (provider !== "claude" && provider !== "codex") return null;
  return { slot: Number(slot), provider, model, folderKey };
}

// The ledger key of a source file: sha256 of its absolute path, in hex.
export function fileKeyOf(path: string): string {
  return createHash("sha256").update(path, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DedupeEntry = readonly [
  slot: number,
  model: string,
  folderKey: string,
  input: number,
  cacheWrite5m: number,
  cacheWrite1h: number,
  cacheRead: number,
  output: number,
];

// What a Codex file scan needs to go on from a saved offset.
export interface CodexSnapshot {
  readonly metaSeen: boolean;
  readonly folderKey: string;
  readonly model: string;
  readonly previous: string | null;
}

export type LedgerEntry = {
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly offset: number;
  // The file time at the last read. Null in a ledger that was saved before the
  // time was kept. It lets a pass drop the entry of a file that left the horizon.
  readonly mtimeMs: number | null;
} & (
  | { readonly provider: "claude"; readonly rev: number; readonly codex: null }
  | { readonly provider: "codex"; readonly rev?: never; readonly codex: CodexSnapshot }
);

export type StoreErrorCode = "store_corrupt" | "store_newer" | "store_too_large" | "internal_error";

// `file` is a store file name made by this module, or "." for the folder. Never input text.
export interface StoreError {
  readonly code: StoreErrorCode;
  readonly file: string;
}

export type Applied = "added" | "repeat" | "replaced" | "moved" | "replaced_moved";

export interface FlushStats {
  readonly written: number;
  readonly pruned: number;
}

export function failure(code: StoreErrorCode, file: string): Result<never, StoreError> {
  return err({ code, file });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

type Json = Readonly<Record<string, unknown>>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

export function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIdNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isText(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}

// Absent gives undefined. Anything unreadable, over the cap or not JSON is corrupt.
export function readJson(dataDir: string, name: string, cap: number, deps: FsDeps): Result<unknown, StoreError> {
  const read = safeRead(join(dataDir, name), cap, deps);
  if (!read.ok) return read.error.code === "not_found" ? ok(undefined) : failure("store_corrupt", name);
  try {
    return ok(JSON.parse(read.value));
  } catch {
    return failure("store_corrupt", name);
  }
}

// The version comes first, so a newer file with a new shape is "newer", not "damaged".
export function openVersioned(name: string, parsed: unknown): Result<Json, StoreError> {
  const body = asObject(parsed);
  if (body === null) return failure("store_corrupt", name);
  const version = body["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return failure("store_corrupt", name);
  }
  if (version > STORE_VERSION) return failure("store_newer", name);
  return ok(body);
}

function parseEntry(value: unknown, day: number): DedupeEntry | null {
  if (!Array.isArray(value) || value.length !== ENTRY_LENGTH) return null;
  const [slot, model, folder, ...columns] = value as unknown[];
  if (!isCount(slot) || dayOfSlot(slot) !== day) return null;
  if (!isText(model, MODEL_NAME) || !isText(folder, FOLDER_NAME)) return null;
  return columns.every(isCount) ? (value as unknown as DedupeEntry) : null;
}

function parseDedupeDay(
  name: string,
  provider: Provider,
  day: number,
  parsed: unknown,
): Result<Map<string, DedupeEntry>, StoreError> {
  const body = openVersioned(name, parsed);
  if (!body.ok) return body;
  const entries = asObject(body.value["entries"]);
  if (entries === null) return failure("store_corrupt", name);
  const keyPattern = provider === "codex" ? CODEX_KEY : CLAUDE_KEY;
  const out = new Map<string, DedupeEntry>();
  for (const key of Object.keys(entries)) {
    const entry = keyPattern.test(key) ? parseEntry(entries[key], day) : null;
    if (entry === null) return failure("store_corrupt", name);
    out.set(key, entry);
  }
  return ok(out);
}

function loadDedupeDay(
  dataDir: string,
  provider: Provider,
  day: number,
  deps: FsDeps,
): Result<Map<string, DedupeEntry>, StoreError> {
  const name = dedupeFileName(provider, day);
  const read = readJson(dataDir, name, FILE_CAPS.dedupe, deps);
  if (!read.ok) return read;
  return read.value === undefined ? ok(new Map()) : parseDedupeDay(name, provider, day, read.value);
}

function parseBuckets(name: string, parsed: unknown): Result<Map<string, number[]>, StoreError> {
  const body = openVersioned(name, parsed);
  if (!body.ok) return body;
  const rows = asObject(body.value["rows"]);
  if (rows === null) return failure("store_corrupt", name);
  const out = new Map<string, number[]>();
  for (const key of Object.keys(rows)) {
    const row = rows[key];
    if (!BUCKET_KEY.test(key) || !Array.isArray(row) || row.length !== BUCKET_COLUMNS || !row.every(isCount)) {
      return failure("store_corrupt", name);
    }
    out.set(key, [...(row as number[])]);
  }
  return ok(out);
}

function loadBucketRows(dataDir: string, month: string, deps: FsDeps): Result<Map<string, number[]>, StoreError> {
  if (!MONTH_NAME.test(month)) return failure("internal_error", ".");
  const name = bucketsFileName(month);
  const read = readJson(dataDir, name, FILE_CAPS.buckets, deps);
  if (!read.ok) return read;
  return read.value === undefined ? ok(new Map()) : parseBuckets(name, read.value);
}

function isColumns(value: unknown): value is number[] {
  return Array.isArray(value) && value.length === BUCKET_COLUMNS && value.every(isCount);
}

function parseDayRow(value: unknown): DayTotals | null {
  const body = asObject(value);
  const models = asObject(body?.["models"]);
  if (body === null || models === null) return null;
  const { claude, codex } = body;
  const keys = Object.keys(models);
  if (!isColumns(claude) || !isColumns(codex) || keys.length > DAYS_MAX_MODELS) return null;
  const rows = new Map<string, number[]>();
  for (const key of keys) {
    const columns = models[key];
    if (!DAY_MODEL_KEY.test(key) || !isColumns(columns)) return null;
    rows.set(key, [...columns]);
  }
  return { claude: [...claude], codex: [...codex], models: rows };
}

function parseDays(name: string, parsed: unknown): Result<DayRows, StoreError> {
  const body = openVersioned(name, parsed);
  if (!body.ok) return body;
  const backfilled = body.value["backfilled"];
  const cutThrough = body.value["cutThrough"];
  const days = asObject(body.value["days"]);
  if (typeof backfilled !== "boolean" || days === null) return failure("store_corrupt", name);
  // A cut belongs to a backfill that ran: no cut mark without the done mark.
  if (cutThrough !== null && (!backfilled || typeof cutThrough !== "string" || !isDateName(cutThrough))) {
    return failure("store_corrupt", name);
  }
  const dates = Object.keys(days);
  if (dates.length > MAX_DAY_ROWS) return failure("store_corrupt", name);
  const out = new DayRows(backfilled, cutThrough);
  for (const date of dates) {
    const row = isDateName(date) ? parseDayRow(days[date]) : null;
    if (row === null) return failure("store_corrupt", name);
    out.load(date, row);
  }
  return ok(out);
}

// The day rows of the data folder. A folder with no days file has no rows and
// no backfill done.
export function loadDayRows(dataDir: string, deps: FsDeps = defaultDeps()): Result<DayRows, StoreError> {
  const read = readJson(dataDir, DAYS_FILE, FILE_CAPS.days, deps);
  if (!read.ok) return read;
  return read.value === undefined ? ok(new DayRows(false)) : parseDays(DAYS_FILE, read.value);
}

function parseSnapshot(value: unknown): CodexSnapshot | null {
  const body = asObject(value);
  if (body === null) return null;
  const { metaSeen, folderKey, model, previous } = body;
  if (typeof metaSeen !== "boolean" || !isText(folderKey, FOLDER_NAME) || !isText(model, MODEL_NAME)) return null;
  if (previous !== null && !isText(previous, CODEX_KEY)) return null;
  return { metaSeen, folderKey, model, previous };
}

function parseLedgerEntry(value: unknown): LedgerEntry | null {
  const body = asObject(value);
  if (body === null) return null;
  const { provider, dev, ino, size, offset, codex } = body;
  const mtimeMs = body["mtimeMs"] ?? null;
  const rev = body["rev"] ?? 0;
  if (provider !== "claude" && provider !== "codex") return null;
  if (!isIdNumber(dev) || !isIdNumber(ino) || !isCount(size) || !isCount(offset) || offset > size) return null;
  if (mtimeMs !== null && !isIdNumber(mtimeMs)) return null;
  if (!isCount(rev)) return null;
  const position = { dev, ino, size, offset, mtimeMs };
  if (provider === "claude") return codex === null ? { provider, ...position, rev, codex: null } : null;
  const snapshot = parseSnapshot(codex);
  return snapshot === null ? null : { provider, ...position, codex: snapshot };
}

function parseLedger(parsed: unknown): Result<Map<string, LedgerEntry>, StoreError> {
  const body = openVersioned(LEDGER_FILE, parsed);
  if (!body.ok) return body;
  const files = asObject(body.value["files"]);
  if (files === null) return failure("store_corrupt", LEDGER_FILE);
  const out = new Map<string, LedgerEntry>();
  for (const key of Object.keys(files)) {
    const entry = LEDGER_KEY.test(key) ? parseLedgerEntry(files[key]) : null;
    if (entry === null) return failure("store_corrupt", LEDGER_FILE);
    out.set(key, entry);
  }
  return ok(out);
}

// ---------------------------------------------------------------------------
// Readers for other commands
// ---------------------------------------------------------------------------

// The rows of one month: "slot|provider|model|folder" to the five buckets.
// A month with no file is empty.
export function loadBucketMonth(
  dataDir: string,
  month: string,
  deps: FsDeps = defaultDeps(),
): Result<ReadonlyMap<string, readonly number[]>, StoreError> {
  return loadBucketRows(dataDir, month, deps);
}

interface DayFile {
  readonly provider: Provider;
  readonly day: number;
}

// The dedupe day files in the data folder, from the horizon on. Older ones are
// returned separately, for pruning.
interface DayFiles {
  readonly inHorizon: readonly DayFile[];
  readonly expired: readonly string[];
}

function listDayFiles(dataDir: string, horizonDay: number): Result<DayFiles, StoreError> {
  const listing = listDir(dataDir, MAX_DATA_DIR_NAMES);
  if (!listing.ok) return failure("internal_error", ".");
  if (listing.value.capped) return failure("store_corrupt", ".");
  const inHorizon: DayFile[] = [];
  const expired: string[] = [];
  for (const name of [...listing.value.names].sort()) {
    const match = DEDUPE_NAME.exec(name);
    const day = match === null ? null : dayFromName(match[2] ?? "");
    if (match === null || day === null) continue;
    if (day < horizonDay) {
      expired.push(name);
    } else {
      inHorizon.push({ provider: match[1] === undefined ? "claude" : "codex", day });
    }
  }
  return ok({ inHorizon, expired });
}

// Doctor only: how many native Claude keys sit in more than one day file. A
// restamped fork across days counts twice; the real-data check expects 0.
export function crossDayClaudeKeys(
  dataDir: string,
  nowMs: number,
  deps: FsDeps = defaultDeps(),
): Result<number, StoreError> {
  const files = listDayFiles(dataDir, horizonDayOf(nowMs));
  if (!files.ok) return files;
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const file of files.value.inHorizon) {
    if (file.provider !== "claude") continue;
    const loaded = loadDedupeDay(dataDir, "claude", file.day, deps);
    if (!loaded.ok) return loaded;
    for (const key of loaded.value.keys()) {
      if (providerOfClaudeKey(key) !== "claude") continue;
      if (seen.has(key)) {
        repeated.add(key);
      } else {
        seen.add(key);
      }
    }
  }
  return ok(repeated.size);
}

// ---------------------------------------------------------------------------
// The working set of one pass
// ---------------------------------------------------------------------------

function tokenAt(entry: DedupeEntry, column: number): number {
  const value = entry[FIRST_BUCKET_INDEX + column];
  return typeof value === "number" ? value : 0;
}

function columnsOf(entry: DedupeEntry): number[] {
  return TOKEN_BUCKETS.map((_, column) => tokenAt(entry, column));
}

// What the backfill knows about the bucket files: the first slot they hold and
// the local days that have a row in them.
interface BackfillGuard {
  firstSlot: number;
  readonly dates: Set<string>;
}

export interface BackfillStats {
  // Entries added to the day rows.
  readonly rows: number;
  // True when a limit ended the backfill before it had read everything.
  readonly cut: boolean;
}

function sameLedgerEntry(a: LedgerEntry, b: LedgerEntry): boolean {
  if (a.provider !== b.provider || a.dev !== b.dev || a.ino !== b.ino) return false;
  if (a.size !== b.size || a.offset !== b.offset || a.mtimeMs !== b.mtimeMs || a.rev !== b.rev) return false;
  if (a.codex === null || b.codex === null) return a.codex === b.codex;
  return (
    a.codex.metaSeen === b.codex.metaSeen &&
    a.codex.folderKey === b.codex.folderKey &&
    a.codex.model === b.codex.model &&
    a.codex.previous === b.codex.previous
  );
}

interface BucketMonth {
  readonly name: string;
  readonly rows: Map<string, number[]>;
}

// What open needs besides the folder: the zone of the local days, the time of the
// pass, and the most message keys that the backfill holds in memory.
export interface StoreSetup {
  readonly zone: Zone;
  readonly nowMs: number;
  readonly backfillKeys: number;
}

export class Store {
  readonly #dataDir: string;
  readonly #deps: FsDeps;
  readonly #ledger: Map<string, LedgerEntry>;
  readonly #codexDays: readonly number[];
  readonly #expired: readonly string[];
  readonly #needsStoreFile: boolean;
  readonly #claude = new Map<number, Map<string, DedupeEntry>>();
  readonly #claudeDirty = new Set<number>();
  readonly #codex = new Map<string, DedupeEntry>();
  readonly #codexDirty = new Set<number>();
  readonly #months = new Map<string, Map<string, number[]>>();
  readonly #monthOfDay = new Map<number, string>();
  readonly #monthsDirty = new Set<string>();
  readonly #days: DayRows;
  readonly #zone: Zone;
  readonly #cutoffDate: string;
  // The rows before the horizon that the backfill collects, until finishBackfill
  // adds them to the day rows. Claude by "UTC day|key", Codex by key.
  readonly #oldClaude = new Map<string, DedupeEntry>();
  readonly #oldCodex = new Map<string, DedupeEntry>();
  readonly #keyLimit: number;
  // The first instant and the month of the 15 minute rows. A bucket month before
  // it is not read by collect.
  readonly #horizonMs: number;
  readonly #horizonMonth: string;
  #guard: BackfillGuard | null = null;
  #backfillCut = false;
  // Codex events with no key that the backfill added at once.
  #keyless = 0;
  #codexLoaded = false;
  #ledgerDirty = false;
  #underflow = 0;

  private constructor(
    dataDir: string,
    deps: FsDeps,
    ledger: Map<string, LedgerEntry>,
    files: DayFiles,
    needsStoreFile: boolean,
    days: DayRows,
    setup: StoreSetup,
  ) {
    this.#dataDir = dataDir;
    this.#deps = deps;
    this.#ledger = ledger;
    this.#codexDays = files.inHorizon.filter((f) => f.provider === "codex").map((f) => f.day);
    this.#expired = files.expired;
    this.#needsStoreFile = needsStoreFile;
    this.#days = days;
    this.#zone = setup.zone;
    this.#cutoffDate = cutoffDateOf(setup.zone, setup.nowMs);
    this.#keyLimit = setup.backfillKeys;
    this.#horizonMs = horizonStartMs(setup.nowMs);
    this.#horizonMonth = monthName(slotOf(this.#horizonMs));
  }

  // Completes a flush that a stop cut short, removes the temp files of killed
  // writes, reads store.json and the ledger, and lists the dedupe days. Dedupe
  // days and bucket months are read later, when a row needs them. The caller
  // holds the collect lock: no flush runs while the journal and the temp files
  // are handled. A newer or damaged store.json stops it before any change.
  // The zone of `setup` sets the local days of the day rows. While the one-time
  // backfill of the day rows is not done, open also sums every bucket month file
  // into them.
  static open(dataDir: string, setup: StoreSetup, deps: FsDeps = defaultDeps()): Result<Store, StoreError> {
    const { nowMs } = setup;
    const meta = readJson(dataDir, STORE_FILE, FILE_CAPS.store, deps);
    if (!meta.ok) return meta;
    if (meta.value !== undefined) {
      const checked = openVersioned(STORE_FILE, meta.value);
      if (!checked.ok) return checked;
    }
    const committed = completeStoppedFlush(dataDir, deps);
    if (!committed.ok) return committed;
    const swept = removeOldTemps(dataDir, nowMs, LOCK_STALE_MS, MAX_DATA_DIR_NAMES);
    if (!swept.ok) return failure("internal_error", ".");
    const saved = readJson(dataDir, LEDGER_FILE, FILE_CAPS.ledger, deps);
    if (!saved.ok) return saved;
    const ledger = saved.value === undefined ? ok(new Map<string, LedgerEntry>()) : parseLedger(saved.value);
    if (!ledger.ok) return ledger;
    const files = listDayFiles(dataDir, horizonDayOf(nowMs));
    if (!files.ok) return files;
    const days = loadDayRows(dataDir, deps);
    if (!days.ok) return days;
    const needsStoreFile = meta.value === undefined && !committed.value.includes(STORE_FILE);
    const store = new Store(dataDir, deps, ledger.value, files.value, needsStoreFile, days.value, setup);
    if (!days.value.backfilled) {
      const folded = store.#foldBucketFiles();
      if (!folded.ok) return folded;
    }
    return ok(store);
  }

  get bucketUnderflow(): number {
    return this.#underflow;
  }

  // --- the backfill of the day rows ---

  get needsBackfill(): boolean {
    return !this.#days.backfilled;
  }

  // Sums every bucket month file of the folder into the day rows, old months
  // included: the files stay on disk after the horizon passes them. The backfill
  // then takes a log row only for a day that has no bucket row, or for a time
  // before the first bucket row. A row that the buckets hold is not counted twice.
  // Collect never reads a month before the horizon, so a bad file there does not
  // stop the pass: it is skipped and the backfill is marked as cut.
  #foldBucketFiles(): Result<null, StoreError> {
    const listing = listDir(this.#dataDir, MAX_DATA_DIR_NAMES);
    if (!listing.ok) return failure("internal_error", ".");
    if (listing.value.capped) return failure("store_corrupt", ".");
    const guard: BackfillGuard = { firstSlot: Number.POSITIVE_INFINITY, dates: new Set() };
    for (const file of [...listing.value.names].sort()) {
      if (!BUCKETS_NAME.test(file)) continue;
      const month = file.slice("buckets-".length, -".json".length);
      const loaded = loadBucketRows(this.#dataDir, month, this.#deps);
      if (!loaded.ok) {
        if (month >= this.#horizonMonth) return loaded;
        this.#backfillCut = true;
        continue;
      }
      for (const [key, columns] of loaded.value) {
        const parts = parseBucketKey(key);
        if (parts === null) continue;
        const date = localDateOf(this.#zone, parts.slot * SLOT_MS);
        this.#days.add(date, parts.provider, parts.model, columns, 1);
        guard.dates.add(date);
        guard.firstSlot = Math.min(guard.firstSlot, parts.slot);
      }
    }
    this.#guard = guard;
    return ok(null);
  }

  // The day of a row before the horizon, or null when the backfill does not
  // take it: the day is past the day horizon, or the buckets hold it.
  #backfillDate(slot: number): string | null {
    const guard = this.#guard;
    if (guard === null) return null;
    const date = localDateOf(this.#zone, slot * SLOT_MS);
    if (date < this.#cutoffDate) return null;
    return slot < guard.firstSlot || !guard.dates.has(date) ? date : null;
  }

  #hasKeyRoom(): boolean {
    if (this.#oldClaude.size + this.#oldCodex.size < this.#keyLimit) return true;
    this.#backfillCut = true;
    return false;
  }

  // Claude, as applyClaude does for one UTC day: the largest output wins and the
  // earliest slot wins. Nothing here reaches the bucket rows or the dedupe days.
  backfillClaude(key: string, incoming: DedupeEntry): void {
    const date = this.#backfillDate(incoming[SLOT_INDEX]);
    if (date === null) return;
    // Proxy replies cannot fill part of a date that already has bucket rows.
    if (providerOfClaudeKey(key) === "codex" && this.#guard?.dates.has(date)) return;
    const mapKey = `${dayOfSlot(incoming[SLOT_INDEX])}|${key}`;
    const existing = this.#oldClaude.get(mapKey);
    if (existing === undefined) {
      if (this.#hasKeyRoom()) this.#oldClaude.set(mapKey, incoming);
      return;
    }
    const replace = incoming[OUTPUT_INDEX] > existing[OUTPUT_INDEX];
    const move = incoming[SLOT_INDEX] < existing[SLOT_INDEX];
    if (replace || move) this.#oldClaude.set(mapKey, mergeEntries(existing, incoming, replace, move));
  }

  // Codex, as applyCodex does: one count for each key, at its earliest slot. An
  // event with no key is only added.
  backfillCodex(key: string | null, incoming: DedupeEntry): void {
    const date = this.#backfillDate(incoming[SLOT_INDEX]);
    if (date === null) return;
    if (key === null) {
      this.#days.add(date, "codex", incoming[MODEL_INDEX], columnsOf(incoming), 1);
      this.#keyless += 1;
      return;
    }
    const existing = this.#oldCodex.get(key);
    if (existing === undefined) {
      if (this.#hasKeyRoom()) this.#oldCodex.set(key, incoming);
      return;
    }
    if (incoming[SLOT_INDEX] < existing[SLOT_INDEX]) this.#oldCodex.set(key, mergeEntries(existing, incoming, false, true));
  }

  // Adds the collected rows to the day rows and marks the backfill as done. It
  // runs once: the next open finds the mark. `cut` says that the scan ended
  // before it had read everything; the mark then keeps the last day that the
  // rows before the horizon may not cover. A Codex key that the dedupe days of the
  // horizon hold is counted there already, also when the old copy has another time.
  finishBackfill(cut: boolean): Result<BackfillStats, StoreError> {
    const loaded = this.#oldCodex.size > 0 ? this.#loadCodexDays() : ok(null);
    if (!loaded.ok) return loaded;
    let rows = this.#keyless;
    const fold = (provider: Provider, entry: DedupeEntry): void => {
      const date = this.#backfillDate(entry[SLOT_INDEX]);
      if (date === null) return;
      this.#days.add(date, provider, entry[MODEL_INDEX], columnsOf(entry), 1);
      rows += 1;
    };
    for (const [key, entry] of this.#oldClaude) fold(providerOfClaudeKey(key), entry);
    for (const [key, entry] of this.#oldCodex) {
      if (!this.#codex.has(key)) fold("codex", entry);
    }
    this.#oldClaude.clear();
    this.#oldCodex.clear();
    this.#guard = null;
    const ended = cut || this.#backfillCut;
    this.#days.markBackfilled(ended ? localDateOf(this.#zone, this.#horizonMs) : null);
    return ok({ rows, cut: ended });
  }

  // --- ledger ---

  ledgerGet(fileKey: string): LedgerEntry | undefined {
    return this.#ledger.get(fileKey);
  }

  ledgerSet(fileKey: string, entry: LedgerEntry): void {
    const before = this.#ledger.get(fileKey);
    if (before !== undefined && sameLedgerEntry(before, entry)) return;
    this.#ledger.set(fileKey, entry);
    this.#ledgerDirty = true;
  }

  // Drops the entries of one provider that are not in `keep`. Returns how many.
  // Call it only when `keep` holds every file that the scan could have listed.
  ledgerRetain(provider: Provider, keep: ReadonlySet<string>): number {
    return this.#ledgerDrop(provider, keep, () => true);
  }

  // Drops the entries of one provider that are not in `keep` and whose file had
  // a file time before `horizonMs` at its last read: such a file is outside the
  // scan, whatever the listing missed. An entry with no saved time stays.
  ledgerDropOlder(provider: Provider, keep: ReadonlySet<string>, horizonMs: number): number {
    return this.#ledgerDrop(provider, keep, (entry) => entry.mtimeMs !== null && entry.mtimeMs < horizonMs);
  }

  #ledgerDrop(provider: Provider, keep: ReadonlySet<string>, doomed: (entry: LedgerEntry) => boolean): number {
    let dropped = 0;
    for (const [key, entry] of [...this.#ledger]) {
      if (entry.provider === provider && !keep.has(key) && doomed(entry)) {
        this.#ledger.delete(key);
        dropped += 1;
      }
    }
    if (dropped > 0) this.#ledgerDirty = true;
    return dropped;
  }

  // --- dedupe and buckets ---

  // Claude-format rows: one entry per key and UTC day. The largest output wins;
  // the earliest slot (with its folder key) wins. The key sets the provider.
  applyClaude(key: string, incoming: DedupeEntry): Result<Applied, StoreError> {
    const day = dayOfSlot(incoming[SLOT_INDEX]);
    const dayMap = this.#claudeDay(day);
    if (!dayMap.ok) return dayMap;
    const existing = dayMap.value.get(key);
    const provider = providerOfClaudeKey(key);
    if (existing === undefined) {
      const added = this.#addTokens(provider, incoming, 1);
      if (!added.ok) return added;
      dayMap.value.set(key, incoming);
      this.#claudeDirty.add(day);
      return ok("added");
    }
    const replace = incoming[OUTPUT_INDEX] > existing[OUTPUT_INDEX];
    const move = incoming[SLOT_INDEX] < existing[SLOT_INDEX];
    if (!replace && !move) return ok("repeat");
    const merged = mergeEntries(existing, incoming, replace, move);
    const swapped = this.#swapTokens(provider, existing, merged);
    if (!swapped.ok) return swapped;
    dayMap.value.set(key, merged);
    this.#claudeDirty.add(day);
    if (replace && move) return ok("replaced_moved");
    return ok(replace ? "replaced" : "moved");
  }

  // Codex: a key is looked up in every day inside the horizon. An event with
  // no key (no total usage) is only added. A key found with a later slot moves
  // to the earlier slot and its folder key; the counted values stay.
  applyCodex(key: string | null, incoming: DedupeEntry): Result<Applied, StoreError> {
    if (key === null) {
      const added = this.#addTokens("codex", incoming, 1);
      return added.ok ? ok("added") : added;
    }
    const loaded = this.#loadCodexDays();
    if (!loaded.ok) return loaded;
    const existing = this.#codex.get(key);
    if (existing === undefined) {
      const added = this.#addTokens("codex", incoming, 1);
      if (!added.ok) return added;
      this.#codex.set(key, incoming);
      this.#codexDirty.add(dayOfSlot(incoming[SLOT_INDEX]));
      return ok("added");
    }
    if (incoming[SLOT_INDEX] >= existing[SLOT_INDEX]) return ok("repeat");
    const merged = mergeEntries(existing, incoming, false, true);
    const swapped = this.#swapTokens("codex", existing, merged);
    if (!swapped.ok) return swapped;
    this.#codex.set(key, merged);
    this.#codexDirty.add(dayOfSlot(existing[SLOT_INDEX]));
    this.#codexDirty.add(dayOfSlot(merged[SLOT_INDEX]));
    return ok("moved");
  }

  #claudeDay(day: number): Result<Map<string, DedupeEntry>, StoreError> {
    const cached = this.#claude.get(day);
    if (cached !== undefined) return ok(cached);
    const loaded = loadDedupeDay(this.#dataDir, "claude", day, this.#deps);
    if (!loaded.ok) return loaded;
    this.#claude.set(day, loaded.value);
    return loaded;
  }

  #loadCodexDays(): Result<null, StoreError> {
    if (this.#codexLoaded) return ok(null);
    for (const day of this.#codexDays) {
      const loaded = loadDedupeDay(this.#dataDir, "codex", day, this.#deps);
      if (!loaded.ok) return loaded;
      for (const [key, entry] of loaded.value) this.#codex.set(key, entry);
    }
    this.#codexLoaded = true;
    return ok(null);
  }

  #month(slot: number): Result<BucketMonth, StoreError> {
    const day = dayOfSlot(slot);
    let name = this.#monthOfDay.get(day);
    if (name === undefined) {
      name = monthName(slot);
      this.#monthOfDay.set(day, name);
    }
    const cached = this.#months.get(name);
    if (cached !== undefined) return ok({ name, rows: cached });
    const loaded = loadBucketRows(this.#dataDir, name, this.#deps);
    if (!loaded.ok) return loaded;
    this.#months.set(name, loaded.value);
    return ok({ name, rows: loaded.value });
  }

  // Adds (+1) or removes (-1) the five buckets of an entry. A bucket that would
  // go below 0 stops at 0 and is counted: it means the files disagree.
  #addTokens(provider: Provider, entry: DedupeEntry, sign: 1 | -1): Result<null, StoreError> {
    const month = this.#month(entry[SLOT_INDEX]);
    if (!month.ok) return month;
    const key = bucketKey(entry[SLOT_INDEX], provider, entry[MODEL_INDEX], entry[FOLDER_INDEX]);
    let row = month.value.rows.get(key);
    if (row === undefined) {
      if (sign < 0) {
        this.#underflow += 1;
        return ok(null);
      }
      row = new Array<number>(BUCKET_COLUMNS).fill(0);
      month.value.rows.set(key, row);
    }
    let empty = true;
    for (let column = 0; column < BUCKET_COLUMNS; column += 1) {
      const next = (row[column] ?? 0) + sign * tokenAt(entry, column);
      if (next < 0) this.#underflow += 1;
      row[column] = Math.max(0, next);
      if (row[column] !== 0) empty = false;
    }
    if (empty) month.value.rows.delete(key);
    this.#monthsDirty.add(month.value.name);
    // The day row follows the bucket row, by the day that holds the slot start.
    const date = localDateOf(this.#zone, entry[SLOT_INDEX] * SLOT_MS);
    this.#days.add(date, provider, entry[MODEL_INDEX], columnsOf(entry), sign);
    return ok(null);
  }

  #swapTokens(provider: Provider, from: DedupeEntry, to: DedupeEntry): Result<null, StoreError> {
    const removed = this.#addTokens(provider, from, -1);
    return removed.ok ? this.#addTokens(provider, to, 1) : removed;
  }

  // --- write ---

  // Replaces what changed (dedupe days, bucket months, the ledger, store.json)
  // in one commit: the files reach their new state together or not at all. A
  // stop before the commit leaves the old files. A stop after it is completed by
  // the next open, so a counted key never sits in a dedupe day without its
  // tokens in the buckets. A body over the read cap of its file would make the
  // next read give store_corrupt, so it stops the flush before anything is
  // written. Then removes expired days.
  flush(): Result<FlushStats, StoreError> {
    const pending: PendingFile[] = [];
    const add: AddPending = (name, cap, value) => {
      const text = JSON.stringify(value);
      if (Buffer.byteLength(text, "utf8") > cap) return failure("store_too_large", name);
      pending.push({ name, text });
      return ok(null);
    };

    for (const day of [...this.#claudeDirty].sort((a, b) => a - b)) {
      const entries = this.#claude.get(day) ?? new Map<string, DedupeEntry>();
      const added = add(dedupeFileName("claude", day), FILE_CAPS.dedupe, {
        version: STORE_VERSION,
        entries: Object.fromEntries(entries),
      });
      if (!added.ok) return added;
    }
    const addedCodex = this.#flushCodex(add);
    if (!addedCodex.ok) return addedCodex;
    for (const name of [...this.#monthsDirty].sort()) {
      const rows = this.#months.get(name) ?? new Map<string, number[]>();
      const added = add(bucketsFileName(name), FILE_CAPS.buckets, { version: STORE_VERSION, rows: Object.fromEntries(rows) });
      if (!added.ok) return added;
    }
    this.#days.prune(this.#cutoffDate);
    if (this.#days.dirty) {
      const added = add(DAYS_FILE, FILE_CAPS.days, this.#days.toJson());
      if (!added.ok) return added;
    }
    if (this.#ledgerDirty) {
      const added = add(LEDGER_FILE, FILE_CAPS.ledger, { version: STORE_VERSION, files: Object.fromEntries(this.#ledger) });
      if (!added.ok) return added;
    }
    if (this.#needsStoreFile) {
      const added = add(STORE_FILE, FILE_CAPS.store, { version: STORE_VERSION });
      if (!added.ok) return added;
    }

    const committed = commitFiles(this.#dataDir, pending, this.#deps);
    if (!committed.ok) return fromCommit(committed.error);
    for (const name of this.#expired) {
      if (!removeFile(join(this.#dataDir, name)).ok) return failure("internal_error", name);
    }
    return ok({ written: pending.length, pruned: this.#expired.length });
  }

  #flushCodex(add: AddPending): Result<null, StoreError> {
    if (this.#codexDirty.size === 0) return ok(null);
    const groups = new Map<number, Map<string, DedupeEntry>>();
    for (const day of this.#codexDirty) groups.set(day, new Map());
    for (const [key, entry] of this.#codex) groups.get(dayOfSlot(entry[SLOT_INDEX]))?.set(key, entry);
    for (const day of [...groups.keys()].sort((a, b) => a - b)) {
      const entries = groups.get(day) ?? new Map<string, DedupeEntry>();
      const added = add(dedupeFileName("codex", day), FILE_CAPS.dedupe, {
        version: STORE_VERSION,
        entries: Object.fromEntries(entries),
      });
      if (!added.ok) return added;
    }
    return ok(null);
  }
}

// Queues one file body for the commit, after the check against its read cap.
type AddPending = (name: string, cap: number, value: unknown) => Result<null, StoreError>;

const COMMIT_CODES = {
  corrupt: "store_corrupt",
  newer: "store_newer",
  io: "internal_error",
} as const satisfies Record<CommitCode, StoreErrorCode>;

function fromCommit(error: CommitError): Result<never, StoreError> {
  return failure(COMMIT_CODES[error.code], error.file);
}

// Completes the commit of a flush that a stop cut short. Returns the names of
// the files that the journal listed, or none when no flush was cut short.
function completeStoppedFlush(dataDir: string, deps: FsDeps): Result<readonly string[], StoreError> {
  const journal = readJournal(dataDir, isStoreFileName, deps);
  if (!journal.ok) return fromCommit(journal.error);
  if (journal.value === null) return ok([]);
  const done = applyJournal(dataDir, journal.value);
  return done.ok ? ok(journal.value.renames.map((rename) => rename.target)) : fromCommit(done.error);
}

// The counted values come from the row with the larger output (`replace`), and
// the slot and folder key from the earlier row (`move`).
function mergeEntries(existing: DedupeEntry, incoming: DedupeEntry, replace: boolean, move: boolean): DedupeEntry {
  const place = move ? incoming : existing;
  const values = replace ? incoming : existing;
  return [
    place[SLOT_INDEX],
    values[MODEL_INDEX],
    place[FOLDER_INDEX],
    values[3],
    values[4],
    values[5],
    values[6],
    values[7],
  ];
}
