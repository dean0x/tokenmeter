// Tests for the task windows, the attribution, the freeze, the week shares and
// the open-item estimates (plan 3.7, B3, B1, step 7). TP-6, TP-7 and the tasks
// part of TP-17.
//
// The clock is an injected number. Data folders and writes are inside a sandbox.
// File checks read the bytes of the store files.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  FEATURE_NAME_MAX,
  MAX_FEATURES,
  MAX_TAGS,
  SLOT_MS,
  SYNC_MAX_BYTES,
  SYNC_MAX_OPEN_ITEMS,
  SYNC_MAX_WINDOWS,
  TASK_HISTORY_MAX,
  type Result,
  type TokenRecord,
  errorRecord,
  isFeatureName,
  isLabel,
  sanitizeFeature,
  weighted,
} from "../src/core.ts";
import {
  type BucketRow,
  CALIBRATION_LABEL,
  type Calibration,
  NOT_READY_LABEL,
  type PeriodName,
  type PeriodSlots,
  type SlotRange,
} from "../src/analysis.ts";
import { type SignalEstimate, estimateFromSignals } from "../src/estimator.ts";
import { FILE_CAPS, type Provider, bucketKey, isCount, slotOf } from "../src/store.ts";
import {
  type Features,
  type OpenItem,
  SHARE_NOT_READY_LABEL,
  TASK_HISTORY_FILE,
  TASK_WINDOWS_FILE,
  type Tags,
  type TaskEntry,
  type TaskWindow,
  attribute,
  collisionWarning,
  freezeDue,
  freezeTasks,
  loadTaskHistory,
  loadTaskWindows,
  parseEstimateInput,
  parseSyncInput,
  sync,
  taskShares,
} from "../src/tasks.ts";
import { installSuiteGuard, makeSandbox } from "./helpers.ts";

installSuiteGuard();

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-05T12:00:00Z");
const T8 = Date.parse("2026-11-05T08:00:00Z");
const ZERO: TokenRecord = { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function must<T, E>(result: Result<T, E>): T {
  assert.ok(result.ok, "the result is an error");
  return result.value;
}

function code<T, E extends { readonly code: string }>(result: Result<T, E>): string | null {
  return result.ok ? null : result.error.code;
}

// ---------------------------------------------------------------------------
// Sync input
// ---------------------------------------------------------------------------

function win(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    label: "B-1",
    start: iso(T8),
    end: iso(T8 + HOUR),
    match: { folders: ["/work/proj"] },
    tags: { type: "feature" },
    ...over,
  };
}

function input(windows: unknown[], open: unknown[] = []): string {
  return JSON.stringify({ windows, open });
}

test("a valid sync input is parsed: folder keys, times in milliseconds, tags and open items", () => {
  const parsed = must(
    parseSyncInput(
      input([win(), win({ label: "B-2", end: undefined })], [{ key: "B-9", tags: { type: "bug", area: "ui" } }]),
      NOW,
    ),
  );
  assert.equal(parsed.windows.length, 2);
  assert.deepEqual(parsed.windows[0], {
    label: "B-1",
    start: T8,
    end: T8 + HOUR,
    folderKeys: ["-work-proj"],
    tags: { type: "feature" },
    features: {},
  });
  assert.equal(parsed.windows[1]?.end, null);
  assert.deepEqual(parsed.open, [openItem("B-9", { type: "bug", area: "ui" })]);
  assert.deepEqual(parsed.refused, { windows: 0, open: 0, features: 0 });
});

test("TP-17: a label, key, tag key or tag value with other characters is refused and counted, the rest is kept", () => {
  const bad = ["has space", "a/b", "é", "x;y", "a".repeat(65), "", "new\nline", "`tick`", "a\u0000b", "{{x}}"];
  for (const text of bad) {
    const parsed = must(
      parseSyncInput(
        input(
          [
            win({ label: text }),
            win({ label: "B-2", tags: { [text]: "v" } }),
            win({ label: "B-3", tags: { type: text } }),
            win({ label: "B-4" }),
          ],
          [
            { key: text, tags: {} },
            { key: "B-5", tags: { type: text } },
            { key: "B-6", tags: { [text]: "v" } },
            { key: "B-7", tags: { type: "bug" } },
          ],
        ),
        NOW,
      ),
    );
    assert.deepEqual(
      parsed.windows.map((w) => w.label),
      ["B-4"],
      JSON.stringify(text),
    );
    assert.deepEqual(
      parsed.open.map((o) => o.key),
      ["B-7"],
      JSON.stringify(text),
    );
    assert.deepEqual(parsed.refused, { windows: 3, open: 3, features: 0 }, JSON.stringify(text));
    if (text !== "") assert.ok(!JSON.stringify(parsed).includes(text), "refused text appears in the result");
  }
});

test("a label made of the allowed characters at the length limit is accepted", () => {
  const label = "A.b_c:d-".repeat(8);
  assert.equal(label.length, 64);
  const parsed = must(parseSyncInput(input([win({ label })]), NOW));
  assert.equal(parsed.windows[0]?.label, label);
});

test("at most 8 tags: 8 pass, 9 refuse the entry", () => {
  const tags = (n: number): Record<string, string> => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, "v"]));
  assert.equal(MAX_TAGS, 8);
  const parsed = must(parseSyncInput(input([win({ tags: tags(8) }), win({ label: "B-2", tags: tags(9) })]), NOW));
  assert.deepEqual(parsed.windows.map((w) => w.label), ["B-1"]);
  assert.equal(parsed.refused.windows, 1);
});

test("a tag key named __proto__ is kept as data and does not change any prototype", () => {
  const text = `{"windows":[{"label":"B-1","start":"${iso(T8)}","match":{"folders":["/w"]},"tags":{"__proto__":"x","type":"bug"}}],"open":[]}`;
  const parsed = must(parseSyncInput(text, NOW));
  const tags = parsed.windows[0]?.tags;
  assert.ok(tags !== undefined);
  assert.equal(Object.getPrototypeOf(tags), Object.prototype);
  assert.equal(Object.hasOwn(tags, "__proto__"), true);
  assert.equal(({} as Record<string, unknown>)["x"], undefined);
});

test("folders must be absolute; they become keys and no path stays in the result", () => {
  const parsed = must(
    parseSyncInput(
      input([
        win({ label: "B-1", match: { folders: ["/work/proj", "/work/proj/", "/a/x/../b"] } }),
        win({ label: "B-2", match: { folders: ["work/proj"] } }),
        win({ label: "B-3", match: { folders: [] } }),
        win({ label: "B-4", match: { folders: ["/"] } }),
        win({ label: "B-5", match: { folders: [42] } }),
        win({ label: "B-6", match: {} }),
        win({ label: "B-7", match: { folders: ["/x".repeat(2100)] } }),
        win({ label: "B-8", match: { folders: Array.from({ length: 17 }, (_, i) => `/f${i}`) } }),
      ]),
      NOW,
    ),
  );
  assert.deepEqual(parsed.windows.map((w) => w.label), ["B-1"]);
  assert.deepEqual(parsed.windows[0]?.folderKeys, ["-work-proj", "-a-b"]);
  assert.equal(parsed.refused.windows, 7);
  assert.ok(!JSON.stringify(parsed).includes("/work"), "a path stays in the result");
});

test("times: an invalid, future or reversed time refuses the window; no end means open", () => {
  const parsed = must(
    parseSyncInput(
      input([
        win({ label: "B-1", start: "yesterday" }),
        win({ label: "B-2", start: iso(NOW + 5 * 60_000) }),
        win({ label: "B-3", end: iso(T8) }),
        win({ label: "B-4", end: iso(T8 - HOUR) }),
        win({ label: "B-5", start: 1_700_000_000_000 }),
        win({ label: "B-6", end: null }),
        win({ label: "B-7", end: "nope" }),
      ]),
      NOW,
    ),
  );
  assert.deepEqual(parsed.windows.map((w) => w.label), ["B-6"]);
  assert.equal(parsed.windows[0]?.end, null);
  assert.equal(parsed.refused.windows, 6);
});

test("a repeated window (same label and start) or open key is refused; a reopened item with a new start is kept", () => {
  const parsed = must(
    parseSyncInput(
      input(
        [win(), win({ end: iso(T8 + 2 * HOUR) }), win({ start: iso(T8 + 3 * HOUR), end: undefined })],
        [
          { key: "B-9", tags: {} },
          { key: "B-9", tags: { type: "bug" } },
        ],
      ),
      NOW,
    ),
  );
  assert.equal(parsed.windows.length, 2);
  assert.deepEqual(parsed.refused, { windows: 1, open: 1, features: 0 });
  assert.deepEqual(parsed.open, [openItem("B-9")]);
});

test("a bad envelope gives usage_error with the fixed hint and no input text", () => {
  const marker = "canary-7f3a";
  const cases: string[] = [
    "{not json",
    "[]",
    "null",
    `"${marker}"`,
    JSON.stringify({ windows: marker, open: [] }),
    JSON.stringify({ windows: [], open: { marker } }),
    " ".repeat(SYNC_MAX_BYTES + 1),
    input(Array.from({ length: SYNC_MAX_WINDOWS + 1 }, (_, i) => win({ label: `B-${i}` }))),
    input([], Array.from({ length: SYNC_MAX_OPEN_ITEMS + 1 }, (_, i) => ({ key: `B-${i}`, tags: {} }))),
  ];
  for (const text of cases) {
    const result = parseSyncInput(text, NOW);
    assert.equal(JSON.stringify(result), JSON.stringify({ ok: false, error: errorRecord("usage_error") }));
    assert.ok(!JSON.stringify(result).includes(marker));
  }
});

test("the count limits are inclusive: 500 windows and 500 open items pass", () => {
  const parsed = must(
    parseSyncInput(
      input(
        Array.from({ length: SYNC_MAX_WINDOWS }, (_, i) => win({ label: `B-${i}` })),
        Array.from({ length: SYNC_MAX_OPEN_ITEMS }, (_, i) => ({ key: `B-${i}`, tags: {} })),
      ),
      NOW,
    ),
  );
  assert.equal(parsed.windows.length, SYNC_MAX_WINDOWS);
  assert.equal(parsed.open.length, SYNC_MAX_OPEN_ITEMS);
});

// ---------------------------------------------------------------------------
// Features: numbers on a window and on an open item
// ---------------------------------------------------------------------------

