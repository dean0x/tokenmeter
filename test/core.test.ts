import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  BASIS_SPENT,
  CHUNK_BYTES,
  ERROR_CODES,
  LINE_CAP_BYTES,
  LOCK_STALE_MS,
  MODEL_BASIS_NAMES,
  type Result,
  compareText,
  errorRecord,
  folderKey,
  isFeatureName,
  isLabel,
  parseJson,
  percentile,
  rawTokens,
  sanitizeFeature,
  sanitizeModel,
  sanitizeTime,
  sanitizeTokens,
  utcMonthOf,
  weighted,
} from "../src/core.ts";
import {
  type FsDeps,
  type FsError,
  type FsErrorCode,
  acquireLock,
  appendLine,
  defaultDeps,
  fsyncDir,
  isTempNameOf,
  prepareDataDir,
  refreshLock,
  readOwnFile,
  releaseLock,
  removeOldTemps,
  renameFile,
  resolveDataDirPath,
  safeRead,
  stageAtomic,
  tempPathFor,
  writeAtomic,
} from "../src/fsafe.ts";
import { type LineOptions, parseRow, readLines, readRows } from "../src/lines.ts";
import {
  REAL_HOME,
  SANDBOX_BASE,
  changedDataDirs,
  guardPath,
  installSuiteGuard,
  makeSandbox,
  realDataDirs,
  snapshotRealDataDirs,
  suiteStartSnapshot,
  touchedDataDirs,
} from "./helpers.ts";

installSuiteGuard();

const NOW = Date.parse("2026-11-03T12:00:00Z");

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

function withUmask<T>(mask: number, fn: () => T): T {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

function failureOf<T>(result: Result<T, FsError>): FsErrorCode {
  assert.ok(!result.ok, "expected a failure");
  return result.error.code;
}

function valueOf<T>(result: Result<T, FsError>): T {
  assert.ok(result.ok, "expected success");
  return result.value;
}

function foreignDeps(): FsDeps {
  const deps = defaultDeps();
  return { ...deps, uid: deps.uid + 1 };
}

function sequenceSuffix(...values: string[]): () => string {
  let next = 0;
  return () => {
    const value = values[Math.min(next, values.length - 1)];
    next += 1;
    return value ?? "none";
  };
}

// ---------------------------------------------------------------------------
// Sanitisers and core types (phase 1)
// ---------------------------------------------------------------------------

test("sanitizeModel keeps good names and maps the rest to other", () => {
  assert.equal(sanitizeModel("claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(sanitizeModel("<synthetic>"), "other");
  assert.equal(sanitizeModel("a".repeat(65)), "other");
  assert.equal(sanitizeModel("a".repeat(64)), "a".repeat(64));
  assert.equal(sanitizeModel(5), "other");
  assert.equal(sanitizeModel("ok\n"), "other");
  assert.equal(sanitizeModel("-leading"), "other");
});

test("folderKey maps non-alphanumerics and caps at 200", () => {
  assert.equal(folderKey("/work/example-account/my proj"), "-work-example-account-my-proj");
  assert.equal(folderKey("x".repeat(500)).length, 200);
});

test("sanitizeTokens accepts integers 0 to 1e8 only", () => {
  assert.deepEqual(sanitizeTokens(0), { ok: true, value: 0 });
  assert.deepEqual(sanitizeTokens(1e8), { ok: true, value: 1e8 });
  for (const bad of [-1, 1e8 + 1, 1.5, true, "5", null, NaN, Infinity]) {
    assert.equal(sanitizeTokens(bad).ok, false);
  }
});

test("sanitizeFeature accepts finite numbers 0 to 1e12 and keeps six decimal places", () => {
  assert.deepEqual(sanitizeFeature(0), { ok: true, value: 0 });
  assert.deepEqual(sanitizeFeature(1e12), { ok: true, value: 1e12 });
  assert.deepEqual(sanitizeFeature(0.1234567), { ok: true, value: 0.123457 });
  assert.deepEqual(sanitizeFeature(7), { ok: true, value: 7 });
  for (const bad of [-1, -0.0000001, 1e12 + 1, NaN, Infinity, -Infinity, true, "5", null, undefined, [1]]) {
    assert.equal(sanitizeFeature(bad).ok, false, String(bad));
  }
});

test("isFeatureName accepts 1 to 16 lower case letters, digits and underscores, from a letter, and refuses reserved names", () => {
  for (const good of ["a", "issue_bytes", "churn", "abcdefghijklmnop", "f1", "a_1"]) assert.equal(isFeatureName(good), true, good);
  const reserved = ["elapsed_hours", "constructor", "type", "all", "none", "spent"];
  const bad = ["", "Upper", "1abc", "_x", "has space", "x-y", "abcdefghijklmnopq", ...reserved, "__proto__", 5, null];
  for (const name of bad) assert.equal(isFeatureName(name), false, String(name));
});

test("the model basis names are type, all, none and spent, and no feature may take any of them", () => {
  assert.equal(BASIS_SPENT, "spent");
  assert.deepEqual([...MODEL_BASIS_NAMES].sort(), ["all", "none", "spent", "type"]);
  for (const name of MODEL_BASIS_NAMES) assert.equal(isFeatureName(name), false, name);
});

test("percentile interpolates between the closest ranks, and an empty list gives 0", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([7], 0.9), 7);
  assert.equal(percentile([100, 200, 300, 400, 500], 0.25), 200);
  assert.equal(percentile([100, 200, 400], 0.25), 150);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4], 1), 4);
});

