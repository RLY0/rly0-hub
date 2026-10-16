import { describe, expect, it, vi } from "vitest";

import {
  AgentInstaller,
  RLY0_AGENT_RECIPES,
  classifyInstallFailure,
  type CommandRunner,
} from "../src/rly0-agents/agent-installer.js";

type Script = (
  command: string,
  args: readonly string[],
) => { code: number | null; output?: string };

function fakeRunner(script: Script) {
  const calls: string[] = [];
  const environments: NodeJS.ProcessEnv[] = [];
  const runner: CommandRunner = {
    async run(command, args, options) {
      calls.push([command, ...args].join(" "));
      environments.push(options.environment);
      const { code, output = "" } = script(command, args);
      return { code, output };
    },
    openTerminal: vi.fn(async () => true),
  };
  return { runner, calls, environments };
}

async function settle(installer: AgentInstaller, agent: string) {
  await vi.waitFor(() => expect(installer.status(agent).state).not.toBe("running"));
  return installer.status(agent);
}

const windowsBase = {
  environment: { PATH: "C:\\Windows", APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
  platform: "win32" as const,
};

describe("one-click agent installation", () => {
  it("has a recipe for every agent on the Connections page", () => {
    expect(Object.keys(RLY0_AGENT_RECIPES).sort()).toEqual(
      [
        "antigravity",
        "claude-code",
        "codebuddy",
        "cursor-cli",
        "deepseek-harness",
        "grok",
        "hermes",
        "kimi-code",
        "kiro-cli",
        "omp",
        "opencode",
        "pi",
        "qoder",
        "qoder-cn",
        "workbuddy",
      ].sort(),
    );
  });

  it("runs the official installer through PowerShell with the proxy-aware environment", async () => {
    const { runner, calls, environments } = fakeRunner(() => ({ code: 0, output: "installed" }));
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      downloadEnvironment: () => ({
        ...windowsBase.environment,
        HTTPS_PROXY: "http://127.0.0.1:7890",
      }),
    });
    expect(installer.start("claude-code")).toMatchObject({ state: "running", automatic: true });
    const done = await settle(installer, "claude-code");
    expect(done).toMatchObject({ state: "succeeded", canOpenLogin: true });
    expect(calls).toEqual([
      "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command irm https://claude.ai/install.ps1 | iex",
    ]);
    expect(environments[0]?.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    // Freshly installed tools are found without waiting for a new login session.
    expect(environments[0]?.PATH).toContain("C:\\Users\\me\\AppData\\Roaming\\npm");
  });

  it("falls back from the official installer to npm, then to the npm mirror", async () => {
    const { runner, calls } = fakeRunner((command, args) => {
      if (command === "powershell.exe") return { code: 1, output: "not available in your region" };
      return args.some((arg) => arg.includes("npmmirror"))
        ? { code: 0 }
        : { code: 1, output: "ETIMEDOUT" };
    });
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      fileExists: (file) =>
        ["C:\\Program Files\\nodejs\\npm.cmd", "C:\\Program Files\\nodejs\\node.exe"].includes(
          file,
        ),
    });
    installer.start("claude-code");
    expect(await settle(installer, "claude-code")).toMatchObject({ state: "succeeded" });
    expect(calls.slice(1)).toEqual([
      // npm is found through the added Node.js folder on PATH.
      '"npm" install -g @anthropic-ai/claude-code',
      '"npm" install -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com',
    ]);
  });

  it("installs Node.js with winget first when an npm agent needs it", async () => {
    let nodeInstalled = false;
    const { runner, calls } = fakeRunner((command) => {
      if (command === "winget") nodeInstalled = true;
      return { code: 0 };
    });
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      fileExists: (file) =>
        file.toLowerCase().endsWith("winget.exe") ||
        (nodeInstalled &&
          ["C:\\Program Files\\nodejs\\npm.cmd", "C:\\Program Files\\nodejs\\node.exe"].includes(
            file,
          )),
    });
    installer.start("opencode");
    expect(await settle(installer, "opencode")).toMatchObject({ state: "succeeded" });
    expect(calls[0]).toContain("winget install --id OpenJS.NodeJS.LTS -e --silent");
    expect(calls[1]).toBe('"npm" install -g opencode-ai');
  });

  it("explains failures: no Node.js without winget, network problems, desktop-only apps", async () => {
    const noWinget = new AgentInstaller({
      ...windowsBase,
      runner: fakeRunner(() => ({ code: 0 })).runner,
      fileExists: () => false,
    });
    noWinget.start("grok");
    expect(await settle(noWinget, "grok")).toMatchObject({
      state: "failed",
      error: "NODE_MISSING",
      requirementReason: "WINGET_UNAVAILABLE",
    });

    const offline = new AgentInstaller({
      ...windowsBase,
      runner: fakeRunner(() => ({ code: 1, output: "Unable to connect to the remote server" }))
        .runner,
    });
    offline.start("qoder");
    const failed = await settle(offline, "qoder");
    expect(failed).toMatchObject({ state: "failed", error: "NETWORK" });
    expect(failed.log).toContain("Unable to connect");

    const manual = new AgentInstaller({
      ...windowsBase,
      runner: fakeRunner(() => ({ code: 0 })).runner,
    });
    expect(manual.start("workbuddy")).toMatchObject({
      state: "failed",
      automatic: false,
      error: "MANUAL",
      manualUrl: expect.stringMatching(/^https:\/\/www\.workbuddy\.ai\//u),
    });
    expect(manual.start("not-an-agent")).toMatchObject({ error: "UNSUPPORTED" });
  });

  it("never starts the same agent twice and opens a terminal for sign-in", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls: string[] = [];
    const runner: CommandRunner = {
      async run(command) {
        calls.push(command);
        await gate;
        return { code: 0, output: "" };
      },
      openTerminal: vi.fn(async () => true),
    };
    const installer = new AgentInstaller({ ...windowsBase, runner });
    installer.start("pi");
    installer.start("pi");
    release();
    await settle(installer, "pi");
    expect(calls).toHaveLength(1);
    expect(await installer.openLogin("pi")).toBe(true);
    expect(runner.openTerminal).toHaveBeenCalledWith("pi", expect.any(Object));
    expect(await installer.openLogin("workbuddy")).toBe(false);
  });

  it("finds winget in WindowsApps and refreshes PATH for nonstandard Node installations", async () => {
    let installed = false;
    const { runner, calls, environments } = fakeRunner((command) => {
      if (command === "winget") {
        installed = true;
        return { code: 0 };
      }
      if (command === "powershell.exe") return { code: 0, output: "D:\\Tools\\Node" };
      return { code: 0 };
    });
    const installer = new AgentInstaller({
      ...windowsBase,
      environment: { ...windowsBase.environment, LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      runner,
      fileExists: (file) =>
        file.toLowerCase().endsWith("\\windowsapps\\winget.exe") ||
        (installed &&
          ["d:\\tools\\node\\npm.cmd", "d:\\tools\\node\\node.exe"].includes(file.toLowerCase())),
    });
    installer.start("grok");
    expect(await settle(installer, "grok")).toMatchObject({ state: "succeeded" });
    expect(calls[0]).toContain("winget install");
    expect(calls[1]).toContain("GetEnvironmentVariable('Path','Machine')");
    expect(environments.at(-1)?.PATH).toContain("D:\\Tools\\Node");
    expect(calls.at(-1)).toBe('"npm" install -g @xai-official/grok');
  });

  it.each([
    [0, "", "NOT_DETECTED"],
    [1, "ETIMEDOUT", "NETWORK"],
    [1, "Access is denied", "PERMISSION"],
    [1, "installer failed", "INSTALL_FAILED"],
  ])(
    "never continues to npm when winget exits %s but Node remains unavailable",
    async (code, output, reason) => {
      const { runner, calls } = fakeRunner((command) =>
        command === "winget"
          ? { code: Number(code), output: String(output) }
          : { code: 0, output: "" },
      );
      const installer = new AgentInstaller({
        ...windowsBase,
        runner,
        fileExists: (file) => file.toLowerCase().endsWith("winget.exe"),
      });
      installer.start("grok");
      expect(await settle(installer, "grok")).toMatchObject({
        state: "failed",
        error: "NODE_MISSING",
        requirementReason: reason,
      });
      expect(calls.some((c) => c.includes("install -g"))).toBe(false);
    },
  );

  it("detects an existing Node and npm outside the inherited PATH", async () => {
    const { runner, calls } = fakeRunner(() => ({ code: 0 }));
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      fileExists: (file) =>
        ["c:\\program files\\nodejs\\node.exe", "c:\\program files\\nodejs\\npm.cmd"].includes(
          file.toLowerCase(),
        ),
    });
    installer.start("grok");
    expect(await settle(installer, "grok")).toMatchObject({ state: "succeeded" });
    expect(calls).toEqual(['"npm" install -g @xai-official/grok']);
  });

  it("classifies installer output", () => {
    expect(classifyInstallFailure("getaddrinfo ENOTFOUND registry.npmjs.org")).toBe("NETWORK");
    expect(classifyInstallFailure("npm ERR! code EPERM")).toBe("PERMISSION");
    expect(classifyInstallFailure("something else")).toBe("FAILED");
  });
});
