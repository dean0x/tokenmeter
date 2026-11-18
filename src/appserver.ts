import { createRequire } from "node:module";
import { asRow, err, ok, parseJson, quotaPoint, type Result } from "./core.ts";
import type { CodexQuotaSample } from "./sources.ts";
import { checkCodexVersion, runCodex, type CodexRunError, type CodexRunOptions, type ResolvedCodex } from "./spawn.ts";

const DEADLINE_MS = 5_000;
const RESET_SLACK_MS = 300_000;
const INITIALIZE_ID = 1;
const LIMITS_ID = 2;

// Load the package version without an experimental JSON module warning on Node 22.0.
const metadata: unknown = createRequire(import.meta.url)("../package.json");
const packageVersion = asRow(metadata)?.["version"];

// Codex uses one JSON message per line and omits the JSON-RPC version marker.
const READ_LIMITS = '{"method":"initialized"}\n'
  + JSON.stringify({ id: LIMITS_ID, method: "account/rateLimits/read" }) + "\n";

export type AppServerError = "auth" | "missing" | "old" | "shape" | "timeout" | "error";
type AppServerOptions = Omit<CodexRunOptions, "timeoutMs"> & { readonly now?: () => number };
type Reading = readonly CodexQuotaSample[];
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

export async function readAppServerLimits(
  codex: ResolvedCodex | null,
  options: AppServerOptions,
): Promise<Result<Reading, AppServerError>> {
  if (codex === null) return err("missing");
  if (typeof packageVersion !== "string" || packageVersion.length === 0) return err("error");
  const deadline = performance.now() + DEADLINE_MS;
  const { now = Date.now, ...runOptions } = options;
  const version = await checkCodexVersion(codex, runOptions);
  if (!version.ok) return err(outcome(version.error));

  const timeoutMs = Math.floor(deadline - performance.now());
  if (timeoutMs <= 0) return err("timeout");
  let expectedId: typeof INITIALIZE_ID | typeof LIMITS_ID = INITIALIZE_ID;
  const result = await runCodex<Reading, AppServerError>(codex, ["app-server"], { ...runOptions, timeoutMs }, {
    initialInput: JSON.stringify({
      id: INITIALIZE_ID, method: "initialize", params: { clientInfo: { name: "tokenmeter", version: packageVersion } },
    }) + "\n",
    onLine: (line, send) => {
      const parsed = parseJson(line);
      const row = parsed.ok ? asRow(parsed.value) : null;
      if (row === null) return err("shape");
      if ("method" in row || row["id"] !== expectedId) return;
      if ("jsonrpc" in row && row["jsonrpc"] !== "2.0") return err("shape");
      if ("error" in row) {
        const code = asRow(row["error"])?.["code"];
        if ("result" in row || typeof code !== "number" || !Number.isSafeInteger(code)) return err("shape");
        return err(code === -32600 ? "auth" : "error");
      }
      const body = asRow(row["result"]);
      if (body === null) return err("shape");
      if (expectedId === LIMITS_ID) return reading(body, now());
      expectedId = LIMITS_ID;
      return send(READ_LIMITS) ? undefined : err("error");
    },
    onExit: () => err("error"),
  });
  return result.ok ? result : err(outcome(result.error));
}
