import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { err, ok, type Result } from "./core.ts";

const MAX_PATH_BYTES = 64 * 1024;
const MAX_PATH_ENTRIES = 256;
const SHARED_WRITE = 0o022;

export interface ResolvedCodex {
  readonly path: string;
  readonly binKey: string;
  readonly searchPath: string;
}

function privateFolder(path: string): boolean {
  try {
    const info = statSync(path);
    return info.isDirectory() && (info.mode & SHARED_WRITE) === 0;
  } catch {
    return false;
  }
}

function pathFolders(path: string): readonly string[] {
  if (path.length > MAX_PATH_BYTES || Buffer.byteLength(path) > MAX_PATH_BYTES) return [];
  const parts = path.split(delimiter);
  if (parts.length > MAX_PATH_ENTRIES) return [];
  // A wrapper can also look up its interpreter on PATH.
  return [...new Set(parts.filter(isAbsolute))].filter(privateFolder);
}

export function resolveCodex(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Result<ResolvedCodex, "missing"> {
  if (platform === "win32") return err("missing");
  const folders = pathFolders(env["PATH"] ?? "");
  const searchPath = folders.join(delimiter);
  for (const folder of folders) {
    try {
      const path = realpathSync.native(join(folder, "codex"));
      const info = statSync(path);
      if (!info.isFile() || !privateFolder(dirname(path))) continue;
      accessSync(path, constants.X_OK);
      const binKey = createHash("sha256").update(JSON.stringify([path, info.size, info.mtimeMs])).digest("hex");
      return ok({ path, binKey, searchPath });
    } catch {
      // The next PATH entry can still hold a valid executable.
    }
  }
  return err("missing");
}
const ENV_KEYS = [
  "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
] as const;

const APP_TIMEOUT_MS = 5_000;
const APP_OUTPUT_BYTES = 256 * 1024;
const LINE_BYTES = 64 * 1024;
const VERSION_TIMEOUT_MS = 2_000;
const VERSION_OUTPUT_BYTES = 4 * 1024;
const KILL_GRACE_MS = 500;
const INPUT_BYTES = 64 * 1024;

export interface CodexRunOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

type Send = (text: string) => boolean;

export interface CodexExchange<T, E> {
  // Omit input to close stdin at once. A live exchange ends when a callback returns a Result.
  readonly initialInput?: string;
  readonly onLine: (line: string, send: Send) => Result<T, E> | undefined;
  readonly onExit: () => Result<T, E>;
}

export type CodexRunError = "missing" | "timeout" | "output_limit" | "aborted" | "error";

function childEnv(searchPath: string, source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: searchPath };
  for (const key of ENV_KEYS) {
    const value = source[key];
    if (value) env[key] = value;
  }
  return env;
}

function signalGroup(pid: number | undefined, signal: "SIGTERM" | "SIGKILL"): boolean {
  if (pid === undefined || pid <= 0) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    // The group can exit before either signal. There is no process to wait for.
    return false;
  }
}

