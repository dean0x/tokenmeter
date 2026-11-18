// Tests for the pool setting that comes from the environment (T3).
//
// The setting is parsed at the boundary: a bad value never throws and never
// reaches the output as text. It gives the separate mode and a fixed reason code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFromEnv } from "../src/pool.ts";
import { installSuiteGuard } from "./helpers.ts";

installSuiteGuard();

const SEPARATE = { mode: "separate", reason: null } as const;

function env(mode: string | undefined, weights?: string): Record<string, string | undefined> {
  return { TOKENMETER_POOL: mode, TOKENMETER_POOL_WEIGHTS: weights };
}

test("pool: no setting, an empty one, or separate gives the separate mode with no reason", () => {
  assert.deepEqual(poolFromEnv({}), SEPARATE);
  assert.deepEqual(poolFromEnv(env("")), SEPARATE);
  assert.deepEqual(poolFromEnv(env("separate")), SEPARATE);
  assert.deepEqual(poolFromEnv(env(" Separate ")), SEPARATE);
});

test("pool: weights are not read in the separate mode", () => {
  assert.deepEqual(poolFromEnv(env("separate", "garbage")), SEPARATE);
  assert.deepEqual(poolFromEnv(env(undefined, "claude=1,codex=1")), SEPARATE);
});

test("pool: combined with a weight for each subscription gives the weights", () => {
  assert.deepEqual(poolFromEnv(env("combined", "claude=1,codex=0.5")), {
    mode: "combined",
    weights: { claude: 1, codex: 0.5 },
  });
  assert.deepEqual(poolFromEnv(env("COMBINED", "codex=.25, claude = 0.75 ")), {
    mode: "combined",
    weights: { claude: 0.75, codex: 0.25 },
  });
  // The limits of the range (0, 1].
  assert.deepEqual(poolFromEnv(env("combined", "claude=0.000001,codex=1")), {
    mode: "combined",
    weights: { claude: 0.000001, codex: 1 },
  });
});

test("pool: combined with no weights falls back to separate with pool_weights_missing", () => {
  const missing = { mode: "separate", reason: "pool_weights_missing" };
  assert.deepEqual(poolFromEnv(env("combined")), missing);
  assert.deepEqual(poolFromEnv(env("combined", "")), missing);
  assert.deepEqual(poolFromEnv(env("combined", "   ")), missing);
});

test("pool: combined with bad weights falls back to separate with pool_weights_bad", () => {
  const bad = [
    "claude=1",
    "codex=1",
    "claude=1,codex=0",
    "claude=0,codex=1",
    "claude=1,codex=1.0000001",
    "claude=2,codex=1",
    "claude=-1,codex=1",
    "claude=1,codex=x",
    "claude=1,codex=",
    "claude=1,codex",
    "claude=1,claude=1",
    "claude=1,gpt=1",
    "claude=1,codex=1,extra=1",
    "1,1",
    "claude==1,codex=1",
    "claude=1;codex=1",
    "claude=1e0,codex=1",
    "claude=NaN,codex=1",
    "claude=Infinity,codex=1",
    "claude=0x1,codex=1",
    "claude=1,codex=1,",
    `claude=1,codex=${"1".repeat(500)}`,
  ];
  for (const weights of bad) {
    assert.deepEqual(poolFromEnv(env("combined", weights)), { mode: "separate", reason: "pool_weights_bad" }, weights);
  }
});

// The cap of src/pool.ts. The texts below are valid in every way except their length.
const MAX_WEIGHTS_CHARS = 100;

// Both weights are 1 and the spaces between the entries are allowed, so only the length changes.
function weightsOfLength(length: number): string {
  const head = "claude=1,";
  const tail = "codex=1";
  return head + " ".repeat(length - head.length - tail.length) + tail;
}

test("pool: a weights text of 100 characters is read, and one of 101 characters is refused for its length alone", () => {
  assert.deepEqual(poolFromEnv(env("combined", weightsOfLength(MAX_WEIGHTS_CHARS))), {
    mode: "combined",
    weights: { claude: 1, codex: 1 },
  });
  assert.deepEqual(poolFromEnv(env("combined", weightsOfLength(MAX_WEIGHTS_CHARS + 1))), {
    mode: "separate",
    reason: "pool_weights_bad",
  });
});

test("pool: a long weights text that is valid in every other way is refused for its length", () => {
  const bad = { mode: "separate", reason: "pool_weights_bad" };
  // A weight with 120 digits is in the range (0, 1].
  assert.deepEqual(poolFromEnv(env("combined", `claude=0.${"5".repeat(120)},codex=1`)), bad);
  assert.deepEqual(poolFromEnv(env("combined", weightsOfLength(1000))), bad);
});

test("pool: an unknown mode falls back to separate with pool_mode_bad", () => {
  assert.deepEqual(poolFromEnv(env("joint", "claude=1,codex=1")), { mode: "separate", reason: "pool_mode_bad" });
  assert.deepEqual(poolFromEnv(env("combined,separate")), { mode: "separate", reason: "pool_mode_bad" });
});
