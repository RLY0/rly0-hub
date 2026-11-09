import { runInNewContext } from "node:vm";
import { afterEach, expect, it } from "vitest";
import { CdpClient } from "../src/cdp-client.js";
import { codexUpdateHoldFallbackScript } from "../src/codex-update-hold.js";
import { startEarlyUpdateHold, type EarlyUpdateHold } from "../src/early-update-hold.js";

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
      result = { result: { type: "boolean", value: true } };
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
        : "";
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
  options: { releaseTimeoutMs?: number } = {},
) {
  const abort = new AbortController();
  let connections = 0;
  const instance = startEarlyUpdateHold({
    rendererCdpEndpoint: "http://127.0.0.1:43123",
    hold,
    signal: abort.signal,
    sleep: () => new Promise((resolve) => setTimeout(resolve, 1)),
    releaseTimeoutMs: options.releaseTimeoutMs ?? 50,
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
  return instance;
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
  expect(browser.of(session)).toEqual([
    "Page.enable",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.runIfWaitingForDebugger",
  ]);
  const script = browser.sent.find((c) => c.method === "Page.addScriptToEvaluateOnNewDocument");
  expect(script?.params.source).toMatch(/\(globalThis, true, true\);$/);
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
  expect(browser.of(worker)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  expect(browser.of(signIn)).toEqual(["Runtime.runIfWaitingForDebugger"]);
  expect(browser.of(quiet)).toEqual([]);
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
    () => browser.sent.filter((c) => c.method === "Runtime.evaluate").length === 2 && !!early,
  );
  for (const sessionId of ["S1", "S2"]) {
    expect(browser.of(sessionId)).toEqual([
      "Page.enable",
      "Page.addScriptToEvaluateOnNewDocument",
      "Runtime.evaluate",
    ]);
  }
  // Only the unreported Codex page is attached explicitly; nothing is released (not paused).
  expect(browser.sent.filter((c) => c.method === "Target.attachToTarget")).toHaveLength(1);
  expect(browser.sent.some((c) => c.method === "Runtime.runIfWaitingForDebugger")).toBe(false);
  const evaluate = browser.sent.find((c) => c.method === "Runtime.evaluate");
  expect(evaluate?.params.expression).toMatch(/\(globalThis, true, true\);$/);
});

it("on a hold change removes the old new-document script, registers the new value, then sets it", async () => {
  const browser = new FakeBrowser();
  const early = start([browser], true);
  await until(() => early.state() === "attached");
  const session = browser.attached("page", "app://-/index.html", true);
  await until(() => browser.of(session).includes("Runtime.runIfWaitingForDebugger"));
  await early.setHold(false);
  const after = browser.sent.filter((c) => c.sessionId === session).slice(3);
  expect(after.map((c) => c.method)).toEqual([
    "Page.removeScriptToEvaluateOnNewDocument",
    "Page.addScriptToEvaluateOnNewDocument",
    "Runtime.evaluate",
  ]);
  expect(after[0]?.params).toEqual({ identifier: "1" });
  expect(after[1]?.params.source).toMatch(/\(globalThis, false, true\);$/);
  expect(after[2]?.params.expression).toContain("state.setHold(false)");

  // M1: a reload runs the registered early script, then the full/core injection built with the
  // old value. The page ends with the current value.
  const context: Record<string, unknown> = { addEventListener: () => undefined };
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
  expect(script?.params.source).toMatch(/\(globalThis, false, true\);$/);
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
