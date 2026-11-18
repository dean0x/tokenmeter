// TP-10 and the static checks of step 8.
//
// The canary is a marker that sits in every text field of the fixtures. This file
// also puts it in corrupt lines and in over-long lines of both source kinds. It
// must appear in no stdout, no stderr and no data file after any command, record
// and statusline included. The one place where the canary of the input is on
// stdout is the pass-through of record: record copies its stdin, byte for byte.
//
// The static checks forbid network code, credential file names and debug output.
// Only the spawn module can use `child_process`. The command checks verify which commands start a process.
// The package has no `.jsonl` files outside the fixtures and names no tool that uses it.

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { ERROR_CODES, asRow, parseJson } from "../src/core.ts";
import { type CliIo, runCli } from "../src/cli.ts";
import { DEFAULT_BUDGET } from "../src/collect.ts";
import { type FsDeps, defaultDeps } from "../src/fsafe.ts";
import type { Zone } from "../src/periods.ts";
import { type Sandbox, assertGuarded, installSuiteGuard, makeSandbox } from "./helpers.ts";
import { probeStarts } from "./spawn-probe.ts";

installSuiteGuard();

const NOW = Date.parse("2026-11-03T12:00:00Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KIB = 1024;
const FIXTURES = join(import.meta.dirname, "fixtures");
const REPO = resolve(import.meta.dirname, "..");
const BIN = join(REPO, "bin", "tokenmeter.js");
const CANARY = "CANARY-7f3e";
// npm provenance needs the repository field to name the source repository.
const PUBLIC_REPOSITORY = { type: "git", url: "git+https://github.com/dean0x/tokenmeter.git" } as const;
const UTC: Zone = { offsetMs: () => 0 };
const DEPS: FsDeps = { ...defaultDeps(), nowMs: () => NOW };
// More than the line cap of 1 MiB.
const OVER_LONG_BYTES = 1536 * KIB;
const MAX_WALK_ENTRIES = 100_000;

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

// Every file under `root`, by name, without following links. The walk is bounded.
function filesUnder(root: string): readonly string[] {
  const found: string[] = [];
  const pending: string[] = [root];
  let visited = 0;
  while (pending.length > 0 && visited < MAX_WALK_ENTRIES) {
    const dir = pending.pop();
    if (dir === undefined) break;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      visited += 1;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
      } else if (entry.isFile()) {
        found.push(path);
      }
    }
  }
  return found.sort();
}

