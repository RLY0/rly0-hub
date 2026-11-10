import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { CdpClient } from "../src/cdp-client.js";
import { codexUpdateHoldFallbackScript } from "../src/codex-update-hold.js";
import {
  startEarlyUpdateHold,
  type EarlyHoldDiagnostics,
  type EarlyUpdateHold,
} from "../src/early-update-hold.js";

interface Sent {
  id: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
type Listener = (event: { data?: unknown }) => void;

/**
 * A browser-level DevTools endpoint speaking the real wire format: commands are
 * `{id, method, params, sessionId?}`; flattened session events carry `sessionId` at the top level,
 * browser-level `Target.attachedToTarget` events do not.
 */
class FakeBrowser {
  readonly sent: Sent[] = [];
  readonly hang = new Set<string>();
  readonly fail = new Set<string>();
  /** Targets that exist before auto-attach; reported (not paused) by setAutoAttach. */
  existing: { targetId: string; type: string; url: string; reported?: boolean }[] = [];
  /** `Runtime.evaluate` result value (the probe reads page diagnostics). */
  evaluateValue: unknown = true;
  #listeners = new Map<string, Set<Listener>>();
  #script = 0;
  #session = 0;
  closed = false;

  socket() {
    return {
      addEventListener: (type: string, listener: Listener) => {
        const set = this.#listeners.get(type) ?? new Set();
        set.add(listener);
        this.#listeners.set(type, set);
        if (type === "open") queueMicrotask(() => listener({}));
      },
      removeEventListener: (type: string, listener: Listener) => {
        this.#listeners.get(type)?.delete(listener);
      },
      send: (data: string) => this.#receive(JSON.parse(data) as Sent),
      close: () => this.drop(),
    };
  }

  #emit(value: unknown) {
    for (const listener of this.#listeners.get("message") ?? [])
      listener({ data: JSON.stringify(value) });
  }

