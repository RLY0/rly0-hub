import { promises as fs } from "node:fs";
import path from "node:path";

import type { Rly0CodexProcessControl } from "./process-control.js";

/** Must match `crates/launcher/src/desktop_control_request.rs`. */
export const DESKTOP_CONTROL_REQUEST_FILE = "desktop-control-request.json";
/** Lets the RPC reply reach the renderer before the Launcher stops the Desktop. */
const DEFAULT_REQUEST_DELAY_MS = 400;

export interface LauncherProcessControlOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly requestDelayMs?: number;
}

interface LauncherIdentity {
  readonly launcherPid: number;
  readonly nonce: string;
  readonly requestPath: string;
}

function launcherIdentity(environment: NodeJS.ProcessEnv): LauncherIdentity | null {
  const pidText = environment.CODEXHOST_LAUNCHER_PID ?? "";
  const descriptorPath = environment.CODEXHOST_RUNTIME_DESCRIPTOR_PATH ?? "";
  const nonce = environment.CODEXHOST_CONTROL_NONCE ?? "";
  if (!/^[1-9]\d{0,9}$/u.test(pidText) || !nonce || !path.isAbsolute(descriptorPath)) return null;
  const launcherPid = Number(pidText);
  if (!Number.isSafeInteger(launcherPid) || launcherPid > 0xffff_ffff) return null;
  return {
    launcherPid,
    nonce,
    requestPath: path.join(path.dirname(descriptorPath), DESKTOP_CONTROL_REQUEST_FILE),
  };
}

/**
 * Force quit / restart through the RLY/0 Hub Launcher that owns this Desktop. The Host lives in
 * the Desktop's own process tree, so it never kills processes itself: it leaves one request file
 * next to the Launcher's runtime descriptor (same per-launch nonce the Launcher handed the
 * Desktop), and the Launcher, running outside the Desktop, stops it and, for a restart, launches
 * it again. Returns `undefined` when this Host was not started by such a Launcher (or not on
 * Windows), so the maintenance page reports the action as unsupported instead of guessing.
 */
export function createLauncherProcessControl(
  options: LauncherProcessControlOptions,
): Rly0CodexProcessControl | undefined {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  const identity = launcherIdentity(options.environment);
  if (!identity) return undefined;
  const delay = options.requestDelayMs ?? DEFAULT_REQUEST_DELAY_MS;

  const request = async (action: "quit" | "restart"): Promise<boolean> => {
    const directory = path.dirname(identity.requestPath);
    try {
      const stat = await fs.stat(directory);
      if (!stat.isDirectory()) return false;
    } catch {
      return false;
    }
    const body = `${JSON.stringify({
      schemaVersion: 1,
      launcherPid: identity.launcherPid,
      nonce: identity.nonce,
      action,
    })}\n`;
    const write = async (): Promise<void> => {
      const temporary = `${identity.requestPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
        await fs.rename(temporary, identity.requestPath);
      } catch {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
      }
    };
    if (delay <= 0) {
      await write();
    } else {
      // Not unref'd: the Host stays alive until the request is on disk.
      setTimeout(() => void write(), delay);
    }
    return true;
  };

  return {
    forceQuit: () => request("quit"),
    restart: () => request("restart"),
  };
}