function plant(path: string, text: string, mtimeMs: number): void {
  assertGuarded(path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
}

// The fixtures have their times on this day. The in-process runs use the fixed
// clock NOW, which is on this day. A child process uses the real clock, so its
// fixtures are moved to a day shortly before the real now: a day far from the real
// now is outside the scan horizon, and the scan would skip it.
const FIXTURE_DATE = "2026-11-03";

function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// The day before the real now. Every fixture time (up to 09:12) is then in the past.
function realFixtureDate(): string {
  return utcDate(Date.now() - DAY_MS);
}

function fixtureText(name: string, date: string = FIXTURE_DATE): string {
  return readFileSync(join(FIXTURES, name), "utf8").replaceAll(`${FIXTURE_DATE}T`, `${date}T`);
}

// ---------------------------------------------------------------------------
// The sources: the fixtures, corrupt lines and over-long lines
// ---------------------------------------------------------------------------

interface World {
  readonly sb: Sandbox;
  readonly claude: string;
  readonly codex: string;
}

function makeWorld(t: TestContext): World {
  const sb = makeSandbox(t);
  return { sb, claude: sb.path("src-claude"), codex: sb.path("src-codex") };
}

// A model name or a folder name is a label that the output shows by design, when
// it has the shape of a name. So the canary goes into text that has no such shape.
const CANARY_TEXT = `${CANARY} some text`;

const CLAUDE_CORRUPT = [
  `{"type":"assistant","timestamp":"2026-11-03T10:00:00Z","message":{"id":"msg_c1","model":"${CANARY_TEXT}","usage":{"input_tokens":${CANARY}`,
  `["${CANARY}", 1, 2]`,
  `"${CANARY}"`,
  `{"type":"assistant","timestamp":"${CANARY}","requestId":"${CANARY}","cwd":"${CANARY_TEXT}","message":{"id":"${CANARY}","model":"${CANARY_TEXT}","usage":{"input_tokens":"${CANARY}","output_tokens":{"${CANARY}":1}}}}`,
  `\u0000\u0001 ${CANARY} \u001b[31m \u001b]52;c;${CANARY}\u0007`,
  "",
].join("\n");

const CODEX_CORRUPT = [
  `{"type":"session_meta","payload":{"id":"${CANARY}","cwd":5,"instructions":"${CANARY}"`,
  `{"type":"event_msg","payload":{"type":"token_count","info":"${CANARY}","rate_limits":{"limit_id":"${CANARY}","primary":{"used_percent":"${CANARY}","window_minutes":"${CANARY}","resets_at":"${CANARY}"}}}}`,
  `{"type":"turn_context","payload":{"model":"${CANARY_TEXT}","instructions":["${CANARY}"],"cwd":{"${CANARY}":1}}}`,
  `not json ${CANARY}`,
  "",
].join("\n");

// One line over the line cap, with the canary at the start, the middle and the end.
function overLongLine(type: string): string {
  const filler = "a".repeat(OVER_LONG_BYTES / 2);
  return `{"type":"${type}","note":"${CANARY}${filler}${CANARY}${filler}${CANARY}"}\n`;
}

// The Codex day folder and the fixture times are on `date`.
function plantSources(w: World, mtimeMs: number, date: string = FIXTURE_DATE): void {
  const day = join(w.codex, ...date.split("-"));
  plant(join(w.claude, "-work-proj", "sess-a.jsonl"), fixtureText("claude-basic.jsonl", date), mtimeMs);
  plant(join(w.claude, "-work-proj", "sess-corrupt.jsonl"), CLAUDE_CORRUPT, mtimeMs);
  plant(join(w.claude, "-work-proj", "sess-long.jsonl"), overLongLine("assistant"), mtimeMs);
  plant(join(day, "rollout-a-parent.jsonl"), fixtureText("codex-basic.jsonl", date), mtimeMs);
  plant(join(day, "rollout-b-child.jsonl"), fixtureText("codex-child.jsonl", date), mtimeMs);
  plant(join(day, "rollout-c-own.jsonl"), fixtureText("codex-child-own-meta.jsonl", date), mtimeMs);
  plant(join(day, "rollout-d-corrupt.jsonl"), CODEX_CORRUPT, mtimeMs);
  plant(join(day, "rollout-e-long.jsonl"), overLongLine("event_msg"), mtimeMs);
}

// ---------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------

interface Step {
  readonly name: string;
  readonly args: readonly string[];
  readonly stdin: string;
}

function syncBody(date: string): string {
  return JSON.stringify({
    windows: [
      { label: "T-DONE", start: `${date}T07:00:00Z`, end: `${date}T09:00:00Z`, match: { folders: ["/work/alpha"] }, tags: { type: "feature" } },
      { label: "T-OPEN", start: `${date}T07:30:00Z`, match: { folders: ["/work/beta"] }, tags: { type: "bug" } },
    ],
    open: [{ key: "I-1", tags: { type: "feature" } }],
  });
}
const ESTIMATE_BODY = JSON.stringify({ items: [{ key: "I-1", tags: { type: "feature" } }, { key: "I-2", tags: {} }] });

// The commands that print the JSON envelope. The task windows are on `date`.
function jsonSteps(w: World, date: string = FIXTURE_DATE): readonly Step[] {
  const roots = ["--claude-root", w.claude, "--codex-root", w.codex];
  return [
    { name: "collect", args: ["collect", ...roots], stdin: "" },
    { name: "status", args: ["status"], stdin: "" },
    { name: "usage", args: ["usage"], stdin: "" },
    { name: "tasks sync", args: ["tasks", "sync"], stdin: syncBody(date) },
    { name: "collect (tasks known)", args: ["collect", ...roots], stdin: "" },
    { name: "tasks", args: ["tasks"], stdin: "" },
    { name: "estimate", args: ["estimate"], stdin: ESTIMATE_BODY },
    { name: "doctor", args: ["doctor", ...roots], stdin: "" },
  ];
}

// A statusline JSON with the canary in every field that is not a rate limit.
function statuslineJson(withCanary: boolean): string {
  const mark = withCanary ? CANARY : "plain";
  const now = Date.now();
  return JSON.stringify({
    session_id: `sess-${mark}`,
    transcript_path: `/home/${mark}/t.jsonl`,
    cwd: `/work/${mark}`,
    model: { id: `m-${mark}`, display_name: `Model ${mark}` },
    workspace: { current_dir: `/w/${mark}`, project_dir: `/p/${mark}` },
    version: `1.${mark}`,
    cost: { total_cost_usd: 1.25, note: mark },
    rate_limits: {
      plan_label: mark,
      five_hour: { used_percentage: 12.5, resets_at: Math.round((now + 2 * HOUR_MS) / 1000), note: mark },
      seven_day: { used_percentage: 40, resets_at: Math.round((now + 3 * DAY_MS) / 1000), note: mark },
    },
  });
}

interface Output {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function runChild(args: readonly string[], env: Readonly<Record<string, string>>, input: string): Promise<Output> {
  return new Promise((resolveRun, reject) => {
    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    const child = spawn(BIN, [...args], { env, stdio: ["pipe", "pipe", "pipe"] });
    child.on("error", reject);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => errs.push(chunk));
    child.stdin.on("error", () => undefined);
    child.on("close", (code) =>
      resolveRun({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errs).toString("utf8") }),
    );
    child.stdin.end(input);
  });
}

