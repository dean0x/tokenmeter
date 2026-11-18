import { homedir } from "node:os";
import { ok, SCHEMA_ID } from "./core.ts";
import { defaultDeps, existingDataDir, resolveDataDirPath } from "./fsafe.ts";
import { readRefreshState, refreshGate } from "./gate.ts";
import { readCodexLatest, type CodexLatestWindow } from "./quota.ts";
import { resolveCodex, startRefresh } from "./spawn.ts";

const MISSING_MAX_AGE_MS = 600_000;
const WINDOW_MINUTES = { five_hour: 300, week: 10_080 } as const;

function codexData(samples: readonly CodexLatestWindow[], at: number) {
  return {
    at,
    limit_reached: samples.some((sample) => sample.at === at && sample.reached),
    windows: samples.map((sample) => ({
      window_minutes: WINDOW_MINUTES[sample.window],
      pct: sample.usedPercent,
      resets_at: sample.resetsAt,
      at: sample.at,
      source: sample.src,
    })),
  };
}

function readHud(ownBin: string) {
  const env = process.env;
  const deps = defaultDeps();
  const path = resolveDataDirPath({ homeDir: homedir(), env, platform: process.platform, flag: null });
  const dir = existingDataDir(path, deps);
  if (!dir.ok && dir.error.code !== "not_found") return null;
  const dataDir = dir.ok ? dir.value : path;
  const now = deps.nowMs();
  const samples = dir.ok ? readCodexLatest(dataDir, now, deps) : [];
  let at: number | null = null;
  for (const sample of samples) at = Math.max(at ?? 0, sample.at);
  const state = dir.ok ? readRefreshState(dataDir, deps) : ok(null);
  const binKey = () => {
    const bin = resolveCodex(env);
    return bin.ok ? bin.value.binKey : null;
  };
  // Only the refresher can create the data folder.
  if (refreshGate(dataDir, at, state, binKey, deps)) startRefresh(ownBin, dataDir, env, dir.ok);
  if (at === null || (state.ok && state.value?.codexFound === false && now - at >= MISSING_MAX_AGE_MS)) return null;
  return codexData(samples, at);
}

export function hudMain(ownBin: string): void {
  const codex = readHud(ownBin);
  const envelope = { schema: SCHEMA_ID, ok: true, data: { hud: 1, codex } };
  // At most two windows with bounded numbers and fixed strings fit in 4 KiB.
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
