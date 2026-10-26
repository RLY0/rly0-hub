import { createHash } from "node:crypto";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  AgentInstaller,
  RLY0_AGENT_RECIPES,
  classifyInstallFailure,
  createOutputDecoder,
  decodeTranscript,
  installWindowScript,
  type CommandRunner,
} from "../src/rly0-agents/agent-installer.js";
import { findCommand, windowsSystemTool } from "../src/rly0-agents/install-paths.js";
import {
  pickNodeLtsMsi,
  sha256FromShasums,
  type InstallerFiles,
} from "../src/rly0-agents/node-msi.js";

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

const isWinget = (command: string) => command.toLowerCase().endsWith("winget.exe");
const downloadUrl = (args: readonly string[]) => /-Uri '([^']+)'/u.exec(args.join(" "))?.[1];

/** Temporary files for the MSI fallback, served from memory by file name. */
function fakeFiles(contents: Record<string, string | Uint8Array>) {
  const removed: string[] = [];
  const files: InstallerFiles = {
    makeTempDirectory: async () => "T:\\rly0-node-1",
    read: async (file) => {
      const value = contents[path.win32.basename(file)];
      if (value === undefined) throw new Error(`ENOENT ${file}`);
      return typeof value === "string" ? Buffer.from(value) : value;
    },
    remove: async (target) => {
      removed.push(target);
    },
  };
  return { files, removed };
}

const MSI_BYTES = Buffer.from("fake node msi");
const MSI_NAME = "node-v22.12.0-x64.msi";
const NODE_INDEX = JSON.stringify([
  { version: "v23.4.0", lts: false, files: ["win-x64-msi"] },
  { version: "v22.12.0", lts: "Jod", files: ["win-x64-msi", "win-x64-zip"] },
]);
const sumsFor = (bytes: Uint8Array) =>
  `${"0".repeat(64)}  node-v22.12.0-x86.msi\n${createHash("sha256").update(bytes).digest("hex")}  ${MSI_NAME}\n`;

