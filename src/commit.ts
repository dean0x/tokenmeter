// One commit for several files (plan 3.8).
//
// A flush changes files that must agree: a dedupe day says a message was
// counted, and a bucket month holds its tokens. A stop between the two renames
// would lose the tokens for good, because the next pass finds the key and
// counts nothing. So the files change in three steps:
//
//   1. Every new body goes to its own synced temp file. The old files stay as
//      they are.
//   2. A journal lists the renames. It is written like any other file, so it is
//      whole or absent. Its rename is the commit point.
//   3. The renames run, the folder is synced and the journal is removed.
//
// A stop before step 2 leaves temp files only, and the old files are the state.
// A stop after step 2 is completed by the next open (readJournal, applyJournal):
// a temp file that is gone was renamed before the stop.

import { basename, join } from "node:path";
import { type Result, STORE_VERSION, asRow, err, ok } from "./core.ts";
import {
  type FsDeps,
  defaultDeps,
  fsyncDir,
  isTempNameOf,
  removeFile,
  renameFile,
  safeRead,
  stageAtomic,
  writeAtomic,
} from "./fsafe.ts";

export const JOURNAL_FILE = "flush-journal.json";
// A flush changes a few dozen files at most. More than this is not our journal.
export const MAX_COMMIT_FILES = 256;
const JOURNAL_CAP_BYTES = 1024 * 1024;

export interface PendingFile {
  readonly name: string;
  readonly text: string;
}

export interface Rename {
  readonly temp: string;
  readonly target: string;
}

export interface Journal {
  readonly renames: readonly Rename[];
}

// `file` is a name made by the store, or "." for the folder. Never input text.
export type CommitCode = "corrupt" | "newer" | "io";

export interface CommitError {
  readonly code: CommitCode;
  readonly file: string;
}

function failure(code: CommitCode, file: string): Result<never, CommitError> {
  return err({ code, file });
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

// A journal names only files that the store makes, each with its own temp name.
function parseJournal(parsed: unknown, isTarget: (name: string) => boolean): Result<Journal, CommitError> {
  const body = asRow(parsed);
  if (body === null) return failure("corrupt", JOURNAL_FILE);
  const version = body["version"];
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return failure("corrupt", JOURNAL_FILE);
  }
  if (version > STORE_VERSION) return failure("newer", JOURNAL_FILE);
  const listed = body["renames"];
  if (!Array.isArray(listed) || listed.length > MAX_COMMIT_FILES) return failure("corrupt", JOURNAL_FILE);
  const targets = new Set<string>();
  const renames: Rename[] = [];
  for (const item of listed as unknown[]) {
    const row = asRow(item);
    const temp = row?.["temp"];
    const target = row?.["target"];
    if (typeof temp !== "string" || typeof target !== "string") return failure("corrupt", JOURNAL_FILE);
    if (!isTarget(target) || !isTempNameOf(target, temp) || targets.has(target)) {
      return failure("corrupt", JOURNAL_FILE);
    }
    targets.add(target);
    renames.push({ temp, target });
  }
  return ok({ renames });
}

// Null when no flush was stopped in the middle. Reads only: nothing changes.
export function readJournal(
  dataDir: string,
  isTarget: (name: string) => boolean,
  deps: FsDeps = defaultDeps(),
): Result<Journal | null, CommitError> {
  const read = safeRead(join(dataDir, JOURNAL_FILE), JOURNAL_CAP_BYTES, deps);
  if (!read.ok) return read.error.code === "not_found" ? ok(null) : failure("corrupt", JOURNAL_FILE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(read.value);
  } catch {
    return failure("corrupt", JOURNAL_FILE);
  }
  return parseJournal(parsed, isTarget);
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

// Runs the renames, syncs the folder and removes the journal. A temp file that
// is gone was renamed before a stop, so a missing source is done work.
function finish(dataDir: string, renames: readonly Rename[]): Result<null, CommitError> {
  for (const { temp, target } of renames) {
    const moved = renameFile(join(dataDir, temp), join(dataDir, target));
    if (!moved.ok && moved.error.code !== "not_found") return failure("io", target);
  }
  if (!fsyncDir(dataDir).ok) return failure("io", ".");
  if (!removeFile(join(dataDir, JOURNAL_FILE)).ok) return failure("io", JOURNAL_FILE);
  return ok(null);
}

// Completes the commit that a stop cut short.
export function applyJournal(dataDir: string, journal: Journal): Result<null, CommitError> {
  return finish(dataDir, journal.renames);
}

// Replaces all `files` or none of them. The caller holds the collect lock and
// has applied any old journal. An error before the journal is in place leaves
// the old files; an error after it is completed by the next open.
export function commitFiles(
  dataDir: string,
  files: readonly PendingFile[],
  deps: FsDeps = defaultDeps(),
): Result<null, CommitError> {
  if (files.length === 0) return ok(null);
  if (files.length > MAX_COMMIT_FILES) return failure("io", ".");

  const staged: Rename[] = [];
  const discard = (): void => {
    for (const { temp } of staged) removeFile(join(dataDir, temp));
  };
  for (const file of files) {
    const temp = stageAtomic(join(dataDir, file.name), file.text, deps);
    if (!temp.ok) {
      discard();
      return failure("io", file.name);
    }
    staged.push({ temp: basename(temp.value), target: file.name });
  }

  const journal = JSON.stringify({ version: STORE_VERSION, renames: staged });
  if (!writeAtomic(join(dataDir, JOURNAL_FILE), journal, deps).ok) {
    discard();
    return failure("io", JOURNAL_FILE);
  }
  if (!fsyncDir(dataDir).ok) return failure("io", ".");
  return finish(dataDir, staged);
}
