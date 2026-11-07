// Playwright fixture for the Hub bench: the real Hub pages of a built `RLY0 Hub.app`, served the
// way the macOS shell serves them, talking to a real, sandboxed Hub service (service.mjs).
//
// The page bridge mirrors apps/hub-desktop/macos/bridge.js + Rly0Hub.swift: request ids `w<n>`,
// method names `area.verb[.Sub]`, 64 KiB per request, SERVICE_STARTING before the service is
// ready, window.zoomGet / zoomSet answered by the shell (100% every start), window.capture
// unsupported, only `ready`, `quota` and `balance` service events forwarded, page files limited
// to the shell's MIME list, and no remote (http/https) loads, pop-ups or navigation.
import { test as base, expect, type Page, type TestInfo } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { startFakeRelay } from "./fake-relay.mjs";
import { appResources, startBenchService, type BenchService } from "./service.mjs";

export const APP = process.env.HUB_BENCH_APP || "";
export const ORIGIN = "http://hub.bench";
const TYPES: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  css: "text/css",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  woff2: "font/woff2",
};
const ID = /^w[0-9]{1,12}$/u;
const METHOD = /^[a-z]+(\.[a-zA-Z]+){1,2}$/u;
const ZOOM_STEPS = [0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6];

const BRIDGE = `(() => {
  "use strict";
  const listeners = new Set();
  const webview = Object.freeze({
    postMessage(message) { window.__benchPost(message); },
    addEventListener(type, listener) {
      if (type === "message" && typeof listener === "function") listeners.add(listener);
    },
    removeEventListener(type, listener) { if (type === "message") listeners.delete(listener); },
  });
  Object.defineProperty(window, "chrome", { value: Object.freeze({ webview }) });
  Object.defineProperty(window, "__rly0HubReceive", {
    value(message) { for (const listener of listeners) listener({ data: message }); },
  });
})();`;

export type BenchCall = {
  id: string;
  method: string;
  params: unknown;
  at: number;
  ms?: number;
  error?: string;
  result?: unknown;
};
export type BenchIssue = { type: string; text: string };

type FakeRelay = Awaited<ReturnType<typeof startFakeRelay>>;

export type Hub = {
  service: BenchService;
  /** The synthetic relay of a test that asked for one (`benchFakeRelay`). */
  relay: FakeRelay | null;
  calls: BenchCall[];
  issues: BenchIssue[];
  /** Loads the Hub page (index.html), optionally then switching to a page via the shell menu. */
  open(target?: string): Promise<void>;
  /** A shell event, as the 前往 menu or the tray would post it. */
  shellEvent(message: Record<string, unknown>): Promise<void>;
  /** Waits until the page has made a call to `method` and it has been answered. */
  waitForCall(method: string, options?: { after?: number; timeout?: number }): Promise<BenchCall>;
  callsTo(method: string): BenchCall[];
};

export type BenchOptions = {
  benchOffline: boolean;
  benchFakeRelay: boolean;
  benchSeed: ((home: string) => void) | undefined;
  benchEnvironment: Record<string, string>;
};

async function deliver(page: Page, message: unknown): Promise<void> {
  if (page.isClosed()) return;
  await page
    .evaluate(
      (value) =>
        (window as unknown as { __rly0HubReceive(m: unknown): void }).__rly0HubReceive(value),
      message,
    )
    .catch(() => undefined);
}

function attachText(testInfo: TestInfo, name: string, body: string) {
  return testInfo.attach(name, { body, contentType: "text/plain" });
}