describe("one-click agent installation", () => {
  it("has a recipe for every agent on the Connections page", () => {
    expect(Object.keys(RLY0_AGENT_RECIPES).sort()).toEqual(
      [
        "antigravity",
        "claude-code",
        "codebuddy",
        "copilot",
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
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(
      /^powershell\.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command /u,
    );
    // UTF-8 output, TLS 1.2 and the Hub's proxy for irm come first; then the official command.
    expect(calls[0]).toContain("[Console]::OutputEncoding=[Text.Encoding]::UTF8");
    expect(calls[0]).toContain("[Net.SecurityProtocolType]::Tls12");
    expect(calls[0]).toContain("Net.WebProxy($env:HTTPS_PROXY,$true)");
    expect(calls[0]).not.toContain('"');
    expect(calls[0]?.endsWith(";irm https://claude.ai/install.ps1 | iex")).toBe(true);
    expect(environments[0]?.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(done.log).toContain(
      "[RLY/0 Hub] 运行官方安装脚本：irm https://claude.ai/install.ps1 | iex",
    );
    expect(done.log).toContain("退出码 0");
    expect(done.log).toContain("网络：http://127.0.0.1:7890");
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
    expect(calls.slice(1).filter((call) => !call.includes("GetEnvironmentVariable"))).toEqual([
      // npm is found through the added Node.js folder on PATH.
      '"npm" install -g @anthropic-ai/claude-code',
      '"npm" install -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com',
    ]);
  });

  it("installs Node.js with winget first when an npm agent needs it", async () => {
    let nodeInstalled = false;
    const { runner, calls } = fakeRunner((command) => {
      if (isWinget(command)) nodeInstalled = true;
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
    expect(calls[0]).toContain(
      "winget.exe install --id OpenJS.NodeJS.LTS -e --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity",
    );
    expect(calls[1]).toBe('"npm" install -g opencode-ai');
  });

  it("explains failures: no Git without winget, network problems, desktop-only apps", async () => {
    const noWinget = new AgentInstaller({
      ...windowsBase,
      runner: fakeRunner(() => ({ code: 0 })).runner,
      fileExists: () => false,
    });
    noWinget.start("kimi-code");
    const noGit = await settle(noWinget, "kimi-code");
    expect(noGit).toMatchObject({
      state: "failed",
      error: "GIT_MISSING",
      requirementReason: "WINGET_UNAVAILABLE",
    });
    expect(noGit.log).toContain("没有找到 winget");

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
      if (isWinget(command)) {
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
    expect(calls[0]).toContain("winget.exe install");
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
    "never continues when winget exits %s but Git remains unavailable",
    async (code, output, reason) => {
      const { runner, calls } = fakeRunner((command) =>
        isWinget(command)
          ? { code: Number(code), output: String(output) }
          : { code: 0, output: "" },
      );
      const installer = new AgentInstaller({
        ...windowsBase,
        runner,
        fileExists: (file) => file.toLowerCase().endsWith("winget.exe"),
      });
      installer.start("kimi-code");
      expect(await settle(installer, "kimi-code")).toMatchObject({
        state: "failed",
        error: "GIT_MISSING",
        requirementReason: reason,
      });
      expect(calls.some((c) => c.includes("install.ps1"))).toBe(false);
    },
  );

  it("installs the verified Node.js LTS MSI when winget is missing", async () => {
    let nodeInstalled = false;
    const { runner, calls } = fakeRunner((command) => {
      if (command === "msiexec.exe") {
        nodeInstalled = true;
        return { code: 0 };
      }
      return { code: 0 };
    });
    const { files, removed } = fakeFiles({
      "index.json": NODE_INDEX,
      "SHASUMS256.txt": sumsFor(MSI_BYTES),
      [MSI_NAME]: MSI_BYTES,
    });
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      files,
      fileExists: (file) =>
        nodeInstalled &&
        ["c:\\program files\\nodejs\\npm.cmd", "c:\\program files\\nodejs\\node.exe"].includes(
          file.toLowerCase(),
        ),
    });
    installer.start("opencode");
    const done = await settle(installer, "opencode");
    expect(done).toMatchObject({ state: "succeeded" });
    expect(calls.filter((c) => c.includes("Invoke-WebRequest"))).toHaveLength(3);
    expect(calls[0]).toContain("-Uri 'https://nodejs.org/dist/index.json'");
    expect(calls[1]).toContain("-Uri 'https://nodejs.org/dist/v22.12.0/SHASUMS256.txt'");
    expect(calls[2]).toContain(`-Uri 'https://nodejs.org/dist/v22.12.0/${MSI_NAME}'`);
    expect(calls[3]).toBe(`msiexec.exe /i T:\\rly0-node-1\\${MSI_NAME} /passive /norestart`);
    expect(calls.at(-1)).toBe('"npm" install -g opencode-ai');
    expect(done.log).toContain("没有找到 winget");
    expect(done.log).toContain("SHA256 已校验");
    expect(removed).toEqual(["T:\\rly0-node-1"]);
  });

  it("falls back to the npmmirror copy of Node.js when nodejs.org is unreachable", async () => {
    let nodeInstalled = false;
    const { runner, calls } = fakeRunner((command, args) => {
      if (downloadUrl(args)?.startsWith("https://nodejs.org/")) {
        return { code: 1, output: "Unable to connect to the remote server" };
      }
      if (command === "msiexec.exe") nodeInstalled = true;
      return { code: 0 };
    });
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      files: fakeFiles({
        "index.json": NODE_INDEX,
        "SHASUMS256.txt": sumsFor(MSI_BYTES),
        [MSI_NAME]: MSI_BYTES,
      }).files,
      fileExists: (file) =>
        nodeInstalled &&
        ["c:\\program files\\nodejs\\npm.cmd", "c:\\program files\\nodejs\\node.exe"].includes(
          file.toLowerCase(),
        ),
    });
    installer.start("grok");
    const done = await settle(installer, "grok");
    expect(done).toMatchObject({ state: "succeeded" });
    expect(calls[1]).toContain("-Uri 'https://npmmirror.com/mirrors/node/index.json'");
    expect(done.log).toContain("下载失败：https://nodejs.org/dist/index.json");
    expect(done.log).toContain("Unable to connect");
  });

  it.each([
    ["the downloads fail", { download: 1 }, "NETWORK", "下载失败"],
    ["the checksum differs", { msiBytes: Buffer.from("tampered") }, "INSTALL_FAILED", "校验失败"],
    ["UAC is declined", { msiexec: 1602 }, "PERMISSION", "管理员授权"],
    ["elevation is required", { msiexec: 1925 }, "PERMISSION", "需要管理员权限"],
  ] as const)(
    "reports a Node.js MSI failure when %s",
    async (
      _case,
      setup: { download?: number; msiBytes?: Buffer; msiexec?: number },
      reason,
      note,
    ) => {
      const { runner, calls } = fakeRunner((command, args) => {
        if (downloadUrl(args)) return { code: setup.download ?? 0, output: "ETIMEDOUT" };
        if (command === "msiexec.exe") return { code: setup.msiexec ?? 0 };
        return { code: 0 };
      });
      const installer = new AgentInstaller({
        ...windowsBase,
        runner,
        files: fakeFiles({
          "index.json": NODE_INDEX,
          "SHASUMS256.txt": sumsFor(MSI_BYTES),
          [MSI_NAME]: setup.msiBytes ?? MSI_BYTES,
        }).files,
        fileExists: () => false,
      });
      installer.start("grok");
      const done = await settle(installer, "grok");
      expect(done).toMatchObject({
        state: "failed",
        error: "NODE_MISSING",
        requirementReason: reason,
      });
      expect(done.log).toContain(note);
      expect(calls.some((c) => c.includes("install -g"))).toBe(false);
      if (setup.msiBytes) expect(calls.some((c) => c.startsWith("msiexec"))).toBe(false);
    },
  );

  it("tries the Node.js MSI after winget fails", async () => {
    let nodeInstalled = false;
    const { runner, calls } = fakeRunner((command) => {
      if (isWinget(command)) return { code: -1978335212, output: "No package found" };
      if (command === "msiexec.exe") nodeInstalled = true;
      return { code: 0 };
    });
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      files: fakeFiles({
        "index.json": NODE_INDEX,
        "SHASUMS256.txt": sumsFor(MSI_BYTES),
        [MSI_NAME]: MSI_BYTES,
      }).files,
      fileExists: (file) =>
        isWinget(file) ||
        (nodeInstalled &&
          ["c:\\program files\\nodejs\\npm.cmd", "c:\\program files\\nodejs\\node.exe"].includes(
            file.toLowerCase(),
          )),
    });
    installer.start("grok");
    const done = await settle(installer, "grok");
    expect(done).toMatchObject({ state: "succeeded" });
    expect(done.log).toContain("退出码 0x8A150014");
    expect(calls.some((c) => c.startsWith("msiexec.exe /i"))).toBe(true);
  });

  it("never writes proxy credentials into the log", async () => {
    const { runner } = fakeRunner(() => ({ code: 0 }));
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      downloadEnvironment: () => ({
        ...windowsBase.environment,
        HTTPS_PROXY: "http://me:secret@127.0.0.1:7890",
      }),
    });
    installer.start("pi");
    const done = await settle(installer, "pi");
    expect(done.log).toContain("网络：http://127.0.0.1:7890");
    expect(done.log).not.toContain("secret");
  });

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
    // Windows PowerShell 5.1 without TLS 1.2, in English and Chinese.
    expect(
      classifyInstallFailure(
        "The underlying connection was closed: An unexpected error occurred on a send.",
      ),
    ).toBe("NETWORK");
    expect(classifyInstallFailure("基础连接已经关闭: 发送时发生错误。")).toBe("NETWORK");
    expect(classifyInstallFailure("Invoke-WebRequest : 未能解析此远程名称: 'claude.ai'")).toBe(
      "NETWORK",
    );
    expect(classifyInstallFailure("无法加载文件，因为在此系统上禁止运行脚本。")).toBe("PERMISSION");
  });

  it("decodes GBK console output and UTF-8 split across chunks", () => {
    const gbk = createOutputDecoder();
    // “拒绝访问。” as cmd.exe writes it on a Chinese Windows.
    const text = gbk.write(Buffer.from("bedcbef8b7c3cecaa1a3", "hex")) + gbk.end();
    expect(text).toBe("拒绝访问。");
    expect(classifyInstallFailure(text)).toBe("PERMISSION");

    const utf8 = createOutputDecoder();
    const bytes = Buffer.from("网络超时 ETIMEDOUT", "utf8");
    expect(utf8.write(bytes.subarray(0, 4)) + utf8.write(bytes.subarray(4)) + utf8.end()).toBe(
      "网络超时 ETIMEDOUT",
    );
  });

  it("picks the newest LTS MSI and its checksum", () => {
    expect(pickNodeLtsMsi(JSON.parse(NODE_INDEX), "x64")).toEqual({
      version: "v22.12.0",
      file: MSI_NAME,
    });
    expect(pickNodeLtsMsi(JSON.parse(NODE_INDEX), "arm64")).toBeNull();
    expect(pickNodeLtsMsi({ not: "a list" }, "x64")).toBeNull();
    expect(
      pickNodeLtsMsi([{ version: "v1.0.0; rm", lts: "x", files: ["win-x64-msi"] }], "x64"),
    ).toBeNull();
    const sums = sumsFor(MSI_BYTES);
    expect(sha256FromShasums(sums, MSI_NAME)).toBe(
      createHash("sha256").update(MSI_BYTES).digest("hex"),
    );
    expect(sha256FromShasums(sums, "node-v22.12.0-arm64.msi")).toBeNull();
  });

  it("resolves winget aliases and System32 tools by full path", () => {
    const environment = {
      PATH: "C:\\Windows\\System32;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps",
      SystemRoot: "C:\\Windows",
    };
    const exists = (file: string) =>
      [
        "c:\\users\\me\\appdata\\local\\microsoft\\windowsapps\\winget.exe",
        "c:\\windows\\system32\\windowspowershell\\v1.0\\powershell.exe",
      ].includes(file.toLowerCase());
    expect(findCommand("winget", environment, "win32", exists)).toBe(
      "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
    );
    expect(findCommand("git", environment, "win32", exists)).toBeNull();
    expect(windowsSystemTool(environment, "WindowsPowerShell\\v1.0\\powershell.exe", exists)).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(windowsSystemTool({}, "msiexec.exe", exists)).toBe("msiexec.exe");
  });
});

