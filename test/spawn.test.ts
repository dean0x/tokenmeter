import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { delimiter, relative } from "node:path";
import { test, type TestContext } from "node:test";
import { setTimeout as wait } from "node:timers/promises";
import { asRow, err, ok } from "../src/core.ts";
import { checkCodexVersion, resolveCodex, runCodex } from "../src/spawn.ts";
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

test("relative and empty PATH entries and the working folder never supply codex or node", posix, async (t) => {
  const { box, folder, env, path, cwd } = fake(t, "env");
  for (const name of ["codex", "node"]) {
    writeFileSync(box.path("data", name), "#!/bin/sh\n: > marker\n", { mode: 0o700 });
  }
  const relativePath = relative(process.cwd(), cwd);
  const dirtyPath = [relativePath, "", folder, folder, ""].join(delimiter);
  assert.deepEqual(resolveCodex({ PATH: relativePath }), err("missing"));
  const resolved = resolveCodex({ ...env, PATH: dirtyPath });
  assert.ok(resolved.ok);
  assert.equal(resolved.value.path, path);
  const result = await runCodex(resolved.value, ["app-server"], { cwd, env: { ...env, PATH: dirtyPath, CODEX_HOME: "" } }, {
    onLine: (line) => ok(line),
    onExit: () => err("no_line"),
  });
  assert.ok(result.ok);
  assertChildEnv(result.value, { PATH: folder, HOME: box.home, TMPDIR: box.tmp }, cwd);
  assert.equal(existsSync(box.path("data", "marker")), false);
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