async function runHere(w: World, step: Step): Promise<Output> {
  const out: string[] = [];
  const errs: string[] = [];
  const io: CliIo = {
    stdin: Readable.from(step.stdin === "" ? [] : [Buffer.from(step.stdin, "utf8")]),
    stdout: { write: (text) => out.push(text) },
    stderr: { write: (text) => errs.push(text) },
    env: w.sb.env,
    platform: "linux",
    homeDir: w.sb.home,
    deps: DEPS,
    zone: UTC,
    budget: DEFAULT_BUDGET,
  };
  const code = await runCli(step.args, io);
  return { code, stdout: out.join(""), stderr: errs.join("") };
}

// Without these counts, a clean output would prove nothing: the sources, the
// corrupt lines and the over-long lines must have been read.
function assertBadLinesWereRead(collectStdout: string): void {
  const counters = (JSON.parse(collectStdout) as { data: { counters: Record<string, number> } }).data.counters;
  assert.ok((counters["counted"] ?? 0) > 0, "rows were counted");
  assert.ok((counters["bad_json"] ?? 0) > 0, "corrupt lines were read");
  assert.ok((counters["not_object"] ?? 0) > 0, "lines that are not objects were read");
  assert.ok((counters["skipped_long"] ?? 0) > 0, "over-long lines were read");
}

// The canary is in no data file of the folder.
function assertNoCanaryStored(step: string, dataDir: string): void {
  for (const file of filesUnder(dataDir)) {
    assert.equal(readFileSync(file).includes(CANARY), false, `${step}: ${relative(dataDir, file)} holds the canary`);
  }
}

// ---------------------------------------------------------------------------
// TP-10
// ---------------------------------------------------------------------------

test("TP-10: the fixtures carry the canary in their text fields", () => {
  for (const name of ["claude-basic.jsonl", "codex-basic.jsonl", "codex-child.jsonl", "codex-child-own-meta.jsonl"]) {
    const lines = fixtureText(name).split("\n").filter((line) => line !== "");
    assert.ok(lines.some((line) => line.includes(CANARY)), name);
  }
});

