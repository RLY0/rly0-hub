import type { RendererHostRpc } from "./renderer-host-rpc-discovery.js";

export interface RendererHostRpcRegistry {
  forHost(hostId: string): RendererHostRpc;
  collectAppStateSnapshot(hostId: string, reason: string): Promise<unknown>;
  getReviewPaneSnapshotMetrics(hostId: string): unknown;
  dispose(): void;
}

export interface RendererHostRpcRegistryBinding {
  readonly registry: RendererHostRpcRegistry;
  isCurrent(): boolean;
}

/** Read one reviewed, already bound signal. Never resolve arbitrary atoms or
 * initialize an unloaded Desktop module while looking for a writable registry.
 * The filename/export pair is the pinned 26.1027 native contract, not a version
 * comparison. Unknown contracts remain unavailable for external draft creation.
 * Self-contained because the Controller embeds this loader in the Renderer.
 */
export async function loadRendererHostRpcRegistry(
  store: unknown,
  target: { location?: { href: string }; [key: string]: unknown },
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
): Promise<RendererHostRpcRegistryBinding | null> {
  const record = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null;
  const catalog = target.__codexhostLoadedModulesV1;
  const page = target.location?.href;
  if (
    !page ||
    !record(catalog) ||
    catalog.complete !== true ||
    catalog.documentUrl !== page ||
    !Array.isArray(catalog.urls) ||
    catalog.urls.length > 4096 ||
    !record(store) ||
    !record(store.signalBindings) ||
    typeof store.signalBindings.get !== "function" ||
    !record(store.store) ||
    typeof store.store.get !== "function"
  )
    return null;
  const urls = new Set<string>();
  const pageUrl = new URL(page);
  for (const source of catalog.urls) {
    if (typeof source !== "string") return null;
    let url: URL;
    try {
      url = new URL(source, pageUrl);
    } catch {
      continue;
    }
    if (
      url.protocol === pageUrl.protocol &&
      url.host === pageUrl.host &&
      url.pathname.endsWith("/app-initial-4267e52fe5b0.js") &&
      !url.search &&
      !url.hash
    )
      urls.add(url.href);
  }
  if (urls.size !== 1) return null;
  const module = await importModule([...urls][0] as string);
  if (target.__codexhostLoadedModulesV1 !== catalog) return null;
  // The captured bundle exports its root registry signal as `mpr`.
  const definition = module.mpr;
  if (
    !record(definition) ||
    definition.cache !== "signal" ||
    definition.scope !== store.token ||
    typeof definition.resolve !== "function"
  )
    return null;
  const signals = store.signalBindings as { get(key: object): unknown };
  const atom = signals.get(definition);
  if (!record(atom)) return null;
  const values = store.store as { get(key: object): unknown };
  const registry = values.get(atom);
  if (
    !record(registry) ||
    typeof registry.forHost !== "function" ||
    typeof registry.collectAppStateSnapshot !== "function" ||
    typeof registry.getReviewPaneSnapshotMetrics !== "function" ||
    typeof registry.dispose !== "function"
  )
    return null;
  return {
    registry: registry as unknown as RendererHostRpcRegistry,
    isCurrent() {
      const current = target.__codexhostLoadedModulesV1;
      return (
        record(current) &&
        current.owner === catalog.owner &&
        current.complete === true &&
        current.documentUrl === page &&
        Array.isArray(current.urls) &&
        current.urls.includes([...urls][0]) &&
        signals.get(definition) === atom &&
        values.get(atom) === registry
      );
    },
  };
}
