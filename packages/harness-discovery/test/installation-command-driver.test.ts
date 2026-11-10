import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
import { runInstallationCommand } from "../src/installation.js";

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.useRealTimers());
describe("injected native command transport", () => {
  it("executes Windows npm.cmd with cmd quoting and an explicit prefix without a real subprocess", async () => {
    mocks.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() => callback(null, "synthetic success", ""));
      return { stdin: { end: vi.fn() } };
    });
    const env = {
      HOME: "/synthetic/home",
      USERPROFILE: "C:\\Synthetic",
      CODEX_HOME: "/synthetic/codex",
      CODEXHOST_DATA_DIR: "/synthetic/data",
      RLY0_MEMORY_DIR: "/synthetic/memory",
      RLY0_SKIP_LEGACY_IMPORT: "1",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
    };
    await expect(
      runInstallationCommand(
        "C:\\Node Space\\npm.cmd",
        ["install", "--global", "--prefix", "C:\\Agent Space & Data\\npm", "pkg@1.2.3"],
        env,
        300_000,
        "win32",
      ),
    ).resolves.toBe("synthetic success");
    expect(mocks.exec).toHaveBeenCalledWith(
      env.ComSpec,
      [
        "/d",
        "/v:off",
        "/s",
        "/c",
        '""C:\\Node Space\\npm.cmd" "install" "--global" "--prefix" "C:\\Agent Space & Data\\npm" "pkg@1.2.3""',
      ],
      expect.objectContaining({
        windowsVerbatimArguments: true,
        windowsHide: true,
      }),
      expect.any(Function),
    );
  });
  it("reports permission failure without exposing command output or credentials", async () => {
    mocks.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error("synthetic secret"), { code: "EACCES" }),
          "",
          "synthetic token",
        ),
      );
      return { stdin: { end: vi.fn() } };
    });
    await expect(
      runInstallationCommand("/synthetic/npm", ["install"], { HOME: "/synthetic" }),
    ).rejects.toThrow("COMMAND_PERMISSION_DENIED");
  });
});

describe("review 1 command errors and cancellation (injected subprocesses)", () => {
  it.each([243, 1])("recognises npm EACCES even though error.code is numeric %s", async (code) => {
    mocks.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error("synthetic"), { code }),
          "",
          "npm error code EACCES; synthetic-secret",
        ),
      );
      return { stdin: { end: vi.fn() } };
    });
    await expect(
      runInstallationCommand("/synthetic/npm", ["install"], { HOME: "/synthetic" }),
    ).rejects.toThrow("COMMAND_PERMISSION_DENIED");
  });
  it("awaits taskkill /T /F on a timed-out Windows npm.cmd before returning to rollback", async () => {
    vi.useFakeTimers();
    let killed = false;
    let finishKill: (() => void) | undefined;
    mocks.exec.mockImplementation((command, _args, _options, callback) => {
      if (command === "taskkill.exe")
        finishKill = () => {
          killed = true;
          callback(null, "", "");
        };
      return { pid: 424242, stdin: { end: vi.fn() } };
    });
    const pending = runInstallationCommand(
      "C:\\Synthetic Space\\npm.cmd",
      ["install"],
      { HOME: "/synthetic" },
      100,
      "win32",
    );
    const checked = expect(pending).rejects.toThrow("timed out");
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(mocks.exec).toHaveBeenCalledWith(
      "taskkill.exe",
      ["/PID", "424242", "/T", "/F"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(settled).toBe(false);
    expect(killed).toBe(false);
    finishKill?.();
    await checked;
    expect(killed).toBe(true);
  });
  it("aborts a running command and waits for its injected tree terminator", async () => {
    const controller = new AbortController();
    const gate = Promise.withResolvers<undefined>();
    mocks.exec.mockReturnValue({ pid: 424242, stdin: { end: vi.fn() } });
    const killTree = vi.fn(() => gate.promise);
    const pending = runInstallationCommand(
      "/synthetic/npm",
      ["install"],
      { HOME: "/synthetic" },
      300_000,
      "darwin",
      { signal: controller.signal, killTree },
    );
    const checked = expect(pending).rejects.toThrow("INTERRUPTED");
    controller.abort();
    expect(killTree).toHaveBeenCalledWith(424242);
    gate.resolve(undefined);
    await checked;
  });
  it("does not run a command after cancellation and does not allow rollback after termination failure", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      runInstallationCommand("/synthetic/npm", ["install"], {}, 100, "win32", {
        signal: controller.signal,
      }),
    ).rejects.toThrow("INTERRUPTED");
    expect(mocks.exec).not.toHaveBeenCalled();
    vi.useFakeTimers();
    mocks.exec.mockReturnValue({ pid: 424242, stdin: { end: vi.fn() } });
    const pending = runInstallationCommand("/synthetic/npm", ["install"], {}, 100, "win32", {
      killTree: async () => {
        throw new Error("synthetic");
      },
    });
    const checked = expect(pending).rejects.toThrow("COMMAND_TREE_STOP_FAILED");
    await vi.advanceTimersByTimeAsync(100);
    await checked;
  });
});

it("does not resolve cancellation until the native process closes after the tree terminator", async () => {
  const controller = new AbortController();
  const child = Object.assign(new EventEmitter(), { pid: 424242, stdin: { end: vi.fn() } });
  mocks.exec.mockReturnValue(child);
  const pending = runInstallationCommand(
    "/synthetic/npm",
    ["install"],
    { HOME: "/synthetic" },
    300_000,
    "darwin",
    { signal: controller.signal, killTree: vi.fn(async () => undefined) },
  );
  const checked = expect(pending).rejects.toThrow("INTERRUPTED");
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  controller.abort();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", null, "SIGKILL");
  await checked;
});
