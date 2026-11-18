// Task windows, attribution, freeze and week shares (plan 3.7, B3 of section 4).
//
//   windows.json   { version, windows: [{label, start, end, folderKeys, tags, features}],
//                    open: [{key, tags, features}] }
//   tasks.jsonl    one line for each frozen task:
//                  {version, label, tags, start, end, shared, claude: [5], codex: [5], features}
//
// `sync` replaces windows.json with the windows of the input that are still
// needed: the open ones, and the ones that ended inside the horizon. Folder
// paths become folder keys at once, so no path is stored. Two different paths
// of one input that give one key are a collision: the sync report counts it,
// and the paths stay in memory only. A bad entry is refused
// and counted; the rest is kept. A bad feature is refused and counted on its
// own: its window, item or task stays. A line with no features reads as having
// none. A bad envelope gives usage_error.
//
// A bucket row belongs to the windows that hold its longest known folder key
// (its own, else the longest cut before a "-" that some window holds) and whose
// time covers its 15-minute slot. No covering window gives nobody; a shorter
// key is not a fallback. Several matches split the row evenly and set `shared`.
// `freezeTasks` writes the totals of a window into tasks.jsonl once, more than
// the freeze delay after its end, when the scan has no backlog. A frozen row
// keeps its stored value. The history holds no session id, no path and no
// folder key. Shares use the calibration at read time.
//
// Every store file is read with a byte cap and written by writeAtomic. A file
// that cannot be read, passes its cap or has the wrong shape gives
// store_corrupt, and nothing is written. A newer version gives store_newer.

import { isAbsolute, join, normalize } from "node:path";
import {
  EARLIEST_TIME_MS,
  type ErrorRecord,
  MAX_FEATURES,
  MAX_TAGS,
  type Result,
  STORE_VERSION,
  SYNC_MAX_BYTES,
  SYNC_MAX_FOLDERS,
  SYNC_MAX_OPEN_ITEMS,
  SYNC_MAX_WINDOWS,
  SYNC_PATH_MAX_CHARS,
  SLOT_MS,
  TASK_FREEZE_DELAY_MS,
  TASK_HISTORY_MAX,
  TOKEN_BUCKETS,
  type TokenRecord,
  asRow,
  err,
  errorRecord,
  folderKey,
  isFeatureName,
  isLabel,
  ok,
  parseJson,
  rawTokens,
  sanitizeFeature,
  sanitizeTime,
} from "./core.ts";
import {
  type BucketRow,
  type Calibration,
  NO_PERIOD_SLOTS,
  PERIOD_NAMES,
  type PeriodName,
  type PeriodSlots,
  type TokenTotals,
  addColumns,
  loadBucketRows,
  newColumns,
  totalsOf,
  within,
} from "./analysis.ts";
import { pctOfWeek } from "./estimator.ts";
import { type FsDeps, defaultDeps, safeRead, writeAtomic } from "./fsafe.ts";
import {
  FILE_CAPS,
  type Provider,
  type StoreError,
  failure,
  horizonStartMs,
  isCount,
  openVersioned,
  readJson,
} from "./store.ts";

// ---------------------------------------------------------------------------
// Names and limits
// ---------------------------------------------------------------------------

export const TASK_WINDOWS_FILE = "windows.json";
export const TASK_HISTORY_FILE = "tasks.jsonl";
export const SHARE_NOT_READY_LABEL = "not ready yet";

// The second share shows from this part of the task's weighted tokens on.
const SECOND_SHARE_MIN_FRACTION = 0.1;

const PROVIDERS: readonly Provider[] = ["claude", "codex"];
const FOLDER_KEY_PATTERN = /^[A-Za-z0-9-]{1,200}$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Tags = Readonly<Record<string, string>>;

// Numbers by name, such as a size or a count. At most MAX_FEATURES, each a valid
// feature name with a value from 0 to 1e12.
export type Features = Readonly<Record<string, number>>;

export interface TaskWindow {
  readonly label: string;
  // Epoch milliseconds.
  readonly start: number;
  // Epoch milliseconds, or null while the task is open.
  readonly end: number | null;
  readonly folderKeys: readonly string[];
  readonly tags: Tags;
  readonly features: Features;
}

