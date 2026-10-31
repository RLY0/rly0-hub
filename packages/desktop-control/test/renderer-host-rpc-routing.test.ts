import { runInNewContext } from "node:vm";
import {
  decodeHarnessPluginRoute,
  encodeHarnessPluginRoute,
  harnessPluginRouteSchema,
} from "@codexhost/shared-contracts";
import { expect, it, vi } from "vitest";
import { installRendererDraftPrewarmPolicyDirect } from "../src/renderer-draft-prewarm-policy.js";
import type { RendererHostRouting as Routing } from "../src/renderer-host-routing.js";
import {
  findRendererAppScopeStore,
  findRendererHostRpcFamily,
  rendererHostRpcHostIds,
  resolveRendererHostRpc,
} from "../src/renderer-host-rpc-discovery.js";
import { installRendererHostRpcRouting } from "../src/renderer-host-rpc-routing.js";

const carrier = encodeHarnessPluginRoute(
  harnessPluginRouteSchema.parse({
    harnessId: "claude-code",
    model: { id: "claude-model-v1.c29ubmV0" },
    thinkingOptionId: "auto",
  }),
);

/** Desktop 26.1027: managers live in the main process; the Renderer keeps one
 * capnweb stub per Host in a signal family of the app scope store. */
function setup(
  options: { connectionFamilies?: number; nativeManager?: boolean; hosts?: string[] } = {},
) {
  const sent: unknown[] = [];
  const wire = (method: string, input: unknown, options: unknown) => {
    // Native capnweb copies enumerable string keys only: Symbol provenance
    // survives native shallow copies but must never be serialized to main.
    new MessagePort().postMessage(
      JSON.parse(JSON.stringify(["push", ["pipeline", -188, [method], [input, options]]])),
    );
    return Promise.resolve({ status: "created", conversationId: "synthetic" });
  };
  const rpc = {
    sendRequest: vi
      .fn<(method: string, params: unknown, options?: unknown) => Promise<{ entries: unknown[] }>>()
      .mockResolvedValue({ entries: [] }),
    clearPrewarmedThreads: vi.fn(async () => undefined),
    startConversation: vi.fn((input: unknown, options: unknown) =>
      wire("startConversation", input, options),
    ),
    prewarmConversation: vi.fn((input: unknown, options: unknown) =>
      wire("prewarmConversation", input, options),
    ),
    prewarmCloudConversation: vi.fn((input: unknown, options: unknown) =>
      wire("prewarmCloudConversation", input, options),
    ),
    prepareThreadStart: vi.fn((input: unknown, options: unknown) =>
      wire("prepareThreadStart", input, options),
    ),
  };
  const connections = new Map(
    (options.hosts ?? ["local"]).map((hostId) => [
      hostId,
      { status: "ready", client: { hostId, rpc: { ...rpc } } },
    ]),
  );
  const signal = (value: unknown) => ({ value: { get: () => value, set: vi.fn() } });
  const familyBindings = new Map<unknown, Map<unknown, unknown>>([
    // Account clients share the Host key but not the connection value shape.
    [{ kind: "signal-family" }, new Map([["local", signal({ hostId: "local", rpc: {} })]])],
  ]);
  for (let index = 0; index < (options.connectionFamilies ?? 1); index += 1) {
    familyBindings.set(
      { kind: "signal-family" },
      new Map([...connections].map(([hostId, connection]) => [hostId, signal(connection)])),
    );
  }
  const store = { familyBindings, parent: undefined };
  const handle = {
    chain: {},
    node: { parent: store },
    scope: {},
    get: vi.fn(),
    set: vi.fn(),
    watch: vi.fn(),
  };
  const rootFiber = {
    memoizedState: { memoizedState: { current: handle }, next: null },
    child: null,
    sibling: null,
  };
  const container = { __reactContainer$app: rootFiber };
  const composerFiber = {
    memoizedProps: { executionTargetHostId: "local" },
    memoizedState: options.nativeManager
      ? {
          memoizedState: {
            getHostId: () => "local",
            sendRequest: vi.fn(),
            requestClient: {
              sendRequest: vi.fn(),
              prewarmThreadStart: vi.fn(),
              enqueueRequest: vi.fn(),
            },
            prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
          },
          next: null,
        }
      : null,
    return: null,
  };
  const editors = [{ __reactFiber$app: composerFiber, parentElement: null }];
  const registry = {
    forHost(hostId: string) {
      const connection = connections.get(hostId);
      if (connection?.status !== "ready") throw new Error("Synthetic Host unavailable");
      return connection.client.rpc;
    },
    collectAppStateSnapshot: vi.fn(),
    getReviewPaneSnapshotMetrics: vi.fn(),
    dispose: vi.fn(),
  };
  const registryBinding = { registry, isCurrent: () => true };
  class MessagePort {
    postMessage(message: unknown): void {
      sent.push(message);
    }
  }
  const target: Record<string, unknown> = {};
  const document = {
    querySelectorAll: () => editors,
    getElementById: (id: string) => (id === "root" ? container : null),
  };
  const renderer = {
    async evaluate<T>(expression: string): Promise<T> {
      return await runInNewContext(expression, {
        document,
        window: target,
        MessagePort,
        crypto: globalThis.crypto,
        TextEncoder,
        TextDecoder,
        Uint8Array,
        setTimeout,
        clearTimeout,
      });
    },
  };
  const post = (message: unknown, hostId = "local") => {
    const expression = (message as unknown[])[1] as unknown[];
    const method = (expression[2] as string[])[0];
    if (method === "startConversation" || method === "prewarmConversation") {
      const client = registry.forHost(hostId);
      return Reflect.apply(client[method], client, expression[3] as unknown[]);
    }
    return new MessagePort().postMessage(message);
  };
  return {
    renderer,
    target,
    rpc,
    connections,
    sent,
    post,
    MessagePort,
    registryBinding,
    registry,
    document,
    options,
    store,
    handle,
  };
}

