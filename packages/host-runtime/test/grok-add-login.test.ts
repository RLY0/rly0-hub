import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GrokAddLogin,
  grokLoginEnvironment,
  grokLoginUrl,
  importGrokAccountFile,
} from "../src/rly0-hub-service/grok-add-login.js";

const roots: string[] = [];
const logins: GrokAddLogin[] = [];
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

function fixture(installed = true) {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "rly0-grok-add-test-"));
  roots.push(tempRoot);
  const child = fakeChild();
  const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd?: string }[] = [];
  const spawnProcess = vi.fn(
    (command: string, args: string[], options: { env: NodeJS.ProcessEnv; cwd?: string }) => {
      calls.push({ command, args, env: options.env, ...(options.cwd ? { cwd: options.cwd } : {}) });
      return child;
    },
  );
  const grokAccounts = vi.fn(async (method: string) => {
    if (method === "importFrom") return { id: "abcdef123456", email: "new@x.ai" };
    return { ok: true };
  });
  const openUrl = vi.fn();
  const controller = new GrokAddLogin({
    environment: async () => ({
      PATH: "C:\\bin",
      XAI_API_KEY: "xai-must-not-leak",
      GROK_HOME: "C:\\Users\\me\\.grok",
      GROK_OIDC_ISSUER: "https://login.example.com",
    }),
    platform: "win32",
    core: {
      grokAccounts: grokAccounts as never,
      getProxySettings: () => ({ mode: "none" }) as never,
    },
    openUrl,
    spawnProcess: spawnProcess as unknown as typeof spawn,
    fileExists: () => installed,
    tempRoot,
    timeoutMs: 10_000,
  });
  logins.push(controller);
  return { controller, child, calls, grokAccounts, openUrl, tempRoot };
}

const waitFor = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
};

describe("adding a Grok account without signing out", () => {
  it("runs the official `grok login` in a throw-away GROK_HOME and saves it", async () => {
    const f = fixture();
    expect((await f.controller.start("工作号")).phase).toBe("starting");
    const call = f.calls[0];
    const dir = call?.env.GROK_HOME ?? "";
    expect(path.basename(dir)).toMatch(/^rly0-grok-login-/u);
    expect(path.dirname(dir)).toBe(f.tempRoot);
    expect(call).toMatchObject({ command: '"grok"', args: ["login"], cwd: dir });
    expect(call?.env.XAI_API_KEY).toBeUndefined();
    expect(call?.env.GROK_OIDC_ISSUER).toBe("https://login.example.com");

    // A help link is not the sign-in page; the xAI page is, and only on request.
    f.child.stdout.write("Docs: https://example.com/help\n");
    expect(f.controller.status().phase).toBe("starting");
    f.child.stdout.write("Open https://auth.x.ai/oauth2/auth?client_id=c&state=s to sign in\n");
    expect(f.controller.status().phase).toBe("waitingForCode");
    expect(f.openUrl).not.toHaveBeenCalled();
    f.controller.reopen(f.controller.status().id ?? "");
    expect(f.openUrl).toHaveBeenCalledOnce();

    f.child.exitCode = 0;
    f.child.emit("close", 0);
    await waitFor(() => f.controller.status().phase === "succeeded");
    expect(f.controller.status()).toMatchObject({
      phase: "succeeded",
      result: { id: "abcdef123456", email: "new@x.ai" },
    });
    expect(f.grokAccounts).toHaveBeenCalledWith("importFrom", { grokHome: dir, alias: "工作号" });
    await waitFor(() => !existsSync(dir));
    expect(existsSync(dir)).toBe(false);
  });

  it("finishes without a printed link, and fails clearly when the CLI does", async () => {
    const f = fixture();
    await f.controller.start();
    f.child.exitCode = 1;
    f.child.emit("close", 1);
    await waitFor(() => f.controller.status().phase === "failed");
    expect(f.controller.status()).toMatchObject({
      phase: "failed",
      error: "GROK_ADD_LOGIN_FAILED",
    });
    expect(f.grokAccounts).not.toHaveBeenCalled();
  });

  it("says when Grok is not installed", async () => {
    const f = fixture(false);
    expect(await f.controller.start()).toMatchObject({
      phase: "failed",
      error: "GROK_NOT_INSTALLED",
    });
    expect(f.calls).toHaveLength(0);
  });

  it("only opens xAI's own https pages", () => {
    expect(grokLoginUrl("https://accounts.x.ai/sign-in?x=1")?.hostname).toBe("accounts.x.ai");
    expect(grokLoginUrl("https://grok.com/device")).not.toBeNull();
    expect(grokLoginUrl("http://auth.x.ai/x")).toBeNull();
    expect(grokLoginUrl("https://auth.x.ai.evil.com/x")).toBeNull();
    expect(grokLoginUrl("https://user:pw@auth.x.ai/x")).toBeNull();
    expect(grokLoginEnvironment({ GROK_TOKEN: "t", A: "1" }, "D")).toEqual({
      A: "1",
      GROK_HOME: "D",
    });
  });
});

describe("importing a Grok login file", () => {
  it("saves an auth.json as an account and an API key file as the official key", async () => {
    const core = {
      grokAccounts: vi.fn(async (_m: string, p: Record<string, unknown>) => {
        if (String(p.content).includes("xai-")) throw new Error("GROK_FILE_API_KEY");
        if (String(p.content).includes("nothing")) throw new Error("GROK_FILE_NO_LOGIN");
        return { id: "abcdef123456", email: "a@x.ai", expired: false, token: "never" };
      }),
    };
    const saveKeyFile = vi.fn(async (content: string) => {
      if (!content.includes("xai-")) throw new Error("AUTH_FILE_NOT_A_LOGIN");
    });
    expect(await importGrokAccountFile(core as never, "{}", { saveKeyFile })).toEqual({
      ok: true,
      id: "abcdef123456",
      email: "a@x.ai",
      expired: false,
    });
    expect(await importGrokAccountFile(core as never, '{"k":"xai-1"}', { saveKeyFile })).toEqual({
      ok: true,
      key: true,
    });
    await expect(
      importGrokAccountFile(core as never, '{"nothing":1}', { saveKeyFile }),
    ).rejects.toThrow("GROK_FILE_NO_LOGIN");
  });
});
