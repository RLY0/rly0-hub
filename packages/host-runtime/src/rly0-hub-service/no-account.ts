import type { Rly0Relay } from "@codexhost/shared-contracts";

import type { Rly0RelayCodexConfigManager } from "../rly0-relay/codex-config.js";
import { isCodexFamilyModel } from "../rly0-relay/model-routing.js";

/**
 * No-account mode: Codex uses relay GPT models through RLY/0 Hub's local proxy without an OpenAI
 * login. It changes `~/.codex/config.toml` (backed up first), so the Hub only applies it after the
 * person has seen the exact changes, and restores it with one click.
 */
export interface Rly0NoAccountStatus {
  readonly enabled: boolean;
  readonly model?: string;
  readonly configPath: string;
  /** GPT-family models the enabled relays list; one becomes Codex's default model. */
  readonly models: readonly string[];
}

export function relayCodexModels(relays: readonly Rly0Relay[]): string[] {
  const models = new Set<string>();
  for (const relay of relays) {
    if (!relay.enabled || !relay.hasKey) continue;
    for (const model of relay.models)
      if (!model.endsWith("*") && isCodexFamilyModel(model)) models.add(model);
  }
  return [...models].sort();
}

export async function noAccountStatus(
  config: Rly0RelayCodexConfigManager,
  relays: readonly Rly0Relay[],
): Promise<Rly0NoAccountStatus> {
  const status = await config.status();
  return {
    enabled: status.noAccount === true,
    ...(status.noAccount && status.model ? { model: status.model } : {}),
    configPath: status.configPath,
    models: relayCodexModels(relays),
  };
}
