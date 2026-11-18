// The record command (plan 3.1, section 6): a statusline filter.
//
// It copies stdin to stdout, chunk by chunk, as the chunks arrive. It keeps a
// copy of the first 64 KiB. At the end of stdin it ends stdout, so the next
// command in the pipe sees the end of input at once. Only then it parses the
// copy and stores the rate limits (R7). The store work waits for the end of
// stdout: sync work before that would hold back the end of the stream.
//
// Record never fails the pipe. Every error is swallowed, nothing goes to stderr,
// it prints nothing of its own and it does not call process.exit. An unsafe or
// missing data folder, a bad input or a late store only means that nothing is
// stored. The deadline stops the store work between its steps; it never stops
// the copy. A file call that blocks is not interrupted by it.

import { homedir } from "node:os";
import type { Readable, Writable } from "node:stream";
import { type FsDeps, attemptFs, defaultDeps, prepareDataDir, resolveDataDirPath } from "./fsafe.ts";
import { hasLimits, parseStatusline, recordStatuslineQuota } from "./quota.ts";

export const RECORD_COPY_CAP_BYTES = 64 * 1024;
export const RECORD_DEADLINE_MS = 1500;

export interface RecordIo {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: string;
  readonly homeDir: string;
  readonly deps: FsDeps;
  readonly deadlineMs: number;
}

// The first `capBytes` of the input. Past the cap the copy is dropped, and the
// text is null: a cut JSON text is never parsed.
interface Copy {
  add(chunk: Buffer): void;
  text(): string | null;
}

function makeCopy(capBytes: number): Copy {
  let parts: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    add(chunk: Buffer): void {
      if (truncated) return;
      if (size + chunk.length > capBytes) {
        truncated = true;
        parts = [];
        return;
      }
      parts.push(chunk);
      size += chunk.length;
    },
    text(): string | null {
      return truncated ? null : Buffer.concat(parts, size).toString("utf8");
    },
  };
}

function storeQuota(io: RecordIo, text: string | null): void {
  if (text === null) return;
  const startMs = io.deps.nowMs();
  const parsed = parseStatusline(text, startMs);
  if (!parsed.ok || !hasLimits(parsed.value)) return;
  const path = resolveDataDirPath({ flag: null, env: io.env, platform: io.platform, homeDir: io.homeDir });
  const dir = prepareDataDir(path, io.deps);
  if (!dir.ok || io.deps.nowMs() - startMs > io.deadlineMs) return;
  recordStatuslineQuota(dir.value, parsed.value, startMs, io.deps);
}

// Never rejects. Resolves after the store work, or after the copy if there is none.
export function runRecord(io: RecordIo): Promise<void> {
  return new Promise<void>((resolve) => {
    const copy = makeCopy(RECORD_COPY_CAP_BYTES);
    let outputOpen = true;
    let finished = false;
    let stored = false;

    const store = (): void => {
      if (stored) return;
      stored = true;
      attemptFs(() => storeQuota(io, copy.text()));
      resolve();
    };

    // A broken output stops the copy to stdout. The input is still read to its end.
    const stopOutput = (): void => {
      outputOpen = false;
      attemptFs(() => io.stdin.resume());
    };

    const onData = (chunk: Buffer | string): void => {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      copy.add(buffer);
      if (!outputOpen) return;
      const written = attemptFs(() => io.stdout.write(buffer));
      if (!written.ok || written.value) return;
      // The reader is slow: wait for it before the next chunk.
      attemptFs(() => {
        io.stdin.pause();
        io.stdout.once("drain", () => io.stdin.resume());
      });
    };

    const finish = (): void => {
      if (finished) return;
      finished = true;
      if (!outputOpen) {
        store();
        return;
      }
      const ended = attemptFs(() => {
        io.stdout.once("close", store);
        io.stdout.end(store);
      });
      if (!ended.ok) store();
    };

    const wired = attemptFs(() => {
      io.stdout.on("error", stopOutput);
      io.stdin.on("data", onData);
      io.stdin.once("end", finish);
      io.stdin.once("error", finish);
      io.stdin.once("close", finish);
    });
    if (!wired.ok) finish();
  });
}

// Real streams, env and clock. Null when the process streams are not usable.
export function processIo(): RecordIo | null {
  const io = attemptFs(
    (): RecordIo => ({
      stdin: process.stdin,
      stdout: process.stdout,
      env: process.env,
      platform: process.platform,
      homeDir: homedir(),
      deps: defaultDeps(),
      deadlineMs: RECORD_DEADLINE_MS,
    }),
  );
  return io.ok ? io.value : null;
}

export async function recordMain(): Promise<void> {
  const io = processIo();
  if (io !== null) await runRecord(io);
}