// A sync body as text, so that a number such as 1e400 is written as a sender
// would write it. The same features text goes on the window and on the item.
function featureBody(featuresText: string): string {
  const features = `"features":${featuresText}`;
  return (
    `{"windows":[{"label":"B-1","start":"${iso(T8)}","end":"${iso(T8 + HOUR)}","match":{"folders":["/work/proj"]},"tags":{},${features}}],` +
    `"open":[{"key":"B-9","tags":{},${features}}]}`
  );
}

test("TP-1: accepted features are kept on the window and the open item, rounded to six decimal places", () => {
  const sixteen = "abcdefghijklmnop";
  const parsed = must(
    parseSyncInput(
      featureBody(`{"issue_bytes":1234,"churn":0.1234567,"files":0,"commits":1000000000000,"${sixteen}":7,"x":2.5}`),
      NOW,
    ),
  );
  const expected = { issue_bytes: 1234, churn: 0.123457, files: 0, commits: 1e12, [sixteen]: 7, x: 2.5 };
  assert.deepEqual(parsed.windows[0]?.features, expected);
  assert.deepEqual(parsed.open[0]?.features, expected);
  assert.deepEqual(parsed.refused, { windows: 0, open: 0, features: 0 });
});

// `count` valid features, f01, f02, and so on, with the values 1, 2, and so on.
function numbered(count: number): Record<string, number> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${String(i + 1).padStart(2, "0")}`, i + 1]));
}

test("exactly sixteen features are all kept on the window and the open item, and none is refused", () => {
  const parsed = must(parseSyncInput(featureBody(JSON.stringify(numbered(16))), NOW));
  assert.deepEqual(parsed.windows[0]?.features, numbered(16));
  assert.deepEqual(parsed.open[0]?.features, numbered(16));
  assert.deepEqual(parsed.refused, { windows: 0, open: 0, features: 0 });
});

test("TP-1: a window with no features, or an empty features object, reads as empty", () => {
  for (const text of [undefined, "{}"]) {
    const body = text === undefined ? input([win()], [{ key: "B-9", tags: {} }]) : featureBody(text);
    const parsed = must(parseSyncInput(body, NOW));
    assert.deepEqual(parsed.windows[0]?.features, {});
    assert.deepEqual(parsed.open[0]?.features, {});
    assert.deepEqual(parsed.refused, { windows: 0, open: 0, features: 0 });
  }
});

const BAD_FEATURES: ReadonlyArray<readonly [string, string, Record<string, number>, number]> = [
  ["a number past the double range", '{"churn":1e400,"files":3}', { files: 3 }, 1],
  ["NaN written as text", '{"churn":"NaN","files":3}', { files: 3 }, 1],
  ["a value that is not a number", '{"churn":null,"files":true,"commits":[1],"issue_bytes":"5","plan_bytes":{}}', {}, 5],
  ["a negative number", '{"churn":-1,"files":3}', { files: 3 }, 1],
  ["a number just above 1e12", '{"churn":1000000000001,"files":1000000000000}', { files: 1e12 }, 1],
  ["a seventeenth feature", JSON.stringify(numbered(17)), numbered(16), 1],
  [
    "bad names",
    '{"Upper":1,"1abc":2,"has space":3,"x-y":4,"":5,"abcdefghijklmnopq":6,"ok_name":7}',
    { ok_name: 7 },
    6,
  ],
  ["reserved names", '{"elapsed_hours":2,"constructor":3,"__proto__":5,"type":6,"all":7,"none":8,"spent":9,"files":1}', { files: 1 }, 7],
  ["a features value that is an array", "[1,2]", {}, 1],
  ["a features value that is text", '"x"', {}, 1],
  ["a features value that is null", "null", {}, 1],
  ["a features value that is a number", "7", {}, 1],
];

test("TP-3: a bad feature is refused alone and counted; the window and the item stay with their good features", () => {
  for (const [name, text, kept, refused] of BAD_FEATURES) {
    const parsed = must(parseSyncInput(featureBody(text), NOW));
    assert.equal(parsed.windows.length, 1, name);
    assert.equal(parsed.open.length, 1, name);
    assert.deepEqual(parsed.windows[0]?.features, kept, name);
    assert.deepEqual(parsed.open[0]?.features, kept, name);
    // The window and the item each count their own refused features.
    assert.deepEqual(parsed.refused, { windows: 0, open: 0, features: 2 * refused }, name);
    const features = parsed.windows[0]?.features;
    assert.ok(features !== undefined);
    assert.equal(Object.getPrototypeOf(features), Object.prototype, `${name}: a prototype changed`);
  }
});

test("TP-57: a window and an item with the feature spent stay, and each counts one refused feature", () => {
  const parsed = must(parseSyncInput(featureBody('{"spent":5,"files":3}'), NOW));
  assert.equal(parsed.windows.length, 1);
  assert.equal(parsed.open.length, 1);
  assert.deepEqual(parsed.windows[0]?.features, { files: 3 });
  assert.deepEqual(parsed.open[0]?.features, { files: 3 });
  assert.deepEqual(parsed.refused, { windows: 0, open: 0, features: 2 });
});

test("TP-54: a window and an item with the stage tag run are kept by sync and read back with the tag", (t) => {
  const dataDir = prepare(t);
  const report = must(sync(dataDir, input([win({ tags: { stage: "run" } })], [{ key: "B-9", tags: { stage: "run" } }]), NOW));
  assert.deepEqual(report.refused, { windows: 0, open: 0, features: 0 });
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(stored.windows.map((w) => w.tags), [{ stage: "run" }]);
  assert.deepEqual(stored.open, [openItem("B-9", { stage: "run" })]);
});

test("TP-3: the features of a window that is refused or repeated are not counted", () => {
  const body = JSON.stringify({
    windows: [
      win({ label: "has space", features: { Bad: 1 } }),
      win({ features: { files: 1 } }),
      win({ features: { Bad: 1 } }),
    ],
    open: [
      { key: "B-9", tags: {}, features: { files: 1 } },
      { key: "B-9", tags: {}, features: { Bad: 1 } },
    ],
  });
  const parsed = must(parseSyncInput(body, NOW));
  assert.deepEqual(parsed.refused, { windows: 2, open: 1, features: 0 });
});

test("TP-3: the estimate input refuses a bad feature alone and keeps the item", () => {
  const parsed = must(
    parseEstimateInput(JSON.stringify({ items: [{ key: "B-1", tags: {}, features: { files: 4, churn: -1, elapsed_hours: 3 } }] })),
  );
  assert.deepEqual(parsed.items, [{ key: "B-1", tags: {}, features: { files: 4 } }]);
  assert.equal(parsed.refused, 0);
  assert.equal(parsed.featuresRefused, 2, "a negative value and a reserved name are two refused features");
});

test("TP-3: the estimate input does not count the features of an item that is refused or repeated", () => {
  const parsed = must(
    parseEstimateInput(
      JSON.stringify({
        items: [
          { key: "has space", tags: {}, features: { Bad: 1 } },
          { key: "B-1", tags: {}, features: { files: 1 } },
          { key: "B-1", tags: {}, features: { Bad: 1 } },
        ],
      }),
    ),
  );
  assert.equal(parsed.refused, 2);
  assert.equal(parsed.featuresRefused, 0);
});

// ---------------------------------------------------------------------------
// Sync: what is kept, and the window file
// ---------------------------------------------------------------------------

function prepare(t: Parameters<typeof makeSandbox>[0]): string {
  const sb = makeSandbox(t);
  mkdirSync(sb.dataDir, { recursive: true, mode: 0o700 });
  return sb.dataDir;
}

test("sync keeps open windows and windows that ended inside the horizon, and drops older ones", (t) => {
  const dataDir = prepare(t);
  // The horizon of 2026-11-05 starts at 2026-10-25T00:00:00Z.
  const text = input([
    win({ label: "OLD", start: "2026-10-01T08:00:00Z", end: "2026-10-01T09:00:00Z" }),
    win({ label: "EDGE", start: "2026-10-24T22:00:00Z", end: "2026-10-25T00:30:00Z" }),
    win({ label: "RECENT", start: "2026-11-02T08:00:00Z", end: "2026-11-02T09:00:00Z" }),
    win({ label: "OPEN-OLD", start: "2026-10-01T08:00:00Z", end: undefined }),
  ]);
  const report = must(sync(dataDir, text, NOW));
  assert.deepEqual(report, {
    windows: 3,
    open: 0,
    refused: { windows: 0, open: 0, features: 0 },
    expired: 1,
    collisions: { keys: 0, windows: [] },
  });
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(stored.windows.map((w) => w.label).sort(), ["EDGE", "OPEN-OLD", "RECENT"]);
});

test("sync writes windows.json with a version, 0600, folder keys and tags only, no path", (t) => {
  const dataDir = prepare(t);
  must(sync(dataDir, input([win()], [{ key: "B-9", tags: { type: "bug" } }]), NOW));
  const file = join(dataDir, TASK_WINDOWS_FILE);
  const text = readFileSync(file, "utf8");
  const body = JSON.parse(text) as Record<string, unknown>;
  assert.equal(body["version"], 1);
  assert.ok(!text.includes("/work"), "a path is in the file");
  assert.ok(text.includes("-work-proj"));
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(dataDir).filter((n) => n.endsWith(".tmp")),
    [],
  );
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(stored.open, [openItem("B-9", { type: "bug" })]);
});

test("a second sync replaces the windows and the open items of the first", (t) => {
  const dataDir = prepare(t);
  must(sync(dataDir, input([win({ label: "B-1" }), win({ label: "B-2" })], [{ key: "B-8", tags: {} }]), NOW));
  must(sync(dataDir, input([win({ label: "B-2" })], [{ key: "B-9", tags: {} }]), NOW));
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(stored.windows.map((w) => w.label), ["B-2"]);
  assert.deepEqual(stored.open.map((o) => o.key), ["B-9"]);
});

// ---------------------------------------------------------------------------
// Folder collisions (issue 11)
// ---------------------------------------------------------------------------

function collisionsOf(windows: unknown[]): unknown {
  return must(parseSyncInput(input(windows), NOW)).collisions;
}

test("collision: two paths of two windows that give one key are counted, with the labels of both windows", () => {
  const windows = [
    win({ label: "T-2", match: { folders: ["/work/a/b"] } }),
    win({ label: "T-1", match: { folders: ["/work/a-b", "/work/other"] } }),
    win({ label: "T-3", match: { folders: ["/work/other"] } }),
  ];
  assert.deepEqual(collisionsOf(windows), { keys: 1, windows: ["T-1", "T-2"] });
});

test("collision: two paths of one window that give one key are counted", () => {
  assert.deepEqual(collisionsOf([win({ label: "T-1", match: { folders: ["/work/a-b", "/work/a/b"] } })]), {
    keys: 1,
    windows: ["T-1"],
  });
});

test("collision: each key with 2 or more paths counts once, and a label shows once", () => {
  const windows = [
    win({ label: "T-1", match: { folders: ["/work/a-b", "/work/c.d"] } }),
    win({ label: "T-1", start: iso(T8 + HOUR), end: iso(T8 + 2 * HOUR), match: { folders: ["/work/a/b"] } }),
    win({ label: "T-2", match: { folders: ["/work/c/d", "/work/c_d"] } }),
  ];
  assert.deepEqual(collisionsOf(windows), { keys: 2, windows: ["T-1", "T-2"] });
});

test("collision: none for different keys, a repeated path, or a path with and without a trailing slash or a double slash", () => {
  const windows = [
    win({ label: "T-1", match: { folders: ["/work/a", "/work/b"] } }),
    win({ label: "T-2", match: { folders: ["/work/a", "/work/a/", "/work//a"] } }),
    win({ label: "T-3", match: { folders: ["/work/a/b/.."] } }),
  ];
  assert.deepEqual(collisionsOf(windows), { keys: 0, windows: [] });
  assert.deepEqual(collisionsOf([]), { keys: 0, windows: [] });
});

test("collision: two paths with the same first 200 characters give one key and are counted", () => {
  const stem = `/work/${"x".repeat(200)}`;
  const windows = [
    win({ label: "T-1", match: { folders: [`${stem}/one`] } }),
    win({ label: "T-2", match: { folders: [`${stem}/two`] } }),
  ];
  assert.deepEqual(collisionsOf(windows), { keys: 1, windows: ["T-1", "T-2"] });
});

test("collision: a refused window takes no part in the check", () => {
  const windows = [
    win({ label: "T-1", match: { folders: ["/work/a-b"] } }),
    win({ label: "has space", match: { folders: ["/work/a/b"] } }),
  ];
  assert.deepEqual(collisionsOf(windows), { keys: 0, windows: [] });
});

test("collision: a window that ended before the horizon takes no part in the check", (t) => {
  // The horizon of 2026-11-05 starts at 2026-10-25T00:00:00Z.
  const windows = [
    win({ label: "OLD", start: "2026-10-01T08:00:00Z", end: "2026-10-01T09:00:00Z", match: { folders: ["/work/a-b"] } }),
    win({ label: "NEW", end: undefined, match: { folders: ["/work/a/b"] } }),
    win({ label: "EDGE", start: "2026-10-24T22:00:00Z", end: "2026-10-25T00:30:00Z", match: { folders: ["/work/c-d"] } }),
    win({ label: "RECENT", match: { folders: ["/work/c/d"] } }),
  ];
  assert.deepEqual(collisionsOf(windows), { keys: 1, windows: ["EDGE", "RECENT"] });
  const report = must(sync(prepare(t), input(windows), NOW));
  assert.equal(report.expired, 1);
  assert.deepEqual(report.collisions, { keys: 1, windows: ["EDGE", "RECENT"] });
});

test("collision: sync reports it, keeps both windows on the one key, and stores no path", (t) => {
  const dataDir = prepare(t);
  const text = input([
    win({ label: "T-1", match: { folders: ["/work/a-b"] } }),
    win({ label: "T-2", match: { folders: ["/work/a/b"] } }),
  ]);
  const report = must(sync(dataDir, text, NOW));
  assert.deepEqual(report.collisions, { keys: 1, windows: ["T-1", "T-2"] });
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(
    stored.windows.map((w) => [w.label, w.folderKeys]),
    [
      ["T-1", ["-work-a-b"]],
      ["T-2", ["-work-a-b"]],
    ],
  );
  const raw = readFileSync(join(dataDir, TASK_WINDOWS_FILE), "utf8");
  assert.ok(!raw.includes("/work"), "a path is in the file");
  assert.ok(!raw.includes("collision"), "the store shape is the same");
});

test("collision: the warning line counts the keys, names the windows, and holds no path and no key", () => {
  assert.equal(collisionWarning({ keys: 0, windows: [] }), null);
  assert.equal(
    collisionWarning({ keys: 1, windows: ["T-1", "T-2"] }),
    'tokenmeter: warning: 1 folder key comes from 2 or more different paths (windows T-1, T-2). Their rows merge. See "The folder match" in the README.\n',
  );
  assert.equal(
    collisionWarning({ keys: 2, windows: ["T-1"] }),
    'tokenmeter: warning: 2 folder keys come from 2 or more different paths (windows T-1). Their rows merge. See "The folder match" in the README.\n',
  );
});

test("a window file that is absent reads as empty", (t) => {
  const dataDir = prepare(t);
  assert.deepEqual(must(loadTaskWindows(dataDir)), { windows: [], open: [], featuresRefused: 0 });
  assert.deepEqual(must(loadTaskHistory(dataDir)), { entries: [], featuresRefused: 0 });
});

test("sync refuses a bad input and writes nothing", (t) => {
  const dataDir = prepare(t);
  const result = sync(dataDir, "{bad", NOW);
  assert.equal(code(result), "usage_error");
  assert.deepEqual(readdirSync(dataDir), []);
});

test("a damaged, newer or over-cap windows.json gives a store error and no write", (t) => {
  const file = (dir: string): string => join(dir, TASK_WINDOWS_FILE);
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["not json", "{nope", "store_corrupt"],
    ["not an object", "[]", "store_corrupt"],
    ["no version", JSON.stringify({ windows: [], open: [] }), "store_corrupt"],
    ["newer version", JSON.stringify({ version: 2, windows: [], open: [] }), "store_newer"],
    ["bad window", JSON.stringify({ version: 1, windows: [{ label: "has space" }], open: [] }), "store_corrupt"],
    [
      "bad folder key",
      JSON.stringify({
        version: 1,
        windows: [{ label: "B-1", tags: {}, start: T8, end: null, folderKeys: ["/raw/path"] }],
        open: [],
      }),
      "store_corrupt",
    ],
    ["bad open item", JSON.stringify({ version: 1, windows: [], open: [{ key: "x y", tags: {} }] }), "store_corrupt"],
    ["over the cap", " ".repeat(FILE_CAPS.windows + 1), "store_corrupt"],
  ];
  for (const [name, body, expected] of cases) {
    const dataDir = prepare(t);
    writeFileSync(file(dataDir), body, { mode: 0o600 });
    const result = sync(dataDir, input([win()]), NOW);
    assert.equal(code(result), expected, name);
    assert.equal(readFileSync(file(dataDir), "utf8"), body, `${name}: the file changed`);
    assert.equal(code(loadTaskWindows(dataDir)), expected, name);
  }
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

function window(over: Partial<TaskWindow> = {}): TaskWindow {
  return { label: "B-1", start: T8, end: T8 + 2 * HOUR, folderKeys: ["-a-b"], tags: {}, features: {}, ...over };
}

function tokens(part: Partial<TokenRecord>): TokenRecord {
  return { ...ZERO, ...part };
}

function row(ms: number, folder: string, part: Partial<TokenRecord>, provider: Provider = "claude", model = "m"): BucketRow {
  return { slot: slotOf(ms), provider, model, folderKey: folder, tokens: tokens(part) };
}

function only<T>(items: readonly T[]): T {
  assert.equal(items.length, 1);
  const first = items[0];
  assert.ok(first !== undefined);
  return first;
}

test("folder match: equal, or the window key followed by '-'; a sibling that extends the name is not a match", () => {
  // The keys of /a/b, /a/b/x and /a/bc.
  const usage = only(
    attribute(
      [window()],
      [
        row(T8, "-a-b", { input: 100 }),
        row(T8, "-a-b-x", { input: 10 }),
        row(T8, "-a-b-x-y", { input: 1 }),
        row(T8, "-a-bc", { input: 1000 }),
        row(T8, "-a", { input: 10000 }),
        row(T8, "-a-b", { input: 5 }, "claude", "other"),
      ],
    ),
  );
  assert.equal(usage.totals.claude.input, 116);
  assert.equal(usage.shared, false);
});

test("the folder rule uses the keys that folderKey makes from paths", () => {
  const parsed = must(
    parseSyncInput(input([win({ match: { folders: ["/a/b"] } })]), NOW),
  );
  const keyed = parsed.windows[0];
  assert.ok(keyed !== undefined);
  const usage = only(
    attribute(
      [keyed],
      [
        row(T8, "-a-b-x", { input: 1 }),
        row(T8, "-a-bc", { input: 100 }),
        row(T8, "-a-b", { input: 10 }),
      ],
    ),
  );
  assert.equal(usage.totals.claude.input, 11);
});

test("time: a slot counts when it overlaps the window; slots that touch only at an edge do not", () => {
  const w = window({ start: T8 + 7 * 60_000, end: T8 + 50 * 60_000 });
  const at = (minutes: number): number => T8 + minutes * 60_000;
  const usage = only(
    attribute(
      [w],
      [
        row(at(-15), "-a-b", { input: 1 }),
        row(at(0), "-a-b", { input: 10 }),
        row(at(15), "-a-b", { input: 100 }),
        row(at(45), "-a-b", { input: 1000 }),
        row(at(60), "-a-b", { input: 10000 }),
      ],
    ),
  );
  assert.equal(usage.totals.claude.input, 1110);

  const exact = window({ start: at(15), end: at(45) });
  const edge = only(
    attribute(
      [exact],
      [
        row(at(0), "-a-b", { input: 1 }),
        row(at(15), "-a-b", { input: 10 }),
        row(at(30), "-a-b", { input: 100 }),
        row(at(45), "-a-b", { input: 1000 }),
      ],
    ),
  );
  assert.equal(edge.totals.claude.input, 110);
});

test("tokens after the end of a window stay unassigned, and an open window covers every later slot", () => {
  const rows = [row(T8 + 3 * HOUR, "-a-b", { input: 7 }), row(T8 + 30 * HOUR, "-a-b", { input: 9 })];
  const [closed, open] = attribute([window(), window({ label: "B-2", end: null })], rows);
  assert.equal(closed?.totals.claude.input, 0);
  assert.equal(open?.totals.claude.input, 16);
});

test("totals per subscription: five raw columns and the weighted value, summed over models", () => {
  const usage = only(
    attribute(
      [window()],
      [
        row(T8, "-a-b", { input: 100, output: 10 }, "claude", "opus"),
        row(T8 + SLOT_MS, "-a-b", { cacheWrite1h: 4, cacheRead: 20 }, "claude", "sonnet"),
        row(T8, "-a-b", { input: 3, output: 2 }, "codex", "gpt"),
      ],
    ),
  );
  assert.deepEqual(
    { ...usage.totals.claude },
    { input: 100, cacheWrite5m: 0, cacheWrite1h: 4, cacheRead: 20, output: 10, weighted: 100 + 8 + 2 + 50 },
  );
  assert.equal(usage.totals.codex.weighted, 3 + 10);
});

test("windows that overlap in one folder split the row evenly and get the shared flag", () => {
  const a = window({ label: "A", start: T8, end: T8 + 2 * HOUR });
  const b = window({ label: "B", start: T8 + HOUR, end: T8 + 3 * HOUR });
  const [ua, ub] = attribute(
    [a, b],
    [
      row(T8 + 15 * 60_000, "-a-b", { input: 100 }),
      row(T8 + HOUR + 15 * 60_000, "-a-b", { input: 100 }),
      row(T8 + 2 * HOUR + 15 * 60_000, "-a-b", { input: 100 }),
    ],
  );
  assert.equal(ua?.totals.claude.input, 150);
  assert.equal(ub?.totals.claude.input, 150);
  assert.equal(ua?.shared, true);
  assert.equal(ub?.shared, true);
});

test("windows in one folder that do not overlap in time are not shared", () => {
  const a = window({ label: "A", start: T8, end: T8 + HOUR });
  const b = window({ label: "B", start: T8 + HOUR, end: T8 + 2 * HOUR });
  const [ua, ub] = attribute([a, b], [row(T8, "-a-b", { input: 10 }), row(T8 + HOUR, "-a-b", { input: 20 })]);
  assert.equal(ua?.totals.claude.input, 10);
  assert.equal(ub?.totals.claude.input, 20);
  assert.equal(ua?.shared, false);
  assert.equal(ub?.shared, false);
});

test("three windows split a row into thirds", () => {
  const three = attribute(
    ["A", "B", "C"].map((label) => window({ label })),
    [row(T8, "-a-b", { input: 90 })],
  );
  assert.deepEqual(three.map((u) => u.totals.claude.input), [30, 30, 30]);
});

test("TP-6: a row in a real sub folder goes to the window of its parent folder", () => {
  const parent = window({ label: "P", folderKeys: ["-a"] });
  const usage = only(attribute([parent], [row(T8, "-a-b-x", { input: 40 })]));
  assert.equal(usage.totals.claude.input, 40);
  assert.equal(usage.shared, false);
});

test("TP-6: with a window on the parent and one on the sub folder, a row goes to the longest folder only", () => {
  const parent = window({ label: "P", folderKeys: ["-a"] });
  const child = window({ label: "C", folderKeys: ["-a-b"] });
  const [up, uc] = attribute(
    [parent, child],
    [row(T8, "-a-b-x", { input: 40 }), row(T8, "-a-b", { input: 8 }), row(T8, "-a", { input: 1 })],
  );
  assert.equal(up?.totals.claude.input, 1);
  assert.equal(uc?.totals.claude.input, 48);
  assert.equal(up?.shared || uc?.shared, false);
});

test("TP-6: the longest folder wins at every depth, and windows on that folder still split the row", () => {
  const windows = [
    window({ label: "A", folderKeys: ["-a"] }),
    window({ label: "B", folderKeys: ["-a-b"] }),
    window({ label: "C", folderKeys: ["-a-b-c"] }),
    window({ label: "D", folderKeys: ["-a-b-c"] }),
  ];
  const usage = attribute(windows, [row(T8, "-a-b-c-d-e", { input: 60 })]);
  assert.deepEqual(usage.map((u) => u.totals.claude.input), [0, 0, 30, 30]);
  assert.deepEqual(usage.map((u) => u.shared), [false, false, true, true]);
});

test("TP-5: a row in folder p1-x with no covering window for p1-x goes to nobody, and never to folder p1", () => {
  const parent = window({ label: "P", folderKeys: ["-w-p1"] });
  // The window of p1-x exists, but it covers a later hour.
  const sibling = window({ label: "S", folderKeys: ["-w-p1-x"], start: T8 + 5 * HOUR, end: T8 + 6 * HOUR });
  const usage = attribute([parent, sibling], [row(T8, "-w-p1-x", { input: 40 }), row(T8, "-w-p1-x-sub", { input: 2 })]);
  assert.deepEqual(usage.map((u) => u.totals.claude.input), [0, 0]);
  assert.deepEqual(usage.map((u) => u.shared), [false, false]);
});

test("TP-5: a window on the longest folder that exists but does not cover the slot gives the row to nobody, not to a shorter folder", () => {
  const near = window({ label: "N", folderKeys: ["-a-b-x"], start: T8 + 5 * HOUR, end: T8 + 6 * HOUR });
  const far = window({ label: "F", folderKeys: ["-a"] });
  const usage = attribute([near, far], [row(T8, "-a-b-x-y", { input: 9 })]);
  assert.deepEqual(usage.map((u) => u.totals.claude.input), [0, 0]);
});

test("a window with two folders that both match a row counts the row once", () => {
  const w = window({ folderKeys: ["-a-b", "-a"] });
  const usage = only(attribute([w], [row(T8, "-a-b-x", { input: 10 })]));
  assert.equal(usage.totals.claude.input, 10);
  assert.equal(usage.shared, false);
  const twice = only(attribute([window({ folderKeys: ["-a-b", "-a-b"] })], [row(T8, "-a-b-x", { input: 10 })]));
  assert.equal(twice.totals.claude.input, 10);
  assert.equal(twice.shared, false);
});

test("attribution is a pure function: the inputs are not changed", () => {
  const windows = [window()];
  const rows = [row(T8, "-a-b", { input: 10 })];
  const before = JSON.stringify([windows, rows]);
  attribute(windows, rows);
  assert.equal(JSON.stringify([windows, rows]), before);
});

// --- the tokens of a window inside today, the week and the month ---

const NO_SPAN: SlotRange = { from: 0, to: 0 };

function span(fromMs: number, toMs: number): SlotRange {
  return { from: slotOf(fromMs), to: slotOf(toMs) };
}

// The slot ranges of the periods. A period that is not named is empty.
function slotsOf(over: Partial<Record<Provider, Partial<Record<PeriodName, SlotRange>>>> = {}): PeriodSlots {
  const empty = { today: NO_SPAN, week: NO_SPAN, month: NO_SPAN };
  return { claude: { ...empty, ...over.claude }, codex: { ...empty, ...over.codex } };
}

test("period tokens: a row counts in a period when its slot is inside the range, and each period counts on its own", () => {
  const rows = [
    row(T8, "-a-b", { input: 10 }),
    row(T8 + HOUR, "-a-b", { input: 100 }),
    row(T8 + 3 * HOUR, "-a-b", { input: 1000 }),
  ];
  const slots = slotsOf({
    claude: {
      today: span(T8 + HOUR, T8 + 2 * HOUR),
      week: span(T8, T8 + 4 * HOUR),
      month: span(T8 - HOUR, T8 + HOUR),
    },
  });
  const usage = only(attribute([window({ end: null })], rows, slots));
  assert.deepEqual({ ...usage.periods.claude }, { today: 100, week: 1110, month: 10 });
  assert.equal(usage.totals.claude.weighted, 1110, "the total since the start stays");
});

test("period tokens: a row outside the window counts in no period, also when the period holds it", () => {
  const rows = [row(T8, "-a-b", { input: 10 }), row(T8 + 2 * HOUR, "-a-b", { input: 100 })];
  const everything = span(T8 - HOUR, T8 + 4 * HOUR);
  const usage = only(
    attribute([window({ start: T8 + HOUR, end: null })], rows, slotsOf({ claude: { today: everything, week: everything, month: everything } })),
  );
  assert.deepEqual({ ...usage.periods.claude }, { today: 100, week: 100, month: 100 });
});

test("period tokens: windows that share hours split the row evenly in every period", () => {
  const all = span(T8 - HOUR, T8 + 4 * HOUR);
  const slots = slotsOf({ claude: { today: all, week: all, month: all } });
  const [a, b] = attribute(
    [window({ label: "A", end: null }), window({ label: "B", end: null })],
    [row(T8, "-a-b", { input: 100 })],
    slots,
  );
  assert.deepEqual({ ...a?.periods.claude }, { today: 50, week: 50, month: 50 });
  assert.deepEqual({ ...b?.periods.claude }, { today: 50, week: 50, month: 50 });
});

test("period tokens: each subscription counts in its own week", () => {
  const rows = [row(T8, "-a-b", { input: 10 }), row(T8, "-a-b", { input: 20 }, "codex", "gpt")];
  const slots = slotsOf({
    claude: { today: span(T8, T8 + HOUR), week: span(T8, T8 + HOUR) },
    codex: { today: span(T8, T8 + HOUR), week: span(T8 + HOUR, T8 + 2 * HOUR) },
  });
  const usage = only(attribute([window({ end: null })], rows, slots));
  assert.deepEqual({ ...usage.periods.claude }, { today: 10, week: 10, month: 0 });
  assert.deepEqual({ ...usage.periods.codex }, { today: 20, week: 0, month: 0 });
});

test("period tokens: with no slot ranges every period is 0", () => {
  const usage = only(attribute([window({ end: null })], [row(T8, "-a-b", { input: 10 })]));
  assert.deepEqual({ ...usage.periods.claude }, { today: 0, week: 0, month: 0 });
  assert.deepEqual({ ...usage.periods.codex }, { today: 0, week: 0, month: 0 });
});

// ---------------------------------------------------------------------------
// Freeze
// ---------------------------------------------------------------------------

test("freezeDue: a window is due more than 1 hour after its end, and an open one never", () => {
  const w = window({ end: T8 + HOUR });
  const rows = [row(T8, "-a-b", { input: 10 })];
  const due = (nowMs: number, windows: readonly TaskWindow[] = [w]): readonly TaskEntry[] =>
    freezeDue({ windows, history: [], rows, nowMs });
  assert.equal(due(T8 + 2 * HOUR - 60_000).length, 0);
  const frozen = only(due(T8 + 2 * HOUR + 60_000));
  assert.equal(frozen.label, "B-1");
  assert.equal(frozen.end, T8 + HOUR);
  assert.equal(frozen.totals.claude.input, 10);
  assert.equal(due(T8 + 50 * HOUR, [window({ end: null })]).length, 0);
});

test("freezeDue skips a window that is already in the history, and keeps a reopened item as a new entry", () => {
  const first = window({ start: T8, end: T8 + HOUR });
  const reopened = window({ start: T8 + 4 * HOUR, end: T8 + 5 * HOUR });
  const rows = [row(T8, "-a-b", { input: 10 }), row(T8 + 4 * HOUR, "-a-b", { input: 20 })];
  const now = T8 + 10 * HOUR;
  const one = freezeDue({ windows: [first], history: [], rows, nowMs: now });
  assert.equal(one.length, 1);
  assert.equal(freezeDue({ windows: [first], history: one, rows, nowMs: now }).length, 0);
  const next = freezeDue({ windows: [first, reopened], history: one, rows, nowMs: now });
  assert.equal(next.length, 1);
  assert.equal(next[0]?.label, "B-1");
  assert.equal(next[0]?.start, T8 + 4 * HOUR);
  assert.equal(next[0]?.totals.claude.input, 20);
});

test("a frozen entry counts the split with a window that is still open", () => {
  const closed = window({ label: "A", start: T8, end: T8 + HOUR });
  const open = window({ label: "B", start: T8, end: null });
  const entry = only(
    freezeDue({ windows: [closed, open], history: [], rows: [row(T8, "-a-b", { input: 80 })], nowMs: T8 + 5 * HOUR }),
  );
  assert.equal(entry.totals.claude.input, 40);
  assert.equal(entry.shared, true);
});

function seed(dataDir: string, windowsText: string, rows: ReadonlyArray<readonly [number, Provider, string, readonly number[]]>): void {
  must(sync(dataDir, windowsText, NOW));
  const body: Record<string, readonly number[]> = {};
  for (const [ms, provider, folder, columns] of rows) body[bucketKey(slotOf(ms), provider, "m", folder)] = columns;
  writeFileSync(join(dataDir, "buckets-2026-11.json"), JSON.stringify({ version: 1, rows: body }), { mode: 0o600 });
}

const FREEZE_NOW = T8 + 2.5 * HOUR;

function seeded(t: Parameters<typeof makeSandbox>[0]): string {
  const dataDir = prepare(t);
  seed(dataDir, input([win({ end: iso(T8 + HOUR) })]), [
    [T8 + 15 * 60_000, "claude", "-work-proj", [100, 0, 0, 0, 10]],
    [T8 + 30 * 60_000, "codex", "-work-proj-sub", [0, 0, 0, 0, 4]],
    [T8 + 30 * 60_000, "claude", "-elsewhere", [999, 0, 0, 0, 0]],
  ]);
  return dataDir;
}

test("freezeTasks writes one history line per finished task; a second freeze adds nothing", (t) => {
  const dataDir = seeded(t);
  const first = must(freezeTasks(dataDir, FREEZE_NOW, true));
  assert.deepEqual(first, { frozen: 1, total: 1 });
  const file = join(dataDir, TASK_HISTORY_FILE);
  const bytes = readFileSync(file, "utf8");
  const second = must(freezeTasks(dataDir, FREEZE_NOW + HOUR, true));
  assert.deepEqual(second, { frozen: 0, total: 1 });
  assert.equal(readFileSync(file, "utf8"), bytes);
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const history = must(loadTaskHistory(dataDir)).entries;
  const entry = only(history);
  assert.equal(entry.label, "B-1");
  assert.deepEqual(entry.tags, { type: "feature" });
  assert.equal(entry.start, T8);
  assert.equal(entry.end, T8 + HOUR);
  assert.equal(entry.shared, false);
  assert.equal(entry.totals.claude.weighted, 100 + 50);
  assert.equal(entry.totals.codex.weighted, 20);
});

test("a task freezes only when the scan has no backlog", (t) => {
  const dataDir = seeded(t);
  assert.deepEqual(must(freezeTasks(dataDir, FREEZE_NOW, false)), { frozen: 0, total: 0 });
  assert.equal(readdirSync(dataDir).includes(TASK_HISTORY_FILE), false);
});

test("a task that ended less than 1 hour ago is not frozen yet", (t) => {
  const dataDir = seeded(t);
  assert.deepEqual(must(freezeTasks(dataDir, T8 + 2 * HOUR - 60_000, true)), { frozen: 0, total: 0 });
});

test("a reopened item gets a new window and a new entry; the old entry stays", (t) => {
  const dataDir = prepare(t);
  const first = win({ start: iso(T8), end: iso(T8 + HOUR) });
  seed(dataDir, input([first]), [
    [T8, "claude", "-work-proj", [10, 0, 0, 0, 0]],
    [T8 + 2 * HOUR, "claude", "-work-proj", [20, 0, 0, 0, 0]],
  ]);
  must(freezeTasks(dataDir, T8 + 3 * HOUR, true));
  const reopened = win({ start: iso(T8 + 1.5 * HOUR), end: iso(T8 + 2.5 * HOUR) });
  must(sync(dataDir, input([first, reopened]), NOW));
  assert.deepEqual(must(freezeTasks(dataDir, NOW, true)), { frozen: 1, total: 2 });
  assert.deepEqual(must(freezeTasks(dataDir, NOW, true)), { frozen: 0, total: 2 });
  const history = must(loadTaskHistory(dataDir)).entries;
  assert.deepEqual(history.map((e) => [e.label, e.totals.claude.input]), [
    ["B-1", 10],
    ["B-1", 20],
  ]);
});

test("the history holds no session id and no path", (t) => {
  const dataDir = prepare(t);
  seed(dataDir, input([win({ match: { folders: ["/work/canary-path-91"] } })]), [
    [T8, "claude", "-work-canary-path-91", [10, 0, 0, 0, 0]],
  ]);
  must(freezeTasks(dataDir, NOW, true));
  const text = readFileSync(join(dataDir, TASK_HISTORY_FILE), "utf8");
  for (const needle of ["canary", "/work", "-work", "session", "folder", "path", "cwd"]) {
    assert.ok(!text.toLowerCase().includes(needle), `the history holds "${needle}"`);
  }
  const line = JSON.parse(text.trim()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(line).sort(), ["claude", "codex", "end", "features", "label", "shared", "start", "tags", "version"]);
});

test("the history keeps the newest entries when it passes its limit", (t) => {
  const dataDir = prepare(t);
  const old = Date.parse("2026-10-26T00:00:00Z");
  const lines: string[] = [];
  for (let i = 0; i < TASK_HISTORY_MAX; i += 1) {
    const label = `OLD-${i}`;
    lines.push(
      JSON.stringify({ version: 1, label, tags: {}, start: old + i * 2000, end: old + i * 2000 + 1000, shared: false, claude: [1, 0, 0, 0, 0], codex: [0, 0, 0, 0, 0] }),
    );
  }
  writeFileSync(join(dataDir, TASK_HISTORY_FILE), `${lines.join("\n")}\n`, { mode: 0o600 });
  seed(dataDir, input([win({ label: "NEW" })]), [[T8, "claude", "-work-proj", [5, 0, 0, 0, 0]]]);
  assert.deepEqual(must(freezeTasks(dataDir, NOW, true)), { frozen: 1, total: TASK_HISTORY_MAX });
  const history = must(loadTaskHistory(dataDir)).entries;
  assert.equal(history.length, TASK_HISTORY_MAX);
  assert.equal(history[0]?.label, "OLD-1");
  assert.equal(history[history.length - 1]?.label, "NEW");
});

test("a damaged, newer or over-cap history gives a store error and no write", (t) => {
  const good = {
    version: 1,
    label: "B-1",
    tags: {},
    start: T8,
    end: T8 + HOUR,
    shared: false,
    claude: [1, 0, 0, 0, 0],
    codex: [0, 0, 0, 0, 0],
  };
  const line = (over: Record<string, unknown>): string => JSON.stringify({ ...good, ...over });
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["not json", "{nope\n", "store_corrupt"],
    ["not an object", "[1]\n", "store_corrupt"],
    ["no version", JSON.stringify({ label: "B-1" }) + "\n", "store_corrupt"],
    ["newer version", `${line({ version: 2 })}\n`, "store_newer"],
    ["bad label", `${line({ label: "has space" })}\n`, "store_corrupt"],
    ["bad tags", `${line({ tags: { a: "b c" } })}\n`, "store_corrupt"],
    ["end before start", `${line({ end: T8 - 1 })}\n`, "store_corrupt"],
    ["bad columns", `${line({ claude: [1, 2] })}\n`, "store_corrupt"],
    ["negative column", `${line({ codex: [-1, 0, 0, 0, 0] })}\n`, "store_corrupt"],
    ["bad shared", `${line({ shared: "yes" })}\n`, "store_corrupt"],
    ["one bad line after a good one", `${line({})}\n{oops\n`, "store_corrupt"],
    ["over the cap", " ".repeat(FILE_CAPS.tasks + 1), "store_corrupt"],
  ];
  for (const [name, body, expected] of cases) {
    const dataDir = prepare(t);
    seed(dataDir, input([win()]), [[T8, "claude", "-work-proj", [5, 0, 0, 0, 0]]]);
    const file = join(dataDir, TASK_HISTORY_FILE);
    writeFileSync(file, body, { mode: 0o600 });
    assert.equal(code(freezeTasks(dataDir, NOW, true)), expected, name);
    assert.equal(readFileSync(file, "utf8"), body, `${name}: the file changed`);
    assert.equal(code(loadTaskHistory(dataDir)), expected, name);
  }
});

test("a damaged window file stops the freeze with no write", (t) => {
  const dataDir = prepare(t);
  writeFileSync(join(dataDir, TASK_WINDOWS_FILE), "{nope", { mode: 0o600 });
  assert.equal(code(freezeTasks(dataDir, NOW, true)), "store_corrupt");
  assert.equal(readdirSync(dataDir).includes(TASK_HISTORY_FILE), false);
});

// ---------------------------------------------------------------------------
// A parent folder and a sibling that extends its name
// ---------------------------------------------------------------------------

// Invented rows. Window L-P is on folder p1, window L-S on folder p1-x. Both
// folders make keys that start with the same text, so the key of the sibling
// also looks like a sub folder of p1.
const SIBLING_ROWS: ReadonlyArray<readonly [number, Provider, string, readonly number[]]> = [
  [T8 + 15 * 60_000, "claude", "-work-p1", [100, 0, 0, 0, 0]],
  [T8 + 15 * 60_000, "claude", "-work-p1-x", [10, 0, 0, 0, 0]],
  [T8 + 15 * 60_000, "claude", "-work-p1-x-sub", [1, 0, 0, 0, 0]],
  [T8 + 15 * 60_000, "claude", "-work-p1-sub", [1000, 0, 0, 0, 0]],
];

function siblingWindows(): string {
  return input([
    win({ label: "L-P", match: { folders: ["/work/p1"] } }),
    win({ label: "L-S", match: { folders: ["/work/p1-x"] } }),
  ]);
}

test("TP-7: a parent folder and a sibling that extends its name each keep their own rows; a real sub folder goes to its parent", (t) => {
  const dataDir = prepare(t);
  seed(dataDir, siblingWindows(), SIBLING_ROWS);
  must(freezeTasks(dataDir, NOW, true));
  const history = must(loadTaskHistory(dataDir)).entries;
  // L-P: its own folder and the sub folder p1/sub. L-S: its own folder and the sub folder p1-x/sub.
  assert.deepEqual(
    history.map((e) => [e.label, e.totals.claude.input, e.shared]),
    [
      ["L-P", 1100, false],
      ["L-S", 11, false],
    ],
  );
});

test("TP-7: a frozen row keeps its stored value when the folder rule would give another", (t) => {
  const dataDir = prepare(t);
  // The row of L-P as an earlier build froze it: the sibling rows were split into it.
  const frozen = JSON.stringify({
    version: 1,
    label: "L-P",
    tags: { type: "feature" },
    start: T8,
    end: T8 + HOUR,
    shared: true,
    claude: [1105, 0, 0, 0, 0],
    codex: [0, 0, 0, 0, 0],
  });
  writeFileSync(join(dataDir, TASK_HISTORY_FILE), `${frozen}\n`, { mode: 0o600 });
  seed(dataDir, siblingWindows(), SIBLING_ROWS);
  assert.deepEqual(must(freezeTasks(dataDir, NOW, true)), { frozen: 1, total: 2 });
  const lines = readFileSync(join(dataDir, TASK_HISTORY_FILE), "utf8").trim().split("\n");
  const stored = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(stored["label"], "L-P");
  assert.deepEqual(stored["claude"], [1105, 0, 0, 0, 0]);
  assert.equal(stored["shared"], true);
  const history = must(loadTaskHistory(dataDir)).entries;
  assert.deepEqual(history.map((e) => [e.label, e.totals.claude.input]), [["L-P", 1105], ["L-S", 11]]);
});

// ---------------------------------------------------------------------------
// Features in the store files
// ---------------------------------------------------------------------------

const STORED_FEATURES = { issue_bytes: 1234, churn: 0.123457, files: 0, commits: 1e12 };

test("TP-1: features survive sync, the window file, the freeze, the history file and a reload", (t) => {
  const dataDir = prepare(t);
  const features = { issue_bytes: 1234, churn: 0.1234567, files: 0, commits: 1e12 };
  seed(dataDir, input([win({ features })], [{ key: "B-9", tags: { type: "bug" }, features }]), [
    [T8 + 15 * 60_000, "claude", "-work-proj", [10, 0, 0, 0, 0]],
  ]);
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(stored.windows[0]?.features, STORED_FEATURES);
  assert.deepEqual(stored.open[0]?.features, STORED_FEATURES);
  assert.equal(stored.featuresRefused, 0);

  assert.deepEqual(must(freezeTasks(dataDir, NOW, true)), { frozen: 1, total: 1 });
  const text = readFileSync(join(dataDir, TASK_HISTORY_FILE), "utf8");
  assert.ok(text.includes('"churn":0.123457'), "six decimal places are in the file");
  assert.ok(!text.includes("0.1234567"), "a seventh decimal place is in the file");
  const history = must(loadTaskHistory(dataDir));
  assert.deepEqual(only(history.entries).features, STORED_FEATURES);
  assert.equal(history.featuresRefused, 0);
});

test("TP-2: old lines and old window files without features read back with empty features", (t) => {
  const dataDir = prepare(t);
  const oldLine = {
    version: 1,
    label: "B-1",
    tags: { type: "bug" },
    start: T8,
    end: T8 + HOUR,
    shared: false,
    claude: [1, 0, 0, 0, 0],
    codex: [0, 0, 0, 0, 0],
  };
  writeFileSync(join(dataDir, TASK_HISTORY_FILE), `${JSON.stringify(oldLine)}\n`, { mode: 0o600 });
  const oldWindow = { label: "B-1", tags: {}, start: T8, end: null, folderKeys: ["-work-proj"] };
  writeFileSync(
    join(dataDir, TASK_WINDOWS_FILE),
    JSON.stringify({ version: 1, windows: [oldWindow], open: [{ key: "B-9", tags: {} }] }),
    { mode: 0o600 },
  );
  const history = must(loadTaskHistory(dataDir));
  assert.deepEqual(only(history.entries).features, {});
  assert.equal(history.featuresRefused, 0);
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(stored.windows[0]?.features, {});
  assert.deepEqual(stored.open[0]?.features, {});
  assert.equal(stored.featuresRefused, 0);
});

test("TP-42: a stored task line with a bad feature loads, keeps its row, and counts the feature", (t) => {
  const dataDir = prepare(t);
  const line = (label: string, features: unknown): string =>
    JSON.stringify({
      version: 1,
      label,
      tags: {},
      start: T8,
      end: T8 + HOUR,
      shared: false,
      claude: [1, 0, 0, 0, 0],
      codex: [0, 0, 0, 0, 0],
      features,
    });
  const lines = [
    line("B-1", { issue_bytes: 5, Bad: 1, churn: -3, elapsed_hours: 2 }),
    line("B-2", [1, 2]),
    line("B-3", { files: 4 }),
  ];
  writeFileSync(join(dataDir, TASK_HISTORY_FILE), `${lines.join("\n")}\n`, { mode: 0o600 });
  const history = must(loadTaskHistory(dataDir));
  assert.deepEqual(
    history.entries.map((e) => [e.label, e.totals.claude.input, e.features]),
    [
      ["B-1", 1, { issue_bytes: 5 }],
      ["B-2", 1, {}],
      ["B-3", 1, { files: 4 }],
    ],
  );
  // Three bad features in the first line, and one bad features value in the second.
  assert.equal(history.featuresRefused, 4);
});

test("TP-56: a stored task line with the feature spent loads, counts one refused feature, and keeps its other features", (t) => {
  const dataDir = prepare(t);
  const stored = {
    version: 1,
    label: "B-1",
    tags: {},
    start: T8,
    end: T8 + HOUR,
    shared: false,
    claude: [1, 0, 0, 0, 0],
    codex: [0, 0, 0, 0, 0],
    features: { spent: 5, files: 4, churn: 2 },
  };
  writeFileSync(join(dataDir, TASK_HISTORY_FILE), `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  const history = must(loadTaskHistory(dataDir));
  assert.deepEqual(history.entries.map((e) => [e.label, e.features]), [["B-1", { churn: 2, files: 4 }]]);
  assert.equal(history.featuresRefused, 1);
});

