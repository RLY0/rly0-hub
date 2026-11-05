import { expect, it, vi } from "vitest";
import { loadRendererHostRpcRegistry } from "../src/renderer-host-rpc-registry.js";

const DESKTOP_3384 = { file: "app-initial-4267e52fe5b0.js", exportName: "mpr" };
const DESKTOP_6604 = { file: "app-initial-fb51ee65d20a.js", exportName: "vpr" };

function fixture(build: { file: string; exportName: string } = DESKTOP_3384) {
  const token = {};
  const definition = { cache: "signal", scope: token, resolve: vi.fn() };
  const atom = {};
  const registry = {
    forHost: vi.fn(),
    collectAppStateSnapshot: vi.fn(),
    getReviewPaneSnapshotMetrics: vi.fn(),
    dispose: vi.fn(),
  };
  const store = {
    token,
    signalBindings: new WeakMap([[definition, atom]]),
    store: { get: vi.fn((): unknown => registry) },
  };
  const target = {
    location: { href: "app://-/index.html" },
    __codexhostLoadedModulesV1: {
      owner: "synthetic-controller",
      complete: true,
      documentUrl: "app://-/index.html",
      urls: [`app://-/assets/${build.file}`],
    },
  };
  const importModule = vi.fn(async (): Promise<Record<string, unknown>> => ({
    [build.exportName]: definition,
    unrelated: { resolve: vi.fn() },
  }));
  return { definition, atom, registry, store, target, importModule };
}

it("reads only the reviewed already-bound native registry signal", async () => {
  const f = fixture();
  const binding = await loadRendererHostRpcRegistry(f.store, f.target, f.importModule);
  expect(binding?.registry).toBe(f.registry);
  expect(binding?.isCurrent()).toBe(true);
  expect(f.importModule).toHaveBeenCalledExactlyOnceWith(
    "app://-/assets/app-initial-4267e52fe5b0.js",
  );
  expect(f.store.store.get).toHaveBeenCalledWith(f.atom);
  expect(f.definition.resolve).not.toHaveBeenCalled();
  expect(f.registry.forHost).not.toHaveBeenCalled();
  f.store.store.get.mockReturnValue({ ...f.registry });
  expect(binding?.isCurrent()).toBe(false);
});

it("reads the reviewed registry signal of Desktop 26.1027.6604.0", async () => {
  const f = fixture(DESKTOP_6604);
  const binding = await loadRendererHostRpcRegistry(f.store, f.target, f.importModule);
  expect(binding?.registry).toBe(f.registry);
  expect(binding?.isCurrent()).toBe(true);
  expect(f.importModule).toHaveBeenCalledExactlyOnceWith(
    "app://-/assets/app-initial-fb51ee65d20a.js",
  );
  expect(f.definition.resolve).not.toHaveBeenCalled();
  expect(f.registry.forHost).not.toHaveBeenCalled();
});

it.each([
  ["26.1027.3384.0", DESKTOP_3384, DESKTOP_6604.exportName],
  ["26.1027.6604.0", DESKTOP_6604, DESKTOP_3384.exportName],
])("does not read another build's export from the %s bundle", async (_version, build, other) => {
  const f = fixture(build);
  f.importModule.mockImplementation(async () => ({ [other]: f.definition }));
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.store.store.get).not.toHaveBeenCalled();
});

it("does not import modules when two reviewed builds are loaded", async () => {
  const f = fixture();
  f.target.__codexhostLoadedModulesV1.urls.push(`app://-/assets/${DESKTOP_6604.file}`);
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.importModule).not.toHaveBeenCalled();
});

it.each(["missing", "incomplete", "unknown-build", "other-origin", "ambiguous"])(
  "does not import modules for a %s catalog",
  async (state) => {
    const f = fixture();
    if (state === "missing") Reflect.deleteProperty(f.target, "__codexhostLoadedModulesV1");
    if (state === "incomplete") f.target.__codexhostLoadedModulesV1.complete = false;
    if (state === "unknown-build")
      f.target.__codexhostLoadedModulesV1.urls = ["app://-/assets/app-initial-unknown.js"];
    if (state === "other-origin")
      f.target.__codexhostLoadedModulesV1.urls = [
        "https://other.invalid/app-initial-4267e52fe5b0.js",
      ];
    if (state === "ambiguous")
      f.target.__codexhostLoadedModulesV1.urls.push("app://-/other/app-initial-4267e52fe5b0.js");
    expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
    expect(f.importModule).not.toHaveBeenCalled();
    expect(f.store.store.get).not.toHaveBeenCalled();
  },
);

