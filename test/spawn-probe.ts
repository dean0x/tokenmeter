import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Sandbox } from "./helpers.ts";

const BIN = join(import.meta.dirname, "..", "bin", "tokenmeter.js");

// Observe process starts at the Node boundary. Do not launch the requested child.
export function probeStarts(
  box: Sandbox, command: "hud" | "record" | "statusline", env: NodeJS.ProcessEnv, input = "",
): { readonly stdout: string; readonly starts: readonly unknown[] } {
  const log = box.path(`${command}-starts.jsonl`);
  const observer = `
    import childProcess from 'node:child_process';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
      childProcess[method] = (file, args, options) => {
        const call = [method, file, args, options?.cwd, options?.detached, options?.stdio];
        appendFileSync(${JSON.stringify(log)}, JSON.stringify(call) + '\\n');
        if (method !== 'spawn') throw new Error('Unexpected process start');
        return { on() {}, unref() {} };
      };
    }
    syncBuiltinESMExports();
  `;
  const preload = `--import=data:text/javascript,${encodeURIComponent(observer)}`;
  const child = spawnSync(process.execPath, [preload, BIN, command], { env, input, encoding: "utf8", timeout: 2_000 });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  assert.equal(child.stderr, "");
  const starts = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").map((line): unknown => JSON.parse(line)) : [];
  return { stdout: child.stdout, starts };
}