function policyOf(route: ReturnType<Routing["forHost"]>) {
  if (!route) throw new Error("Host route is unavailable");
  return route.policy;
}

async function install(fixture: ReturnType<typeof setup>): Promise<Routing> {
  if (fixture.options.nativeManager)
    await installRendererDraftPrewarmPolicyDirect(fixture.renderer);
  else
    runInNewContext(`(${installRendererHostRpcRouting.toString()})(root, target, dependencies)`, {
      root: fixture.document,
      target: fixture.target,
      dependencies: {
        findStore: findRendererAppScopeStore,
        findFamily: findRendererHostRpcFamily,
        resolve: resolveRendererHostRpc,
        hostIds: rendererHostRpcHostIds,
        composerHostIds: () => ({ editorCount: 1, hostIds: ["local"] }),
        registry: fixture.registryBinding,
        portPrototype: fixture.MessagePort.prototype,
      },
      crypto: globalThis.crypto,
    });
  return fixture.target.__codexhostHostRoutingV1 as Routing;
}

function creation(method: string, model: string, options: Record<string, unknown>) {
  return [
    "push",
    [
      "pipeline",
      -188,
      [method],
      [
        {
          input: [[{ type: "text", text: "hello" }]],
          collaborationMode: { mode: "default", settings: { model, reasoning_effort: "high" } },
          cwd: "/work",
        },
        options,
      ],
    ],
  ];
}

it("routes Host requests through the main-process RPC client without native internals", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const route = routing.forComposer();
    expect(route?.manager).toMatchObject({ kind: "main-process-rpc" });
    expect(route?.manager).not.toHaveProperty("requestClient");
    expect(routing.knownHostIds?.()).toEqual(["local"]);
    await route?.manager.sendRequest("codexhost/harness/display-settings/get", {});
    expect(fixture.rpc.sendRequest).toHaveBeenCalledWith(
      "codexhost/harness/display-settings/get",
      {},
    );
  } finally {
    routing.dispose();
  }
});