it("does not initialize an unbound signal or use a definition from another scope", async () => {
  const f = fixture();
  f.store.signalBindings.delete(f.definition);
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.definition.resolve).not.toHaveBeenCalled();
  expect(f.store.store.get).not.toHaveBeenCalled();
  f.store.signalBindings.set(f.definition, f.atom);
  f.definition.scope = {};
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.store.store.get).not.toHaveBeenCalled();
});

it("rejects catalog replacement during import and registry ownership changes afterwards", async () => {
  const f = fixture();
  const binding = await loadRendererHostRpcRegistry(f.store, f.target, f.importModule);
  f.store.signalBindings.set(f.definition, {});
  expect(binding?.isCurrent()).toBe(false);
  f.importModule.mockImplementation(async () => {
    f.target.__codexhostLoadedModulesV1 = { ...f.target.__codexhostLoadedModulesV1 };
    return { mpr: f.definition, unrelated: { resolve: vi.fn() } };
  });
  f.store.store.get.mockClear();
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.store.store.get).not.toHaveBeenCalled();
});

it("keeps a valid binding across ordinary lazy-module catalog updates", async () => {
  const f = fixture();
  const binding = await loadRendererHostRpcRegistry(f.store, f.target, f.importModule);
  f.target.__codexhostLoadedModulesV1 = {
    ...f.target.__codexhostLoadedModulesV1,
    urls: [...f.target.__codexhostLoadedModulesV1.urls, "app://-/assets/lazy-module.js"],
  };
  expect(binding?.isCurrent()).toBe(true);
  f.target.__codexhostLoadedModulesV1.owner = "replacement-controller";
  expect(binding?.isCurrent()).toBe(false);
});

// Desktop 26.1029.7803.0 (Rspack). Trimmed from the shipped webview: index.html loads the
// preloaded chunks 782259/727403/158624 and the entry/runtime chunk 348410, which ends with
// `export{v as __webpack_require__}` (`p.c=l` is the module cache of `{id, exports}` records).
// Async chunk 24191 defines module `Dgwo` (signal definition, getter export `p`, via
// `n.d(t,{V:()=>p},{p:d})`) and `hms3` (the registry factory). Module ids are per-build hashes.
const RSPACK_ENTRY = "348410.ae8bb87271.js";
const RSPACK_PRELOADED = ["782259.9dd29a0a62.js", "727403.97d7d53b0c.js", "158624.372d9fdf73.js"];

function rspackFixture() {
  const token = {};
  const definition = { cache: "signal", scope: token, resolve: vi.fn() };
  const foreignDefinition = { cache: "signal", scope: {}, resolve: vi.fn() };
  const otherSignal = { cache: "signal", scope: token, resolve: vi.fn() };
  const atom = {};
  const otherAtom = {};
  const registry = {
    forHost: vi.fn(),
    collectAppStateSnapshot: vi.fn(),
    getReviewPaneSnapshotMetrics: vi.fn(),
    dispose: vi.fn(),
  };
  const values = new Map<object, unknown>([
    [atom, registry],
    [otherAtom, { forHost: vi.fn() }],
  ]);
  const store = {
    token,
    signalBindings: new WeakMap<object, object>([
      [definition, atom],
      [otherSignal, otherAtom],
    ]),
    store: { get: vi.fn((key: object): unknown => values.get(key)) },
  };
  const exportsWithGetter = (bindings: Record<string, () => unknown>) => {
    const exports = {};
    for (const [key, get] of Object.entries(bindings))
      Object.defineProperty(exports, key, { enumerable: true, get });
    return exports;
  };
  const cache: Record<string, unknown> = {
    R2r9: { id: "R2r9", exports: {} },
    Dgwo: { id: "Dgwo", exports: exportsWithGetter({ V: () => vi.fn(), p: () => definition }) },
    hms3: { id: "hms3", exports: exportsWithGetter({ E: () => vi.fn() }) },
    SOuP: { id: "SOuP", exports: { foreign: foreignDefinition, other: otherSignal } },
    tdzz: {
      id: "tdzz",
      exports: exportsWithGetter({
        x: () => {
          throw new ReferenceError("Cannot access before initialization");
        },
      }),
    },
  };
  const webpackRequire = Object.assign(vi.fn(), { c: cache, m: {} });
  const target = {
    location: { href: "app://-/index.html" },
    __codexhostLoadedModulesV1: {
      owner: "synthetic-controller",
      complete: true,
      documentUrl: "app://-/index.html",
      urls: [...RSPACK_PRELOADED, RSPACK_ENTRY].map((file) => `app://-/assets/${file}`),
    },
  };
  const importModule = vi.fn(async (url: string): Promise<Record<string, unknown>> => {
    if (url.endsWith(RSPACK_ENTRY)) return { __webpack_require__: webpackRequire };
    const id = Number(url.slice(url.lastIndexOf("/") + 1).split(".")[0]);
    return { __rspack_esm_id: id, __rspack_esm_ids: [id], __webpack_modules__: {} };
  });
  return {
    definition,
    otherSignal,
    atom,
    registry,
    store,
    target,
    cache,
    webpackRequire,
    importModule,
  };
}