test("parseJson gives the parsed value, or bad_json for text that is not JSON", () => {
  assert.deepEqual(parseJson('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseJson("null"), { ok: true, value: null });
  assert.deepEqual(parseJson("{nope"), { ok: false, error: "bad_json" });
  assert.deepEqual(parseJson(""), { ok: false, error: "bad_json" });
});

test("compareText orders by code unit, with no locale", () => {
  assert.equal(compareText("a", "b"), -1);
  assert.equal(compareText("b", "a"), 1);
  assert.equal(compareText("a", "a"), 0);
  assert.deepEqual(["b", "B", "a", "ab"].sort(compareText), ["B", "a", "ab", "b"]);
});

test("utcMonthOf names the UTC month of a time, and gives null for a time that is not valid", () => {
  assert.equal(utcMonthOf(Date.parse("2026-10-31T23:59:59.999Z")), "2026-10");
  assert.equal(utcMonthOf(Date.parse("2026-11-01T00:00:00Z")), "2026-11");
  assert.equal(utcMonthOf(Date.parse("2026-02-01T05:00:00+10:00")), "2026-01", "a zone offset does not move the month");
  assert.equal(utcMonthOf(Number.NaN), null);
  assert.equal(utcMonthOf(Number.POSITIVE_INFINITY), null);
  assert.equal(utcMonthOf(8.64e15 + 1), null, "past the last time a date can hold");
});

test("sanitizeTime bounds 2020-01-01 to now + 60 s", () => {
  assert.equal(sanitizeTime("2026-11-03T12:01:00Z", NOW).ok, true);
  assert.equal(sanitizeTime("2026-11-03T12:01:01Z", NOW).ok, false);
  assert.equal(sanitizeTime("2019-12-31T23:59:59Z", NOW).ok, false);
  assert.equal(sanitizeTime("2020-01-01T00:00:00Z", NOW).ok, true);
  assert.equal(sanitizeTime("2026-11-03T13:00:00+01:00", NOW).ok, true);
  assert.equal(sanitizeTime("Jan 1 2021", NOW).ok, false);
  assert.equal(sanitizeTime(1_700_000_000_000, NOW).ok, false);
});

test("weighted applies the five weights", () => {
  const w = weighted({ input: 10, cacheWrite5m: 8, cacheWrite1h: 5, cacheRead: 100, output: 2 });
  assert.equal(w, 10 + 10 + 10 + 10 + 10);
});

test("rawTokens adds the five columns with no weight", () => {
  assert.equal(rawTokens({ input: 10, cacheWrite5m: 8, cacheWrite1h: 5, cacheRead: 100, output: 2 }), 125);
  assert.equal(rawTokens({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 }), 0);
});

test("every error code has a fixed hint", () => {
  for (const code of ERROR_CODES) assert.ok(errorRecord(code).hint.length > 0);
});

test("isLabel accepts plain labels only", () => {
  assert.equal(isLabel("B-12"), true);
  assert.equal(isLabel("a b"), false);
  assert.equal(isLabel(""), false);
  assert.equal(isLabel("x".repeat(65)), false);
});

// ---------------------------------------------------------------------------
// TP-11: sandbox and real-home guard
// ---------------------------------------------------------------------------

test("the sandbox is inside the sandbox base and its env points inside it", (t) => {
  const sb = makeSandbox(t);
  assert.ok(sb.root.startsWith(`${SANDBOX_BASE}/sb-`));
  assert.equal(guardPath(sb.root).ok, true);
  for (const key of ["HOME", "XDG_STATE_HOME", "TOKENMETER_DATA_DIR", "TMPDIR"]) {
    const value = sb.env[key];
    assert.ok(value !== undefined && value.startsWith(`${sb.root}/`), `${key} is inside the sandbox`);
  }
});

test("the guard fails on a path under the real home and passes the sandbox", (t) => {
  const sb = makeSandbox(t);
  assert.deepEqual(guardPath(REAL_HOME), { ok: false, error: "under_real_home" });
  assert.deepEqual(guardPath(join(REAL_HOME, "anything")), { ok: false, error: "under_real_home" });
  for (const dir of realDataDirs()) {
    assert.deepEqual(guardPath(dir), { ok: false, error: "under_real_home" });
  }
  assert.equal(guardPath(sb.path("a", "b")).ok, true);
});

test("the guard sees through dot-dot and through a link into the real home", (t) => {
  const sb = makeSandbox(t);
  assert.equal(guardPath(join(sb.root, "..", "..", "src")).ok, false);
  assert.throws(() => sb.path("..", "..", "src"));
  symlinkSync(REAL_HOME, join(sb.root, "evil"));
  assert.equal(guardPath(join(sb.root, "evil", "Library")).ok, false);
  assert.throws(() => sb.path("evil", "Library"));
});

test("the guard allows a path outside the given home", (t) => {
  const sb = makeSandbox(t);
  const fakeHome = sb.path("fake-home");
  mkdirSync(fakeHome);
  const options = { home: fakeHome, allowedBase: sb.path("other") };
  assert.equal(guardPath(join(fakeHome, "x"), options).ok, false);
  assert.equal(guardPath(sb.root, options).ok, true);
});

test("the data folder check sees a folder that appears in the home", (t) => {
  const sb = makeSandbox(t);
  const fakeHome = sb.path("fake-home");
  mkdirSync(fakeHome);
  const before = snapshotRealDataDirs(fakeHome);
  assert.deepEqual(changedDataDirs(before, fakeHome), []);
  const support = join(fakeHome, "Library", "Application Support", "tokenmeter");
  mkdirSync(support, { recursive: true });
  assert.deepEqual(changedDataDirs(before, fakeHome), [support]);
  const xdg = join(fakeHome, ".local", "state", "tokenmeter");
  mkdirSync(xdg, { recursive: true });
  assert.deepEqual(changedDataDirs(before, fakeHome), [support, xdg]);
});

test("the data folder check does not fail on a new mtime of a folder that was there at the start, and lists it as touched", (t) => {
  const sb = makeSandbox(t);
  const fakeHome = sb.path("fake-home");
  const support = join(fakeHome, "Library", "Application Support", "tokenmeter");
  mkdirSync(support, { recursive: true });
  const before = snapshotRealDataDirs(fakeHome);
  assert.deepEqual(touchedDataDirs(before, fakeHome), []);
  // A real run of the tool makes a file in the folder. That moves the mtime of the folder.
  writeFileSync(join(support, "status.json"), "{}");
  utimesSync(support, 1, 1);
  assert.deepEqual(changedDataDirs(before, fakeHome), []);
  assert.deepEqual(touchedDataDirs(before, fakeHome), [support]);
  // A folder that was absent at the start is changed when it appears, never only touched.
  const xdg = join(fakeHome, ".local", "state", "tokenmeter");
  mkdirSync(xdg, { recursive: true });
  assert.deepEqual(changedDataDirs(before, fakeHome), [xdg]);
  assert.deepEqual(touchedDataDirs(before, fakeHome), [support]);
});

test("the data folder check sees a folder that was there at the start and is removed or replaced", (t) => {
  const sb = makeSandbox(t);
  const fakeHome = sb.path("fake-home");
  const support = join(fakeHome, "Library", "Application Support", "tokenmeter");
  mkdirSync(support, { recursive: true });
  const before = snapshotRealDataDirs(fakeHome);
  // The old folder stays under another name, so the new folder cannot take its inode.
  renameSync(support, `${support}-old`);
  assert.deepEqual(changedDataDirs(before, fakeHome), [support]);
  mkdirSync(support);
  assert.deepEqual(changedDataDirs(before, fakeHome), [support]);
  assert.deepEqual(touchedDataDirs(before, fakeHome), []);
});

test("the real default data folders are unchanged by this suite so far", () => {
  assert.deepEqual(changedDataDirs(suiteStartSnapshot()), []);
});

test("default resolution with the sandbox env stays inside the sandbox", (t) => {
  const sb = makeSandbox(t);
  const viaEnv = resolveDataDirPath({ flag: null, env: sb.env, platform: process.platform, homeDir: sb.home });
  assert.equal(viaEnv, sb.dataDir);
  const { TOKENMETER_DATA_DIR: _unused, ...rest } = sb.env;
  const viaDefault = resolveDataDirPath({ flag: null, env: rest, platform: process.platform, homeDir: sb.home });
  assert.equal(guardPath(viaDefault).ok, true);
  assert.ok(viaDefault.startsWith(`${sb.root}/`));
});

// ---------------------------------------------------------------------------
// TP-17: data folder resolution and safety
// ---------------------------------------------------------------------------

test("data folder path: flag, env, then platform defaults", () => {
  const base = { flag: null, env: {}, platform: "linux", homeDir: "/example/account" };
  assert.equal(resolveDataDirPath(base), "/example/account/.local/state/tokenmeter");
  assert.equal(resolveDataDirPath({ ...base, env: { XDG_STATE_HOME: "/xdg" } }), "/xdg/tokenmeter");
  assert.equal(
    resolveDataDirPath({ ...base, platform: "darwin", env: { XDG_STATE_HOME: "/xdg" } }),
    "/example/account/Library/Application Support/tokenmeter",
  );
  const withEnv = { ...base, platform: "darwin", env: { TOKENMETER_DATA_DIR: "/from-env", XDG_STATE_HOME: "/xdg" } };
  assert.equal(resolveDataDirPath(withEnv), "/from-env");
  assert.equal(resolveDataDirPath({ ...withEnv, flag: "/from-flag" }), "/from-flag");
});

test("data folder path ignores empty values and a relative XDG_STATE_HOME", () => {
  const base = { flag: "", env: { TOKENMETER_DATA_DIR: "", XDG_STATE_HOME: "relative/dir" }, platform: "linux", homeDir: "/example/account" };
  assert.equal(resolveDataDirPath(base), "/example/account/.local/state/tokenmeter");
  assert.equal(resolveDataDirPath({ ...base, flag: "/a/b/../c/" }), "/a/c");
});

test("data folder path ignores a relative TOKENMETER_DATA_DIR, but not a relative flag", () => {
  const base = { flag: null, env: { TOKENMETER_DATA_DIR: "relative/data" }, platform: "linux", homeDir: "/example/account" };
  assert.equal(resolveDataDirPath(base), "/example/account/.local/state/tokenmeter");
  const onMac = { ...base, platform: "darwin" };
  assert.equal(resolveDataDirPath(onMac), "/example/account/Library/Application Support/tokenmeter");
  const withXdg = { ...base, env: { ...base.env, XDG_STATE_HOME: "/xdg" } };
  assert.equal(resolveDataDirPath(withXdg), "/xdg/tokenmeter");
  assert.equal(resolveDataDirPath({ ...base, env: { TOKENMETER_DATA_DIR: "/abs/data" } }), "/abs/data");
  assert.equal(resolveDataDirPath({ ...base, flag: "rel/flag" }), resolve("rel/flag"));
});

test("the data folder is created with mode 0700, parents included", (t) => {
  const sb = makeSandbox(t);
  const dir = sb.path("one", "two", "data");
  const result = withUmask(0, () => prepareDataDir(dir));
  assert.deepEqual(result, { ok: true, value: dir });
  assert.equal(modeOf(dir), 0o700);
});

test("an existing safe data folder is accepted and left alone", (t) => {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { mode: 0o700 });
  writeFileSync(join(sb.dataDir, "keep"), "x");
  assert.equal(prepareDataDir(sb.dataDir).ok, true);
  assert.equal(readFileSync(join(sb.dataDir, "keep"), "utf8"), "x");
  chmodSync(sb.dataDir, 0o755);
  assert.equal(prepareDataDir(sb.dataDir).ok, true);
  assert.equal(modeOf(sb.dataDir), 0o755);
});

test("a symlinked data folder is refused", (t) => {
  const sb = makeSandbox(t);
  const real = sb.path("real");
  mkdirSync(real, { mode: 0o700 });
  const link = sb.path("link");
  symlinkSync(real, link);
  assert.equal(failureOf(prepareDataDir(link)), "data_dir_unsafe");
});

test("a data folder that is a regular file is refused", (t) => {
  const sb = makeSandbox(t);
  writeFileSync(sb.dataDir, "not a folder");
  assert.equal(failureOf(prepareDataDir(sb.dataDir)), "data_dir_unsafe");
});

test("a group-writable or world-writable data folder is refused", (t) => {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { mode: 0o700 });
  for (const mode of [0o770, 0o720, 0o707, 0o702, 0o777]) {
    chmodSync(sb.dataDir, mode);
    assert.equal(failureOf(prepareDataDir(sb.dataDir)), "data_dir_unsafe", `mode ${mode.toString(8)}`);
  }
  chmodSync(sb.dataDir, 0o700);
  assert.equal(prepareDataDir(sb.dataDir).ok, true);
});

