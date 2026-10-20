import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeAddLogin,
  claudeLoginEnvironment,
  importClaudeAccountFile,
} from "../src/rly0-hub-service/claude-add-login.js";

const state = "synthetic-state-456";
const url = `https://claude.com/cai/oauth/authorize?code=true&client_id=test&code_challenge=c&state=${state}&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback`;
const roots: string[] = [];
const logins: ClaudeAddLogin[] = [];
afterEach(() => {
  for (const login of logins.splice(0)) login.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => true),
  });
}

function fixture(statusJson = '{"loggedIn":true,"authMethod":"claude.ai","email":"new@x.com"}') {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rly0-add-login-test-"));
  roots.push(tempRoot);
  const login = fakeChild();
  let submitted = "";
  login.stdin.on("data", (chunk) => (submitted += chunk.toString()));
  const calls: { args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
  const spawnProcess = vi.fn(
    (_command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
      calls.push({ args, env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) });
      if (args[1] === "status") {
        const status = fakeChild();
        setTimeout(() => {
          status.stdout.write(statusJson);
          status.exitCode = 0;
          status.emit("close", 0);
        }, 1);
        return status;
      }
      return login;
    },
  );
  const claudeAccounts = vi.fn(async (method: string) => {
    if (method === "importFrom") return { id: "abcdef123456", email: "new@x.com", plan: "max" };
    return { ok: true };
  });
  const openUrl = vi.fn();
  const controller = new ClaudeAddLogin({
    environment: {
      PATH: "C:\\bin",
      ANTHROPIC_API_KEY: "sk-ant-api-must-not-leak",
      CLAUDE_CONFIG_DIR: "C:\\Users\\me\\.claude",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "C:\\Users\\me\\.claude",
    },
    platform: "win32",
    core: {
      claudeAccounts: claudeAccounts as never,
      getProxySettings: () => ({ mode: "none" }) as never,
    },
    openUrl,
    spawnProcess: spawnProcess as unknown as typeof spawn,
    fileExists: () => true,
    tempRoot,
    timeoutMs: 10_000,
  });
  logins.push(controller);
  return {
    controller,
    login,
    calls,
    claudeAccounts,
    openUrl,
    tempRoot,
    submitted: () => submitted,
  };
}