test("TP-42: a stored window or open item with a bad feature loads and counts the feature", (t) => {
  const dataDir = prepare(t);
  const storedWindow = { label: "B-1", tags: {}, start: T8, end: null, folderKeys: ["-work-proj"], features: { files: 2, Bad: 1 } };
  const storedItem = { key: "B-9", tags: {}, features: { churn: -1, commits: 3 } };
  writeFileSync(join(dataDir, TASK_WINDOWS_FILE), JSON.stringify({ version: 1, windows: [storedWindow], open: [storedItem] }), {
    mode: 0o600,
  });
  const stored = must(loadTaskWindows(dataDir));
  assert.deepEqual(stored.windows[0]?.features, { files: 2 });
  assert.deepEqual(stored.open[0]?.features, { commits: 3 });
  assert.equal(stored.featuresRefused, 2);
});

// The worst case of the history file. Each field of a line has the largest size
// that the readers accept. The fixture and the computed worst case are both built
// from these constants.
const WORST_COUNT = Number.MAX_SAFE_INTEGER;
// "false" is one character longer than "true".
const WORST_SHARED = false;
// A label, a tag key and a tag value.
const WORST_LABEL_CHARS = 64;
// An epoch time in milliseconds.
const WORST_TIME_DIGITS = 13;
// The longest text that a feature value takes after the rounding to six decimal
// places: 17 digits and a point.
const WORST_FEATURE_VALUE = 140737488355.12344;
const WORST_FEATURE_VALUE_CHARS = 18;
const WORST_COLUMNS = Array.from({ length: Object.keys(ZERO).length }, () => WORST_COUNT);
const WORST_TAGS: Tags = Object.fromEntries(
  Array.from({ length: MAX_TAGS }, (_, i) => [`${"k".repeat(WORST_LABEL_CHARS - 1)}${i}`, "v".repeat(WORST_LABEL_CHARS)]),
);
const WORST_FEATURES: Features = Object.fromEntries(
  Array.from({ length: MAX_FEATURES }, (_, i) => [
    `${"a".repeat(FEATURE_NAME_MAX - 2)}${String(i + 1).padStart(2, "0")}`,
    WORST_FEATURE_VALUE,
  ]),
);
const OLD_START = Date.parse("2026-10-26T00:00:00Z");