  attached(type: string, url: string, waitingForDebugger: boolean, targetId?: string) {
    const sessionId = `S${++this.#session}`;
    this.#emit({
      method: "Target.attachedToTarget",
      params: {
        sessionId,
        targetInfo: {
          targetId: targetId ?? `T${this.#session}`,
          type,
          title: "",
          url,
          attached: true,
          canAccessOpener: false,
          browserContextId: "B1",
        },
        waitingForDebugger,
      },
    });
    return sessionId;
  }

  detached(sessionId: string, targetId: string) {
    this.#emit({ method: "Target.detachedFromTarget", params: { sessionId, targetId } });
  }

  drop() {
    if (this.closed) return;
    this.closed = true;
    for (const listener of this.#listeners.get("close") ?? []) listener({});
  }

  #receive(command: Sent) {
    this.sent.push(command);
    if (this.hang.has(command.method)) return;
    if (this.fail.has(command.method)) {
      queueMicrotask(() =>
        this.#emit({ id: command.id, error: { code: -32000, message: "Not allowed" } }),
      );
      return;
    }
    let result: Record<string, unknown> = {};
    if (command.method === "Page.addScriptToEvaluateOnNewDocument")
      result = { identifier: String(++this.#script) };
    if (command.method === "Runtime.evaluate")
      result = { result: { type: "object", value: this.evaluateValue } };
    if (command.method === "Target.setAutoAttach")
      for (const target of this.existing)
        if (target.reported !== false)
          this.attached(target.type, target.url, false, target.targetId);
    if (command.method === "Target.getTargets")
      result = {
        targetInfos: this.existing.map((target) => ({
          ...target,
          title: "",
          attached: true,
          canAccessOpener: false,
        })),
      };
    if (command.method === "Target.attachToTarget") {
      const target = this.existing.find((entry) => entry.targetId === command.params.targetId);
      const sessionId = target
        ? this.attached(target.type, target.url, false, target.targetId)
        : this.attached("page", "", false, String(command.params.targetId));
      result = { sessionId };
    }
    queueMicrotask(() => this.#emit({ id: command.id, result }));
  }

  of(sessionId: string) {
    return this.sent.filter((command) => command.sessionId === sessionId).map((c) => c.method);
  }
}

const settle = async (rounds = 5) => {
  for (let index = 0; index < rounds; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
};
const until = async (condition: () => boolean) => {
  for (let index = 0; index < 200 && !condition(); index += 1) await settle(1);
  expect(condition()).toBe(true);
};

const running: { abort: AbortController; hold: EarlyUpdateHold }[] = [];
afterEach(async () => {
  for (const entry of running.splice(0)) {
    entry.abort.abort();
    await entry.hold.finished;
  }
});

function start(
  browsers: FakeBrowser[],
  hold: boolean,
  options: {
    releaseTimeoutMs?: number;
    commandTimeoutMs?: number;
    after?: Promise<void>;
    onDiagnostics?: (diagnostics: EarlyHoldDiagnostics) => void;
  } = {},
) {
  const abort = new AbortController();
  let connections = 0;
  const instance = startEarlyUpdateHold({
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    hold,
    signal: abort.signal,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    releaseTimeoutMs: options.releaseTimeoutMs ?? 50,
    commandTimeoutMs: options.commandTimeoutMs ?? 100,
    ...(options.after ? { after: options.after } : {}),
    ...(options.onDiagnostics ? { onDiagnostics: options.onDiagnostics } : {}),
    connectBrowser: async () => {
      const browser = browsers[connections];
      connections += 1;
      if (!browser) throw new Error("ECONNREFUSED");
      return CdpClient.connect("ws://127.0.0.1:43123/devtools/browser/fake", {
        socketFactory: () => browser.socket() as never,
      });
    },
  });
  running.push({ abort, hold: instance });
  return Object.assign(instance, { abort });
}

it("auto-attaches with waitForDebuggerOnStart and registers the hold before releasing a paused page", async () => {
  const browser = new FakeBrowser();
  const early = start([browser], true);
  await until(() => early.state() === "attached");
  expect(browser.sent[0]).toMatchObject({
    method: "Target.setAutoAttach",
    params: { autoAttach: true, waitForDebuggerOnStart: true, flatten: true },
  });
  const session = browser.attached("page", "app://-/index.html", true);
  await until(() => browser.of(session).includes("Runtime.runIfWaitingForDebugger"));
  await until(() => browser.of(session).length === 4);
  // Released, then probed (late-installs a document whose new-document script did not run).
  expect(browser.of(session)).toEqual([
    "Page.enable",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.runIfWaitingForDebugger",
    "Runtime.evaluate",
  ]);
  const script = browser.sent.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
  expect(script?.params.source).toMatch(/\(globalThis, true, true, "app:"\);$/);
  // A new window may be paused before its first navigation.
  const blank = browser.attached("page", "about:blank", true);
  await until(() => browser.of(blank).includes("Runtime.runIfWaitingForDebugger"));
  expect(browser.of(blank)).toContain("Page.addScriptToEvaluateOnNewDocument");
});

it("still releases a paused page when preparation hangs or fails", async () => {
  const hanging = new FakeBrowser();
  hanging.hang.add("Page.enable");
  const early = start([hanging], true, { releaseTimeoutMs: 20 });
  await until(() => early.state() === "attached");
  const session = hanging.attached("page", "app://-/index.html", true);
  await until(() => hanging.of(session).includes("Runtime.runIfWaitingForDebugger"));
  expect(hanging.of(session)).not.toContain("Page.addScriptToEvaluateOnNewDocument");

  const failing = new FakeBrowser();
  failing.fail.add("Page.addScriptToEvaluateOnNewDocument");
  const second = start([failing], false);
  await until(() => second.state() === "attached");
  const other = failing.attached("page", "app://-/index.html", true);
  await until(() => failing.of(other).includes("Runtime.runIfWaitingForDebugger"));
});

it("releases and detaches non-page targets and non-Codex pages at once", async () => {
  const browser = new FakeBrowser();
  const early = start([browser], true);
  await until(() => early.state() === "attached");
  const worker = browser.attached("service_worker", "app://-/sw.js", true);
  const signIn = browser.attached("page", "https://auth.openai.com/", true);
  const quiet = browser.attached("shared_worker", "app://-/w.js", false);
  await until(
    () => browser.sent.filter((c) => c.method === "Target.detachFromTarget").length === 3,
  );
  // Released even when reported as not waiting: a reconnect reports stranded targets that way.
  expect(browser.of(worker)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  expect(browser.of(signIn)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  expect(browser.of(quiet)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  expect(
    browser.sent.filter((c) => c.method === "Target.detachFromTarget").map((c) => c.params),
  ).toEqual([{ sessionId: worker }, { sessionId: signIn }, { sessionId: quiet }]);
});

it("installs into pages that already exist: script for reloads, then immediate evaluate", async () => {
  const browser = new FakeBrowser();
  browser.existing = [
    { targetId: "MAIN", type: "page", url: "app://-/index.html" },
    { targetId: "MISSED", type: "page", url: "app://-/index.html", reported: false },
    { targetId: "SW", type: "service_worker", url: "app://-/sw.js", reported: false },
  ];
  const early = start([browser], true);
  await until(
    () => browser.sent.filter((c) => c.method === "Runtime.evaluate").length === 4 && !!early,
  );
  for (const sessionId of ["S1", "S2"]) {
    expect(browser.of(sessionId)).toEqual([
      "Page.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Runtime.evaluate",
      "Runtime.runIfWaitingForDebugger",
      "Runtime.evaluate",
    ]);
  }
  // Only the unreported Codex page is attached explicitly.
  expect(browser.sent.filter((c) => c.method === "Target.attachToTarget")).toHaveLength(1);
  const evaluate = browser.sent.find((c) => c.method === "Runtime.evaluate");
  expect(evaluate?.params.expression).toMatch(/\(globalThis, true, true, "app:"\);$/);
});

it("on a hold change removes the old new-document script, registers the new value, then sets it", async () => {
  const browser = new FakeBrowser();
  const early = start([browser], true);
  await until(() => early.state() === "attached");
  const session = browser.attached("page", "app://-/index.html", true);
  await until(() => browser.of(session).length === 4);
  await early.setHold(false);
  const after = browser.sent.filter((c) => c.sessionId === session).slice(4);
  expect(after.map((c) => c.method)).toEqual([
    "Page.removeScriptToEvaluateOnNewDocument",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
  ]);
  expect(after[0]?.params).toEqual({ identifier: "1" });
  expect(after[1]?.params.source).toMatch(/\(globalThis, false, true, "app:"\);$/);
  expect(after[2]?.params.expression).toContain("state.setHold(false)");

  // M1: a reload runs the registered early script, then the full/core injection built with the
  // old value. The page ends with the current value.
  const context: Record<string, unknown> = {
    location: { protocol: "app:" },
    addEventListener: () => undefined,
  };
  runInNewContext(String(after[1]?.params.source), context);
  runInNewContext(codexUpdateHoldFallbackScript(true), context);
  expect((context.__codexhostUpdateHoldV1 as { hold: boolean }).hold).toBe(false);
});

it("reconnects after the browser connection drops and registers the current value", async () => {
  const first = new FakeBrowser();
  const second = new FakeBrowser();
  const early = start([first, second], true);
  await until(() => early.state() === "attached");
  first.drop();
  await until(() => early.state() === "connecting");
  await early.setHold(false); // While disconnected: applied by the next connection.
  await until(() => early.state() === "attached" && second.sent.length > 0);
  expect(second.sent[0]?.method).toBe("Target.setAutoAttach");
  const session = second.attached("page", "app://-/index.html", true);
  await until(() => second.of(session).includes("Runtime.runIfWaitingForDebugger"));
  const script = second.sent.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
  expect(script?.params.source).toMatch(/\(globalThis, false, true, "app:"\);$/);
});

it("keeps polling while the browser endpoint is unavailable and stops on abort", async () => {
  const abort = new AbortController();
  let attempts = 0;
  const early = startEarlyUpdateHold({
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    hold: true,
    signal: abort.signal,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 0)),
    connectBrowser: async () => {
      attempts += 1;
      throw new Error("ECONNREFUSED");
    },
  });
  await until(() => attempts > 3);
  expect(early.state()).toBe("connecting");
  await early.setHold(false); // No connection: nothing to do, never throws.
  abort.abort();
  await early.finished;
});

it("a stop turns auto-attach off, then re-attaches and releases every unconfirmed target", async () => {
  const browser = new FakeBrowser();
  // The first release never answers: the target counts as still paused.
  browser.hang.add("Runtime.runIfWaitingForDebugger");
  const early = start([browser], true, { commandTimeoutMs: 20 });
  await until(() => early.state() === "attached");
  const session = browser.attached("page", "", true, "POPUP");
  await until(() => browser.of(session).includes("Runtime.runIfWaitingForDebugger"));
  await settle(20);
  browser.hang.delete("Runtime.runIfWaitingForDebugger");
  early.abort.abort();
  await early.finished;
  const methods = browser.sent.map((c) => c.method);
  const off = browser.sent.findIndex(
    (c) => c.method === "Target.setAutoAttach" && c.params.autoAttach === false,
  );
  expect(off).toBeGreaterThan(0);
  expect(browser.sent[off]?.params).toEqual({
    autoAttach: false,
    waitForDebuggerOnStart: false,
    flatten: true,
  });
  const reattach = browser.sent.findIndex(
    (c, index) => index > off && c.method === "Target.attachToTarget",
  );
  expect(browser.sent[reattach]?.params).toEqual({ targetId: "POPUP", flatten: true });
  const released = browser.sent.filter(
    (c, index) =>
      index > reattach && c.method === "Runtime.runIfWaitingForDebugger" && c.sessionId !== session,
  );
  expect(released.length).toBeGreaterThan(0);
  expect(methods.slice(reattach)).toContain("Target.detachFromTarget");
  expect(browser.closed).toBe(true);
});

it("a stop with every command hanging still finishes (all commands are bounded)", async () => {
  const browser = new FakeBrowser();
  const early = start([browser], true, { commandTimeoutMs: 20, releaseTimeoutMs: 20 });
  await until(() => early.state() === "attached");
  for (const method of [
    "Runtime.runIfWaitingForDebugger",
    "Target.setAutoAttach",
    "Target.attachToTarget",
    "Target.detachFromTarget",
    "Page.enable",
  ])
    browser.hang.add(method);
  browser.attached("page", "app://-/index.html", true, "MAIN");
  await settle(5);
  early.abort.abort();
  await early.finished;
  expect(browser.closed).toBe(true);
});

it("a connection established after abort is closed without attaching (no residual session)", async () => {
  const abort = new AbortController();
  const browser = new FakeBrowser();
  let release: (() => void) | undefined;
  const early = startEarlyUpdateHold({
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    hold: true,
    signal: abort.signal,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    connectBrowser: async () => {
      await new Promise<void>((resolve) => (release = resolve));
      return CdpClient.connect("ws://127.0.0.1:43123/devtools/browser/fake", {
        socketFactory: () => browser.socket() as never,
      });
    },
  });
  await until(() => release !== undefined);
  abort.abort();
  release?.();
  await early.finished;
  expect(browser.sent).toEqual([]);
  expect(browser.closed).toBe(true);
});

it("passes the abort signal to the connection so /json/version can be cancelled", async () => {
  const abort = new AbortController();
  let seen: AbortSignal | undefined;
  const early = startEarlyUpdateHold({
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    hold: true,
    signal: abort.signal,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    connectBrowser: (_endpoint, signal) => {
      seen = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
      );
    },
  });
  await until(() => seen !== undefined);
  abort.abort();
  await early.finished;
  expect(seen?.aborted).toBe(true);
});

it("a new run starts only after the previous one finished (never two auto-attach sessions)", async () => {
  const first = new FakeBrowser();
  const earlier = start([first], true);
  await until(() => earlier.state() === "attached");
  first.hang.add("Target.setAutoAttach"); // The stop's auto-attach-off takes until its timeout.
  earlier.abort.abort();
  const second = new FakeBrowser();
  const later = start([second], true, { after: earlier.finished });
  await settle(3);
  expect(second.sent).toEqual([]);
  await earlier.finished;
  await until(() => later.state() === "attached");
  expect(first.closed).toBe(true);
});

it("reports whether the main window got the hold before its own scripts", async () => {
  const browser = new FakeBrowser();
  const reports: EarlyHoldDiagnostics[] = [];
  const early = start([browser], true, { onDiagnostics: (d) => reports.push(d) });
  await until(() => early.state() === "attached");
  browser.evaluateValue = {
    codex: true,
    installed: true,
    lateInstall: true,
    source: "early",
    observed: 0,
    sent: 0,
    error: null,
    installedAt: 900,
    firstGateAt: null,
  };
  browser.attached("page", "app://-/index.html", true, "MAIN");
  await until(() => reports.some((r) => r.mainWindow !== null));
  expect(reports.at(-1)).toMatchObject({
    state: "attached",
    connections: 1,
    codexPages: 1,
    holdBeforePageScripts: false,
    mainWindow: { waitingAtAttach: true, attachedUrl: "codex", lateInstall: true },
  });
  // Not a Codex document yet (a new window before navigation): no report.
  browser.evaluateValue = { codex: false, installed: false };
  const count = reports.length;
  browser.attached("page", "", true, "POPUP");
  await settle(10);
  expect(reports.length).toBe(count);
  expect(JSON.stringify(reports)).not.toContain("index.html");
});
