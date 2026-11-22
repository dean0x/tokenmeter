import { createRequire } from "node:module";
import { replyRows, type AccountRow, type UsageError } from "./account-usage.ts";
import { asRow, err, ok, parseJson, quotaPoint, type Result } from "./core.ts";
import type { CodexQuotaSample } from "./sources.ts";
import { checkCodexVersion, runCodex, type CodexExchange, type CodexRunError, type CodexRunOptions, type ResolvedCodex } from "./spawn.ts";

const DEADLINE_MS = 5_000;
const RESET_SLACK_MS = 300_000;
const INITIALIZE_ID = 1;
const LIMITS_ID = 2;
const USAGE_ID = 3;

// Load the package version without an experimental JSON module warning on Node 22.0.
const metadata: unknown = createRequire(import.meta.url)("../package.json");
const packageVersion = asRow(metadata)?.["version"];

// Codex uses one JSON message per line and omits the JSON-RPC version marker.
const READ_LIMITS = '{"method":"initialized"}\n'
  + JSON.stringify({ id: LIMITS_ID, method: "account/rateLimits/read" }) + "\n";
const READ_USAGE = JSON.stringify({ id: USAGE_ID, method: "account/usage/read" }) + "\n";

export type AppServerError = "auth" | "missing" | "old" | "shape" | "timeout" | "error";
type AppServerOptions = Omit<CodexRunOptions, "timeoutMs"> & {
  readonly now?: () => number;
  readonly usage?: boolean;
};
type Reading = readonly CodexQuotaSample[];
interface AppServerReading {
  readonly limits: Reading;
  readonly usage: Result<readonly AccountRow[], UsageError> | null;
}
type Session =
  | { readonly id: typeof INITIALIZE_ID | typeof LIMITS_ID }
  | { readonly id: typeof USAGE_ID; readonly limits: Reading };
type Row = Readonly<Record<string, unknown>>;

function outcome(error: AppServerError | CodexRunError): AppServerError {
  return error === "aborted" || error === "output_limit" ? "error" : error;
}

function sample(value: unknown, at: number, reached: boolean): CodexQuotaSample | null {
  const row = asRow(value);
  if (row === null) return null;
  const mins = row["windowDurationMins"];
  if (mins !== 300 && mins !== 10_080) return null;
  const point = quotaPoint(row["usedPercent"], row["resetsAt"], at);
  if (!point.ok || point.value.resetsAt > at + mins * 60_000 + RESET_SLACK_MS) return null;
  return { ...point.value, window: mins === 300 ? "five_hour" : "week", at, reached };
}

function reading(result: Row, at: number): Result<Reading, "shape"> {
  const limits = asRow(result["rateLimits"]);
  if (limits === null || ("limitId" in limits && limits["limitId"] !== "codex")) return err("shape");
  const reachedType = limits["rateLimitReachedType"];
  const reached = typeof reachedType === "string" && reachedType.length > 0;
  const samples = [sample(limits["primary"], at, reached), sample(limits["secondary"], at, reached)]
    .filter((item) => item !== null);
  return samples.length > 0 ? ok(samples) : err("shape");
}

function rpcReply(row: Row): Result<Row, number | "shape"> {
  if ("jsonrpc" in row && row["jsonrpc"] !== "2.0") return err("shape");
  if ("error" in row) {
    const code = asRow(row["error"])?.["code"];
    if ("result" in row || typeof code !== "number" || !Number.isSafeInteger(code)) return err("shape");
    return err(code);
  }
  const body = asRow(row["result"]);
  return body === null ? err("shape") : ok(body);
}

function usageReplyError(code: number | "shape"): UsageError {
  if (code === "shape") return code;
  return code === -32601 ? "unsupported" : "error";
}

function accountExchange({ now = Date.now, usage, mayStart }: AppServerOptions): CodexExchange<AppServerReading, AppServerError> {
  let session: Session = { id: INITIALIZE_ID };
  const keepLimits = (error: UsageError) => session.id === USAGE_ID
    ? ok({ limits: session.limits, usage: err(error) }) : undefined;
  return {
    initialInput: JSON.stringify({
      id: INITIALIZE_ID, method: "initialize", params: { clientInfo: { name: "tokenmeter", version: packageVersion } },
    }) + "\n",
    onLine: (line, send) => {
      const parsed = parseJson(line);
      const row = parsed.ok ? asRow(parsed.value) : null;
      if (row === null) return keepLimits("shape") ?? err("shape");
      if ("method" in row || row["id"] !== session.id) return;
      const body = rpcReply(row);
      if (session.id === USAGE_ID) {
        const account = body.ok ? replyRows(body.value, now()) : err(usageReplyError(body.error));
        return ok({ limits: session.limits, usage: account });
      }
      if (!body.ok) {
        if (body.error === "shape") return err("shape");
        return err(body.error === -32600 ? "auth" : "error");
      }
      if (session.id === INITIALIZE_ID) {
        if (mayStart?.() === false) return err("error");
        session = { id: LIMITS_ID };
        return send(READ_LIMITS) ? undefined : err("error");
      }
      const limits = reading(body.value, now());
      if (!limits.ok) return limits;
      if (!usage || mayStart?.() === false) return ok({ limits: limits.value, usage: null });
      session = { id: USAGE_ID, limits: limits.value };
      return send(READ_USAGE) ? undefined : keepLimits("error");
    },
    onExit: () => keepLimits("error") ?? err("error"),
    onStop: (reason) => {
      if (reason === "output_limit") return keepLimits("too_large");
      return keepLimits(reason === "timeout" ? "timeout" : "error");
    },
  };
}

export async function readAppServerLimits(
  codex: ResolvedCodex | null,
  options: AppServerOptions,
): Promise<Result<AppServerReading, AppServerError>> {
  if (codex === null) return err("missing");
  if (typeof packageVersion !== "string" || packageVersion.length === 0) return err("error");
  const deadline = performance.now() + DEADLINE_MS;
  const version = await checkCodexVersion(codex, options);
  if (!version.ok) return err(outcome(version.error));
  const timeoutMs = Math.floor(deadline - performance.now());
  if (timeoutMs <= 0) return err("timeout");
  const result = await runCodex(codex, ["app-server"], { ...options, timeoutMs }, accountExchange(options));
  return result.ok ? result : err(outcome(result.error));
}