it("applies an external draft's carrier only to that draft's creation call", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const policy = policyOf(routing.forComposer());
    expect(policy.select(carrier, "client-new-thread:external")).toBe(true);
    expect(fixture.rpc.clearPrewarmedThreads).toHaveBeenCalledTimes(1);
    const exported = ["export", -1320];
    fixture.post(
      creation("startConversation", "gpt-6.1-sol", {
        clientThreadId: "client-new-thread:external",
        onSettled: exported,
      }),
    );
    fixture.post(
      creation("startConversation", "gpt-6.1-sol", { clientThreadId: "client-new-thread:codex" }),
    );
    fixture.post(["push", ["pipeline", -188, ["sendRequest"], ["model/list", {}]]]);
    const [external, codex, request] = fixture.sent as [unknown[], unknown, unknown];
    const args = (external[1] as unknown[])[3] as Record<string, unknown>[];
    expect(args[0]?.collaborationMode).toEqual({
      mode: "default",
      settings: { model: carrier, reasoning_effort: "high" },
    });
    expect(args[1]).toEqual({ clientThreadId: "client-new-thread:external", onSettled: exported });
    expect(codex).toEqual(
      creation("startConversation", "gpt-6.1-sol", { clientThreadId: "client-new-thread:codex" }),
    );
    expect(request).toEqual(["push", ["pipeline", -188, ["sendRequest"], ["model/list", {}]]]);
  } finally {
    routing.dispose();
  }
});

it.each(["disconnected", "replaced"])(
  "clears only the retired Host's drafts when its RPC is %s",
  async (change) => {
    const fixture = setup({ hosts: ["local", "remote"] });
    const routing = await install(fixture);
    try {
      const oldPolicy = policyOf(routing.forHost("local"));
      oldPolicy.select(carrier, "client-new-thread:local");
      policyOf(routing.forHost("remote")).select(carrier, "client-new-thread:remote");
      const connection = fixture.connections.get("local");
      if (!connection) throw new Error("Missing local fixture connection");
      if (change === "disconnected") connection.status = "disconnected";
      else connection.client.rpc = { ...fixture.rpc };
      const replacement = routing.forHost("local");
      expect(replacement === null).toBe(change === "disconnected");
      const local = creation("startConversation", "official", {
        clientThreadId: "client-new-thread:local",
      });
      expect(() => fixture.post(local)).toThrow("Draft route is unavailable");
      expect(fixture.sent).toEqual([]);
      fixture.post(
        creation("startConversation", "official", { clientThreadId: "client-new-thread:remote" }),
        "remote",
      );
      expect(fixture.sent.at(-1)).toEqual(
        creation("startConversation", carrier, { clientThreadId: "client-new-thread:remote" }),
      );
      connection.status = "ready";
      const next = policyOf(routing.forHost("local"));
      next.select(carrier, "client-new-thread:local");
      oldPolicy.dispose();
      fixture.post(local);
      expect(fixture.sent.at(-1)).toEqual(
        creation("startConversation", carrier, { clientThreadId: "client-new-thread:local" }),
      );
      next.select(null);
      fixture.post(local);
      expect(fixture.sent.at(-1)).toEqual(local);
      fixture.post(
        creation("startConversation", "official", { clientThreadId: "client-new-thread:remote" }),
        "remote",
      );
      expect(fixture.sent.at(-1)).toEqual(
        creation("startConversation", carrier, { clientThreadId: "client-new-thread:remote" }),
      );
    } finally {
      routing.dispose();
    }
  },
);

it("marks local prewarms with the selected carrier and stops after the draft returns to Codex", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const policy = policyOf(routing.forHost("local"));
    const warm = creation("prewarmConversation", "gpt-6.1-sol", {});
    const warmInput = (
      (warm[1] as unknown[])[3] as { collaborationMode: Record<string, unknown> }[]
    )[0];
    if (!warmInput) throw new Error("Missing synthetic prewarm input");
    const mode = warmInput.collaborationMode;
    policy.select(carrier, "client-new-thread:external", [mode]);
    fixture.post(warm);
    const prewarmed = (((fixture.sent[0] as unknown[])[1] as unknown[])[3] as unknown[])[0] as {
      collaborationMode: { settings: { model: string } };
    };
    expect(decodeHarnessPluginRoute(prewarmed.collaborationMode.settings.model)).toEqual({
      ...decodeHarnessPluginRoute(carrier),
      prewarm: true,
    });

    expect(policy.select(null, "client-new-thread:external")).toBe(true);
    expect(fixture.rpc.clearPrewarmedThreads).toHaveBeenCalledTimes(2);
    fixture.post(creation("prewarmConversation", "gpt-6.1-sol", {}));
    expect(fixture.sent[1]).toEqual(creation("prewarmConversation", "gpt-6.1-sol", {}));
  } finally {
    routing.dispose();
  }
});

