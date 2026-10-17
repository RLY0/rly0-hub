import { promises as fs } from "node:fs";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import {
  RLY0_CODEX_PROVIDER_ID,
  RLY0_CODEX_PROVIDER_NAME,
  rly0RelayCodexConfigApplyParamsSchema,
  type Rly0RelayCodexConfigApplyParams,
  type Rly0RelayCodexConfigMutationResult,
  type Rly0RelayCodexConfigStatusResult,
} from "@codexhost/shared-contracts";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { backupAndWriteAtomic, resolveCodexHome } from "../rly0-mcp/file-io.js";
import {
  removeTable,
  removeTopLevelKey,
  setTopLevelKey,
  tomlString,
  upsertTable,
} from "../rly0-mcp/toml-editor.js";

export const RLY0_RELAY_INJECTION_STATE_FILE_NAME = "relay-injection.json";
const PROVIDER_PATH = ["model_providers", RLY0_CODEX_PROVIDER_ID] as const;

/** What the first apply found in config.toml, so "restore official" can put it back. */
interface InjectionState {
  readonly version: 1;
  readonly appliedAt: number;
  readonly setDefault: boolean;
  readonly previous: { readonly modelProvider: string | null; readonly model: string | null };
  /** The `model` value this feature wrote, so restore only reverts it if still unchanged. */
  readonly writtenModel: string | null;
  /** No-account mode was applied (provider written with `requires_openai_auth = false`). */
  readonly noAccount?: boolean;
}

export interface Rly0RelayCodexConfigManagerOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function codedError(code: string): Error {
  return new Error(code);
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function parseConfig(content: string): Record<string, unknown> {
  try {
    return parseToml(content) as Record<string, unknown>;
  } catch {
    throw codedError("CODEX_CONFIG_PARSE_ERROR");
  }
}

function parseState(raw: string | null): InjectionState | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.previous)) return null;
    return {
      version: 1,
      appliedAt: typeof value.appliedAt === "number" ? value.appliedAt : 0,
      setDefault: value.setDefault === true,
      previous: {
        modelProvider: stringOrNull(value.previous.modelProvider),
        model: stringOrNull(value.previous.model),
      },
      writtenModel: stringOrNull(value.writtenModel),
      ...(value.noAccount === true ? { noAccount: true } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Injects / removes the RLY/0 Hub local routing proxy as a Codex model provider in
 * `${CODEX_HOME:-~/.codex}/config.toml`. Edits are line-level (comments preserved), backed up
 * before every write, written atomically, and re-parsed to verify the intended values before the
 * file is replaced. Restore state lives in the RLY/0 Hub data directory, never in `~/.codex`.
 */
export class Rly0RelayCodexConfigManager {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;

  constructor(options: Rly0RelayCodexConfigManagerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  configPath(): string {
    return path.join(resolveCodexHome(this.#environment), "config.toml");
  }

  statePath(): string {
    return path.join(resolveRly0DataDir(this.#environment), RLY0_RELAY_INJECTION_STATE_FILE_NAME);
  }

  async #readState(): Promise<InjectionState | null> {
    return parseState(await readOptional(this.statePath()));
  }

  async #writeState(state: InjectionState): Promise<void> {
    const statePath = this.statePath();
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    const tempPath = `${statePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await fs.rename(tempPath, statePath);
  }

  async status(): Promise<Rly0RelayCodexConfigStatusResult> {
    const configPath = this.configPath();
    const content = await readOptional(configPath);
    const state = await this.#readState();
    const base = {
      configPath,
      configExists: content !== null,
      applied: state !== null,
      ...(state ? { setDefault: state.setDefault } : {}),
    };
    if (content === null) return { ...base, providerPresent: false };
    let parsed: Record<string, unknown>;
    try {
      parsed = parseConfig(content);
    } catch {
      return { ...base, providerPresent: false, parseError: "CODEX_CONFIG_PARSE_ERROR" };
    }
    const providers = isRecord(parsed.model_providers) ? parsed.model_providers : {};
    const provider = providers[RLY0_CODEX_PROVIDER_ID];
    const modelProvider = stringOrNull(parsed.model_provider);
    const model = stringOrNull(parsed.model);
    const providerBaseUrl = isRecord(provider) ? stringOrNull(provider.base_url) : null;
    const catalog = stringOrNull(parsed.model_catalog_json);
    const noAccount = isRecord(provider) && provider.requires_openai_auth === false;
    return {
      ...base,
      providerPresent: isRecord(provider),
      ...(noAccount ? { noAccount: true } : {}),
      ...(providerBaseUrl === null ? {} : { providerBaseUrl: providerBaseUrl.slice(0, 2048) }),
      ...(modelProvider === null ? {} : { modelProvider: modelProvider.slice(0, 128) }),
      ...(model === null ? {} : { model: model.slice(0, 256) }),
      ...(catalog === null ? {} : { modelCatalogJson: catalog.slice(0, 4096) }),
    };
  }

  async apply(input: Rly0RelayCodexConfigApplyParams): Promise<Rly0RelayCodexConfigMutationResult> {
    const params = rly0RelayCodexConfigApplyParamsSchema.parse(input);
    const configPath = this.configPath();
    const content = (await readOptional(configPath)) ?? "";
    const parsed = content.trim() === "" ? {} : parseConfig(content);
    const currentProvider = stringOrNull(parsed.model_provider);
    const currentModel = stringOrNull(parsed.model);

    const existing = await this.#readState();
    // Keep the originally recorded values across repeated applies, unless the earlier apply never
    // touched the top-level keys (then the current values are still the user's own).
    const keepPrevious = existing !== null && existing.setDefault;
    const previous = keepPrevious
      ? existing.previous
      : {
          modelProvider: currentProvider === RLY0_CODEX_PROVIDER_ID ? null : currentProvider,
          model: currentModel,
        };

    let next = upsertTable(content, PROVIDER_PATH, [
      ["name", tomlString(RLY0_CODEX_PROVIDER_NAME)],
      ["base_url", tomlString(params.baseUrl)],
      ["wire_api", tomlString("responses")],
      // Normally Codex attaches its own login so the local proxy can hand models no relay claims
      // back to the official account (the proxy strips it before any relay request). In
      // no-account mode there is no login to attach; only relay models work.
      ["requires_openai_auth", params.noAccount ? "false" : "true"],
    ]);
    if (params.setDefault && params.model !== undefined) {
      next = setTopLevelKey(next, "model_provider", tomlString(RLY0_CODEX_PROVIDER_ID));
      next = setTopLevelKey(next, "model", tomlString(params.model));
    }

    const verified = parseConfig(next);
    const providers = isRecord(verified.model_providers) ? verified.model_providers : {};
    const provider = providers[RLY0_CODEX_PROVIDER_ID];
    const providerOk =
      isRecord(provider) &&
      provider.base_url === params.baseUrl &&
      provider.name === RLY0_CODEX_PROVIDER_NAME &&
      provider.wire_api === "responses" &&
      provider.requires_openai_auth === !params.noAccount;
    const defaultsOk =
      !params.setDefault ||
      (verified.model_provider === RLY0_CODEX_PROVIDER_ID && verified.model === params.model);
    if (!providerOk || !defaultsOk) throw codedError("CODEX_CONFIG_VERIFY_FAILED");

    await this.#writeState({
      version: 1,
      appliedAt: this.#now(),
      setDefault: params.setDefault || (existing?.setDefault ?? false),
      previous,
      writtenModel: params.setDefault ? (params.model ?? null) : (existing?.writtenModel ?? null),
      ...(params.noAccount ? { noAccount: true } : {}),
    });
    if (next !== content) await backupAndWriteAtomic(configPath, next);
    return { ok: true, status: await this.status() };
  }

  /**
   * What `apply` would change, as short human-readable lines, so the person can confirm before
   * anything in `~/.codex/config.toml` is written.
   */
  async preview(
    input: Rly0RelayCodexConfigApplyParams,
  ): Promise<{ configPath: string; changes: string[] }> {
    const params = rly0RelayCodexConfigApplyParamsSchema.parse(input);
    const content = (await readOptional(this.configPath())) ?? "";
    const parsed = content.trim() === "" ? {} : parseConfig(content);
    const changes = [
      `[model_providers.${RLY0_CODEX_PROVIDER_ID}] base_url = "${params.baseUrl}"`,
      `[model_providers.${RLY0_CODEX_PROVIDER_ID}] requires_openai_auth = ${params.noAccount ? "false" : "true"}`,
    ];
    if (params.setDefault && params.model !== undefined) {
      const was = (value: unknown) =>
        typeof value === "string" ? `（原来是 "${value}"）` : "（原来没有）";
      changes.push(`model_provider = "${RLY0_CODEX_PROVIDER_ID}" ${was(parsed.model_provider)}`);
      changes.push(`model = "${params.model}" ${was(parsed.model)}`);
    }
    return { configPath: this.configPath(), changes };
  }

  async restore(): Promise<Rly0RelayCodexConfigMutationResult> {
    const configPath = this.configPath();
    const content = await readOptional(configPath);
    const state = await this.#readState();
    if (content !== null) {
      const parsed = content.trim() === "" ? {} : parseConfig(content);
      let next = removeTable(content, PROVIDER_PATH);
      if (parsed.model_provider === RLY0_CODEX_PROVIDER_ID) {
        const previousProvider = state?.previous.modelProvider ?? null;
        next =
          previousProvider === null
            ? removeTopLevelKey(next, "model_provider")
            : setTopLevelKey(next, "model_provider", tomlString(previousProvider));
      }
      if (
        state?.writtenModel !== null &&
        state?.writtenModel !== undefined &&
        parsed.model === state.writtenModel
      ) {
        next =
          state.previous.model === null
            ? removeTopLevelKey(next, "model")
            : setTopLevelKey(next, "model", tomlString(state.previous.model));
      }
      const verified = next.trim() === "" ? {} : parseConfig(next);
      const providers = isRecord(verified.model_providers) ? verified.model_providers : {};
      if (
        isRecord(providers[RLY0_CODEX_PROVIDER_ID]) ||
        verified.model_provider === RLY0_CODEX_PROVIDER_ID
      ) {
        throw codedError("CODEX_CONFIG_VERIFY_FAILED");
      }
      if (next !== content) await backupAndWriteAtomic(configPath, next);
    }
    await fs.rm(this.statePath(), { force: true });
    return { ok: true, status: await this.status() };
  }
}

const KNOWN_RELAY_CONFIG_ERRORS = new Set([
  "CODEX_CONFIG_PARSE_ERROR",
  "CODEX_CONFIG_VERIFY_FAILED",
]);

export function rly0RelayCodexConfigRpcError(error: unknown): { code: number; message: string } {
  if (error instanceof Error && KNOWN_RELAY_CONFIG_ERRORS.has(error.message)) {
    return { code: -32000, message: error.message };
  }
  return { code: -32000, message: "CODEX_CONFIG_WRITE_FAILED" };
}
