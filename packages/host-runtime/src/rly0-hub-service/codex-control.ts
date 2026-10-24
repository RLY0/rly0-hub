import { spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { RLY0_APP_DATA_DIRECTORY_NAME } from "@codexhost/shared-contracts";

import { createLauncherProcessControl } from "../rly0-maintenance/launcher-process-control.js";

/** Must match `crates/launcher/src/runtime_instance.rs`. */
export const RLY0_RUNTIME_DESCRIPTOR_FILE = "desktop-runtime-v1.json";

export interface Rly0CodexStatus {
  /** A Codex Desktop started by the RLY/0 Hub Launcher is running now. */
  readonly running: boolean;
  /** This build can start Codex (the Launcher is installed next to the Hub). */
  readonly canOpen: boolean;
}

interface Descriptor {
  readonly launcherPid: number;
  readonly nonce: string;
}

export interface Rly0CodexControlOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly installRoot: string;
  readonly platform?: NodeJS.Platform;
  readonly isAlive?: (pid: number) => boolean;
  readonly startDetached?: (executable: string) => void;
  readonly fileExists?: (file: string) => boolean;
  /** Whether the Codex side's heartbeat is fresh (Codex open through RLY/0 Hub). */
  readonly heartbeatAlive?: () => Promise<boolean>;
  /**
   * Ends Codex's processes directly (`codex-processes.ts`) when the Launcher cannot: Codex opened
   * some other way, or the Launcher already exited. Returns how many were ended. Without it,
   * quitting and restarting only work through the Launcher.
   */
  readonly killProcesses?: () => Promise<number>;
  /** Pause between ending Codex and opening it again on a direct restart. */
  readonly restartDelayMs?: number;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function startDetached(executable: string): void {
  const child = spawn(executable, [], {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
    cwd: path.dirname(executable),
  });
  child.on("error", () => undefined);
  child.unref();
}

/**
 * Opens and restarts Codex from outside it. Opening runs the Launcher's own Start entry (it
 * focuses an already running Codex instead of starting a second one). Restarting uses the same
 * request file the in-Codex maintenance page writes, addressed with the running Launcher's PID and
 * per-launch nonce from its runtime descriptor; the Launcher ignores anything else.
 */
export class Rly0CodexControl {
  readonly #options: Rly0CodexControlOptions;

  constructor(options: Rly0CodexControlOptions) {
    this.#options = options;
  }

  #descriptorPath(): string | null {
    const root = this.#options.environment.LOCALAPPDATA;
    return root
      ? path.join(root, RLY0_APP_DATA_DIRECTORY_NAME, RLY0_RUNTIME_DESCRIPTOR_FILE)
      : null;
  }

  #startExecutable(): string {
    if ((this.#options.platform ?? process.platform) === "darwin") {
      return path.posix.join(this.#options.installRoot, "bin", "codexhost");
    }
    return path.join(this.#options.installRoot, "bin", "codexhost-start.exe");
  }

  async #descriptor(): Promise<Descriptor | null> {
    const file = this.#descriptorPath();
    if (!file) return null;
    try {
      const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      const launcherPid = value.launcherPid;
      const nonce = value.nonce;
      if (
        typeof launcherPid !== "number" ||
        !Number.isSafeInteger(launcherPid) ||
        launcherPid <= 0 ||
        typeof nonce !== "string" ||
        !/^[0-9a-f]{16,128}$/iu.test(nonce)
      ) {
        return null;
      }
      return (this.#options.isAlive ?? processAlive)(launcherPid) ? { launcherPid, nonce } : null;
    } catch {
      return null;
    }
  }

  #windows(): boolean {
    return (this.#options.platform ?? process.platform) === "win32";
  }

  async status(): Promise<Rly0CodexStatus> {
    const platform = this.#options.platform ?? process.platform;
    const canOpen =
      (this.#windows() || platform === "darwin") &&
      (this.#options.fileExists ?? existsSync)(this.#startExecutable());
    // The Launcher's descriptor, or the Codex side's own heartbeat (the Launcher may have exited
    // while Codex keeps running).
    const running =
      (await this.#descriptor()) !== null ||
      (await (this.#options.heartbeatAlive ?? (() => Promise.resolve(false)))());
    return { running, canOpen };
  }

  async open(): Promise<{ ok: boolean }> {
    if (!(await this.status()).canOpen) return { ok: false };
    (this.#options.startDetached ?? startDetached)(this.#startExecutable());
    return { ok: true };
  }

  /**
   * Through the Launcher first; then whatever is left of Codex is ended directly (when allowed),
   * so a Codex opened without the Launcher, or a stuck helper, also goes away.
   */
  async forceQuit(): Promise<{ ok: boolean; killed?: number }> {
    const viaLauncher = (await this.#request("quit")).ok;
    if (!this.#options.killProcesses) return { ok: viaLauncher };
    const killed = await this.#options.killProcesses().catch(() => 0);
    return { ok: viaLauncher || killed > 0, killed };
  }

  /** Through the Launcher; otherwise end Codex directly and open it again. */
  async restart(): Promise<{ ok: boolean }> {
    if ((await this.#request("restart")).ok) return { ok: true };
    if (!this.#options.killProcesses) return { ok: false };
    const killed = await this.#options.killProcesses().catch(() => 0);
    if (killed === 0 && !(await this.status()).running) return { ok: false };
    await new Promise((resolve) => setTimeout(resolve, this.#options.restartDelayMs ?? 1500));
    return this.open();
  }

  async #request(action: "quit" | "restart"): Promise<{ ok: boolean }> {
    const descriptor = await this.#descriptor();
    const descriptorPath = this.#descriptorPath();
    if (!descriptor || !descriptorPath) return { ok: false };
    const control = createLauncherProcessControl({
      environment: {
        CODEXHOST_LAUNCHER_PID: String(descriptor.launcherPid),
        CODEXHOST_RUNTIME_DESCRIPTOR_PATH: descriptorPath,
        CODEXHOST_CONTROL_NONCE: descriptor.nonce,
      },
      ...(this.#options.platform ? { platform: this.#options.platform } : {}),
      requestDelayMs: 0,
    });
    return {
      ok: control ? await (action === "quit" ? control.forceQuit() : control.restart()) : false,
    };
  }
}
