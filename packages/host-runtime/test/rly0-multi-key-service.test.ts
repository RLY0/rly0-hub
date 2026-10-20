import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { Rly0HubService } from "../src/rly0-hub-service/service.js";

describe("SYNTHETIC multiple Claude credentials", () => {
  it("adds without switching, addresses each card, and refuses wrong-vendor or active deletion", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-multi-key-"));
    const entries = ["aaaaaaaaaaaa", "bbbbbbbbbbbb"].map((id) => ({
      id,
      name: id,
      baseUrl: "https://api.anthropic.com",
      models: [],
      protocol: "responses",
      enabled: true,
      hasKey: true,
    }));
    entries.push({
      id: "cccccccccccc",
      name: "other vendor",
      baseUrl: "https://api.x.ai/v1",
      models: [],
      protocol: "responses",
      enabled: true,
      hasKey: true,
    });
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const core = {
      listRelays: async () => ({ available: true, relays: entries }),
      claudeAccounts: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        return method === "saveKey"
          ? { id: "bbbbbbbbbbbb" }
          : { kind: "subscription", last4: params.relayId, valid: true };
      },
      testRelay: async () => ({ available: true, ok: true, models: [] }),
      removeRelay: async ({ id }: { id: string }) => {
        entries.splice(
          entries.findIndex((entry) => entry.id === id),
          1,
        );
        return { available: true, ok: true };
      },
      updateRelay: async ({ id, name }: { id: string; name: string }) => {
        const entry = entries.find((entry) => entry.id === id);
        if (!entry) throw new Error("SYNTHETIC_ENTRY_NOT_FOUND");
        entry.name = name;
        return { available: true, relay: entry };
      },
      proxyStatus: async () => ({
        available: true,
        running: true,
        baseUrl: "http://127.0.0.1:25917/v1",
      }),
      dispose: async () => undefined,
    } as unknown as Rly0CoreBridge;
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      core,
      backendReloadTimeoutMs: 25,
    });
    try {
      await service.handle("agents.officialKeys.select", {
        vendor: "anthropic",
        id: "aaaaaaaaaaaa",
      });
      await expect(
        service.handle("agents.officialKeys.rename", {
          vendor: "anthropic",
          id: "aaaaaaaaaaaa",
          name: "主力 Claude",
        }),
      ).resolves.toMatchObject({ ok: true, name: "主力 Claude" });
      expect(entries[0].name).toBe("主力 Claude");
      await expect(
        service.handle("agents.officialKeys.rename", {
          vendor: "anthropic",
          id: "cccccccccccc",
          name: "错误站点",
        }),
      ).rejects.toThrow("OFFICIAL_KEY_NOT_FOUND");
      await expect(
        service.handle("agents.officialKeys.rename", {
          vendor: "anthropic",
          id: "aaaaaaaaaaaa",
          name: " ",
        }),
      ).rejects.toThrow("INVALID_PARAMS");
      await service.handle("agents.officialKeys.set", {
        vendor: "anthropic",
        apiKey: "sk-ant-oat01-SYNTHETIC_TOKEN_1234567890",
      });
      expect(await service.handle("agents.relays.get", {})).toMatchObject({
        claudeCode: "aaaaaaaaaaaa",
      });
      expect(
        await service.handle("agents.officialKeys.info", {
          vendor: "anthropic",
          id: "bbbbbbbbbbbb",
        }),
      ).toMatchObject({ info: { id: "bbbbbbbbbbbb", last4: "bbbbbbbbbbbb" } });
      await service.handle("agents.officialKeys.select", {
        vendor: "anthropic",
        id: "bbbbbbbbbbbb",
      });
      expect(
        await service.handle("agents.officialKeys.info", { vendor: "anthropic" }),
      ).toMatchObject({ info: { id: "bbbbbbbbbbbb" } });
      await service.handle("agents.claudeCode.keyInfo", {});
      expect(calls.at(-1)).toEqual({ method: "keyInfo", params: { relayId: "bbbbbbbbbbbb" } });
      await expect(
        service.handle("agents.officialKeys.remove", { vendor: "anthropic", id: "bbbbbbbbbbbb" }),
      ).rejects.toThrow("OFFICIAL_KEY_IN_USE");
      for (const method of ["info", "select", "remove"]) {
        await expect(
          service.handle(`agents.officialKeys.${method}`, {
            vendor: "anthropic",
            id: "cccccccccccc",
          }),
        ).rejects.toThrow("OFFICIAL_KEY_NOT_FOUND");
      }
      await service.handle("agents.officialKeys.remove", {
        vendor: "anthropic",
        id: "aaaaaaaaaaaa",
      });
      expect(entries.map((entry) => entry.id)).toEqual(["bbbbbbbbbbbb", "cccccccccccc"]);
      await expect(
        service.handle("agents.officialKeys.set", {
          vendor: "anthropic",
          id: "bbbbbbbbbbbb",
          apiKey: "sk-ant-oat01-SYNTHETIC_REPLACE_1234567890",
        }),
      ).rejects.toThrow("OFFICIAL_KEY_IN_USE");
      await service.handle("agents.relays.set", { claudeCode: null });
      await service.handle("agents.officialKeys.set", {
        vendor: "anthropic",
        id: "bbbbbbbbbbbb",
        apiKey: "sk-ant-oat01-SYNTHETIC_REPLACE_1234567890",
      });
      expect(calls.findLast((call) => call.method === "saveKey")?.params.id).toBe("bbbbbbbbbbbb");
    } finally {
      await service.dispose();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