describe("adding a Claude account without signing out", () => {
  it("runs the official login in its own throw-away config folder and saves it", async () => {
    const f = fixture();
    const started = await f.controller.start("工作号");
    expect(started.phase).toBe("starting");
    const dir = f.calls[0]?.env.CLAUDE_CONFIG_DIR ?? "";
    expect(path.basename(dir)).toMatch(/^rly0-claude-login-/u);
    expect(path.dirname(dir)).toBe(f.tempRoot);
    expect(f.calls[0]).toMatchObject({ args: ["auth", "login", "--claudeai"], cwd: dir });
    expect(f.calls[0]?.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(dir);
    expect(f.calls[0]?.env.ANTHROPIC_API_KEY).toBeUndefined();
    // Claude Code opens the browser itself; the Hub does not open a second page.
    f.login.stdout.write(
      `Opening browser to sign in…\nIf the browser didn't open, visit: ${url}\n`,
    );
    expect(f.controller.status()).toMatchObject({ phase: "waitingForCode" });
    expect(f.openUrl).not.toHaveBeenCalled();
    const id = f.controller.status().id ?? "";
    f.controller.reopen(id);
    expect(f.openUrl).toHaveBeenCalledExactlyOnceWith(url);
    // Finished by the browser callback, no pasted code.
    f.login.exitCode = 0;
    f.login.emit("close", 0);
    await vi.waitFor(() => expect(f.controller.status().phase).toBe("succeeded"));
    expect(f.controller.status().result).toEqual({
      id: "abcdef123456",
      email: "new@x.com",
      plan: "max",
    });
    expect(f.calls[1]).toMatchObject({ args: ["auth", "status", "--json"] });
    expect(f.calls[1]?.env.CLAUDE_CONFIG_DIR).toBe(dir);
    expect(f.claudeAccounts).toHaveBeenCalledWith("importFrom", {
      configDir: dir,
      alias: "工作号",
    });
    await vi.waitFor(() => expect(existsSync(dir)).toBe(false));
    expect(f.claudeAccounts).toHaveBeenCalledWith("forgetLogin", { configDir: dir });
  });

  it("passes a pasted code to the CLI and cleans up when cancelled", async () => {
    const f = fixture();
    await f.controller.start();
    f.login.stdout.write(`\u001b]8;;${url}\u0007${url}\u001b]8;;\u0007\n`);
    const id = f.controller.status().id ?? "";
    await expect(f.controller.submit(id, "only-a-code")).rejects.toThrow(
      "CLAUDE_ADD_LOGIN_CODE_INVALID",
    );
    await expect(f.controller.submit(id, "code#other-state")).rejects.toThrow(
      "CLAUDE_ADD_LOGIN_CODE_MISMATCH",
    );
    await f.controller.submit(id, `the-code#${state}`);
    expect(f.submitted()).toBe(`the-code#${state}\n`);
    expect(JSON.stringify(f.controller.status())).not.toContain("the-code");
    f.controller.cancel(id);
    expect(f.controller.status().phase).toBe("cancelled");
    expect(f.login.kill).toHaveBeenCalled();
    f.login.emit("close", null);
    await vi.waitFor(() => expect(readdirSync(f.tempRoot)).toEqual([]));
    expect(f.claudeAccounts).toHaveBeenCalledWith("forgetLogin", expect.anything());
    expect(f.claudeAccounts).not.toHaveBeenCalledWith("importFrom", expect.anything());
  });

  it("does not save anything Claude Code does not confirm", async () => {
    const f = fixture('{"loggedIn":false}');
    await f.controller.start();
    f.login.exitCode = 0;
    f.login.emit("close", 0);
    await vi.waitFor(() =>
      expect(f.controller.status()).toMatchObject({
        phase: "failed",
        error: "CLAUDE_ADD_LOGIN_NOT_CONFIRMED",
      }),
    );
    expect(f.claudeAccounts).not.toHaveBeenCalledWith("importFrom", expect.anything());
  });

  it("keeps the person's own config folder and keys out of the login", () => {
    const env = claudeLoginEnvironment(
      {
        PATH: "x",
        CLAUDE_CODE_OAUTH_TOKEN: "t",
        CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "r",
        ANTHROPIC_BASE_URL: "http://relay",
        HTTPS_PROXY: "http://127.0.0.1:7890",
      },
      "D:\\tmp\\rly0-claude-login-1",
    );
    expect(env).toEqual({
      PATH: "x",
      HTTPS_PROXY: "http://127.0.0.1:7890",
      CLAUDE_CONFIG_DIR: "D:\\tmp\\rly0-claude-login-1",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "D:\\tmp\\rly0-claude-login-1",
    });
  });
});

describe("importing a Claude credentials file", () => {
  it("hands Claude Code's format to rly0-core and returns display fields only", async () => {
    const claudeAccounts = vi.fn(async () => ({
      id: "abcdef123456",
      email: "file@x.com",
      plan: "max",
      renewed: true,
      extra: { secret: "no" },
    }));
    const content = JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "r" } });
    const result = await importClaudeAccountFile({ claudeAccounts } as never, content, {
      alias: "备用",
      saveToken: vi.fn(),
    });
    expect(claudeAccounts).toHaveBeenCalledWith("importFile", { content, alias: "备用" });
    expect(result).toEqual({
      ok: true,
      id: "abcdef123456",
      email: "file@x.com",
      plan: "max",
      renewed: true,
    });
  });
  it("keeps a Sub2API subscription token as the official key and rejects non-JSON", async () => {
    const claudeAccounts = vi.fn();
    const saveToken = vi.fn(async () => undefined);
    const sub2api = JSON.stringify({
      accounts: [
        {
          platform: "anthropic",
          credentials: { access_token: "sk-ant-oat01-synthetic-token-abc" },
        },
      ],
    });
    expect(
      await importClaudeAccountFile({ claudeAccounts } as never, sub2api, { saveToken }),
    ).toEqual({ ok: true, token: true });
    expect(saveToken).toHaveBeenCalledWith("sk-ant-oat01-synthetic-token-abc");
    await expect(
      importClaudeAccountFile({ claudeAccounts } as never, "not json", { saveToken }),
    ).rejects.toThrow("CLAUDE_FILE_NOT_JSON");
    expect(claudeAccounts).not.toHaveBeenCalled();
  });
});
