// The estimate log: file input and output only.
//
//   estimates-YYYY-MM.jsonl   one line for each change of the basis of an
//                             estimate, in the UTC month of the line time
//
// A line is {"at","key","basis","basis_name","features","stage","basis_project","low","high"}:
// the time in epoch milliseconds, the item key, the basis word, the basis name,
// the feature names, the stage label, the project of the basis, and the range
// in weighted tokens. The range is null with no basis. A missing stage or
// project scope reads as null. A shared basis or no basis has null scope.
//
// A month file takes no line once it holds the cap. The reader looks at the
// newest 24 month files. A damaged file (a link, a foreign owner, open to the
// group or the world, or over its read cap) is not read and is counted. The
// append follows the read: a line for a month that the pass did not read is not
// written, because the next pass could not read it either and would write it
// again. The read and the append use one trust rule (fsafe.ts, isOwnPrivateFile).
// The scoring of the lines and the choice of the time to keep are in estimator.ts;
// a prune takes that time and deletes the month files older than its month.
// The name of a month file is not a store file name (store.ts): the journal of
// the store never names it.

import { join } from "node:path";
import {
  BASIS_NONE,
  EARLIEST_TIME_MS,
  FUTURE_SLACK_MS,
  MAX_FEATURES,
  MODEL_BASIS_NAMES,
  asRow,
  isFeatureName,
  isLabel,
  parseJson,
  utcMonthOf,
} from "./core.ts";
import { type EstimateLogLine, settledLines } from "./estimator.ts";
import { type FsDeps, appendLine, defaultDeps, isOwnPrivateFile, listDir, lstatEntry, readOwnFile, removeFile } from "./fsafe.ts";

const KIB = 1024;
export const ESTIMATE_LOG_CAP_BYTES = KIB * KIB;
// A month file passes the cap by at most one line, so a read allows some more.
const READ_CAP_BYTES = ESTIMATE_LOG_CAP_BYTES + 64 * KIB;
const MAX_READ_MONTHS = 24;
// The names that one look at the data folder lists.
const MAX_LISTED_NAMES = 1000;
const FILE_NAME = /^estimates-(\d{4}-(?:0[1-9]|1[0-2]))\.jsonl$/;

// ---------------------------------------------------------------------------
// Names and lines
// ---------------------------------------------------------------------------

function fileOfMonth(month: string): string {
  return `estimates-${month}.jsonl`;
}

// The file of a line time: its UTC month. Null for a time that is not valid.
export function estimateLogFile(atMs: number): string | null {
  const month = utcMonthOf(atMs);
  if (month === null) return null;
  const file = fileOfMonth(month);
  return isEstimateLogFile(file) ? file : null;
}

// Exactly estimates-YYYY-MM.jsonl, with a month from 01 to 12.
export function isEstimateLogFile(name: string): boolean {
  return FILE_NAME.test(name);
}

function monthOfFile(name: string): string | null {
  return FILE_NAME.exec(name)?.[1] ?? null;
}

// One line of JSON, with no line break.
export function logLineText(line: EstimateLogLine): string {
  return JSON.stringify({
    at: line.at,
    key: line.key,
    basis: line.basis,
    basis_name: line.basisName,
    features: line.features,
    stage: line.stage,
    basis_project: line.basisProject ?? null,
    low: line.low,
    high: line.high,
  });
}

// One of type, all and none, or a feature name, or two joined by "+" for a pair.
// A feature name is never one of the first three (core.ts).
function isBasisName(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (MODEL_BASIS_NAMES.has(value)) return true;
  const parts = value.split("+");
  return parts.length <= 2 && parts.every(isFeatureName);
}

// At most MAX_FEATURES valid names, each once. Sorted, as the writer sorts them.
function featureNamesOf(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length > MAX_FEATURES) return null;
  const names: string[] = [];
  for (const name of value as unknown[]) {
    if (!isFeatureName(name)) return null;
    names.push(name);
  }
  names.sort();
  return new Set(names).size === names.length ? names : null;
}

