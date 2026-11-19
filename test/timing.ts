// Timing checks for the start of the bin.
//
// A fixed time limit fails when the machine is busy, because load slows every
// process start. So a timing test also starts a baseline script: an empty Node
// script with the same shebang, the same env and the same spawn path. The test
// runs the baseline and the command in turns, so load falls on both. It then
// compares the median times. Load raises both medians and keeps the ratio; extra
// work in the command raises only the command median.

import { chmodSync, writeFileSync } from "node:fs";

export const TIMING_RUNS = 20;

// The command may take at most this many baseline starts. The command does the
// baseline Node start plus its own module load and work.
export const MAX_RATIO_TO_BASELINE = 4;

// Extra time that is always allowed. It covers the timer noise of short runs.
export const NOISE_MS = 50;

export interface TimingVerdict {
  readonly ok: boolean;
  readonly detail: string;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? Number.POSITIVE_INFINITY;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

export function judgeTiming(commandMs: readonly number[], baselineMs: readonly number[]): TimingVerdict {
  const command = median(commandMs);
  const baseline = median(baselineMs);
  const limit = MAX_RATIO_TO_BASELINE * baseline + NOISE_MS;
  const ok =
    commandMs.length > 0 &&
    commandMs.length === baselineMs.length &&
    Number.isFinite(command) &&
    Number.isFinite(baseline) &&
    command <= limit;
  const ratio = baseline > 0 ? command / baseline : Number.POSITIVE_INFINITY;
  return {
    ok,
    detail:
      `command median ${command.toFixed(0)} ms, baseline median ${baseline.toFixed(0)} ms, ` +
      `ratio ${ratio.toFixed(2)}, limit ${limit.toFixed(0)} ms (${commandMs.length} runs)`,
  };
}

// Write the baseline script at `path`, with the shebang of bin/tokenmeter.js.
export function writeBaselineScript(path: string): string {
  writeFileSync(path, "#!/usr/bin/env node\n", { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

// Run the baseline and the command in turns, `runs` times each.
export async function measurePaired(
  runs: number,
  runBaseline: () => Promise<number>,
  runCommand: (index: number) => Promise<number>,
): Promise<{ readonly baselineMs: readonly number[]; readonly commandMs: readonly number[] }> {
  const baselineMs: number[] = [];
  const commandMs: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    baselineMs.push(await runBaseline());
    commandMs.push(await runCommand(i));
  }
  return { baselineMs, commandMs };
}
