import { runInNewContext } from "node:vm";
import { expect, it } from "vitest";
import {
  codexUpdateHoldFallbackScript,
  codexUpdateHoldProbeExpression,
  codexUpdateHoldPushExpression,
  codexUpdateHoldScript,
} from "../src/codex-update-hold.js";
import { coreRendererBootstrap } from "../src/core-renderer-session.js";

/**
 * The page-side sender in Codex Desktop 26.1103.41825 (webview chunk 366057):
 * `dispatchMessage("electron-sparkle-gates-changed", {preferMxc, disableInAppUpdates,
 * disableSparkleAutodownload, useBackendAppcast, useInternalUpdateCdn:false,
 * useWindowsCoreRuntimeFrameworks, useWindowsPrimaryRuntimeFrameworks})` → `{...payload, type}`
 * through `window.electronBridge.sendMessageFromView`, then the same object as the
 * `codex-message-from-view` CustomEvent detail.
 */
const realGates = (overrides: Record<string, unknown> = {}) => ({
  preferMxc: false,
  disableInAppUpdates: false,
  disableSparkleAutodownload: false,
  useBackendAppcast: true,
  useInternalUpdateCdn: false,
  useWindowsCoreRuntimeFrameworks: false,
  useWindowsPrimaryRuntimeFrameworks: false,
  ...overrides,
  type: "electron-sparkle-gates-changed",
});

