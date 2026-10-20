import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Rly0CoreBridge } from "../src/rly0-core/index.js";

async function harness(timeoutMs?: number) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-synthetic-local-"));
  await fs.writeFile(
    path.join(root, "account.json"),
    JSON.stringify({ id: "aaaaaaaaaaaa", alias: "before" }),
  );
  let notify: (() => void) | undefined;
  let complete: (() => void) | undefined;
  const children: ReturnType<typeof spawn>[] = [];
  const bridge = new Rly0CoreBridge({
    binaryPath: "synthetic",
    environment: { ...process.env, RLY0_SYNTHETIC_DIR: root },
    proxySettingsPath: null,
    timeoutMs,
    spawn: ((_binary: string, _args: string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawn(
        process.execPath,
        [path.join(import.meta.dirname, "fixtures/serial-rly0-core.mjs")],
        options,
      );
      children.push(child);
      child.stdout?.on("data", (data: Buffer) => {
        if (String(data).includes("_STARTED")) notify?.();
        if (String(data).includes("SYNTHETIC_MUTATION_COMPLETED")) complete?.();
      });
      return child;
    }) as typeof spawn,
  });
  return {
    bridge,
    started: () =>
      new Promise<void>((resolve) => {
        notify = resolve;
      }),
    completed: () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
    async close() {
      const exits = children
        .filter((child) => child.exitCode === null)
        .map((child) => new Promise<void>((resolve) => child.once("exit", () => resolve())));
      await bridge.dispose();
      await Promise.all(exits);
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

describe("SYNTHETIC local account reads while the core is busy", () => {
  it("shows accounts while a synchronous quota request is still blocked", async () => {
    const h = await harness();
    try {
      const started = h.started();
      let quotaSettled = false;
      const quota = h.bridge.claudeAccounts("keyInfo", { relayId: "aaaaaaaaaaaa" }).finally(() => {
        quotaSettled = true;
      });
      await started;
      const listed = await h.bridge.claudeAccounts("list");
      expect(listed).toMatchObject({ accounts: [{ alias: "before" }] });
      expect(quotaSettled).toBe(false);
      await quota;
    } finally {
      await h.close();
    }
  });

  it("waits for an earlier rename and reads its persisted name", async () => {
    const h = await harness();
    try {
      const started = h.started();
      const rename = h.bridge.claudeAccounts("rename", { id: "aaaaaaaaaaaa", alias: "after" });
      await started;
      const listed = h.bridge.claudeAccounts("list");
      await expect(rename).resolves.toEqual({ ok: true });
      await expect(listed).resolves.toMatchObject({ accounts: [{ alias: "after" }] });
    } finally {
      await h.close();
    }
  });

  it("does not release a queued mutation when its caller times out", async () => {
    const h = await harness(350);
    try {
      const started = h.started();
      const completed = h.completed();
      const rename = h.bridge.claudeAccounts("rename", { id: "aaaaaaaaaaaa", alias: "late" });
      const timedOut = expect(rename).rejects.toThrow("RLY0_CORE_TIMEOUT");
      await started;
      await timedOut;
      await expect(h.bridge.claudeAccounts("list")).rejects.toThrow("RLY0_CORE_BUSY");
      await completed;
      await expect(h.bridge.claudeAccounts("list")).resolves.toMatchObject({
        accounts: [{ alias: "late" }],
      });
    } finally {
      await h.close();
    }
  });

  it("rejects a read waiting for a mutation when disposed", async () => {
    const h = await harness();
    try {
      const started = h.started();
      const rename = h.bridge.claudeAccounts("rename", { id: "aaaaaaaaaaaa", alias: "cancelled" });
      const writeFailed = expect(rename).rejects.toThrow("RLY0_CORE_DISPOSED");
      await started;
      const listed = h.bridge.claudeAccounts("list");
      const readFailed = expect(listed).rejects.toThrow("RLY0_CORE_DISPOSED");
      await h.bridge.dispose();
      await Promise.all([writeFailed, readFailed]);
    } finally {
      await h.close();
    }
  });
});