export interface OpenItem {
  readonly key: string;
  readonly tags: Tags;
  readonly features: Features;
}

export interface Refused {
  readonly windows: number;
  readonly open: number;
  // Bad features of the windows and items that were kept.
  readonly features: number;
}

// Folder keys that two or more different paths of one sync input gave. The rows
// of those folders merge. It holds no path and no key.
export interface Collisions {
  // The number of such keys.
  readonly keys: number;
  // The labels of the stored windows that hold such a key, sorted, each once.
  readonly windows: readonly string[];
}

export interface SyncInput {
  readonly windows: readonly TaskWindow[];
  readonly open: readonly OpenItem[];
  readonly refused: Refused;
  readonly collisions: Collisions;
}

export interface SyncReport {
  readonly windows: number;
  readonly open: number;
  readonly refused: Refused;
  // Windows that ended before the horizon.
  readonly expired: number;
  readonly collisions: Collisions;
}

export interface StoredTasks {
  readonly windows: readonly TaskWindow[];
  readonly open: readonly OpenItem[];
  // Bad features that the file held. They are left out of the windows and items.
  readonly featuresRefused: number;
}

export type SubscriptionTotals = Readonly<Record<Provider, TokenTotals>>;

// Weighted tokens inside today, the week and the month.
export type PeriodWeighted = Readonly<Record<PeriodName, number>>;

export type SubscriptionPeriods = Readonly<Record<Provider, PeriodWeighted>>;

export interface WindowUsage {
  readonly window: TaskWindow;
  readonly totals: SubscriptionTotals;
  // The weighted tokens of the window inside each period, split like `totals`.
  readonly periods: SubscriptionPeriods;
  // The window split at least one row with another window.
  readonly shared: boolean;
}

// One frozen task. It has no session id, no path and no folder key.
export interface TaskEntry {
  readonly label: string;
  readonly tags: Tags;
  readonly start: number;
  readonly end: number;
  readonly shared: boolean;
  readonly totals: SubscriptionTotals;
  readonly features: Features;
}

export interface TaskHistory {
  readonly entries: readonly TaskEntry[];
  // Bad features that the file held. They are left out of the entries.
  readonly featuresRefused: number;
}

export interface FreezeInput {
  readonly windows: readonly TaskWindow[];
  readonly history: readonly TaskEntry[];
  readonly rows: readonly BucketRow[];
  readonly nowMs: number;
}

export interface FreezeReport {
  readonly frozen: number;
  // Entries in the history after the call.
  readonly total: number;
}

export type ShareValue =
  | { readonly ready: true; readonly pct: number }
  | { readonly ready: false; readonly label: typeof SHARE_NOT_READY_LABEL };

export interface TaskShare {
  readonly provider: Provider;
  readonly weighted: number;
  // The five columns added with no weight.
  readonly raw: number;
  // The subscription with the most weighted tokens of the task.
  readonly main: boolean;
  // The main share, or a share with a tenth or more of the task's weighted tokens.
  readonly shown: boolean;
  // The part of the subscription's week, in percent.
  readonly share: ShareValue;
}

export interface EstimateInput {
  readonly subscription: Provider;
  readonly items: readonly OpenItem[];
  readonly refused: number;
  // The bad features of the kept items only.
  readonly featuresRefused: number;
}

// ---------------------------------------------------------------------------
// Parse at the boundary
// ---------------------------------------------------------------------------

type Row = Readonly<Record<string, unknown>>;

function usageError(): Result<never, ErrorRecord> {
  return err(errorRecord("usage_error"));
}

// The envelope: within the byte limit, valid JSON, an object.
function parseBody(text: string): Result<Row, ErrorRecord> {
  if (Buffer.byteLength(text, "utf8") > SYNC_MAX_BYTES) return usageError();
  const parsed = parseJson(text);
  const body = parsed.ok ? asRow(parsed.value) : null;
  return body === null ? usageError() : ok(body);
}

