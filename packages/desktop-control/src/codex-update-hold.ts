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
 * The first gate message of a launch can precede injection. The last observed real message is kept
 * in the page's own storage and replayed (corrected) when a held page installs this script.
 *
 * Self-contained: serialized with `Function.prototype.toString` and run in full and core modes.
 * No React, DOM or Codex module access. Anything unexpected records `update-hold` in
 * `__codexhostFeatureFailuresV1` and sends nothing.
 */
export function installCodexUpdateHold(root: Record<string, unknown>, hold: boolean): boolean {
  const STATE_KEY = "__codexhostUpdateHoldV1";
  const STORAGE_KEY = "codexhost.sparkle-gates.v1";
  const MESSAGE_TYPE = "electron-sparkle-gates-changed";
  type Gates = Record<string, string | number | boolean | null>;
  type PageStorage = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  interface HoldState {
    hold: boolean;
    observed: number;
    sent: number;
    replayed: boolean;
    error: string | null;
    setHold(value: boolean): void;
  }
  const existing = root[STATE_KEY] as Partial<HoldState> | undefined;
  if (existing && typeof existing.setHold === "function") {
    existing.setHold(hold);
    return true;
  }
  let last: Gates | null = null;
  const state: HoldState = {
    hold: false,
    observed: 0,
    sent: 0,
    replayed: false,
    error: null,
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
        last = message;
        try {
          (root.localStorage as PageStorage).setItem(STORAGE_KEY, JSON.stringify(message));
        } catch {
          /* Replay is best effort; correcting this message does not depend on it. */
        }
        if (state.hold) send(message);
      } catch {
        fail("listener-failed");
      }
    },
  );
  root[STATE_KEY] = state;
  state.hold = hold === true;
  if (state.hold) {
    let stored: unknown = null;
    try {
      stored = JSON.parse((root.localStorage as PageStorage).getItem(STORAGE_KEY) ?? "null");
    } catch {
      stored = null;
    }
    const template = gates(stored);
    if (template) {
      last = template;
      state.replayed = true;
      send(template);
    }
  }
  return true;
}

export function codexUpdateHoldScript(hold: boolean): string {
  return `(${installCodexUpdateHold.toString()})(globalThis, ${hold === true});`;
}

/** Pushes a hold change into an installed page; a page without the script is left untouched. */
export function codexUpdateHoldPushExpression(hold: boolean): string {
  return `(() => { const state = globalThis.__codexhostUpdateHoldV1; if (state && typeof state.setHold === "function") state.setHold(${hold === true}); return true; })()`;
}
