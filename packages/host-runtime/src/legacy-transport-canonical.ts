import {
  decodeExternalTransportSelection,
  encodePiTransportModel,
  encodeClaudeTransportModel,
  encodeDeepSeekHarnessTransportModel,
  encodeOpenCodeTransportModel,
  encodeGrokTransportModel,
  encodeOmpTransportModel,
  encodeAntigravityTransportModel,
} from "@codexhost/protocol-core";
import { isDeepStrictEqual } from "node:util";

import type { TransportCanonicalizer } from "./legacy-codexhost-import.js";

/**
 * Re-encodes a chat's model choice the way the Hub writes it for its own chats, so chats brought
 * over from upstream CodexHost (generic `codexhost/plugin-v1@…` form) can be continued. Kept out
 * of `legacy-codexhost-import.ts` so the Hub window's service bundle does not pull in
 * protocol-core; only the Host runtime (which opens the thread store) passes it.
 */
export const canonicalTransportModelId: TransportCanonicalizer = (harnessId, transportModelId) => {
  const selection = decodeExternalTransportSelection(harnessId, transportModelId);
  if (!selection) return null;
  // Generic plugin encoding is now the upstream default. This legacy repair still needs
  // the explicit native encoder; calling the generic encoder would leave the record unchanged.
  let canonical: string;
  switch (harnessId) {
    case "pi":
      canonical = encodePiTransportModel(selection.model, selection.thinkingOptionId);
      break;
    case "claude-code":
      canonical = encodeClaudeTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
      break;
    case "deepseek-harness":
      canonical = encodeDeepSeekHarnessTransportModel(selection.model, selection.permissionModeId);
      break;
    case "opencode":
      canonical = encodeOpenCodeTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
      break;
    case "grok":
      canonical = encodeGrokTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
      break;
    case "omp":
      canonical = encodeOmpTransportModel(
        selection.model,
        selection.thinkingOptionId,
        selection.permissionModeId,
      );
      break;
    case "antigravity":
      canonical = encodeAntigravityTransportModel(
        selection.model,
        selection.permissionModeId,
        selection.thinkingOptionId,
      );
      break;
    default:
      return null;
  }
  // Some native formats cannot express every modern plugin selection (e.g. DeepSeek thinking).
  // Preserve the original route whenever rewriting would lose a field.
  if (!isDeepStrictEqual(decodeExternalTransportSelection(harnessId, canonical), selection))
    return null;
  return canonical !== transportModelId ? canonical : null;
};
