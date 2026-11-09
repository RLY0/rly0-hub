import { CdpClient, listCdpTargets } from "./cdp-client.js";
import {
  selectPrimaryRendererTarget,
  type RendererCdpControlSession,
} from "./renderer-cdp-control-session.js";
import type { CodexRendererPolicy } from "@codexhost/shared-contracts";
import { codexUpdateHoldScript } from "./codex-update-hold.js";

/** Passive data bridge for Claude's quota/balance view; no React discovery, RPC patch or composer. */
export function coreRendererBootstrap(policy: CodexRendererPolicy): string {
  // The update hold is independent: its failure is recorded by itself and never stops the bridge.
  return `try { ${codexUpdateHoldScript(policy.holdUpdates === true)} } catch {}
  (() => {
    globalThis.__codexhostFeaturePolicyV1 = ${JSON.stringify(policy)};
    globalThis.__codexhostCoreUsageV1 = { available: false, checkedAt: null, quota: null, balance: null };
    globalThis.dispatchEvent(new CustomEvent('codexhost:core-usage'));
    return true;
  })()`;
}
export async function createCoreRendererSession(options: {
  rendererCdpEndpoint: string;
  policy: CodexRendererPolicy;
}): Promise<RendererCdpControlSession> {
  const target = selectPrimaryRendererTarget(await listCdpTargets(options.rendererCdpEndpoint));
  if (!target) throw new Error("CORE_RENDERER_UNAVAILABLE");
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  const snapshot = {
    target,
    draftPrewarmPolicy: { state: "disabled" as const, reason: "core-no-patches" as const },
    binding: {
      version: 2 as const,
      enabledAgents: [],
      adapter: { state: "ready" as const, reason: "core-data-only" },
    },
  };
  try {
    if ((await client.evaluate(coreRendererBootstrap(options.policy))) !== true)
      throw new Error("CORE_RENDERER_FAILED");
  } catch (error) {
    client.close();
    throw error;
  }
  return {
    snapshot,
    async ensureInstalled() {
      const current = selectPrimaryRendererTarget(
        await listCdpTargets(options.rendererCdpEndpoint),
      );
      if (!current || current.id !== target.id) throw new Error("CORE_RENDERER_CHANGED");
      if (!(await client.evaluate("!!globalThis.__codexhostCoreUsageV1")))
        if ((await client.evaluate(coreRendererBootstrap(options.policy))) !== true)
          throw new Error("CORE_RENDERER_FAILED");
      return snapshot;
    },
    async activateDesktop() {
      await client.command("Page.bringToFront");
      return 1;
    },
    executeRenderer: (expression) => client.evaluate(expression),
    async dispose() {
      await client.evaluate("delete globalThis.__codexhostCoreUsageV1").catch(() => undefined);
      client.close();
    },
    close: () => client.close(),
  };
}
