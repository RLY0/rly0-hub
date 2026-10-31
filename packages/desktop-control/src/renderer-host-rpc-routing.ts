import type {
  findRendererAppScopeStore,
  findRendererHostRpcFamily,
  RendererHostRpc,
  RendererHostRpcDiscovery,
  RendererHostRpcRoot,
  resolveRendererHostRpc,
  rendererHostRpcHostIds,
} from "./renderer-host-rpc-discovery.js";
import type { DraftPrewarmPolicyTarget } from "./renderer-draft-prewarm-runtime.js";
import type { RendererHostRpcRegistryBinding } from "./renderer-host-rpc-registry.js";
import type { RendererHostRoot } from "./renderer-host-discovery.js";
import type {
  RendererHostRoute,
  RendererHostRouting,
  RendererHostRpcManager,
  RendererHostRoutePolicy,
} from "./renderer-host-routing.js";

interface RendererHostRpcDependencies {
  findStore: typeof findRendererAppScopeStore;
  findFamily: typeof findRendererHostRpcFamily;
  resolve: typeof resolveRendererHostRpc;
  hostIds: typeof rendererHostRpcHostIds;
  /** Host identities named by the given Composer (or every mounted Composer). */
  composerHostIds(composer?: RendererHostRoot): { editorCount: number; hostIds: string[] };
  registry: RendererHostRpcRegistryBinding;
  portPrototype: { postMessage(this: unknown, message: unknown, ...rest: unknown[]): unknown };
}

/**
 * Routing for Desktop builds whose AppServerManagers live in the main process.
 * Desktop Hosts its native request policy there, so codexhost cannot replace it;
 * the Host owns external routing and this route only forwards codexhost requests
 * through the native per-Host RPC client.
 * Self-contained for injection; dependencies are supplied by the Controller.
 */