it("finds the registry signal of Rspack Desktop 26.1029.7803.0 through the module cache", async () => {
  const f = rspackFixture();
  const binding = await loadRendererHostRpcRegistry(f.store, f.target, f.importModule);
  expect(binding?.registry).toBe(f.registry);
  expect(binding?.isCurrent()).toBe(true);
  expect(f.importModule).toHaveBeenCalledWith(`app://-/assets/${RSPACK_ENTRY}`);
  expect(f.webpackRequire).not.toHaveBeenCalled();
  expect(f.definition.resolve).not.toHaveBeenCalled();
  expect(f.registry.forHost).not.toHaveBeenCalled();
  f.store.store.get.mockReturnValue({ ...f.registry });
  expect(binding?.isCurrent()).toBe(false);
});

it("does not depend on Rspack module ids", async () => {
  const f = rspackFixture();
  f.cache.Zq9x = f.cache.Dgwo;
  Reflect.deleteProperty(f.cache, "Dgwo");
  expect((await loadRendererHostRpcRegistry(f.store, f.target, f.importModule))?.registry).toBe(
    f.registry,
  );
});

it("fails closed when the registry chunk is not loaded yet", async () => {
  const f = rspackFixture();
  Reflect.deleteProperty(f.cache, "Dgwo");
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.webpackRequire).not.toHaveBeenCalled();
});

it("fails closed when two signals resolve to a registry", async () => {
  const f = rspackFixture();
  const second = { ...f.registry };
  const atom = {};
  f.store.signalBindings.set(f.otherSignal, atom);
  f.store.store.get.mockImplementation((key: object) =>
    key === f.atom ? f.registry : key === atom ? second : undefined,
  );
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
});

it("does not use an unbound signal or a registry-shaped value of another scope", async () => {
  const f = rspackFixture();
  f.store.signalBindings.delete(f.definition);
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.definition.resolve).not.toHaveBeenCalled();
});

it.each(["no-runtime", "two-runtimes", "async-only", "other-origin", "query"])(
  "fails closed for a %s Rspack catalog",
  async (state) => {
    const f = rspackFixture();
    const urls = f.target.__codexhostLoadedModulesV1;
    if (state === "no-runtime") urls.urls = urls.urls.slice(0, 3);
    if (state === "two-runtimes") urls.urls.push("app://-/assets/999999.0123456789.js");
    if (state === "async-only") urls.urls = [`app://-/assets/async/${RSPACK_ENTRY}`];
    if (state === "other-origin") urls.urls = [`https://other.invalid/assets/${RSPACK_ENTRY}`];
    if (state === "query") urls.urls = [`app://-/assets/${RSPACK_ENTRY}?x=1`];
    if (state === "two-runtimes")
      f.importModule.mockImplementation(async (url: string) =>
        url.includes("348410") || url.includes("999999")
          ? { __webpack_require__: f.webpackRequire }
          : {},
      );
    expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
    expect(f.store.store.get).not.toHaveBeenCalled();
  },
);

it("prefers neither contract when a Vite and an Rspack bundle are both loaded", async () => {
  const f = rspackFixture();
  f.target.__codexhostLoadedModulesV1.urls.push(`app://-/assets/${DESKTOP_6604.file}`);
  f.importModule.mockImplementation(async () => ({ vpr: {} }));
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
});

it("rejects catalog replacement while importing the Rspack runtime", async () => {
  const f = rspackFixture();
  f.importModule.mockImplementation(async () => {
    f.target.__codexhostLoadedModulesV1 = { ...f.target.__codexhostLoadedModulesV1 };
    return { __webpack_require__: f.webpackRequire };
  });
  expect(await loadRendererHostRpcRegistry(f.store, f.target, f.importModule)).toBeNull();
  expect(f.store.store.get).not.toHaveBeenCalled();
});

it("matches the shipped 26.1029.7803.0 file names and entry export", () => {
  expect(RSPACK_ENTRY).toMatch(/^\d+\.[0-9a-f]{8,}\.js$/);
  for (const file of RSPACK_PRELOADED) expect(file).toMatch(/^\d+\.[0-9a-f]{8,}\.js$/);
});