it.each(["disconnected", "replaced"])(
  "rejects delayed requests and creation after RPC is %s without a routing refresh",
  async (change) => {
    const fixture = setup();
    const routing = await install(fixture);
    try {
      const route = routing.forHost("local");
      if (!route) throw new Error("Missing synthetic route");
      route.policy.select(carrier, "client-new-thread:delayed");
      const connection = fixture.connections.get("local");
      if (!connection) throw new Error("Missing synthetic connection");
      if (change === "disconnected") connection.status = "disconnected";
      else connection.client.rpc = { ...fixture.rpc };
      const message = creation("startConversation", "official", {
        clientThreadId: "client-new-thread:delayed",
      });
      expect(() => fixture.post(message)).toThrow("Draft route is unavailable");
      expect(() => fixture.post(message)).toThrow("Draft route is unavailable");
      expect(fixture.sent).toEqual([]);
      await expect(route.manager.sendRequest("synthetic/read", {})).rejects.toThrow("retired");
    } finally {
      routing.dispose();
    }
  },
);

it("publishes the local draft workspace named by its prewarm", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    fixture.post(creation("prewarmConversation", "gpt-6.1-sol", {}));
    expect(fixture.target.__codexhostDraftWorkspacesV1).toEqual({ local: "/work" });
  } finally {
    routing.dispose();
  }
});

it("keeps an official draft's prewarm native when another draft selects an external Agent", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    policyOf(routing.forHost("local")).select(carrier, "client-new-thread:external");
    // Synthetic call from another native Composer: the selected external draft
    // is not evidence that this prewarm belongs to it.
    const official = creation("prewarmConversation", "gpt-6.1-sol", {});
    fixture.post(official);
    expect(fixture.sent.at(-1)).toEqual(official);
  } finally {
    routing.dispose();
  }
});

it("restores the registry while retaining a dormant guard for late native fallback calls", async () => {
  const fixture = setup();
  const original = (fixture.MessagePort.prototype as { postMessage: unknown }).postMessage;
  const originalForHost = fixture.registry.forHost;
  const routing = await install(fixture);
  expect(fixture.registry.forHost).not.toBe(originalForHost);
  expect((fixture.MessagePort.prototype as { postMessage: unknown }).postMessage).not.toBe(
    original,
  );
  routing.dispose();
  expect(fixture.registry.forHost).toBe(originalForHost);
  expect((fixture.MessagePort.prototype as { postMessage: unknown }).postMessage).not.toBe(
    original,
  );
  new fixture.MessagePort().postMessage(["synthetic-native-message"]);
  expect(fixture.sent.at(-1)).toEqual(["synthetic-native-message"]);
});

it("binds background creation and prewarm to the originating draft before encoding", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const policy = policyOf(routing.forHost("local"));
    const initial = creation("startConversation", "official", {
      clientThreadId: "client-new-thread:origin",
    });
    const input = (
      (initial[1] as unknown[])[3] as { collaborationMode: Record<string, unknown> }[]
    )[0];
    if (!input) throw new Error("Missing synthetic creation input");
    policy.select(carrier, "client-new-thread:origin", [input.collaborationMode]);
    const copied = {
      ...input.collaborationMode,
      settings: { model: "official", reasoning_effort: "high" },
    };
    const result = fixture.registry
      .forHost("local")
      .startConversation(
        { ...input, collaborationMode: copied },
        { clientThreadId: "client-new-thread:background" },
      );
    expect(result).toBe(fixture.rpc.startConversation.mock.results.at(-1)?.value);
    expect(fixture.sent.at(-1)).toEqual(
      creation("startConversation", carrier, { clientThreadId: "client-new-thread:background" }),
    );
    expect(JSON.stringify(fixture.sent)).not.toContain("draft origin");
    const received = fixture.rpc.startConversation.mock.calls.at(-1)?.[0] as {
      collaborationMode: { settings: { model: string } };
    };
    expect(received.collaborationMode.settings.model).toBe(carrier);
    expect(input.collaborationMode.settings).toEqual({
      model: "official",
      reasoning_effort: "high",
    });
    fixture.registry
      .forHost("local")
      .prewarmConversation({ ...input, collaborationMode: copied }, {});
    const warmed = fixture.rpc.prewarmConversation.mock.calls.at(-1)?.[0] as {
      collaborationMode: { settings: { model: string } };
    };
    expect(decodeHarnessPluginRoute(warmed.collaborationMode.settings.model)?.prewarm).toBe(true);
  } finally {
    routing.dispose();
  }
});

