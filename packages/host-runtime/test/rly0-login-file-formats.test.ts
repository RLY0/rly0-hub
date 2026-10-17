import { describe, expect, it } from "vitest";

import { parseLoginFile } from "../src/rly0-hub-service/account-import.js";
import { parseClaudeImport } from "../src/rly0-hub-service/claude-official.js";

const sub2api = (accounts: unknown[]) =>
  JSON.stringify({ type: "sub2api-data", version: 1, proxies: [], accounts });

describe("login files from other tools", () => {
  it("turns Sub2API OpenAI accounts into Codex logins", () => {
    const logins = parseLoginFile(
      sub2api([
        {
          name: "ChatGPT-A",
          platform: "openai",
          type: "oauth",
          credentials: {
            access_token: "at-1",
            refresh_token: "rt-1",
            id_token: "id-1",
            chatgpt_account_id: "acc-1",
          },
        },
        { name: "Claude", platform: "anthropic", credentials: { access_token: "x" } },
      ]),
    );
    expect(logins).toHaveLength(1);
    expect(logins[0]!.alias).toBe("ChatGPT-A");
    const auth = JSON.parse(logins[0]!.json);
    expect(auth.tokens).toEqual({
      id_token: "id-1",
      access_token: "at-1",
      refresh_token: "rt-1",
      account_id: "acc-1",
    });
    expect(() => parseLoginFile(sub2api([]))).toThrow("AUTH_FILE_NOT_A_LOGIN");
    expect(parseLoginFile(JSON.stringify({ tokens: { id_token: "x" } }))).toHaveLength(1);
  });

  it("reads a Claude setup token from a Sub2API export", () => {
    const token = `sk-ant-oat01-${"a".repeat(90)}`;
    expect(
      parseClaudeImport(
        sub2api([
          { platform: "anthropic", type: "setup-token", credentials: { access_token: token } },
        ]),
      ),
    ).toEqual({ kind: "token", token });
    expect(() => parseClaudeImport(sub2api([{ platform: "openai" }]))).toThrow(
      "AUTH_FILE_NOT_A_LOGIN",
    );
    expect(
      parseClaudeImport(JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-xxxxxxxx" } }))
        .kind,
    ).toBe("credentials");
  });
});
