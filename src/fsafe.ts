// Safe file I/O (plan 3.4). Every function returns a Result. A failure holds a
// fixed code and an errno name such as "ENOENT", never a path or message text.
// Time, process id, owner id and temp names are injected through FsDeps.

import { randomBytes } from "node:crypto";
import {
  type Stats,
  accessSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  CHUNK_BYTES,
  LOCK_BODY_CAP_BYTES,
  LOCK_STALE_MS,
  MAX_LOCK_ATTEMPTS,
  MAX_TEMP_ATTEMPTS,
  type Result,
  err,
  ok,
} from "./core.ts";

export type FsErrorCode =
  | "data_dir_unsafe"
  | "not_found"
  | "unsafe_file"
  | "too_large"
  | "bad_input"
  | "lock_held"
  | "io_error";

export interface FsError {
  readonly code: FsErrorCode;
  readonly sys: string | null;
}

export interface FsDeps {
  readonly uid: number;
  readonly pid: number;
  readonly nowMs: () => number;
  readonly isAlive: (pid: number) => boolean;
  readonly suffix: () => string;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GROUP_WORLD_WRITE = 0o022;
// Group and world bits must be clear on a data file that is read back.
const GROUP_WORLD_BITS = 0o077;
const STICKY_BIT = 0o1000;
const APP_DIR = "tokenmeter";
const MAX_DATA_DIR_ANCESTORS = 256;
const SUFFIX_BYTES = 6;
const TOKEN_BYTES = 8;
const TOKEN_MAX_CHARS = 64;
const SUFFIX_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const TEMP_END = ".tmp";
// What tempPathFor makes for the files that writeAtomic writes: `.name.json.suffix.tmp`,
// also for the collect lock.
const TEMP_NAME = /^\.[A-Za-z0-9][A-Za-z0-9-]*\.(?:jsonl?|lock)\.[A-Za-z0-9._-]{1,64}\.tmp$/;
const ERRNO_PATTERN = /^E[A-Z0-9]{1,15}$/;
// Slack on the read loop bound, for short reads.
const READ_SLACK_ITERATIONS = 16;

const DECODER = new TextDecoder("utf-8", { fatal: false });

const BAD_INPUT: FsError = { code: "bad_input", sys: null };
const UNSAFE_FILE: FsError = { code: "unsafe_file", sys: null };

// ---------------------------------------------------------------------------
// Error plumbing
// ---------------------------------------------------------------------------

function errnoName(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ERRNO_PATTERN.test(code) ? code : null;
}

function classify(sys: string | null): FsErrorCode {
  if (sys === "ENOENT" || sys === "ENOTDIR") return "not_found";
  if (sys === "ELOOP") return "unsafe_file";
  return "io_error";
}

// The one place that catches: runs a system call and returns a Result.
export function attemptFs<T>(call: () => T): Result<T, FsError> {
  try {
    return ok(call());
  } catch (error) {
    const sys = errnoName(error);
    return err({ code: classify(sys), sys });
  }
}

// A failed close of a read-only or already checked descriptor has no recovery.
export function closeFd(fd: number): void {
  attemptFs(() => closeSync(fd));
}

function removeQuiet(path: string): void {
  attemptFs(() => unlinkSync(path));
}

// A missing file counts as removed.
export function removeFile(path: string): Result<null, FsError> {
  if (!isValidDirPath(path)) return err(BAD_INPUT);
  const removed = attemptFs(() => unlinkSync(path));
  if (!removed.ok && removed.error.sys !== "ENOENT") return removed;
  return ok(null);
}

// Stat of the entry itself. A link is reported as a link, never followed.
export function lstatEntry(path: string): Result<Stats, FsError> {
  if (!isValidDirPath(path)) return err(BAD_INPUT);
  return attemptFs(() => lstatSync(path));
}

export interface DirListing {
  readonly names: readonly string[];
  // True when the folder holds more than `cap` entries. The rest is not listed.
  readonly capped: boolean;
}

// Reads at most `cap` names, in folder order. A huge folder costs at most cap + 1 reads.
export function listDir(path: string, cap: number): Result<DirListing, FsError> {
  if (!isValidDirPath(path) || !Number.isInteger(cap) || cap < 0) return err(BAD_INPUT);
  const opened = attemptFs(() => opendirSync(path));
  if (!opened.ok) return opened;
  const dir = opened.value;
  const names: string[] = [];
  let capped = false;
  let failure: FsError | null = null;
  for (let read = 0; read <= cap; read += 1) {
    const next = attemptFs(() => dir.readSync());
    if (!next.ok) {
      failure = next.error;
      break;
    }
    if (next.value === null) break;
    if (read === cap) {
      capped = true;
      break;
    }
    names.push(next.value.name);
  }
  attemptFs(() => dir.closeSync());
  return failure === null ? ok({ names, capped }) : err(failure);
}

function isValidDirPath(path: string): boolean {
  return isAbsolute(path) && !path.includes("\0");
}

function isValidFilePath(path: string): boolean {
  if (!isValidDirPath(path) || path.endsWith("/")) return false;
  const name = basename(path);
  return name !== "" && name !== "." && name !== "..";
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoName(error) === "EPERM";
  }
}