test("TP-10: the JSON commands print and store no canary, and the bad lines were really read and counted", async (t) => {
  const w = makeWorld(t);
  plantSources(w, NOW - HOUR_MS);
  const dataDir = w.sb.dataDir;
  for (const step of jsonSteps(w)) {
    const run = await runHere(w, step);
    assert.equal(run.code, 0, `${step.name}: ${run.stdout.slice(0, 200)}`);
    assert.equal(run.stdout.includes(CANARY), false, `${step.name}: stdout`);
    assert.equal(run.stdout.split("\n").length, 2, `${step.name}: one line of JSON`);
    assert.equal(run.stderr, "", `${step.name}: stderr`);
    assertNoCanaryStored(step.name, dataDir);
    if (step.name === "collect") assertBadLinesWereRead(run.stdout);
  }
  assert.ok(filesUnder(dataDir).length >= 3, "the data folder holds files");
});

test("TP-10: in child processes, no command prints a canary to stdout or stderr or stores one, record and statusline included", async (t) => {
  const w = makeWorld(t);
  // The children use the real clock, so the sources are planted shortly before the real now.
  const date = realFixtureDate();
  plantSources(w, Date.now() - HOUR_MS, date);
  const dataDir = w.sb.dataDir;
  const env = w.sb.env;

  for (const step of jsonSteps(w, date)) {
    const run = await runChild(step.args, env, step.stdin);
    assert.equal(run.code, 0, `${step.name}: ${run.stdout.slice(0, 200)}`);
    assert.equal(run.stdout.includes(CANARY), false, `${step.name}: stdout`);
    assert.equal(run.stderr, "", `${step.name}: stderr`);
    assertNoCanaryStored(step.name, dataDir);
    if (step.name === "collect") assertBadLinesWereRead(run.stdout);
  }

  // record: with a clean input, its output is that input and nothing else.
  const clean = statuslineJson(false);
  const plain = await runChild(["record"], env, clean);
  assert.equal(plain.code, 0);
  assert.equal(plain.stdout, clean);
  assert.equal(plain.stderr, "");
  assertNoCanaryStored("record (clean input)", dataDir);

  // record: the canary of the input is on stdout only as the copy of the input.
  const marked = statuslineJson(true);
  const copy = await runChild(["record"], env, marked);
  assert.equal(copy.code, 0);
  assert.equal(copy.stdout, marked);
  assert.equal(copy.stderr, "");
  assertNoCanaryStored("record (canary input)", dataDir);

  // statusline: the line holds numbers and fixed words only.
  const line = await runChild(["statusline"], env, marked);
  assert.equal(line.code, 0);
  assert.match(line.stdout, /^Claude wk 40% /);
  assert.equal(line.stdout.includes(CANARY), false, "statusline: stdout");
  assert.equal(line.stderr, "");
  assertNoCanaryStored("statusline", dataDir);

  // The commands after record and statusline.
  for (const name of ["status", "usage", "doctor"]) {
    const args = name === "doctor" ? [name, "--claude-root", w.claude, "--codex-root", w.codex] : [name];
    const run = await runChild(args, env, "");
    assert.equal(run.code, 0, name);
    assert.equal(run.stdout.includes(CANARY), false, `${name}: stdout`);
    assert.equal(run.stderr, "", `${name}: stderr`);
  }
  assert.deepEqual(filesUnder(w.sb.home), [], "nothing is written under the sandbox home");
});

// Two windows whose paths give one key, with the canary in both paths and so in the key.
function collisionBody(date: string): string {
  return JSON.stringify({
    windows: [
      { label: "T-1", start: `${date}T07:00:00Z`, end: `${date}T09:00:00Z`, match: { folders: [`/work/${CANARY}/a-b`] }, tags: {} },
      { label: "T-2", start: `${date}T07:30:00Z`, match: { folders: [`/work/${CANARY}/a/b`] }, tags: {} },
    ],
    open: [],
  });
}

