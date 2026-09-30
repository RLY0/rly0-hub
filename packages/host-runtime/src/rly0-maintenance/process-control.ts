/**
 * Best-effort control over the user's Codex CLI process(es), used by the maintenance page's
 * "force quit" / "restart" buttons. Injectable so tests never touch a real process: the app-server
 * host wires a concrete implementation (or none, when no safe implementation exists on this
 * platform / build), and `Rly0MaintenanceManager` reports `{ supported: false }` when none is
 * wired up.
 */
export interface Rly0CodexProcessControl {
  /** Resolves to whether the operation completed; never throws for an expected failure. */
  forceQuit(): Promise<boolean>;
  restart(): Promise<boolean>;
}
