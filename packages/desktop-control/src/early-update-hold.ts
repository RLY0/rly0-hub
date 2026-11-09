import { CdpClient, getCdpBrowserVersion } from "./cdp-client.js";
import { codexUpdateHoldPushExpression, codexUpdateHoldScript } from "./codex-update-hold.js";

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

export interface EarlyUpdateHoldOptions {
  rendererCdpEndpoint: string;
  hold: boolean;
  signal: AbortSignal;
  connectBrowser?(endpoint: string): Promise<EarlyHoldBrowser>;
  sleep?(milliseconds: number): Promise<void>;
  /** Upper bound for preparing a paused target before it is released regardless. */
  releaseTimeoutMs?: number;
  trace?(stage: string): void;
}

export interface EarlyUpdateHold {
  /** `attached`: auto-attach is active on a live browser connection. */
  state(): "connecting" | "attached";
  /** Re-registers the new-document script with the new value on every page, then sets it. */
  setHold(hold: boolean): Promise<void>;
  /** Settles when the connection loop has ended (after abort). */
  readonly finished: Promise<void>;
}

const RELEASE_TIMEOUT_MS = 2_000;
/** Codex opens its debugging port while the browser initializes; poll fast while it starts. */
const FAST_POLL_MS = 50;
const FAST_POLL_ATTEMPTS = 200;
const SLOW_POLL_MS = 1_000;

