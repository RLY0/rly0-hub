import { promises as fs } from "node:fs";

import { describe, expect, it } from "vitest";

import { apiKeyLogin, importLogin, parseAuthFile } from "../src/rly0-hub-service/account-import.js";

describe("Adding Codex accounts from a file or an API key", () => {
  it("accepts a ChatGPT auth.json or an API-key auth.json, and nothing else", () => {
    const chatgpt = JSON.stringify({ tokens: { id_token: "a.b.c", access_token: "x" } });
    expect(parseAuthFile(`\uFEFF${chatgpt}`).alias).toBeUndefined();
    expect(
      parseAuthFile(JSON.stringify({ OPENAI_API_KEY: "sk-proj-abcdefgh12345678" })).alias,
    ).toBe("API Key ····5678");
    expect(() => parseAuthFile("not json")).toThrow("AUTH_FILE_INVALID");
    expect(() => parseAuthFile(JSON.stringify({ hello: 1 }))).toThrow("AUTH_FILE_NOT_A_LOGIN");
    expect(() => apiKeyLogin("nope")).toThrow("API_KEY_INVALID");
    expect(apiKeyLogin(" sk-proj-abcdefgh12345678 ").json).toBe(
      JSON.stringify({ OPENAI_API_KEY: "sk-proj-abcdefgh12345678" }),
    );
  });

  it("hands rly0-core a throw-away rly0-login folder and deletes it afterwards", async () => {
    let seen: { codexHome: string; alias?: string } | undefined;
    let content = "";
    const core = {
      importFrom: async (params: { codexHome: string; alias?: string }) => {
        seen = params;
        content = await fs.readFile(`${params.codexHome}/auth.json`, "utf8");
        return { available: true as const, id: "0123456789ab" };
      },
    };
    const result = await importLogin(core, '{"OPENAI_API_KEY":"sk-x"}', "API Key ····sk-x");
    expect(result).toEqual({ id: "0123456789ab" });
    expect(seen?.codexHome).toMatch(/rly0-login-[0-9a-f]{16}$/u);
    expect(content).toBe('{"OPENAI_API_KEY":"sk-x"}');
    await expect(fs.access(seen?.codexHome ?? "")).rejects.toThrow();
  });
});
