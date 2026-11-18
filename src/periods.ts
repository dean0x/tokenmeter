// Periods (plan 3.5, section 4). Pure functions of `now`, the quota samples and
// a time zone. The zone is injected: a function from an instant to the offset
// of local time from UTC.
//
// A period is a half-open interval of instants [start, end). A bucket slot (15
// minutes, counted from the epoch in UTC) belongs to the period that holds the
// first instant of the slot, rounded down to a slot edge: see `slotRange`. So a
// period edge that is not on a slot edge gives its slot to the later period, and
// periods that follow each other never count a slot twice or lose one.

import { type Result, SLOT_MS, err, ok } from "./core.ts";
import { ANY_RESET, type QuotaProvider, type QuotaSample, pickLatestSample } from "./quota.ts";
import { DAY_MS, slotOf } from "./store.ts";

export const HOUR_MS = 3_600_000;
export const WEEK_MS = 7 * DAY_MS;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;

// Local time offsets are at most 14 hours, so the first instant of a local
// wall time is inside this distance of the wall time read as UTC.
const SEARCH_SPAN_MS = 3 * DAY_MS;
// The span halves each step: 6 days of milliseconds need 30 steps.
const MAX_SEARCH_STEPS = 40;

// ---------------------------------------------------------------------------
// Zones
// ---------------------------------------------------------------------------

export interface Zone {
  // Local time minus UTC, in milliseconds, at the instant `utcMs`.
  readonly offsetMs: (utcMs: number) => number;
}

function partOf(parts: readonly Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
  return Number(parts.find((part) => part.type === type)?.value ?? Number.NaN);
}

// An IANA zone name such as "Europe/Berlin". The offset comes from the wall
// clock that Intl shows for the instant, so it follows every DST change.
export function zoneNamed(name: string): Result<Zone, "bad_zone"> {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
  } catch {
    return err("bad_zone");
  }
  const offsetMs = (utcMs: number): number => {
    const whole = Math.floor(utcMs / MS_PER_SECOND) * MS_PER_SECOND;
    const parts = format.formatToParts(whole);
    const wall = Date.UTC(
      partOf(parts, "year"),
      partOf(parts, "month") - 1,
      partOf(parts, "day"),
      partOf(parts, "hour"),
      partOf(parts, "minute"),
      partOf(parts, "second"),
    );
    return wall - whole;
  };
  return ok({ offsetMs });
}

// The zone of this process. It follows the TZ environment variable.
export function localZone(): Zone {
  return { offsetMs: (utcMs) => -new Date(utcMs).getTimezoneOffset() * MS_PER_MINUTE };
}

function wallOf(zone: Zone, utcMs: number): number {
  return utcMs + zone.offsetMs(utcMs);
}

// The first instant whose local wall clock is at or after `wallMs`. When the
// wall time does not exist (the clock jumps over it) this is the instant of the
// jump. The search is a bisection with a fixed step bound.
function firstInstantAtWall(zone: Zone, wallMs: number): number {
  let low = wallMs - SEARCH_SPAN_MS;
  let high = wallMs + SEARCH_SPAN_MS;
  for (let step = 0; step < MAX_SEARCH_STEPS && high - low > 1; step += 1) {
    const middle = Math.floor((low + high) / 2);
    if (wallOf(zone, middle) >= wallMs) {
      high = middle;
    } else {
      low = middle;
    }
  }
  return high;
}

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

export interface Period {
  readonly start: number;
  readonly end: number;
}

export type WeekKind = "reset" | "rolling";

export interface WeekPeriod extends Period {
  readonly kind: WeekKind;
}

// The local calendar day of `nowMs`, from its first instant to the first
// instant of the next day. A DST day is 23 or 25 hours long.
export function todayPeriod(zone: Zone, nowMs: number): Period {
  const wall = wallOf(zone, nowMs);
  const midnight = Math.floor(wall / DAY_MS) * DAY_MS;
  return { start: firstInstantAtWall(zone, midnight), end: firstInstantAtWall(zone, midnight + DAY_MS) };
}

// The first instant of the local calendar day named "YYYY-MM-DD" (a name that
// localDateOf made). When midnight does not exist, it is the instant of the jump.
export function localDayStart(zone: Zone, date: string): number {
  return firstInstantAtWall(zone, Date.parse(`${date}T00:00:00Z`));
}

// The local calendar month of `nowMs`.
export function monthPeriod(zone: Zone, nowMs: number): Period {
  const wall = new Date(wallOf(zone, nowMs));
  const year = wall.getUTCFullYear();
  const month = wall.getUTCMonth();
  return {
    start: firstInstantAtWall(zone, Date.UTC(year, month, 1)),
    end: firstInstantAtWall(zone, Date.UTC(year, month + 1, 1)),
  };
}

// The week of one subscription. With a week sample: the seven days up to its
// latest reset time. A reset time that is past rolls forward by whole weeks,
// until the reset is after `nowMs`. With no sample: the newest 672 slots, so
// the slot of `nowMs` counts, marked "rolling".
export function weekPeriod(samples: readonly QuotaSample[], provider: QuotaProvider, nowMs: number): WeekPeriod {
  const latest = pickLatestSample(samples, provider, "week", ANY_RESET);
  if (latest === null) {
    const end = (slotOf(nowMs) + 1) * SLOT_MS;
    return { start: end - WEEK_MS, end, kind: "rolling" };
  }
  const weeksPast = latest.resetsAt > nowMs ? 0 : Math.floor((nowMs - latest.resetsAt) / WEEK_MS) + 1;
  const end = latest.resetsAt + weeksPast * WEEK_MS;
  return { start: end - WEEK_MS, end, kind: "reset" };
}

// The slots [from, to) of a period.
export function slotRange(period: Period): { readonly from: number; readonly to: number } {
  return { from: slotOf(period.start), to: slotOf(period.end) };
}
