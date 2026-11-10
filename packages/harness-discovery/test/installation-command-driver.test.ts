import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ exec: vi.fn() }));
vi.mock("node:child_process", () => ({ execFile: mocks.exec }));
import { runInstallationCommand } from "../src/installation.js";

beforeEach(() => vi.resetAllMocks());
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
        timeout: 300_000,
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
