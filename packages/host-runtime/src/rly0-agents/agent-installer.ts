import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Rly0AgentInstallStatus } from "@codexhost/shared-contracts";

import { commandExists } from "./claude-code-auth.js";
import {
  fileOrAliasExists,
  findCommand,
  POWERSHELL_PRELUDE,
  powershellArguments,
  windowsSystemTool,
  withAgentInstallPaths,
} from "./install-paths.js";
import { installNodeFromMsi, windowsNodeArch, type InstallerFiles } from "./node-msi.js";

/**
 * One-click installation of native agents. Each agent has a recipe: the vendor's official
 * installer (the same command the Connections page shows), npm for npm-distributed agents, and the
 * prerequisites they need (Node.js, Git), installed with Windows' own winget when missing (Node.js
 * falls back to the checksum-verified official MSI when winget is missing or fails). Commands are
 * fixed literals; nothing the person types is executed.
 */

type Attempt =
  | { readonly kind: "script"; readonly windows: string; readonly posix: string }
  | { readonly kind: "npm"; readonly packageName: string };

interface Recipe {
  readonly requires?: readonly ("node" | "git")[];
  readonly attempts: readonly Attempt[];
  /** Page to open when the agent cannot be installed automatically (desktop apps). */
  readonly manualUrl?: string;
  /** Command that starts the agent in a terminal for its own sign-in or setup. */
  readonly loginCommand?: string;
  /** Installation detection is independent of interactive login support. */
  readonly detectionCommand?: string;
}

const script = (windows: string, posix: string): Attempt => ({ kind: "script", windows, posix });
const npm = (packageName: string): Attempt => ({ kind: "npm", packageName });

