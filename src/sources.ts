// Row parsers for Claude transcripts and Codex rollouts (plan 3.3).
//
// Each parser takes one parsed row and returns a fixed record, or a skip reason
// code. Only named fields are copied into new records. The parsed row, and every
// text field in it, is dropped: no record holds a reference to it. Field names
// are the ones in the schema note and are unverified until the first real-data check.

import { createHash } from "node:crypto";
import {
  CLAUDE_KEY_SEPARATOR,
  CODEX_PROXY_KEY_TAG,
  type Result,
  type TokenRecord,
  asRow,
  err,
  folderKey as toFolderKey,
  ok,
  quotaPoint,
  sanitizeModel,
  sanitizeTime,
  sanitizeTokens,
} from "./core.ts";
import type { Row } from "./lines.ts";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

// Codes only. The caller counts them; they never hold input text.
export const SKIP_REASONS = [
  "not_assistant",
  "api_error",
  "synthetic",
  "no_usage",
  "missing_id",
  "bad_token",
  "bad_time",
  "ignored_type",
  "repeat_event",
  "other_limit",
  "bad_window",
  "bad_percent",
  "bad_reset",
] as const;

export type SkipReason = (typeof SKIP_REASONS)[number];

// Folder key for a row with no usable folder path. Real keys start with "-".
export const UNKNOWN_FOLDER = "unknown";

// Ids come from the log but are opaque. A safe id has no separator or space.
const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

type CountReader = (value: unknown) => Result<number, "bad_token">;

function readId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

function folderOf(cwd: unknown): string {
  return typeof cwd === "string" && cwd.length > 0 ? toFolderKey(cwd) : UNKNOWN_FOLDER;
}

