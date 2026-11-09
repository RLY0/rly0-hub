import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  parseDesktopControllerArguments,
  runDesktopController,
  RENDERER_DISABLED_MESSAGE,
  serializeDesktopControllerReadiness,
  type DesktopControllerDependencies,
} from "../src/production-controller.js";
import type { DesktopControllerStatusDocument } from "../src/controller-status.js";
import type { RendererCdpControlSession } from "../src/renderer-cdp-control-session.js";
import { CdpConnectionClosedError } from "../src/cdp-client.js";
import { codexUpdateHoldPushExpression, codexUpdateHoldScript } from "../src/codex-update-hold.js";

const attachmentNonce = "0123456789abcdef0123456789abcdef";

function controllerOptions() {
  return {
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    rendererPath: "/renderer.js",
    attachmentPort: 43124,
    attachmentNonce,
  };
}

function attachmentServer() {
  return { close: vi.fn(async () => {}) };
}

function controllerSnapshot(): RendererCdpControlSession["snapshot"] {
  return {} as RendererCdpControlSession["snapshot"];
}

describe("production Desktop Controller", () => {
  it("accepts only a loopback Renderer CDP endpoint, absolute Renderer path, and strict attachment fields", () => {
    const rendererPath = path.resolve("fixtures/renderer-extension.js");
    expect(
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        attachmentNonce,
      ]),
    ).toEqual({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererPath,
      attachmentPort: 43124,
      attachmentNonce,
    });
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://example.com:43123",
        "--renderer",
        "/renderer.js",
      ]),
    ).toThrow("loopback HTTP origin");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        "renderer.js",
      ]),
    ).toThrow("absolute path");
    expect(() =>
      parseDesktopControllerArguments([
        "--renderer-cdp-endpoint",
        "http://127.0.0.1:43123",
        "--renderer",
        rendererPath,
        "--attachment-port",
        "43124",
        "--attachment-nonce",
        "bad",
      ]),
    ).toThrow("32 lowercase hexadecimal");
  });

  it("accepts --no-renderer once as a valueless safe-mode switch", () => {
    const base = [
      "--renderer-cdp-endpoint",
      "http://127.0.0.1:43123",
      "--renderer",
      path.resolve("fixtures/renderer-extension.js"),
      "--attachment-port",
      "43124",
      "--attachment-nonce",
      attachmentNonce,
    ];
    expect(parseDesktopControllerArguments([...base, "--no-renderer"]).noRenderer).toBe(true);
    expect(parseDesktopControllerArguments(["--no-renderer", ...base]).noRenderer).toBe(true);
    expect(parseDesktopControllerArguments(base)).not.toHaveProperty("noRenderer");
    expect(() =>
      parseDesktopControllerArguments([...base, "--no-renderer", "--no-renderer"]),
    ).toThrow("only be provided once");
  });

  it("in safe mode keeps the handshake and attachment but never installs the Renderer", async () => {
    const abort = new AbortController();
    const ready = vi.fn();
    const install = vi.fn();
    const readRenderer = vi.fn(async () => "production renderer");
    const bringToFront = vi.fn(async () => {
      throw new Error("no window yet");
    });
    const published: DesktopControllerStatusDocument[] = [];
    const server = attachmentServer();
    let handlers!: Parameters<DesktopControllerDependencies["startAttachmentServer"]>[0];
    let ticks = 0;
    await runDesktopController({ ...controllerOptions(), noRenderer: true }, abort.signal, {
      readRenderer,
      install,
      startAttachmentServer: vi.fn(async (options) => {
        handlers = options;
        return server;
      }),
      ready,
      publishStatus: (document) => published.push(document),
      bringToFront,
      sleep: vi.fn(async () => {
        ticks += 1;
        if (ticks === 3) abort.abort();
      }),
      monitorIntervalMs: 1,
    });

    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(install).not.toHaveBeenCalled();
    expect(readRenderer).not.toHaveBeenCalled();
    expect(published.map((document) => document.renderer.state)).toEqual(["disabled"]);
    // Attach still succeeds (the Desktop is running) even when the window cannot be raised.
    await expect(handlers.attach()).resolves.toBeUndefined();
    expect(bringToFront).toHaveBeenCalledWith("http://127.0.0.1:43123");
    await expect(handlers.openLocalPage?.("http://127.0.0.1:1/")).rejects.toThrow(
      RENDERER_DISABLED_MESSAGE,
    );
    expect(install).not.toHaveBeenCalled();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("serializes only strict and bounded readiness results", () => {
    expect(
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "compatible",
        issues: [],
      }),
    ).toBe('{"schemaVersion":2,"state":"compatible","issues":[]}');
    expect(() =>
      serializeDesktopControllerReadiness({
        schemaVersion: 2,
        state: "incompatible",
        issues: [],
      } as never),
    ).toThrow("readiness is invalid");
  });

  it("signals compatible readiness, serves attachment, and monitors recovery", async () => {
    const abort = new AbortController();
    const snapshot = controllerSnapshot();
    const ensureInstalled = vi.fn(async () => {
      abort.abort();
      return snapshot;
    });
    const activateDesktop = vi.fn(async () => 1);
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot,
      ensureInstalled,
      activateDesktop,
      executeRenderer: vi.fn(),
      close,
    };
    const ready = vi.fn();
    const install = vi.fn(async () => session);
    const server = attachmentServer();
    let attach: (() => Promise<void>) | undefined;
    const startAttachmentServer = vi.fn(async (options) => {
      attach = options.attach;
      return server;
    });
    const dependencies: DesktopControllerDependencies = {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    };

    await runDesktopController(controllerOptions(), abort.signal, dependencies);

    expect(install).toHaveBeenCalledWith({
      rendererCdpEndpoint: "http://127.0.0.1:43123",
      rendererSource: `globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;\nglobalThis.__codexhostFeaturePolicyV1 = {"schemaVersion":1,"mode":"full","disabled":[],"holdUpdates":false};\ntry { ${codexUpdateHoldScript(false)} } catch {}\nproduction renderer`,
      timeoutMs: 90_000,
      signal: abort.signal,
    });
    expect(startAttachmentServer).toHaveBeenCalledWith({
      port: 43124,
      nonce: attachmentNonce,
      attach: expect.any(Function),
      openLocalPage: expect.any(Function),
      remoteConnections: expect.any(Function),
    });
    expect(ready).toHaveBeenCalledWith({
      schemaVersion: 2,
      state: "compatible",
      issues: [],
    });
    expect(ensureInstalled).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(attach).toEqual(expect.any(Function));
  });

  it("publishes readiness before a pending Renderer install finishes", async () => {
    const abort = new AbortController();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(async () => controllerSnapshot()),
      activateDesktop: vi.fn(async () => 1),
      executeRenderer: vi.fn(),
      close,
    };
    let finishInstall!: (value: RendererCdpControlSession) => void;
    const install = vi.fn(
      () =>
        new Promise<RendererCdpControlSession>((resolve) => {
          finishInstall = resolve;
        }),
    );
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    const run = runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {
        abort.abort();
      }),
      monitorIntervalMs: 1,
    });

    await vi.waitFor(() => {
      expect(ready).toHaveBeenCalledWith({
        schemaVersion: 2,
        state: "compatible",
        issues: [],
      });
    });
    expect(startAttachmentServer).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();

    finishInstall(session);
    await run;
    expect(install).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("Promise was collected"),
    new CdpConnectionClosedError("CDP WebSocket closed"),
  ])("retries a transient Renderer startup failure: %s", async (secondFailure) => {
    const abort = new AbortController();
    abort.abort();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(
        new Error("Renderer installation failed", {
          cause: new Error("Execution context was destroyed during Renderer reload"),
        }),
      )
      .mockRejectedValueOnce(secondFailure)
      .mockResolvedValueOnce(session);
    const ready = vi.fn();
    const sleep = vi.fn(async () => {});

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready,
      sleep,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(250);
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("recovers an unclassified inspection failure after managed readiness", async () => {
    const abort = new AbortController();
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(new Error("Inspector target is not ready"))
      .mockResolvedValueOnce(session);
    const ready = vi.fn();
    let currentTime = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      if (milliseconds === 1) currentTime += 30_000;
      if (install.mock.calls.length >= 2) abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready,
      sleep,
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses a structural installation failure and starts attachment", async () => {
    const abort = new AbortController();
    abort.abort();
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    const install = vi.fn(async () => {
      throw new Error("Production Renderer Adapter is unsupported: signature-mismatch");
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledOnce();
    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(JSON.stringify(ready.mock.calls)).not.toContain("signature-mismatch");
    expect(startAttachmentServer).toHaveBeenCalledOnce();
  });

  it("publishes Renderer integration failure and recovery for the console", async () => {
    const abort = new AbortController();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close: vi.fn(),
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(
        new Error("Production Renderer Adapter is unsupported: signature-mismatch"),
      )
      .mockResolvedValueOnce(session);
    const publishStatus = vi.fn();
    let currentTime = 0;

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready: vi.fn(),
      publishStatus,
      sleep: vi.fn(async (milliseconds: number) => {
        if (milliseconds === 1) currentTime += 30_000;
        if (install.mock.calls.length >= 2) abort.abort();
      }),
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    const states = publishStatus.mock.calls.map(([document]) => document.renderer);
    expect(states.map((renderer) => renderer.state)).toEqual([
      "installing",
      "unavailable",
      "installing",
      "installed",
    ]);
    expect(states[1]).toMatchObject({
      error: "Production Renderer Adapter is unsupported: signature-mismatch",
      failures: 1,
    });
    expect(states[3]).toMatchObject({
      error: null,
      failures: 1,
      lastError: "Production Renderer Adapter is unsupported: signature-mismatch",
      lastFailedAt: 0,
      lastInstalledAt: 30_000,
    });
  });

  it("suppresses an unclassified inspection failure without leaking its error", async () => {
    const abort = new AbortController();
    abort.abort();
    const ready = vi.fn();
    const startAttachmentServer = vi.fn(async () => attachmentServer());
    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => {
        throw new Error("/private/user/path and request details");
      }),
      install: vi.fn(),
      startAttachmentServer,
      ready,
      sleep: vi.fn(async () => {}),
      monitorIntervalMs: 1,
    });

    expect(ready).toHaveBeenCalledWith({ schemaVersion: 2, state: "compatible", issues: [] });
    expect(JSON.stringify(ready.mock.calls)).not.toContain("private/user");
    expect(startAttachmentServer).toHaveBeenCalledOnce();
  });

  it("installs on demand when attachment arrives during recovery", async () => {
    const abort = new AbortController();
    const activateDesktop = vi.fn(async () => 1);
    const close = vi.fn();
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop,

      executeRenderer: vi.fn(),
      close,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockRejectedValueOnce(new Error("Composer is not ready"))
      .mockResolvedValueOnce(session);
    let attach: (() => Promise<void>) | undefined;
    const startAttachmentServer = vi.fn(async (options) => {
      attach = options.attach;
      return attachmentServer();
    });
    const sleep = vi.fn(async () => {
      await attach?.();
      abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer,
      ready: vi.fn(),
      sleep,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(activateDesktop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("replaces a ready Session after Renderer recovery fails", async () => {
    const abort = new AbortController();
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    const first: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(async () => {
        throw new Error("Renderer binding disappeared");
      }),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close: firstClose,
    };
    const second: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(),
      activateDesktop: vi.fn(async () => 1),

      executeRenderer: vi.fn(),
      close: secondClose,
    };
    const install = vi
      .fn<DesktopControllerDependencies["install"]>()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    let monitorCycles = 0;
    let currentTime = 0;
    const sleep = vi.fn(async () => {
      monitorCycles += 1;
      currentTime += 30_000;
      if (monitorCycles === 3) abort.abort();
    });

    await runDesktopController(controllerOptions(), abort.signal, {
      readRenderer: vi.fn(async () => "production renderer"),
      install,
      startAttachmentServer: vi.fn(async () => attachmentServer()),
      ready: vi.fn(),
      sleep,
      now: () => currentTime,
      monitorIntervalMs: 1,
    });

    expect(install).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledOnce();
    expect(secondClose).toHaveBeenCalledOnce();
  });
});

it.each([false, true])(
  "core mode avoids full injection and falls back without injection on failure=%s",
  async (fail) => {
    const abort = new AbortController();
    const fullInstall = vi.fn();
    const readRenderer = vi.fn();
    const installed: DesktopControllerStatusDocument[] = [];
    const session: RendererCdpControlSession = {
      snapshot: controllerSnapshot(),
      ensureInstalled: vi.fn(async () => controllerSnapshot()),
      activateDesktop: vi.fn(async () => 1),
      executeRenderer: vi.fn(),
      close: vi.fn(),
      dispose: vi.fn(async () => undefined),
    };
    const coreInstall = vi.fn(async () => {
      if (fail) throw new Error("synthetic unsupported core");
      return session;
    });
    let ticks = 0;
    await runDesktopController(controllerOptions(), abort.signal, {
      readPolicy: async () => ({ schemaVersion: 1, mode: "core", disabled: [] }),
      install: fullInstall,
      readRenderer,
      installCore: coreInstall,
      startAttachmentServer: async () => attachmentServer(),
      ready: vi.fn(),
      publishStatus: (status) => installed.push(status),
      sleep: async () => {
        if (++ticks > 2) abort.abort();
      },
      monitorIntervalMs: 1,
    });
    expect(fullInstall).not.toHaveBeenCalled();
    expect(readRenderer).not.toHaveBeenCalled();
    expect(coreInstall).toHaveBeenCalledOnce();
    expect(installed.map((entry) => entry.renderer.state)).toContain(fail ? "disabled" : "core");
    if (!fail) expect(session.dispose).toHaveBeenCalledOnce();
  },
);

it("pushes an update-hold change into the running page without reinstalling the session", async () => {
  const abort = new AbortController();
  const executed: string[] = [];
  const session: RendererCdpControlSession = {
    snapshot: controllerSnapshot(),
    ensureInstalled: vi.fn(async () => controllerSnapshot()),
    activateDesktop: vi.fn(async () => 1),
    executeRenderer: vi.fn(async (expression: string) => {
      executed.push(expression);
      return true as never;
    }),
    close: vi.fn(),
    dispose: vi.fn(async () => undefined),
  };
  const coreInstall = vi.fn<
    (options: {
      policy: { holdUpdates?: boolean | undefined };
    }) => Promise<RendererCdpControlSession>
  >(async () => session);
  // Hub releases the hold (an armed update) while Codex keeps running.
  let hold = true;
  let ticks = 0;
  const realSetInterval = globalThis.setInterval;
  const intervals: (() => void)[] = [];
  vi.stubGlobal("setInterval", (callback: () => void) => {
    intervals.push(callback);
    return realSetInterval(() => undefined, 1_000_000);
  });
  try {
    await runDesktopController(controllerOptions(), abort.signal, {
      readPolicy: async () => ({ schemaVersion: 1, mode: "core", disabled: [], holdUpdates: hold }),
      install: vi.fn(),
      readRenderer: vi.fn(),
      installCore: coreInstall,
      startAttachmentServer: async () => attachmentServer(),
      ready: vi.fn(),
      sleep: async () => {
        ticks += 1;
        if (ticks === 2) {
          hold = false;
          for (const callback of intervals) callback();
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        if (ticks > 4) abort.abort();
      },
      monitorIntervalMs: 1,
    });
  } finally {
    vi.unstubAllGlobals();
  }
  expect(coreInstall).toHaveBeenCalledOnce();
  expect(coreInstall.mock.calls[0]?.[0].policy.holdUpdates).toBe(true);
  expect(session.dispose).toHaveBeenCalledOnce(); // Only at shutdown, not on the hold change.
  expect(executed).toContain(codexUpdateHoldPushExpression(false));
  expect(executed).not.toContain(codexUpdateHoldPushExpression(true));
});
