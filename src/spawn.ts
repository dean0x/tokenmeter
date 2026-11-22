import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync, statSync, type Stats } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { err, ok, type Result } from "./core.ts";
import { defaultDeps, readOwnFile, writeOwnFile } from "./fsafe.ts";

const MAX_PATH_BYTES = 64 * 1024;
const MAX_PATH_ENTRIES = 256;
const SHARED_WRITE = 0o022;

export interface ResolvedCodex {
  readonly path: string;
  readonly binKey: string;
  readonly searchPath: string;
}

interface CodexPathDeps {
  readonly uid: number;
  readonly stat?: (path: string) => Stats;
}

function privateEntry(info: Stats, uid: number): boolean {
  return (info.uid === 0 || info.uid === uid) && (info.mode & SHARED_WRITE) === 0;
}

function privateFolder(path: string, deps: CodexPathDeps): boolean {
  try {
    const info = (deps.stat ?? statSync)(path);
    return info.isDirectory() && privateEntry(info, deps.uid);
  } catch {
    return false;
  }
}

function pathFolders(path: string, deps: CodexPathDeps): readonly string[] {
  if (path.length > MAX_PATH_BYTES || Buffer.byteLength(path) > MAX_PATH_BYTES) return [];
  const parts = path.split(delimiter);
  if (parts.length > MAX_PATH_ENTRIES) return [];
  return [...new Set(parts.filter(isAbsolute))].filter((folder) => privateFolder(folder, deps));
}

export function resolveCodex(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: CodexPathDeps = defaultDeps(),
): Result<ResolvedCodex, "missing"> {
  if (platform === "win32") return err("missing");
  const folders = pathFolders(env["PATH"] ?? "", deps);
  const searchPath = folders.join(delimiter);
  for (const folder of folders) {
    try {
      const path = realpathSync.native(join(folder, "codex"));
      const info = (deps.stat ?? statSync)(path);
      if (!info.isFile() || !privateEntry(info, deps.uid) || !privateFolder(dirname(path), deps)) continue;
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
  // Check the caller's current permission immediately before each child start.
  readonly mayStart?: () => boolean;
}

type Send = (text: string) => boolean;

export interface CodexExchange<T, E> {
  // Omit input to close stdin at once. A live exchange ends when a callback returns a Result.
  readonly initialInput?: string;
  readonly onLine: (line: string, send: Send) => Result<T, E> | undefined;
  readonly onExit: () => Result<T, E>;
  readonly onStop?: (reason: CodexRunError) => Result<T, E> | undefined;
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

// Submit a refresh without pipes or a reference that keeps the caller alive.
export function startRefresh(
  ownBin: string, dataDir: string, source: NodeJS.ProcessEnv, dataDirExists: boolean,
): Result<null, "error"> {
  if (!isAbsolute(ownBin) || !isAbsolute(dataDir)) return err("error");
  try {
    const bin = realpathSync.native(ownBin);
    const cwd = dataDirExists ? dataDir : dirname(bin);
    const deps = defaultDeps();
    if (!dataDirExists && !privateFolder(cwd, deps)) return err("error");
    const searchPath = pathFolders(source["PATH"] ?? "", deps).join(delimiter);
    const child = spawn(process.execPath, [bin, "refresh"], {
      shell: false, detached: true, cwd, stdio: "ignore",
      env: { ...childEnv(searchPath, source), TOKENMETER_DATA_DIR: dataDir },
    });
    // A child start can fail after submission. Do not report that to the HUD.
    child.on("error", () => undefined);
    child.unref();
    return ok(null);
  } catch {
    return err("error");
  }
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

// Reuse one line buffer. Stop as soon as the exchange settles or exceeds a cap.
function lineReceiver(maxBytes: number, accept: (text: string) => void, stopped: () => boolean) {
  const line = Buffer.allocUnsafe(Math.min(LINE_BYTES, maxBytes));
  let total = 0;
  let length = 0;
  function emit(): void {
    const end = length > 0 && line[length - 1] === 13 ? length - 1 : length;
    const text = line.toString("utf8", 0, end);
    length = 0;
    accept(text);
  }
  function receive(chunk: Buffer): boolean {
    total += chunk.length;
    if (total > maxBytes) return false;
    for (let start = 0; !stopped() && start < chunk.length;) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (length + end - start > line.length) return false;
      length += chunk.copy(line, length, start, end);
      if (newline >= 0) emit();
      start = end + 1;
    }
    return true;
  }
  return { receive, finish: () => { if (length > 0) emit(); } };
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
    let child: ChildProcessByStdio<Writable, Readable, null>;
    try {
      if (options.mayStart?.() === false) { resolve(err("aborted")); return; }
      child = spawn(codex.path, args, {
        shell: false, detached: true, cwd: options.cwd, stdio: ["pipe", "pipe", "ignore"],
        env: childEnv(codex.searchPath, options.env ?? process.env),
      });
    } catch {
      resolve(err("error"));
      return;
    }

    let settled = false;
    let stopping = false;
    let inputBytes = 0;
    const abort = () => stop("aborted");
    const deadline = setTimeout(() => stop("timeout"), timeout);

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

    function stop(reason: CodexRunError): void {
      if (settled || stopping) return;
      stopping = true;
      let result: Result<T, E> | undefined;
      try {
        result = exchange.onStop?.(reason);
      } catch {
        // Keep the original stop reason if the hook fails.
      }
      settle(result ?? err(reason));
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

    const lines = lineReceiver(maxBytes, (text) => {
      const result = exchange.onLine(text, send);
      if (result !== undefined) settle(result);
    }, () => settled);

    child.stdout.on("data", (chunk: Buffer) => {
      try {
        if (!lines.receive(chunk)) stop("output_limit");
      } catch {
        stop("error");
      }
    });

    const failed = () => stop("error");
    child.on("error", failed);
    child.stdin.on("error", failed);
    child.stdout.on("error", failed);
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) { failed(); return; }
      try {
        lines.finish();
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
// Each HUD refresh has its own process. Keep only the supported binary's digest.
// The refresh gate caches an old or malformed answer for up to one day.
const VERSION_CACHE = "codex-version.json";
const CACHE_BYTES = 66; // 64 hex digits and the JSON quotes.
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
  if (!isAbsolute(options.cwd)) return err("error");
  const deps = defaultDeps();
  const cache = join(options.cwd, VERSION_CACHE);
  const digest = JSON.stringify(codex.binKey);
  const saved = readOwnFile(cache, CACHE_BYTES, deps);
  if (saved.ok && saved.value === digest) return ok(undefined);
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
  if (!answer.value.ok) return answer.value;
  return writeOwnFile(cache, digest, deps).ok ? ok(undefined) : err("error");
}
