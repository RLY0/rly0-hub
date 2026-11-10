import { CdpClient, getCdpBrowserVersion } from "./cdp-client.js";
import {
  codexUpdateHoldProbeExpression,
  codexUpdateHoldPushExpression,
  codexUpdateHoldScript,
  type CodexUpdateHoldProbe,
} from "./codex-update-hold.js";

/** The subset of a browser-level CDP connection this module uses (a `CdpClient`). */
export interface EarlyHoldBrowser {
  command(method: string, params?: Record<string, unknown>): Promise<unknown>;
  sessionCommand(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown>;
  on(
    method: string,
    listener: (params: unknown, sessionId: string | undefined) => void,
  ): () => void;
  onClose(listener: () => void): () => void;
  close(): void;
}

/** What the early session learned about one Codex window. No URL or page content. */
export interface EarlyHoldPageReport {
  /** The target was paused (`waitingForDebugger`) when it was first attached. */
  waitingAtAttach: boolean;
  /** URL kind at the first attach: a new window is reported before its first navigation. */
  attachedUrl: "empty" | "about:blank" | "codex";
  installed: boolean;
  /** The hold was installed after the document had already parsed or run page scripts. */
  lateInstall: boolean | null;
  source: "early" | "fallback" | null;
  observed: number;
  sent: number;
  error: string | null;
  installedAt: number | null;
  firstGateAt: number | null;
}

export interface EarlyHoldDiagnostics {
  state: "connecting" | "attached" | "stopped";
  /** Browser connections established during this run (a reconnect adds one). */
  connections: number;
  firstAttachedAt: number | null;
  /** The first Codex window seen (normally the main window). */
  mainWindow: EarlyHoldPageReport | null;
  /**
   * true: the early session installed the hold before the main window's own scripts, so the first
   * gate message of the launch is corrected. false: it ran after them. null: not known yet.
   */
  holdBeforePageScripts: boolean | null;
  codexPages: number;
}

export interface EarlyUpdateHoldOptions {
  rendererCdpEndpoint: string;
  hold: boolean;
  signal: AbortSignal;
  connectBrowser?(endpoint: string, signal: AbortSignal): Promise<EarlyHoldBrowser>;
  sleep?(milliseconds: number): Promise<void>;
  /** Upper bound for preparing a paused target before it is released regardless. */
  releaseTimeoutMs?: number;
  /** Upper bound for every CDP command this module sends. */
  commandTimeoutMs?: number;
  /** A previous run that must have ended first: only one auto-attach session at a time. */
  after?: Promise<void>;
  /** Codex documents; tests on a plain browser use `http:`. */
  pageProtocol?: string;
  onDiagnostics?(diagnostics: EarlyHoldDiagnostics): void;
  now?(): number;
  trace?(stage: string): void;
}

export interface EarlyUpdateHold {
  /** `attached`: auto-attach is active on a live browser connection. */
  state(): "connecting" | "attached";
  /** Re-registers the new-document script with the new value on every page, then sets it. */
  setHold(hold: boolean): Promise<void>;
  /** Settles when the connection loop has ended (after abort); every paused target is released. */
  readonly finished: Promise<void>;
}

const RELEASE_TIMEOUT_MS = 2_000;
const COMMAND_TIMEOUT_MS = 2_000;
const VERSION_TIMEOUT_MS = 2_000;
/** Codex opens its debugging port while the browser initializes; poll fast while it starts. */
const FAST_POLL_MS = 50;
const FAST_POLL_ATTEMPTS = 200;
const SLOW_POLL_MS = 1_000;
/** Gate messages follow the first render; probe the counters again after load. */
const LATE_PROBE_MS = 15_000;

interface PageRecord {
  targetId: string;
  sessionId: string;
  scriptId: string | null;
  /** Serializes install and hold changes of one page. */
  chain: Promise<void>;
}

interface Connection {
  browser: EarlyHoldBrowser;
  pages: Map<string, PageRecord>;
  /** Attached targets whose release is not confirmed yet: targetId → sessionId. */
  unreleased: Map<string, string>;
  stopping: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A new window can be paused before its first navigation (empty or about:blank URL). Codex pages
 * use app://. The registered script itself installs only in Codex documents, so a window that
 * later navigates to a sign-in page gets nothing.
 */
function holdCandidate(type: unknown, url: unknown, protocol: string): boolean {
  if (type !== "page" || typeof url !== "string") return false;
  return url === "" || url === "about:blank" || url.startsWith(`${protocol}//`);
}

function urlKind(url: unknown): EarlyHoldPageReport["attachedUrl"] {
  if (url === "") return "empty";
  if (url === "about:blank") return "about:blank";
  return "codex";
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("early update hold timed out")), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function defaultConnectBrowser(
  endpoint: string,
  signal: AbortSignal,
): Promise<EarlyHoldBrowser> {
  const version = await getCdpBrowserVersion(endpoint, undefined, {
    signal,
    timeoutMs: VERSION_TIMEOUT_MS,
  });
  return CdpClient.connect(version.webSocketDebuggerUrl, {
    connectTimeoutMs: 2_000,
    commandTimeoutMs: COMMAND_TIMEOUT_MS,
  });
}

/**
 * Browser-level auto-attach so the update hold is registered before Codex's first page script:
 * `Target.setAutoAttach {waitForDebuggerOnStart}` pauses every new target until
 * `Runtime.runIfWaitingForDebugger`. Page targets get the hold as a new-document script first;
 * every other target is released at once.
 *
 * A paused target stays paused (blank window) until a client releases it: Chromium does not
 * release it when the connection closes, when the session is detached, or when auto-attach is
 * turned off (that detaches it). So every attached target is released unconditionally, also when
 * Chromium reports it as not waiting (a reconnect reports targets stranded by an earlier
 * connection that way). A deliberate stop turns auto-attach off first (no new pauses), then
 * re-attaches and releases every target whose release was not confirmed, then closes. Every
 * command is bounded by `commandTimeoutMs`; preparation by `releaseTimeoutMs`.
 *
 * Pages that already exist get the script registered for reloads and evaluated immediately. The
 * connection is kept for the whole Controller run (new-document scripts end with their session)
 * and re-established after a drop.
 */
export function startEarlyUpdateHold(options: EarlyUpdateHoldOptions): EarlyUpdateHold {
  const connect = options.connectBrowser ?? defaultConnectBrowser;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const releaseTimeoutMs = options.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS;
  const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const protocol = options.pageProtocol ?? "app:";
  const now = options.now ?? Date.now;
  const trace = options.trace ?? (() => undefined);
  const signal = options.signal;
  let hold = options.hold === true;
  let state: "connecting" | "attached" = "connecting";
  let active: Connection | null = null;

  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  const pause = (milliseconds: number): Promise<void> =>
    Promise.race([sleep(milliseconds), aborted]);

  // Diagnostics: the first attach of each target and the first Codex window, across reconnects.
  const firstAttach = new Map<
    string,
    Pick<EarlyHoldPageReport, "waitingAtAttach" | "attachedUrl">
  >();
  const codexTargets = new Set<string>();
  let mainTargetId: string | null = null;
  const diagnostics: EarlyHoldDiagnostics = {
    state: "connecting",
    connections: 0,
    firstAttachedAt: null,
    mainWindow: null,
    holdBeforePageScripts: null,
    codexPages: 0,
  };
  const publish = (): void => {
    try {
      options.onDiagnostics?.({
        ...diagnostics,
        mainWindow: diagnostics.mainWindow ? { ...diagnostics.mainWindow } : null,
      });
    } catch {
      /* Diagnostics never affect the hold. */
    }
  };

  const command = (
    current: EarlyHoldBrowser,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> => withTimeout(current.command(method, params), commandTimeoutMs);
  const sessionCommand = (
    current: EarlyHoldBrowser,
    sessionId: string,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> =>
    withTimeout(current.sessionCommand(sessionId, method, params), commandTimeoutMs);

  const register = async (current: EarlyHoldBrowser, record: PageRecord): Promise<void> => {
    if (record.scriptId)
      await sessionCommand(current, record.sessionId, "Page.removeScriptToEvaluateOnNewDocument", {
        identifier: record.scriptId,
      }).catch(() => undefined);
    record.scriptId = null;
    const added = await sessionCommand(
      current,
      record.sessionId,
      "Page.addScriptToEvaluateOnNewDocument",
      { source: codexUpdateHoldScript(hold, protocol) },
    );
    if (isRecord(added) && typeof added.identifier === "string") record.scriptId = added.identifier;
  };

  /** Releases a target; confirmed releases leave the stop list. */
  const release = async (connection: Connection, targetId: string, sessionId: string) => {
    try {
      await sessionCommand(connection.browser, sessionId, "Runtime.runIfWaitingForDebugger");
      if (connection.unreleased.get(targetId) === sessionId) connection.unreleased.delete(targetId);
    } catch {
      /* Kept in `unreleased`: a stop re-attaches and releases it. */
    }
  };

  /** Reads (and if needed late-installs) the hold of a Codex document for diagnostics. */
  const probe = async (connection: Connection, record: PageRecord): Promise<void> => {
    const response = await sessionCommand(
      connection.browser,
      record.sessionId,
      "Runtime.evaluate",
      {
        expression: codexUpdateHoldProbeExpression(hold, protocol),
        returnByValue: true,
      },
    ).catch(() => null);
    const value =
      isRecord(response) && isRecord(response.result) ? response.result.value : undefined;
    if (!isRecord(value) || value.codex !== true) return;
    const result = value as unknown as CodexUpdateHoldProbe;
    if (!codexTargets.has(record.targetId)) {
      codexTargets.add(record.targetId);
      diagnostics.codexPages = codexTargets.size;
    }
    mainTargetId ??= record.targetId;
    if (mainTargetId !== record.targetId) {
      publish();
      return;
    }
    const attached = firstAttach.get(record.targetId) ?? {
      waitingAtAttach: false,
      attachedUrl: "codex" as const,
    };
    diagnostics.mainWindow = {
      ...attached,
      installed: result.installed === true,
      lateInstall: typeof result.lateInstall === "boolean" ? result.lateInstall : null,
      source: result.source === "early" || result.source === "fallback" ? result.source : null,
      observed: typeof result.observed === "number" ? result.observed : 0,
      sent: typeof result.sent === "number" ? result.sent : 0,
      error: typeof result.error === "string" ? result.error.slice(0, 64) : null,
      installedAt: typeof result.installedAt === "number" ? result.installedAt : null,
      firstGateAt: typeof result.firstGateAt === "number" ? result.firstGateAt : null,
    };
    const main = diagnostics.mainWindow;
    diagnostics.holdBeforePageScripts =
      main.installed && main.lateInstall !== null
        ? main.source === "early" && !main.lateInstall
        : null;
    publish();
  };

  const onAttached = (connection: Connection, params: unknown): void => {
    if (!isRecord(params) || typeof params.sessionId !== "string") return;
    const current = connection.browser;
    const sessionId = params.sessionId;
    const info = isRecord(params.targetInfo) ? params.targetInfo : {};
    const targetId = typeof info.targetId === "string" ? info.targetId : sessionId;
    const waiting = params.waitingForDebugger === true;
    connection.unreleased.set(targetId, sessionId);
    if (connection.stopping) {
      // Re-attached during a stop: release and let go, nothing else.
      void release(connection, targetId, sessionId).finally(() =>
        command(current, "Target.detachFromTarget", { sessionId }).catch(() => undefined),
      );
      return;
    }
    const candidate =
      holdCandidate(info.type, info.url, protocol) && !connection.pages.has(targetId);
    if (candidate && !firstAttach.has(targetId))
      firstAttach.set(targetId, { waitingAtAttach: waiting, attachedUrl: urlKind(info.url) });
    let prepared: Promise<void> = Promise.resolve();
    let record: PageRecord | undefined;
    if (candidate) {
      // Registered synchronously so a concurrent hold change queues behind the install.
      const page: PageRecord = { targetId, sessionId, scriptId: null, chain: Promise.resolve() };
      record = page;
      connection.pages.set(targetId, page);
      prepared = (async () => {
        await sessionCommand(current, sessionId, "Page.enable");
        await register(current, page);
        // An existing page has already run its scripts: install now, hold first.
        if (!waiting)
          await sessionCommand(current, sessionId, "Runtime.evaluate", {
            expression: codexUpdateHoldScript(hold, protocol),
            returnByValue: true,
          });
      })();
      page.chain = prepared.catch(() => undefined);
    }
    void withTimeout(prepared, releaseTimeoutMs)
      .catch(() => trace("early update hold could not prepare a page"))
      .finally(async () => {
        // Unconditional: a target reported as not waiting may still be paused.
        await release(connection, targetId, sessionId);
        // Only Codex pages keep a session: their new-document script lives with it.
        if (!record) {
          await command(current, "Target.detachFromTarget", { sessionId }).catch(() => undefined);
          return;
        }
        // A document that already ran (its new-document script came too late) is installed now.
        await probe(connection, record);
      });
  };

  const onDetached = (connection: Connection, params: unknown): void => {
    if (!isRecord(params)) return;
    for (const [targetId, record] of connection.pages)
      if (record.sessionId === params.sessionId) connection.pages.delete(targetId);
  };

  const attach = async (connection: Connection): Promise<void> => {
    const current = connection.browser;
    current.on("Target.attachedToTarget", (params, parentSessionId) => {
      if (parentSessionId === undefined) onAttached(connection, params);
    });
    current.on("Target.detachedFromTarget", (params, parentSessionId) => {
      if (parentSessionId === undefined) onDetached(connection, params);
    });
    current.on("Page.loadEventFired", (_params, sessionId) => {
      if (connection.stopping) return;
      const record = [...connection.pages.values()].find((page) => page.sessionId === sessionId);
      if (!record) return;
      void probe(connection, record).then(async () => {
        await pause(LATE_PROBE_MS);
        if (!signal.aborted && !connection.stopping && connection.pages.get(record.targetId))
          await probe(connection, record);
      });
    });
    await command(current, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    // Existing pages are normally reported by setAutoAttach; attach any that were not.
    const listed = await command(current, "Target.getTargets").catch(() => null);
    const infos = isRecord(listed) && Array.isArray(listed.targetInfos) ? listed.targetInfos : [];
    for (const info of infos) {
      if (connection.stopping) return;
      if (!isRecord(info) || typeof info.targetId !== "string") continue;
      if (!holdCandidate(info.type, info.url, protocol) || connection.pages.has(info.targetId))
        continue;
      await command(current, "Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      }).catch(() => undefined);
    }
  };

  /**
   * Turning auto-attach off detaches its sessions, and a target detached while paused stays
   * paused; so every target whose release is unconfirmed is attached again and released.
   */
  const shutdown = async (connection: Connection): Promise<void> => {
    connection.stopping = true;
    const current = connection.browser;
    await command(current, "Target.setAutoAttach", {
      autoAttach: false,
      waitForDebuggerOnStart: false,
      flatten: true,
    }).catch(() => undefined);
    await Promise.all(
      [...connection.unreleased.keys()].map(async (targetId) => {
        const attached = await command(current, "Target.attachToTarget", {
          targetId,
          flatten: true,
        }).catch(() => null);
        if (!isRecord(attached) || typeof attached.sessionId !== "string") return;
        await sessionCommand(current, attached.sessionId, "Runtime.runIfWaitingForDebugger").catch(
          () => undefined,
        );
        if (connection.unreleased.get(targetId) === attached.sessionId)
          connection.unreleased.delete(targetId);
        await command(current, "Target.detachFromTarget", {
          sessionId: attached.sessionId,
        }).catch(() => undefined);
      }),
    );
    current.close();
  };

  const finished = (async () => {
    await options.after?.catch(() => undefined);
    let attempt = 0;
    while (!signal.aborted) {
      let current: EarlyHoldBrowser;
      try {
        current = await connect(options.rendererCdpEndpoint, signal);
      } catch {
        attempt += 1;
        await pause(attempt < FAST_POLL_ATTEMPTS ? FAST_POLL_MS : SLOW_POLL_MS);
        continue;
      }
      // Aborted while connecting: nothing was attached on this connection.
      if (signal.aborted) {
        current.close();
        break;
      }
      attempt = 0;
      const connection: Connection = {
        browser: current,
        pages: new Map(),
        unreleased: new Map(),
        stopping: false,
      };
      const closed = new Promise<void>((resolve) => current.onClose(resolve));
      let stopping: Promise<void> | null = null;
      const stop = (): void => {
        stopping ??= shutdown(connection);
      };
      signal.addEventListener("abort", stop, { once: true });
      try {
        active = connection;
        diagnostics.connections += 1;
        await attach(connection);
        if (!connection.stopping) {
          state = "attached";
          diagnostics.state = "attached";
          diagnostics.firstAttachedAt ??= now();
          publish();
          trace("early update hold attached");
        }
        await closed;
      } catch {
        trace("early update hold could not attach");
      } finally {
        signal.removeEventListener("abort", stop);
        // Also after a failed attach or a dropped connection: release what is still paused.
        stop();
        await stopping;
        active = null;
        state = "connecting";
        diagnostics.state = "connecting";
      }
      if (!signal.aborted) {
        publish();
        trace("early update hold reconnecting");
        await pause(SLOW_POLL_MS);
      }
    }
    diagnostics.state = "stopped";
    publish();
  })();

  return {
    state: () => state,
    finished,
    async setHold(value: boolean) {
      hold = value === true;
      const connection = active;
      if (!connection || connection.stopping) return; // The next connection registers the value.
      const current = connection.browser;
      await Promise.all(
        [...connection.pages.values()].map((record) => {
          record.chain = record.chain
            .then(async () => {
              await register(current, record);
              await sessionCommand(current, record.sessionId, "Runtime.evaluate", {
                expression: codexUpdateHoldPushExpression(hold),
                returnByValue: true,
              });
            })
            .catch(() => undefined);
          return record.chain;
        }),
      );
    },
  };
}