// The warning line names the windows only: no path, no folder key, no canary.
// The data folder is not checked here: it stores the folder key by design, and
// this key holds the canary.
function assertCleanWarning(where: string, run: Output): void {
  assert.equal(run.code, 0, `${where}: ${run.stdout.slice(0, 200)}`);
  assert.match(run.stderr, /^tokenmeter: warning: 1 folder key comes from .*\(windows T-1, T-2\)/, `${where}: the warning`);
  for (const [name, text] of [["stdout", run.stdout], ["stderr", run.stderr]] as const) {
    assert.equal(text.includes(CANARY), false, `${where}: ${name} holds the canary`);
    assert.equal(text.includes("/work"), false, `${where}: ${name} holds a path`);
    assert.equal(text.includes("-work-"), false, `${where}: ${name} holds a folder key`);
  }
}

test("TP-10: the folder collision warning of tasks sync holds no path, no folder key and no canary", async (t) => {
  const w = makeWorld(t);
  const here = await runHere(w, { name: "tasks sync (collision)", args: ["tasks", "sync"], stdin: collisionBody(FIXTURE_DATE) });
  assertCleanWarning("in process", here);
  const child = await runChild(["tasks", "sync"], w.sb.env, collisionBody(realFixtureDate()));
  assertCleanWarning("child process", child);
});

// ---------------------------------------------------------------------------
// Static checks of the package (step 8)
// ---------------------------------------------------------------------------

const MAX_FILE_BYTES = 4 * 1024 * 1024;

function commandOutput(command: string, args: readonly string[], cwd: string, env?: NodeJS.ProcessEnv): string {
  const run = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 15_000, maxBuffer: MAX_FILE_BYTES });
  // A full buffer can leave status 0 and set run.error.
  const cause = `status ${run.status}, signal ${run.signal}, error ${run.error?.name ?? "none"}`;
  assert.ok(run.error === undefined && run.status === 0, `${command} ${args[0]} failed: ${cause}`);
  return run.stdout;
}

function gitFiles(root: string, args: readonly string[], env?: NodeJS.ProcessEnv): readonly string[] {
  return commandOutput("git", ["ls-files", "-z", ...args], root, env).split("\0").filter(Boolean);
}

function sourceFiles(): readonly string[] {
  return [...filesUnder(join(REPO, "src")), ...filesUnder(join(REPO, "bin"))];
}

function readAll(files: readonly string[]): readonly (readonly [string, string])[] {
  return files.map((file): [string, string] => [relative(REPO, file), readFileSync(file, "utf8")]);
}

test("static: no .jsonl file in the repo outside test/fixtures", () => {
  const all = gitFiles(REPO, ["--cached", "--others", "--exclude-standard"]).filter((name) => name.endsWith(".jsonl"));
  assert.ok(all.length >= 4, "the fixtures are found");
  for (const name of all) assert.ok(name.startsWith("test/fixtures/"), `${name} is outside test/fixtures`);
});

// Check the disk too: local Git excludes can hide logs in source folders.
test("static: no .jsonl file on disk in src or bin", () => {
  const files = sourceFiles();
  assert.ok(files.length >= 14, "the shipped files are found");
  assert.deepEqual(files.filter((file) => file.endsWith(".jsonl")).map((file) => relative(REPO, file)), []);
});