export const test = base.extend<BenchOptions & { hub: Hub }>({
  benchOffline: [true, { option: true }],
  benchFakeRelay: [false, { option: true }],
  benchSeed: [undefined, { option: true }],
  benchEnvironment: [{}, { option: true }],
  hub: async (
    { page, context, benchOffline, benchFakeRelay, benchSeed, benchEnvironment },
    use,
    testInfo,
  ) => {
    if (!APP) throw new Error("HUB_BENCH_APP must point at a built RLY0 Hub.app");
    const resources = appResources(APP);
    const www = path.join(resources, "app", "hub-ui");
    // Started first: the sandbox only lets the service reach ports known when it starts.
    const relay = benchFakeRelay ? await startFakeRelay() : null;
    const service = await startBenchService({
      resources,
      offline: benchOffline,
      seed: benchSeed,
      extraEnvironment: benchEnvironment,
      allowPorts: relay ? [Number(new URL(relay.baseUrl).port)] : [],
    });
    const calls: BenchCall[] = [];
    const issues: BenchIssue[] = [];
    const inflight = new Set<string>();
    let loaded = false;
    let zoom = 1.0;

    page.on("pageerror", (error) => {
      // WebKit reports a deferred ResizeObserver round as an error event; it is not a script fault.
      const text = String(error.stack || error.message);
      if (/^ResizeObserver loop completed with undelivered notifications/u.test(error.message)) {
        issues.push({ type: "resize-observer-loop", text });
      } else issues.push({ type: "pageerror", text });
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      // Playwright's own screenshot styling, refused by the Hub's CSP; not a page fault.
      const harness = /^Refused to apply a stylesheet because its hash/u.test(message.text());
      issues.push({ type: harness ? "harness-style" : "console.error", text: message.text() });
    });
    page.on("dialog", (dialog) => {
      issues.push({ type: "dialog", text: `${dialog.type()}: ${dialog.message()}` });
      void dialog.dismiss();
    });
    context.on("page", (popup) => {
      issues.push({ type: "popup", text: popup.url() });
      void popup.close();
    });
    page.on("load", () => {
      loaded = true;
      // The shell posts `ready` once the page has loaded and the service is up.
      void deliver(page, { event: "ready" });
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) loaded = false;
    });

    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (url.origin !== ORIGIN) {
        issues.push({ type: "remote-load", text: route.request().url() });
        await route.abort("blockedbyclient");
        return;
      }
      if (route.request().isNavigationRequest() && url.pathname !== "/index.html") {
        issues.push({ type: "navigation", text: route.request().url() });
        await route.abort("blockedbyclient");
        return;
      }
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/u, "");
      const file = path.resolve(www, relative);
      const type = TYPES[path.extname(file).slice(1).toLowerCase()];
      if (!file.startsWith(www + path.sep) || !type || relative.includes("\\") || url.search) {
        issues.push({ type: "resource-rejected", text: url.pathname + url.search });
        await route.abort("accessdenied");
        return;
      }
      let body: Buffer;
      try {
        body = readFileSync(file);
      } catch {
        issues.push({ type: "resource-missing", text: url.pathname });
        await route.abort("filenotfound");
        return;
      }
      await route.fulfill({ status: 200, contentType: type, body });
    });

    const unsubscribe = service.onMessage((message) => {
      if (!loaded) return;
      const event = message.event;
      if (event === "quota" || event === "balance") void deliver(page, message);
    });

    await page.exposeBinding("__benchPost", async (_source, request: Record<string, unknown>) => {
      const { id, method, params } = request || {};
      if (
        typeof id !== "string" ||
        !ID.test(id) ||
        typeof method !== "string" ||
        !METHOD.test(method) ||
        !params ||
        typeof params !== "object" ||
        Array.isArray(params) ||
        JSON.stringify({ id, method, params }).length > 65536 ||
        inflight.has(id)
      ) {
        issues.push({ type: "bridge-rejected", text: JSON.stringify(request).slice(0, 300) });
        return;
      }
      const entry: BenchCall = { id, method, params, at: Date.now() };
      calls.push(entry);
      const answer = (message: Record<string, unknown>) => {
        entry.ms = Date.now() - entry.at;
        if (message.error) entry.error = String((message.error as { message?: unknown }).message);
        else entry.result = message.result;
        return deliver(page, message);
      };
      if (method === "window.zoomGet" || method === "window.zoomSet") {
        const next = (params as { zoom?: unknown }).zoom;
        if (method === "window.zoomSet" && typeof next === "number" && Number.isFinite(next)) {
          zoom = Math.max(0.8, Math.min(1.6, Math.round(next * 100) / 100));
        }
        await answer({ id, result: { zoom, steps: ZOOM_STEPS } });
        return;
      }
      if (method === "window.capture") {
        await answer({ id, error: { code: -32000, message: "CAPTURE_UNSUPPORTED" } });
        return;
      }
      if (service.exited) {
        await answer({ id, error: { code: -32000, message: "SERVICE_UNAVAILABLE" } });
        return;
      }
      inflight.add(id);
      try {
        const reply = await service.send({ id, method, params });
        await answer(reply as Record<string, unknown>);
      } catch (error) {
        await answer({ id, error: { code: -32000, message: String((error as Error).message) } });
      } finally {
        inflight.delete(id);
      }
    });
    await page.addInitScript({ content: BRIDGE });

    const hub: Hub = {
      service,
      relay,
      calls,
      issues,
      async open(target) {
        await page.goto(`${ORIGIN}/index.html`);
        if (target) await hub.shellEvent({ event: "navigate", page: target });
      },
      async shellEvent(message) {
        await deliver(page, message);
      },
      async waitForCall(method, options = {}) {
        const after = options.after ?? 0;
        let found: BenchCall | undefined;
        await expect
          .poll(
            () => {
              found = calls.find((c) => c.method === method && c.at >= after && c.ms !== undefined);
              return Boolean(found);
            },
            { timeout: options.timeout ?? 30_000, message: `page call ${method}` },
          )
          .toBe(true);
        return found as BenchCall;
      },
      callsTo: (method) => calls.filter((c) => c.method === method),
    };

    await use(hub);

    unsubscribe();
    await service.stop();
    await relay?.close();
    const failed = testInfo.status !== testInfo.expectedStatus;
    await attachText(
      testInfo,
      "bench-calls.json",
      JSON.stringify(
        calls.map(({ result, ...rest }) => ({
          ...rest,
          result: JSON.stringify(result ?? null).slice(0, 400),
        })),
        null,
        2,
      ),
    );
    await attachText(testInfo, "bench-issues.json", JSON.stringify(issues, null, 2));
    try {
      await attachText(
        testInfo,
        "service-stderr.log",
        readFileSync(service.stderrLog, "utf8").slice(-20000),
      );
    } catch {
      // no stderr output
    }
    service.dispose({ keep: failed && process.env.HUB_BENCH_KEEP === "1" });
  },
});

export { expect };
