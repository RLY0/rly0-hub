import { expect, it, vi } from "vitest";
import {
  discoverRendererHosts,
  requestManagerFromHookState,
  resolveRendererHostManager,
} from "../src/renderer-host-discovery.js";

function fixture() {
  // Synthetic fixture matching Desktop 26.1021's observed registry API.
  const manager = (hostId: string) => ({
    getHostId: () => hostId,
    sendRequest: vi.fn(),
    requestClient: {
      hostId,
      sendRequest: vi.fn(),
      prewarmThreadStart: vi.fn(),
      enqueueRequest: vi.fn(),
    },
    prewarmedThreadManager: { discardAllPrewarmedThreads: vi.fn() },
  });
  const local = manager("local");
  const remote = manager("remote-synthetic");
  const managers = new Map([
    ["local", local],
    ["remote-synthetic", remote],
  ]);
  const registry = {
    addManager: vi.fn(),
    getForHostId: (hostId: string) => managers.get(hostId) ?? null,
    getImplForHostId: (hostId: string) => managers.get(hostId) ?? null,
    addRegistryCallback: vi.fn(),
  };
  const fiber = {
    memoizedProps: { executionTargetHostId: "local" },
    memoizedState: {
      memoizedState: registry,
      next: { memoizedState: local, next: null },
    },
    return: null,
  };
  const editor = {
    __reactFiber$synthetic: fiber,
    parentElement: null,
    querySelectorAll: () => [],
  };
  const root = { querySelectorAll: () => [editor] };
  return { local, remote, managers, registry, root };
}

it("reads the observed replacement registry without the removed wait method", () => {
  const f = fixture();
  expect(requestManagerFromHookState(f.registry, "local")).toBe(f.local);
  expect(requestManagerFromHookState(f.registry, "remote-synthetic")).toBe(f.remote);
});

it("keeps the replacement registry authoritative when a direct stale hook remains", () => {
  const f = fixture();
  const discovery = discoverRendererHosts(f.root);
  expect(discovery.registries).toEqual([f.registry]);
  expect(resolveRendererHostManager(discovery, "local")).toBe(f.local);
  f.managers.delete("local");
  expect(resolveRendererHostManager(discovery, "local")).toBeNull();
  expect(resolveRendererHostManager(discovery, "remote-synthetic")).toBe(f.remote);
});

it("rejects a replacement registry entry owned by a different Host", () => {
  const f = fixture();
  const discovery = discoverRendererHosts(f.root);
  f.managers.set("local", f.remote);
  expect(resolveRendererHostManager(discovery, "local")).toBeNull();
});