test("a data folder owned by another user is refused", (t) => {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { mode: 0o700 });
  assert.equal(failureOf(prepareDataDir(sb.dataDir, foreignDeps())), "data_dir_unsafe");
});

test("a data folder below a group-writable or world-writable parent is refused, and nothing is made there", (t) => {
  const sb = makeSandbox(t);
  const parent = sb.path("shared");
  mkdirSync(parent, { mode: 0o700 });
  const target = join(parent, "data");
  for (const mode of [0o770, 0o720, 0o707, 0o702, 0o777]) {
    chmodSync(parent, mode);
    assert.equal(failureOf(prepareDataDir(target)), "data_dir_unsafe", `mode ${mode.toString(8)}`);
    assert.equal(existsSync(target), false, `mode ${mode.toString(8)}: no folder is made`);
  }
  chmodSync(parent, 0o700);
  assert.equal(prepareDataDir(target).ok, true);
});

test("a data folder below a parent that others can write is accepted when the parent has the sticky bit", (t) => {
  const sb = makeSandbox(t);
  const parent = sb.path("sticky");
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o1777);
  assert.equal(prepareDataDir(join(parent, "data")).ok, true);
  chmodSync(parent, 0o1770);
  assert.equal(prepareDataDir(join(parent, "data")).ok, true);
});