function page(
  options: {
    bridge?: boolean;
    storage?: Map<string, string>;
    reject?: boolean;
    protocol?: string;
    document?: unknown;
  } = {},
) {
  const listeners: ((event: unknown) => void)[] = [];
  const sent: Record<string, unknown>[] = [];
  const storage = options.storage ?? new Map<string, string>();
  const context: Record<string, unknown> = {
    location: { protocol: options.protocol ?? "app:" },
    ...(options.document ? { document: options.document } : {}),
    performance: { now: () => 12.4 },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      if (type === "codex-message-from-view") listeners.push(listener);
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
    Promise,
    JSON,
    Object,
    Array,
  };
  if (options.bridge !== false)
    // contextBridge exposes a deep-frozen object; the script must only call it.
    context.electronBridge = Object.freeze({
      sendMessageFromView: async (message: Record<string, unknown>) => {
        if (options.reject) throw new Error("ipc closed");
        sent.push(message);
      },
    });
  return {
    context,
    sent,
    storage,
    run: (source: string) => runInNewContext(source, context) as unknown,
    /** What Codex's SITX.postMessage does right after sending through the bridge. */
    view: (message: unknown) => {
      for (const listener of listeners) listener({ detail: message });
    },
    state: () =>
      runInNewContext(
        "({ ...globalThis.__codexhostUpdateHoldV1, setHold: undefined, failures: globalThis.__codexhostFeatureFailuresV1 })",
        context,
      ) as Record<string, unknown>,
  };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

it("while held, re-sends each real gate message with background downloads off and the latch untouched", async () => {
  const p = page();
  expect(p.run(codexUpdateHoldScript(true))).toBe(true);
  p.view(realGates());
  await settle();
  expect(p.sent).toEqual([
    { ...realGates(), disableInAppUpdates: null, disableSparkleAutodownload: true },
  ]);
  expect(p.state()).toMatchObject({ hold: true, observed: 1, sent: 1, error: null });
});

it("passes gates through while released, and ignores other view messages", async () => {
  const p = page();
  p.run(codexUpdateHoldScript(false));
  p.view(realGates());
  p.view({ type: "electron-desktop-features-changed", appshotsEnabled: true });
  p.view({ type: "log-message", message: "x" });
  await settle();
  expect(p.sent).toEqual([]);
  expect(p.state()).toMatchObject({ observed: 1, error: null });
});

it("does not resend when Codex itself already disables background downloads", async () => {
  const p = page();
  p.run(codexUpdateHoldScript(true));
  p.view(realGates({ disableSparkleAutodownload: true }));
  await settle();
  expect(p.sent).toEqual([]);
});

it("an unknown gate shape or missing bridge sends nothing and records a feature failure", async () => {
  const unknown = page();
  unknown.run(codexUpdateHoldScript(true));
  unknown.view(realGates({ disableSparkleAutodownload: "false" }));
  unknown.view(realGates({ nested: { future: true } }));
  await settle();
  expect(unknown.sent).toEqual([]);
  expect(unknown.state()).toMatchObject({ error: "unknown-shape", failures: ["update-hold"] });

  const noBridge = page({ bridge: false });
  noBridge.run(codexUpdateHoldScript(true));
  noBridge.view(realGates());
  expect(noBridge.state()).toMatchObject({
    error: "bridge-unavailable",
    failures: ["update-hold"],
  });

  const rejected = page({ reject: true });
  rejected.run(codexUpdateHoldScript(true));
  rejected.view(realGates());
  await settle();
  expect(rejected.state()).toMatchObject({ error: "send-failed", sent: 0 });
});

it("a page without an event target records the failure instead of throwing", () => {
  const failures = runInNewContext(
    `${codexUpdateHoldScript(true)}; globalThis.__codexhostFeatureFailuresV1`,
    { location: { protocol: "app:" }, Promise, JSON, Object, Array },
  );
  expect(failures).toEqual(["update-hold"]);
});

it("never stores or replays gates from an earlier launch (M2)", async () => {
  const storage = new Map<string, string>();
  const earlier = page({ storage });
  earlier.run(codexUpdateHoldScript(false));
  earlier.view(realGates({ useBackendAppcast: false }));
  // Next launch, held: nothing is sent until Codex itself reports its current gates.
  const later = page({ storage });
  later.run(codexUpdateHoldScript(true));
  await settle();
  expect(storage.size).toBe(0);
  expect(later.sent).toEqual([]);
  later.view(realGates());
  await settle();
  expect(later.sent).toEqual([
    { ...realGates(), disableInAppUpdates: null, disableSparkleAutodownload: true },
  ]);
});

it("the bundled fallback never overrides a hold installed by the early session (M1)", async () => {
  const p = page();
  // Early session registered the current value (released) before the page's own scripts.
  p.run(codexUpdateHoldScript(false));
  // The full/core injection carries the value its session was built with (stale: held).
  p.run(codexUpdateHoldFallbackScript(true));
  p.view(realGates());
  await settle();
  expect(p.sent).toEqual([]);
  expect(p.state()).toMatchObject({ hold: false });
  // Without an early hold, the fallback installs with its own value.
  const alone = page();
  alone.run(codexUpdateHoldFallbackScript(true));
  alone.view(realGates());
  await settle();
  expect(alone.sent).toHaveLength(1);
  // The authoritative copy (re-registered after a hold change) sets an installed page.
  alone.run(codexUpdateHoldScript(false));
  expect(alone.state()).toMatchObject({ hold: false });
});

it("installs once; a hold turned on while running re-sends the last observed message", async () => {
  const p = page();
  p.run(codexUpdateHoldScript(false));
  p.view(realGates());
  p.run(codexUpdateHoldScript(false)); // Session reinstall keeps one listener.
  p.run(codexUpdateHoldPushExpression(true));
  p.run(codexUpdateHoldPushExpression(true));
  await settle();
  expect(p.sent).toHaveLength(1);
  p.run(codexUpdateHoldPushExpression(false));
  p.view(realGates());
  await settle();
  expect(p.sent).toHaveLength(1);
});

it("core mode installs the hold before its passive data bridge and survives its failure", () => {
  const events: string[] = [];
  const context = {
    location: { protocol: "app:" },
    dispatchEvent: (event: { type: string }) => events.push(event.type),
    CustomEvent: class {
      constructor(readonly type: string) {}
    },
    Promise,
    JSON,
    Object,
    Array,
  };
  expect(
    runInNewContext(
      coreRendererBootstrap({ schemaVersion: 1, mode: "core", disabled: [], holdUpdates: true }),
      context,
    ),
  ).toBe(true);
  expect(events).toEqual(["codexhost:core-usage"]);
  // No addEventListener in this context: hold failed on its own, the bridge still installed.
  expect(runInNewContext("globalThis.__codexhostFeatureFailuresV1", context)).toEqual([
    "update-hold",
  ]);
});

it("installs only in Codex documents: a window that navigated to a sign-in page gets nothing", () => {
  for (const protocol of ["https:", "about:", "http:"]) {
    const p = page({ protocol });
    expect(p.run(codexUpdateHoldScript(true))).toBe(false);
    expect(p.run(codexUpdateHoldFallbackScript(true))).toBe(false);
    expect(p.run("globalThis.__codexhostUpdateHoldV1")).toBeUndefined();
    expect(p.run("globalThis.__codexhostFeatureFailuresV1")).toBeUndefined();
  }
  // Tests on a plain browser pass their own protocol.
  expect(page({ protocol: "http:" }).run(codexUpdateHoldScript(true, "http:"))).toBe(true);
});

it("reports whether the hold was installed before the document's own scripts", async () => {
  const early = page({ document: { readyState: "loading", scripts: { length: 0 } } });
  early.run(codexUpdateHoldScript(true));
  expect(early.state()).toMatchObject({
    lateInstall: false,
    source: "early",
    installedAt: 12,
    firstGateAt: null,
  });
  early.view(realGates());
  await settle();
  expect(early.state()).toMatchObject({ firstGateAt: 12, observed: 1, sent: 1 });

  const late = page({ document: { readyState: "complete", scripts: { length: 4 } } });
  late.run(codexUpdateHoldFallbackScript(true));
  expect(late.state()).toMatchObject({ lateInstall: true, source: "fallback" });
  const parsing = page({ document: { readyState: "loading", scripts: { length: 2 } } });
  parsing.run(codexUpdateHoldScript(true));
  expect(parsing.state()).toMatchObject({ lateInstall: true });
});

it("the probe late-installs a document whose new-document script never ran and reports it", () => {
  const p = page({ document: { readyState: "complete", scripts: { length: 3 } } });
  expect(p.run(codexUpdateHoldProbeExpression(true))).toEqual({
    codex: true,
    blank: false,
    installed: true,
    lateInstall: true,
    source: "early",
    observed: 0,
    sent: 0,
    error: null,
    installedAt: 12,
    firstGateAt: null,
  });
  const blank = page({ protocol: "about:" });
  expect(blank.run(codexUpdateHoldProbeExpression(true))).toMatchObject({
    codex: false,
    blank: true,
    installed: false,
    lateInstall: null,
  });
  // A popup that navigated to a sign-in or third-party page.
  const signIn = page({ protocol: "https:" });
  expect(signIn.run(codexUpdateHoldProbeExpression(true))).toMatchObject({
    codex: false,
    blank: false,
    installed: false,
  });
});