function newSuffix(): string {
  return `${process.pid}-${randomBytes(SUFFIX_BYTES).toString("hex")}`;
}

// uid -1 never matches a real owner, so a missing getuid fails closed.
export function defaultDeps(): FsDeps {
  return {
    uid: process.getuid?.() ?? -1,
    pid: process.pid,
    nowMs: () => Date.now(),
    isAlive: isProcessAlive,
    suffix: newSuffix,
  };
}

// ---------------------------------------------------------------------------
// Data folder
// ---------------------------------------------------------------------------

export interface DataDirInput {
  readonly flag: string | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly homeDir: string;
}

function nonEmpty(value: string | null | undefined): string | null {
  return value === null || value === undefined || value === "" ? null : value;
}

// An environment value that names a folder: absolute only. A relative value
// would follow the current folder, so each project folder would get its own data folder.
function absoluteEnv(value: string | undefined): string | null {
  const set = nonEmpty(value);
  return set !== null && isAbsolute(set) ? set : null;
}

// Pure. Order: --data-dir (a relative flag resolves against the current folder),
// TOKENMETER_DATA_DIR (absolute only), macOS Application Support, then
// $XDG_STATE_HOME (absolute only) or ~/.local/state.
export function resolveDataDirPath(input: DataDirInput): string {
  const explicit = nonEmpty(input.flag) ?? absoluteEnv(input.env["TOKENMETER_DATA_DIR"]);
  if (explicit !== null) return resolve(explicit);
  if (input.platform === "darwin") {
    return join(input.homeDir, "Library", "Application Support", APP_DIR);
  }
  const stateHome = absoluteEnv(input.env["XDG_STATE_HOME"]) ?? join(input.homeDir, ".local", "state");
  return join(stateHome, APP_DIR);
}

// The parent must not let another user swap the leaf after the check: a group or
// world writable parent is refused, unless its sticky bit is set (as on /tmp).
// The parent is read through links, because a link's own mode says nothing.
function parentIsSafe(parent: string): Result<null, FsError> {
  const stat = attemptFs(() => statSync(parent));
  if (!stat.ok) return err({ code: "data_dir_unsafe", sys: stat.error.sys });
  return parentModeIsSafe(stat.value.mode) ? ok(null) : err({ code: "data_dir_unsafe", sys: null });
}

function parentModeIsSafe(mode: number): boolean {
  return (mode & GROUP_WORLD_WRITE) === 0 || (mode & STICKY_BIT) !== 0;
}