test("a data folder below a read-only parent for others is accepted, also when the parent is a link", (t) => {
  const sb = makeSandbox(t);
  const real = sb.path("real-parent");
  mkdirSync(real, { mode: 0o700 });
  chmodSync(real, 0o755);
  assert.equal(prepareDataDir(join(real, "data")).ok, true);
  const link = sb.path("link-parent");
  symlinkSync(real, link);
  assert.equal(prepareDataDir(join(link, "data2")).ok, true);
});

test("a relative data folder path is refused", () => {
  assert.equal(failureOf(prepareDataDir("relative/data")), "bad_input");
});

test("written and appended files have mode 0600 whatever the umask", (t) => {
  const sb = makeSandbox(t);
  const written = sb.path("written.json");
  const appended = sb.path("appended.jsonl");
  withUmask(0, () => {
    valueOf(writeAtomic(written, "{}"));
    valueOf(appendLine(appended, "{}"));
  });
  assert.equal(modeOf(written), 0o600);
  assert.equal(modeOf(appended), 0o600);
});

// ---------------------------------------------------------------------------
// safeRead
// ---------------------------------------------------------------------------

test("safeRead returns the text and enforces the byte cap", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.txt");
  writeFileSync(file, "x".repeat(100));
  assert.deepEqual(safeRead(file, 100), { ok: true, value: "x".repeat(100) });
  assert.equal(failureOf(safeRead(file, 99)), "too_large");
  assert.equal(failureOf(safeRead(file, -1)), "bad_input");
});

test("safeRead reports a missing file and replaces invalid UTF-8", (t) => {
  const sb = makeSandbox(t);
  assert.equal(failureOf(safeRead(sb.path("missing"), 10)), "not_found");
  const file = sb.path("bad.txt");
  writeFileSync(file, Buffer.from([0x61, 0xff, 0x62]));
  assert.deepEqual(safeRead(file, 10), { ok: true, value: "a�b" });
});

test("safeRead refuses a symlink and does not read its target", (t) => {
  const sb = makeSandbox(t);
  const target = sb.path("target.txt");
  writeFileSync(target, "secret");
  const link = sb.path("link.txt");
  symlinkSync(target, link);
  assert.equal(failureOf(safeRead(link, 100)), "unsafe_file");
});

test("safeRead refuses a folder and a named pipe without blocking", { timeout: 10_000 }, (t) => {
  const sb = makeSandbox(t);
  assert.equal(failureOf(safeRead(sb.root, 100)), "unsafe_file");
  const fifo = sb.path("pipe");
  const made = spawnSync("mkfifo", [fifo], { env: sb.env });
  assert.equal(made.status, 0);
  assert.equal(failureOf(safeRead(fifo, 100)), "unsafe_file");
});

test("safeRead refuses a file owned by another user", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.txt");
  writeFileSync(file, "x");
  assert.equal(failureOf(safeRead(file, 10, foreignDeps())), "unsafe_file");
});

// ---------------------------------------------------------------------------
// readOwnFile
// ---------------------------------------------------------------------------

test("readOwnFile reads a private regular file", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.txt");
  writeFileSync(file, "hello");
  chmodSync(file, 0o600);
  assert.deepEqual(readOwnFile(file, 5, defaultDeps()), { ok: true, value: "hello" });
});

test("readOwnFile gives a failure code for a missing, over-cap, shared, linked, foreign or folder path", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.txt");
  writeFileSync(file, "hello");
  chmodSync(file, 0o600);
  assert.deepEqual(readOwnFile(sb.path("missing"), 5, defaultDeps()), { ok: false, error: "missing" });
  assert.deepEqual(readOwnFile(file, 4, defaultDeps()), { ok: false, error: "too_large" });
  assert.deepEqual(readOwnFile(file, 5, foreignDeps()), { ok: false, error: "unsafe" });
  const link = sb.path("link.txt");
  symlinkSync(file, link);
  assert.deepEqual(readOwnFile(link, 5, defaultDeps()), { ok: false, error: "unsafe" });
  assert.deepEqual(readOwnFile(sb.root, 5, defaultDeps()), { ok: false, error: "unsafe" });
  for (const mode of [0o640, 0o604, 0o644]) {
    chmodSync(file, mode);
    assert.deepEqual(readOwnFile(file, 5, defaultDeps()), { ok: false, error: "unsafe" }, mode.toString(8));
  }
});

// ---------------------------------------------------------------------------
// writeAtomic
// ---------------------------------------------------------------------------

test("writeAtomic replaces the content and leaves no temp file", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("store.json");
  valueOf(writeAtomic(file, "first"));
  valueOf(writeAtomic(file, "second"));
  assert.equal(readFileSync(file, "utf8"), "second");
  assert.deepEqual(readdirSync(sb.root).filter((n) => n.includes("store")), ["store.json"]);
});

test("writeAtomic uses a new temp name when one exists and keeps the old file", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("store.json");
  const planted = tempPathFor(file, "dup");
  writeFileSync(planted, "planted");
  const deps = { ...defaultDeps(), suffix: sequenceSuffix("dup", "fresh") };
  valueOf(writeAtomic(file, "data", deps));
  assert.equal(readFileSync(file, "utf8"), "data");
  assert.equal(readFileSync(planted, "utf8"), "planted");
});

test("a symlink planted at a temp name does not redirect the write", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("store.json");
  const victim = sb.path("victim.txt");
  writeFileSync(victim, "victim");
  const planted = tempPathFor(file, "dup");
  symlinkSync(victim, planted);
  const deps = { ...defaultDeps(), suffix: sequenceSuffix("dup", "fresh") };
  valueOf(writeAtomic(file, "data", deps));
  assert.equal(readFileSync(victim, "utf8"), "victim");
  assert.equal(readFileSync(file, "utf8"), "data");
  assert.ok(lstatSync(planted).isSymbolicLink());
});

