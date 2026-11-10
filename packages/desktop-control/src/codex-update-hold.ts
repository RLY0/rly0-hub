/**
 * Codex Desktop (26.1103, webview chunk `366057`) reports server feature gates to its main process
 * with `electron-sparkle-gates-changed`. Its page-side sender posts through the frozen context
 * bridge (`window.electronBridge.sendMessageFromView`) and then dispatches the same object as the
 * `codex-message-from-view` window event. The bridge cannot be wrapped, so while Hub holds updates
 * this script observes that event and immediately sends a corrected copy through the same bridge:
 * `disableSparkleAutodownload: true` turns Sparkle background downloads off, and
 * `disableInAppUpdates: null` leaves Codex's per-launch update latch untouched (a later contrary
 * latch makes Codex show a "restart to apply policy" dialog).
 *
 * To see the first gate message of a launch, the Controller registers this script through a
 * browser-level auto-attach session before the page's own scripts run (`early-update-hold.ts`);
 * that copy is authoritative (`override`). The copy bundled with the full/core injection is a
 * fallback for pages the early session missed: it installs only when no hold is present and never
 * changes an existing hold value. Nothing is stored or replayed across launches.
 *
 * Only Codex documents (`protocol`, `app:` in production) install it: a new window is registered
 * before its first navigation and may then load a third-party page such as a sign-in page.
 *
 * Diagnostics on the state object: `lateInstall` is true when the document had already parsed or
 * run page scripts at install time (any gate message sent before that was not seen); a
 * new-document install before the page's own scripts reports false. `source` is `early`
 * (authoritative copy) or `fallback`; `installedAt` / `firstGateAt` are `performance.now()`.
 *
 * Self-contained: serialized with `Function.prototype.toString` and run in full and core modes.
 * No React, DOM or Codex module access. Anything unexpected records `update-hold` in
 * `__codexhostFeatureFailuresV1` and sends nothing.
 */
export function installCodexUpdateHold(
  root: Record<string, unknown>,
  hold: boolean,
  override: boolean,
  protocol: string = "app:",
): boolean {
  const STATE_KEY = "__codexhostUpdateHoldV1";
  const MESSAGE_TYPE = "electron-sparkle-gates-changed";
  type Gates = Record<string, string | number | boolean | null>;
  interface HoldState {
    hold: boolean;
    observed: number;
    sent: number;
    error: string | null;
    lateInstall: boolean;
    source: "early" | "fallback";
    installedAt: number | null;
    firstGateAt: number | null;
    setHold(value: boolean): void;
  }
  let pageProtocol: unknown;
  try {
    pageProtocol = (root.location as { protocol?: unknown } | undefined)?.protocol;
  } catch {
    pageProtocol = undefined;
  }
  if (pageProtocol !== protocol) return false;
  const existing = root[STATE_KEY] as Partial<HoldState> | undefined;
  if (existing && typeof existing.setHold === "function") {
    if (override) existing.setHold(hold);
    return true;
  }
  const clock = (): number | null => {
    try {
      const value = (root.performance as { now?: () => number } | undefined)?.now?.();
      return typeof value === "number" ? Math.round(value) : null;
    } catch {
      return null;
    }
  };
  let lateInstall = true;
  try {
    const document = root.document as
      { readyState?: unknown; scripts?: { length?: unknown } } | undefined;
    lateInstall = !(document?.readyState === "loading" && document.scripts?.length === 0);
  } catch {
    lateInstall = true;
  }
  let last: Gates | null = null;
  const state: HoldState = {
    hold: false,
    observed: 0,
    sent: 0,
    error: null,
    lateInstall,
    source: override ? "early" : "fallback",
    installedAt: clock(),
    firstGateAt: null,
    setHold: () => undefined,
  };
  const fail = (reason: string): void => {
    state.error = reason;
    try {
      const failures = (root.__codexhostFeatureFailuresV1 ??= []) as unknown;
      if (Array.isArray(failures) && !failures.includes("update-hold"))
        failures.push("update-hold");
    } catch {
      /* Observability must never break the page. */
    }
  };
  /** null: not a gate message. undefined: a gate message of an unknown shape. */
  const gates = (value: unknown): Gates | null | undefined => {
    if (typeof value !== "object" || value === null) return null;
    const message = value as Record<string, unknown>;
    if (message.type !== MESSAGE_TYPE) return null;
    if (typeof message.disableSparkleAutodownload !== "boolean") return undefined;
    const copy: Gates = {};
    for (const key of Object.keys(message)) {
      const field = message[key];
      if (
        field !== null &&
        typeof field !== "boolean" &&
        typeof field !== "string" &&
        typeof field !== "number"
      )
        return undefined;
      copy[key] = field as string | number | boolean | null;
    }
    return copy;
  };
  const send = (message: Gates): void => {
    if (message.disableSparkleAutodownload === true) return; // Codex already disables it.
    let bridge: { sendMessageFromView?: unknown } | null = null;
    try {
      bridge = root.electronBridge as { sendMessageFromView?: unknown } | null;
    } catch {
      bridge = null;
    }
    const deliver = bridge?.sendMessageFromView;
    if (typeof deliver !== "function") {
      fail("bridge-unavailable");
      return;
    }
    const corrected = { ...message, disableInAppUpdates: null, disableSparkleAutodownload: true };
    try {
      Promise.resolve(deliver.call(bridge, corrected)).then(
        () => {
          state.sent += 1;
        },
        () => fail("send-failed"),
      );
    } catch {
      fail("send-failed");
    }
  };
  state.setHold = (value: boolean) => {
    const enabling = value === true && !state.hold;
    state.hold = value === true;
    if (enabling && last) send(last);
  };
  if (typeof root.addEventListener !== "function") {
    fail("listener-unavailable");
    return false;
  }
  (root.addEventListener as (type: string, listener: (event: unknown) => void) => void)(
    "codex-message-from-view",
    (event: unknown) => {
      try {
        const message = gates((event as { detail?: unknown } | null)?.detail);
        if (message === null) return;
        if (message === undefined) {
          fail("unknown-shape");
          return;
        }
        state.observed += 1;
        state.firstGateAt ??= clock();
        last = message;
        if (state.hold) send(message);
      } catch {
        fail("listener-failed");
      }
    },
  );
  root[STATE_KEY] = state;
  state.hold = hold === true;
  return true;
}