// Keep in step with the renderer's installation guides (same official sources).
export const RLY0_AGENT_RECIPES: Readonly<Record<string, Recipe>> = {
  pi: {
    attempts: [
      script("irm https://pi.dev/install.ps1 | iex", "curl -fsSL https://pi.dev/install.sh | sh"),
    ],
    loginCommand: "pi",
    detectionCommand: "pi",
  },
  "claude-code": {
    attempts: [
      script(
        "irm https://claude.ai/install.ps1 | iex",
        "curl -fsSL https://claude.ai/install.sh | bash",
      ),
      // Fallback when the native installer's download service is unreachable from here.
      npm("@anthropic-ai/claude-code"),
    ],
    requires: [],
    loginCommand: "claude",
    detectionCommand: "claude",
  },
  "deepseek-harness": {
    requires: ["node"],
    attempts: [npm("@deepseek-ai/dsh@0.1.5-rc.1")],
    detectionCommand: "dsh",
  },
  opencode: {
    requires: ["node"],
    attempts: [npm("opencode-ai")],
    loginCommand: "opencode",
    detectionCommand: "opencode",
  },
  grok: {
    requires: ["node"],
    attempts: [npm("@xai-official/grok")],
    loginCommand: "grok",
    detectionCommand: "grok",
  },
  omp: {
    attempts: [
      script("irm https://omp.sh/install.ps1 | iex", "curl -fsSL https://omp.sh/install | sh"),
    ],
    loginCommand: "omp",
    detectionCommand: "omp",
  },
  antigravity: {
    attempts: [
      script(
        "irm https://antigravity.google/cli/install.ps1 | iex",
        "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      ),
    ],
    loginCommand: "agy",
    detectionCommand: "agy",
  },
  "kiro-cli": {
    attempts: [
      script(
        "irm 'https://cli.kiro.dev/install.ps1' | iex",
        "curl -fsSL https://cli.kiro.dev/install | bash",
      ),
    ],
    loginCommand: "kiro-cli",
    detectionCommand: "kiro-cli",
  },
  codebuddy: {
    requires: ["node"],
    attempts: [npm("@tencent-ai/codebuddy-code")],
    loginCommand: "codebuddy",
    detectionCommand: "codebuddy",
  },
  workbuddy: {
    attempts: [],
    manualUrl:
      "https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Installation-Win-Guide",
  },
  "cursor-cli": {
    attempts: [
      script(
        "irm 'https://cursor.com/install?win32=true' | iex",
        "curl https://cursor.com/install -fsS | bash",
      ),
    ],
    loginCommand: "agent",
    detectionCommand: "agent",
  },
  hermes: {
    attempts: [
      script(
        "iex (irm https://hermes-agent.nousresearch.com/install.ps1)",
        "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
      ),
    ],
    loginCommand: "hermes model",
    detectionCommand: "hermes",
  },
  qoder: {
    attempts: [
      script(
        "irm https://qoder.com/install.ps1 | iex",
        "curl -fsSL https://qoder.com/install | bash",
      ),
    ],
    loginCommand: "qodercli",
    detectionCommand: "qodercli",
  },
  "qoder-cn": {
    attempts: [
      script(
        "irm https://static.qoder.com.cn/qoder-cli-cn/install.ps1 | iex",
        "curl -fsSL https://static.qoder.com.cn/qoder-cli-cn/install.sh | bash",
      ),
    ],
    loginCommand: "qoderclicn",
    detectionCommand: "qoderclicn",
  },
  "kimi-code": {
    requires: ["git"],
    attempts: [
      script(
        "irm https://code.kimi.com/kimi-code/install.ps1 | iex",
        "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash",
      ),
    ],
    loginCommand: "kimi",
    detectionCommand: "kimi",
  },
  copilot: {
    requires: ["node"],
    attempts: [npm("@github/copilot")],
    loginCommand: "copilot",
    detectionCommand: "copilot",
  },
};

const NPM_MIRROR = "https://registry.npmmirror.com";
const STEP_TIMEOUT_MS = 15 * 60_000;
/** A visible install window may wait on the person; give it longer. */
const WINDOW_TIMEOUT_MS = 40 * 60_000;
const LOG_LIMIT = 6_000;
const WINGET_PACKAGES = { node: "OpenJS.NodeJS.LTS", git: "Git.Git" } as const;

export interface CommandResult {
  readonly code: number | null;
  readonly output: string;
}

export interface CommandRunner {
  run(
    command: string,
    args: readonly string[],
    options: { environment: NodeJS.ProcessEnv; shell: boolean; timeoutMs: number },
  ): Promise<CommandResult>;
  /** Opens a visible terminal running `command` (for an agent's own sign-in). */
  openTerminal(command: string, environment: NodeJS.ProcessEnv): Promise<boolean>;
  /**
   * Runs a PowerShell command in a visible window the person can answer prompts in, and resolves
   * with its exit code and transcript once the window closes. Windows only.
   */
  runInWindow?(
    command: string,
    options: { environment: NodeJS.ProcessEnv; timeoutMs: number },
  ): Promise<CommandResult>;
}

/**
 * The script a visible install window runs: the vendor's own installer, with its prompts answered
 * by the person, recorded to `logFile` so the Hub can show what happened.
 */
export function installWindowScript(command: string, logFile: string, codeFile: string): string {
  const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
  return [
    "$Host.UI.RawUI.WindowTitle = 'RLY/0 Hub - 安装'",
    `try { Start-Transcript -LiteralPath ${quote(logFile)} -Force | Out-Null } catch {}`,
    "Write-Host 'RLY/0 Hub 正在运行官方安装程序。如果下面有提问，请直接在这个窗口里回答。' -ForegroundColor Cyan",
    "Write-Host ''",
    POWERSHELL_PRELUDE,
    "$rly0Code = 0",
    `try { ${command}; if ($LASTEXITCODE) { $rly0Code = $LASTEXITCODE } } catch { Write-Host $_ -ForegroundColor Red; $rly0Code = 1 }`,
    "try { Stop-Transcript | Out-Null } catch {}",
    `try { Set-Content -LiteralPath ${quote(codeFile)} -Value $rly0Code } catch {}`,
    "Write-Host ''",
    "if ($rly0Code -eq 0) { Write-Host '安装程序已结束，窗口马上关闭。' -ForegroundColor Green; Start-Sleep -Seconds 3 }",
    "else { Write-Host '安装程序报错了，原因见上方。按回车关闭窗口，RLY/0 Hub 里也能看到这段日志。' -ForegroundColor Yellow; try { [void](Read-Host) } catch {} }",
    "exit $rly0Code",
  ].join("\r\n");
}

/** Start-Transcript writes UTF-16 or UTF-8 depending on the Windows version. */
export function decodeTranscript(bytes: Buffer): string {
  const text =
    bytes[0] === 0xff && bytes[1] === 0xfe
      ? bytes.subarray(2).toString("utf16le")
      : bytes.toString("utf8").replace(/^\uFEFF/u, "");
  const lines = text.split(/\r?\n/u);
  // Header and footer are fenced by lines of asterisks; keep only what ran in between.
  const fences = lines.flatMap((line, index) => (/^\*{6,}$/u.test(line) ? [index] : []));
  const body =
    fences[1] !== undefined
      ? lines.slice(fences[1] + 1, fences[2] ?? lines.length)
      : lines.filter((line) => !/^\*{6,}$/u.test(line));
  return body
    .filter((line) => !/^(Transcript started|已启动脚本)/u.test(line))
    .join("\n")
    .trim();
}

/** Length of an incomplete UTF-8 sequence at the end of `bytes` (0 when it ends cleanly). */
function incompleteUtf8Tail(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return needed > back ? back : 0;
  }
  return 0;
}