test("writeAtomic gives up after a bounded number of temp name clashes", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("store.json");
  const planted = tempPathFor(file, "dup");
  writeFileSync(planted, "planted");
  const deps = { ...defaultDeps(), suffix: sequenceSuffix("dup") };
  assert.equal(failureOf(writeAtomic(file, "data", deps)), "io_error");
  assert.equal(readFileSync(planted, "utf8"), "planted");
  assert.deepEqual(readdirSync(sb.root).filter((n) => n.startsWith(".store.json")), [".store.json.dup.tmp"]);
});

test("writeAtomic removes its temp file when the rename fails", (t) => {
  const sb = makeSandbox(t);
  const target = sb.path("store.json");
  mkdirSync(target);
  const deps = { ...defaultDeps(), suffix: sequenceSuffix("only") };
  const result = writeAtomic(target, "data", deps);
  assert.ok(!result.ok && result.error.code === "io_error");
  assert.ok(["EISDIR", "ENOTEMPTY", "EEXIST"].includes(result.error.sys ?? ""));
  assert.throws(() => lstatSync(tempPathFor(target, "only")));
  assert.ok(lstatSync(target).isDirectory());
  assert.deepEqual(readdirSync(sb.root).filter((n) => n.endsWith(".tmp")), []);
});

test("writeAtomic replaces a symlink at the destination and does not follow it", (t) => {
  const sb = makeSandbox(t);
  const victim = sb.path("victim.txt");
  writeFileSync(victim, "victim");
  const file = sb.path("store.json");
  symlinkSync(victim, file);
  valueOf(writeAtomic(file, "data"));
  assert.equal(readFileSync(victim, "utf8"), "victim");
  assert.ok(lstatSync(file).isFile());
  assert.equal(readFileSync(file, "utf8"), "data");
});

test("default temp suffixes are unique", () => {
  const deps = defaultDeps();
  const seen = new Set<string>();
  for (let i = 0; i < 1000; i += 1) seen.add(deps.suffix());
  assert.equal(seen.size, 1000);
});

test("writeAtomic refuses a relative path", () => {
  assert.equal(failureOf(writeAtomic("relative.json", "x")), "bad_input");
});

// ---------------------------------------------------------------------------
// stageAtomic, renameFile, fsyncDir, isTempNameOf, removeOldTemps
// ---------------------------------------------------------------------------

test("stageAtomic writes a 0600 temp file and leaves the target as it was", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("store.json");
  writeFileSync(file, "old");
  const deps = { ...defaultDeps(), suffix: sequenceSuffix("one") };
  const temp = valueOf(stageAtomic(file, "new", deps));
  assert.equal(temp, tempPathFor(file, "one"));
  assert.equal(readFileSync(temp, "utf8"), "new");
  assert.equal(modeOf(temp), 0o600);
  assert.equal(readFileSync(file, "utf8"), "old");
  valueOf(renameFile(temp, file));
  assert.equal(readFileSync(file, "utf8"), "new");
  assert.equal(failureOf(renameFile(temp, file)), "not_found");
  assert.equal(failureOf(renameFile("relative.json", file)), "bad_input");
});

test("fsyncDir accepts a folder and refuses a missing folder and a relative path", (t) => {
  const sb = makeSandbox(t);
  valueOf(fsyncDir(sb.root));
  assert.equal(failureOf(fsyncDir(sb.path("missing"))), "not_found");
  assert.equal(failureOf(fsyncDir("relative")), "bad_input");
});

test("isTempNameOf accepts only the temp name that tempPathFor makes for that file", () => {
  assert.ok(isTempNameOf("store.json", ".store.json.123-abc.tmp"));
  assert.ok(isTempNameOf("store.json", ".store.json.dup.tmp"));
  const refused = [
    ".store.json.tmp",
    ".store.json..tmp",
    ".ledger.json.123-abc.tmp",
    "store.json.123-abc.tmp",
    ".store.json.123-abc",
    ".store.json.12/3.tmp",
    "../.store.json.1.tmp",
    `.store.json.${"a".repeat(65)}.tmp`,
  ];
  for (const name of refused) assert.equal(isTempNameOf("store.json", name), false, name);
});

test("removeOldTemps removes only old plain files with a temp name, and reads at most cap names", (t) => {
  const sb = makeSandbox(t);
  const old = NOW - 10 * 60_000;
  const make = (name: string, mtimeMs: number): void => {
    const path = sb.path(name);
    writeFileSync(path, "x");
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  };
  make(".a.json.1-x.tmp", old);
  make(".b.jsonl.2-x.tmp", old);
  make(".c.json.3-x.tmp", NOW - 1000);
  make("d.tmp", old);
  make(".e.txt.4-x.tmp", old);
  symlinkSync(sb.path("d.tmp"), sb.path(".f.json.5-x.tmp"));
  mkdirSync(sb.path(".g.json.6-x.tmp"));

  assert.equal(valueOf(removeOldTemps(sb.root, NOW, 60_000, 100)), 2);
  assert.deepEqual(
    readdirSync(sb.root).filter((name) => name.endsWith(".tmp")).sort(),
    [".c.json.3-x.tmp", ".e.txt.4-x.tmp", ".f.json.5-x.tmp", ".g.json.6-x.tmp", "d.tmp"],
  );
  assert.equal(failureOf(removeOldTemps(sb.path("missing"), NOW, 60_000, 100)), "not_found");
  assert.equal(failureOf(removeOldTemps("relative", NOW, 60_000, 100)), "bad_input");

  make(".h.json.7-x.tmp", old);
  make(".i.json.8-x.tmp", old);
  const cut = valueOf(removeOldTemps(sb.root, NOW, 60_000, 1));
  assert.ok(cut <= 1, "one name is looked at");
});

// ---------------------------------------------------------------------------
// appendLine
// ---------------------------------------------------------------------------

test("appendLine adds one line at a time and keeps earlier content", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("log.jsonl");
  valueOf(appendLine(file, "one"));
  valueOf(appendLine(file, "two"));
  assert.equal(readFileSync(file, "utf8"), "one\ntwo\n");
});