export function installRendererHostRpcRouting(
  root: RendererHostRpcRoot,
  target: DraftPrewarmPolicyTarget,
  dependencies: RendererHostRpcDependencies,
): RendererHostRouting | null {
  const existing = target.__codexhostHostRoutingV1 as RendererHostRouting | undefined;
  if (existing) return existing;
  let disposed = false;
  let discovery: RendererHostRpcDiscovery | null = null;
  const routes = new Map<string, { route: RendererHostRoute; rpc: RendererHostRpc }>();
  const read = (): RendererHostRpcDiscovery | null => {
    if (disposed) return null;
    const store = dependencies.findStore(root);
    if (!store || (discovery && discovery.store !== store)) return null;
    if (!discovery) discovery = dependencies.findFamily(store);
    if (discovery && ![...store.familyBindings.values()].includes(discovery.family)) return null;
    return discovery;
  };
  if (!read()) return null;

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  // Draft creation policy. Desktop's Model hook accepts only catalog Models, so a
  // codexhost carrier never reaches the native collaboration mode. The Renderer
  // still issues each creation call; the selected carrier is applied to that call.
  interface DraftRoute {
    draftId: string;
    model: string | null;
    owner: RendererHostRoutePolicy;
    wireToken: string;
  }
  interface WireOrigin {
    draft: DraftRoute;
  }
  interface CreationPermit {
    owner: RendererHostRoutePolicy;
    method: string;
    model: unknown;
    clientThreadId: unknown;
    current(): boolean;
  }
  const externalDrafts = new Map<string, DraftRoute>();
  // One-shot permits for creations that name their carrier explicitly (a
  // scheduled task's workspace chat), keyed by the Host route that issued them.
  const explicitCreations = new Map<RendererHostRoutePolicy, string[]>();
  // Keep only provenance and tombstones across Controller replacement. A
  // background shallow copy from a retired installation must fail closed when
  // it reaches a new registry wrapper; it must not become an official draft.
  const retained = target.__codexhostRpcDraftProvenanceV1 as
    | {
        key: symbol;
        known: WeakSet<object>;
        retired: Map<string, string>;
        wireOrigins: Map<string, WireOrigin>;
        wireDrafts: Map<string, WireOrigin>;
        permits: Map<string, CreationPermit>;
        portInstalled?: boolean;
      }
    | undefined;
  const provenance = retained ?? {
    key: Symbol("codexhost RPC draft origin"),
    known: new WeakSet<object>(),
    retired: new Map<string, string>(),
    wireOrigins: new Map<string, WireOrigin>(),
    wireDrafts: new Map<string, WireOrigin>(),
    permits: new Map<string, CreationPermit>(),
    portInstalled: false,
  };
  if (!retained)
    Object.defineProperty(target, "__codexhostRpcDraftProvenanceV1", {
      configurable: true,
      value: provenance,
    });
  const retiredDrafts = provenance.retired;
  const draftIdentity = provenance.key;
  const origins = provenance.known;
  const wireField = "__codexhostDraftOriginV1";
  // Desktop 26.1027 exposes two further creation entries beside the two local
  // ones. `prewarmCloudConversation` runs the same shared thread-creation
  // prewarm path for a projectless cloud thread; `prepareThreadStart` prepares
  // a thread-start request. Both receive the active collaboration mode, so both
  // can carry a bound draft's private provenance into the main process.
  const prewarmMethods = new Set(["prewarmConversation", "prewarmCloudConversation"]);
  const cloudCreationMethods = new Set(["prewarmCloudConversation", "prepareThreadStart"]);
  const creationMethods = new Set(["startConversation", "prepareThreadStart", ...prewarmMethods]);
  const prewarmCarrier = (carrier: string): string | null => {
    const prefix = "codexhost/plugin-v1@";
    if (!carrier.startsWith(prefix)) return null;
    try {
      const json = carrier
        .slice(prefix.length)
        .replace(/[a-f0-9]{2}/gu, (byte) => String.fromCharCode(Number.parseInt(byte, 16)));
      const route: unknown = JSON.parse(json);
      if (!isRecord(route)) return null;
      // Schema order keeps the encoding canonical: `prewarm` is its last field.
      const payload = [...JSON.stringify({ ...route, prewarm: true })]
        .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("");
      return `${prefix}${payload}`;
    } catch {
      return null;
    }
  };
  // The draft's workspace reaches the Host only through its prewarm. Publish it
  // so the Composer can ask for that workspace's live Harness commands.
  const publishDraftWorkspace = (hostId: string, cwd: unknown): void => {
    if (typeof cwd !== "string" || cwd.length === 0) return;
    const drafts = isRecord(target.__codexhostDraftWorkspacesV1)
      ? target.__codexhostDraftWorkspacesV1
      : {};
    if (drafts[hostId] === cwd) return;
    drafts[hostId] = cwd;
    Object.defineProperty(target, "__codexhostDraftWorkspacesV1", {
      configurable: true,
      value: drafts,
    });
    if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function") {
      target.dispatchEvent(
        new CustomEvent("codexhost:draft-workspace", { detail: { hostId, cwd } }),
      );
    }
  };
  /** Capture origin before capnweb drops Symbols. Background creation changes
   * clientThreadId but shallow-copies the originating collaboration mode. */
  const routeCreationInput = (
    hostId: string,
    method: string,
    input: unknown,
    options: unknown,
  ): unknown => {
    const mode =
      isRecord(input) && isRecord(input.collaborationMode) ? input.collaborationMode : null;
    const token: unknown = mode ? Reflect.get(mode, draftIdentity) : undefined;
    const draftId = isRecord(options) ? options.clientThreadId : undefined;
    if (typeof draftId === "string" && retiredDrafts.has(draftId))
      throw new Error("Draft route is unavailable; reselect the Agent");
    const explicit = typeof draftId === "string" ? externalDrafts.get(draftId) : undefined;
    let origin: DraftRoute | undefined;
    if (isRecord(token) && origins.has(token)) origin = token as unknown as DraftRoute;
    if (token !== undefined && !origin)
      throw new Error("Draft creation origin is unavailable; reselect the Agent");
    const wireToken = mode?.[wireField];
    if (wireToken !== undefined) {
      const wireOrigin =
        typeof wireToken === "string" ? provenance.wireOrigins.get(wireToken)?.draft : undefined;
      if (!wireOrigin) throw new Error("Draft route is unavailable; reselect the Agent");
      if (origin && origin !== wireOrigin)
        throw new Error("Draft creation origin conflicts with its transport token");
      origin = wireOrigin;
    }
    if (origin && explicit && origin !== explicit)
      throw new Error("Draft creation origin conflicts with its client Thread identity");
    const draft = origin ?? explicit;
    let owned = false;
    if (draft) {
      if (externalDrafts.get(draft.draftId) !== draft)
        throw new Error("Draft route is unavailable; reselect the Agent");
      // Official traffic carries no codexhost Model, so nothing about it can be
      // misrouted; a native cloud prewarm may also target another Host than the
      // draft was selected on. Rewriting the Model is external routing and
      // therefore still requires the called Host to own the draft.
      owned = draft.owner.hostId === hostId && routeFor(hostId)?.policy === draft.owner;
      if (!owned && (draft.model !== null || !cloudCreationMethods.has(method)))
        throw new Error("Draft route is unavailable; reselect the Agent");
      if (typeof draftId === "string" && !explicit) {
        externalDrafts.set(draftId, draft);
        const entry = provenance.wireOrigins.get(draft.wireToken);
        if (entry) provenance.wireDrafts.set(draftId, entry);
      }
    }
    if (method === "prewarmConversation" && isRecord(input) && input.ephemeral !== true)
      publishDraftWorkspace(hostId, input.cwd);
    if (
      !draft &&
      mode &&
      isRecord(mode.settings) &&
      typeof mode.settings.model === "string" &&
      mode.settings.model.startsWith("codexhost/")
    ) {
      // The carrier is already the caller's explicit choice; nothing is rewritten.
      const policy = method === "startConversation" ? routeFor(hostId)?.policy : undefined;
      const pending = policy ? explicitCreations.get(policy) : undefined;
      const index = pending?.indexOf(mode.settings.model) ?? -1;
      if (!pending || index < 0)
        throw new Error("External draft creation is missing its originating draft binding");
      pending.splice(index, 1);
    }
    const cleanMode = mode ? { ...mode } : null;
    if (cleanMode) Reflect.deleteProperty(cleanMode, wireField);
    const model = draft?.model;
    let routed: unknown =
      wireToken !== undefined && isRecord(input)
        ? { ...input, collaborationMode: cleanMode }
        : input;
    if (model) {
      if (!isRecord(input) || !mode || !isRecord(mode.settings))
        throw new Error("External draft creation is missing its native Model settings");
      const routedModel = prewarmMethods.has(method) ? prewarmCarrier(model) : model;
      if (!routedModel) throw new Error("External draft has an invalid transport carrier");
      routed = {
        ...input,
        collaborationMode: { ...cleanMode, settings: { ...mode.settings, model: routedModel } },
      };
    }
    if (!draft || !isRecord(routed) || !isRecord(routed.collaborationMode)) return routed;
    const finalMode = routed.collaborationMode;
    const permit = crypto.randomUUID();
    provenance.permits.set(permit, {
      owner: draft.owner,
      method,
      model: isRecord(finalMode.settings) ? finalMode.settings.model : undefined,
      clientThreadId: draftId,
      current: () =>
        // Only a permit that rewrote the Model rewrote this draft's route; its
        // later tagged frame must still leave through that same route. An
        // official permit proved ownership of nothing beyond this installation.
        (!owned ||
          (routeFor(hostId)?.policy === draft.owner &&
            externalDrafts.get(draft.draftId) === draft)) &&
        dependencies.registry.isCurrent() &&
        registry.forHost === forHost,
    });
    return { ...routed, collaborationMode: { ...finalMode, [wireField]: permit } };
  };

  // tg() can swallow a registry error and return a ready or pending raw RPC.
  // Preserve an opaque origin through that encoding path. Only an invocation
  // checked against its raw RPC receives a one-use send permit; raw fallback
  // origins are rejected, never routed by guessing their destination Host.
  // Remove permits before sending. Untagged native traffic is unchanged. This guard
  // survives Controller detach so delayed tagged calls cannot escape during
  // asynchronous reinstallation; it contains no retired Controller closure.
  if (!provenance.portInstalled) {
    const port = dependencies.portPrototype;
    const originalPost = port.postMessage;
    port.postMessage = function (this: unknown, message: unknown, ...rest: unknown[]): unknown {
      if (Array.isArray(message) && message.length === 2 && message[0] === "push") {
        const expression: unknown = message[1];
        if (Array.isArray(expression) && expression.length === 4 && expression[0] === "pipeline") {
          const path: unknown = expression[2],
            args: unknown = expression[3];
          if (
            Array.isArray(path) &&
            path.length === 1 &&
            typeof path[0] === "string" &&
            creationMethods.has(path[0]) &&
            Array.isArray(args)
          ) {
            const input: unknown = args[0];
            const mode =
              isRecord(input) && isRecord(input.collaborationMode) ? input.collaborationMode : null;
            const options: unknown = args[1];
            const draftId = isRecord(options) ? options.clientThreadId : undefined;
            if (typeof draftId === "string" && provenance.retired.has(draftId))
              throw new Error("Draft route is unavailable; reselect the Agent");
            const tagged = mode && Object.hasOwn(mode, wireField);
            const direct =
              typeof draftId === "string" ? provenance.wireDrafts.get(draftId) : undefined;
            if (tagged) {
              const token: unknown = mode?.[wireField];
              const permit = typeof token === "string" ? provenance.permits.get(token) : undefined;
              if (typeof token === "string") provenance.permits.delete(token);
              const actualModel = mode && isRecord(mode.settings) ? mode.settings.model : undefined;
              if (
                !permit ||
                !permit.current() ||
                permit.method !== path[0] ||
                permit.model !== actualModel ||
                permit.clientThreadId !== draftId
              )
                throw new Error("Draft route is unavailable; reselect the Agent");
              const cleanMode = { ...mode };
              Reflect.deleteProperty(cleanMode, wireField);
              const routed = isRecord(input) ? { ...input, collaborationMode: cleanMode } : input;
              return originalPost.call(
                this,
                ["push", ["pipeline", expression[1], path, [routed, ...args.slice(1)]]],
                ...rest,
              );
            }
            if (direct?.draft.model)
              throw new Error("Draft route is unavailable; reselect the Agent");
          }
        }
      }
      return originalPost.call(this, message, ...rest);
    };
    provenance.portInstalled = true;
  }

  const registry = dependencies.registry.registry;
  const originalForHost = registry.forHost;
  const wrappers = new WeakMap<object, Map<string, RendererHostRpc>>();
  const wrapRpc = (
    rpc: RendererHostRpc,
    hostId: string,
    connection: RendererHostRpc,
  ): RendererHostRpc => {
    let hosts = wrappers.get(rpc);
    if (!hosts) {
      hosts = new Map();
      wrappers.set(rpc, hosts);
    }
    const existing = hosts.get(hostId);
    if (existing) return existing;
    const methods = new Map<PropertyKey, unknown>();
    const wrapped = new Proxy(rpc, {
      get(target, key) {
        if (methods.has(key)) return methods.get(key);
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (typeof key !== "string" || (key !== "dup" && !creationMethods.has(key))) {
          // Remote callable properties expose `.bind` as an RPC path. Preserve
          // those properties unchanged. Only actual local prototype methods
          // (or the plain-object test adapter) require a local receiver.
          let prototype: object | null = Object.getPrototypeOf(target) as object | null;
          let local = typeof target !== "function";
          for (let depth = 0; !local && prototype && depth < 16; depth++) {
            local = Object.getOwnPropertyDescriptor(prototype, key) !== undefined;
            prototype = Object.getPrototypeOf(prototype) as object | null;
          }
          if (!local) return value;
          const bound = (...args: unknown[]): unknown => Reflect.apply(value, target, args);
          methods.set(key, bound);
          return bound;
        }
        const invoke = (...args: unknown[]): unknown => {
          const current = read();
          if (
            !current ||
            !dependencies.registry.isCurrent() ||
            registry.forHost !== forHost ||
            dependencies.resolve(current, hostId) !== connection
          )
            throw new Error("Draft route is unavailable; reselect the Agent");
          if (key === "dup") {
            const copy: unknown = Reflect.apply(value, target, args);
            if ((typeof copy !== "object" || copy === null) && typeof copy !== "function")
              throw new Error("Renderer RPC duplication returned an invalid client");
            return wrapRpc(copy as RendererHostRpc, hostId, connection);
          }
          if (creationMethods.has(key)) {
            const input = routeCreationInput(hostId, key, args[0], args[1]);
            try {
              return Reflect.apply(value, target, [input, ...args.slice(1)]);
            } catch (error) {
              const mode =
                isRecord(input) && isRecord(input.collaborationMode)
                  ? input.collaborationMode
                  : null;
              const permit = mode?.[wireField];
              if (typeof permit === "string") provenance.permits.delete(permit);
              throw error;
            }
          }
          return Reflect.apply(value, target, args);
        };
        methods.set(key, invoke);
        return invoke;
      },
    });
    hosts.set(hostId, wrapped);
    return wrapped;
  };
  const forHost = function (this: unknown, hostId: string): RendererHostRpc {
    let rpc: RendererHostRpc;
    try {
      rpc = originalForHost.call(this, hostId);
    } catch {
      throw new Error("Draft route is unavailable; reselect the Agent");
    }
    // Do not throw an ownership error at this accessor: native tg catches it
    // and takes a raw fallback. The returned client's creation methods reject.
    return wrapRpc(rpc, hostId, rpc);
  };
  registry.forHost = forHost;

  const createRoute = (hostId: string, rpc: RendererHostRpc): RendererHostRoute => {
    let retired = false;
    let selectedModel: string | null = null;
    const isCurrent = (): boolean => {
      const current = read();
      return (
        !retired &&
        !disposed &&
        dependencies.registry.isCurrent() &&
        registry.forHost === forHost &&
        routes.get(hostId)?.rpc === rpc &&
        current !== null &&
        dependencies.resolve(current, hostId) === rpc
      );
    };
    const manager: RendererHostRpcManager = Object.freeze({
      kind: "main-process-rpc" as const,
      getHostId: () => hostId,
      sendRequest(method: string, params: unknown, options?: unknown): Promise<unknown> {
        if (!isCurrent())
          return Promise.reject(new Error(`Renderer request manager is retired for ${hostId}`));
        return options === undefined
          ? rpc.sendRequest(method, params)
          : rpc.sendRequest(method, params, options);
      },
      // The main process broadcasts every app-server notification to its windows,
      // including codexhost methods Desktop's own notification table drops.
      addNotificationCallback(
        methods: string | readonly string[],
        listener: (notification: unknown) => void,
      ): () => void {
        const accepted = new Set(typeof methods === "string" ? [methods] : methods);
        const onMessage = (event: Event): void => {
          const { source, data } = event as Event & { source?: unknown; data?: unknown };
          if (source != null && source !== target) return;
          if (
            !isRecord(data) ||
            data.type !== "mcp-notification" ||
            data.hostId !== hostId ||
            typeof data.method !== "string" ||
            !accepted.has(data.method) ||
            !isCurrent()
          )
            return;
          listener({ method: data.method, params: data.params });
        };
        target.addEventListener?.("message", onMessage);
        return () => target.removeEventListener?.("message", onMessage);
      },
    });
    const clearDrafts = (retiring = false): void => {
      for (const [token, permit] of provenance.permits)
        if (permit.owner === policy) provenance.permits.delete(token);
      for (const [draftId, draft] of externalDrafts) {
        if (draft.owner === policy) {
          externalDrafts.delete(draftId);
          provenance.wireOrigins.delete(draft.wireToken);
          if (provenance.wireDrafts.get(draftId)?.draft === draft)
            provenance.wireDrafts.delete(draftId);
          if (retiring) retiredDrafts.set(draftId, hostId);
        }
      }
      if (!retiring)
        for (const [draftId, ownerHost] of retiredDrafts)
          if (ownerHost === hostId) retiredDrafts.delete(draftId);
    };
    const clear = (): Promise<void> =>
      isCurrent()
        ? Promise.resolve(rpc.clearPrewarmedThreads()).then(() => undefined)
        : Promise.reject(new Error("Renderer request manager is retired"));
    const policy: RendererHostRoutePolicy = Object.freeze({
      state: "ready" as const,
      hostId,
      scopedCreation: true,
      requestTarget: () => {
        if (!isCurrent()) throw new Error("Renderer request manager is retired");
        return manager;
      },
      select(
        model: string | null,
        draftId?: string,
        creationModes: readonly Record<string, unknown>[] = [],
      ): boolean {
        if (!isCurrent()) throw new Error("Renderer request manager is retired");
        if (model !== null && (typeof model !== "string" || !model.startsWith("codexhost/"))) {
          throw new Error("Draft route Model must be a codexhost transport carrier");
        }
        if (draftId === undefined) {
          if (model === null) clearDrafts();
          else throw new Error("External draft route is missing its client Thread identity");
        } else {
          if (!draftId.startsWith("client-new-thread:"))
            throw new Error("External draft route is missing its client Thread identity");
          const previous = externalDrafts.get(draftId);
          const draft =
            previous?.owner === policy && previous.model === model
              ? previous
              : { draftId, model, owner: policy, wireToken: crypto.randomUUID() };
          // Refuse ambiguous shared mode objects rather than overwrite another
          // draft's origin. Validate the whole set before publishing a binding.
          for (const mode of creationModes) {
            const token: unknown = Reflect.get(mode, draftIdentity);
            if (
              isRecord(token) &&
              origins.has(token) &&
              (token as unknown as DraftRoute).draftId !== draftId
            )
              throw new Error("Native creation mode is shared by multiple drafts");
            for (const key of [draftIdentity, wireField]) {
              const descriptor = Object.getOwnPropertyDescriptor(mode, key);
              if (
                (descriptor && descriptor.configurable !== true) ||
                (!descriptor && !Object.isExtensible(mode))
              )
                throw new Error("Native creation mode cannot retain draft origin");
            }
          }
          if (previous && previous !== draft) provenance.wireOrigins.delete(previous.wireToken);
          externalDrafts.set(draftId, draft);
          origins.add(draft);
          const wireOrigin = { draft };
          provenance.wireOrigins.set(draft.wireToken, wireOrigin);
          provenance.wireDrafts.set(draftId, wireOrigin);
          retiredDrafts.delete(draftId);
          for (const mode of creationModes) {
            Object.defineProperty(mode, draftIdentity, {
              configurable: true,
              enumerable: true,
              value: draft,
            });
            Object.defineProperty(mode, wireField, {
              configurable: true,
              enumerable: true,
              value: draft.wireToken,
            });
          }
        }
        if (selectedModel === model) return false;
        selectedModel = model;
        // Main-process prewarms are keyed by workspace, not Model. Calls arrive in
        // order, so this discards any prewarm requested for the previous selection.
        void clear().catch(() => undefined);
        return true;
      },
      clear,
      allowExplicitCreation(model: string): () => void {
        if (!isCurrent()) throw new Error("Renderer request manager is retired");
        if (typeof model !== "string" || !model.startsWith("codexhost/"))
          throw new Error("Explicit creation Model must be a codexhost transport carrier");
        const pending = explicitCreations.get(policy) ?? [];
        explicitCreations.set(policy, pending);
        pending.push(model);
        return () => {
          const index = pending.indexOf(model);
          if (index >= 0) pending.splice(index, 1);
        };
      },
      dispose() {
        if (retired) return;
        retired = true;
        clearDrafts(true);
        explicitCreations.delete(policy);
        selectedModel = null;
      },
    });
    return { hostId, manager, policy };
  };
  const retire = (hostId: string): void => {
    const entry = routes.get(hostId);
    routes.delete(hostId);
    entry?.route.policy.dispose();
  };
  const routeFor = (hostId: string): RendererHostRoute | null => {
    const current = read();
    const rpc = current ? dependencies.resolve(current, hostId) : null;
    const previous = routes.get(hostId);
    if (rpc && previous?.rpc === rpc) return previous.route;
    retire(hostId);
    if (!rpc) return null;
    const route = createRoute(hostId, rpc);
    routes.set(hostId, { route, rpc });
    return route;
  };
  const publish = (route: RendererHostRoute | null): void => {
    const policy = route?.policy;
    if (target.__codexhostDraftPrewarmPolicyV1 === policy) return;
    Object.defineProperty(target, "__codexhostDraftPrewarmPolicyV1", {
      configurable: true,
      value: policy,
    });
    if (typeof target.dispatchEvent === "function" && typeof CustomEvent === "function") {
      target.dispatchEvent(new CustomEvent("codexhost:draft-prewarm-policy-changed"));
    }
  };
  const composerHostId = (composer?: RendererHostRoot): string | null => {
    const hostIds = new Set(dependencies.composerHostIds(composer).hostIds);
    const hostId = hostIds.size === 1 ? hostIds.values().next().value : null;
    return typeof hostId === "string" && hostId ? hostId : null;
  };
  const routing: RendererHostRouting = {
    isCurrent() {
      return read() !== null && dependencies.registry.isCurrent() && registry.forHost === forHost;
    },
    knownHostIds() {
      const current = read();
      return current ? dependencies.hostIds(current) : [];
    },
    forHost(hostId) {
      return hostId && !disposed ? routeFor(hostId) : null;
    },
    hostIdForComposer(composer) {
      if (disposed) return null;
      try {
        return composerHostId(composer);
      } catch {
        return null;
      }
    },
    forComposer(composer) {
      if (disposed) return null;
      let hostId: string | null;
      try {
        hostId = composerHostId(composer);
      } catch {
        hostId = null;
      }
      const route = hostId ? routeFor(hostId) : null;
      if (!composer) publish(route);
      return route;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const hostId of [...routes.keys()]) retire(hostId);
      discovery = null;
      externalDrafts.clear();
      if (registry.forHost === forHost) registry.forHost = originalForHost;
      if (target.__codexhostHostRoutingV1 === routing) {
        delete target.__codexhostHostRoutingV1;
        publish(null);
      }
    },
  };
  Object.defineProperty(target, "__codexhostHostRoutingV1", { configurable: true, value: routing });
  return routing;
}
