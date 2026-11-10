import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec, spawn: mocks.spawn }));
import { runInstallationCommand } from "../src/installation.js";

function syntheticChild() {
  return Object.assign(new EventEmitter(), {
    pid: 424242,
    stdin: { end: vi.fn() },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
}
beforeEach(() => {
  vi.resetAllMocks();
  // Bridge the existing callback fixtures to spawn events; every OS command stays injected.
  mocks.spawn.mockImplementation((command, args, options) => {
    const child = syntheticChild();
    const native = mocks.exec(
      command,
      args,
      options,
      (error: NodeJS.ErrnoException | null, stdout: string, stderr: string) => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        if (error && typeof error.code === "string") child.emit("error", error);
        child.emit("close", error ? 1 : 0);
      },
    );
    return native?.once ? native : child;
  });
});
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
          const child = mocks.spawn.mock.results[0]?.value;
          child?.emit("close", null, "SIGKILL");
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
    const killTree = vi.fn(async () => {
      await gate.promise;
      mocks.spawn.mock.results[0]?.value.emit("close", null, "SIGKILL");
    });
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

describe("review 2 detached group and Windows exit regressions (synthetic)", () => {
  it("kills only its own POSIX process group without invoking ps", async () => {
    vi.useFakeTimers();
    const child = syntheticChild();
    const spawn = vi.fn(() => child);
    mocks.spawn.mockImplementation(spawn);
    const kill = vi.fn(() => {
      child.emit("close", null, "SIGKILL");
      return true as const;
    });
    const pending = runInstallationCommand("/synthetic/npm", [], {}, 100, "darwin", { kill });
    const checked = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(mocks.spawn.mock.calls[0]?.[2]).toMatchObject({ detached: true });
    expect(kill.mock.calls).toEqual([[-424242, "SIGKILL"]]);
    expect(mocks.exec).not.toHaveBeenCalled();
  });
  it("at least kills its direct child when group signalling fails, preserving failure", async () => {
    vi.useFakeTimers();
    const child = syntheticChild();
    mocks.spawn.mockReturnValue(child);
    const kill = vi.fn((pid: number) => {
      if (pid < 0) throw Object.assign(new Error("synthetic"), { code: "EPERM" });
      child.emit("close", null, "SIGKILL");
      return true as const;
    });
    const pending = runInstallationCommand("/synthetic/npm", [], {}, 100, "darwin", { kill });
    const checked = expect(pending).rejects.toThrow("COMMAND_TREE_STOP_FAILED");
    await vi.advanceTimersByTimeAsync(100);
    await checked;
    expect(kill.mock.calls).toEqual([
      [-424242, "SIGKILL"],
      [424242, "SIGKILL"],
    ]);
  });
  it("accepts taskkill losing the race to a confirmed native close", async () => {
    vi.useFakeTimers();
    const child = syntheticChild();
    mocks.spawn.mockReturnValue(child);
    mocks.exec.mockImplementation((_command, _args, _options, callback) => {
      child.emit("close", 0);
      callback(new Error("ERROR: The process '424242' not found."));
    });
    const pending = runInstallationCommand("C:\\Synthetic\\npm.cmd", [], {}, 100, "win32");
    const checked = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await checked;
  });
  it("distinguishes Windows npm EPERM rename failure from EACCES", async () => {
    mocks.exec.mockImplementation((_command, _args, _options, callback) => {
      queueMicrotask(() =>
        callback(
          Object.assign(new Error("synthetic"), { code: 1 }),
          "",
          "npm error code EPERM\nnpm error syscall rename",
        ),
      );
      return { stdin: { end: vi.fn() } };
    });
    await expect(
      runInstallationCommand("C:\\Synthetic\\npm.cmd", ["install"], {}, 100, "win32"),
    ).rejects.toThrow("COMMAND_FILE_IN_USE");
  });
});
