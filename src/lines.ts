// Line reader (plan 3.3). Reads a file from a byte offset in 64 KiB chunks and
// hands each complete line to a callback. Nothing keeps the line text after the
// callback returns: the reader holds at most one unfinished line (1 MiB cap)
// and the chunk buffer. A line over the cap is counted and never buffered whole.
// The offset moves only to the end of the last newline.

import { readSync } from "node:fs";
import { CHUNK_BYTES, LINE_CAP_BYTES, type Result, err, ok } from "./core.ts";
import {
  type FsDeps,
  type FsError,
  type OpenedFile,
  attemptFs,
  closeFd,
  defaultDeps,
  openRegularRead,
} from "./fsafe.ts";

export interface LineOptions {
  // Byte offset to start from. The caller saved it from an earlier scan.
  readonly offset: number;
  // Read budget for this call in bytes. Omitted means up to the file size.
  readonly maxBytes?: number;
  // A line is delivered only if it holds at least one of these substrings.
  // Omitted or empty means every line passes. The test runs on bytes, before any decode.
  readonly prefilter?: readonly string[];
}

export interface LineScan {
  // New offset: the end of the last newline seen, never past it.
  readonly offset: number;
  // File size at open. A saved offset above it means the file was rewritten.
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  // Complete non-empty lines within the cap.
  readonly lines: number;
  readonly delivered: number;
  readonly filtered: number;
  // Complete lines over the cap, skipped.
  readonly skippedLong: number;
}

export interface RowScan extends LineScan {
  readonly rows: number;
  readonly badJson: number;
  readonly notObject: number;
}

export type ParseReason = "bad_json" | "not_object";

export type Row = Readonly<Record<string, unknown>>;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
// Slack on the read loop bound, for short reads.
const READ_SLACK_ITERATIONS = 16;
const BAD_INPUT: FsError = { code: "bad_input", sys: null };

const DECODER = new TextDecoder("utf-8", { fatal: false });

function isCount(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value >= 0);
}

// JSON.parse in try. The error object is dropped: only a reason code is kept.
export function parseRow(line: string): Result<Row, ParseReason> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return err("bad_json");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return err("not_object");
  return ok(parsed as Row);
}

interface Counts {
  lines: number;
  delivered: number;
  skippedLong: number;
}

// Strips a trailing CR, skips an empty line, applies the pre-filter, then
// decodes (invalid UTF-8 replaced) and delivers.
function deliver(raw: Buffer, needles: readonly Buffer[], counts: Counts, onLine: (line: string) => void): void {
  const end = raw.length > 0 && raw[raw.length - 1] === CARRIAGE_RETURN ? raw.length - 1 : raw.length;
  if (end === 0) return;
  const line = raw.subarray(0, end);
  counts.lines += 1;
  if (needles.length > 0 && !needles.some((needle) => line.includes(needle))) return;
  counts.delivered += 1;
  onLine(DECODER.decode(line));
}

function scanOpened(
  file: OpenedFile,
  options: LineOptions,
  onLine: (line: string) => void,
): Result<LineScan, FsError> {
  const needles = (options.prefilter ?? []).map((text) => Buffer.from(text, "utf8"));
  const limit = options.maxBytes === undefined ? file.size : Math.min(file.size, options.offset + options.maxBytes);
  const counts: Counts = { lines: 0, delivered: 0, skippedLong: 0 };
  const chunk = Buffer.allocUnsafe(CHUNK_BYTES);

  let committed = options.offset;
  let pos = options.offset;
  let pending: Buffer[] = [];
  let pendingLen = 0;
  let skipping = false;

  const maxIterations = Math.max(0, Math.ceil((limit - pos) / CHUNK_BYTES)) + READ_SLACK_ITERATIONS;
  for (let iteration = 0; iteration < maxIterations && pos < limit; iteration += 1) {
    const want = Math.min(CHUNK_BYTES, limit - pos);
    const got = attemptFs(() => readSync(file.fd, chunk, 0, want, pos));
    if (!got.ok) return got;
    const n = got.value;
    if (n === 0) break;
    const view = chunk.subarray(0, n);

    let start = 0;
    // A chunk of n bytes holds at most n newlines.
    for (let found = 0; found < n; found += 1) {
      const newline = view.indexOf(NEWLINE, start);
      if (newline === -1) break;
      if (skipping) {
        skipping = false;
        counts.skippedLong += 1;
      } else if (pendingLen + (newline - start) > LINE_CAP_BYTES) {
        counts.skippedLong += 1;
      } else {
        const piece = view.subarray(start, newline);
        deliver(pendingLen === 0 ? piece : Buffer.concat([...pending, piece]), needles, counts, onLine);
      }
      pending = [];
      pendingLen = 0;
      start = newline + 1;
      committed = pos + start;
    }

    if (start < n && !skipping) {
      const tailLength = n - start;
      if (pendingLen + tailLength > LINE_CAP_BYTES) {
        skipping = true;
        pending = [];
        pendingLen = 0;
      } else {
        pending.push(Buffer.from(view.subarray(start, n)));
        pendingLen += tailLength;
      }
    }
    pos += n;
  }

  return ok({
    offset: committed,
    size: file.size,
    dev: file.dev,
    ino: file.ino,
    lines: counts.lines,
    delivered: counts.delivered,
    filtered: counts.lines - counts.delivered,
    skippedLong: counts.skippedLong,
  });
}

// Delivers lines to `onLine`; the reader keeps none of them.
export function readLines(
  path: string,
  options: LineOptions,
  onLine: (line: string) => void,
  deps: FsDeps = defaultDeps(),
): Result<LineScan, FsError> {
  if (!isCount(options.offset) || !isCount(options.maxBytes)) return err(BAD_INPUT);
  const opened = openRegularRead(path, deps);
  if (!opened.ok) return opened;
  try {
    return scanOpened(opened.value, options, onLine);
  } finally {
    closeFd(opened.value.fd);
  }
}

// Lines that pass the pre-filter are parsed; objects go to `onRow`, and every
// failure is counted by reason code. The parsed object is not kept.
export function readRows(
  path: string,
  options: LineOptions,
  onRow: (row: Row) => void,
  deps: FsDeps = defaultDeps(),
): Result<RowScan, FsError> {
  let rows = 0;
  let badJson = 0;
  let notObject = 0;
  const scanned = readLines(
    path,
    options,
    (line) => {
      const parsed = parseRow(line);
      if (parsed.ok) {
        rows += 1;
        onRow(parsed.value);
      } else if (parsed.error === "bad_json") {
        badJson += 1;
      } else {
        notObject += 1;
      }
    },
    deps,
  );
  if (!scanned.ok) return scanned;
  return ok({ ...scanned.value, rows, badJson, notObject });
}
