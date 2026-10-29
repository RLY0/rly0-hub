import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MappingStore } from "../src/index.js";

// Exercise the actual Windows PowerShell/CIM query, not the current-PID shortcut.
// Access to a protected system process is covered separately by simulated OS replies.
describe.skipIf(process.platform !== "win32")("Windows native Mapping Store lock ownership", () => {
  let directory: string;
  let owner: ChildProcess;
  let store: MappingStore;
  let processStartedAt: string;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "codexhost-windows-native-lock-"));
    owner = spawn(
      process.execPath,
      [
        "-e",
        "process.send(new Date(Date.now() - process.uptime() * 1000).toISOString()); setInterval(() => {}, 1000)",
      ],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] },
    );
    const [startedAt] = await once(owner, "message");
    if (typeof startedAt !== "string") throw new Error("Missing fixture process start time");
    processStartedAt = startedAt;
    store = new MappingStore({ directory });
  });

  afterEach(async () => {
    await store?.close();
    if (owner && owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, "exit");
      owner.kill();
      await exited;
    }
    await rm(directory, { recursive: true, force: true });
  });

  async function writeLock(startedAt: string | undefined): Promise<string> {
    const content = JSON.stringify({
      pid: owner.pid,
      instanceId: "previous-owner",
      startedAt: new Date(0).toISOString(),
      executablePath: process.execPath,
      processStartedAt: startedAt,
    });
    await writeFile(path.join(directory, "store.lock"), content);
    return content;
  }

  it("recovers a stale lock with the same PID and executable but a different creation time", async () => {
    await writeLock(new Date(0).toISOString());
    await store.initialize();
    expect(JSON.parse(await readFile(path.join(directory, "store.lock"), "utf8"))).toMatchObject({
      pid: process.pid,
    });
    // Reclaiming the lock must not stop the unrelated process that reused the PID.
    if (owner.pid === undefined) throw new Error("Missing fixture process PID");
    expect(process.kill(owner.pid, 0)).toBe(true);
  });

  it("preserves a real live owner's lock", async () => {
    const content = await writeLock(processStartedAt);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
  });

  it("preserves a legacy lock without the process creation time", async () => {
    const content = await writeLock(undefined);
    await expect(store.initialize()).rejects.toMatchObject({ code: "STORE_LOCKED" });
    expect(await readFile(path.join(directory, "store.lock"), "utf8")).toBe(content);
  });
});
