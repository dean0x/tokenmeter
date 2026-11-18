#!/usr/bin/env node
// The tokenmeter command shim uses plain JavaScript so an old Node can run it.
//
// `record` imports only dist/record.js. It prints its input and exits 0.
// If Node is too old or the import fails, it pipes stdin to stdout.
// `statusline` imports only dist/statusline.js. It prints one short line and exits 0.
// If Node is too old or the import fails, it prints a fixed short line.
// `refresh` does quota work without output and does not open stdin.
// `hud` reads stored quota and prints one JSON envelope without opening stdin.
// Other commands check the Node version first. Then dist/cli.js prints one JSON envelope.

const [major = 0] = process.versions.node.split(".").map(Number);
const nodeOk = major >= 22;

function failure(code, hint) {
  process.stdout.write(`${JSON.stringify({ schema: "tokenmeter.v1", ok: false, error: { code, hint } })}\n`);
  process.exitCode = 1;
}

function exitZeroAlways() {
  process.exitCode = 0;
  process.on("uncaughtException", () => {
    process.exitCode = 0;
  });
}

function passThrough() {
  try {
    process.stdin.pipe(process.stdout);
  } catch {
    // No usable stream: there is nothing to pass on.
  }
}

// The writer of the statusline JSON is not cut off: stdin is read to its end.
function printLine(text) {
  try {
    process.stdout.write(`${text}\n`);
    if (!process.stdin.isTTY) process.stdin.resume();
  } catch {
    // No usable stream: there is nothing to print.
  }
}

if (process.argv[2] === "record") {
  exitZeroAlways();
  if (nodeOk) {
    import("../dist/record.js").then((record) => record.recordMain().then(undefined, () => undefined), passThrough);
  } else {
    passThrough();
  }
} else if (process.argv[2] === "statusline") {
  exitZeroAlways();
  if (nodeOk) {
    import("../dist/statusline.js").then(
      (line) => line.statuslineMain().then(undefined, () => undefined),
      () => printLine("tokenmeter: unavailable"),
    );
  } else {
    printLine("tokenmeter: needs Node 22.0");
  }
} else if (process.argv[2] === "refresh") {
  if (nodeOk) import("../dist/refresh.js").then((module) => module.refreshMain()).catch(() => undefined);
} else if (nodeOk && process.argv[2] === "hud") {
  import("../dist/hud.js").then(
    (hud) => hud.hudMain(import.meta.filename),
    () => failure("internal_error", "An internal error occurred."),
  );
} else if (nodeOk) {
  import("../dist/cli.js").then(
    (cli) => cli.cliMain(),
    () => failure("internal_error", "An internal error occurred."),
  );
} else {
  failure("node_too_old", "Node 22.0 or newer is required.");
}