// A missing list is empty. A list that is not an array, or is over its limit, is null.
function listOf(value: unknown, limit: number): readonly unknown[] | null {
  if (value === undefined) return [];
  return Array.isArray(value) && value.length <= limit ? (value as unknown[]) : null;
}

function parseTags(value: unknown): Tags | null {
  const row = asRow(value);
  if (row === null) return null;
  const keys = Object.keys(row);
  if (keys.length > MAX_TAGS) return null;
  const entries: Array<readonly [string, string]> = [];
  for (const key of keys) {
    const tagValue = row[key];
    if (!isLabel(key) || !isLabel(tagValue)) return null;
    entries.push([key, tagValue]);
  }
  return Object.fromEntries(entries);
}

// A parsed value and the number of bad features that were left out of it.
interface Parsed<T> {
  readonly item: T;
  readonly featuresRefused: number;
}

// A missing value has no features. Each bad entry is refused on its own and
// counted: a bad name, a bad number, or a good one past MAX_FEATURES. A value
// that is not an object is refused as one entry. The rest of the row stays.
function parseFeatures(value: unknown): Parsed<Features> {
  if (value === undefined) return { item: {}, featuresRefused: 0 };
  const row = asRow(value);
  if (row === null) return { item: {}, featuresRefused: 1 };
  const entries: Array<readonly [string, number]> = [];
  let refused = 0;
  for (const name of Object.keys(row)) {
    const number = sanitizeFeature(row[name]);
    if (!isFeatureName(name) || !number.ok || entries.length >= MAX_FEATURES) {
      refused += 1;
      continue;
    }
    entries.push([name, number.value]);
  }
  return { item: Object.fromEntries(entries), featuresRefused: refused };
}

function parseOpenItem(value: unknown): Parsed<OpenItem> | null {
  const row = asRow(value);
  if (row === null) return null;
  const key = row["key"];
  const tags = parseTags(row["tags"]);
  const features = parseFeatures(row["features"]);
  if (!isLabel(key) || tags === null) return null;
  return { item: { key, tags, features: features.item }, featuresRefused: features.featuresRefused };
}

// A folder of a sync input: its clean path and its key. The path is kept only
// for the collision check, and never leaves parseSyncInput.
interface Folder {
  readonly path: string;
  readonly key: string;
}

// A parsed window with the folders it came from.
interface WindowDraft {
  readonly window: TaskWindow;
  readonly folders: readonly Folder[];
}

// An absolute path as a folder. The root folder would match nothing, so it is refused.
function folderOfPath(path: unknown): Folder | null {
  if (typeof path !== "string" || path.length === 0 || path.length > SYNC_PATH_MAX_CHARS) return null;
  if (!isAbsolute(path)) return null;
  const clean = normalize(path);
  const trimmed = clean.length > 1 && clean.endsWith("/") ? clean.slice(0, -1) : clean;
  return trimmed === "/" ? null : { path: trimmed, key: folderKey(trimmed) };
}

function foldersOf(value: unknown): readonly Folder[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > SYNC_MAX_FOLDERS) return null;
  const folders: Folder[] = [];
  for (const path of value as unknown[]) {
    const folder = folderOfPath(path);
    if (folder === null) return null;
    folders.push(folder);
  }
  return folders;
}

function parseWindow(value: unknown, nowMs: number): Parsed<WindowDraft> | null {
  const row = asRow(value);
  if (row === null) return null;
  const label = row["label"];
  const start = sanitizeTime(row["start"], nowMs);
  const rawEnd = row["end"];
  const end = rawEnd === undefined || rawEnd === null ? ok(null) : sanitizeTime(rawEnd, nowMs);
  const tags = parseTags(row["tags"]);
  const features = parseFeatures(row["features"]);
  const folders = foldersOf(asRow(row["match"])?.["folders"]);
  if (!isLabel(label) || !start.ok || !end.ok || tags === null || folders === null) return null;
  if (end.value !== null && end.value <= start.value) return null;
  const folderKeys = [...new Set(folders.map((folder) => folder.key))];
  return {
    item: {
      window: { label, start: start.value, end: end.value, folderKeys, tags, features: features.item },
      folders,
    },
    featuresRefused: features.featuresRefused,
  };
}

