import { readFileSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { rly0ProxySettingsSchema, type Rly0ProxySettings } from "@codexhost/shared-contracts";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export const RLY0_PROXY_SETTINGS_FILE_NAME = "proxy-settings.json";
export const DEFAULT_RLY0_PROXY_SETTINGS: Rly0ProxySettings = Object.freeze({ mode: "system" });

const PROXY_VARIABLE_NAMES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;

export function resolveRly0ProxySettingsPath(environment: NodeJS.ProcessEnv): string {
  return path.join(resolveRly0DataDir(environment), RLY0_PROXY_SETTINGS_FILE_NAME);
}

/**
 * Derives the rly0-core child environment from the user's proxy choice. rly0-core only honours
 * HTTPS_PROXY/HTTP_PROXY, so `custom` sets both spellings; `direct` strips every proxy variable
 * (including ALL_PROXY) so an inherited system proxy cannot leak in; `system` keeps them as-is.
 */
export function applyProxyEnvironment(
  environment: NodeJS.ProcessEnv,
  settings: Rly0ProxySettings,
): NodeJS.ProcessEnv {
  if (settings.mode === "system") return { ...environment };
  const stripped = new Set<string>(PROXY_VARIABLE_NAMES);
  const next: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !stripped.has(name)),
  );
  if (settings.mode === "custom" && settings.url) {
    next.HTTPS_PROXY = settings.url;
    next.https_proxy = settings.url;
    next.HTTP_PROXY = settings.url;
    next.http_proxy = settings.url;
  }
  return next;
}

/** Reads persisted settings; a missing or malformed file falls back to `system`. */
export function readRly0ProxySettingsSync(filePath: string): Rly0ProxySettings {
  try {
    const parsed = rly0ProxySettingsSchema.safeParse(JSON.parse(readFileSync(filePath, "utf8")));
    return parsed.success ? parsed.data : DEFAULT_RLY0_PROXY_SETTINGS;
  } catch {
    return DEFAULT_RLY0_PROXY_SETTINGS;
  }
}

export async function writeRly0ProxySettings(
  filePath: string,
  settings: Rly0ProxySettings,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}