function worstLabel(i: number): string {
  return `${"L".repeat(WORST_LABEL_CHARS - 5)}${String(i).padStart(5, "0")}`;
}

function worstLine(label: string, start: number): string {
  return JSON.stringify({
    version: 1,
    label,
    tags: WORST_TAGS,
    start,
    end: start + 1000,
    shared: WORST_SHARED,
    claude: WORST_COLUMNS,
    codex: WORST_COLUMNS,
    features: WORST_FEATURES,
  });
}

// Every line has the same size, so the file is the line size times the line cap.
const WORST_LINE_BYTES = Buffer.byteLength(worstLine(worstLabel(0), 10 ** (WORST_TIME_DIGITS - 1)), "utf8") + 1;
const WORST_FILE_BYTES = TASK_HISTORY_MAX * WORST_LINE_BYTES;

// The longest time text that the sync input takes: nine decimals and an offset.
function longestTime(ms: number): string {
  return `${iso(ms).slice(0, -1)}000000+00:00`;
}

// The windows of the worst case, as they arrive in a sync.
function worstWindows(): Array<Record<string, unknown>> {
  return Array.from({ length: SYNC_MAX_WINDOWS }, (_, i) =>
    win({
      label: worstLabel(10_000 + i),
      start: longestTime(T8),
      end: longestTime(T8 + HOUR),
      match: { folders: [`/work/w${i}`] },
      tags: WORST_TAGS,
      features: WORST_FEATURES,
    }),
  );
}