it("rejects conflicting draft origins and cross-Host use without sending", async () => {
  const fixture = setup({ hosts: ["local", "remote"] });
  const routing = await install(fixture);
  try {
    const mode = { settings: { model: "official" } };
    policyOf(routing.forHost("local")).select(carrier, "client-new-thread:a", [mode]);
    policyOf(routing.forHost("local")).select(null, "client-new-thread:b");
    expect(() =>
      fixture.registry
        .forHost("local")
        .startConversation({ collaborationMode: mode }, { clientThreadId: "client-new-thread:b" }),
    ).toThrow("conflicts");
    expect(() =>
      fixture.registry
        .forHost("remote")
        .startConversation(
          { collaborationMode: mode },
          { clientThreadId: "client-new-thread:remote-background" },
        ),
    ).toThrow("unavailable");
    expect(() =>
      policyOf(routing.forHost("local")).select(null, "client-new-thread:b", [mode]),
    ).toThrow("multiple drafts");
    expect(fixture.sent).toEqual([]);
  } finally {
    routing.dispose();
  }
});

it("rejects copied origins after reselection and after disposal", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  const client = fixture.registry.forHost("local");
  const mode = { settings: { model: "official" } };
  const policy = policyOf(routing.forHost("local"));
  policy.select(carrier, "client-new-thread:a", [mode]);
  const copied = { ...mode };
  policy.select(null, "client-new-thread:a", [mode]);
  expect(() =>
    client.startConversation(
      { collaborationMode: copied },
      { clientThreadId: "client-new-thread:late" },
    ),
  ).toThrow("unavailable");
  client.startConversation({ collaborationMode: mode }, { clientThreadId: "client-new-thread:a" });
  const forwarded = fixture.rpc.startConversation.mock.calls.at(-1)?.[0] as {
    collaborationMode: Record<string, unknown>;
  };
  expect(forwarded.collaborationMode.settings).toEqual(mode.settings);
  expect(forwarded.collaborationMode).toHaveProperty("__codexhostDraftOriginV1");
  expect(JSON.stringify(fixture.sent)).not.toContain("__codexhostDraftOriginV1");
  routing.dispose();
  expect(() => client.startConversation({ collaborationMode: mode }, {})).toThrow("unavailable");
});

it("rejects retired provenance across Controller reinstallation", async () => {
  const fixture = setup();
  const old = await install(fixture);
  const mode = { settings: { model: "official" } };
  policyOf(old.forHost("local")).select(carrier, "client-new-thread:a", [mode]);
  const copied = { ...mode };
  old.dispose();
  const next = await install(fixture);
  try {
    expect(() =>
      fixture.registry
        .forHost("local")
        .startConversation(
          { collaborationMode: copied },
          { clientThreadId: "client-new-thread:late-background" },
        ),
    ).toThrow("unavailable");
    expect(fixture.sent).toEqual([]);
    policyOf(next.forHost("local")).select(carrier, "client-new-thread:a", [mode]);
    fixture.registry
      .forHost("local")
      .startConversation(
        { collaborationMode: mode },
        { clientThreadId: "client-new-thread:current-background" },
      );
    expect(fixture.sent).toHaveLength(1);
  } finally {
    next.dispose();
  }
});