// An absent or null optional field counts as 0.
function optionalCount(value: unknown, read: CountReader): Result<number, "bad_token"> {
  return value === undefined || value === null ? ok(0) : read(value);
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

export interface ClaudeEntry {
  // Join message.id and the request id or reserved proxy tag with "|".
  readonly key: string;
  // Epoch milliseconds.
  readonly at: number;
  readonly model: string;
  readonly folderKey: string;
  readonly tokens: TokenRecord;
}

// Bump this when the Claude parser rule changes. Each bump re-reads all discovered Claude data once.
export const CLAUDE_PARSER_REV = 1;

function readOneHourWrite(creation: unknown): Result<number, "bad_token"> {
  if (creation === undefined || creation === null) return ok(0);
  const nested = asRow(creation);
  if (nested === null) return err("bad_token");
  return optionalCount(nested["ephemeral_1h_input_tokens"], sanitizeTokens);
}

function readClaudeTokens(usage: Row): Result<TokenRecord, "bad_token"> {
  const input = sanitizeTokens(usage["input_tokens"]);
  if (!input.ok) return input;
  const output = sanitizeTokens(usage["output_tokens"]);
  if (!output.ok) return output;
  const created = optionalCount(usage["cache_creation_input_tokens"], sanitizeTokens);
  if (!created.ok) return created;
  const cacheRead = optionalCount(usage["cache_read_input_tokens"], sanitizeTokens);
  if (!cacheRead.ok) return cacheRead;
  const oneHour = readOneHourWrite(usage["cache_creation"]);
  if (!oneHour.ok) return oneHour;
  return ok({
    input: input.value,
    cacheWrite5m: Math.max(0, created.value - oneHour.value),
    cacheWrite1h: oneHour.value,
    cacheRead: cacheRead.value,
    output: output.value,
  });
}

// `nowMs` is injected so tests control the clock.
export function parseClaudeRow(row: Row, nowMs: number): Result<ClaudeEntry, SkipReason> {
  if (row["type"] !== "assistant") return err("not_assistant");
  if (row["isApiErrorMessage"] === true) return err("api_error");
  const message = asRow(row["message"]);
  if (message === null) return err("no_usage");
  if (message["model"] === "<synthetic>") return err("synthetic");
  const usage = asRow(message["usage"]);
  if (usage === null) return err("no_usage");

  const messageId = readId(message["id"]);
  const requestId = readId(row["requestId"]);
  if (messageId === null || requestId === CODEX_PROXY_KEY_TAG) return err("missing_id");
  const model = sanitizeModel(message["model"]);
  const proxy = row["requestId"] === undefined && messageId.startsWith("resp_") && model.startsWith("gpt-");
  const suffix = proxy ? CODEX_PROXY_KEY_TAG : requestId;
  if (suffix === null) return err("missing_id");
  const at = sanitizeTime(row["timestamp"], nowMs);
  if (!at.ok) return at;
  const tokens = readClaudeTokens(usage);
  if (!tokens.ok) return tokens;

  return ok({
    key: `${messageId}${CLAUDE_KEY_SEPARATOR}${suffix}`,
    at: at.value,
    model,
    folderKey: folderOf(row["cwd"]),
    tokens: tokens.value,
  });
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

export type QuotaWindow = "five_hour" | "week";

export interface CodexQuotaSample {
  readonly window: QuotaWindow;
  // Event time and reset time, epoch milliseconds.
  readonly at: number;
  readonly usedPercent: number;
  readonly resetsAt: number;
  readonly reached: boolean;
}

export interface CodexEntry {
  // Dedupe key, or null when the event has no total_token_usage.
  readonly key: string | null;
  readonly at: number;
  readonly model: string;
  readonly folderKey: string;
  readonly tokens: TokenRecord;
  // True when the event held a cache write count that was not valid. It counted as 0.
  readonly cacheInvalid: boolean;
}

// Small per-file state. The caller threads it through the rows of one file.
export interface CodexFileState {
  // True after the first session_meta, so a later one changes nothing.
  readonly metaSeen: boolean;
  readonly sessionId: string | null;
  readonly folderKey: string;
  // Model of the latest turn_context, else "other".
  readonly model: string;
  // Identity of the previous counted event, to skip a direct repeat.
  readonly previous: string | null;
}

export const CODEX_INITIAL_STATE: CodexFileState = {
  metaSeen: false,
  sessionId: null,
  folderKey: UNKNOWN_FOLDER,
  model: "other",
  previous: null,
};

export interface CodexStep {
  readonly state: CodexFileState;
  readonly entry: CodexEntry | null;
  readonly quota: readonly CodexQuotaSample[];
  readonly skips: readonly SkipReason[];
}

interface UsageFields {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
  readonly reasoning: number;
  readonly total: number;
}

// sha256 as hex, cut to 32 characters (128 bits). The cut is part of the stored
// key format: a change makes every stored Codex key stale.
const KEY_HEX_CHARS = 32;
const HASH_SEPARATOR = "|";
const KEY_TAG = "k";
const IDENTITY_TAG = "f";

const FIVE_HOUR_MINUTES = 300;
const WEEK_MINUTES = 10080;
const QUOTA_SLOTS = ["primary", "secondary"] as const;

// A running total in a long session can pass the per-event cap.
function cumulativeCount(value: unknown): Result<number, "bad_token"> {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? ok(value) : err("bad_token");
}

function readUsage(usage: Row, read: CountReader): Result<UsageFields, "bad_token"> {
  const input = read(usage["input_tokens"]);
  if (!input.ok) return input;
  const output = read(usage["output_tokens"]);
  if (!output.ok) return output;
  const cached = optionalCount(usage["cached_input_tokens"], read);
  if (!cached.ok) return cached;
  const reasoning = optionalCount(usage["reasoning_output_tokens"], read);
  if (!reasoning.ok) return reasoning;
  const total = optionalCount(usage["total_tokens"], read);
  if (!total.ok) return total;
  return ok({
    input: input.value,
    cached: cached.value,
    output: output.value,
    reasoning: reasoning.value,
    total: total.value,
  });
}

// An absent total gives null. A present total that is not valid gives an error.
function readTotal(value: unknown): Result<UsageFields | null, "bad_token"> {
  if (value === undefined || value === null) return ok(null);
  const usage = asRow(value);
  if (usage === null) return err("bad_token");
  return readUsage(usage, cumulativeCount);
}

function fieldsText(usage: UsageFields): string {
  return `${usage.input},${usage.cached},${usage.output},${usage.reasoning},${usage.total}`;
}

interface CacheWrite {
  readonly count: number;
  readonly invalid: boolean;
}

// An absent or null count is 0. A count that is not valid is also 0, but flagged:
// the event stays, because the rest of its usage is good.
function readCacheWrite(usage: Row): CacheWrite {
  const read = optionalCount(usage["cache_write_input_tokens"], sanitizeTokens);
  return read.ok ? { count: read.value, invalid: false } : { count: 0, invalid: true };
}

function digest(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join(HASH_SEPARATOR), "utf8").digest("hex").slice(0, KEY_HEX_CHARS);
}

function quietStep(state: CodexFileState, skips: readonly SkipReason[] = []): CodexStep {
  return { state, entry: null, quota: [], skips };
}

// --- quota ---

interface QuotaRead {
  readonly samples: readonly CodexQuotaSample[];
  readonly skips: readonly SkipReason[];
}

function windowOf(minutes: unknown): QuotaWindow | null {
  if (minutes === FIVE_HOUR_MINUTES) return "five_hour";
  if (minutes === WEEK_MINUTES) return "week";
  return null;
}

function readWindow(
  window: Row,
  at: number,
  reached: boolean,
): Result<CodexQuotaSample, "bad_window" | "bad_percent" | "bad_reset"> {
  const name = windowOf(window["window_minutes"]);
  if (name === null) return err("bad_window");
  const point = quotaPoint(window["used_percent"], window["resets_at"], at);
  if (!point.ok) return point;
  return ok({ window: name, at, ...point.value, reached });
}

function readQuota(value: unknown, at: number): QuotaRead {
  const limits = asRow(value);
  if (limits === null) return { samples: [], skips: [] };
  const limitId = limits["limit_id"];
  if (limitId !== undefined && limitId !== null && limitId !== "codex") {
    return { samples: [], skips: ["other_limit"] };
  }
  const reachedType = limits["rate_limit_reached_type"];
  const reached = typeof reachedType === "string" && reachedType.length > 0;
  const samples: CodexQuotaSample[] = [];
  const skips: SkipReason[] = [];
  for (const slot of QUOTA_SLOTS) {
    const window = asRow(limits[slot]);
    if (window === null) continue;
    const sample = readWindow(window, at, reached);
    if (sample.ok) {
      samples.push(sample.value);
    } else {
      skips.push(sample.error);
    }
  }
  return { samples, skips };
}

// --- rows ---

function readSessionMeta(state: CodexFileState, payload: Row | null): CodexStep {
  if (state.metaSeen) return quietStep(state);
  const sessionId = readId(payload?.["session_id"]) ?? readId(payload?.["id"]);
  return quietStep({ ...state, metaSeen: true, sessionId, folderKey: folderOf(payload?.["cwd"]) });
}

function readTurnContext(state: CodexFileState, payload: Row | null): CodexStep {
  return quietStep({ ...state, model: sanitizeModel(payload?.["model"]) });
}

function readTokenCount(state: CodexFileState, row: Row, payload: Row, nowMs: number): CodexStep {
  const at = sanitizeTime(row["timestamp"], nowMs);
  if (!at.ok) return quietStep(state, ["bad_time"]);
  const quota = readQuota(payload["rate_limits"], at.value);
  const withQuota = (skip: SkipReason): CodexStep => ({
    state,
    entry: null,
    quota: quota.samples,
    skips: [skip, ...quota.skips],
  });

  const info = asRow(payload["info"]);
  const lastRow = asRow(info?.["last_token_usage"]);
  if (info === null || lastRow === null) return withQuota("no_usage");
  const last = readUsage(lastRow, sanitizeTokens);
  if (!last.ok) return withQuota(last.error);
  const total = readTotal(info["total_token_usage"]);
  if (!total.ok) return withQuota(total.error);

  // The key has no session id and no time, so a copied event in a child file
  // gets the key of its source. Without a total, the time joins the identity.
  const key =
    total.value === null
      ? null
      : digest([KEY_TAG, state.model, fieldsText(last.value), fieldsText(total.value)]);
  const identity = key ?? digest([IDENTITY_TAG, String(at.value), state.model, fieldsText(last.value)]);
  if (state.previous === identity) return quietStep(state, ["repeat_event"]);

  // The cache write is a part of the input, as the cached input is. It moves to the
  // 5 minute column and never more than the input holds, so the raw total stays.
  const cacheWrite = readCacheWrite(lastRow);
  const uncached = Math.max(0, last.value.input - last.value.cached);
  const written = Math.min(cacheWrite.count, uncached);
  const entry: CodexEntry = {
    key,
    at: at.value,
    model: state.model,
    folderKey: state.folderKey,
    tokens: {
      input: uncached - written,
      cacheWrite5m: written,
      cacheWrite1h: 0,
      cacheRead: last.value.cached,
      output: last.value.output,
    },
    cacheInvalid: cacheWrite.invalid,
  };
  return { state: { ...state, previous: identity }, entry, quota: quota.samples, skips: quota.skips };
}

// Reads one row and returns the next file state with what the row gave.
// The state and the row are not changed.
export function stepCodexRow(state: CodexFileState, row: Row, nowMs: number): CodexStep {
  const payload = asRow(row["payload"]);
  const type = row["type"];
  if (type === "session_meta") return readSessionMeta(state, payload);
  if (type === "turn_context") return readTurnContext(state, payload);
  if (type === "event_msg" && payload !== null && payload["type"] === "token_count") {
    return readTokenCount(state, row, payload, nowMs);
  }
  return quietStep(state, ["ignored_type"]);
}