/**
 * Decodes installer output chunk by chunk: UTF-8 when it is valid, otherwise the Chinese Windows
 * console code page (GBK/GB18030), which cmd.exe and many native tools still write when their
 * output is piped. Without this, localized errors such as “拒绝访问” arrive garbled and are
 * neither readable in the log nor classifiable.
 */
export function createOutputDecoder(): { write(chunk: Uint8Array): string; end(): string } {
  const utf8 = new TextDecoder("utf-8", { fatal: true });
  let carry: Uint8Array = new Uint8Array(0);
  const legacy = (bytes: Uint8Array): string => {
    try {
      return new TextDecoder("gb18030").decode(bytes);
    } catch {
      return Buffer.from(bytes).toString("utf8");
    }
  };
  return {
    write(chunk) {
      const bytes = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk;
      const cut = incompleteUtf8Tail(bytes);
      try {
        const text = utf8.decode(bytes.subarray(0, bytes.length - cut));
        carry = bytes.slice(bytes.length - cut);
        return text;
      } catch {
        carry = new Uint8Array(0);
        return legacy(bytes);
      }
    },
    end() {
      const rest = carry;
      carry = new Uint8Array(0);
      if (rest.length === 0) return "";
      try {
        return utf8.decode(rest);
      } catch {
        return legacy(rest);
      }
    },
  };
}

/** winget and other HRESULT-style exit codes read better in hex. */
function formatExitCode(code: number | null): string {
  if (code === null) return "无（未启动或超时）";
  return code < 0 ? `0x${(code >>> 0).toString(16).toUpperCase()}` : String(code);
}

/** Proxy URLs may carry a user name and password; the log only says which host is used. */
function describeProxy(environment: NodeJS.ProcessEnv): string {
  const value = environment.HTTPS_PROXY ?? environment.https_proxy ?? environment.HTTP_PROXY;
  if (!value) return "系统代理设置";
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "自定义代理";
  }
}

function killTree(child: ReturnType<typeof spawn>): void {
  // On Windows `kill` stops only the direct child (cmd.exe for npm), not the installer below it.
  if (process.platform === "win32" && child.pid !== undefined) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => child.kill());
      return;
    } catch {
      // Fall through to a plain kill.
    }
  }
  child.kill();
}

/**
 * `start "<title>" [/wait] <program> <args>` for cmd.exe, quoted the way cmd expects. Only fixed
 * program paths and fixed commands reach here (never text the person typed).
 */
