import type { Rly0AppearanceAutostartResult } from "@codexhost/shared-contracts";

import { resolveRly0LauncherCommand } from "./windows-autostart.js";
import type { Rly0AutostartRegistry } from "./autostart-registry.js";

export type { Rly0AutostartRegistry } from "./autostart-registry.js";

export interface Rly0AppearanceManagerOptions {
  /** Omitted (the default) on any platform/build with no safe registry implementation wired up. */
  readonly registry?: Rly0AutostartRegistry;
  readonly platform?: NodeJS.Platform;
  readonly launcherCommand?: string;
}

/** Backs the appearance page's "开机自启" (autostart) toggle. Windows-only; a no-op elsewhere. */
export class Rly0AppearanceManager {
  readonly #registry: Rly0AutostartRegistry | undefined;
  readonly #platform: NodeJS.Platform;
  readonly #launcherCommand: string;

  constructor(options: Rly0AppearanceManagerOptions = {}) {
    this.#registry = options.registry;
    this.#platform = options.platform ?? process.platform;
    this.#launcherCommand = options.launcherCommand ?? resolveRly0LauncherCommand();
  }

  get supported(): boolean {
    return this.#platform === "win32" && this.#registry !== undefined;
  }

  async autostartStatus(): Promise<Rly0AppearanceAutostartResult> {
    if (!this.supported || !this.#registry) return { supported: false, enabled: false };
    const current = await this.#registry.get();
    return { supported: true, enabled: current !== null };
  }

  async setAutostart(enabled: boolean): Promise<Rly0AppearanceAutostartResult> {
    if (!this.supported || !this.#registry) return { supported: false, enabled: false };
    if (enabled) await this.#registry.set(this.#launcherCommand);
    else await this.#registry.remove();
    return this.autostartStatus();
  }
}

/** Maps a rejected `Rly0AppearanceManager` call to a JSON-RPC error without leaking detail. */
export function rly0AppearanceRpcError(): { code: number; message: string } {
  return { code: -32000, message: "APPEARANCE_OPERATION_FAILED" };
}
