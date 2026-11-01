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