test("static: only spawn.ts can use child_process, and no source names network code or credential files", () => {
  const banned = [
    "node:http", "node:https", "node:net", "node:dns", "node:tls", "node:dgram", "WebSocket",
    "auth.json", "credentials.json", ".netrc",
  ];
  const files = readAll(sourceFiles());
  assert.ok(files.length >= 14, "the source files are found");
  for (const [name, text] of files) {
    for (const word of banned) assert.equal(text.includes(word), false, `${name} holds ${word}`);
    assert.equal(/fetch\s*\(/.test(text), false, `${name} uses fetch`);
    if (name !== join("src", "spawn.ts")) assert.equal(text.includes("child_process"), false, `${name} holds child_process`);
  }
});

test("record and statusline start no process", (t) => {
  const box = makeSandbox(t);
  const env = { ...box.env, PATH: box.path("bin") };
  const input = statuslineJson(false);
  for (const command of ["record", "statusline"] as const) {
    assert.deepEqual(probeStarts(box, command, env, input).starts, [], command);
  }
});

test("hud can start one detached refresh from an existing data folder", (t) => {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  const env = { ...box.env, PATH: box.path("bin") };
  const bin = realpathSync.native(BIN);
  assert.deepEqual(probeStarts(box, "hud", env).starts, [
    ["spawn", process.execPath, [bin, "refresh"], box.dataDir, true, "ignore"],
  ]);
});

test("static: every import is a file of the package or a node: module", () => {
  for (const [name, text] of readAll(sourceFiles())) {
    for (const match of text.matchAll(/(?:from\s+|import\()\s*"([^"]+)"/g)) {
      const specifier = match[1] ?? "";
      assert.ok(specifier.startsWith("./") || specifier.startsWith("../") || specifier.startsWith("node:"), `${name} imports ${specifier}`);
    }
  }
});

test("static: no console output in src or bin", () => {
  for (const [name, text] of readAll(sourceFiles())) assert.equal(text.includes("console."), false, `${name} holds console.`);
});

test("static: public code, tests and docs do not name consumer tools", () => {
  // Check substrings without putting the names in the public test itself.
  const fingerprints = new Set([
    "5898b9896e0d8147631dc1e22b7ed6a0c6cd1440fc4400fc1b08fbaafb1930ab",
    "06c8aaa93d80a768829b6005973fa92e34612849b79910c8be8e3b006cf91c61",
    "859169b38185780daa5497983ff20d2994390058d8a71f2847ac7846f970971e",
  ]);
  const checked = new Set<string>();
  const files = gitFiles(REPO, ["--cached"]).filter((path) => /^(?:src|test|bin)\//.test(path) || path.endsWith(".md"));
  for (const [name, text] of readAll(files.map((path) => join(REPO, path)))) {
    for (const size of [5, 7]) {
      const substrings = new RegExp(`(?=([a-z]{${size}}))`, "g");
      for (const match of text.toLowerCase().matchAll(substrings)) {
        const part = match[1];
        if (part === undefined || checked.has(part)) continue;
        assert.ok(!fingerprints.has(createHash("sha256").update(part).digest("hex")), `${name} names a consumer`);
        checked.add(part);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Publish readiness
// ---------------------------------------------------------------------------

const HOME_PATH = /\/(?:Users|home)\/[\p{L}\p{N}_.-]/u;
const TEMP_PATH = /\/(?:tmp|var\/(?:tmp|folders))\/[^\s/'"`\\]/;

function assertNoPrivatePaths(name: string, text: string): void {
  assert.equal(HOME_PATH.test(text), false, `${name} holds a home path`);
  assert.equal(TEMP_PATH.test(text), false, `${name} holds a temp path`);
}

function assertTrackedText(root: string, env?: NodeJS.ProcessEnv): void {
  const files = gitFiles(root, ["--cached"], env);
  assert.ok(files.length > 0, "tracked files are found");
  for (const name of files) {
    const path = join(root, name);
    const stat = lstatSync(path);
    assert.ok(stat.isFile() || stat.isSymbolicLink(), `${name} is not a file or link`);
    assert.ok(stat.size <= MAX_FILE_BYTES, `${name} exceeds the scan limit`);
    const text = stat.isSymbolicLink() ? readlinkSync(path, "utf8") : readFileSync(path, "utf8");
    assertNoPrivatePaths(name, text);
  }
}

test("publish: no home or temp paths in any tracked file", () => {
  assertTrackedText(REPO);
});

function packReport(root: string, sb: Sandbox, mode: readonly string[]): { filename: string; files: readonly string[] } {
  const env = { ...sb.env, npm_config_cache: sb.path("npm-cache"), npm_config_offline: "true" };
  const text = commandOutput("npm", ["pack", ...mode, "--json", "--ignore-scripts"], root, env);
  const parsed = parseJson(text);
  assert.ok(parsed.ok && Array.isArray(parsed.value) && parsed.value.length === 1, "expected one npm pack report");
  const report = asRow(parsed.value[0]);
  assert.ok(report !== null && Array.isArray(report.files), "npm pack must report its files");
  const filename = report.filename;
  assert.ok(typeof filename === "string" && /^[\w.-]+\.tgz$/.test(filename), "invalid tarball filename");
  const files = report.files.map((entry: unknown) => {
    const path = asRow(entry)?.path;
    assert.ok(typeof path === "string" && path.length > 0, "npm pack must report each file path");
    return path;
  });
  return { filename, files };
}

function assertPackFiles(files: readonly string[], expected: readonly string[]): void {
  assert.deepEqual([...files].sort(), [...expected].sort(), "pack file list differs from the expected list");
}

function packArchive(root: string, sb: Sandbox, expected: readonly string[]): (name: string) => string {
  const packed = packReport(root, sb, ["--pack-destination", sb.tmp]);
  assertPackFiles(packed.files, expected);
  const archive = sb.path("tmp", packed.filename);
  // Read each member to stdout. Do not extract paths from the archive to disk.
  return (name) => commandOutput("tar", ["-xOzf", archive, "--", `package/${name}`], sb.root, sb.env);
}

function assertPackedText(files: readonly string[], read: (name: string) => string): void {
  for (const name of files) assertNoPrivatePaths(name, read(name));
}

function assertPackedManifest(text: string): void {
  const parsed = parseJson(text);
  assert.ok(parsed.ok, "packed package.json is not JSON");
  const manifest = asRow(parsed.value);
  assert.ok(manifest !== null, "packed package.json is not an object");
  assert.deepEqual(manifest.repository, PUBLIC_REPOSITORY, "packed repository field");
  if (Object.hasOwn(manifest, "scripts")) {
    const scripts = asRow(manifest.scripts);
    assert.ok(scripts !== null, "packed scripts field is not an object");
    for (const name of ["preinstall", "install", "postinstall"]) {
      assert.equal(Object.hasOwn(scripts, name), false, `packed install script: ${name}`);
    }
  }
  for (const name of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (!Object.hasOwn(manifest, name)) continue;
    const deps = asRow(manifest[name]);
    assert.ok(deps !== null && Object.keys(deps).length === 0, `packed runtime dependencies: ${name}`);
  }
  for (const name of ["bundleDependencies", "bundledDependencies"]) {
    if (!Object.hasOwn(manifest, name)) continue;
    const deps = manifest[name];
    assert.ok(deps === false || (Array.isArray(deps) && deps.length === 0), `packed runtime dependencies: ${name}`);
  }
}

function assertRegistryUrls(text: string): void {
  let resolved = 0;
  JSON.parse(text, (key: string, value: unknown) => {
    if (key === "resolved") {
      resolved += 1;
      assert.ok(typeof value === "string" && value.startsWith("https://registry.npmjs.org/") && URL.canParse(value),
        "lockfile resolved URL must use the public npm registry over HTTPS");
    }
    return value;
  });
  assert.ok(resolved > 0, "lockfile resolved URLs are found");
}

test("publish: the file list, archive contents and manifest meet the package contract", (t) => {
  const sb = makeSandbox(t);
  // A clean build emits one .js file for each tracked TypeScript source.
  const dist = gitFiles(REPO, ["--cached", "--", "src"]).filter((name) => name.endsWith(".ts"))
    .map((name) => `dist/${name.slice("src/".length, -".ts".length)}.js`);
  assert.ok(dist.length > 0, "compiled modules are expected");
  const expected = ["bin/tokenmeter.js", ...dist, "README.md", "LICENSE", "package.json"];
  assertPackFiles(packReport(REPO, sb, ["--dry-run"]).files, expected);
  const read = packArchive(REPO, sb, expected);
  assertPackedText(expected, read);
  assertPackedManifest(read("package.json"));
});

test("publish: every lockfile resolved URL uses the public npm registry", () => {
  assertRegistryUrls(readFileSync(join(REPO, "package-lock.json"), "utf8"));
});

test("publish probes: both the tracked scan and the archive scan reject paths", (t) => {
  const sb = makeSandbox(t);
  const root = sb.path("probe");
  const home = sb.path("probe", "home.txt");
  const temp = sb.path("probe", "temp.txt");
  plant(home, ["", "Users", "example-account", "project"].join("/"), NOW);
  plant(temp, ["", "private", "var", "folders", "example", "file"].join("/"), NOW);
  plant(sb.path("probe", "package.json"), JSON.stringify({ name: "publish-probe", version: "1.0.0", files: ["*.txt"] }), NOW);
  commandOutput("git", ["init", "--quiet"], root, sb.env);
  commandOutput("git", ["add", "--", "home.txt"], root, sb.env);
  assert.throws(() => assertTrackedText(root, sb.env), /home\.txt holds a home path/);
  commandOutput("git", ["rm", "--cached", "--", "home.txt"], root, sb.env);
  commandOutput("git", ["add", "--", "temp.txt"], root, sb.env);
  assert.throws(() => assertTrackedText(root, sb.env), /temp\.txt holds a temp path/);

  const read = packArchive(root, sb, ["home.txt", "temp.txt", "package.json"]);
  assert.throws(() => assertPackedText(["home.txt"], read), /home\.txt holds a home path/);
  assert.throws(() => assertPackedText(["temp.txt"], read), /temp\.txt holds a temp path/);
});

test("publish probes: unexpected files, manifest fields and registry URLs fail the checks", (t) => {
  const sb = makeSandbox(t);
  const root = sb.path("probe");
  const manifest = sb.path("probe", "package.json");
  const lockfile = sb.path("probe", "package-lock.json");
  const base = { name: "publish-probe", version: "1.0.0", repository: PUBLIC_REPOSITORY };
  plant(manifest, JSON.stringify(base), NOW);
  plant(sb.path("probe", "extra.txt"), "not in the expected list", NOW);
  const dryRun = packReport(root, sb, ["--dry-run"]);
  assert.throws(() => assertPackFiles(dryRun.files, ["package.json"]), /pack file list differs/);

  for (const [field, value, message] of [
    ["scripts", { preinstall: "echo probe" }, /packed install script/],
    ["dependencies", { probe: "1.0.0" }, /packed runtime dependencies/],
    ["repository", "https://example.invalid/probe", /packed repository field/],
  ] as const) {
    plant(manifest, JSON.stringify({ ...base, [field]: value }), NOW);
    const read = packArchive(root, sb, ["extra.txt", "package.json"]);
    assert.throws(() => assertPackedManifest(read("package.json")), message);
  }

  for (const resolved of ["https://registry.npmjs.org.example.invalid/probe.tgz", "http://registry.npmjs.org/probe.tgz"]) {
    plant(lockfile, JSON.stringify({ packages: { "node_modules/probe": { resolved } } }), NOW);
    assert.throws(() => assertRegistryUrls(readFileSync(lockfile, "utf8")), /lockfile resolved URL/);
  }
});

// ---------------------------------------------------------------------------
// The README
// ---------------------------------------------------------------------------

test("README: it names every command, every error code and the limits of what it counts", () => {
  const text = readFileSync(join(REPO, "README.md"), "utf8");
  for (const command of ["collect", "status", "usage", "tasks sync", "tasks", "estimate", "doctor", "record", "statusline", "hud", "config", "config app_server off"]) {
    assert.ok(text.includes(`tokenmeter ${command}`), `the command ${command}`);
  }
  for (const code of ERROR_CODES) assert.ok(text.includes(code), `the error code ${code}`);
  for (const phrase of [
    "Node 22.0", "no credentials", "five_hour", "seven_day", "Opus", "Sonnet", "Claude Desktop", "TOKENMETER_DATA_DIR",
    "codex app-server", "on by default", "npm run build",
  ]) {
    assert.ok(text.includes(phrase), phrase);
  }
  // The second use names no program: the status line command is a placeholder.
  assert.ok(text.includes("{ tokenmeter record 2>/dev/null || cat; } | { <your status line command>; }"));
  assert.ok(text.includes("tokenmeter collect"), "the schedule line");
});