it("keeps duplicate RPC clients guarded while preserving native cleanup", async () => {
  const fixture = setup();
  const connection = fixture.connections.get("local");
  if (!connection) throw new Error("Missing synthetic connection");
  const cleanup = vi.fn();
  const copy = { ...connection.client.rpc, [Symbol.dispose]: cleanup };
  const raw = Object.assign(connection.client.rpc, { dup: vi.fn(() => copy) });
  const routing = await install(fixture);
  const client = fixture.registry.forHost("local") as typeof raw;
  const duplicate = client.dup();
  expect(raw.dup).toHaveBeenCalledExactlyOnceWith();
  policyOf(routing.forHost("local")).select(carrier, "client-new-thread:a");
  duplicate.startConversation(
    { collaborationMode: { settings: { model: "official" } } },
    { clientThreadId: "client-new-thread:a" },
  );
  expect(fixture.sent.at(-1)).toBeDefined();
  routing.dispose();
  expect(() => duplicate.startConversation({}, {})).toThrow("unavailable");
  duplicate[Symbol.dispose]();
  expect(cleanup).toHaveBeenCalledExactlyOnceWith();
});

it("does not guess a route for an unbound external carrier", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    expect(() =>
      fixture.registry
        .forHost("local")
        .startConversation({ collaborationMode: { settings: { model: carrier } } }, {}),
    ).toThrow("originating draft binding");
    expect(fixture.sent).toEqual([]);
  } finally {
    routing.dispose();
  }
});

it("admits one explicitly named carrier creation, such as a scheduled task's chat", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  try {
    const policy = policyOf(routing.forHost("local"));
    const client = fixture.registry.forHost("local");
    const explicit = { collaborationMode: { settings: { model: carrier } } };
    const release = policy.allowExplicitCreation?.(carrier);
    expect(release).toBeTypeOf("function");
    // Another carrier and another creation entry are still refused.
    expect(() =>
      client.startConversation({ collaborationMode: { settings: { model: "codexhost/pi" } } }, {}),
    ).toThrow("originating draft binding");
    expect(() => client.prewarmConversation(explicit, {})).toThrow("originating draft binding");
    expect(fixture.sent).toEqual([]);

    client.startConversation(explicit, {});
    expect(fixture.sent).toHaveLength(1);
    // The permit is spent: a second unbound creation fails closed again.
    expect(() => client.startConversation(explicit, {})).toThrow("originating draft binding");
    release?.();

    const unused = policy.allowExplicitCreation?.(carrier);
    unused?.();
    expect(() => client.startConversation(explicit, {})).toThrow("originating draft binding");
    expect(fixture.sent).toHaveLength(1);
  } finally {
    routing.dispose();
  }
});

it.each(["scope", "family"])(
  "rejects a delayed caller when the app %s is replaced",
  async (change) => {
    const fixture = setup();
    const routing = await install(fixture);
    try {
      const client = fixture.registry.forHost("local");
      policyOf(routing.forHost("local")).select(carrier, "client-new-thread:a");
      if (change === "scope") fixture.handle.node.parent = { ...fixture.store };
      else fixture.store.familyBindings.clear();
      expect(routing.isCurrent?.()).toBe(false);
      expect(() => client.startConversation({}, { clientThreadId: "client-new-thread:a" })).toThrow(
        "unavailable",
      );
      expect(fixture.sent).toEqual([]);
    } finally {
      routing.dispose();
    }
  },
);

it("preserves callable remote RPC members without reading their remote bind property", async () => {
  const fixture = setup();
  const connection = fixture.connections.get("local");
  if (!connection) throw new Error("Missing synthetic connection");
  const paths: PropertyKey[] = [];
  const calls: unknown[][] = [];
  const result = Promise.resolve({ synthetic: true });
  const remote = new Proxy(function () {}, {
    get(_target, key) {
      paths.push(key);
      return function () {};
    },
    apply(_target, _receiver, args) {
      calls.push(args);
      return result;
    },
  });
  const raw = connection.client.rpc;
  const rpc = new Proxy(function () {}, {
    get(target, key, receiver) {
      if (key === "sendRequest") return remote;
      if (key in raw) return Reflect.get(raw, key, raw);
      return Reflect.get(target, key, receiver);
    },
  });
  connection.client.rpc = rpc as unknown as typeof raw;
  const routing = await install(fixture);
  try {
    const wrapped = fixture.registry.forHost("local");
    expect(wrapped.sendRequest).toBe(remote);
    const callback = () => undefined;
    expect(wrapped.sendRequest("config/read", { callback })).toBe(result);
    expect(calls).toEqual([["config/read", { callback }]]);
    expect(paths).toEqual([]);
  } finally {
    routing.dispose();
  }
});

