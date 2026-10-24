import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AGENT_CHECK_REQUEST_FILE,
  AGENT_STATUS_FILE,
  BACKEND_RELOAD_REQUEST_FILE,
  BackendReloadChannel,
  CODEX_HEARTBEAT_FILE,
  codexHeartbeatBusy,
  HubRequestChannel,
  readAgentStatus,
  requestAgentCheck,
  requestBackendReload,
  writeJsonFile,
} from "../src/rly0-maintenance/backend-reload-channel.js";

describe("Hub → Codex backend reload channel", () => {
  it("reloads once per new request and reports the outcome to the Hub", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-reload-"));
    // A request from before this Codex started is never acted on.
    await fs.writeFile(
      path.join(directory, BACKEND_RELOAD_REQUEST_FILE),
      JSON.stringify({ id: "0123456789abcdef" }),
    );
    const channel = new BackendReloadChannel(directory);
    const reload = vi.fn(async () => "reloaded" as const);
    await channel.poll(reload);
    expect(reload).not.toHaveBeenCalled();

    const timer = setInterval(() => void channel.poll(reload), 20);
    const status = await requestBackendReload(directory, { timeoutMs: 3000, pollMs: 20 });
    clearInterval(timer);
    expect(status).toBe("reloaded");
    expect(reload).toHaveBeenCalledTimes(1);
    await channel.poll(reload);
    expect(reload).toHaveBeenCalledTimes(1);

    // Nobody answering (an older Codex side) leaves the Hub to restart Codex itself.
    expect(await requestBackendReload(directory, { timeoutMs: 100, pollMs: 20 })).toBeNull();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("lets the Hub ask the Codex side to check every agent and read the report", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-check-"));
    const channel = new HubRequestChannel(directory, AGENT_CHECK_REQUEST_FILE);
    await channel.poll(async () => undefined); // first poll only marks what was there
    expect(await readAgentStatus(directory)).toBeNull();
    const timer = setInterval(
      () =>
        void channel.poll((requestId) =>
          writeJsonFile(path.join(directory, AGENT_STATUS_FILE), {
            requestId,
            checkedAt: 1,
            agents: {
              pi: { status: "ready" },
              hermes: { status: "error", code: "HERMES_UNAVAILABLE", message: "boom" },
              "../x": { status: "ready" },
            },
          }),
        ),
      20,
    );
    const report = await requestAgentCheck(directory, { timeoutMs: 3000, pollMs: 20 });
    clearInterval(timer);
    expect(report?.agents).toEqual({
      pi: { status: "ready" },
      hermes: { status: "error", code: "HERMES_UNAVAILABLE", message: "boom" },
    });
    expect((await readAgentStatus(directory))?.checkedAt).toBe(1);
    await fs.rm(directory, { recursive: true, force: true });
  });
});

describe("Codex heartbeat busy flag", () => {
  it("reads busy only from a fresh heartbeat of a live process", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-beat-"));
    const file = path.join(directory, CODEX_HEARTBEAT_FILE);
    expect(await codexHeartbeatBusy(directory)).toBeNull();
    await writeJsonFile(file, { pid: process.pid, at: Date.now(), busy: true });
    expect(await codexHeartbeatBusy(directory)).toBe(true);
    await writeJsonFile(file, { pid: process.pid, at: Date.now(), busy: false });
    expect(await codexHeartbeatBusy(directory)).toBe(false);
    // An older Codex side that does not say, and a stale heartbeat, are both unknown.
    await writeJsonFile(file, { pid: process.pid, at: Date.now() });
    expect(await codexHeartbeatBusy(directory)).toBeNull();
    await writeJsonFile(file, { pid: process.pid, at: Date.now() - 60_000, busy: false });
    expect(await codexHeartbeatBusy(directory)).toBeNull();
  });
});
