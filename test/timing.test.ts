import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_RATIO_TO_BASELINE, NOISE_MS, judgeTiming, median } from "./timing.ts";

const quietBaseline = Array.from({ length: 20 }, (_, i) => 40 + (i % 5));
const quietCommand = Array.from({ length: 20 }, (_, i) => 65 + (i % 7));

test("median: odd, even and empty lists", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), Number.POSITIVE_INFINITY);
});

test("judgeTiming: a quiet machine passes", () => {
  assert.equal(judgeTiming(quietCommand, quietBaseline).ok, true);
});

test("judgeTiming: load that slows every start five times still passes", () => {
  const verdict = judgeTiming(
    quietCommand.map((ms) => ms * 5),
    quietBaseline.map((ms) => ms * 5),
  );
  assert.equal(verdict.ok, true, verdict.detail);
});

test("judgeTiming: a few slow outliers do not move the median", () => {
  const command = quietCommand.map((ms, i) => (i < 4 ? 900 : ms));
  assert.equal(judgeTiming(command, quietBaseline).ok, true);
});

test("judgeTiming: 200 ms of extra work in the command fails", () => {
  const verdict = judgeTiming(
    quietCommand.map((ms) => ms + 200),
    quietBaseline,
  );
  assert.equal(verdict.ok, false, verdict.detail);
});

test("judgeTiming: a command just over the limit fails, one at the limit passes", () => {
  const limit = MAX_RATIO_TO_BASELINE * 40 + NOISE_MS;
  const baseline = Array.from({ length: 20 }, () => 40);
  assert.equal(judgeTiming(Array.from({ length: 20 }, () => limit), baseline).ok, true);
  assert.equal(judgeTiming(Array.from({ length: 20 }, () => limit + 1), baseline).ok, false);
});

test("judgeTiming: missing or unequal samples fail", () => {
  assert.equal(judgeTiming([], []).ok, false);
  assert.equal(judgeTiming([60, 61], [40]).ok, false);
});