// The range of a line with a basis: two finite numbers, the low end above 0 and
// the high end at or above the low end. This is the one place that says so.
function rangeOf(low: unknown, high: unknown): { readonly low: number; readonly high: number } | null {
  return typeof low === "number" && typeof high === "number" && low > 0 && high >= low && Number.isFinite(high)
    ? { low, high }
    : null;
}

// A missing own label or null reads as null. An invalid value reads as undefined.
function labelOfRow(row: Readonly<Record<string, unknown>>, key: "stage" | "basis_project"): string | null | undefined {
  const value = Object.hasOwn(row, key) ? row[key] : null;
  return value === null || isLabel(value) ? value : undefined;
}

type LineHead = Required<Pick<EstimateLogLine, "at" | "key" | "basisName" | "features" | "stage" | "basisProject">>;

// A line with no basis has the name none, no range and no project scope.
function lineWithBasis(head: LineHead, basis: unknown, low: unknown, high: unknown): EstimateLogLine | null {
  if (basis === "none") {
    if (head.basisName !== BASIS_NONE || head.basisProject !== null || low !== null || high !== null) return null;
    return { ...head, basis, basisProject: null, low, high };
  }
  const range = rangeOf(low, high);
  return (basis === "similar" || basis === "wide") && range !== null && head.basisName !== BASIS_NONE
    ? { ...head, basis, ...range }
    : null;
}