// A window that sync stores: an open one, or one that ended inside the horizon.
function isLive(window: TaskWindow, horizon: number): boolean {
  return window.end === null || window.end >= horizon;
}

// The keys that two or more different paths gave, over the windows that sync
// stores, and the labels of the windows that hold one. A window that ended before
// the horizon gets no rows, so it takes no part. The input has at most
// SYNC_MAX_WINDOWS windows of SYNC_MAX_FOLDERS folders each, so the loops are bounded.
function collisionsOf(all: readonly WindowDraft[], horizon: number): Collisions {
  const drafts = all.filter(({ window }) => isLive(window, horizon));
  const pathsByKey = new Map<string, Set<string>>();
  for (const { folders } of drafts) {
    for (const { key, path } of folders) {
      const paths = pathsByKey.get(key) ?? new Set<string>();
      paths.add(path);
      pathsByKey.set(key, paths);
    }
  }
  const colliding = new Set([...pathsByKey].filter(([, paths]) => paths.size > 1).map(([key]) => key));
  const labels = drafts
    .filter(({ window }) => window.folderKeys.some((key) => colliding.has(key)))
    .map(({ window }) => window.label);
  return { keys: colliding.size, windows: [...new Set(labels)].sort() };
}

// The one warning line of a sync with a collision, or null when there is none.
// It names the windows by their labels only: no path and no key.
export function collisionWarning(collisions: Collisions): string | null {
  if (collisions.keys === 0) return null;
  const count = collisions.keys === 1 ? "1 folder key comes" : `${collisions.keys} folder keys come`;
  return (
    `tokenmeter: warning: ${count} from 2 or more different paths (windows ${collisions.windows.join(", ")}). ` +
    'Their rows merge. See "The folder match" in the README.\n'
  );
}

export function windowId(label: string, start: number): string {
  return `${label}|${start}`;
}

interface Kept<T> {
  readonly kept: readonly T[];
  readonly refused: number;
  // The bad features of the kept entries only.
  readonly featuresRefused: number;
}

// Keeps the first entry of each id. A bad entry or a repeat is refused and counted.
function keepValid<T>(
  raws: readonly unknown[],
  parse: (raw: unknown) => Parsed<T> | null,
  idOf: (item: T) => string,
): Kept<T> {
  const seen = new Set<string>();
  const kept: T[] = [];
  let refused = 0;
  let featuresRefused = 0;
  for (const raw of raws) {
    const parsed = parse(raw);
    const id = parsed === null ? null : idOf(parsed.item);
    if (parsed === null || id === null || seen.has(id)) {
      refused += 1;
      continue;
    }
    seen.add(id);
    kept.push(parsed.item);
    featuresRefused += parsed.featuresRefused;
  }
  return { kept, refused, featuresRefused };
}

export function parseSyncInput(text: string, nowMs: number): Result<SyncInput, ErrorRecord> {
  const body = parseBody(text);
  if (!body.ok) return body;
  const windows = listOf(body.value["windows"], SYNC_MAX_WINDOWS);
  const open = listOf(body.value["open"], SYNC_MAX_OPEN_ITEMS);
  if (windows === null || open === null) return usageError();
  const keptWindows = keepValid(
    windows,
    (raw) => parseWindow(raw, nowMs),
    ({ window }) => windowId(window.label, window.start),
  );
  const keptOpen = keepValid(open, parseOpenItem, (item) => item.key);
  return ok({
    windows: keptWindows.kept.map(({ window }) => window),
    open: keptOpen.kept,
    refused: {
      windows: keptWindows.refused,
      open: keptOpen.refused,
      features: keptWindows.featuresRefused + keptOpen.featuresRefused,
    },
    collisions: collisionsOf(keptWindows.kept, horizonStartMs(nowMs)),
  });
}