test("the worst-case constants are the largest values that the readers accept", () => {
  assert.ok(isLabel("x".repeat(WORST_LABEL_CHARS)));
  assert.equal(isLabel("x".repeat(WORST_LABEL_CHARS + 1)), false);
  const names = Object.keys(WORST_FEATURES);
  assert.equal(names.length, MAX_FEATURES);
  assert.ok(names.every((name) => name.length === FEATURE_NAME_MAX && isFeatureName(name)));
  assert.equal(isFeatureName(`${names[0]}a`), false);
  assert.deepEqual(sanitizeFeature(WORST_FEATURE_VALUE), { ok: true, value: WORST_FEATURE_VALUE });
  assert.equal(JSON.stringify(WORST_FEATURE_VALUE).length, WORST_FEATURE_VALUE_CHARS);
  assert.ok(isCount(WORST_COUNT));
  assert.equal(isCount(WORST_COUNT + 1), false);
  assert.equal(String(OLD_START).length, WORST_TIME_DIGITS);
  assert.equal(String(NOW).length, WORST_TIME_DIGITS);
});

// The 500 windows that freeze now arrive in a sync. The body test below checks
// that sync against its limit.
test("TP-4: a worst-case history of 5000 lines with sixteen feature names stays under the file cap, equals the computed worst case, and reads back", (t) => {
  const dataDir = prepare(t);
  // 4500 old lines, in the shape of the file, and 500 windows that freeze now.
  const lines: string[] = [];
  for (let i = 0; i < TASK_HISTORY_MAX - SYNC_MAX_WINDOWS; i += 1) lines.push(worstLine(worstLabel(i), OLD_START + i * 2000));
  writeFileSync(join(dataDir, TASK_HISTORY_FILE), `${lines.join("\n")}\n`, { mode: 0o600 });
  const rows: Array<readonly [number, Provider, string, readonly number[]]> = Array.from({ length: SYNC_MAX_WINDOWS }, (_, i) => i).flatMap(
    (i) => [
      [T8 + 15 * 60_000, "claude", `-work-w${i}`, WORST_COLUMNS] as const,
      [T8 + 15 * 60_000, "codex", `-work-w${i}`, WORST_COLUMNS] as const,
    ],
  );
  seed(dataDir, input(worstWindows()), rows);

  assert.deepEqual(must(freezeTasks(dataDir, NOW, true)), { frozen: SYNC_MAX_WINDOWS, total: TASK_HISTORY_MAX });
  const size = statSync(join(dataDir, TASK_HISTORY_FILE)).size;
  assert.ok(size < FILE_CAPS.tasks, `the file has ${size} bytes`);
  assert.equal(size, WORST_FILE_BYTES);
  const written = readFileSync(join(dataDir, TASK_HISTORY_FILE), "utf8").split("\n").filter((line) => line !== "");
  assert.deepEqual([...new Set(written.map((line) => Buffer.byteLength(line, "utf8") + 1))], [WORST_LINE_BYTES]);

  const history = must(loadTaskHistory(dataDir));
  assert.equal(history.entries.length, TASK_HISTORY_MAX);
  assert.equal(history.featuresRefused, 0);
  assert.ok(history.entries.every((e) => Object.keys(e.features).length === MAX_FEATURES));
  assert.deepEqual(history.entries[TASK_HISTORY_MAX - 1]?.features, WORST_FEATURES);
});