export function startCommandLine(program: string, args: readonly string[], wait: boolean): string {
  const quote = (value: string): string => (/[\s&()^|<>]/u.test(value) ? `"${value}"` : value);
  return [
    "start",
    '"RLY0 Hub"',
    ...(wait ? ["/wait"] : []),
    `"${program}"`,
    ...args.map(quote),
  ].join(" ");
}

export const processRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const decoders = { stdout: createOutputDecoder(), stderr: createOutputDecoder() };
      const append = (text: string): void => {
        output = `${output}${text}`.slice(-LOG_LIMIT * 4);
      };
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        append(decoders.stdout.end() + decoders.stderr.end());
        resolve({ code, output });
      };
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(command, [...args], {
          env: options.environment,
          shell: options.shell,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        resolve({ code: null, output: error instanceof Error ? error.message : String(error) });
        return;
      }
      const timer = setTimeout(() => {
        append(`\n[RLY/0 Hub] 超时（${Math.round(options.timeoutMs / 60_000)} 分钟），已停止。`);
        killTree(child);
        finish(null);
      }, options.timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => append(decoders.stdout.write(chunk)));
      child.stderr?.on("data", (chunk: Buffer) => append(decoders.stderr.write(chunk)));
      child.on("error", (error) => {
        append(`\n${error.message}`);
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  },
  async runInWindow(command, options) {
    if (process.platform !== "win32") return { code: null, output: "WINDOW_UNSUPPORTED" };
    const directory = await mkdtemp(path.join(tmpdir(), "rly0-install-"));
    const scriptFile = path.join(directory, "install.ps1");
    const logFile = path.join(directory, "install.log");
    const codeFile = path.join(directory, "exit-code.txt");
    try {
      // PowerShell 5.1 reads a script without a BOM in the ANSI code page.
      await writeFile(
        scriptFile,
        `\uFEFF${installWindowScript(command, logFile, codeFile)}`,
        "utf8",
      );
      const powershell = path.join(
        options.environment.SystemRoot ?? options.environment.windir ?? "C:\\Windows",
        "System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      );
      const code = await new Promise<number | null>((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          // `start /wait` opens a new console window and waits until it closes.
          child = spawn(
            "cmd.exe",
            [
              "/d",
              "/s",
              "/c",
              `"${startCommandLine(powershell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile], true)}"`,
            ],
            {
              env: options.environment,
              windowsHide: true,
              stdio: "ignore",
              // cmd does not understand Node's \" escaping; the line is built for cmd itself.
              windowsVerbatimArguments: true,
            },
          );
        } catch {
          resolve(null);
          return;
        }
        const timer = setTimeout(() => {
          killTree(child);
          resolve(null);
        }, options.timeoutMs);
        child.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.on("close", (exit) => {
          clearTimeout(timer);
          resolve(exit);
        });
      });
      // `start /wait` does not pass the exit code on. The wrapper writes it; a vendor script that
      // calls `exit` itself leaves no file, which counts as a failure unless the agent is found.
      let exitCode: number | null = code === null ? null : 1;
      try {
        const written = Number.parseInt((await readFile(codeFile, "utf8")).trim(), 10);
        if (Number.isFinite(written)) exitCode = written;
      } catch {
        // No file: the script ended early.
      }
      let output: string;
      try {
        output = decodeTranscript(await readFile(logFile));
      } catch {
        output = "（安装窗口没有留下日志）";
      }
      return { code: exitCode, output: output.slice(-LOG_LIMIT * 4) };
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  },
  openTerminal(command, environment) {
    // Windows only for now; elsewhere the page shows the command to run instead.
    if (process.platform !== "win32") return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const child = spawn(
          "cmd.exe",
          ["/d", "/s", "/c", `"${startCommandLine("cmd.exe", ["/k", command], false)}"`],
          {
            env: environment,
            windowsHide: true,
            detached: true,
            stdio: "ignore",
            windowsVerbatimArguments: true,
          },
        );
        child.on("error", () => resolve(false));
        child.unref();
        setTimeout(() => resolve(true), 300);
      } catch {
        resolve(false);
      }
    });
  },
};

