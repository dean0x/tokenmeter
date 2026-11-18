// The statusline command: tokenmeter as the status line of Claude Code.
//
// It reads the statusline JSON from stdin once and stores the rate limits through
// the record code path (runRecord, with its pass-through output thrown away).
// Then it prints ONE short line on stdout and ends stdout:
//
//   Claude wk 40% | 70% by reset | today 2.7k, 3m ago
//   Claude wk 80% | 140% by reset, runs out in 24h | today 2.7k, 3m ago
//
// The week percent and the forecast come from quota-latest.json. The forecast is
// arithmetic on that reading. Today's tokens (weighted) and the age come from the
// status snapshot that collect wrote. With no snapshot, the line has the quota and
// the forecast only. A window with a reason code shows "?".
//
// It never collects and starts no process. Every error is swallowed, nothing goes
// to stderr, and a missing or unsafe data folder gives a short fixed line. The line
// is built from numbers and fixed words only, so it is plain ASCII.

import { Writable } from "node:stream";
import { forecastFrom } from "./analysis.ts";
import { asRow } from "./core.ts";
import { attemptFs, existingDataDir, resolveDataDirPath } from "./fsafe.ts";
import { HOUR_MS } from "./periods.ts";
import { type QuotaReading, readLatestQuota } from "./quota.ts";
import { type RecordIo, processIo, runRecord } from "./record.ts";
import { readSnapshot } from "./status.ts";
import { DAY_MS } from "./store.ts";

export const NO_DATA_LINE = "tokenmeter: no data";

// A hard bound on the line. The longest line that the parts make is 79.
const LINE_MAX_CHARS = 80;
const MINUTE_MS = 60_000;
const SHOWN_MAX_PERCENT = 999;
const SHOWN_MAX_DAYS = 999;
const SHOWN_MAX_TOKENS = 999e9;
// Hours show up to this age, then days.
const HOURS_TO_DAYS = 48;
const TOKEN_UNITS: readonly (readonly [string, number])[] = [
  ["B", 1e9],
  ["M", 1e6],
  ["k", 1e3],
];

export interface TodayTokens {
  // Claude tokens of today, weighted, from the snapshot.
  readonly weighted: number;
  // When collect wrote the snapshot, epoch milliseconds.
  readonly writtenAt: number;
}

export interface LineInput {
  readonly nowMs: number;
  readonly week: QuotaReading;
  readonly today: TodayTokens | null;
}

// ---------------------------------------------------------------------------
// The line (pure)
// ---------------------------------------------------------------------------

function percentText(percent: number): string {
  const whole = Math.round(percent);
  return whole > SHOWN_MAX_PERCENT ? `>${SHOWN_MAX_PERCENT}%` : `${whole}%`;
}

// A span of time in its largest whole unit: 7m, 5h, 2d. Under a minute: <1m.
function spanText(spanMs: number): string {
  if (spanMs < MINUTE_MS) return "<1m";
  if (spanMs < HOUR_MS) return `${Math.floor(spanMs / MINUTE_MS)}m`;
  if (spanMs < HOURS_TO_DAYS * HOUR_MS) return `${Math.floor(spanMs / HOUR_MS)}h`;
  const days = Math.floor(spanMs / DAY_MS);
  return days > SHOWN_MAX_DAYS ? `>${SHOWN_MAX_DAYS}d` : `${days}d`;
}

// 842, 1.5k, 123k, 45.6M, 5.5B.
function tokensText(count: number): string {
  if (count > SHOWN_MAX_TOKENS) return ">999B";
  const unit = TOKEN_UNITS.find(([, size]) => count >= size);
  if (unit === undefined) return String(Math.round(count));
  const scaled = count / unit[1];
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${unit[0]}`;
}

function forecastText(week: Extract<QuotaReading, { known: true }>, nowMs: number): string | null {
  const forecast = forecastFrom({ usedPercent: week.usedPercent, resetsAt: week.resetsAt, at: week.at });
  if (forecast === null) return null;
  const byReset = `${percentText(forecast.atResetPct)} by reset`;
  return forecast.runsOutAt === null ? byReset : `${byReset}, runs out in ${spanText(forecast.runsOutAt - nowMs)}`;
}

export function renderStatusline(input: LineInput): string {
  const { week, today, nowMs } = input;
  const parts = [`Claude wk ${week.known ? percentText(week.usedPercent) : "?"}`];
  const forecast = week.known ? forecastText(week, nowMs) : null;
  if (forecast !== null) parts.push(forecast);
  if (today !== null) parts.push(`today ${tokensText(today.weighted)}, ${spanText(nowMs - today.writtenAt)} ago`);
  return parts.join(" | ").slice(0, LINE_MAX_CHARS);
}

// ---------------------------------------------------------------------------
// The data (reads only)
// ---------------------------------------------------------------------------

// The snapshot is a file: a value that is not a count, or no snapshot at all,
// leaves today's tokens out and keeps the rest of the line.
function todayOf(dataDir: string, io: RecordIo): TodayTokens | null {
  const snapshot = readSnapshot(dataDir, io.deps);
  if (!snapshot.ok || snapshot.value === null || snapshot.value.data === null) return null;
  const { data } = snapshot.value;
  const claude = data.subscriptions.find((subscription) => subscription.id === "claude");
  const weighted = asRow(asRow(claude?.tokens)?.["today"])?.["weighted"];
  if (typeof weighted !== "number" || !Number.isFinite(weighted) || weighted < 0) return null;
  return { weighted, writtenAt: data.written_at };
}

function lineInput(io: RecordIo): LineInput | null {
  const path = resolveDataDirPath({ flag: null, env: io.env, platform: io.platform, homeDir: io.homeDir });
  const dir = existingDataDir(path, io.deps);
  if (!dir.ok) return null;
  const nowMs = io.deps.nowMs();
  return { nowMs, week: readLatestQuota(dir.value, nowMs, io.deps).week, today: todayOf(dir.value, io) };
}

function lineFor(io: RecordIo): string {
  const line = attemptFs(() => {
    const input = lineInput(io);
    return input === null ? NO_DATA_LINE : renderStatusline(input);
  });
  return line.ok ? line.value : NO_DATA_LINE;
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

function discard(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
}

// Writes the text, ends the output and resolves. A broken output only ends it.
function endWith(output: Writable, text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const wired = attemptFs(() => {
      output.once("error", () => resolve());
      output.once("close", () => resolve());
      output.end(text, () => resolve());
    });
    if (!wired.ok) resolve();
  });
}

// Never rejects. The store work is the record code path: its copy of stdin goes
// to a sink, so the only thing on stdout is the line.
export async function runStatusline(io: RecordIo): Promise<void> {
  await runRecord({ ...io, stdout: discard() });
  await endWith(io.stdout, `${lineFor(io)}\n`);
}

export async function statuslineMain(): Promise<void> {
  const io = processIo();
  if (io !== null) await runStatusline(io);
}
