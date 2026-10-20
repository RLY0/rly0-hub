import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SandboxBinding } from "@codexhost/sandbox-runtime";
import {
  IsolationLogin,
  claudeIsolationLoginUrl,
} from "../src/rly0-hub-service/isolation-login.js";

const state = "synthetic-state-123";
const url = `https://claude.com/cai/oauth/authorize?client_id=test&code_challenge=synthetic-challenge&state=${state}&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback`;
const controllers: IsolationLogin[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.close();
  vi.useRealTimers();
});

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    kill: vi.fn(() => true),
  });
  let submitted = "";
  child.stdin.on("data", (chunk) => {
    submitted += chunk.toString();
  });
  const binding: SandboxBinding = {
    command: "D:\\DockerSandboxes\\sbx.exe",
    project: { project: "D:\\project", id: "sandbox-id", name: "claude-demo" },
    settings: {
      version: 1,
      enabled: false,
      runtimeRoot: "D:\\sandbox-runtime",
      proxy: "socks5h://127.0.0.1:19876",
      projects: [],
    },
  };
  const spawnProcess = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
  const openUrl = vi.fn();
  const resolve = vi.fn(async () => binding);
  const loggedIn = vi.fn(async () => true);
  const controller = new IsolationLogin({
    environment: { CODEXHOST_CLAUDE_COMMAND: "host-must-not-run.exe" },
    resolve,
    loggedIn,
    openUrl,
    spawnProcess: spawnProcess as unknown as typeof spawn,
    timeoutMs: 10000,
  });
  controllers.push(controller);
  return {
    controller,
    child,
    binding,
    spawnProcess,
    openUrl,
    resolve,
    loggedIn,
    submitted: () => submitted,
    ready: () => child.stdout.write(`Open browser:\n${url}\nPaste your code:\n`),
  };
}

