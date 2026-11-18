import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import { DEFAULT_APP_SERVER, readAppServerSetting, writeAppServerSetting } from "../src/config.ts";
import { defaultDeps } from "../src/fsafe.ts";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();
const deps = defaultDeps();

function setup(t: TestContext) {
  const box = makeSandbox(t);
  mkdirSync(box.dataDir, { mode: 0o700 });
  return { dir: box.dataDir, path: box.path("data", "config.json"), target: box.path("target") };
}

test("a missing config file gives the default setting", (t) => {
  const { dir } = setup(t);
  assert.equal(readAppServerSetting(dir, deps), DEFAULT_APP_SERVER);
});

test("the setter writes the schema at mode 0600 and can repair malformed private config", (t) => {
  const { dir, path } = setup(t);
  writeFileSync(path, "{", { mode: 0o600 });
  assert.equal(writeAppServerSetting(dir, "on", deps).ok, true);
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { version: 1, app_server: "on" });
  assert.equal(readAppServerSetting(dir, deps), "on");
});

for (const text of ["{", '{"version":2,"app_server":"on"}', '{"version":1,"app_server":true}',
  '{"version":1,"app_server":"on"}'.padEnd(4097)]) {
  test(`invalid config means off (${text.slice(0, 35)}, ${text.length} bytes)`, (t) => {
    const { dir, path } = setup(t);
    writeFileSync(path, text, { mode: 0o600 });
    assert.equal(readAppServerSetting(dir, deps), "off");
  });
}

for (const kind of ["symlink", "0644"]) {
  test(`config refuses to read or replace a ${kind} file`, { skip: process.platform === "win32" }, (t) => {
    const { dir, path, target } = setup(t);
    const text = '{"version":1,"app_server":"on"}';
    if (kind === "symlink") {
      writeFileSync(target, text, { mode: 0o600 });
      symlinkSync(target, path);
    } else {
      writeFileSync(path, text);
      chmodSync(path, 0o644);
    }
    assert.equal(readAppServerSetting(dir, deps), "off");
    assert.equal(writeAppServerSetting(dir, "off", deps).ok, false);
    assert.equal(readFileSync(path, "utf8"), text);
  });
}
