import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CdpClient } from "../src/cdp-client.js";
import {
  startEarlyUpdateHold,
  type EarlyHoldBrowser,
  type EarlyHoldDiagnostics,
} from "../src/early-update-hold.js";

/**
 * Real Chromium: the early update hold against a throwaway headless Google Chrome (own temporary
 * profile and port, never a running Codex). Off by default; run with
 * `RLY0_REAL_CHROMIUM=1 npx vitest run --config tests/vitest.config.js <this file>`.
 * `RLY0_CHROME_PATH` overrides the browser binary. Pages are served over http, so the hold uses
 * `pageProtocol: "http:"` in place of Codex's `app:`.
 */
const CHROME =
  process.env.RLY0_CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const enabled = process.env.RLY0_REAL_CHROMIUM === "1";

/** A Codex-like page: reports a sparkle gate through the bridge event while it parses. */
const PAGE = `<!doctype html><script>
window.__holdBeforePage = !!globalThis.__codexhostUpdateHoldV1;
window.__sent = [];
window.electronBridge = { sendMessageFromView: async (message) => { window.__sent.push(message); } };
dispatchEvent(new CustomEvent("codex-message-from-view", { detail: {
  type: "electron-sparkle-gates-changed", preferMxc: false, disableInAppUpdates: false,
  disableSparkleAutodownload: false, useBackendAppcast: true } }));
</script><body>page</body>`;

const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

interface PageState {
  url: string;
  readyState: string;
  holdBeforePage: boolean | null;
  corrected: boolean;
  hold: Record<string, unknown> | null;
}