/** Turns an installer's output into a reason a person can act on. */
export function classifyInstallFailure(
  output: string,
): NonNullable<Rly0AgentInstallStatus["error"]> {
  if (
    /supported-countries|not available in your region|unexpected content|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket hang up|unable to connect|could not be resolved|remote name could not be resolved|underlying connection was closed|error occurred on a send|could not establish (?:secure channel|trust relationship)|SSL\/TLS|certificate|远程名称无法解析|未能解析此远程名称|无法连接|基础连接已经关闭|发送时发生错误|无法建立|操作超时|timed out|network/iu.test(
      output,
    )
  ) {
    return "NETWORK";
  }
  if (
    /EACCES|EPERM|access is denied|拒绝访问|administrator|elevation|需要管理员|管理员权限|running scripts is disabled|禁止运行脚本|not digitally signed/iu.test(
      output,
    )
  ) {
    return "PERMISSION";
  }
  return "FAILED";
}

function requirementReasonOf(
  result: CommandResult,
): NonNullable<Rly0AgentInstallStatus["requirementReason"]> {
  if (result.code === 0) return "NOT_DETECTED";
  const kind = classifyInstallFailure(result.output);
  return kind === "NETWORK" ? "NETWORK" : kind === "PERMISSION" ? "PERMISSION" : "INSTALL_FAILED";
}

const defaultFiles: InstallerFiles = {
  makeTempDirectory: () => mkdtemp(path.join(tmpdir(), "rly0-node-")),
  read: (file) => readFile(file),
  remove: (target) => rm(target, { recursive: true, force: true }),
};

export interface AgentInstallerOptions {
  readonly environment: NodeJS.ProcessEnv;
  /** Environment for downloads, with RLY/0 Hub's proxy settings applied. */
  readonly downloadEnvironment?: () => NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly runner?: CommandRunner;
  readonly fileExists?: (file: string) => boolean;
  /** Temporary files for the Node.js MSI fallback. */
  readonly files?: InstallerFiles;
  readonly now?: () => number;
}

interface MutableStatus {
  state: Rly0AgentInstallStatus["state"];
  step?: Rly0AgentInstallStatus["step"];
  error?: Rly0AgentInstallStatus["error"];
  requirementReason?: Rly0AgentInstallStatus["requirementReason"];
  log: string;
  startedAt?: number;
  finishedAt?: number;
  manualUrl?: string;
}

export class AgentInstaller {
  readonly #options: AgentInstallerOptions;
  readonly #status = new Map<string, MutableStatus>();
  #refreshedPath = "";

  constructor(options: AgentInstallerOptions) {
    this.#options = options;
  }

