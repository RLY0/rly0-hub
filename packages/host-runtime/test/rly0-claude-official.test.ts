import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  importClaudeCredentials,
  isAnthropicOfficial,
  saveAnthropicApiKey,
} from "../src/rly0-hub-service/claude-official.js";

const KEY = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz";

describe("Claude Code official sign-ins", () => {
  it("saves an Anthropic key once and replaces it later", async () => {
    const relays: { id: string; name: string; baseUrl: string }[] = [];
    const core = {
      listRelays: vi.fn(async () => ({ available: true as const, relays: relays as never[] })),
      addRelay: vi.fn(async (p: { name: string; baseUrl: string }) => {
        relays.push({ id: "r-anthropic", name: p.name, baseUrl: p.baseUrl });
        return { available: true as const, id: "r-anthropic", relay: {} as never };
      }),
      updateRelay: vi.fn(async () => ({ available: true as const, relay: {} as never })),
    };
    expect(await saveAnthropicApiKey(core as never, ` ${KEY} `)).toEqual({ id: "r-anthropic" });
    expect(core.addRelay).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: "https://api.anthropic.com", apiKey: KEY, models: [] }),
    );
    expect(await saveAnthropicApiKey(core as never, KEY)).toEqual({ id: "r-anthropic" });
    expect(core.addRelay).toHaveBeenCalledTimes(1);
    expect(core.updateRelay).toHaveBeenCalledWith({
      id: "r-anthropic",
      apiKey: KEY,
      enabled: true,
    });
    await expect(saveAnthropicApiKey(core as never, "sk-openai-123")).rejects.toThrow(
      "API_KEY_INVALID",
    );
    expect(isAnthropicOfficial({ baseUrl: "https://api.anthropic.com/v1" })).toBe(true);
    expect(isAnthropicOfficial({ baseUrl: "https://api.rly0.com/v1" })).toBe(false);
  });

  it("imports a credentials file after backing up the current one", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-claude-"));
    const environment = { CLAUDE_CONFIG_DIR: home };
    await fs.writeFile(path.join(home, ".credentials.json"), "old", "utf8");
    const content = JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-xxxxxxxx" } });
    const result = await importClaudeCredentials(environment, content, () => 42);
    expect(result.backup).toBe(path.join(home, ".credentials.json.rly0-backup-42"));
    expect(await fs.readFile(result.backup!, "utf8")).toBe("old");
    expect(JSON.parse(await fs.readFile(path.join(home, ".credentials.json"), "utf8"))).toEqual(
      JSON.parse(content),
    );
    await expect(importClaudeCredentials(environment, "{}")).rejects.toThrow(
      "AUTH_FILE_NOT_A_LOGIN",
    );
    await expect(importClaudeCredentials(environment, "nope")).rejects.toThrow("AUTH_FILE_INVALID");
    await fs.rm(home, { recursive: true, force: true });
  });
});
