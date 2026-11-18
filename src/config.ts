import { join } from "node:path";
import { asRow, parseJson, type Result } from "./core.ts";
import { defaultDeps, readOwnFile, writeOwnFile, type FsDeps, type FsError } from "./fsafe.ts";

export type AppServerSetting = "on" | "off";
// Change only this constant to change the default for every caller.
export const DEFAULT_APP_SERVER: AppServerSetting = "on";
const CONFIG_FILE = "config.json";
const CONFIG_CAP_BYTES = 4 * 1024;
const CONFIG_VERSION = 1;

export function isAppServerSetting(value: unknown): value is AppServerSetting {
  return value === "on" || value === "off";
}

export function readAppServerSetting(dataDir: string, deps: FsDeps = defaultDeps()): AppServerSetting {
  const text = readOwnFile(join(dataDir, CONFIG_FILE), CONFIG_CAP_BYTES, deps);
  if (!text.ok) return text.error === "missing" ? DEFAULT_APP_SERVER : "off";
  const parsed = parseJson(text.value);
  const row = parsed.ok ? asRow(parsed.value) : null;
  if (row?.["version"] !== CONFIG_VERSION) return "off";
  const setting = row["app_server"];
  return isAppServerSetting(setting) ? setting : "off";
}

export function writeAppServerSetting(
  dataDir: string,
  setting: AppServerSetting,
  deps: FsDeps = defaultDeps(),
): Result<null, FsError> {
  return writeOwnFile(join(dataDir, CONFIG_FILE), JSON.stringify({ version: CONFIG_VERSION, app_server: setting }), deps);
}