// A trust boundary: the file is private to this user, but a line is checked as
// if it were not. A line that is not valid reads as null.
export function parseLogLine(text: string, nowMs: number): EstimateLogLine | null {
  const parsed = parseJson(text);
  const row = parsed.ok ? asRow(parsed.value) : null;
  if (row === null) return null;
  const { at, key, basis, basis_name: basisName, features: rawFeatures, low, high } = row;
  if (typeof at !== "number" || !(at >= EARLIEST_TIME_MS && at <= nowMs + FUTURE_SLACK_MS)) return null;
  if (!isLabel(key) || !isBasisName(basisName)) return null;
  const features = featureNamesOf(rawFeatures);
  const stage = labelOfRow(row, "stage");
  const basisProject = labelOfRow(row, "basis_project");
  if (features === null || stage === undefined || basisProject === undefined) return null;
  return lineWithBasis({ at, key, basisName, features, stage, basisProject }, basis, low, high);
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface EstimateLogRead {
  // The valid lines of the newest 24 month files, in time order, with each repeat
  // of the latest state of a key left out.
  readonly lines: readonly EstimateLogLine[];
  // Month files that were not read because they are not safe or too large, and
  // a folder listing that was cut short or failed.
  readonly damaged: number;
  // Month files at or above the cap.
  readonly atCap: number;
  // The months (YYYY-MM) of the listed files that this read did not read: the
  // damaged ones, and the ones older than the newest 24.
  readonly unreadMonths: readonly string[];
  // False when the folder listing failed or stopped at its cap. Then a month file
  // may exist that this read did not see.
  readonly listingComplete: boolean;
}

// What the append needs from the read of the same pass.
export type MonthAccess = Pick<EstimateLogRead, "unreadMonths" | "listingComplete">;

// Never fails. A line that is not valid is skipped and is not damage. A month
// file that is missing between the listing and the read is not damage either.
// `nowMs` is the time of the pass: a line later than it is not valid.
export function readEstimateLog(dataDir: string, nowMs: number, deps: FsDeps = defaultDeps()): EstimateLogRead {
  const listing = listDir(dataDir, MAX_LISTED_NAMES);
  if (!listing.ok) {
    const missing = listing.error.code === "not_found";
    return { lines: [], damaged: missing ? 0 : 1, atCap: 0, unreadMonths: [], listingComplete: missing };
  }
  const listed = listing.value.names.flatMap((name) => monthOfFile(name) ?? []).sort();
  const unreadMonths = listed.slice(0, -MAX_READ_MONTHS);
  const lines: EstimateLogLine[] = [];
  let damaged = listing.value.capped ? 1 : 0;
  let atCap = 0;
  for (const month of listed.slice(-MAX_READ_MONTHS)) {
    const path = join(dataDir, fileOfMonth(month));
    const stat = lstatEntry(path);
    if (stat.ok && stat.value.isFile() && stat.value.size >= ESTIMATE_LOG_CAP_BYTES) atCap += 1;
    const text = readOwnFile(path, READ_CAP_BYTES, deps);
    if (!text.ok) {
      if (text.error !== "missing") {
        damaged += 1;
        unreadMonths.push(month);
      }
      continue;
    }
    for (const raw of text.value.split("\n")) {
      const line = parseLogLine(raw, nowMs);
      if (line !== null) lines.push(line);
    }
  }
  return { lines: settledLines(lines), damaged, atCap, unreadMonths, listingComplete: !listing.value.capped };
}

// ---------------------------------------------------------------------------
// Append
// ---------------------------------------------------------------------------

export interface AppendReport {
  readonly appended: number;
  // Lines refused because their month file holds the cap.
  readonly full: number;
  // Lines not written: an invalid or noncanonical line, an unread month, a file
  // that the read would refuse, or a write that failed.
  readonly failed: number;
}

// The size of a month file that the read would accept, 0 for a missing file, null
// for any other file (a link, a folder, a foreign owner, group or world bits) and
// for anything that cannot be looked at.
function sizeBeforeAppend(path: string, uid: number): number | null {
  const stat = lstatEntry(path);
  if (!stat.ok) return stat.error.code === "not_found" ? 0 : null;
  return isOwnPrivateFile(stat.value, uid) ? stat.value.size : null;
}

function appendOne(dataDir: string, line: EstimateLogLine, access: MonthAccess, deps: FsDeps): keyof AppendReport {
  const file = estimateLogFile(line.at);
  if (file === null || !access.listingComplete || access.unreadMonths.some((month) => fileOfMonth(month) === file)) return "failed";
  const text = logLineText(line);
  const back = parseLogLine(text, line.at);
  if (back === null || logLineText(back) !== text) return "failed";
  const path = join(dataDir, file);
  const size = sizeBeforeAppend(path, deps.uid);
  if (size === null) return "failed";
  if (size >= ESTIMATE_LOG_CAP_BYTES) return "full";
  return appendLine(path, text, deps).ok ? "appended" : "failed";
}

// Appends each line to the file of its month, only where the pass read the month
// file: a line for a month it did not read is not written. The cap is checked
// before each append, and a refusal changes nothing. The caller calls this only
// after the snapshot is written.
export function appendEstimateLines(
  dataDir: string,
  lines: readonly EstimateLogLine[],
  access: MonthAccess,
  deps: FsDeps = defaultDeps(),
): AppendReport {
  const counts = { appended: 0, full: 0, failed: 0 };
  for (const line of lines) counts[appendOne(dataDir, line, access, deps)] += 1;
  return counts;
}

// ---------------------------------------------------------------------------
// Prune
// ---------------------------------------------------------------------------

export interface PruneReport {
  readonly removed: number;
  readonly failed: number;
}

// Deletes the month files older than the UTC month of `keepAtMs`, the time of the
// oldest line that is still needed. With no keep time, or a time that is not
// valid, it deletes nothing. Only an exact month file name that is a regular
// file goes: a link, a folder or any other name stays.
export function pruneEstimateLog(dataDir: string, keepAtMs: number | null): PruneReport {
  const cutMonth = keepAtMs === null ? null : utcMonthOf(keepAtMs);
  if (cutMonth === null) return { removed: 0, failed: 0 };
  const listing = listDir(dataDir, MAX_LISTED_NAMES);
  if (!listing.ok) return { removed: 0, failed: listing.error.code === "not_found" ? 0 : 1 };
  let removed = 0;
  let failed = 0;
  for (const name of listing.value.names) {
    const month = monthOfFile(name);
    if (month === null || month >= cutMonth) continue;
    const path = join(dataDir, name);
    const stat = lstatEntry(path);
    if (!stat.ok) {
      if (stat.error.code !== "not_found") failed += 1;
    } else if (stat.value.isFile()) {
      if (removeFile(path).ok) removed += 1;
      else failed += 1;
    }
  }
  return { removed, failed };
}
