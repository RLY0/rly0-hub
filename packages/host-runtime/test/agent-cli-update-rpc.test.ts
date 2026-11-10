import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentCliUpdateStatusSchema } from "@codexhost/shared-contracts";
import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { Rly0HubService } from "../src/rly0-hub-service/service.js";

const services: Rly0HubService[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-rpc-"));
  roots.push(root);
  const driver = {
    inspect: vi.fn(async () => null),
    install: vi.fn(),
    version: vi.fn(),
    busy: vi.fn(),
    ready: vi.fn(),
  };
  const service = new Rly0HubService({
    installRoot: root,
    environment: {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, "codex"),
      CODEXHOST_DATA_DIR: root,
      RLY0_MEMORY_DIR: path.join(root, "memory"),
      RLY0_SKIP_LEGACY_IMPORT: "1",
    },
    core: {
      dispose: vi.fn(),
      getProxySettings: () => ({ mode: "direct" }),
    } as unknown as Rly0CoreBridge,
    agentCliUpdateDriver: driver,
  });
  services.push(service);
  return { service, driver };
}
describe("CLI update management RPC", () => {
  it("exposes typed status, a durable default-on switch and a prompt manual trigger", async () => {
    const { service, driver } = await fixture();
    const status = agentCliUpdateStatusSchema.parse(
      await service.handle("agents.cliUpdates.status", {}),
    );
    expect(status.enabled).toBe(true);
    expect(status.agents.every((a) => a.phase === "idle")).toBe(true);
    expect(await service.handle("agents.cliUpdates.setEnabled", { enabled: false })).toMatchObject({
      enabled: false,
    });
    await service.handle("agents.cliUpdates.check", { agent: "pi" });
    await vi.waitFor(async () =>
      expect(await service.handle("agents.cliUpdates.status", {})).toMatchObject({
        checking: false,
      }),
    );
    expect(driver.inspect).not.toHaveBeenCalled();
    await service.handle("agents.cliUpdates.setEnabled", { enabled: true });
    await service.handle("agents.cliUpdates.check", { agent: "pi" });
    await vi.waitFor(() => expect(driver.inspect).toHaveBeenCalledTimes(1));
    expect(driver.install).not.toHaveBeenCalled();
  });
  it.each([
    ["agents.cliUpdates.status", { command: "npm" }],
    ["agents.cliUpdates.setEnabled", { enabled: "true" }],
    ["agents.cliUpdates.setEnabled", { enabled: true, prefix: "/real/global" }],
    ["agents.cliUpdates.check", { agent: "claude-code" }],
    ["agents.cliUpdates.check", { agent: "codex" }],
    ["agents.cliUpdates.check", { agent: "zcode" }],
    ["agents.cliUpdates.check", { agent: "workbuddy" }],
    ["agents.cliUpdates.check", { agent: "pi", version: "evil" }],
  ])("rejects unsupported IDs, commands and untyped fields: %s", async (method, params) => {
    const { service, driver } = await fixture();
    await expect(service.handle(method as string, params)).rejects.toMatchObject({ code: -32602 });
    expect(driver.inspect).not.toHaveBeenCalled();
  });
});
