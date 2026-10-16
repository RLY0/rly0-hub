import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  ClaudeCodeAuth,
  commandExists,
  parseClaudeAuthStatus,
  withClaudeCodeInstallPaths,
} from "../src/rly0-agents/claude-code-auth.js";

function fakeSpawn(script: (args: readonly string[]) => { output?: string; code?: number }) {
  const calls: string[][] = [];
  const spawnProcess = ((command: string, args: readonly string[]) => {
    calls.push([command, ...args]);
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      child.emit("close", null);
      return true;
    };
    const { output = "", code = 0 } = script(args);
    setTimeout(() => {
      child.stdout.write(output);
      if (code !== -1) child.emit("close", code);
    }, 1);
    return child;
  }) as never;
  return { calls, spawnProcess };
}

const installed = { fileExists: () => true, platform: "linux" as const };

describe("Claude Code sign-in through its CLI", () => {
  it("keeps only a few display fields from `claude auth status --json`", () => {
    expect(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}')).toEqual({
      installed: true,
      loggedIn: false,
    });
    expect(
      parseClaudeAuthStatus(
        'note\n{"loggedIn":true,"authMethod":"claude.ai","account":{"email":"me@example.com","subscriptionType":"max"},"accessToken":"secret"}',
      ),
    ).toEqual({
      installed: true,
      loggedIn: true,
      method: "claude.ai",
      email: "me@example.com",
      plan: "max",
    });
    expect(parseClaudeAuthStatus("garbage")).toMatchObject({ error: "STATUS_UNREADABLE" });
  });

  it("finds the command through PATH and PATHEXT, or reports it missing", () => {
    const files = new Set(["C:\\npm\\claude.cmd", "/usr/local/bin/claude"]);
    const exists = (file: string) => files.has(file);
    expect(
      commandExists(
        "claude",
        { PATH: "C:\\Windows;C:\\npm", PATHEXT: ".EXE;.CMD" },
        "win32",
        exists,
      ),
    ).toBe(true);
    expect(commandExists("claude", { PATH: "/usr/bin:/usr/local/bin" }, "linux", exists)).toBe(
      true,
    );
    expect(commandExists("claude", { PATH: "/usr/bin" }, "linux", exists)).toBe(false);
    expect(commandExists("C:\\nope\\claude.exe", {}, "win32", exists)).toBe(false);
  });

  it("reads status, starts the browser sign-in with the right mode, and signs out", async () => {
    const { calls, spawnProcess } = fakeSpawn((args) =>
      args[1] === "status"
        ? { output: '{"loggedIn":true,"account":{"email":"me@example.com"}}' }
        : args[1] === "login"
          ? { output: "Opening https://claude.ai/oauth/authorize?code=1 in your browser", code: -1 }
          : { code: 0 },
    );
    const auth = new ClaudeCodeAuth({ environment: { PATH: "/bin" }, spawnProcess, ...installed });
    expect(await auth.status()).toMatchObject({
      installed: true,
      loggedIn: true,
      email: "me@example.com",
    });
    await expect(auth.login("console")).resolves.toEqual({
      started: true,
      url: "https://claude.ai/oauth/authorize?code=1",
    });
    // A second request joins the running sign-in instead of starting another one.
    await expect(auth.login("claudeai")).resolves.toMatchObject({ started: true });
    expect(await auth.status()).toMatchObject({ loginInProgress: true });
    expect(await auth.logout()).toBe(true);
    expect(calls.map((call) => call.slice(1).join(" "))).toEqual([
      "auth status --json",
      "auth login --console",
      "auth status --json",
      "auth logout",
    ]);
  });

  it("uses the saved custom command and reports a missing Claude Code without running anything", async () => {
    const { calls, spawnProcess } = fakeSpawn(() => ({ output: "{}" }));
    const missing = new ClaudeCodeAuth({
      environment: { PATH: "/bin" },
      command: async () => "/opt/custom/claude",
      spawnProcess,
      platform: "linux",
      fileExists: () => false,
    });
    expect(await missing.status()).toEqual({ installed: false, loggedIn: false });
    expect(await missing.login("claudeai")).toEqual({ started: false });
    expect(calls).toEqual([]);
  });

  it("finds a freshly installed Claude Code outside the PATH Codex started with", async () => {
    const { calls, spawnProcess } = fakeSpawn(() => ({ output: '{"loggedIn":false}' }));
    const nativeInstall = "C:\\Users\\me\\.local\\bin\\claude.exe";
    const auth = new ClaudeCodeAuth({
      environment: { PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\me", PATHEXT: ".EXE;.CMD" },
      spawnProcess,
      platform: "win32",
      fileExists: (file) => file.toLowerCase() === nativeInstall.toLowerCase(),
    });
    expect(await auth.status()).toEqual({ installed: true, loggedIn: false });
    expect(calls).toHaveLength(1);
    expect(
      withClaudeCodeInstallPaths({ PATH: "C:\\Windows", USERPROFILE: "C:\\Users\\me" }, "win32")
        .PATH,
    ).toBe("C:\\Windows;C:\\Users\\me\\.local\\bin");
  });
});