describe.skipIf(!enabled)("early update hold on a real Chromium", () => {
  let chrome: ChildProcess | undefined;
  let profile = "";
  let server: Server | undefined;
  let endpoint = "";
  let base = "";
  let control: CdpClient | undefined;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(PAGE);
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no server address");
    base = `http://127.0.0.1:${address.port}`;
    profile = mkdtempSync(path.join(tmpdir(), "rly0-early-hold-chrome-"));
    chrome = spawn(
      CHROME,
      [
        "--headless=new",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-component-extensions-with-background-pages",
        "--disable-background-networking",
        "--disable-popup-blocking",
        "about:blank",
      ],
      { stdio: "ignore" },
    );
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let index = 0; index < 150 && !endpoint; index += 1) {
      await sleep(100);
      if (existsSync(portFile)) {
        const port = readFileSync(portFile, "utf8").split("\n")[0]?.trim();
        if (port) endpoint = `http://127.0.0.1:${port}`;
      }
    }
    if (!endpoint) throw new Error("Chrome did not open its debugging port");
    const version = (await (await fetch(`${endpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    control = await CdpClient.connect(version.webSocketDebuggerUrl, { commandTimeoutMs: 5_000 });
  }, 30_000);

  afterAll(async () => {
    control?.close();
    if (chrome && chrome.exitCode === null) {
      const exited = new Promise((resolve) => chrome?.once("exit", resolve));
      chrome.kill("SIGTERM");
      await Promise.race([exited, sleep(5_000)]);
      if (chrome.exitCode === null && chrome.signalCode === null) chrome.kill("SIGKILL");
    }
    await new Promise((resolve) => server?.close(resolve));
    if (profile) rmSync(profile, { recursive: true, force: true });
  }, 30_000);

  const cdp = (): CdpClient => {
    if (!control) throw new Error("no browser connection");
    return control;
  };
  const running: { early: { finished: Promise<void> }; abort: AbortController }[] = [];
  // A failed assertion must not leave an auto-attach session behind for the next case.
  afterEach(async () => {
    for (const entry of running.splice(0)) {
      entry.abort.abort();
      await entry.early.finished;
    }
  });
  // Each case starts with only the opener page, so "main window" diagnostics refer to its page.
  beforeEach(async () => {
    for (const target of await targets())
      if (target.url !== "about:blank")
        await cdp().command("Target.closeTarget", { targetId: target.targetId });
    await sleep(200);
  });

  const targets = async () =>
    (
      (await cdp().command("Target.getTargets")) as {
        targetInfos: { targetId: string; type: string; url: string }[];
      }
    ).targetInfos.filter((target) => target.type === "page");

  /** Reads a page through a separate explicit session (released first, harmlessly). */
  const pageState = async (targetId: string): Promise<PageState> => {
    const { sessionId } = (await cdp().command("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };
    try {
      const response = (await cdp().sessionCommand(sessionId, "Runtime.evaluate", {
        expression: `({ url: location.href, readyState: document.readyState,
          holdBeforePage: typeof window.__holdBeforePage === "boolean" ? window.__holdBeforePage : null,
          corrected: Array.isArray(window.__sent) && window.__sent.some((m) => m.disableSparkleAutodownload === true && m.disableInAppUpdates === null),
          hold: globalThis.__codexhostUpdateHoldV1 ? JSON.parse(JSON.stringify({ ...globalThis.__codexhostUpdateHoldV1, setHold: undefined })) : null })`,
        returnByValue: true,
      })) as { result: { value: PageState } };
      return response.result.value;
    } finally {
      await cdp()
        .command("Target.detachFromTarget", { sessionId })
        .catch(() => undefined);
    }
  };

  /** window.open from the first page, with a user gesture; never awaits a paused popup. */
  const openPopup = async (url: string): Promise<void> => {
    const opener = (await targets()).find((target) => target.url === "about:blank");
    if (!opener) throw new Error("no opener page");
    const { sessionId } = (await cdp().command("Target.attachToTarget", {
      targetId: opener.targetId,
      flatten: true,
    })) as { sessionId: string };
    void cdp()
      .sessionCommand(sessionId, "Runtime.evaluate", {
        expression: `window.open(${JSON.stringify(url)}); true`,
        userGesture: true,
      })
      .catch(() => undefined)
      .finally(() =>
        cdp()
          .command("Target.detachFromTarget", { sessionId })
          .catch(() => 0),
      );
  };

  const waitForPage = async (url: string, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const target = (await targets()).find((entry) => entry.url === url);
      if (target) {
        const state = await pageState(target.targetId);
        if (state.readyState === "complete") return { target, state };
      }
      await sleep(100);
    }
    return null;
  };

  /** The stranded-target case: auto-attach pauses a popup and the connection is dropped. */
  const strandPopup = async (url: string): Promise<string> => {
    const version = (await (await fetch(`${endpoint}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const crashed = await CdpClient.connect(version.webSocketDebuggerUrl);
    let pausedTarget = "";
    crashed.on("Target.attachedToTarget", (params) => {
      const info = (params as { targetInfo: { targetId: string; url: string; type: string } })
        .targetInfo;
      if (info.type === "page" && info.url === "") pausedTarget = info.targetId;
    });
    await crashed.command("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    await openPopup(url);
    for (let index = 0; index < 50 && !pausedTarget; index += 1) await sleep(50);
    crashed.close(); // No release: Chromium keeps the popup paused.
    await sleep(1_000);
    const stuck = (await targets()).find((target) => target.targetId === pausedTarget);
    expect(stuck?.url).toBe("");
    return pausedTarget;
  };

  const start = (
    options: {
      wrap?: (browser: EarlyHoldBrowser) => EarlyHoldBrowser;
      onDiagnostics?: (diagnostics: EarlyHoldDiagnostics) => void;
    } = {},
  ) => {
    const abort = new AbortController();
    const wrap = options.wrap;
    const early = startEarlyUpdateHold({
      rendererCdpEndpoint: endpoint,
      hold: true,
      signal: abort.signal,
      pageProtocol: "http:",
      ...(options.onDiagnostics ? { onDiagnostics: options.onDiagnostics } : {}),
      ...(wrap
        ? {
            connectBrowser: async () => {
              const version = (await (await fetch(`${endpoint}/json/version`)).json()) as {
                webSocketDebuggerUrl: string;
              };
              return wrap(await CdpClient.connect(version.webSocketDebuggerUrl));
            },
          }
        : {}),
    });
    running.push({ early, abort });
    return { early, abort };
  };
  const attached = async (early: { state(): string }) => {
    for (let index = 0; index < 100 && early.state() !== "attached"; index += 1) await sleep(50);
    expect(early.state()).toBe("attached");
  };

  it("window.open: the popup is paused, the hold runs before the page's scripts, then it loads", async () => {
    const reports: EarlyHoldDiagnostics[] = [];
    const { early, abort } = start({ onDiagnostics: (d) => reports.push(d) });
    await attached(early);
    const url = `${base}/window-open`;
    await openPopup(url);
    const loaded = await waitForPage(url);
    expect(loaded?.state).toMatchObject({ holdBeforePage: true, corrected: true });
    expect(loaded?.state.hold).toMatchObject({ lateInstall: false, source: "early", sent: 1 });
    for (let index = 0; index < 40 && !reports.at(-1)?.mainWindow; index += 1) await sleep(50);
    const report = reports.at(-1);
    console.info("[real-chromium] window.open diagnostics", JSON.stringify(report));
    expect(report).toMatchObject({
      holdBeforePageScripts: true,
      mainWindow: { waitingAtAttach: true, attachedUrl: "empty", lateInstall: false },
    });
    abort.abort();
    await early.finished;
  }, 30_000);

  it("Target.createTarget with a URL: records whether the hold ran before the page's scripts", async () => {
    const reports: EarlyHoldDiagnostics[] = [];
    const { early, abort } = start({ onDiagnostics: (d) => reports.push(d) });
    await attached(early);
    const url = `${base}/create-target`;
    await cdp().command("Target.createTarget", { url });
    const loaded = await waitForPage(url);
    if (!loaded) throw new Error("the created page did not load");
    // The probe installs the hold late when the new-document script came too late.
    for (let index = 0; index < 40 && !loaded.state.hold; index += 1) {
      await sleep(50);
      loaded.state = await pageState(loaded.target.targetId);
    }
    for (let index = 0; index < 40 && !reports.at(-1)?.mainWindow; index += 1) await sleep(50);
    console.info(
      "[real-chromium] createTarget",
      JSON.stringify({ state: loaded.state, diagnostics: reports.at(-1) }),
    );
    expect(loaded.state.hold).not.toBeNull();
    // The page and the diagnostics agree on the order, whichever it was.
    expect(loaded.state.hold?.lateInstall).toBe(!loaded.state.holdBeforePage);
    expect(reports.at(-1)?.holdBeforePageScripts).toBe(loaded.state.holdBeforePage);
    // Observed on Chrome 157: reported as paused, yet the page's scripts had already run.
    expect(reports.at(-1)?.mainWindow).toMatchObject({ waitingAtAttach: true });
    expect(loaded.state.holdBeforePage).toBe(false);
    abort.abort();
    await early.finished;
  }, 30_000);

  it("a popup stranded by a dropped connection is released when the hold (re)connects", async () => {
    const url = `${base}/stranded`;
    await strandPopup(url);
    const { early, abort } = start();
    await attached(early);
    expect(await waitForPage(url)).not.toBeNull();
    abort.abort();
    await early.finished;
  }, 30_000);

  it("its own connection dropping mid-pause: the reconnect releases the popup", async () => {
    let first = true;
    let firstClient: EarlyHoldBrowser | undefined;
    const { early, abort } = start({
      wrap: (browser) => {
        if (!first) return browser;
        first = false;
        firstClient = browser;
        // The first connection never releases anything (a crash right after the pause).
        return {
          command: (method, params) => browser.command(method, params),
          sessionCommand: (sessionId, method, params) =>
            method === "Runtime.runIfWaitingForDebugger"
              ? new Promise(() => undefined)
              : browser.sessionCommand(sessionId, method, params),
          on: (method, listener) => browser.on(method, listener),
          onClose: (listener) => browser.onClose(listener),
          close: () => browser.close(),
        };
      },
    });
    await attached(early);
    const url = `${base}/reconnect`;
    await openPopup(url);
    await sleep(800);
    expect((await targets()).some((target) => target.url === "")).toBe(true);
    firstClient?.close(); // Connection lost: the loop reconnects after a second.
    expect(await waitForPage(url, 10_000)).not.toBeNull();
    abort.abort();
    await early.finished;
  }, 30_000);

  it("a deliberate stop leaves no paused target, and later windows open normally", async () => {
    let lose = true;
    const { early, abort } = start({
      wrap: (browser) => ({
        command: (method, params) => browser.command(method, params),
        // Releases before the stop are lost: the popup stays paused until the stop releases it.
        sessionCommand: (sessionId, method, params) =>
          lose && method === "Runtime.runIfWaitingForDebugger"
            ? Promise.reject(new Error("lost"))
            : browser.sessionCommand(sessionId, method, params),
        on: (method, listener) => browser.on(method, listener),
        onClose: (listener) => browser.onClose(listener),
        close: () => browser.close(),
      }),
    });
    await attached(early);
    const url = `${base}/stop`;
    await openPopup(url);
    await sleep(800);
    expect((await targets()).some((target) => target.url === "")).toBe(true);
    lose = false;
    abort.abort();
    await early.finished;
    expect(await waitForPage(url)).not.toBeNull();
    // Auto-attach is off: a later window is not paused.
    const later = `${base}/after-stop`;
    await openPopup(later);
    expect(await waitForPage(later)).not.toBeNull();
    expect((await targets()).filter((target) => target.url === "")).toEqual([]);
  }, 30_000);
});
