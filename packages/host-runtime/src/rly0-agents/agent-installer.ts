import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { Rly0AgentInstallStatus } from "@codexhost/shared-contracts";

import { commandExists } from "./claude-code-auth.js";
import { withAgentInstallPaths } from "./install-paths.js";

/**
 * One-click installation of native agents. Each agent has a recipe: the vendor's official
 * installer (the same command the Connections page shows), npm for npm-distributed agents, and the
 * prerequisites they need (Node.js, Git), installed with Windows' own winget when missing. Commands
 * are fixed literals; nothing the person types is executed.
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
    loginCommand: "hermes",
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
};

const NPM_MIRROR = "https://registry.npmmirror.com";
const STEP_TIMEOUT_MS = 15 * 60_000;
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
}

export const processRunner: CommandRunner = {
  run(command, args, options) {
    return new Promise((resolve) => {
      let output = "";
      let settled = false;
      const finish = (code: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
        output += "\n[RLY/0 Hub] step timed out";
        child.kill();
        finish(null);
      }, options.timeoutMs);
      const collect = (chunk: Buffer | string): void => {
        output = `${output}${chunk.toString()}`.slice(-LOG_LIMIT * 4);
      };
      child.stdout?.on("data", collect);
      child.stderr?.on("data", collect);
      child.on("error", (error) => {
        output += `\n${error.message}`;
        finish(null);
      });
      child.on("close", (code) => finish(code));
    });
  },
  openTerminal(command, environment) {
    // Windows only for now; elsewhere the page shows the command to run instead.
    if (process.platform !== "win32") return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        const child = spawn("cmd.exe", ["/c", "start", '"RLY/0 Hub"', "cmd.exe", "/k", command], {
          env: environment,
          windowsHide: false,
          detached: true,
          stdio: "ignore",
        });
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
    /supported-countries|not available in your region|unexpected content|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|unable to connect|could not be resolved|远程名称无法解析|无法连接|操作超时|timed out|network/iu.test(
      output,
    )
  ) {
    return "NETWORK";
  }
  if (/EACCES|EPERM|access is denied|拒绝访问|administrator/iu.test(output)) return "PERMISSION";
  return "FAILED";
}

export interface AgentInstallerOptions {
  readonly environment: NodeJS.ProcessEnv;
  /** Environment for downloads, with RLY/0 Hub's proxy settings applied. */
  readonly downloadEnvironment?: () => NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly runner?: CommandRunner;
  readonly fileExists?: (file: string) => boolean;
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

  #exists(file: string): boolean {
    return (this.#options.fileExists ?? existsSync)(file);
  }

  #environment(): NodeJS.ProcessEnv {
    return this.#options.downloadEnvironment?.() ?? this.#options.environment;
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
    const now = this.#options.now ?? Date.now;
    const status: MutableStatus = { state: "running", log: "", startedAt: now() };
    this.#status.set(agent, status);
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
        status.finishedAt = now();
        delete status.step;
      });
    return this.status(agent);
  }

  async openLogin(agent: string): Promise<boolean> {
    const command = RLY0_AGENT_RECIPES[agent]?.loginCommand;
    if (!command) return false;
    return this.#runner.openTerminal(command, this.#withKnownPaths(this.#options.environment));
  }

  #append(status: MutableStatus, text: string): void {
    status.log = `${status.log}${text.endsWith("\n") ? text : `${text}\n`}`.slice(-LOG_LIMIT * 2);
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
      if (result.code === 0) {
        delete status.error;
        return true;
      }
      lastOutput = result.output;
    }
    status.error =
      status.error === "NODE_MISSING" ? status.error : classifyInstallFailure(lastOutput);
    return false;
  }

  /** PATH plus the usual install folders, so freshly installed tools are found right away. */
  #withKnownPaths(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const next = withAgentInstallPaths(environment, this.#platform);
    if (this.#refreshedPath) next.PATH = `${next.PATH ?? ""};${this.#refreshedPath}`;
    return next;
  }

  #npmCommand(environment: NodeJS.ProcessEnv): string | null {
    const known = this.#platform === "win32" ? "C:\\Program Files\\nodejs\\npm.cmd" : null;
    if (commandExists("npm", environment, this.#platform, this.#options.fileExists)) return "npm";
    if (known && this.#exists(known)) return known;
    return null;
  }

  async #ensureRequirement(requirement: "node" | "git", status: MutableStatus): Promise<boolean> {
    const environment = this.#withKnownPaths(this.#environment());
    const present =
      requirement === "node"
        ? this.#npmCommand(environment) !== null &&
          commandExists("node", environment, this.#platform, this.#options.fileExists)
        : commandExists("git", environment, this.#platform, this.#options.fileExists);
    if (present) return true;
    status.step = requirement === "node" ? "installingNode" : "installingGit";
    if (
      this.#platform !== "win32" ||
      !commandExists("winget", environment, this.#platform, this.#options.fileExists)
    ) {
      status.error = requirement === "node" ? "NODE_MISSING" : "GIT_MISSING";
      status.requirementReason = "WINGET_UNAVAILABLE";
      this.#append(status, "系统没有可用的 winget，无法自动安装依赖。请手动安装后重试。");
      return false;
    }
    const result = await this.#runner.run(
      "winget",
      [
        "install",
        "--id",
        WINGET_PACKAGES[requirement],
        "-e",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
      { environment, shell: false, timeoutMs: STEP_TIMEOUT_MS },
    );
    this.#append(status, result.output);
    // Refresh only PATH (not credentials or other environment values) when winget used a
    // nonstandard destination. Existing processes do not inherit registry PATH updates.
    const known = this.#withKnownPaths(this.#environment());
    if (!commandExists(requirement, known, this.#platform, this.#options.fileExists)) {
      const refreshed = await this.#runner.run(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "([Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User'))",
        ],
        { environment: known, shell: false, timeoutMs: 10_000 },
      );
      if (refreshed.code === 0) this.#refreshedPath = refreshed.output.trim();
    }
    const installed =
      requirement === "node"
        ? this.#npmCommand(this.#withKnownPaths(this.#environment())) !== null &&
          commandExists(
            "node",
            this.#withKnownPaths(this.#environment()),
            this.#platform,
            this.#options.fileExists,
          )
        : commandExists(
            "git",
            this.#withKnownPaths(this.#environment()),
            this.#platform,
            this.#options.fileExists,
          );
    if (installed) return true;
    status.requirementReason =
      result.code === 0
        ? "NOT_DETECTED"
        : classifyInstallFailure(result.output) === "NETWORK"
          ? "NETWORK"
          : classifyInstallFailure(result.output) === "PERMISSION"
            ? "PERMISSION"
            : "INSTALL_FAILED";
    status.error = requirement === "node" ? "NODE_MISSING" : "GIT_MISSING";
    return false;
  }

  async #runScript(
    attempt: Extract<Attempt, { kind: "script" }>,
    status: MutableStatus,
  ): Promise<CommandResult> {
    status.step = "officialInstaller";
    const environment = this.#withKnownPaths(this.#environment());
    const result =
      this.#platform === "win32"
        ? await this.#runner.run(
            "powershell.exe",
            [
              "-NoProfile",
              "-NonInteractive",
              "-ExecutionPolicy",
              "Bypass",
              "-Command",
              attempt.windows,
            ],
            { environment, shell: false, timeoutMs: STEP_TIMEOUT_MS },
          )
        : await this.#runner.run("sh", ["-c", attempt.posix], {
            environment,
            shell: false,
            timeoutMs: STEP_TIMEOUT_MS,
          });
    this.#append(status, result.output);
    return result;
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
    const run = (registry?: string) =>
      this.#runner.run(
        windows ? `"${npmCommand}"` : npmCommand,
        ["install", "-g", attempt.packageName, ...(registry ? [`--registry=${registry}`] : [])],
        { environment, shell: windows, timeoutMs: STEP_TIMEOUT_MS },
      );
    status.step = "npm";
    const first = await run();
    this.#append(status, first.output);
    if (first.code === 0) return first;
    // The public registry is often slow or blocked in mainland China; retry through the mirror.
    status.step = "npmMirror";
    const mirrored = await run(NPM_MIRROR);
    this.#append(status, mirrored.output);
    return mirrored;
  }
}
