import { CODEX_PREFILTER, findCodexFiles } from "./collect.ts";
import { ok, type Result } from "./core.ts";
import { defaultDeps, type FsDeps, type FsError } from "./fsafe.ts";
import { readRows } from "./lines.ts";
import { CODEX_INITIAL_STATE, stepCodexRow, type CodexQuotaSample } from "./sources.ts";

const FILE_LIMIT = 3;
const TAIL_BYTES = 1024 * 1024;
const RETRY_BYTES = 4 * TAIL_BYTES;

type Rollout = { readonly path: string; readonly size: number; readonly dev: number; readonly ino: number };

function scanTail(file: Rollout, bytes: number, nowMs: number, deps: FsDeps): Result<CodexQuotaSample[], FsError> {
  const samples: CodexQuotaSample[] = [];
  let state = CODEX_INITIAL_STATE;
  const scanned = readRows(file.path, {
    offset: Math.max(0, file.size - bytes), maxBytes: bytes,
    prefilter: CODEX_PREFILTER, discardFirstLine: true, identity: file,
  }, (row) => {
    const step = stepCodexRow(state, row, nowMs);
    state = step.state;
    samples.push(...step.quota);
  }, deps);
  return scanned.ok ? ok(samples) : scanned;
}

export function readCodexTail(
  root: string,
  nowMs: number,
  deps: FsDeps = defaultDeps(),
): Result<readonly CodexQuotaSample[], FsError> {
  const files = findCodexFiles(root, nowMs, undefined, deps);
  if (!files.ok) return files;
  const samples: CodexQuotaSample[] = [];
  for (const file of files.value.slice(0, FILE_LIMIT)) {
    const first = scanTail(file, TAIL_BYTES, nowMs, deps);
    if (!first.ok) continue;
    const tail = first.value.length === 0 && file.size > TAIL_BYTES
      ? scanTail(file, RETRY_BYTES, nowMs, deps) : first;
    if (tail.ok) for (const sample of tail.value) samples.push(sample);
  }
  // The quota store caps the batch; put the newest samples within that cap.
  return ok(samples.sort((a, b) => b.at - a.at));
}
