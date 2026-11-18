// The pool setting (T3). Two subscriptions can be read as one pool: the weekly
// limit that counts is then the weighted sum of both.
//
//   TOKENMETER_POOL          separate (the default) or combined
//   TOKENMETER_POOL_WEIGHTS  claude=<w>,codex=<w>, each w a number in (0, 1]
//
// The setting is parsed here, at the boundary. A combined pool with no weights
// or bad weights falls back to separate, and the reason is a fixed code for the
// doctor. No text of the environment reaches the output.

export type PoolReason = "pool_mode_bad" | "pool_weights_missing" | "pool_weights_bad";

export interface PoolWeights {
  readonly claude: number;
  readonly codex: number;
}

export type PoolConfig =
  | { readonly mode: "separate"; readonly reason: PoolReason | null }
  | { readonly mode: "combined"; readonly weights: PoolWeights };

export const SEPARATE_POOL: PoolConfig = { mode: "separate", reason: null };

const MODE_VARIABLE = "TOKENMETER_POOL";
const WEIGHTS_VARIABLE = "TOKENMETER_POOL_WEIGHTS";
// Two short entries need far less than this.
const MAX_WEIGHTS_CHARS = 100;
const WEIGHT_ENTRIES = 2;
const DECIMAL = /^(?:\d+(?:\.\d+)?|\.\d+)$/;

function separateWith(reason: PoolReason): PoolConfig {
  return { mode: "separate", reason };
}

// A plain decimal number above 0 and up to 1. No sign, no exponent, no hex.
function parseWeight(text: string): number | null {
  if (!DECIMAL.test(text)) return null;
  const weight = Number(text);
  return weight > 0 && weight <= 1 ? weight : null;
}

// Exactly one entry for claude and one for codex, in any order.
function parseWeights(text: string): PoolWeights | null {
  if (text.length > MAX_WEIGHTS_CHARS) return null;
  const entries = text.split(",");
  if (entries.length !== WEIGHT_ENTRIES) return null;
  const found = new Map<string, number>();
  for (const entry of entries) {
    const [name, value, ...rest] = entry.split("=");
    if (name === undefined || value === undefined || rest.length > 0) return null;
    const key = name.trim();
    const weight = parseWeight(value.trim());
    if ((key !== "claude" && key !== "codex") || weight === null || found.has(key)) return null;
    found.set(key, weight);
  }
  const claude = found.get("claude");
  const codex = found.get("codex");
  return claude === undefined || codex === undefined ? null : { claude, codex };
}

export function poolFromEnv(env: Readonly<Record<string, string | undefined>>): PoolConfig {
  const mode = (env[MODE_VARIABLE] ?? "").trim().toLowerCase();
  if (mode === "" || mode === "separate") return SEPARATE_POOL;
  if (mode !== "combined") return separateWith("pool_mode_bad");
  const text = (env[WEIGHTS_VARIABLE] ?? "").trim();
  if (text === "") return separateWith("pool_weights_missing");
  const weights = parseWeights(text);
  return weights === null ? separateWith("pool_weights_bad") : { mode: "combined", weights };
}