function nativeFallback(fixture: ReturnType<typeof setup>) {
  // Captured Desktop tg(): a forHost failure is swallowed, then the ready
  // family client.rpc is returned. Calls happen outside this catch.
  try {
    return fixture.registry.forHost("local");
  } catch {
    const connection = fixture.connections.get("local");
    if (!connection) throw new Error("Missing synthetic connection");
    return connection.client.rpc;
  }
}

it.each(["registry-unavailable", "owner-retired", "scope", "family", "disposed"])(
  "guards the native raw-RPC fallback when %s",
  async (state) => {
    const fixture = setup();
    if (state === "registry-unavailable")
      fixture.registry.forHost = () => {
        throw new Error("Synthetic registry unavailable");
      };
    const routing = await install(fixture);
    const mode = { settings: { model: "official" } };
    policyOf(routing.forHost("local")).select(carrier, "client-new-thread:a", [mode]);
    if (state === "owner-retired") fixture.registryBinding.isCurrent = () => false;
    if (state === "scope") fixture.handle.node.parent = { ...fixture.store };
    if (state === "family") fixture.store.familyBindings.clear();
    if (state === "disposed") routing.dispose();
    try {
      const call = () =>
        nativeFallback(fixture).startConversation(
          { collaborationMode: { ...mode } },
          { clientThreadId: "client-new-thread:background" },
        );
      expect(call).toThrow("Draft route is unavailable");
      expect(fixture.sent).toEqual([]);
    } finally {
      routing.dispose();
    }
  },
);

it("preserves receivers for local adapter methods", async () => {
  const fixture = setup();
  const raw = fixture.connections.get("local")?.client.rpc;
  if (!raw) throw new Error("Missing synthetic RPC");
  raw.sendRequest.mockImplementation(function (this: typeof raw) {
    expect(this).toBe(raw);
    return Promise.resolve({ entries: [] });
  });
  const routing = await install(fixture);
  try {
    await fixture.registry.forHost("local").sendRequest("config/read", {});
  } finally {
    routing.dispose();
  }
});

it("rejects a pending raw native call that becomes ready after Controller disposal", async () => {
  const fixture = setup();
  const routing = await install(fixture);
  const mode = { settings: { model: "official" } };
  policyOf(routing.forHost("local")).select(carrier, "client-new-thread:a", [mode]);
  const raw = fixture.connections.get("local")?.client.rpc;
  if (!raw) throw new Error("Missing synthetic RPC");
  const pending = Promise.resolve().then(() =>
    raw.startConversation(
      { collaborationMode: { ...mode } },
      { clientThreadId: "client-new-thread:pending-background" },
    ),
  );
  routing.dispose();
  await expect(pending).rejects.toThrow("Draft route is unavailable");
  expect(fixture.sent).toEqual([]);
});

it.each(["model", "method", "client-id", "replay"])(
  "checks the one-use encoding permit against %s changes",
  async (change) => {
    const fixture = setup();
    let encoded: unknown;
    fixture.rpc.startConversation.mockImplementation((input, options) => {
      encoded = JSON.parse(
        JSON.stringify(["push", ["pipeline", -188, ["startConversation"], [input, options]]]),
      );
      return Promise.resolve({ status: "created", conversationId: "synthetic" });
    });
    const routing = await install(fixture);
    try {
      const mode = { settings: { model: "official" } };
      policyOf(routing.forHost("local")).select(carrier, "client-new-thread:a", [mode]);
      const nativeResult = fixture.registry
        .forHost("local")
        .startConversation(
          { collaborationMode: mode },
          { clientThreadId: "client-new-thread:background" },
        );
      expect(nativeResult).toBe(fixture.rpc.startConversation.mock.results.at(-1)?.value);
      const expression = (encoded as unknown[])[1] as unknown[];
      const args = expression[3] as Record<string, unknown>[];
      const input = args[0];
      if (!input) throw new Error("Missing synthetic encoded input");
      if (change === "model")
        (
          (input.collaborationMode as Record<string, unknown>).settings as Record<string, unknown>
        ).model = "official";
      if (change === "method") expression[2] = ["prewarmConversation"];
      if (change === "client-id") args[1] = { clientThreadId: "client-new-thread:other" };
      if (change === "replay") {
        new fixture.MessagePort().postMessage(encoded);
        expect(JSON.stringify(fixture.sent)).not.toContain("__codexhostDraftOriginV1");
        expect(fixture.sent).toHaveLength(1);
      }
      expect(() => new fixture.MessagePort().postMessage(encoded)).toThrow(
        "Draft route is unavailable",
      );
      expect(fixture.sent).toHaveLength(change === "replay" ? 1 : 0);
    } finally {
      routing.dispose();
    }
  },
);