/** Authoritative copy: installs, or sets the hold of an installed page. */
export function codexUpdateHoldScript(hold: boolean, protocol = "app:"): string {
  return `(${installCodexUpdateHold.toString()})(globalThis, ${hold === true}, true, ${JSON.stringify(protocol)});`;
}

/** Page diagnostics returned by `codexUpdateHoldProbeExpression` (no URL or page content). */
export interface CodexUpdateHoldProbe {
  /** The document is a Codex page (`protocol`). */
  codex: boolean;
  /** The document is still the initial `about:` document of a window that has not navigated. */
  blank: boolean;
  installed: boolean;
  lateInstall: boolean | null;
  source: "early" | "fallback" | null;
  observed: number;
  sent: number;
  error: string | null;
  installedAt: number | null;
  firstGateAt: number | null;
}

/**
 * Installs the authoritative copy when a Codex document has none (its new-document script did not
 * run, so it reports `lateInstall`), then returns the page's hold diagnostics.
 */
export function codexUpdateHoldProbeExpression(hold: boolean, protocol = "app:"): string {
  return `(() => { try { ${codexUpdateHoldScript(hold, protocol)} } catch {} const pageProtocol = (() => { try { return globalThis.location.protocol; } catch { return undefined; } })(); const codex = pageProtocol === ${JSON.stringify(protocol)}; const blank = pageProtocol === "about:"; const state = globalThis.__codexhostUpdateHoldV1; const ok = !!state && typeof state.setHold === "function"; const num = (value) => (typeof value === "number" ? value : null); return { codex, blank, installed: ok, lateInstall: ok && typeof state.lateInstall === "boolean" ? state.lateInstall : null, source: ok && (state.source === "early" || state.source === "fallback") ? state.source : null, observed: ok ? num(state.observed) ?? 0 : 0, sent: ok ? num(state.sent) ?? 0 : 0, error: ok && typeof state.error === "string" ? state.error : null, installedAt: ok ? num(state.installedAt) : null, firstGateAt: ok ? num(state.firstGateAt) : null }; })()`;
}

/** Bundled with the full/core injection: installs only when the page has no hold yet. */
export function codexUpdateHoldFallbackScript(hold: boolean): string {
  return `(${installCodexUpdateHold.toString()})(globalThis, ${hold === true}, false);`;
}

/**
 * Idempotent; safe to run every monitor pass, which also corrects a page reloaded with a stale
 * fallback value. A page without the script is left untouched.
 */
export function codexUpdateHoldPushExpression(hold: boolean): string {
  return `(() => { const state = globalThis.__codexhostUpdateHoldV1; if (state && typeof state.setHold === "function" && state.hold !== ${hold === true}) state.setHold(${hold === true}); return true; })()`;
}
