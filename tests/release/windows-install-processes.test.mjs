import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const windowsDir = path.join(root, "scripts/release/windows");
const stopper = path.join(windowsDir, "stop-install-processes.ps1");
const run = promisify(execFile);
const windows = process.platform === "win32";

/** Everything here runs in a throwaway folder; the real install directory is never touched. */
const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function sandbox() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "rly0-install-processes-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  return dir;
}

/** Starts a copy of Node under `exe`, so a process really runs from that file and locks it. */
async function holdOpen(exe) {
  await mkdir(path.dirname(exe), { recursive: true });
  await copyFile(process.execPath, exe);
  const child = spawn(exe, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  // kill() only reports, never throws, when the process is already gone.
  cleanups.push(() => child.kill("SIGKILL"));
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function stopScript(args) {
  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", stopper, ...args],
      { windowsHide: true, timeout: 90_000 },
    );
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code, stdout: String(error.stdout ?? "") };
  }
}

async function waitDead(pid) {
  for (let i = 0; i < 50 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

describe("installer process stop", () => {
  it("runs before any file is copied and asks before closing Codex", async () => {
    const iss = await readFile(path.join(windowsDir, "Installer.iss"), "utf8");
    expect(iss).toContain('Source: "stop-install-processes.ps1"; Flags: dontcopy');
    expect(iss).toContain("function PrepareToInstall");
    expect(iss).toContain("RunStopper('Detect', False)");
    expect(iss).toContain("RunStopper('Stop', CloseCodex)");
    expect(iss).toContain("需要先关闭 Codex，安装完会自动重新打开。");
    expect(iss).toContain("Check: ShouldReopenCodex");
    // Refusing leaves the old version untouched rather than half-installed.
    expect(iss).toContain("安装未进行，没有做任何更改");
  });

  it.skipIf(!windows)(
    "ends a helper holding a libexec file and leaves other programs alone",
    { timeout: 120_000 },
    async () => {
      const dir = await sandbox();
      const app = path.join(dir, "app");
      const repl = path.join(app, "libexec", "codexhost-node-repl.exe");
      const helper = await holdOpen(repl);
      const outsider = await holdOpen(path.join(dir, "elsewhere", "other.exe"));
      await expect(unlink(repl)).rejects.toMatchObject({ code: "EPERM" });

      const detect = await stopScript(["-InstallDir", app, "-Mode", "Detect"]);
      expect(detect.code).toBe(0);
      expect(detect.stdout).toContain("codexhost-node-repl.exe");

      const stop = await stopScript(["-InstallDir", app, "-Mode", "Stop", "-TimeoutSeconds", "15"]);
      expect(stop.code).toBe(0);
      expect(await waitDead(helper.pid)).toBe(true);
      expect(alive(outsider.pid)).toBe(true);
      await unlink(repl);
      expect(existsSync(repl)).toBe(false);
    },
  );

  it.skipIf(!windows)(
    "reports Codex using the install and closes it only when asked",
    { timeout: 120_000 },
    async () => {
      const dir = await sandbox();
      const app = path.join(dir, "app");
      const shim = await holdOpen(path.join(app, "libexec", "codexhost-shim.exe"));
      const codex = await holdOpen(path.join(dir, "codex", "Codex.exe"));
      const codexPattern = `${path.join(dir, "codex")}\\*`;

      const detect = await stopScript([
        "-InstallDir",
        app,
        "-Mode",
        "Detect",
        "-CodexPatterns",
        codexPattern,
      ]);
      expect(detect.code).toBe(2);

      await stopScript(["-InstallDir", app, "-Mode", "Stop", "-CodexPatterns", codexPattern]);
      expect(await waitDead(shim.pid)).toBe(true);
      expect(alive(codex.pid)).toBe(true);

      const close = await stopScript([
        "-InstallDir",
        app,
        "-Mode",
        "Stop",
        "-CloseCodex",
        "-CodexPatterns",
        codexPattern,
      ]);
      expect(close.code).toBe(0);
      expect(await waitDead(codex.pid)).toBe(true);
    },
  );

  it.skipIf(!windows)(
    "deletes files an earlier run renamed aside",
    { timeout: 60_000 },
    async () => {
      const dir = await sandbox();
      const app = path.join(dir, "app");
      const leftover = path.join(app, "libexec", "codexhost-node-repl.exe.rly0-old-123");
      await mkdir(path.dirname(leftover), { recursive: true });
      await writeFile(leftover, "old");
      expect((await stopScript(["-InstallDir", app, "-Mode", "Stop"])).code).toBe(0);
      expect(existsSync(leftover)).toBe(false);
    },
  );
});

const iscc = [
  path.join(process.env["ProgramFiles(x86)"] ?? "", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.ProgramFiles ?? "", "Inno Setup 6", "ISCC.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Inno Setup 6", "ISCC.exe"),
].find((candidate) => windows && existsSync(candidate));

// Builds the real Installer.iss with /DSandboxTest (its own AppId, no uninstall entry, shortcuts
// or registry) and installs into a temporary folder while a helper there holds its file open.
describe.skipIf(!iscc || process.env.RLY0_INSTALLER_SANDBOX !== "1")("installer sandbox", () => {
  it("stops the helper holding libexec and replaces its file", { timeout: 300_000 }, async () => {
    const dir = await sandbox();
    const payload = path.join(dir, "payload");
    await mkdir(path.join(payload, "libexec"), { recursive: true });
    await writeFile(path.join(payload, "libexec", "codexhost-node-repl.exe"), "new build");
    await run(iscc, [
      "/Q",
      path.join(windowsDir, "Installer.iss"),
      "/DSandboxTest",
      `/DPayloadRoot=${payload}`,
      `/DOutputDir=${dir}`,
      "/DOutputBaseFilename=sandbox-setup",
      "/DProductVersion=0.0.0-sandbox",
      "/DArchitecture=x64",
    ]);

    const app = path.join(dir, "app");
    const repl = path.join(app, "libexec", "codexhost-node-repl.exe");
    const helper = await holdOpen(repl);
    const log = path.join(dir, "setup.log");
    await run(
      path.join(dir, "sandbox-setup.exe"),
      ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/DIR=${app}`, `/LOG=${log}`],
      { timeout: 240_000 },
    );
    expect(await waitDead(helper.pid)).toBe(true);
    expect(await readFile(repl, "utf8")).toBe("new build");
    expect(await readFile(log, "utf8")).toContain("stop-install-processes -Mode Stop");
  });
});