export function parseEstimateInput(text: string): Result<EstimateInput, ErrorRecord> {
  const body = parseBody(text);
  if (!body.ok) return body;
  const subscription = body.value["subscription"] ?? "claude";
  const items = listOf(body.value["items"], SYNC_MAX_OPEN_ITEMS);
  if ((subscription !== "claude" && subscription !== "codex") || items === null) return usageError();
  const keptItems = keepValid(items, parseOpenItem, (item) => item.key);
  return ok({
    subscription,
    items: keptItems.kept,
    refused: keptItems.refused,
    featuresRefused: keptItems.featuresRefused,
  });
}

// ---------------------------------------------------------------------------
// Store files
// ---------------------------------------------------------------------------

function isStoredTime(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= EARLIEST_TIME_MS;
}

function parseStoredWindow(value: unknown): Parsed<TaskWindow> | null {
  const row = asRow(value);
  if (row === null) return null;
  const { label, start, end, folderKeys } = row;
  const tags = parseTags(row["tags"]);
  const features = parseFeatures(row["features"]);
  if (!isLabel(label) || tags === null || !isStoredTime(start)) return null;
  if (end !== null && (!isStoredTime(end) || end <= start)) return null;
  const keysOk =
    Array.isArray(folderKeys) &&
    folderKeys.length >= 1 &&
    folderKeys.length <= SYNC_MAX_FOLDERS &&
    folderKeys.every((key) => typeof key === "string" && FOLDER_KEY_PATTERN.test(key));
  if (!keysOk) return null;
  return {
    item: { label, start, end, folderKeys: folderKeys as string[], tags, features: features.item },
    featuresRefused: features.featuresRefused,
  };
}

// All entries must be valid. A list over its limit is not valid.
function parseAll<T>(
  value: unknown,
  limit: number,
  parse: (raw: unknown) => Parsed<T> | null,
): { readonly items: T[]; readonly featuresRefused: number } | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const items: T[] = [];
  let featuresRefused = 0;
  for (const raw of value as unknown[]) {
    const parsed = parse(raw);
    if (parsed === null) return null;
    items.push(parsed.item);
    featuresRefused += parsed.featuresRefused;
  }
  return { items, featuresRefused };
}

export function loadTaskWindows(dataDir: string, deps: FsDeps = defaultDeps()): Result<StoredTasks, StoreError> {
  const read = readJson(dataDir, TASK_WINDOWS_FILE, FILE_CAPS.windows, deps);
  if (!read.ok) return read;
  if (read.value === undefined) return ok({ windows: [], open: [], featuresRefused: 0 });
  const body = openVersioned(TASK_WINDOWS_FILE, read.value);
  if (!body.ok) return body;
  const windows = parseAll(body.value["windows"], SYNC_MAX_WINDOWS, parseStoredWindow);
  const open = parseAll(body.value["open"], SYNC_MAX_OPEN_ITEMS, parseOpenItem);
  if (windows === null || open === null) return failure("store_corrupt", TASK_WINDOWS_FILE);
  return ok({
    windows: windows.items,
    open: open.items,
    featuresRefused: windows.featuresRefused + open.featuresRefused,
  });
}

function columnsOf(totals: TokenRecord): number[] {
  return TOKEN_BUCKETS.map((bucket) => totals[bucket]);
}

function entryLine(entry: TaskEntry): string {
  return JSON.stringify({
    version: STORE_VERSION,
    label: entry.label,
    tags: entry.tags,
    start: entry.start,
    end: entry.end,
    shared: entry.shared,
    claude: columnsOf(entry.totals.claude),
    codex: columnsOf(entry.totals.codex),
    features: entry.features,
  });
}

function parseColumns(value: unknown): TokenTotals | null {
  const columns = Array.isArray(value) ? (value as unknown[]) : null;
  const valid = columns !== null && columns.length === TOKEN_BUCKETS.length && columns.every(isCount);
  return valid ? totalsOf(columns as number[]) : null;
}