test("appendLine refuses a symlink and writes nothing to its target", (t) => {
  const sb = makeSandbox(t);
  const victim = sb.path("victim.txt");
  writeFileSync(victim, "victim");
  const link = sb.path("log.jsonl");
  symlinkSync(victim, link);
  assert.equal(failureOf(appendLine(link, "line")), "unsafe_file");
  assert.equal(readFileSync(victim, "utf8"), "victim");
});

test("appendLine refuses a line with a newline and writes nothing", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("log.jsonl");
  assert.equal(failureOf(appendLine(file, "a\nb")), "bad_input");
  assert.equal(failureOf(appendLine(file, "a\rb")), "bad_input");
  assert.throws(() => statSync(file));
});

for (const cap of [NaN, 0, -1, 0.5]) {
  test(`appendLine rejects cap ${cap} without creating or modifying a file`, (t) => {
    const sb = makeSandbox(t);
    const missing = sb.path("missing.jsonl");
    const existing = sb.path("existing.jsonl");
    writeFileSync(existing, "keep\n", { mode: 0o600 });

    assert.equal(failureOf(appendLine(missing, "line", undefined, cap)), "bad_input");
    assert.throws(() => lstatSync(missing), { code: "ENOENT" });
    assert.equal(failureOf(appendLine(existing, "line", undefined, cap)), "bad_input");
    assert.equal(readFileSync(existing, "utf8"), "keep\n");
  });
}

test("appendLine refuses a file owned by another user and a folder", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("log.jsonl");
  writeFileSync(file, "keep\n");
  assert.equal(failureOf(appendLine(file, "x", foreignDeps())), "unsafe_file");
  assert.equal(readFileSync(file, "utf8"), "keep\n");
  assert.equal(appendLine(sb.root, "x").ok, false);
});

// ---------------------------------------------------------------------------
// Lock
// ---------------------------------------------------------------------------

function lockDeps(nowMs: number, alive: boolean): FsDeps {
  return { ...defaultDeps(), nowMs: () => nowMs, isAlive: () => alive };
}

function readLock(path: string): { pid: number; startedAtMs: number; token: string } {
  return JSON.parse(readFileSync(path, "utf8")) as { pid: number; startedAtMs: number; token: string };
}

test("acquireLock writes a 0600 file with the pid and start time", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  const lock = valueOf(withUmask(0, () => acquireLock(path, lockDeps(NOW, true))));
  assert.equal(modeOf(path), 0o600);
  const content = readLock(path);
  assert.equal(content.pid, process.pid);
  assert.equal(content.startedAtMs, NOW);
  assert.equal(content.token, lock.token);
});

test("a live young lock is not broken", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  valueOf(acquireLock(path, lockDeps(NOW, true)));
  const before = readFileSync(path, "utf8");
  assert.equal(failureOf(acquireLock(path, lockDeps(NOW + LOCK_STALE_MS - 1, true))), "lock_held");
  assert.equal(readFileSync(path, "utf8"), before);
});

test("a lock that nobody refreshed for 120 s is broken even when the pid is alive", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  valueOf(acquireLock(path, lockDeps(NOW, true)));
  const second = valueOf(acquireLock(path, lockDeps(NOW + LOCK_STALE_MS, true)));
  assert.equal(readLock(path).token, second.token);
  assert.equal(readLock(path).startedAtMs, NOW + LOCK_STALE_MS);
});

test("refreshLock writes a new time into its own lock, and the 120 s count starts again", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  const mine = valueOf(acquireLock(path, lockDeps(NOW, true)));
  const later = NOW + LOCK_STALE_MS - 1000;
  valueOf(refreshLock(mine, lockDeps(later, true)));
  const content = readLock(path);
  assert.deepEqual(content, { pid: process.pid, startedAtMs: later, token: mine.token });
  assert.equal(modeOf(path), 0o600);
  assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")), [], "no temp file stays");
  // 120 s after the first start the lock is still young. 120 s after the refresh it is not.
  assert.equal(failureOf(acquireLock(path, lockDeps(NOW + LOCK_STALE_MS, true))), "lock_held");
  const second = valueOf(acquireLock(path, lockDeps(later + LOCK_STALE_MS, true)));
  assert.equal(readLock(path).token, second.token);
});

test("refreshLock gives lock_held and writes nothing when another holder took the lock over", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  const mine = valueOf(acquireLock(path, lockDeps(NOW, true)));
  const theirs = valueOf(acquireLock(path, lockDeps(NOW + LOCK_STALE_MS, true)));
  const before = readFileSync(path, "utf8");
  assert.equal(failureOf(refreshLock(mine, lockDeps(NOW + LOCK_STALE_MS + 1000, true))), "lock_held");
  assert.equal(readFileSync(path, "utf8"), before);
  assert.equal(readLock(path).token, theirs.token);
  assert.deepEqual(readdirSync(dirname(path)).filter((name) => name.endsWith(".tmp")), []);
});

test("refreshLock gives lock_held when the lock is gone", (t) => {
  const sb = makeSandbox(t);
  const lock = { path: sb.path("collect.lock"), token: "none" };
  assert.equal(failureOf(refreshLock(lock, lockDeps(NOW, true))), "lock_held");
  assert.equal(existsSync(lock.path), false, "a refresh never makes a lock");
});

test("refreshLock gives lock_held for the same token under another pid, and for a body it cannot read", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  const mine = valueOf(acquireLock(path, lockDeps(NOW, true)));
  const other = JSON.stringify({ pid: process.pid + 1, startedAtMs: NOW, token: mine.token });
  writeFileSync(path, other);
  assert.equal(failureOf(refreshLock(mine, lockDeps(NOW + 1000, true))), "lock_held");
  assert.equal(readFileSync(path, "utf8"), other);
  writeFileSync(path, "garbage");
  assert.equal(failureOf(refreshLock(mine, lockDeps(NOW + 1000, true))), "lock_held");
  assert.equal(readFileSync(path, "utf8"), "garbage");
});

test("refreshLock does not follow a symlink at the lock path", (t) => {
  const sb = makeSandbox(t);
  const victim = sb.path("victim.txt");
  writeFileSync(victim, "victim");
  const path = sb.path("collect.lock");
  symlinkSync(victim, path);
  assert.equal(failureOf(refreshLock({ path, token: "none" }, lockDeps(NOW, true))), "unsafe_file");
  assert.equal(readFileSync(victim, "utf8"), "victim");
  assert.ok(lstatSync(path).isSymbolicLink());
});

