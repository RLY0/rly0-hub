/**
 * Injectable Windows autostart control (HKCU\Software\Microsoft\Windows\CurrentVersion\Run,
 * value name `"RLY0Hub"`). Tests always inject a fake implementation; the real one is wired in
 * `app-server-host.ts` and shells out to `reg.exe` rather than adding a native registry
 * dependency. Non-Windows platforms report `{ supported: false }` without ever constructing a
 * real implementation.
 */
export interface Rly0AutostartRegistry {
  /** Resolves to the currently configured launch command, or `null` if the value is unset. */
  get(): Promise<string | null>;
  set(command: string): Promise<void>;
  remove(): Promise<void>;
}

export const RLY0_AUTOSTART_REGISTRY_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
export const RLY0_AUTOSTART_REGISTRY_VALUE_NAME = "RLY0Hub";