// A line holds raw columns only. The weighted value is worked out from them, so
// a change of the weights cannot leave an old value in the history.
function parseEntryLine(line: string): Result<Parsed<TaskEntry>, StoreError> {
  const parsed = parseJson(line);
  if (!parsed.ok) return failure("store_corrupt", TASK_HISTORY_FILE);
  const body = openVersioned(TASK_HISTORY_FILE, parsed.value);
  if (!body.ok) return body;
  const { label, start, end, shared } = body.value;
  const tags = parseTags(body.value["tags"]);
  const features = parseFeatures(body.value["features"]);
  const claude = parseColumns(body.value["claude"]);
  const codex = parseColumns(body.value["codex"]);
  const valid =
    isLabel(label) &&
    tags !== null &&
    isStoredTime(start) &&
    isStoredTime(end) &&
    end > start &&
    typeof shared === "boolean" &&
    claude !== null &&
    codex !== null;
  if (!valid) return failure("store_corrupt", TASK_HISTORY_FILE);
  return ok({
    item: { label, tags, start, end, shared, totals: { claude, codex }, features: features.item },
    featuresRefused: features.featuresRefused,
  });
}

export function loadTaskHistory(dataDir: string, deps: FsDeps = defaultDeps()): Result<TaskHistory, StoreError> {
  const read = safeRead(join(dataDir, TASK_HISTORY_FILE), FILE_CAPS.tasks, deps);
  if (!read.ok) {
    return read.error.code === "not_found"
      ? ok({ entries: [], featuresRefused: 0 })
      : failure("store_corrupt", TASK_HISTORY_FILE);
  }
  const lines = read.value.split("\n").filter((line) => line !== "");
  if (lines.length > TASK_HISTORY_MAX) return failure("store_corrupt", TASK_HISTORY_FILE);
  const entries: TaskEntry[] = [];
  let featuresRefused = 0;
  for (const line of lines) {
    const parsed = parseEntryLine(line);
    if (!parsed.ok) return parsed;
    entries.push(parsed.value.item);
    featuresRefused += parsed.value.featuresRefused;
  }
  return ok({ entries, featuresRefused });
}

