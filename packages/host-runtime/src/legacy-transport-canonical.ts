import {
  decodeExternalTransportSelection,
  encodeExternalTransportSelection,
} from "@codexhost/protocol-core";

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
  const canonical = encodeExternalTransportSelection(harnessId, selection);
  return canonical !== transportModelId ? canonical : null;
};
