// Test sandbox and real-home guard.
//
// Every test keeps its data folder, its sources and its writes inside a sandbox
// made with mkdtemp under `state-test/` in this repo (git-ignored). The system
// temp folder is never used. HOME, XDG_STATE_HOME, TOKENMETER_DATA_DIR and TMPDIR
// point inside the sandbox, for child processes and for injected env.
//
// The repo can sit inside the real home. So the guard cannot ask for a sandbox
// outside the home. It refuses every path under the real home except the one
// sandbox base, and it refuses the real default data folders by name.

import { after } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type Result, err, ok } from "../src/core.ts";

// Read before any env change. userInfo() uses the account database, not $HOME.
export const REAL_HOME: string = realpathSync(userInfo().homedir);

const REPO_ROOT = resolve(import.meta.dirname, "..");
export const SANDBOX_BASE: string = join(REPO_ROOT, "state-test");

const MAX_ANCESTOR_STEPS = 256;

function isWithin(base: string, candidate: string): boolean {
  const rel = relative(base, candidate);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return !isAbsolute(rel);
}

// Resolve symlinks in the longest existing part of the path, so a link inside
// the sandbox that points into the real home is seen for what it is.
function canonical(path: string): string {
  const absolute = resolve(path);
  let probe = absolute;
  let rest = "";
  for (let step = 0; step < MAX_ANCESTOR_STEPS; step += 1) {
    try {
      return join(realpathSync.native(probe), rest);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute;
      rest = rest === "" ? probe.slice(parent.length + 1) : join(probe.slice(parent.length + 1), rest);
      probe = parent;
    }
  }
  return absolute;
}

export type GuardOptions = { readonly home?: string; readonly allowedBase?: string };

// Fails on a path under the real home, unless it is inside the allowed base.
export function guardPath(path: string, options: GuardOptions = {}): Result<string, "under_real_home"> {
  const home = options.home ?? REAL_HOME;
  const base = canonical(options.allowedBase ?? SANDBOX_BASE);
  const target = canonical(path);
  if (isWithin(home, target) && !isWithin(base, target)) return err("under_real_home");
  return ok(target);
}

export function assertGuarded(path: string, options: GuardOptions = {}): string {
  const checked = guardPath(path, options);
  assert.ok(checked.ok, "path is under the real home and outside the sandbox base");
  return checked.value;
}

// ---------------------------------------------------------------------------
// The real default data folders must stay as they were.
// ---------------------------------------------------------------------------

// The identity of a folder is its device and inode, or "absent". The mtime is kept
// apart: it changes each time a file in the folder is made or renamed, and a real
// `collect` or `record` run (a cron job or a status line) can do that during a test run.
interface DirState {
  readonly identity: string;
  readonly mtimeMs: number | null;
}

export type DirSnapshot = ReadonlyMap<string, DirState>;

export function realDataDirs(home: string = REAL_HOME): readonly string[] {
  return [
    join(home, "Library", "Application Support", "tokenmeter"),
    join(home, ".local", "state", "tokenmeter"),
  ];
}

function stateOf(path: string): DirState {
  try {
    const st = lstatSync(path);
    return { identity: `${st.dev}:${st.ino}`, mtimeMs: st.mtimeMs };
  } catch {
    return { identity: "absent", mtimeMs: null };
  }
}

export function snapshotRealDataDirs(home: string = REAL_HOME): DirSnapshot {
  return new Map(realDataDirs(home).map((dir) => [dir, stateOf(dir)]));
}

// Returns the folders that appeared, vanished or were replaced since the snapshot.
// A folder that was there at the start stays unchanged while its mtime moves.
export function changedDataDirs(before: DirSnapshot, home: string = REAL_HOME): readonly string[] {
  return realDataDirs(home).filter((dir) => before.get(dir)?.identity !== stateOf(dir).identity);
}

// Returns the folders that were there at the start, are the same folder, and have
// a new mtime. The cause may be a real run of the tool, so this is not a failure.
export function touchedDataDirs(before: DirSnapshot, home: string = REAL_HOME): readonly string[] {
  return realDataDirs(home).filter((dir) => {
    const was = before.get(dir);
    const now = stateOf(dir);
    return was !== undefined && was.identity !== "absent" && was.identity === now.identity && was.mtimeMs !== now.mtimeMs;
  });
}

const SUITE_START: DirSnapshot = snapshotRealDataDirs();

export function suiteStartSnapshot(): DirSnapshot {
  return SUITE_START;
}

// Call once at the top of a test file. The check runs after the last test.
export function installSuiteGuard(): void {
  after((context) => {
    if ("diagnostic" in context) {
      for (const dir of touchedDataDirs(SUITE_START)) {
        context.diagnostic(`${dir} has a new mtime; a real run of the tool may have written there`);
      }
    }
    assert.deepEqual(changedDataDirs(SUITE_START), [], "a real default data folder appeared or changed");
  });
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

export interface Sandbox {
  readonly root: string;
  readonly home: string;
  readonly xdg: string;
  readonly tmp: string;
  readonly dataDir: string;
  readonly env: Readonly<Record<string, string>>;
  // Join parts under the sandbox root. Fails the test on an escape.
  path(...parts: string[]): string;
}

export function makeSandbox(t: { after: (fn: () => void) => void }): Sandbox {
  mkdirSync(SANDBOX_BASE, { recursive: true });
  const base = realpathSync(SANDBOX_BASE);
  const root = realpathSync(mkdtempSync(join(base, "sb-")));
  assert.ok(isWithin(base, root) && root !== base, "sandbox is not inside the sandbox base");
  assertGuarded(root);

  const home = join(root, "home");
  const xdg = join(root, "xdg-state");
  const tmp = join(root, "tmp");
  const dataDir = join(root, "data");
  for (const dir of [home, xdg, tmp]) mkdirSync(dir, { mode: 0o700 });

  const env: Record<string, string> = {
    HOME: home,
    XDG_STATE_HOME: xdg,
    TOKENMETER_DATA_DIR: dataDir,
    TMPDIR: tmp,
  };
  const pathEnv = process.env["PATH"];
  if (pathEnv !== undefined) env["PATH"] = pathEnv;
  for (const value of Object.values(env)) {
    if (value !== pathEnv) assert.ok(isWithin(root, value), "an env path is outside the sandbox");
  }

  t.after(() => {
    // Delete only a folder that is inside the sandbox base.
    assert.ok(isWithin(base, root) && root !== base, "refusing to remove a path outside the sandbox base");
    rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    home,
    xdg,
    tmp,
    dataDir,
    env,
    path(...parts: string[]): string {
      const joined = join(root, ...parts);
      assert.ok(isWithin(root, canonical(joined)), "path leaves the sandbox");
      assertGuarded(joined);
      return joined;
    },
  };
}
