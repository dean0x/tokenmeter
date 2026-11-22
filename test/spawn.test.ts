import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { setImmediate as afterIo, setTimeout as wait } from "node:timers/promises";
import { asRow, err, ok } from "../src/core.ts";
import { checkCodexVersion, resolveCodex, runCodex, startRefresh } from "../src/spawn.ts";
import { writeFakeCodex, type FakeMode } from "./fixtures/fake-codex.mjs";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();
const posix = { skip: process.platform === "win32" };

function fake(t: TestContext, mode?: FakeMode) {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  const folder = box.path("fake codex ' bin");
  const path = writeFakeCodex(folder, mode);
  const env = { ...box.env, PATH: folder };
  const resolved = resolveCodex(env);
  assert.ok(resolved.ok);
  assert.equal(resolved.value.path, path);
  return { box, folder, env, path, codex: resolved.value, cwd: box.dataDir };
}

function assertChildEnv(text: string, expected: Readonly<Record<string, string>>, cwd: string): void {
  const child = asRow(JSON.parse(text));
  assert.ok(child);
  const actual = asRow(child["env"]);
  assert.ok(actual);
  // The fixture shell and macOS can add these after the spawn.
  const { PWD, SHLVL, __CF_USER_TEXT_ENCODING, ...env } = actual;
  if (PWD !== undefined) assert.equal(PWD, cwd);
  if (SHLVL !== undefined) assert.match(String(SHLVL), /^\d+$/);
  if (__CF_USER_TEXT_ENCODING !== undefined) {
    assert.match(String(__CF_USER_TEXT_ENCODING), /^0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+:0x[0-9A-Fa-f]+$/);
  }
  assert.deepEqual({ env, cwd: child["cwd"] }, { env: expected, cwd });
}

test("Codex is off on Windows even if PATH is set", () => {
  assert.deepEqual(resolveCodex({ PATH: process.cwd() }, "win32"), err("missing"));
});

test("the Codex child PATH contains only eligible absolute folders", posix, async (t) => {
  const { box, folder, env, path, cwd } = fake(t, "env");
  for (const name of ["codex", "node"]) {
    writeFileSync(box.path("data", name), "#!/bin/sh\n: > marker\n", { mode: 0o700 });
  }
  const shared = box.path("shared");
  const other = box.path("other-owner");
  mkdirSync(shared);
  chmodSync(shared, 0o770);
  mkdirSync(other, { mode: 0o700 });
  const uid = statSync(folder).uid + 1;
  const stat = (name: string) => Object.assign(statSync(name), { uid: name === other ? uid + 1 : uid });
  const relativePath = relative(process.cwd(), cwd);
  const dirtyPath = [relativePath, "", shared, other, folder, folder, ""].join(delimiter);
  assert.deepEqual(resolveCodex({ PATH: relativePath }), err("missing"));
  const resolved = resolveCodex({ ...env, PATH: dirtyPath }, process.platform, { uid, stat });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.path, path);
  const result = await runCodex(resolved.value, ["app-server"], { cwd, env: { ...env, PATH: dirtyPath, CODEX_HOME: "" } }, {
    onLine: (line) => ok(line),
    onExit: () => err("no_line"),
  });
  assert.ok(result.ok);
  assertChildEnv(result.value, { PATH: folder, HOME: box.home, TMPDIR: box.tmp }, cwd);
  assert.equal(resolved.value.searchPath, folder);
  assert.equal(existsSync(box.path("data", "marker")), false);
});

test("Codex lookup accepts root owners and refuses a different user as the file owner", posix, (t) => {
  const { env, path, folder } = fake(t);
  const uid = statSync(path).uid + 1;
  const stat = (name: string) => Object.assign(statSync(name), { uid: name === folder ? 0 : uid + 1 });
  assert.ok(resolveCodex(env, process.platform, { uid, stat: (name) => Object.assign(statSync(name), { uid: 0 }) }).ok);
  assert.deepEqual(resolveCodex(env, process.platform, { uid, stat }), err("missing"));
});

test("the refresh does not start from a shared-write bin folder when the data folder is absent", posix, (t) => {
  const box = makeSandbox(t);
  const folder = box.path("bin");
  const bin = box.path("bin", "refresh.js");
  mkdirSync(folder);
  chmodSync(folder, 0o770);
  writeFileSync(bin, "// Fixture only.\n");
  assert.deepEqual(startRefresh(bin, box.dataDir, box.env, false), err("error"));
});

test("an executable and a symlink target in a group-writable folder are refused", posix, (t) => {
  const { box, folder, env, codex } = fake(t);
  const links = box.path("links");
  mkdirSync(links, { mode: 0o700 });
  symlinkSync(codex.path, box.path("links", "codex"));
  const linked = resolveCodex({ PATH: links });
  assert.ok(linked.ok);
  assert.equal(linked.value.path, codex.path);
  assert.equal(linked.value.binKey, codex.binKey);
  chmodSync(folder, 0o770);
  assert.deepEqual(resolveCodex(env), err("missing"));
  assert.deepEqual(resolveCodex({ PATH: links }), err("missing"));
});