// The body holds windows only. Open items add to a real sync, and the room that
// they have under the limit is a stated limit, not a case that this test checks.
test("the sync body of the worst-case windows, with no open items, stays within the sync limit, and every window keeps all its features", () => {
  const body = input(worstWindows());
  const size = Buffer.byteLength(body, "utf8");
  assert.ok(size <= SYNC_MAX_BYTES, `the body has ${size} bytes`);
  const parsed = must(parseSyncInput(body, NOW));
  assert.equal(parsed.windows.length, SYNC_MAX_WINDOWS);
  assert.deepEqual(parsed.refused, { windows: 0, open: 0, features: 0 });
  assert.ok(parsed.windows.every((w) => Object.keys(w.features).length === MAX_FEATURES));
});

// ---------------------------------------------------------------------------
// Shares (B3)
// ---------------------------------------------------------------------------

function ready(perPctWeighted: number): Calibration {
  return { ready: true, perPctWeighted, confidence: "medium", intervals: 3, label: CALIBRATION_LABEL };
}

const NOT_READY: Calibration = { ready: false, label: NOT_READY_LABEL };

function totalsOf(claudeWeighted: number, codexWeighted: number): Record<Provider, TokenRecord & { weighted: number }> {
  const make = (value: number): TokenRecord & { weighted: number } => {
    const record = tokens({ input: value });
    return { ...record, weighted: weighted(record) };
  };
  return { claude: make(claudeWeighted), codex: make(codexWeighted) };
}

