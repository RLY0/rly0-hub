import type {
  Rly0Account,
  Rly0AccountsImportCurrentParams,
  Rly0AccountsImportCurrentResult,
  Rly0AccountsListResult,
  Rly0AccountsRemoveParams,
  Rly0AccountsRemoveResult,
  Rly0AccountsRenameParams,
  Rly0AccountsRenameResult,
  Rly0AccountsSwitchParams,
  Rly0AccountsSwitchResult,
  Rly0CoreStatusResult,
} from "@codexhost/shared-contracts";
import { Rly0CoreClient, type Rly0CoreClientOptions } from "./client.js";

export { Rly0CoreClient, resolveRly0CoreBinaryPath } from "./client.js";
export type { Rly0CoreClientOptions, Rly0CoreResponse } from "./client.js";

interface CoreHelloResult {
  readonly name: string;
  readonly version: string;
  readonly capabilities: string[];
}

/**
 * Typed facade over `Rly0CoreClient`, shaping raw JSON-RPC results into the shared-contracts
 * result unions (always including the `available` discriminant) so `app-server-host.ts` only
 * has to parse and forward.
 */
export class Rly0CoreBridge {
  readonly #client: Rly0CoreClient;

  constructor(options: Rly0CoreClientOptions = {}) {
    this.#client = new Rly0CoreClient(options);
  }

  async status(): Promise<Rly0CoreStatusResult> {
    const response = await this.#client.request<CoreHelloResult>("core/hello", {});
    if (!response.available) return { available: false };
    return {
      available: true,
      name: response.result.name,
      version: response.result.version,
      capabilities: response.result.capabilities,
    };
  }

  async listAccounts(): Promise<Rly0AccountsListResult> {
    const response = await this.#client.request<{
      accounts: Rly0Account[];
      liveLoggedIn?: boolean;
      liveUnsaved?: boolean;
    }>("accounts/list", {});
    if (!response.available) return { available: false, accounts: [] };
    return {
      available: true,
      accounts: response.result.accounts,
      ...(response.result.liveLoggedIn === undefined
        ? {}
        : { liveLoggedIn: response.result.liveLoggedIn }),
      ...(response.result.liveUnsaved === undefined
        ? {}
        : { liveUnsaved: response.result.liveUnsaved }),
    };
  }

  async importCurrent(
    params: Rly0AccountsImportCurrentParams,
  ): Promise<Rly0AccountsImportCurrentResult> {
    const response = await this.#client.request<{ id: string }>("accounts/importCurrent", params);
    if (!response.available) return { available: false };
    return { available: true, id: response.result.id };
  }

  async switchAccount(params: Rly0AccountsSwitchParams): Promise<Rly0AccountsSwitchResult> {
    const response = await this.#client.request<{
      switched: boolean;
      requiresRestart?: boolean;
      alias?: string;
      alreadyCurrent?: boolean;
    }>("accounts/switch", params);
    if (!response.available) return { available: false, switched: false };
    return { available: true, ...response.result };
  }

  async rename(params: Rly0AccountsRenameParams): Promise<Rly0AccountsRenameResult> {
    const response = await this.#client.request<{ ok: boolean }>("accounts/rename", params);
    if (!response.available) return { available: false, ok: false };
    return { available: true, ok: response.result.ok };
  }

  async remove(params: Rly0AccountsRemoveParams): Promise<Rly0AccountsRemoveResult> {
    const response = await this.#client.request<{ ok: boolean }>("accounts/remove", params);
    if (!response.available) return { available: false, ok: false };
    return { available: true, ok: response.result.ok };
  }

  async dispose(): Promise<void> {
    await this.#client.dispose();
  }
}

/**
 * Maps a rejected `Rly0CoreBridge` call to a JSON-RPC error to send to the renderer. rly0-core's
 * own business errors already carry a short code (e.g. `CODEX_NOT_LOGGED_IN`) as `error.message`
 * with `error.code === -32000`; that code is safe to forward as-is. Anything else (timeout, crash,
 * malformed response) collapses to a generic code so no path/stack detail can leak.
 */
export function rly0CoreRpcError(error: unknown): { code: number; message: string } {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  if (error instanceof Error && typeof code === "number") {
    return { code, message: error.message || "RLY0_CORE_ERROR" };
  }
  if (error instanceof Error && error.message === "RLY0_CORE_TIMEOUT") {
    return { code: -32000, message: "RLY0_CORE_TIMEOUT" };
  }
  if (error instanceof Error && error.message === "RLY0_CORE_EXITED") {
    return { code: -32000, message: "RLY0_CORE_EXITED" };
  }
  return { code: -32000, message: "RLY0_CORE_ERROR" };
}