test("candidates must be regular executable files", posix, (t) => {
  const { box, env, path } = fake(t);
  for (const mode of [0o600, 0o770, 0o707]) {
    chmodSync(path, mode);
    assert.deepEqual(resolveCodex(env), err("missing"));
  }
  mkdirSync(box.path("directory"), { mode: 0o700 });
  mkdirSync(box.path("directory", "codex"), { mode: 0o700 });
  assert.deepEqual(resolveCodex({ PATH: box.path("directory") }), err("missing"));
});

test("the child has only the allowed environment and uses the data folder", posix, async (t) => {
  const { box, codex, env, cwd } = fake(t, "env");
  const allowed = {
    HOME: box.home, CODEX_HOME: box.home, TMPDIR: box.tmp, LANG: "C", LC_ALL: "C",
    HTTP_PROXY: "http://proxy.invalid", HTTPS_PROXY: "http://proxy.invalid", NO_PROXY: "localhost",
    ALL_PROXY: "http://proxy.invalid", http_proxy: "http://proxy.invalid", https_proxy: "http://proxy.invalid",
    no_proxy: "localhost", all_proxy: "http://proxy.invalid", SSL_CERT_FILE: box.path("ca"), SSL_CERT_DIR: box.root,
    PATH: env.PATH,
  };
  const child = await runCodex(codex, ["app-server"], {
    cwd,
    env: {
      ...allowed, CANARY_SECRET: "canary", NODE_OPTIONS: "not-a-node-option",
      OPENAI_API_KEY: "canary", CODEX_API_KEY: "canary", RUST_LOG: "trace",
    },
  }, { onLine: (line) => ok(line), onExit: () => err("no_line") });
  assert.ok(child.ok);
  assertChildEnv(child.value, allowed, cwd);
});

test("the app-server exits cleanly on stdin EOF, as in Codex 0.165.0", posix, async (t) => {
  const { codex, cwd, env } = fake(t);
  const lines: string[] = [];
  const result = await runCodex(codex, ["app-server"], { cwd, env }, {
    onLine: (line) => { lines.push(line); },
    onExit: () => ok(lines),
  });
  assert.deepEqual(result, ok(["eof"]));
});

test("the session can send another request and read split UTF-8 lines", posix, async (t) => {
  const { codex, cwd, env } = fake(t, "split");
  const lines: string[] = [];
  const result = await runCodex(codex, ["app-server"], { cwd, env }, {
    initialInput: "initialize\n",
    onLine: (line, send) => {
      lines.push(line);
      if (lines.length === 2) return ok(lines);
      return send("follow-up\n") ? undefined : err("write_failed");
    },
    onExit: () => err("ended_early"),
  });
  assert.deepEqual(result, ok(["aé", "b"]));
});

for (const [mode, error] of [["hang", "timeout"], ["wide", "output_limit"]] as const) {
  test(`the ${error} path stops descendants that ignore SIGTERM`, posix, async (t) => {
    const { box, codex, cwd, env } = fake(t, mode);
    const result = await runCodex(codex, ["app-server"], { cwd, env, timeoutMs: 2_000 }, {
      initialInput: "initialize\n", onLine: () => undefined, onExit: () => ok(undefined),
    });
    assert.deepEqual(result, err(error));
    assert.equal(existsSync(box.path("data", "term")), true);
    await wait(350);
    assert.equal(existsSync(box.path("data", "survivor")), false);
  });
}

test("stdout has a 256 KiB total cap even when each line fits", posix, async (t) => {
  const { codex, cwd, env } = fake(t, "many");
  const result = await runCodex(codex, ["app-server"], { cwd, env }, {
    onLine: () => undefined, onExit: () => ok(undefined),
  });
  assert.deepEqual(result, err("output_limit"));
});

test("an abort stops an active session", posix, async (t) => {
  const { box, codex, cwd, env } = fake(t, "hang");
  const controller = new AbortController();
  const result = await runCodex(codex, ["app-server"], { cwd, env, signal: controller.signal }, {
    onLine: () => { controller.abort(); }, onExit: () => ok(undefined),
  });
  assert.deepEqual(result, err("aborted"));
  assert.equal(existsSync(box.path("data", "term")), true);
});

for (const [mode, arg, reason] of [
  ["hang", "app-server", "timeout"],
  ["wide", "app-server", "output_limit"],
  ["fail", "--version", "error"],
] as const) {
  test(`the stop hook can replace ${reason} with a result`, posix, async (t) => {
    const { codex, cwd, env } = fake(t, mode);
    const result = await runCodex(codex, [arg], { cwd, env, timeoutMs: 1_000 }, {
      onLine: () => undefined, onExit: () => err("early_exit"), onStop: (stop) => ok(stop),
    });
    assert.deepEqual(result, ok(reason));
  });
}