test("a young lock with a dead pid is broken", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  valueOf(acquireLock(path, lockDeps(NOW, true)));
  valueOf(acquireLock(path, lockDeps(NOW + 1000, false)));
});

test("the real pid check: a finished child is dead and this process is alive", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  const child = spawnSync(process.execPath, ["--version"], { env: sb.env });
  assert.ok(child.pid !== undefined && child.pid > 0);
  const now = Date.now();
  writeFileSync(path, JSON.stringify({ pid: child.pid, startedAtMs: now, token: "old" }), { mode: 0o600 });
  const taken = valueOf(acquireLock(path));
  assert.notEqual(taken.token, "old");
  assert.equal(failureOf(acquireLock(path)), "lock_held");
});

test("an unreadable lock body falls back to the file time", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  writeFileSync(path, "garbage", { mode: 0o600 });
  const live = { ...defaultDeps(), isAlive: () => true };
  assert.equal(failureOf(acquireLock(path, live)), "lock_held");
  const old = (Date.now() - 2 * LOCK_STALE_MS) / 1000;
  utimesSync(path, old, old);
  valueOf(acquireLock(path, live));
});

test("a symlink at the lock path is refused and not followed", (t) => {
  const sb = makeSandbox(t);
  const victim = sb.path("victim.txt");
  writeFileSync(victim, "victim");
  const path = sb.path("collect.lock");
  symlinkSync(victim, path);
  assert.equal(failureOf(acquireLock(path, lockDeps(NOW, false))), "unsafe_file");
  assert.equal(readFileSync(victim, "utf8"), "victim");
});

test("releaseLock removes its own lock and a new acquire then works", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  const lock = valueOf(acquireLock(path, lockDeps(NOW, true)));
  assert.deepEqual(releaseLock(lock), { ok: true, value: true });
  assert.throws(() => statSync(path));
  valueOf(acquireLock(path, lockDeps(NOW, true)));
});

test("releaseLock leaves a lock that another holder took over", (t) => {
  const sb = makeSandbox(t);
  const path = sb.path("collect.lock");
  const mine = valueOf(acquireLock(path, lockDeps(NOW, true)));
  const theirs = valueOf(acquireLock(path, lockDeps(NOW + LOCK_STALE_MS, true)));
  assert.deepEqual(releaseLock(mine), { ok: true, value: false });
  assert.equal(readLock(path).token, theirs.token);
});

test("releaseLock on a missing lock removes nothing", (t) => {
  const sb = makeSandbox(t);
  const lock = { path: sb.path("collect.lock"), token: "none" };
  assert.deepEqual(releaseLock(lock), { ok: true, value: false });
});

// ---------------------------------------------------------------------------
// Line reader
// ---------------------------------------------------------------------------

function collect(path: string, options: LineOptions, deps?: FsDeps) {
  const lines: string[] = [];
  const result = readLines(path, options, (line) => lines.push(line), deps);
  return { lines, result };
}

test("a partial last line keeps the offset before it, and resume reads the rest", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, "one\ntwo\npart");
  const first = collect(file, { offset: 0 });
  assert.deepEqual(first.lines, ["one", "two"]);
  const scan = valueOf(first.result);
  assert.equal(scan.offset, 8);
  assert.equal(scan.size, 12);
  appendFileSync(file, "ial\nthree\n");
  const second = collect(file, { offset: scan.offset });
  assert.deepEqual(second.lines, ["partial", "three"]);
  assert.equal(valueOf(second.result).offset, 8 + "partial\n".length + "three\n".length);
});

test("resume from the saved offset reads only the new lines", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, "a\nb\n");
  const first = valueOf(collect(file, { offset: 0 }).result);
  assert.equal(first.offset, 4);
  const idle = collect(file, { offset: first.offset });
  assert.deepEqual(idle.lines, []);
  assert.equal(valueOf(idle.result).offset, 4);
  appendFileSync(file, "c\n");
  assert.deepEqual(collect(file, { offset: 4 }).lines, ["c"]);
});

test("a 2 MiB line is skipped, counted and never delivered", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  const huge = Buffer.alloc(2 * 1024 * 1024, 0x78);
  writeFileSync(file, Buffer.concat([Buffer.from("first\n"), huge, Buffer.from("\nlast\n")]));
  const { lines, result } = collect(file, { offset: 0 });
  assert.deepEqual(lines, ["first", "last"]);
  const scan = valueOf(result);
  assert.equal(scan.skippedLong, 1);
  assert.equal(scan.offset, scan.size);
});

test("the line cap is exactly 1 MiB", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  const atCap = "y".repeat(LINE_CAP_BYTES);
  const overCap = "z".repeat(LINE_CAP_BYTES + 1);
  writeFileSync(file, `${atCap}\n${overCap}\nend\n`);
  const { lines, result } = collect(file, { offset: 0 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0]?.length, LINE_CAP_BYTES);
  assert.equal(lines[1], "end");
  assert.equal(valueOf(result).skippedLong, 1);
});

test("an over-long unfinished tail is not counted and the offset stays before it", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, Buffer.concat([Buffer.from("ok\n"), Buffer.alloc(2 * 1024 * 1024, 0x78)]));
  const { lines, result } = collect(file, { offset: 0 });
  assert.deepEqual(lines, ["ok"]);
  const scan = valueOf(result);
  assert.equal(scan.skippedLong, 0);
  assert.equal(scan.offset, 3);
});

test("invalid UTF-8 is replaced per line and the line is still delivered", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, Buffer.concat([Buffer.from('{"x":"'), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('"}\nnext\n')]));
  const { lines } = collect(file, { offset: 0 });
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '{"x":"���"}');
  assert.equal(lines[1], "next");
});

test("a multi-byte character across a chunk boundary decodes whole", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  const line = `${"a".repeat(CHUNK_BYTES - 1)}é${"b".repeat(10)}`;
  writeFileSync(file, `${line}\ntail\n`);
  assert.deepEqual(collect(file, { offset: 0 }).lines, [line, "tail"]);
});

test("CRLF line ends are handled", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, "a\r\nb\r\n\r\nc\n");
  const { lines, result } = collect(file, { offset: 0 });
  assert.deepEqual(lines, ["a", "b", "c"]);
  assert.equal(valueOf(result).offset, 10);
});

