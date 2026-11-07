import { describe, expect, it } from "vitest";

import {
  quitMacCodex,
  selectMacCodexProcesses,
  type MacProcessDependencies,
  type MacProcessEntry,
} from "../src/rly0-hub-service/codex-processes.js";
import { Rly0CodexControl } from "../src/rly0-hub-service/codex-control.js";

const pkg = "/Volumes/Synthetic/npm-global/lib/node_modules/@codexhost/cli-darwin-arm64";
const rows: MacProcessEntry[] = [
  { pid: 100, args: "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=1" },
  {
    pid: 101,
    args: "/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT Helper (Renderer).app/Contents/MacOS/ChatGPT Helper (Renderer) --type=renderer",
  },
  { pid: 200, args: `${pkg}/bin/codexhost launch --node /n --shim ${pkg}/libexec/codexhost-shim` },
  { pid: 201, args: `/n --disable-warning=X ${pkg}/app/desktop-controller.mjs --renderer x` },
  { pid: 202, args: `/n ${pkg}/app/host-runtime.mjs -c features.code_mode_host=true app-server` },
  { pid: 203, args: `/n ${pkg}/app/console-server.mjs serve` },
  { pid: 300, args: "/Volumes/Synthetic/RLY0 Hub.app/Contents/MacOS/rly0-hub" },
  { pid: 301, args: "/Volumes/Synthetic/RLY0 Hub.app/Contents/Resources/runtime/rly0-core" },
  { pid: 302, args: "/Users/synthetic/Applications/Codex.app/Contents/MacOS/Codex" },
  { pid: 400, args: "/usr/bin/vim /Applications/ChatGPT.app/Contents/MacOS/ChatGPT" },
];

function fakeSystem(options: { quitWorks: boolean; helpersFollow: boolean }) {
  const living = new Set(rows.map((row) => row.pid));
  const signals: Array<[number, string]> = [];
  let quitRequests = 0;
  const dependencies: MacProcessDependencies = {
    async list() {
      return rows.filter((row) => living.has(row.pid));
    },
    async requestQuit() {
      quitRequests += 1;
      if (!options.quitWorks) return;
      living.delete(100);
      living.delete(101);
      living.delete(302);
      if (options.helpersFollow) [200, 201].forEach((pid) => living.delete(pid));
    },
    alive: (pid) => living.has(pid),
    signal(pid, signal) {
      signals.push([pid, signal]);
      living.delete(pid);
    },
    sleep: async () => undefined,
    keep: new Set([202]),
  };
  return { dependencies, living, signals, quitRequests: () => quitRequests };
}

describe("macOS Codex restart (synthetic processes)", () => {
  it("matches only the Desktop main executable and codexhost Launcher/Host/controller", () => {
    expect(selectMacCodexProcesses(rows, new Set())).toEqual({
      app: [100, 302],
      helpers: [200, 201, 202],
    });
    expect(selectMacCodexProcesses(rows, new Set([100, 202]))).toEqual({
      app: [302],
      helpers: [200, 201],
    });
  });

  it("quits normally first and sends no signal when everything exits by itself", async () => {
    const f = fakeSystem({ quitWorks: true, helpersFollow: true });
    expect(await quitMacCodex(f.dependencies)).toBe(4);
    expect(f.quitRequests()).toBe(1);
    expect(f.signals).toEqual([]);
    // Hub, Core, the web console, Electron helpers' unrelated lookalikes and kept PIDs stay.
    expect([...f.living].sort()).toEqual([202, 203, 300, 301, 400]);
  });

  it("ends lingering helpers and a Desktop that ignores quit, escalating from SIGTERM", async () => {
    const f = fakeSystem({ quitWorks: false, helpersFollow: false });
    expect(await quitMacCodex(f.dependencies)).toBe(4);
    expect(f.signals).toEqual([
      [100, "SIGTERM"],
      [302, "SIGTERM"],
      [200, "SIGTERM"],
      [201, "SIGTERM"],
    ]);
    expect(f.living.has(300)).toBe(true);
    expect(f.living.has(203)).toBe(true);
  });

  it("does nothing when Codex is not running", async () => {
    const f = fakeSystem({ quitWorks: true, helpersFollow: true });
    f.living.clear();
    expect(await quitMacCodex(f.dependencies)).toBe(0);
    expect(f.quitRequests()).toBe(0);
  });

  it("restarts on macOS without a Launcher descriptor: quit, wait, then reopen through bin/codexhost", async () => {
    const started: string[] = [];
    const control = new Rly0CodexControl({
      environment: {},
      installRoot: "/Volumes/Synthetic/RLY0 Hub.app/Contents/Resources",
      platform: "darwin",
      fileExists: () => true,
      heartbeatAlive: async () => false,
      killProcesses: async () => 3,
      restartDelayMs: 0,
      startDetached: (executable) => started.push(executable),
    });
    expect(await control.restart()).toEqual({ ok: true });
    expect(started).toEqual(["/Volumes/Synthetic/RLY0 Hub.app/Contents/Resources/bin/codexhost"]);
  });

  it("reports failure instead of pretending when nothing was running and nothing was ended", async () => {
    const started: string[] = [];
    const control = new Rly0CodexControl({
      environment: {},
      installRoot: "/Volumes/Synthetic/RLY0 Hub.app/Contents/Resources",
      platform: "darwin",
      fileExists: () => true,
      heartbeatAlive: async () => false,
      killProcesses: async () => 0,
      restartDelayMs: 0,
      startDetached: (executable) => started.push(executable),
    });
    expect(await control.restart()).toEqual({ ok: false });
    expect(started).toEqual([]);
  });
});