test("the stop hook replaces abort once, even when the data handler fails after the abort", posix, async (t) => {
  const { codex, cwd, env } = fake(t, "hang");
  const controller = new AbortController();
  const reasons: string[] = [];
  const result = await runCodex(codex, ["app-server"], { cwd, env, signal: controller.signal }, {
    onLine: () => { controller.abort(); throw new Error("test callback failure"); },
    onExit: () => err("early_exit"),
    onStop: (reason) => { reasons.push(reason); return err("held_result"); },
  });
  assert.deepEqual({ result, reasons }, { result: err("held_result"), reasons: ["aborted"] });
});

test("a child error after the abort does not call the stop hook again", posix, async (t) => {
  const { box, codex, cwd, env } = fake(t);
  const controller = new AbortController();
  const reasons: string[] = [];
  const stopped = runCodex({ ...codex, path: box.path("missing-codex") }, ["app-server"], { cwd, env, signal: controller.signal }, {
    onLine: () => undefined, onExit: () => err("early_exit"),
    onStop: (reason) => { reasons.push(reason); return ok(reason); },
  });
  controller.abort();
  const result = await stopped;
  await afterIo();
  assert.deepEqual({ result, reasons }, { result: ok("aborted"), reasons: ["aborted"] });
});

test("a stop hook that aborts the signal does not run again", posix, async (t) => {
  const { codex, cwd, env } = fake(t, "wide");
  const controller = new AbortController();
  const reasons: string[] = [];
  const result = await runCodex(codex, ["app-server"], { cwd, env, signal: controller.signal }, {
    onLine: () => undefined,
    onExit: () => err("early_exit"),
    onStop: (reason) => { reasons.push(reason); controller.abort(); return ok(reason); },
  });
  assert.deepEqual({ result, reasons }, { result: ok("output_limit"), reasons: ["output_limit"] });
});

for (const outcome of ["undefined", "throw"] as const) {
  test(`the plain stop reason survives when the stop hook gives ${outcome}`, posix, async (t) => {
    const { codex, cwd, env } = fake(t, "eof");
    const reasons: string[] = [];
    const result = await runCodex(codex, ["app-server"], { cwd, env }, {
      onLine: () => { throw new Error("test callback failure"); },
      onExit: () => err("early_exit"),
      onStop: (reason) => {
        reasons.push(reason);
        if (outcome === "throw") throw new Error("test hook failure");
        return undefined;
      },
    });
    assert.deepEqual({ result, reasons }, { result: err("error"), reasons: ["error"] });
  });
}

test("a pre-aborted session does not call the stop hook", posix, async (t) => {
  const { codex, cwd, env } = fake(t, "eof");
  const result = await runCodex(codex, ["app-server"], { cwd, env, signal: AbortSignal.abort() }, {
    onLine: () => undefined, onExit: () => err("early_exit"), onStop: () => ok("unexpected"),
  });
  assert.deepEqual(result, err("aborted"));
});

test("version support is cached by binary identity and a changed mtime ends the cache hit", posix, async (t) => {
  const { box, codex, path, cwd, env } = fake(t);
  const calls = box.path("data", "version-calls");
  assert.equal(existsSync(calls), false, "resolution alone starts no process");
  assert.match(codex.binKey, /^[0-9a-f]{64}$/);
  assert.deepEqual(await checkCodexVersion(codex, { cwd, env }), ok(undefined));
  assert.deepEqual(await checkCodexVersion(codex, { cwd, env }), ok(undefined));
  assert.equal(readFileSync(calls, "utf8"), "1\n");
  utimesSync(path, 1_700_000_000, 1_700_000_000);
  const changed = resolveCodex(env);
  assert.ok(changed.ok);
  assert.equal(changed.value.path, path);
  assert.notEqual(changed.value.binKey, codex.binKey);
  assert.deepEqual(await checkCodexVersion(changed.value, { cwd, env }), ok(undefined));
  assert.equal(readFileSync(calls, "utf8"), "1\n1\n");
});

for (const kind of ["link", "shared"] as const) {
  test(`a ${kind} version cache cannot approve an old binary`, posix, async (t) => {
    const { box, codex, cwd, env } = fake(t, "old");
    const cache = box.path("data", "codex-version.json");
    const digest = JSON.stringify(codex.binKey);
    if (kind === "link") {
      const target = box.path("digest");
      writeFileSync(target, digest, { mode: 0o600 });
      symlinkSync(target, cache);
    } else {
      writeFileSync(cache, digest);
      chmodSync(cache, 0o644);
    }
    assert.deepEqual(await checkCodexVersion(codex, { cwd, env }), err("old"));
  });
}

for (const [mode, error] of [["old", "old"], ["bad", "shape"], ["large", "output_limit"], ["fail", "error"]] as const) {
  test(`version probe returns ${error} for ${mode} output`, posix, async (t) => {
    const { codex, cwd, env } = fake(t, mode);
    assert.deepEqual(await checkCodexVersion(codex, { cwd, env }), err(error));
  });
}
