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
 * Each filename/export pair is a pinned, reviewed 26.1027 native contract, not a
 * version comparison. Rspack builds (26.1029+) are found by capability detection in
 * the already-populated webpack module cache instead of by name. Unknown contracts remain unavailable for external draft creation.
 * Self-contained because the Controller embeds this loader in the Renderer.
 */
export async function loadRendererHostRpcRegistry(
  store: unknown,
  target: { location?: { href: string }; [key: string]: unknown },
  importModule: (url: string) => Promise<Record<string, unknown>> = (url) => import(url),
  options: {
    /** Rspack only: how long to wait for the lazily loaded registry chunk. */
    timeoutMs?: number;
    /** Rspack only: module-cache poll interval. */
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Receives a short reason whenever the loader fails closed. */
    onUnavailable?: (reason: string) => void;
  } = {},
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
  const isRegistry = (value: unknown): boolean =>
    record(value) &&
    typeof value.forHost === "function" &&
    typeof value.collectAppStateSnapshot === "function" &&
    typeof value.getReviewPaneSnapshotMetrics === "function" &&
    typeof value.dispose === "function";
  const isDefinition = (value: unknown): value is Record<string, unknown> =>
    record(value) &&
    value.cache === "signal" &&
    value.scope === store.token &&
    typeof value.resolve === "function";
  const signals = store.signalBindings as { get(key: object): unknown };
  const values = store.store as { get(key: object): unknown };
  // Each captured Vite bundle exports the same root registry signal under its own name.
  const contracts = new Map([
    ["app-initial-4267e52fe5b0.js", "mpr"], // Desktop 26.1027.3384.0
    ["app-initial-fb51ee65d20a.js", "vpr"], // Desktop 26.1027.6604.0
  ]);
  // Rspack builds (Desktop 26.1029+) name chunks `<numeric id>.<hash>.js` and the
  // entry/runtime chunk exports `__webpack_require__`, whose `.c` is the module cache.
  const rspackChunk = /^\d+\.[0-9a-f]{8,}\.js$/;
  const urls = new Map<string, string>();
  const rspackUrls: string[] = [];
  const pageUrl = new URL(page);
  for (const source of catalog.urls) {
    if (typeof source !== "string") return null;
    let url: URL;
    try {
      url = new URL(source, pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== pageUrl.protocol || url.host !== pageUrl.host || url.search || url.hash)
      continue;
    const file = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
    const contract = contracts.get(file);
    if (contract !== undefined) urls.set(url.href, contract);
    else if (rspackChunk.test(file) && !url.pathname.includes("/async/")) rspackUrls.push(url.href);
  }
  let moduleUrl: string;
  let definition: Record<string, unknown>;
  if (urls.size === 1) {
    // Reviewed Vite contract (Desktop 26.1027 and earlier).
    const [[legacyUrl, exportName]] = [...urls] as [[string, string]];
    const module = await importModule(legacyUrl);
    if (target.__codexhostLoadedModulesV1 !== catalog) return null;
    const legacy = module[exportName];
    if (!isDefinition(legacy)) return null;
    moduleUrl = legacyUrl;
    definition = legacy;
  } else if (urls.size === 0 && rspackUrls.length > 0 && rspackUrls.length <= 64) {
    // Capability detection: only already-loaded entry chunks are imported (same
    // instance as the page's module scripts) and only already-evaluated modules in the
    // webpack module cache are inspected. A definition qualifies only when it passes the
    // signal contract, is already bound, and its bound value has the registry shape.
    // Fail closed unless exactly one entry chunk and exactly one definition qualify.
    const runtimes: Array<{ url: string; cache: Record<string, unknown> }> = [];
    for (const url of rspackUrls) {
      let module: Record<string, unknown>;
      try {
        module = await importModule(url);
      } catch {
        continue;
      }
      if (target.__codexhostLoadedModulesV1 !== catalog) return null;
      const runtime = module.__webpack_require__;
      if (typeof runtime === "function" && record((runtime as { c?: unknown }).c))
        runtimes.push({ url, cache: (runtime as unknown as { c: Record<string, unknown> }).c });
    }
    if (runtimes.length !== 1) return null;
    const [{ url: runtimeUrl, cache }] = runtimes as [
      { url: string; cache: Record<string, unknown> },
    ];
    // Desktop 26.1029 lazy-loads the chunk that defines the registry (ComposerLayoutRoot)
    // after the main composer renders, so poll the module cache for a bounded time. Never
    // trigger chunk loads ourselves: that would initialize unloaded Desktop modules.
    const timeoutMs = Math.max(0, Math.min(options.timeoutMs ?? 10_000, 60_000));
    const intervalMs = Math.max(10, options.intervalMs ?? 250);
    const sleep =
      options.sleep ??
      ((ms: number) => new Promise<void>((resolve) => globalThis.setTimeout(resolve, ms)));
    const now = options.now ?? (() => Date.now());
    const fail = (reason: string) => {
      try {
        options.onUnavailable?.(reason);
      } catch {
        // diagnostics must never change the outcome
      }
      return null;
    };
    // Lazy chunk loads replace the catalog; accept only same-owner, same-page updates.
    const sameCatalog = () => {
      const current = target.__codexhostLoadedModulesV1;
      return (
        record(current) &&
        current.owner === catalog.owner &&
        current.complete === true &&
        current.documentUrl === page &&
        Array.isArray(current.urls) &&
        current.urls.includes(runtimeUrl)
      );
    };
    const scan = (): Set<Record<string, unknown>> | null => {
      const found = new Set<Record<string, unknown>>();
      for (const id of Object.keys(cache)) {
        const entry = cache[id];
        if (!record(entry) || entry.error !== undefined || !record(entry.exports)) continue;
        const exports = entry.exports;
        for (const key of Object.keys(exports)) {
          let candidate: unknown;
          try {
            candidate = exports[key];
          } catch {
            continue;
          }
          if (!isDefinition(candidate) || found.has(candidate)) continue;
          const bound = signals.get(candidate);
          if (record(bound) && isRegistry(values.get(bound))) found.add(candidate);
        }
        if (found.size > 1) return null;
      }
      return found;
    };
    const deadline = now() + timeoutMs;
    let found = scan();
    while (found !== null && found.size === 0 && now() < deadline) {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
      if (!sameCatalog()) return fail("renderer module catalog changed while waiting");
      found = scan();
    }
    if (found === null) return fail("more than one renderer host RPC registry signal is bound");
    if (found.size !== 1)
      return fail(
        `renderer host RPC registry was not loaded within ${timeoutMs}ms (Rspack module cache)`,
      );
    moduleUrl = runtimeUrl;
    [definition] = [...found] as [Record<string, unknown>];
  } else return null;
  const atom = signals.get(definition);
  if (!record(atom)) return null;
  const registry = values.get(atom);
  if (!isRegistry(registry)) return null;
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
        current.urls.includes(moduleUrl) &&
        signals.get(definition) === atom &&
        values.get(atom) === registry
      );
    },
  };
}