// Creates the folder (parents and leaf 0700), checks the parent, and checks the
// leaf through one descriptor: a directory, not a link, owned by this user, no
// group or world write.
export function prepareDataDir(path: string, deps: FsDeps = defaultDeps()): Result<string, FsError> {
  if (!isValidDirPath(path)) return err(BAD_INPUT);
  const target = resolve(path);
  const parents = attemptFs(() => mkdirSync(dirname(target), { recursive: true, mode: DIR_MODE }));
  if (!parents.ok) return parents;
  const parent = parentIsSafe(dirname(target));
  if (!parent.ok) return parent;
  const leaf = attemptFs(() => {
    try {
      mkdirSync(target, { mode: DIR_MODE });
    } catch (error) {
      if (errnoName(error) !== "EEXIST") throw error;
    }
  });
  if (!leaf.ok) return leaf;
  return checkDataDir(target, deps);
}

function checkDataDir(target: string, deps: FsDeps): Result<string, FsError> {
  const unsafe = (sys: string | null): Result<string, FsError> => err({ code: "data_dir_unsafe", sys });
  const opened = attemptFs(() => openSync(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
  if (!opened.ok) return unsafe(opened.error.sys);
  const fd = opened.value;
  const stat = attemptFs(() => fstatSync(fd));
  closeFd(fd);
  if (!stat.ok) return unsafe(stat.error.sys);
  const info = stat.value;
  if (!info.isDirectory() || info.uid !== deps.uid || (info.mode & GROUP_WORLD_WRITE) !== 0) {
    return unsafe(null);
  }
  return ok(target);
}

// A read-only command never creates the data folder.
export function existingDataDir(path: string, deps: FsDeps = defaultDeps()): Result<string, FsError> {
  if (!isValidDirPath(path)) return err(BAD_INPUT);
  const target = resolve(path);
  const found = lstatEntry(target);
  if (!found.ok && found.error.code === "not_found") return found;
  const parent = parentIsSafe(dirname(target));
  return parent.ok ? checkDataDir(target, deps) : parent;
}

function canWriteIn(path: string): boolean {
  return attemptFs(() => accessSync(path, constants.W_OK | constants.X_OK)).ok;
}

// Check write access without creating the data folder. The caller checks an existing folder first.
export function dataDirWritable(path: string, exists: boolean): boolean {
  if (!isValidDirPath(path)) return false;
  if (exists) return canWriteIn(path);

  let parent = dirname(path);
  for (let depth = 0; depth < MAX_DATA_DIR_ANCESTORS; depth += 1) {
    const entry = lstatEntry(parent);
    if (entry.ok) {
      const info = entry.value.isSymbolicLink() ? attemptFs(() => statSync(parent)) : entry;
      // If the direct parent does not exist, the refresher creates it at 0700.
      return info.ok && info.value.isDirectory() && (depth !== 0 || parentModeIsSafe(info.value.mode))
        && canWriteIn(parent);
    }
    if (entry.error.sys !== "ENOENT") return false;
    const next = dirname(parent);
    if (next === parent) return false;
    parent = next;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

export interface OpenedFile {
  readonly fd: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly dev: number;
  readonly ino: number;
}

// Opens read-only without following a link and without blocking on a pipe,
// then checks through the descriptor: a regular file owned by this user.
// The caller closes the descriptor with closeFd.
export function openRegularRead(
  path: string, deps: FsDeps = defaultDeps(), privateOnly = false, exactMode?: number,
): Result<OpenedFile, FsError> {
  if (!isValidDirPath(path)) return err(BAD_INPUT);
  const opened = attemptFs(() => openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
  if (!opened.ok) return opened;
  const fd = opened.value;
  const stat = attemptFs(() => fstatSync(fd));
  if (!stat.ok) {
    closeFd(fd);
    return stat;
  }
  const info = stat.value;
  const safe = privateOnly ? isOwnPrivateFile(info, deps.uid) : info.isFile() && info.uid === deps.uid;
  if (!safe || (exactMode !== undefined && (info.mode & 0o7777) !== exactMode)) {
    closeFd(fd);
    return err(UNSAFE_FILE);
  }
  return ok({ fd, size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino });
}

// Reads exactly `size` bytes unless the file ends early. Bounded by size.
function readAll(fd: number, size: number): Result<Buffer, FsError> {
  const buffer = Buffer.allocUnsafe(size);
  const maxIterations = Math.ceil(size / CHUNK_BYTES) + READ_SLACK_ITERATIONS;
  let filled = 0;
  for (let i = 0; i < maxIterations && filled < size; i += 1) {
    const want = Math.min(CHUNK_BYTES, size - filled);
    const got = attemptFs(() => readSync(fd, buffer, filled, want, filled));
    if (!got.ok) return got;
    if (got.value === 0) break;
    filled += got.value;
  }
  return ok(filled === size ? buffer : buffer.subarray(0, filled));
}

// Text with invalid UTF-8 replaced. A file over the cap is refused, not cut.
function readText(path: string, capBytes: number, deps: FsDeps, privateOnly: boolean, exactMode?: number): Result<string, FsError> {
  if (!Number.isInteger(capBytes) || capBytes < 0) return err(BAD_INPUT);
  const opened = openRegularRead(path, deps, privateOnly, exactMode);
  if (!opened.ok) return opened;
  const { fd, size } = opened.value;
  const body: Result<Buffer, FsError> = size > capBytes ? err({ code: "too_large", sys: null }) : readAll(fd, size);
  closeFd(fd);
  if (!body.ok) return body;
  return ok(DECODER.decode(body.value));
}

export function safeRead(path: string, capBytes: number, deps: FsDeps = defaultDeps()): Result<string, FsError> {
  return readText(path, capBytes, deps, false);
}

type FileFailure = "missing" | "unsafe" | "too_large";

// A regular file, owned by this user, with no group or world bits.
// Use lstat or a no-follow descriptor to reject links.
export function isOwnPrivateFile(info: Pick<Stats, "isFile" | "uid" | "mode">, uid: number): boolean {
  return info.isFile() && info.uid === uid && (info.mode & GROUP_WORLD_BITS) === 0;
}

// A file that passes `isOwnPrivateFile`, the byte cap and any exact mode check.
// Anything else is a failure code, never an error text.
export function readOwnFile(path: string, capBytes: number, deps: FsDeps, exactMode?: number): Result<string, FileFailure> {
  const text = readText(path, capBytes, deps, true, exactMode);
  if (text.ok) return text;
  if (text.error.code === "too_large") return err("too_large");
  return err(text.error.code === "not_found" ? "missing" : "unsafe");
}

// ---------------------------------------------------------------------------
// Write
// ---------------------------------------------------------------------------

export function tempPathFor(path: string, suffix: string): string {
  return join(dirname(path), `.${basename(path)}.${suffix}${TEMP_END}`);
}

interface TempFile {
  readonly temp: string;
  readonly fd: number;
}

// O_EXCL also fails on a planted link, so a link at a temp name is never followed.
function createTemp(path: string, deps: FsDeps): Result<TempFile, FsError> {
  let lastSys: string | null = null;
  for (let attempt = 0; attempt < MAX_TEMP_ATTEMPTS; attempt += 1) {
    const suffix = deps.suffix();
    if (!SUFFIX_PATTERN.test(suffix)) return err(BAD_INPUT);
    const temp = tempPathFor(path, suffix);
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const opened = attemptFs(() => openSync(temp, flags, FILE_MODE));
    if (opened.ok) return ok({ temp, fd: opened.value });
    if (opened.error.sys !== "EEXIST") return opened;
    lastSys = opened.error.sys;
  }
  return err({ code: "io_error", sys: lastSys });
}

// True when `name` is the temp name that tempPathFor makes for the file `target`.
export function isTempNameOf(target: string, name: string): boolean {
  const head = `.${target}.`;
  if (!name.startsWith(head) || !name.endsWith(TEMP_END)) return false;
  return SUFFIX_PATTERN.test(name.slice(head.length, name.length - TEMP_END.length));
}

// Writes a unique 0600 temp file in the same folder and syncs it. The target is
// not touched. The temp file is removed on any failure; on success the caller
// owns it and returns its path.
export function stageAtomic(path: string, text: string, deps: FsDeps = defaultDeps()): Result<string, FsError> {
  if (!isValidFilePath(path)) return err(BAD_INPUT);
  const created = createTemp(path, deps);
  if (!created.ok) return created;
  const { temp, fd } = created.value;

  const prepared = attemptFs(() => {
    fchmodSync(fd, FILE_MODE);
    return fstatSync(fd);
  });
  if (!prepared.ok || !prepared.value.isFile() || prepared.value.uid !== deps.uid) {
    closeFd(fd);
    removeQuiet(temp);
    return prepared.ok ? err(UNSAFE_FILE) : prepared;
  }

  const wrote = attemptFs(() => {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  });
  const closed = attemptFs(() => closeSync(fd));
  if (!wrote.ok) {
    removeQuiet(temp);
    return wrote;
  }
  if (!closed.ok) {
    removeQuiet(temp);
    return closed;
  }
  return ok(temp);
}

// Moves a file over another one, in the same folder. A missing source is
// `not_found`.
export function renameFile(from: string, to: string): Result<null, FsError> {
  if (!isValidFilePath(from) || !isValidFilePath(to)) return err(BAD_INPUT);
  const moved = attemptFs(() => renameSync(from, to));
  return moved.ok ? ok(null) : moved;
}

// Writes a unique 0600 temp file in the same folder, then renames it over the
// target. The temp file is removed on any failure.
export function writeAtomic(path: string, text: string, deps: FsDeps = defaultDeps()): Result<null, FsError> {
  const staged = stageAtomic(path, text, deps);
  if (!staged.ok) return staged;
  const renamed = renameFile(staged.value, path);
  if (!renamed.ok) removeQuiet(staged.value);
  return renamed;
}

// Replace only a missing or private file in the caller's checked data folder.
export function writeOwnFile(path: string, text: string, deps: FsDeps): Result<null, FsError> {
  const stat = lstatEntry(path);
  if (stat.ok && !isOwnPrivateFile(stat.value, deps.uid)) return err(UNSAFE_FILE);
  if (!stat.ok && stat.error.sys !== "ENOENT") return stat;
  return writeAtomic(path, text, deps);
}

// Makes the renames and removals in a folder durable. A file system that cannot
// sync a folder (EINVAL, ENOTSUP) has nothing to wait for.
export function fsyncDir(path: string): Result<null, FsError> {
  if (!isValidDirPath(path)) return err(BAD_INPUT);
  const opened = attemptFs(() => openSync(path, constants.O_RDONLY | constants.O_DIRECTORY));
  if (!opened.ok) return opened;
  const synced = attemptFs(() => fsyncSync(opened.value));
  closeFd(opened.value);
  const unsupported = synced.ok || synced.error.sys === "EINVAL" || synced.error.sys === "ENOTSUP";
  return unsupported ? ok(null) : synced;
}

// Removes the temp files in a folder that are at least `minAgeMs` old, by their
// file time. Only a plain file with a temp name goes: never a link, a folder or
// any other name. A write in progress is far younger than the age, so it stays.
// Looks at the first `cap` names and returns how many files it removed.
export function removeOldTemps(dir: string, nowMs: number, minAgeMs: number, cap: number): Result<number, FsError> {
  const listing = listDir(dir, cap);
  if (!listing.ok) return listing;
  let removed = 0;
  for (const name of listing.value.names) {
    if (!TEMP_NAME.test(name)) continue;
    const path = join(dir, name);
    const info = lstatEntry(path);
    if (!info.ok) {
      if (info.error.code === "not_found") continue;
      return info;
    }
    if (!info.value.isFile() || nowMs - info.value.mtimeMs < minAgeMs) continue;
    const gone = removeFile(path);
    if (!gone.ok) return gone;
    removed += 1;
  }
  return ok(removed);
}

// A private log may end with a complete or partial record but no newline.
// Keep that record separate from the next one. Read at most one byte.
function privateLogPrefix(fd: number, info: Stats, uid: number, cap: number): Result<string, FsError> {
  if (!isOwnPrivateFile(info, uid)) return err(UNSAFE_FILE);
  if (info.size >= cap) return err({ code: "too_large", sys: null });
  if (info.size === 0) return ok("");
  const last = Buffer.alloc(1);
  const read = attemptFs(() => readSync(fd, last, 0, 1, info.size - 1));
  if (!read.ok) return read;
  if (read.value !== 1) return err({ code: "io_error", sys: null });
  return ok(last[0] === 0x0a ? "" : "\n");
}

// Append one record in a single write. A private log checks its byte cap and
// last separator on the same descriptor as the write.
export function appendLine(path: string, line: string, deps: FsDeps = defaultDeps(), privateLogCap?: number): Result<null, FsError> {
  if (!isValidFilePath(path) || /[\r\n]/.test(line)) return err(BAD_INPUT);
  if (privateLogCap !== undefined && !(Number.isSafeInteger(privateLogCap) && privateLogCap > 0)) return err(BAD_INPUT);
  const access = privateLogCap === undefined ? constants.O_WRONLY : constants.O_RDWR;
  const flags = access | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const opened = attemptFs(() => openSync(path, flags, FILE_MODE));
  if (!opened.ok) return opened;
  const fd = opened.value;
  const stat = attemptFs(() => fstatSync(fd));
  if (!stat.ok) {
    closeFd(fd);
    return stat;
  }
  if (!stat.value.isFile() || stat.value.uid !== deps.uid) {
    closeFd(fd);
    return err(UNSAFE_FILE);
  }
  const prefix = privateLogCap === undefined ? ok("") : privateLogPrefix(fd, stat.value, deps.uid, privateLogCap);
  if (!prefix.ok) {
    closeFd(fd);
    return prefix;
  }
  const data = Buffer.from(`${prefix.value}${line}\n`, "utf8");
  const wrote = attemptFs(() => writeSync(fd, data));
  const closed = attemptFs(() => closeSync(fd));
  if (!wrote.ok) return wrote;
  if (wrote.value !== data.length) return err({ code: "io_error", sys: null });
  if (!closed.ok) return closed;
  return ok(null);
}

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

export interface Lock {
  readonly path: string;
  readonly token: string;
}

interface LockBody {
  readonly pid: number;
  // When the holder made or last refreshed the lock, epoch milliseconds.
  readonly startedAtMs: number;
  readonly token: string;
}

const LOCK_LOST: FsError = { code: "lock_held", sys: null };

function lockBodyText(token: string, deps: FsDeps): string {
  return JSON.stringify({ pid: deps.pid, startedAtMs: deps.nowMs(), token });
}

interface LockRead {
  readonly text: string;
  readonly mtimeMs: number;
}

type LockVerdict =
  | { readonly kind: "gone" }
  | { readonly kind: "held" }
  | { readonly kind: "stale"; readonly text: string };

function parseLockBody(text: string): LockBody | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { pid, startedAtMs, token } = parsed as Record<string, unknown>;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return null;
  if (typeof token !== "string" || token.length === 0 || token.length > TOKEN_MAX_CHARS) return null;
  return { pid, startedAtMs, token };
}

// A body over the cap reads as empty, so the file time decides.
function readLockFile(path: string, deps: FsDeps): Result<LockRead, FsError> {
  const opened = openRegularRead(path, deps, true);
  if (!opened.ok) return opened;
  const { fd, size, mtimeMs } = opened.value;
  const body: Result<Buffer, FsError> = size > LOCK_BODY_CAP_BYTES ? ok(Buffer.alloc(0)) : readAll(fd, size);
  closeFd(fd);
  if (!body.ok) return body;
  return ok({ text: DECODER.decode(body.value), mtimeMs });
}

function createLockFile(path: string, body: string): Result<null, FsError> {
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const opened = attemptFs(() => openSync(path, flags, FILE_MODE));
  if (!opened.ok) return opened;
  const fd = opened.value;
  const wrote = attemptFs(() => {
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, body, "utf8");
  });
  const closed = attemptFs(() => closeSync(fd));
  if (!wrote.ok) {
    removeQuiet(path);
    return wrote;
  }
  if (!closed.ok) {
    removeQuiet(path);
    return closed;
  }
  return ok(null);
}

// Stale: not refreshed for LOCK_STALE_MS (the time in the body, else the file
// time), also when its pid is alive, or the pid in the body is dead.
function judgeLock(path: string, deps: FsDeps): Result<LockVerdict, FsError> {
  const read = readLockFile(path, deps);
  if (!read.ok) return read.error.code === "not_found" ? ok({ kind: "gone" }) : read;
  const body = parseLockBody(read.value.text);
  const startedAt = body === null ? read.value.mtimeMs : body.startedAtMs;
  const stale: LockVerdict = { kind: "stale", text: read.value.text };
  if (deps.nowMs() - startedAt >= LOCK_STALE_MS) return ok(stale);
  if (body !== null && !deps.isAlive(body.pid)) return ok(stale);
  return ok({ kind: "held" });
}

// A read-only check. Only acquireLock can claim an available lock.
export function lockAvailable(path: string, deps: FsDeps): boolean {
  const verdict = judgeLock(path, deps);
  return verdict.ok && verdict.value.kind !== "held";
}

// Removes the lock only if it still holds the content judged stale. A small
// race remains between this read and the unlink; the next create decides.
function breakStale(path: string, judgedText: string, deps: FsDeps): Result<null, FsError> {
  const again = readLockFile(path, deps);
  if (!again.ok) return again.error.code === "not_found" ? ok(null) : again;
  if (again.value.text !== judgedText) return ok(null);
  const removed = attemptFs(() => unlinkSync(path));
  if (!removed.ok && removed.error.sys !== "ENOENT") return removed;
  return ok(null);
}

// One try, plus one more after a stale lock is broken. It never waits.
export function acquireLock(path: string, deps: FsDeps = defaultDeps()): Result<Lock, FsError> {
  if (!isValidFilePath(path)) return err(BAD_INPUT);
  const token = randomBytes(TOKEN_BYTES).toString("hex");
  const body = lockBodyText(token, deps);
  for (let attempt = 0; attempt < MAX_LOCK_ATTEMPTS; attempt += 1) {
    const created = createLockFile(path, body);
    if (created.ok) return ok({ path, token });
    if (created.error.sys !== "EEXIST") return created;
    const verdict = judgeLock(path, deps);
    if (!verdict.ok) return verdict;
    if (verdict.value.kind === "held") break;
    if (verdict.value.kind === "stale") {
      const broken = breakStale(path, verdict.value.text, deps);
      if (!broken.ok) return broken;
    }
  }
  return err({ code: "lock_held", sys: null });
}

// Removes the lock file only if it still holds this lock's token and pid.
// Returns true when it removed the file.
export function releaseLock(lock: Lock, deps: FsDeps = defaultDeps()): Result<boolean, FsError> {
  const read = readLockFile(lock.path, deps);
  if (!read.ok) return read.error.code === "not_found" ? ok(false) : read;
  const body = parseLockBody(read.value.text);
  if (body === null || body.token !== lock.token || body.pid !== deps.pid) return ok(false);
  const removed = attemptFs(() => unlinkSync(lock.path));
  if (!removed.ok) return removed.error.sys === "ENOENT" ? ok(false) : removed;
  return ok(true);
}

// Writes the current time into the lock, if the lock still holds this lock's
// token and pid. The stale limit then counts from this write, so a pass that
// keeps working keeps its lock. A lock that is gone, or that another holder took
// over, gives lock_held and nothing is written.
export function refreshLock(lock: Lock, deps: FsDeps = defaultDeps()): Result<null, FsError> {
  const read = readLockFile(lock.path, deps);
  if (!read.ok) return read.error.code === "not_found" ? err(LOCK_LOST) : read;
  const body = parseLockBody(read.value.text);
  if (body === null || body.token !== lock.token || body.pid !== deps.pid) return err(LOCK_LOST);
  return writeAtomic(lock.path, lockBodyText(lock.token, deps), deps);
}