function putFile(dataDir: string, name: string, text: string, cap: number, deps: FsDeps): Result<null, StoreError> {
  if (Buffer.byteLength(text, "utf8") > cap) return failure("internal_error", name);
  const wrote = writeAtomic(join(dataDir, name), text, deps);
  return wrote.ok ? ok(null) : failure("internal_error", name);
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

// The existing file is read first, so a damaged or newer file is not overwritten.
function applySync(dataDir: string, input: SyncInput, nowMs: number, deps: FsDeps): Result<SyncReport, StoreError> {
  const existing = loadTaskWindows(dataDir, deps);
  if (!existing.ok) return existing;
  const horizon = horizonStartMs(nowMs);
  const windows = input.windows.filter((w) => isLive(w, horizon));
  const text = JSON.stringify({ version: STORE_VERSION, windows, open: input.open });
  const wrote = putFile(dataDir, TASK_WINDOWS_FILE, text, FILE_CAPS.windows, deps);
  if (!wrote.ok) return wrote;
  return ok({
    windows: windows.length,
    open: input.open.length,
    refused: input.refused,
    expired: input.windows.length - windows.length,
    collisions: input.collisions,
  });
}

// Parse the input text, then replace windows.json with the windows that are
// still needed: the open ones, and the ones that ended inside the horizon.
export function sync(
  dataDir: string,
  text: string,
  nowMs: number,
  deps: FsDeps = defaultDeps(),
): Result<SyncReport, ErrorRecord> {
  const parsed = parseSyncInput(text, nowMs);
  if (!parsed.ok) return parsed;
  const applied = applySync(dataDir, parsed.value, nowMs, deps);
  return applied.ok ? applied : err(errorRecord(applied.error.code));
}

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

// Private accumulator of one attribute() call, changed in place.
interface Acc {
  readonly window: TaskWindow;
  readonly columns: Readonly<Record<Provider, number[]>>;
  readonly periodColumns: Readonly<Record<Provider, Readonly<Record<PeriodName, number[]>>>>;
  shared: boolean;
}

function newPeriodColumns(): Readonly<Record<PeriodName, number[]>> {
  return { today: newColumns(), week: newColumns(), month: newColumns() };
}

function periodWeighted(columns: Readonly<Record<PeriodName, readonly number[]>>): PeriodWeighted {
  return {
    today: roundedTotals(columns.today).weighted,
    week: roundedTotals(columns.week).weighted,
    month: roundedTotals(columns.month).weighted,
  };
}

// The slot [slot start, slot end) overlaps the window. A slot that only touches
// the start or the end of the window does not count.
function covers(window: TaskWindow, slot: number): boolean {
  const slotStart = slot * SLOT_MS;
  return slotStart < (window.end ?? Number.POSITIVE_INFINITY) && slotStart + SLOT_MS > window.start;
}

function scaled(tokens: TokenRecord, factor: number): TokenRecord {
  return {
    input: tokens.input * factor,
    cacheWrite5m: tokens.cacheWrite5m * factor,
    cacheWrite1h: tokens.cacheWrite1h * factor,
    cacheRead: tokens.cacheRead * factor,
    output: tokens.output * factor,
  };
}

// The longest folder key that a window holds and that the row's folder key
// equals or starts with, followed by "-". The folder key has at most 200
// characters.
function longestKnownKey(byFolder: ReadonlyMap<string, readonly Acc[]>, folder: string): string | null {
  if (byFolder.has(folder)) return folder;
  for (let index = folder.length - 1; index >= 1; index -= 1) {
    if (folder[index] === "-" && byFolder.has(folder.slice(0, index))) return folder.slice(0, index);
  }
  return null;
}

// The windows of a row: those on its longest known folder key that cover its
// slot. When none covers it, nobody gets it. A shorter key is never a fallback:
// the key of a sibling folder (p1-x) is the key of a sub folder of p1 as well,
// and the sibling's own windows are the better owner of its rows.
function matchingWindows(byFolder: ReadonlyMap<string, readonly Acc[]>, row: BucketRow): Acc[] {
  const key = longestKnownKey(byFolder, row.folderKey);
  return key === null ? [] : (byFolder.get(key) ?? []).filter((acc) => covers(acc.window, row.slot));
}

function roundedTotals(columns: readonly number[]): TokenTotals {
  return totalsOf(columns.map((value) => Math.round(value)));
}

// The tokens of each window, in the order of `windows`. A row that several
// windows match is split evenly, and each of them is marked shared. Tokens of a
// slot outside every window stay unassigned. The totals are whole tokens. The
// same split gives the weighted tokens inside each period: a row counts in a
// period when its slot is in the slot range of the period (see PeriodSlots).
export function attribute(
  windows: readonly TaskWindow[],
  rows: readonly BucketRow[],
  slots: PeriodSlots = NO_PERIOD_SLOTS,
): readonly WindowUsage[] {
  const accs = windows.map(
    (window): Acc => ({
      window,
      columns: { claude: newColumns(), codex: newColumns() },
      periodColumns: { claude: newPeriodColumns(), codex: newPeriodColumns() },
      shared: false,
    }),
  );
  const byFolder = new Map<string, Acc[]>();
  for (const acc of accs) {
    for (const key of new Set(acc.window.folderKeys)) {
      const list = byFolder.get(key) ?? [];
      list.push(acc);
      byFolder.set(key, list);
    }
  }
  for (const row of rows) {
    const matched = matchingWindows(byFolder, row);
    if (matched.length === 0) continue;
    const tokens = matched.length === 1 ? row.tokens : scaled(row.tokens, 1 / matched.length);
    const inside = PERIOD_NAMES.filter((period) => within(row.slot, slots[row.provider][period]));
    for (const acc of matched) {
      addColumns(acc.columns[row.provider], tokens);
      for (const period of inside) addColumns(acc.periodColumns[row.provider][period], tokens);
      if (matched.length > 1) acc.shared = true;
    }
  }
  return accs.map((acc) => ({
    window: acc.window,
    totals: { claude: roundedTotals(acc.columns.claude), codex: roundedTotals(acc.columns.codex) },
    periods: { claude: periodWeighted(acc.periodColumns.claude), codex: periodWeighted(acc.periodColumns.codex) },
    shared: acc.shared,
  }));
}

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

// Ended more than the freeze delay ago, and not in the history yet. A reopened
// item has a new start, so it is a new window.
function dueWindows(input: Pick<FreezeInput, "windows" | "history" | "nowMs">): readonly TaskWindow[] {
  const frozen = new Set(input.history.map((entry) => windowId(entry.label, entry.start)));
  return input.windows.filter(
    (w) => w.end !== null && input.nowMs - w.end > TASK_FREEZE_DELAY_MS && !frozen.has(windowId(w.label, w.start)),
  );
}

function entryOf(usage: WindowUsage): TaskEntry | null {
  const { window } = usage;
  if (window.end === null) return null;
  return {
    label: window.label,
    tags: window.tags,
    start: window.start,
    end: window.end,
    shared: usage.shared,
    totals: usage.totals,
    features: window.features,
  };
}

// The new history entries, oldest end first. The split with other windows counts
// every window known, also the open ones.
export function freezeDue(input: FreezeInput): readonly TaskEntry[] {
  const due = new Set(dueWindows(input));
  if (due.size === 0) return [];
  const entries: TaskEntry[] = [];
  for (const usage of attribute(input.windows, input.rows)) {
    const entry = due.has(usage.window) ? entryOf(usage) : null;
    if (entry !== null) entries.push(entry);
  }
  return entries.sort((a, b) => a.end - b.end);
}

// Freezes the due windows into tasks.jsonl. It does nothing while the scan has
// a backlog. The history keeps the newest TASK_HISTORY_MAX entries.
export function freezeTasks(
  dataDir: string,
  nowMs: number,
  scanComplete: boolean,
  deps: FsDeps = defaultDeps(),
): Result<FreezeReport, StoreError> {
  const stored = loadTaskWindows(dataDir, deps);
  if (!stored.ok) return stored;
  const history = loadTaskHistory(dataDir, deps);
  if (!history.ok) return history;
  const input = { windows: stored.value.windows, history: history.value.entries, nowMs };
  if (!scanComplete || dueWindows(input).length === 0) return ok({ frozen: 0, total: history.value.entries.length });

  const rows = loadBucketRows(dataDir, nowMs, deps);
  if (!rows.ok) return rows;
  const fresh = freezeDue({ ...input, rows: rows.value });
  const all = [...history.value.entries, ...fresh].sort((a, b) => a.end - b.end).slice(-TASK_HISTORY_MAX);
  const text = `${all.map(entryLine).join("\n")}\n`;
  const wrote = putFile(dataDir, TASK_HISTORY_FILE, text, FILE_CAPS.tasks, deps);
  if (!wrote.ok) return wrote;
  return ok({ frozen: fresh.length, total: all.length });
}

// ---------------------------------------------------------------------------
// Shares (B3)
// ---------------------------------------------------------------------------

function shareOf(calibration: Calibration, weightedTokens: number): ShareValue {
  const pct = pctOfWeek(calibration, weightedTokens);
  return pct === null ? { ready: false, label: SHARE_NOT_READY_LABEL } : { ready: true, pct };
}

// A share on each subscription the task used, the main one first. The main
// share is the subscription with the most weighted tokens; on a tie, claude.
// The others show only from a tenth of the task's weighted tokens on.
export function taskShares(
  totals: SubscriptionTotals,
  calibrations: Readonly<Record<Provider, Calibration>>,
): readonly TaskShare[] {
  const used = PROVIDERS.filter((provider) => totals[provider].weighted > 0).sort(
    (a, b) => totals[b].weighted - totals[a].weighted,
  );
  const sum = used.reduce((acc, provider) => acc + totals[provider].weighted, 0);
  return used.map((provider, index): TaskShare => {
    const weightedTokens = totals[provider].weighted;
    const main = index === 0;
    return {
      provider,
      weighted: weightedTokens,
      raw: rawTokens(totals[provider]),
      main,
      shown: main || weightedTokens / sum >= SECOND_SHARE_MIN_FRACTION,
      share: shareOf(calibrations[provider], weightedTokens),
    };
  });
}