describe("Hub isolated Claude browser login", () => {
  it("starts only the selected microVM's native login and opens a complete official link once", async () => {
    const f = fixture();
    await f.controller.start("D:\\project");
    expect(f.spawnProcess).toHaveBeenCalledOnce();
    const [command, args, options] = f.spawnProcess.mock.calls[0] as unknown as [
      string,
      string[],
      { env: NodeJS.ProcessEnv; windowsHide: boolean },
    ];
    expect(command).toBe(f.binding.command);
    expect(args).toContain("--login");
    expect(args.slice(-4)).toEqual([
      "/home/agent/.local/bin/claude",
      "auth",
      "login",
      "--claudeai",
    ]);
    expect(args).not.toContain("-t");
    expect(options).toMatchObject({
      windowsHide: true,
      env: { LOCALAPPDATA: "D:\\sandbox-runtime" },
    });
    f.child.stdout.write(url.slice(0, 90));
    expect(f.openUrl).not.toHaveBeenCalled();
    f.child.stdout.write(`${url.slice(90)}\n`);
    expect(f.controller.status().phase).toBe("waitingForCode");
    expect(f.openUrl).toHaveBeenCalledExactlyOnceWith(url);
    f.ready();
    expect(f.openUrl).toHaveBeenCalledOnce();
    expect(JSON.stringify(f.controller.status())).not.toContain("code_challenge");
  });
  it("rejects external or malformed links and accepts only the official manual-code flow", () => {
    expect(claudeIsolationLoginUrl(url)?.hostname).toBe("claude.com");
    for (const invalid of [
      url.replace("https://claude.com", "https://claude.com.evil.test"),
      url.replace("https://claude.com", "http://claude.com"),
      url.replace("https://claude.com", "https://user:secret@claude.com"),
      url.replace("oauth%2Fcode%2Fcallback", "unrelated"),
      url.replace("platform.claude.com", "evil.test"),
      "https://claude.com/help",
      url.replace(state, "short"),
    ])
      expect(claudeIsolationLoginUrl(invalid)).toBeNull();
  });
  it("keeps duplicate starts idempotent and refuses another project's login", async () => {
    const f = fixture();
    const first = await f.controller.start("D:\\project");
    expect((await f.controller.start("d:\\PROJECT")).id).toBe(first.id);
    await expect(f.controller.start("D:\\other")).rejects.toThrow("ISOLATION_LOGIN_BUSY");
    expect(f.spawnProcess).toHaveBeenCalledOnce();
  });
  it("passes a code only via stdin and confirms native auth status before reporting success", async () => {
    const f = fixture();
    await f.controller.start("D:\\project");
    f.ready();
    const id = f.controller.status().id ?? "";
    const code = `synthetic-one-time-code#${state}`;
    expect(await f.controller.submit(id, code)).toMatchObject({ phase: "authorizing" });
    expect(f.submitted()).toBe(`${code}\n`);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.spawnProcess.mock.calls)).not.toContain(code);
    expect(JSON.stringify(f.controller.status())).not.toContain(code);
    await expect(f.controller.submit(id, code)).rejects.toThrow("ISOLATION_LOGIN_NOT_WAITING");
    f.child.exitCode = 0;
    f.child.emit("close", 0);
    await vi.waitFor(() => expect(f.controller.status().phase).toBe("succeeded"));
    expect(f.loggedIn).toHaveBeenCalledOnce();
  });
  it("does not consume mismatched, stale or multiline codes", async () => {
    const f = fixture();
    await f.controller.start("D:\\project");
    f.ready();
    const id = f.controller.status().id ?? "";
    await expect(f.controller.submit(id, "code#another-state")).rejects.toThrow(
      "ISOLATION_LOGIN_CODE_MISMATCH",
    );
    await expect(f.controller.submit("old-id", "code")).rejects.toThrow("ISOLATION_LOGIN_STALE");
    await expect(f.controller.submit(id, "code\nmore-code")).rejects.toThrow(
      "ISOLATION_LOGIN_CODE_INVALID",
    );
    expect(f.submitted()).toBe("");
  });
  it("revalidates the project before submitting and rejects a replaced VM", async () => {
    const f = fixture();
    await f.controller.start("D:\\project");
    f.ready();
    f.resolve.mockResolvedValue({
      ...f.binding,
      project: { ...f.binding.project, id: "replaced" },
    });
    expect(
      await f.controller.submit(f.controller.status().id ?? "", `synthetic-code#${state}`),
    ).toMatchObject({ phase: "failed", error: "ISOLATION_LOGIN_SUBMIT_FAILED" });
    expect(f.submitted()).toBe("");
    expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it("does not call a zero exit code a successful login without credential confirmation", async () => {
    const f = fixture();
    f.loggedIn.mockResolvedValue(false);
    await f.controller.start("D:\\project");
    f.ready();
    f.child.exitCode = 0;
    f.child.emit("close", 0);
    await vi.waitFor(() =>
      expect(f.controller.status()).toMatchObject({
        phase: "failed",
        error: "ISOLATION_LOGIN_NOT_CONFIRMED",
      }),
    );
  });
  it("can reopen the official page when the browser opener fails", async () => {
    const f = fixture();
    f.openUrl.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    await f.controller.start("D:\\project");
    f.ready();
    expect(f.controller.status()).toMatchObject({ phase: "waitingForCode", browserOpened: false });
    f.controller.reopen(f.controller.status().id ?? "");
    expect(f.controller.status().browserOpened).toBe(true);
  });
  it("cancels pending setup and ignores late spawn results and stale child exits", async () => {
    const f = fixture();
    let finish!: (binding: SandboxBinding) => void;
    f.resolve.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const starting = f.controller.start("D:\\project");
    const id = f.controller.status().id ?? "";
    f.controller.cancel(id);
    finish(f.binding);
    await starting;
    expect(f.spawnProcess).not.toHaveBeenCalled();
    expect(f.controller.status().phase).toBe("cancelled");
  });
  it("gives a cold microVM minutes, not seconds, to print the authorization link", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("D:\project");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.controller.status().phase).toBe("starting");
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.controller.status()).toMatchObject({
      phase: "failed",
      error: "ISOLATION_LOGIN_TIMEOUT",
    });
    expect(f.child.kill).toHaveBeenCalledOnce();
  });
  it("times out and closes only its own login client", async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.controller.start("D:\\project");
    f.ready();
    await vi.advanceTimersByTimeAsync(10000);
    expect(f.controller.status()).toMatchObject({
      phase: "failed",
      error: "ISOLATION_LOGIN_TIMEOUT",
    });
    expect(f.child.kill).toHaveBeenCalledOnce();
    f.child.emit("close", 0);
    expect(f.controller.status().phase).toBe("failed");
  });
});