test("TP-6: a finished task gets a share on each subscription it used, from that calibration", () => {
  const shares = taskShares(totalsOf(300, 100), { claude: ready(100), codex: ready(50) });
  assert.deepEqual(
    shares.map((s) => [s.provider, s.weighted, s.share.ready ? s.share.pct : null]),
    [
      ["claude", 300, 3],
      ["codex", 100, 2],
    ],
  );
});

test("TP-6: the main share is the subscription with the most weighted tokens", () => {
  const shares = taskShares(totalsOf(100, 300), { claude: ready(100), codex: ready(50) });
  assert.deepEqual(shares.map((s) => [s.provider, s.main]), [
    ["codex", true],
    ["claude", false],
  ]);
});

test("TP-6: the second share shows only at 10 percent of the task's weighted tokens or more", () => {
  const cal = { claude: ready(100), codex: ready(100) };
  const at = (claude: number, codex: number): readonly boolean[] => taskShares(totalsOf(claude, codex), cal).map((s) => s.shown);
  assert.deepEqual(at(90, 10), [true, true]);
  assert.deepEqual(at(91, 9), [true, false]);
  assert.deepEqual(at(50, 50), [true, true]);
  assert.deepEqual(at(999, 1), [true, false]);
});

test("a subscription the task did not use has no share; a task with no tokens has none", () => {
  const cal = { claude: ready(100), codex: ready(100) };
  assert.deepEqual(taskShares(totalsOf(100, 0), cal).map((s) => s.provider), ["claude"]);
  assert.deepEqual(taskShares(totalsOf(0, 100), cal).map((s) => s.provider), ["codex"]);
  assert.deepEqual(taskShares(totalsOf(0, 0), cal), []);
});

test("equal weighted tokens: claude is the main share", () => {
  const shares = taskShares(totalsOf(50, 50), { claude: ready(100), codex: ready(100) });
  assert.deepEqual(shares.map((s) => s.provider), ["claude", "codex"]);
  assert.equal(shares[0]?.main, true);
  assert.equal(shares[1]?.main, false);
});

// Totals from the five columns of each subscription. The weighted value follows.
function totalsFrom(claude: Partial<TokenRecord>, codex: Partial<TokenRecord> = {}): Record<Provider, TokenRecord & { weighted: number }> {
  const make = (part: Partial<TokenRecord>): TokenRecord & { weighted: number } => {
    const record = tokens(part);
    return { ...record, weighted: weighted(record) };
  };
  return { claude: make(claude), codex: make(codex) };
}

test("a share has the raw tokens of the task: the five columns added with no weight", () => {
  const totals = totalsFrom(
    { input: 10, cacheWrite5m: 8, cacheWrite1h: 5, cacheRead: 100, output: 2 },
    { input: 40, cacheRead: 60, output: 4 },
  );
  const shares = taskShares(totals, { claude: ready(100), codex: ready(100) });
  // Weighted: Codex 66 and Claude 50, so Codex is the main share. Raw: 104 and 125.
  assert.deepEqual(shares.map((s) => [s.provider, s.weighted, s.raw]), [
    ["codex", 66, 104],
    ["claude", 50, 125],
  ]);
});

test("the raw tokens of windows that share hours are split evenly", () => {
  const [a, b] = attribute(
    [window({ label: "A", end: null }), window({ label: "B", end: null })],
    [row(T8, "-a-b", { input: 100, output: 10 })],
  );
  assert.ok(a !== undefined && b !== undefined);
  const cal = { claude: ready(100), codex: ready(100) };
  assert.equal(taskShares(a.totals, cal)[0]?.raw, 55);
  assert.equal(taskShares(b.totals, cal)[0]?.raw, 55);
});

test("with no ready calibration the share is 'not ready yet', per subscription", () => {
  const shares = taskShares(totalsOf(300, 100), { claude: NOT_READY, codex: ready(50) });
  assert.deepEqual(shares[0]?.share, { ready: false, label: SHARE_NOT_READY_LABEL });
  assert.equal(SHARE_NOT_READY_LABEL, "not ready yet");
  assert.deepEqual(shares[1]?.share, { ready: true, pct: 2 });
});

// ---------------------------------------------------------------------------
// Estimates (B1)
// ---------------------------------------------------------------------------

