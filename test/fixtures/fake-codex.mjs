// Test-only Codex stand-in. The wrapper never looks up Node on PATH.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(import.meta.url);
const quote = (arg) => "'" + arg.replaceAll("'", "'\\''") + "'";

export function writeFakeCodex(folder, mode = "eof") {
  mkdirSync(folder, { mode: 0o700 });
  const bin = join(folder, "codex");
  const command = [process.execPath, script, mode].map(quote).join(" ");
  writeFileSync(bin, `#!/bin/sh\nexec ${command} "$@"\n`, { mode: 0o700, flag: "wx" });
  return bin;
}

function descendant() {
  const stop = setTimeout(() => { process.exitCode = 1; }, 4_500);
  process.once("SIGTERM", () => {
    clearTimeout(stop);
    writeFileSync("term", "");
    setTimeout(() => writeFileSync("survivor", ""), 750);
  });
  process.stdout.write("ready\n");
}

function version(mode) {
  appendFileSync("version-calls", "1\n");
  if (mode === "rpc-switch-off") writeFileSync("config.json", '{"version":1,"app_server":"off"}', { mode: 0o600 });
  if (mode === "old") process.stdout.write("codex-cli 0.56.0-alpha.1\n");
  else if (mode === "rpc-old") process.stdout.write("codex-cli 0.55.0\n");
  else if (mode === "bad") process.stdout.write("unclear 0.165.0\n");
  else process.stdout.write("codex-cli 0.165.0\n");
  if (mode === "large") process.stdout.write("x".repeat(4_096));
  if (mode === "fail") process.exitCode = 1;
}

function rpc() {
  appendFileSync("app-server-calls", "1\n");
  const replies = JSON.parse(readFileSync("rpc-replies.json", "utf8"));
  writeFileSync("rpc-input", "");
  writeFileSync("rpc-pid", String(process.pid));
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    appendFileSync("rpc-input", line + "\n");
    const method = JSON.parse(line).method;
    if (method === "initialize") process.stdout.write(replies.initialize.join("\n") + "\n");
    if (method === "account/rateLimits/read" && replies.limits.length > 0) {
      process.stdout.write(replies.limits.join("\n") + "\n", () => {
        if (replies.afterLimits === "exit0") process.exit(0);
        if (replies.afterLimits === "exit1") process.exit(1);
      });
    }
    if (method === "account/usage/read") {
      appendFileSync("usage-calls", "1\n");
      if (replies.usage?.length > 0) process.stdout.write(replies.usage.join("\n") + "\n");
    }
  });
}

function main(mode, arg) {
  if (arg === "--version") version(mode);
  else if (arg === "app-server" && (mode === "rpc" || mode === "rpc-old" || mode === "rpc-switch-off")) rpc();
  else if (mode === "env") process.stdout.write(JSON.stringify({ env: process.env, cwd: process.cwd() }) + "\n");
  else if (mode === "eof") {
    // In Codex 0.165.0, the wrapper and its only child exit cleanly within 20 ms of EOF.
    const child = spawn(process.execPath, [script, "native"], { stdio: ["inherit", "inherit", "ignore"] });
    child.once("close", (code) => { process.exitCode = code ?? 1; });
  } else if (mode === "native") {
    process.stdin.on("end", () => process.stdout.write("eof\n"));
    process.stdin.resume();
  } else if (mode === "descendant") descendant();
  else if (mode === "hang" || mode === "wide") {
    const child = spawn(process.execPath, [script, "descendant"], { stdio: ["ignore", "pipe", "ignore"] });
    child.stdout.once("data", (ready) => {
      process.stdout.write(ready);
      if (mode === "wide") process.stdout.write("é".repeat(32_769) + "\n");
    });
  } else if (mode === "many") {
    process.stdout.write(("x".repeat(32_767) + "\n").repeat(8) + "x\n");
  } else if (mode === "split") {
    const bytes = Buffer.from("aé\r\nb\n");
    process.stdout.write(bytes.subarray(0, 2));
    process.stdin.once("data", () => {
      process.stdout.write(bytes.subarray(2));
      process.stdin.resume();
    });
  }
}

if (process.argv[1] === script) main(process.argv[2], process.argv[3]);