interface PageRecord {
  sessionId: string;
  scriptId: string | null;
  /** Serializes install and hold changes of one page. */
  chain: Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A new window can be paused before its first navigation (empty or about:blank URL). Codex pages
 * use app://; any other page (for example a sign-in page) is released without the script.
 */
function holdCandidate(type: unknown, url: unknown): boolean {
  if (type !== "page" || typeof url !== "string") return false;
  return url === "" || url === "about:blank" || url.startsWith("app://");
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

async function defaultConnectBrowser(endpoint: string): Promise<EarlyHoldBrowser> {
  const version = await getCdpBrowserVersion(endpoint);
  return CdpClient.connect(version.webSocketDebuggerUrl, { connectTimeoutMs: 2_000 });
}

/**
 * Browser-level auto-attach so the update hold is registered before Codex's first page script:
 * `Target.setAutoAttach {waitForDebuggerOnStart}` pauses every new target until
 * `Runtime.runIfWaitingForDebugger`. Page targets get the hold as a new-document script first;
 * every other target is released at once. Release always happens (`finally`), bounded by
 * `releaseTimeoutMs` even when preparation hangs or fails. Pages that already exist get the
 * script registered for reloads and evaluated immediately. The connection is kept for the whole
 * Controller run (new-document scripts end with their session) and re-established after a drop.
 */
export function startEarlyUpdateHold(options: EarlyUpdateHoldOptions): EarlyUpdateHold {
  const connect = options.connectBrowser ?? defaultConnectBrowser;
  const sleep =
    options.sleep ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const releaseTimeoutMs = options.releaseTimeoutMs ?? RELEASE_TIMEOUT_MS;
  const trace = options.trace ?? (() => undefined);
  let hold = options.hold === true;
  let state: "connecting" | "attached" = "connecting";
  let browser: EarlyHoldBrowser | null = null;
  const pages = new Map<string, PageRecord>();

  const register = async (current: EarlyHoldBrowser, record: PageRecord): Promise<void> => {
    if (record.scriptId)
      await current
        .sessionCommand(record.sessionId, "Page.removeScriptToEvaluateOnNewDocument", {
          identifier: record.scriptId,
        })
        .catch(() => undefined);
    record.scriptId = null;
    const added = await current.sessionCommand(
      record.sessionId,
      "Page.addScriptToEvaluateOnNewDocument",
      { source: codexUpdateHoldScript(hold) },
    );
    if (isRecord(added) && typeof added.identifier === "string") record.scriptId = added.identifier;
  };

  const onAttached = (current: EarlyHoldBrowser, params: unknown): void => {
    if (!isRecord(params) || typeof params.sessionId !== "string") return;
    const sessionId = params.sessionId;
    const info = isRecord(params.targetInfo) ? params.targetInfo : {};
    const targetId = typeof info.targetId === "string" ? info.targetId : sessionId;
    const waiting = params.waitingForDebugger === true;
    const candidate = holdCandidate(info.type, info.url) && !pages.has(targetId);
    let prepared: Promise<void> = Promise.resolve();
    if (candidate) {
      // Registered synchronously so a concurrent hold change queues behind the install.
      const record: PageRecord = { sessionId, scriptId: null, chain: Promise.resolve() };
      pages.set(targetId, record);
      prepared = (async () => {
        await current.sessionCommand(sessionId, "Page.enable");
        await register(current, record);
        // An existing page has already run its scripts: install now, hold first.
        if (!waiting)
          await current.sessionCommand(sessionId, "Runtime.evaluate", {
            expression: codexUpdateHoldScript(hold),
            returnByValue: true,
          });
      })();
      record.chain = prepared.catch(() => undefined);
    }
    void withTimeout(prepared, releaseTimeoutMs)
      .catch(() => trace("early update hold could not prepare a page"))
      .finally(() => {
        if (waiting)
          void current
            .sessionCommand(sessionId, "Runtime.runIfWaitingForDebugger")
            .catch(() => undefined);
        // Only Codex pages keep a session: their new-document script lives with it.
        if (!candidate)
          void current.command("Target.detachFromTarget", { sessionId }).catch(() => undefined);
      });
  };

  const onDetached = (params: unknown): void => {
    if (!isRecord(params)) return;
    for (const [targetId, record] of pages)
      if (record.sessionId === params.sessionId) pages.delete(targetId);
  };

  const attach = async (current: EarlyHoldBrowser): Promise<void> => {
    current.on("Target.attachedToTarget", (params, parentSessionId) => {
      if (parentSessionId === undefined) onAttached(current, params);
    });
    current.on("Target.detachedFromTarget", (params, parentSessionId) => {
      if (parentSessionId === undefined) onDetached(params);
    });
    await current.command("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: true,
      flatten: true,
    });
    // Existing pages are normally reported by setAutoAttach; attach any that were not.
    const listed = await current.command("Target.getTargets").catch(() => null);
    const infos = isRecord(listed) && Array.isArray(listed.targetInfos) ? listed.targetInfos : [];
    for (const info of infos) {
      if (!isRecord(info) || typeof info.targetId !== "string") continue;
      if (!holdCandidate(info.type, info.url) || pages.has(info.targetId)) continue;
      await current
        .command("Target.attachToTarget", { targetId: info.targetId, flatten: true })
        .catch(() => undefined);
    }
  };

  const finished = (async () => {
    let attempt = 0;
    while (!options.signal.aborted) {
      let current: EarlyHoldBrowser;
      try {
        current = await connect(options.rendererCdpEndpoint);
      } catch {
        attempt += 1;
        await sleep(attempt < FAST_POLL_ATTEMPTS ? FAST_POLL_MS : SLOW_POLL_MS);
        continue;
      }
      attempt = 0;
      const closed = new Promise<void>((resolve) => current.onClose(resolve));
      const abort = (): void => current.close();
      options.signal.addEventListener("abort", abort, { once: true });
      try {
        browser = current;
        await attach(current);
        state = "attached";
        trace("early update hold attached");
        await closed;
      } catch {
        current.close();
      } finally {
        options.signal.removeEventListener("abort", abort);
        browser = null;
        state = "connecting";
        pages.clear();
      }
      if (!options.signal.aborted) {
        trace("early update hold reconnecting");
        await sleep(SLOW_POLL_MS);
      }
    }
  })();

  return {
    state: () => state,
    finished,
    async setHold(value: boolean) {
      hold = value === true;
      const current = browser;
      if (!current) return; // The next connection registers the new value.
      await Promise.all(
        [...pages.values()].map((record) => {
          record.chain = record.chain
            .then(async () => {
              await register(current, record);
              await current.sessionCommand(record.sessionId, "Runtime.evaluate", {
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