function entry(label: string, type: string | null, claude: number, codex = 0, over: Partial<TaskEntry> = {}): TaskEntry {
  const totals = totalsOf(claude, codex);
  return {
    label,
    tags: type === null ? {} : { type },
    start: T8,
    end: T8 + HOUR,
    shared: false,
    totals,
    features: {},
    ...over,
  };
}

function openItem(key: string, tags: Tags = {}, features: Features = {}): OpenItem {
  return { key, tags, features };
}

const CAL = { claude: ready(100), codex: ready(100) };

function only1(estimates: readonly SignalEstimate[]): SignalEstimate {
  return only(estimates);
}

type Ranged = Extract<SignalEstimate, { basis: "similar" | "wide" }>;

// The one estimate of a call, which must have a basis.
function rangedOnly(estimates: readonly SignalEstimate[]): Ranged {
  const result = only1(estimates);
  if (result.basis === "none") return assert.fail("a basis was expected");
  return result;
}

function close(actual: number, expected: number, message?: string): void {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${message ?? ""} ${actual} is not close to ${expected}`);
}

// Every task has the same type and no feature, so the type scores the same as all
// and the tie goes to all.
test("3 or more finished tasks give the 10th to 90th percentile range of their cost, basis wide, named all", () => {
  const history = [100, 200, 300, 400, 500].map((w, i) => entry(`T-${i}`, "feature", w));
  const result = rangedOnly(estimateFromSignals([openItem("B-9", { type: "feature" })], history, CAL));
  assert.deepEqual([result.key, result.subscription, result.basis, result.basisName, result.label, result.count], [
    "B-9",
    "claude",
    "wide",
    "all",
    "wide, low confidence",
    5,
  ]);
  // Ranks 0.4 and 3.6 of 100, 200, 300, 400, 500, with 100 weighted tokens for 1 percent.
  close(result.lowPct, 1.4);
  close(result.highPct, 4.6);
  close(result.rawLow, 140);
  close(result.rawHigh, 460);
});

test("the percentile range interpolates between ranks", () => {
  const history = [100, 200, 400].map((w, i) => entry(`T-${i}`, "bug", w));
  const result = rangedOnly(estimateFromSignals([openItem("B-9", { type: "bug" })], history, CAL));
  assert.equal(result.basis, "wide");
  close(result.lowPct, 1.2);
  close(result.highPct, 3.6);
  assert.equal(result.count, 3);
});

test("a type whose tasks cost far less spread than the rest wins: basis wide, named type, the range of its own tasks", () => {
  const bugs = [100_000, 110_000, 120_000, 130_000].map((w, i) => entry(`B-${i}`, "bug", w));
  const docs = [100, 200, 300, 400, 500, 600].map((w, i) => entry(`D-${i}`, "docs", w));
  const result = rangedOnly(estimateFromSignals([openItem("B-9", { type: "bug" })], [...bugs, ...docs], CAL));
  assert.deepEqual([result.basis, result.basisName, result.count], ["wide", "type", 4]);
  close(result.lowPct, 1030);
  close(result.highPct, 1270);
});

// A finished task whose raw tokens differ from its weighted tokens. With the
// calibration of 110 weighted tokens for 1 percent, task n has n percent and
// 1010 x n raw tokens.
function rawEntry(label: string, type: string, n: number, codexN = 0): TaskEntry {
  const totals = totalsFrom({ input: 10 * n, cacheRead: 1000 * n }, { input: 10 * codexN, cacheRead: 1000 * codexN });
  return entry(label, type, 0, 0, { totals });
}

const CAL_110 = { claude: ready(110), codex: ready(110) };

test("the estimate gives the same range in raw tokens, from the raw totals of the same tasks", () => {
  const history = [1, 2, 3, 4, 5].map((n) => rawEntry(`T-${n}`, "feature", n));
  const result = rangedOnly(estimateFromSignals([openItem("B-9", { type: "feature" })], history, CAL_110));
  assert.equal(result.basis, "wide");
  close(result.lowPct, 1.4);
  close(result.highPct, 4.6);
  close(result.rawLow, 1.4 * 1010);
  close(result.rawHigh, 4.6 * 1010);
});

test("the raw range interpolates between ranks, like the percent range", () => {
  const history = [1, 2, 4].map((n) => rawEntry(`T-${n}`, "bug", n));
  const result = rangedOnly(estimateFromSignals([openItem("B-9", { type: "bug" })], history, CAL_110));
  close(result.lowPct, 1.2);
  close(result.highPct, 3.6);
  close(result.rawLow, 1.2 * 1010);
  close(result.rawHigh, 3.6 * 1010);
});

test("the wide raw range uses all finished tasks with a share, and leaves out a task that did not use the subscription", () => {
  const history = [
    rawEntry("T-1", "feature", 1),
    rawEntry("T-2", "feature", 2),
    rawEntry("T-3", "bug", 3),
    rawEntry("T-4", "bug", 4),
    rawEntry("T-5", "bug", 0, 50),
  ];
  const claude = rangedOnly(estimateFromSignals([openItem("B-9", { type: "docs" })], history, CAL_110));
  assert.equal(claude.basis, "wide");
  assert.equal(claude.count, 4);
  close(claude.rawLow, 1.3 * 1010);
  close(claude.rawHigh, 3.7 * 1010);
  const codex = only1(estimateFromSignals([openItem("B-9", { type: "docs" })], history, CAL_110, "codex"));
  assert.equal(codex.basis, "none");
});

test("the raw range of the other subscription comes from its own raw totals", () => {
  const history = [1, 2, 3].map((n) => rawEntry(`T-${n}`, "feature", 0, n));
  const result = rangedOnly(estimateFromSignals([openItem("B-9", { type: "feature" })], history, CAL_110, "codex"));
  close(result.rawLow, 1.2 * 1010);
  close(result.rawHigh, 2.8 * 1010);
});

test("with fewer than 3 of the same type but 3 or more in all, the range is over all, basis wide", () => {
  const history = [entry("T-1", "feature", 100), entry("T-2", "feature", 200), entry("T-3", "bug", 300), entry("T-4", "bug", 400)];
  const result = rangedOnly(estimateFromSignals([openItem("B-9", { type: "feature" })], history, CAL));
  assert.deepEqual([result.basis, result.basisName, result.label, result.count], ["wide", "all", "wide, low confidence", 4]);
  close(result.lowPct, 1.3);
  close(result.highPct, 3.7);
});

test("an item with no type tag, or a type nobody has done, uses the range over all", () => {
  const history = [100, 200, 300].map((w, i) => entry(`T-${i}`, "feature", w));
  const results = estimateFromSignals([openItem("B-1"), openItem("B-2", { type: "docs" })], history, CAL);
  assert.deepEqual(results.map((r) => [r.basis, r.basisName]), [["wide", "all"], ["wide", "all"]]);
});

test("with fewer than 3 finished tasks there is no basis yet", () => {
  const history = [entry("T-1", "feature", 100), entry("T-2", "feature", 200)];
  const result = only1(estimateFromSignals([openItem("B-9", { type: "feature" })], history, CAL));
  assert.deepEqual(result, { key: "B-9", subscription: "claude", basis: "none", basisName: "none", label: "no basis yet" });
  assert.deepEqual(estimateFromSignals([openItem("B-9")], [], CAL).map((r) => r.basis), ["none"]);
});

test("the basis is the tasks with a share on the subscription: tasks that did not use it are left out", () => {
  const history = [
    entry("T-1", "feature", 100),
    entry("T-2", "feature", 200),
    entry("T-3", "feature", 0, 300),
    entry("T-4", "feature", 300),
  ];
  const claude = rangedOnly(estimateFromSignals([openItem("B-9", { type: "feature" })], history, CAL));
  assert.deepEqual([claude.basis, claude.count], ["wide", 3]);
  const codex = only1(estimateFromSignals([openItem("B-9", { type: "feature" })], history, CAL, "codex"));
  assert.equal(codex.subscription, "codex");
  assert.equal(codex.basis, "none");
});

test("the estimate names the subscription and uses its calibration", () => {
  const history = [100, 200, 300].map((w, i) => entry(`T-${i}`, "feature", 0, w));
  const result = rangedOnly(
    estimateFromSignals([openItem("B-9", { type: "feature" })], history, { claude: ready(1), codex: ready(50) }, "codex"),
  );
  assert.equal(result.subscription, "codex");
  close(result.lowPct, 120 / 50);
  close(result.highPct, 280 / 50);
});

test("with no ready calibration on the subscription there is no basis", () => {
  const history = [100, 200, 300].map((w, i) => entry(`T-${i}`, "feature", w));
  const result = only1(estimateFromSignals([openItem("B-9", { type: "feature" })], history, { claude: NOT_READY, codex: ready(1) }));
  assert.equal(result.basis, "none");
});

test("one estimate per open item, in the order given; the inputs are not changed", () => {
  const items: OpenItem[] = [openItem("B-2"), openItem("B-1", { type: "bug" })];
  const history = [100, 200, 300].map((w, i) => entry(`T-${i}`, "bug", w));
  const before = JSON.stringify([items, history]);
  const results = estimateFromSignals(items, history, CAL);
  assert.deepEqual(results.map((r) => r.key), ["B-2", "B-1"]);
  assert.equal(JSON.stringify([items, history]), before);
});

test("the estimate input: subscription defaults to claude; a bad label is refused and counted; a bad envelope is usage_error", () => {
  const parsed = must(
    parseEstimateInput(JSON.stringify({ items: [{ key: "B-1", tags: { type: "bug" } }, { key: "bad key", tags: {} }] })),
  );
  assert.deepEqual(parsed, { subscription: "claude", items: [openItem("B-1", { type: "bug" })], refused: 1, featuresRefused: 0 });
  assert.equal(must(parseEstimateInput(JSON.stringify({ subscription: "codex", items: [] }))).subscription, "codex");
  for (const text of [
    "{nope",
    "[]",
    JSON.stringify({ subscription: "gemini", items: [] }),
    JSON.stringify({ items: "x" }),
    JSON.stringify({ items: Array.from({ length: SYNC_MAX_OPEN_ITEMS + 1 }, (_, i) => ({ key: `B-${i}`, tags: {} })) }),
    " ".repeat(SYNC_MAX_BYTES + 1),
  ]) {
    assert.equal(JSON.stringify(parseEstimateInput(text)), JSON.stringify({ ok: false, error: errorRecord("usage_error") }));
  }
});