  get #platform(): NodeJS.Platform {
    return this.#options.platform ?? process.platform;
  }

  get #runner(): CommandRunner {
    return this.#options.runner ?? processRunner;
  }

  get #fileExists(): (file: string) => boolean {
    return this.#options.fileExists ?? fileOrAliasExists;
  }

  #now(): number {
    return (this.#options.now ?? Date.now)();
  }

  #has(command: string, environment: NodeJS.ProcessEnv): boolean {
    return commandExists(command, environment, this.#platform, this.#fileExists);
  }

  #environment(): NodeJS.ProcessEnv {
    return this.#options.downloadEnvironment?.() ?? this.#options.environment;
  }

  #powershell(environment: NodeJS.ProcessEnv): string {
    return windowsSystemTool(
      environment,
      "WindowsPowerShell\\v1.0\\powershell.exe",
      this.#fileExists,
    );
  }

  status(agent: string): Rly0AgentInstallStatus {
    const recipe = RLY0_AGENT_RECIPES[agent];
    const current = this.#status.get(agent);
    return {
      state: current?.state ?? "idle",
      automatic: Boolean(recipe && recipe.attempts.length > 0),
      ...(recipe?.loginCommand ? { canOpenLogin: true } : {}),
      ...(current?.step ? { step: current.step } : {}),
      ...(current?.error ? { error: current.error } : {}),
      ...(current?.requirementReason ? { requirementReason: current.requirementReason } : {}),
      ...(current?.log ? { log: current.log.slice(-LOG_LIMIT) } : {}),
      ...(current?.startedAt ? { startedAt: current.startedAt } : {}),
      ...(current?.finishedAt ? { finishedAt: current.finishedAt } : {}),
      ...((current?.manualUrl ?? recipe?.manualUrl)
        ? { manualUrl: current?.manualUrl ?? recipe?.manualUrl }
        : {}),
    };
  }

  /** Starts installing in the background; poll `status` for progress. */
  start(agent: string): Rly0AgentInstallStatus {
    const recipe = RLY0_AGENT_RECIPES[agent];
    if (!recipe) return { state: "failed", automatic: false, error: "UNSUPPORTED" };
    const current = this.#status.get(agent);
    if (current?.state === "running") return this.status(agent);
    if (recipe.attempts.length === 0) {
      this.#status.set(agent, {
        state: "failed",
        error: "MANUAL",
        log: "",
        ...(recipe.manualUrl ? { manualUrl: recipe.manualUrl } : {}),
      });
      return this.status(agent);
    }
    const status: MutableStatus = { state: "running", log: "", startedAt: this.#now() };
    this.#status.set(agent, status);
    this.#append(
      status,
      `[RLY/0 Hub] 安装 ${agent}（${this.#platform}，网络：${describeProxy(this.#environment())}）`,
    );
    void this.#install(recipe, status)
      .then((ok) => {
        status.state = ok ? "succeeded" : "failed";
      })
      .catch((error: unknown) => {
        status.state = "failed";
        status.error ??= "FAILED";
        this.#append(status, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        status.finishedAt = this.#now();
        delete status.step;
        this.#append(
          status,
          status.state === "succeeded"
            ? "[RLY/0 Hub] 安装完成。"
            : `[RLY/0 Hub] 安装失败（${[status.error, status.requirementReason].filter(Boolean).join(" / ")}）。`,
        );
      });
    return this.status(agent);
  }

  async openLogin(agent: string): Promise<boolean> {
    const command = RLY0_AGENT_RECIPES[agent]?.loginCommand;
    if (!command) return false;
    return this.#runner.openTerminal(command, this.#withKnownPaths(this.#options.environment));
  }

  #append(status: MutableStatus, text: string): void {
    if (!text) return;
    status.log = `${status.log}${text.endsWith("\n") ? text : `${text}\n`}`.slice(-LOG_LIMIT * 2);
  }

  /** Runs one step with a readable header, exit code and duration in the log. */
  async #step(
    status: MutableStatus,
    label: string,
    command: string,
    args: readonly string[],
    options: { environment: NodeJS.ProcessEnv; shell: boolean; timeoutMs: number },
  ): Promise<CommandResult> {
    this.#append(status, `[RLY/0 Hub] ${label}`);
    const started = this.#now();
    const result = await this.#runner.run(command, args, options);
    this.#append(status, result.output.trim());
    const seconds = Math.max(0, Math.round((this.#now() - started) / 1000));
    this.#append(status, `[RLY/0 Hub] 退出码 ${formatExitCode(result.code)}，用时 ${seconds} 秒`);
    return result;
  }

  async #install(recipe: Recipe, status: MutableStatus): Promise<boolean> {
    for (const requirement of recipe.requires ?? []) {
      if (!(await this.#ensureRequirement(requirement, status))) return false;
    }
    let lastOutput = "";
    for (const attempt of recipe.attempts) {
      const result =
        attempt.kind === "script"
          ? await this.#runScript(attempt, status)
          : await this.#runNpm(attempt, status);
      // Vendor scripts sometimes end with a stale non-zero code although the agent is installed.
      const ok = result.code === 0 || (await this.#detected(recipe));
      if (ok && result.code !== 0) {
        this.#append(status, "[RLY/0 Hub] 已检测到装好的命令，按安装成功处理。");
      }
      if (ok) {
        delete status.error;
        delete status.requirementReason;
        return true;
      }
      lastOutput = result.output;
    }
    status.error =
      status.error === "NODE_MISSING" ? status.error : classifyInstallFailure(lastOutput);
    return false;
  }

  #pathReadAt = 0;

  /**
   * The environment to look for installed agents in: PATH as Windows has it now (re-read at most
   * every 15 seconds), so an agent installed since the Hub started is found without a restart.
   */
  async searchEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (this.#platform === "win32" && this.#now() - this.#pathReadAt > 15_000) {
      this.#pathReadAt = this.#now();
      await this.#refreshPath().catch(() => undefined);
    }
    return this.#withKnownPaths(this.#options.environment);
  }

  async #detected(recipe: Recipe): Promise<boolean> {
    const command = recipe.detectionCommand;
    if (!command) return false;
    if (this.#has(command, this.#withKnownPaths(this.#environment()))) return true;
    if (this.#platform !== "win32") return false;
    await this.#refreshPath();
    return this.#has(command, this.#withKnownPaths(this.#environment()));
  }

  /** PATH plus the usual install folders, so freshly installed tools are found right away. */
  #withKnownPaths(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const next = withAgentInstallPaths(environment, this.#platform);
    if (this.#refreshedPath) next.PATH = `${next.PATH ?? ""};${this.#refreshedPath}`;
    return next;
  }

  #npmCommand(environment: NodeJS.ProcessEnv): string | null {
    const known = this.#platform === "win32" ? "C:\\Program Files\\nodejs\\npm.cmd" : null;
    if (this.#has("npm", environment)) return "npm";
    if (known && this.#fileExists(known)) return known;
    return null;
  }

  #hasRequirement(requirement: "node" | "git"): boolean {
    const environment = this.#withKnownPaths(this.#environment());
    return requirement === "node"
      ? this.#npmCommand(environment) !== null && this.#has("node", environment)
      : this.#has("git", environment);
  }

  /**
   * Machine and user PATH as Windows has them now. Installers update the registry, but a running
   * process (and everything it starts) keeps the PATH it was born with.
   */
  async #refreshPath(): Promise<void> {
    const environment = this.#withKnownPaths(this.#environment());
    const refreshed = await this.#runner.run(
      this.#powershell(environment),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))",
      ],
      { environment, shell: false, timeoutMs: 20_000 },
    );
    if (refreshed.code === 0) this.#refreshedPath = refreshed.output.trim();
  }

  async #ensureRequirement(requirement: "node" | "git", status: MutableStatus): Promise<boolean> {
    if (this.#hasRequirement(requirement)) return true;
    const name = requirement === "node" ? "Node.js" : "Git";
    status.step = requirement === "node" ? "installingNode" : "installingGit";
    const fail = (reason: NonNullable<Rly0AgentInstallStatus["requirementReason"]>): false => {
      status.error = requirement === "node" ? "NODE_MISSING" : "GIT_MISSING";
      status.requirementReason = reason;
      return false;
    };
    if (this.#platform !== "win32") {
      this.#append(status, `没有找到 ${name}，请手动安装后重试。`);
      return fail("WINGET_UNAVAILABLE");
    }
    const environment = this.#withKnownPaths(this.#environment());
    // winget is an app execution alias in %LOCALAPPDATA%\Microsoft\WindowsApps, which a service
    // started without a console often lacks on PATH; the known folders above include it.
    const winget = findCommand("winget", environment, this.#platform, this.#fileExists);
    let reason: NonNullable<Rly0AgentInstallStatus["requirementReason"]> = "WINGET_UNAVAILABLE";
    if (winget) {
      const result = await this.#step(
        status,
        `用 winget 安装 ${name}（Windows 可能请求管理员授权）`,
        winget,
        [
          "install",
          "--id",
          WINGET_PACKAGES[requirement],
          "-e",
          "--source",
          "winget",
          "--silent",
          "--accept-package-agreements",
          "--accept-source-agreements",
          "--disable-interactivity",
        ],
        { environment, shell: false, timeoutMs: STEP_TIMEOUT_MS },
      );
      if (!this.#hasRequirement(requirement)) await this.#refreshPath();
      if (this.#hasRequirement(requirement)) return true;
      reason = requirementReasonOf(result);
      this.#append(status, `winget 没有装好 ${name}。`);
    } else {
      this.#append(status, "没有找到 winget（Windows“应用安装程序”）。");
    }
    if (requirement === "git") {
      this.#append(status, "请从 https://git-scm.com 手动安装 Git 后重试。");
      return fail(reason);
    }
    const outcome = await installNodeFromMsi({
      runner: this.#runner,
      environment,
      powershell: this.#powershell(environment),
      msiexec: windowsSystemTool(environment, "msiexec.exe", this.#fileExists),
      arch: windowsNodeArch(environment),
      files: this.#options.files ?? defaultFiles,
      log: (text) => this.#append(status, text),
    });
    if (outcome.ok) {
      if (!this.#hasRequirement("node")) await this.#refreshPath();
      if (this.#hasRequirement("node")) return true;
      this.#append(status, "Node.js 已安装，但还找不到 node/npm；重启 RLY/0 Hub 后重试。");
      return fail("NOT_DETECTED");
    }
    return fail(outcome.reason);
  }

  async #runScript(
    attempt: Extract<Attempt, { kind: "script" }>,
    status: MutableStatus,
  ): Promise<CommandResult> {
    status.step = "officialInstaller";
    const environment = this.#withKnownPaths(this.#environment());
    if (this.#platform === "win32" && this.#runner.runInWindow) {
      // Official scripts ask questions (install Node? add to PATH?) that a hidden run cannot
      // answer, so they run in a window the person can see and type in.
      status.step = "installerWindow";
      this.#append(status, `[RLY/0 Hub] 在新窗口运行官方安装脚本：${attempt.windows}`);
      const started = this.#now();
      const result = await this.#runner.runInWindow(attempt.windows, {
        environment,
        timeoutMs: WINDOW_TIMEOUT_MS,
      });
      this.#append(status, result.output.trim());
      const seconds = Math.max(0, Math.round((this.#now() - started) / 1000));
      this.#append(status, `[RLY/0 Hub] 退出码 ${formatExitCode(result.code)}，用时 ${seconds} 秒`);
      return result;
    }
    if (this.#platform === "win32") {
      return this.#step(
        status,
        `运行官方安装脚本：${attempt.windows}`,
        this.#powershell(environment),
        powershellArguments(attempt.windows),
        { environment, shell: false, timeoutMs: STEP_TIMEOUT_MS },
      );
    }
    return this.#step(status, `运行官方安装脚本：${attempt.posix}`, "sh", ["-c", attempt.posix], {
      environment,
      shell: false,
      timeoutMs: STEP_TIMEOUT_MS,
    });
  }

  async #runNpm(
    attempt: Extract<Attempt, { kind: "npm" }>,
    status: MutableStatus,
  ): Promise<CommandResult> {
    if (!(await this.#ensureRequirement("node", status)))
      return { code: null, output: "NODE_MISSING" };
    const environment = this.#withKnownPaths(this.#environment());
    const npmCommand = this.#npmCommand(environment);
    if (!npmCommand) {
      status.error = "NODE_MISSING";
      return { code: null, output: "npm is not available" };
    }
    const windows = this.#platform === "win32";
    // npm is a .cmd on Windows, which needs a shell; the quoted command keeps spaces intact.
    const run = (registry?: string) =>
      this.#step(
        status,
        `npm install -g ${attempt.packageName}${registry ? `（镜像 ${registry}）` : ""}`,
        windows ? `"${npmCommand}"` : npmCommand,
        ["install", "-g", attempt.packageName, ...(registry ? [`--registry=${registry}`] : [])],
        { environment, shell: windows, timeoutMs: STEP_TIMEOUT_MS },
      );
    status.step = "npm";
    const first = await run();
    if (first.code === 0) return first;
    // The public registry is often slow or blocked in mainland China; retry through the mirror.
    status.step = "npmMirror";
    return run(NPM_MIRROR);
  }
}