test("empty lines are skipped and the last line may lack a newline", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, "a\n\n\nb\nc");
  const { lines, result } = collect(file, { offset: 0 });
  assert.deepEqual(lines, ["a", "b"]);
  assert.equal(valueOf(result).offset, 6);
});

test("the pre-filter drops lines before delivery and still moves the offset", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, '{"t":"usage"}\n{"t":"other"}\n{"t":"token_count"}\n');
  const one = collect(file, { offset: 0, prefilter: ["usage"] });
  assert.deepEqual(one.lines, ['{"t":"usage"}']);
  const scan = valueOf(one.result);
  assert.equal(scan.lines, 3);
  assert.equal(scan.delivered, 1);
  assert.equal(scan.filtered, 2);
  assert.equal(scan.offset, scan.size);
  const any = collect(file, { offset: 0, prefilter: ["usage", "token_count"] });
  assert.equal(any.lines.length, 2);
  assert.equal(collect(file, { offset: 0, prefilter: [] }).lines.length, 3);
});

test("maxBytes stops the read and the offset stays on the last whole line", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, "123456789\n".repeat(10));
  const first = collect(file, { offset: 0, maxBytes: 35 });
  assert.equal(first.lines.length, 3);
  assert.equal(valueOf(first.result).offset, 30);
  const rest = collect(file, { offset: 30 });
  assert.equal(rest.lines.length, 7);
  assert.equal(valueOf(rest.result).offset, 100);
});

test("an offset past the end reads nothing and keeps the offset", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, "abc\n");
  const { lines, result } = collect(file, { offset: 50 });
  assert.deepEqual(lines, []);
  const scan = valueOf(result);
  assert.equal(scan.offset, 50);
  assert.equal(scan.size, 4);
});

test("the scan reports the file identity for change detection", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, "abc\n");
  const scan = valueOf(collect(file, { offset: 0 }).result);
  const st = statSync(file);
  assert.equal(scan.dev, st.dev);
  assert.equal(scan.ino, st.ino);
});

test("the reader refuses a symlink, a missing file and a foreign owner", (t) => {
  const sb = makeSandbox(t);
  const target = sb.path("t.jsonl");
  writeFileSync(target, "a\n");
  const link = sb.path("l.jsonl");
  symlinkSync(target, link);
  assert.equal(failureOf(collect(link, { offset: 0 }).result), "unsafe_file");
  assert.equal(failureOf(collect(sb.path("none.jsonl"), { offset: 0 }).result), "not_found");
  assert.equal(failureOf(collect(target, { offset: 0 }, foreignDeps()).result), "unsafe_file");
  assert.equal(failureOf(collect(target, { offset: -1 }).result), "bad_input");
  assert.equal(failureOf(collect(target, { offset: 0, maxBytes: -5 }).result), "bad_input");
});

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

test("random line lengths over many chunks match a plain split", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  const next = lcg(7);
  const alphabet = ["a", "b", "é", "€", "\u{1F600}"];
  const expected: string[] = [];
  const parts: string[] = [];
  for (let i = 0; i < 300; i += 1) {
    const length = Math.floor(next() ** 3 * 12000);
    let line = "";
    for (let c = 0; c < length; c += 1) line += alphabet[Math.floor(next() * alphabet.length)] ?? "a";
    if (line.length > 0) expected.push(line);
    parts.push(line);
  }
  const body = Buffer.from(`${parts.join("\n")}\n`, "utf8");
  assert.ok(body.length > 3 * CHUNK_BYTES);
  writeFileSync(file, body);
  const { lines, result } = collect(file, { offset: 0 });
  assert.deepEqual(lines, expected);
  assert.equal(valueOf(result).offset, body.length);
});

// ---------------------------------------------------------------------------
// Rows: parse, count by reason code only
// ---------------------------------------------------------------------------

test("parseRow accepts objects and gives a reason code otherwise", () => {
  assert.deepEqual(parseRow('{"a":1}'), { ok: true, value: { a: 1 } });
  assert.deepEqual(parseRow("not json"), { ok: false, error: "bad_json" });
  assert.deepEqual(parseRow("[1,2]"), { ok: false, error: "not_object" });
  assert.deepEqual(parseRow("null"), { ok: false, error: "not_object" });
  assert.deepEqual(parseRow('"text"'), { ok: false, error: "not_object" });
  assert.deepEqual(parseRow("42"), { ok: false, error: "not_object" });
});

test("readRows delivers objects and counts failures by reason without any line text", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(
    file,
    ['{"a":1}', "CANARY-bad-json {", "[1]", '"CANARY-string"', "null", "7", '{"b":2}', ""].join("\n"),
  );
  const rows: unknown[] = [];
  const scan = valueOf(readRows(file, { offset: 0 }, (row) => rows.push(row)));
  assert.deepEqual(rows, [{ a: 1 }, { b: 2 }]);
  assert.equal(scan.rows, 2);
  assert.equal(scan.badJson, 1);
  assert.equal(scan.notObject, 4);
  assert.equal(scan.offset, scan.size);
  assert.ok(!JSON.stringify(scan).includes("CANARY"));
});

test("readRows refuses a file whose opened descriptor has a different identity", (t) => {
  const box = makeSandbox(t);
  const file = box.path("rows.jsonl");
  writeFileSync(file, '{"a":1}\n');
  const { dev, ino } = statSync(file);
  const rows: unknown[] = [];
  const scanned = readRows(file, { offset: 0, identity: { dev, ino: ino === 0 ? 1 : 0 } }, (row) => rows.push(row));
  assert.deepEqual(scanned, { ok: false, error: { code: "unsafe_file", sys: null } });
  assert.deepEqual(rows, []);
});

test("readRows applies the pre-filter before any parse", (t) => {
  const sb = makeSandbox(t);
  const file = sb.path("a.jsonl");
  writeFileSync(file, '{"type":"usage"}\nbroken line without the word\n{"type":"x"}\n');
  const rows: unknown[] = [];
  const scan = valueOf(readRows(file, { offset: 0, prefilter: ["usage"] }, (row) => rows.push(row)));
  assert.equal(rows.length, 1);
  assert.equal(scan.badJson, 0);
  assert.equal(scan.filtered, 2);
});