describe("visible install window", () => {
  it("runs official scripts in a window the person can answer, and keeps its transcript", async () => {
    const windowed: string[] = [];
    const runner: CommandRunner = {
      async run() {
        return { code: 0, output: "" };
      },
      openTerminal: vi.fn(async () => true),
      async runInWindow(command) {
        windowed.push(command);
        return { code: 0, output: "Pi installed" };
      },
    };
    const installer = new AgentInstaller({ ...windowsBase, runner });
    installer.start("pi");
    const status = await settle(installer, "pi");
    expect(status.state).toBe("succeeded");
    expect(windowed).toEqual(["irm https://pi.dev/install.ps1 | iex"]);
    expect(status.log).toContain("Pi installed");
  });

  it("treats a non-zero exit as success once the agent's command is found", async () => {
    let installed = false;
    const runner: CommandRunner = {
      async run() {
        return { code: 0, output: "" };
      },
      openTerminal: vi.fn(async () => true),
      async runInWindow() {
        installed = true;
        return { code: 1, output: "stale exit code" };
      },
    };
    const installer = new AgentInstaller({
      ...windowsBase,
      runner,
      fileExists: (file) => installed && /[\\/]pi\.(cmd|exe)$/iu.test(file),
    });
    installer.start("pi");
    expect((await settle(installer, "pi")).state).toBe("succeeded");
  });

  it("wraps the command with a transcript, the network prelude and a readable ending", () => {
    const script = installWindowScript(
      "irm https://x.dev/i.ps1 | iex",
      "T:/it's.log",
      "T:/code.txt",
    );
    expect(script).toContain("Start-Transcript -LiteralPath 'T:/it''s.log'");
    expect(script).toContain("Set-Content -LiteralPath 'T:/code.txt' -Value $rly0Code");
    expect(script).toContain("Tls12");
    expect(script).toContain("try { irm https://x.dev/i.ps1 | iex;");
    expect(script.trim().endsWith("exit $rly0Code")).toBe(true);
    const transcript = [
      "**********************",
      "Start time: 1",
      "RunAs 用户: x",
      "**********************",
      "hello",
      "**********************",
      "End time: 2",
    ].join("\n");
    expect(decodeTranscript(Buffer.from(transcript))).toBe("hello");
  });
});