// Node supplies pipe capture and POSIX process groups without a runtime dependency.
export async function runCodex<T, E>(
  codex: ResolvedCodex,
  args: readonly ["app-server" | "--version"],
  options: CodexRunOptions,
  exchange: CodexExchange<T, E>,
): Promise<Result<T, E | CodexRunError>> {
  if (process.platform === "win32") return err("missing");
  if (options.signal?.aborted) return err("aborted");
  const version = args[0] === "--version";
  const maxTimeout = version ? VERSION_TIMEOUT_MS : APP_TIMEOUT_MS;
  const timeout = options.timeoutMs ?? maxTimeout;
  if (!Number.isInteger(timeout) || timeout <= 0 || timeout > maxTimeout || !isAbsolute(options.cwd)) return err("error");
  const maxBytes = version ? VERSION_OUTPUT_BYTES : APP_OUTPUT_BYTES;

  return new Promise((resolve) => {
    const line = Buffer.allocUnsafe(Math.min(LINE_BYTES, maxBytes));
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      child = spawn(codex.path, args, {
        shell: false, detached: true, cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"],
        env: childEnv(codex.searchPath, options.env ?? process.env),
      });
    } catch {
      resolve(err("error"));
      return;
    }

    let settled = false;
    let total = 0;
    let length = 0;
    let inputBytes = 0;
    const abort = () => settle(err("aborted"));
    const deadline = setTimeout(() => settle(err("timeout")), timeout);

    function settle(result: Result<T, E | CodexRunError>): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", abort);
      child.stdin.end();
      child.stdout.destroy();
      if (!signalGroup(child.pid, "SIGTERM")) {
        resolve(result);
        return;
      }
      setTimeout(() => {
        signalGroup(child.pid, "SIGKILL");
        resolve(result);
      }, KILL_GRACE_MS);
    }

    const send: Send = (text) => {
      if (settled || child.stdin.writableEnded) return false;
      const remaining = INPUT_BYTES - inputBytes;
      if (text.length > remaining) return false;
      const bytes = Buffer.byteLength(text);
      if (bytes > remaining) return false;
      inputBytes += bytes;
      child.stdin.write(text);
      return true;
    };

    function emitLine(): void {
      const end = length > 0 && line[length - 1] === 13 ? length - 1 : length;
      const text = line.toString("utf8", 0, end);
      length = 0;
      const result = exchange.onLine(text, send);
      if (result !== undefined) settle(result);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) { settle(err("output_limit")); return; }
      try {
        // Each pass consumes a newline or all remaining bytes in a capped chunk.
        for (let start = 0; !settled && start < chunk.length;) {
          const newline = chunk.indexOf(10, start);
          const end = newline < 0 ? chunk.length : newline;
          if (length + end - start > line.length) { settle(err("output_limit")); return; }
          length += chunk.copy(line, length, start, end);
          if (newline >= 0) emitLine();
          start = end + 1;
        }
      } catch {
        settle(err("error"));
      }
    });

    const failed = () => settle(err("error"));
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.stdout.on("error", failed);
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) { failed(); return; }
      try {
        if (length > 0) emitLine();
        if (!settled) settle(exchange.onExit());
      } catch {
        failed();
      }
    });

    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    else if (exchange.initialInput === undefined) child.stdin.end();
    else if (!send(exchange.initialInput)) failed();
  });
}

export type CodexVersionError = CodexRunError | "old" | "shape";
type VersionAnswer = Result<void, "old" | "shape">;
let lastVersion: { readonly binKey: string; readonly answer: VersionAnswer } | undefined;
const CODEX_VERSION = /^codex-cli (0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function versionAnswer(line: string | undefined): VersionAnswer {
  const match = line?.match(CODEX_VERSION);
  if (!match) return err("shape");
  const [major, minor, patch] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (![major, minor, patch].every(Number.isSafeInteger)) return err("shape");
  if (major === 0 && (minor < 56 || (minor === 56 && patch === 0 && match[4] !== undefined))) return err("old");
  return ok(undefined);
}

export async function checkCodexVersion(
  codex: ResolvedCodex,
  options: Omit<CodexRunOptions, "timeoutMs">,
): Promise<Result<void, CodexVersionError>> {
  if (options.signal?.aborted) return err("aborted");
  if (lastVersion?.binKey === codex.binKey) return lastVersion.answer;
  let line: string | undefined;
  let extraLine = false;
  const answer = await runCodex<VersionAnswer, never>(codex, ["--version"], options, {
    onLine: (text) => {
      if (line === undefined) line = text;
      else extraLine = true;
    },
    onExit: () => ok(extraLine ? err("shape") : versionAnswer(line)),
  });
  if (!answer.ok) return answer;
  lastVersion = { binKey: codex.binKey, answer: answer.value };
  return answer.value;
}
