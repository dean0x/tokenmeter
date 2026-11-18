// The per-day totals (days.json), kept next to the 15 minute rows.
//
//   days.json   { version, backfilled, cutThrough, days: { "YYYY-MM-DD": { claude, codex, models } } }
//
// `backfilled` is true once the one-time backfill ran. `cutThrough` is null when
// it read everything, else the last day that a limit may have left incomplete.
//
// A day is a local calendar day in the zone of the collect process. A bucket
// belongs to the day that holds the start of its slot. `claude` and `codex` hold
// the five raw columns of the provider, `models` the same for each model, under
// the key "provider|model". A day with no tokens has no row. A row lives
// DAYS_HORIZON_DAYS days, then it is pruned.
//
// Inside the horizon of the 15 minute rows, a day row is the sum of its 15 minute
// rows: the store adds and removes the same columns in both. Older days come from
// the backfill (see Store.finishBackfill) and never change again.
//
// This module holds the data and its text form only. It imports nothing from the
// store (the store imports it) and nothing at run time from periods.ts.

import { DAYS_HORIZON_DAYS, DAYS_MAX_MODELS, STORE_VERSION, TOKEN_BUCKETS, compareText, weighted } from "./core.ts";
import type { Zone } from "./periods.ts";
import type { Provider } from "./store.ts";

export const DAYS_FILE = "days.json";

const DAY_MS = 86_400_000;
const DATE_NAME = /^(\d{4})-(\d{2})-(\d{2})$/;
const BUCKET_COUNT = TOKEN_BUCKETS.length;

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// "YYYY-MM-DD" of the local calendar day that holds the instant `ms`.
export function localDateOf(zone: Zone, ms: number): string {
  return new Date(ms + zone.offsetMs(ms)).toISOString().slice(0, 10);
}

// A date name that is a real calendar day. Calendar arithmetic is in UTC on
// purpose: a date name has no zone, so a day always has one successor.
export function isDateName(text: string): boolean {
  const match = DATE_NAME.exec(text);
  if (match === null) return false;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === text;
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// The oldest day that a day row may have at `nowMs`: the horizon holds
// DAYS_HORIZON_DAYS days, today included.
export function cutoffDateOf(zone: Zone, nowMs: number): string {
  return shiftDate(localDateOf(zone, nowMs), 1 - DAYS_HORIZON_DAYS);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export function zeroColumns(): number[] {
  return new Array<number>(BUCKET_COUNT).fill(0);
}

function isZeroColumns(columns: readonly number[]): boolean {
  return columns.every((value) => value === 0);
}

// A column stops at 0 when a removal is larger than what is there.
function addColumns(target: number[], tokens: readonly number[], sign: 1 | -1): void {
  for (let index = 0; index < BUCKET_COUNT; index += 1) {
    target[index] = Math.max(0, (target[index] ?? 0) + sign * (tokens[index] ?? 0));
  }
}

function weightedColumns(columns: readonly number[]): number {
  return weighted({
    input: columns[0] ?? 0,
    cacheWrite5m: columns[1] ?? 0,
    cacheWrite1h: columns[2] ?? 0,
    cacheRead: columns[3] ?? 0,
    output: columns[4] ?? 0,
  });
}

// The `limit` entries with the most weighted tokens, the larger first. Equal
// entries go in text order of their key, so the cut is the same on every run.
export function topModels<T extends readonly number[]>(
  entries: Iterable<readonly [string, T]>,
  limit: number = DAYS_MAX_MODELS,
): (readonly [string, T])[] {
  return [...entries]
    .sort((a, b) => weightedColumns(b[1]) - weightedColumns(a[1]) || compareText(a[0], b[0]))
    .slice(0, limit);
}

export interface DayTotals {
  readonly claude: number[];
  readonly codex: number[];
  // Key "provider|model".
  readonly models: Map<string, number[]>;
}

function modelKey(provider: Provider, model: string): string {
  return `${provider}|${model}`;
}

export class DayRows {
  readonly #days = new Map<string, DayTotals>();
  #backfilled: boolean;
  #cutThrough: string | null;
  #dirty = false;

  // `cutThrough` is the last day that a cut backfill may have left incomplete.
  constructor(backfilled: boolean, cutThrough: string | null = null) {
    this.#backfilled = backfilled;
    this.#cutThrough = cutThrough;
  }

  get backfilled(): boolean {
    return this.#backfilled;
  }

  // The last day that the backfill may not have covered whole, or null when it
  // read everything. A day after it comes from the normal scan only.
  get cutThrough(): string | null {
    return this.#cutThrough;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  // Marks the one-time backfill as done, with the last day that it may have left
  // incomplete when a limit cut it. It is the only change that a load makes.
  markBackfilled(cutThrough: string | null): void {
    if (this.#backfilled) return;
    this.#backfilled = true;
    this.#cutThrough = cutThrough;
    this.#dirty = true;
  }

  // The dates with a row, the oldest first.
  dates(): string[] {
    return [...this.#days.keys()].sort(compareText);
  }

  get(date: string): DayTotals | undefined {
    return this.#days.get(date);
  }

  // Puts a row read from the file. It does not mark the rows as changed.
  load(date: string, row: DayTotals): void {
    this.#days.set(date, row);
  }

  // Adds (+1) or removes (-1) five columns of one model on one day.
  add(date: string, provider: Provider, model: string, tokens: readonly number[], sign: 1 | -1): void {
    let day = this.#days.get(date);
    if (day === undefined) {
      if (sign < 0) return;
      day = { claude: zeroColumns(), codex: zeroColumns(), models: new Map() };
      this.#days.set(date, day);
    }
    addColumns(day[provider], tokens, sign);
    const key = modelKey(provider, model);
    let row = day.models.get(key);
    if (row === undefined && sign > 0) {
      row = zeroColumns();
      day.models.set(key, row);
    }
    if (row !== undefined) {
      addColumns(row, tokens, sign);
      if (isZeroColumns(row)) day.models.delete(key);
    }
    if (isZeroColumns(day.claude) && isZeroColumns(day.codex)) this.#days.delete(date);
    this.#dirty = true;
  }

  // Drops the days before `cutoffDate`.
  prune(cutoffDate: string): void {
    for (const date of [...this.#days.keys()]) {
      if (date < cutoffDate) {
        this.#days.delete(date);
        this.#dirty = true;
      }
    }
  }

  // The file body. A day keeps at most DAYS_MAX_MODELS models. Dates and model
  // keys are in text order.
  toJson(): unknown {
    const days: Record<string, unknown> = {};
    for (const date of this.dates()) {
      const day = this.#days.get(date);
      if (day === undefined) continue;
      const kept = topModels(day.models).sort((a, b) => compareText(a[0], b[0]));
      days[date] = { claude: day.claude, codex: day.codex, models: Object.fromEntries(kept) };
    }
    return { version: STORE_VERSION, backfilled: this.#backfilled, cutThrough: this.#cutThrough, days };
  }
}
