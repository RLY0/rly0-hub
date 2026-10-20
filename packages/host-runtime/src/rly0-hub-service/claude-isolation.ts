import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import path from "node:path";
import {
  listDockerSandboxes,
  readSandboxSettings,
  resolveSandboxCommand,
  runSandboxCommand,
  sameProject,
  sandboxEnvironment,
  SANDBOX_DENIED_NETWORKS,
  SANDBOX_GUEST_GUARD,
  validateSandboxProject,
  verifySandboxProxy,
  verifySandboxWorkspace,
  writeSandboxSettings,
} from "@codexhost/sandbox-runtime";
import { sandboxConfigureSchema, type SandboxSettings } from "@codexhost/shared-contracts";
import { processRunner } from "../rly0-agents/agent-installer.js";
import { commandExists } from "../rly0-agents/claude-code-auth.js";
import { powershellQuote, withAgentInstallPaths } from "../rly0-agents/install-paths.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { IsolationLogin } from "./isolation-login.js";

export interface IsolationJob {
  phase: "idle" | "installing" | "preparing" | "succeeded" | "failed" | "cancelled";
  error?: string;
}

/** Owns setup intent; all displayed readiness comes from a fresh Docker/Claude query. */
export class ClaudeIsolation {
  #job: IsolationJob = { phase: "idle" };
  #generation = 0;
  #mutating = false;
  readonly #logins: IsolationLogin;
  constructor(
    readonly environment: NodeJS.ProcessEnv,
    readonly platform = process.platform,
    options: { openUrl?: (url: string) => void } = {},
  ) {
    this.#logins = new IsolationLogin({
      environment,
      openUrl:
        options.openUrl ??
        (() => {
          throw new Error("BROWSER_UNAVAILABLE");
        }),
      resolve: (project) => this.#resolveLogin(project),
      loggedIn: async (binding) => {
        await this.#resolveLogin(binding.project.project);
        const output = await runSandboxCommand(
          environment,
          binding.settings,
          [
            "exec",
            "-u",
            "agent",
            binding.project.name,
            "/home/agent/.local/bin/claude",
            "auth",
            "status",
            "--json",
          ],
          20000,
          [1],
        );
        return (JSON.parse(output) as { loggedIn?: boolean }).loggedIn === true;
      },
    });
  }

  #settings(): SandboxSettings {
    const settings = readSandboxSettings(this.environment);
    if (!settings) throw new Error("ISOLATION_NOT_CONFIGURED");
    return settings;
  }
  #supported(): void {
    if (this.platform !== "win32") throw new Error("ISOLATION_WINDOWS_ONLY");
  }
  #idle(): void {
    this.#supported();
    if (
      this.#mutating ||
      this.#logins.active ||
      ["installing", "preparing"].includes(this.#job.phase)
    )
      throw new Error("ISOLATION_BUSY");
  }

  async status() {
    let settings: SandboxSettings | null;
    try {
      settings = readSandboxSettings(this.environment);
    } catch {
      return {
        supported: this.platform === "win32",
        error: "ISOLATION_CONFIG_INVALID",
        job: this.#job,
        login: this.#logins.status(),
      };
    }
    let dockerInstalled = false;
    try {
      resolveSandboxCommand(this.environment);
      dockerInstalled = true;
    } catch {
      /* prerequisite absent */
    }
    const result = {
      supported: this.platform === "win32",
      dockerInstalled,
      localClaudeInstalled: commandExists(
        "claude",
        withAgentInstallPaths(this.environment, this.platform),
        this.platform,
      ),
      settings,
      defaultRuntimeRoot: path.join(resolveRly0DataDir(this.environment), "sandbox-runtime"),
      suggestedProxy: this.#suggestProxy(),
      job: this.#job,
      login: this.#logins.status(),
    };
    if (!settings || !dockerInstalled || this.platform !== "win32") return result;
    try {
      const sandboxes = await listDockerSandboxes(this.environment, settings);
      let networkError: string | null = null;
      try {
        await verifySandboxProxy(this.environment, settings);
      } catch (error) {
        networkError = (error as Error).message;
      }
      const projects = await Promise.all(
        settings.projects.map(async (project) => {
          try {
            const box = verifySandboxWorkspace(sandboxes, project);
            const login = this.#logins.status();
            if (this.#logins.active && login.project && sameProject(login.project, project.project))
              return { ...project, loggedIn: null, error: null };
            if (box.status !== "running") return { ...project, loggedIn: null, error: null };
            // Auth status contains no tokens. Never import Windows credentials into the microVM.
            const output = await runSandboxCommand(
              this.environment,
              settings,
              [
                "exec",
                "-u",
                "agent",
                box.name,
                "/home/agent/.local/bin/claude",
                "auth",
                "status",
                "--json",
              ],
              20000,
              [1],
            );
            const auth = JSON.parse(output) as { loggedIn?: boolean };
            return { ...project, loggedIn: auth.loggedIn === true, error: null };
          } catch {
            return { ...project, loggedIn: false, error: "ISOLATION_PROJECT_UNAVAILABLE" };
          }
        }),
      );
      return {
        ...result,
        sandboxes: sandboxes.filter((box) => box.agent === "claude"),
        projects,
        networkError,
      };
    } catch {
      return { ...result, error: "ISOLATION_DOCKER_UNAVAILABLE" };
    }
  }

  #suggestProxy(): string {
    for (const value of [
      this.environment.HTTPS_PROXY,
      this.environment.HTTP_PROXY,
      this.environment.ALL_PROXY,
    ]) {
      if (value && sandboxConfigureSchema.shape.proxy.safeParse(value).success) return value;
    }
    return "";
  }

  async configure(input: { enabled: boolean; runtimeRoot: string; proxy: string }) {
    this.#idle();
    this.#mutating = true;
    try {
      const parsed = sandboxConfigureSchema.parse(input);
      if (!path.isAbsolute(parsed.runtimeRoot)) throw new Error("ISOLATION_RUNTIME_ROOT_INVALID");
      const old = readSandboxSettings(this.environment);
      const changedRoot = old && !sameProject(old.runtimeRoot, parsed.runtimeRoot);
      if (changedRoot && old.projects.length) throw new Error("ISOLATION_RUNTIME_HAS_PROJECTS");
      const settings: SandboxSettings = { version: 1, ...parsed, projects: old?.projects ?? [] };
      if (settings.enabled && settings.projects.length === 0)
        throw new Error("ISOLATION_PROJECT_REQUIRED");
      // This is an explicit setup action, never an implicit mutation during status/launch.
      await runSandboxCommand(this.environment, settings, [
        "settings",
        "set",
        "proxy",
        settings.proxy,
      ]);
      await verifySandboxProxy(this.environment, settings);
      await writeSandboxSettings(this.environment, settings);
      return { ok: true, reloadRequired: true };
    } finally {
      this.#mutating = false;
    }
  }

  prepare(input: { project: string; name?: string | undefined }) {
    this.#idle();
    const settings = this.#settings();
    const generation = ++this.#generation;
    this.#job = { phase: "preparing" };
    void this.#prepare(input, settings, generation)
      .then(() => {
        if (generation === this.#generation) this.#job = { phase: "succeeded" };
      })
      .catch((error: unknown) => {
        if (generation === this.#generation)
          this.#job = {
            phase: "failed",
            error: error instanceof Error ? error.message : "ISOLATION_SETUP_FAILED",
          };
      });
    return { started: true };
  }

  async #prepare(
    input: { project: string; name?: string | undefined },
    settings: SandboxSettings,
    generation: number,
  ) {
    const project = await validateSandboxProject(input.project, this.environment);
    if (
      sameProject(project, settings.runtimeRoot) ||
      !path.relative(project, settings.runtimeRoot).startsWith("..")
    )
      throw new Error("ISOLATION_PROJECT_TOO_BROAD");
    const name =
      input.name ??
      `rly0-claude-${createHash("sha256").update(project.toLowerCase()).digest("hex").slice(0, 12)}`;
    await verifySandboxProxy(this.environment, settings);
    const boxes = await listDockerSandboxes(this.environment, settings);
    if (!boxes.some((box) => box.name === name)) {
      if (input.name) throw new Error("ISOLATION_SANDBOX_NOT_FOUND");
      await runSandboxCommand(
        this.environment,
        settings,
        [
          "create",
          "--name",
          name,
          "--skills",
          "off",
          "--cpus",
          "2",
          "--memory",
          "4g",
          ...SANDBOX_DENIED_NETWORKS.flatMap((network) => ["--deny-network", network]),
          "claude",
          project,
        ],
        300000,
      );
    }
    if (generation !== this.#generation) return;
    const sandbox = verifySandboxWorkspace(await listDockerSandboxes(this.environment, settings), {
      name,
      project,
    });
    // Apply the same guest restriction used on every SDK start. No host firewall changes.
    await runSandboxCommand(this.environment, settings, [
      "exec",
      "-u",
      "root",
      name,
      "python3",
      "-c",
      SANDBOX_GUEST_GUARD,
    ]);
    if (generation !== this.#generation) return;
    this.#mutating = true;
    try {
      await writeSandboxSettings(this.environment, {
        ...settings,
        projects: [
          ...settings.projects.filter((p) => !sameProject(p.project, project)),
          { project, name, id: sandbox.id },
        ],
      });
    } finally {
      this.#mutating = false;
    }
  }

  cancel() {
    if (this.#mutating) throw new Error("ISOLATION_BUSY");
    // Do not claim the Docker daemon cancelled an in-flight image pull. Its eventual result
    // is deliberately not adopted; no project is authorized by a cancelled operation.
    if (this.#job.phase !== "preparing") throw new Error("ISOLATION_NOT_PREPARING");
    ++this.#generation;
    this.#job = { phase: "cancelled" };
    return { ok: true, dockerMayStillBePreparing: true };
  }

  async forget(project: string) {
    this.#idle();
    this.#mutating = true;
    try {
      const settings = this.#settings();
      const projects = settings.projects.filter((p) => !sameProject(project, p.project));
      // Keep protection selected even with no projects: subsequent starts must fail closed.
      await writeSandboxSettings(this.environment, { ...settings, projects });
      return { ok: true, existingSessionsUnaffected: true };
    } finally {
      this.#mutating = false;
    }
  }

  async disable() {
    this.#idle();
    this.#mutating = true;
    try {
      await writeSandboxSettings(this.environment, { ...this.#settings(), enabled: false });
      return { ok: true, reloadRequired: true };
    } finally {
      this.#mutating = false;
    }
  }

  async login(project?: string) {
    this.#supported();
    if (!project)
      return this.#openTerminal(
        resolveSandboxCommand(this.environment),
        ["login"],
        this.#settings(),
      );
    if (this.#mutating || ["installing", "preparing"].includes(this.#job.phase))
      throw new Error("ISOLATION_BUSY");
    return this.#logins.start(project);
  }
  async #resolveLogin(project: string) {
    this.#supported();
    const settings = this.#settings();
    const entry = settings.projects.find((p) => sameProject(p.project, project));
    if (!entry) throw new Error("ISOLATION_PROJECT_NOT_AUTHORIZED");
    verifySandboxWorkspace(await listDockerSandboxes(this.environment, settings), entry);
    await verifySandboxProxy(this.environment, settings);
    return { settings, project: entry, command: resolveSandboxCommand(this.environment) };
  }
  loginSubmit(id: string, code: string) {
    return this.#logins.submit(id, code);
  }
  loginCancel(id: string) {
    return this.#logins.cancel(id);
  }
  loginOpen(id: string) {
    return this.#logins.reopen(id);
  }
  close() {
    this.#logins.close();
  }

  async #openTerminal(command: string, args: string[], settings: SandboxSettings) {
    // cmd.exe has an 8191-character limit. Keep the guest program in a scoped script,
    // and encode only its invocation; never embed credentials or shell-built user text.
    const directory = path.join(resolveRly0DataDir(this.environment), "tmp", "sandbox-login");
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, `login-${randomUUID()}.ps1`);
    const script = `\uFEFFImport-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1')\ntry { & ${powershellQuote(command)} ${args.map(powershellQuote).join(" ")} } finally { Remove-Item -LiteralPath $PSCommandPath -Force -ErrorAction SilentlyContinue }\n`;
    await writeFile(file, script, { mode: 0o600 });
    const encoded = Buffer.from(`& ${powershellQuote(file)}`, "utf16le").toString("base64");
    const opened = await processRunner.openTerminal(
      `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
      sandboxEnvironment(this.environment, settings),
    );
    if (!opened) await unlink(file).catch(() => undefined);
    return { opened };
  }

  install() {
    this.#idle();
    this.#job = { phase: "installing" };
    void processRunner
      .run(
        "winget",
        [
          "install",
          "--id",
          "Docker.sbx",
          "--exact",
          "--source",
          "winget",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ],
        { environment: this.environment, shell: false, timeoutMs: 600000 },
      )
      .then(() => {
        try {
          resolveSandboxCommand(this.environment);
          this.#job = { phase: "succeeded" };
        } catch {
          this.#job = { phase: "failed", error: "ISOLATION_DOCKER_MISSING" };
        }
      })
      .catch(() => {
        this.#job = { phase: "failed", error: "ISOLATION_INSTALL_FAILED" };
      });
    return { started: true };
  }
}