it("rejects a raw fallback on another Host rather than inferring its destination from origin", async () => {
  const fixture = setup({ hosts: ["local", "remote"] });
  const routing = await install(fixture);
  try {
    const mode = { settings: { model: "official" } };
    policyOf(routing.forHost("local")).select(carrier, "client-new-thread:a", [mode]);
    const rawRemote = fixture.connections.get("remote")?.client.rpc;
    if (!rawRemote) throw new Error("Missing synthetic remote RPC");
    expect(() =>
      rawRemote.startConversation(
        { collaborationMode: { ...mode } },
        { clientThreadId: "client-new-thread:remote-background" },
      ),
    ).toThrow("Draft route is unavailable");
    expect(fixture.sent).toEqual([]);
  } finally {
    routing.dispose();
  }
});

it.each(["prewarmCloudConversation", "prepareThreadStart"] as const)(
  "preserves official %s while scrubbing private draft provenance",
  async (method) => {
    const fixture = setup({ hosts: ["local", "durable"] });
    const routing = await install(fixture);
    try {
      const mode = { mode: "default", settings: { model: "official" } };
      policyOf(routing.forHost("durable")).select(null, "client-new-thread:cloud", [mode]);
      const provider = () => ({ synthetic: true });
      const input = {
        collaborationMode: mode,
        cwd: "/synthetic",
        workspaceRoots: ["/synthetic"],
        cloudThreadPrototype: true,
        serviceTier: "synthetic-original",
      };
      const result = fixture.registry.forHost("durable")[method](input, provider);
      expect(result).toBe(fixture.rpc[method].mock.results.at(-1)?.value);
      expect(fixture.rpc[method].mock.calls.at(-1)?.[1]).toBe(provider);
      const args = ((fixture.sent.at(-1) as unknown[])[1] as unknown[])[3] as unknown[];
      expect(args[0]).toEqual({
        ...input,
        collaborationMode: { mode: "default", settings: { model: "official" } },
      });
      expect(JSON.stringify(fixture.sent)).not.toContain("__codexhostDraftOriginV1");
    } finally {
      routing.dispose();
    }
  },
);

it.each(["prewarmCloudConversation", "prepareThreadStart"] as const)(
  "rejects late raw %s provenance after disposal",
  async (method) => {
    const fixture = setup();
    const routing = await install(fixture);
    const mode = { settings: { model: "official" } };
    policyOf(routing.forHost("local")).select(null, "client-new-thread:cloud", [mode]);
    routing.dispose();
    const raw = fixture.connections.get("local")?.client.rpc;
    if (!raw) throw new Error("Missing synthetic RPC");
    expect(() => raw[method]({ collaborationMode: { ...mode } }, () => ({}))).toThrow(
      "Draft route is unavailable",
    );
    expect(fixture.sent).toEqual([]);
  },
);

it("stays unavailable when Host connection values are ambiguous", async () => {
  const fixture = setup({ connectionFamilies: 2 });
  vi.useFakeTimers();
  try {
    const pending = installRendererDraftPrewarmPolicyDirect(fixture.renderer);
    const failure = expect(pending).rejects.toThrow("Renderer Host request manager is unavailable");
    await vi.advanceTimersByTimeAsync(61_000);
    await failure;
    expect(fixture.target.__codexhostHostRoutingV1).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("keeps the native manager path when Desktop exposes one in the Renderer", async () => {
  const fixture = setup({ nativeManager: true });
  const original = (fixture.MessagePort.prototype as { postMessage: unknown }).postMessage;
  const routing = await install(fixture);
  try {
    expect(routing.forComposer()?.manager).toHaveProperty("requestClient");
    expect((fixture.MessagePort.prototype as { postMessage: unknown }).postMessage).toBe(original);
  } finally {
    routing.dispose();
  }
});
