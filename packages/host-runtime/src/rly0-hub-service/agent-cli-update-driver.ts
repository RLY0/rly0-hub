import type { access } from "node:fs/promises";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  installationVersion,
  newerInstallationVersion,
  npmInstallation,
  resolveHarnessExecutable,
  runInstallationCommand,
  versionFromOutput,
  VERSION_MANAGER_ROOTS,
  type NpmInstallationOptions,
} from "@codexhost/harness-discovery";
import {
  AGENT_CLI_BUSY_METHOD,
  AGENT_CLI_RELEASE_METHOD,
  AGENT_CLI_INSPECT_METHOD,
  agentCliBusyResultSchema,
  harnessInspectionSchema,
  HARNESS_LAUNCH_SETTINGS_GET_METHOD,
  harnessLaunchSettingsSchema,
  type AgentCliUpdateId,
  type AgentCliUpdateError,
} from "@codexhost/shared-contracts";
import { z } from "zod";
import { HarnessLaunchSettingsStore } from "@codexhost/harness-plugin-files";
import { assertCliWritable, cliProcessBusy } from "./agent-cli-update-system.js";
import { RLY0_AGENT_RECIPES } from "../rly0-agents/agent-installer.js";
import type { HubHostRequest } from "./host-console-routes.js";
import { getUpdateJson, type UpdateHttpGet } from "./hub-update-net.js";

/**
 * Official native updaters. claude/kimi/opencode install an exact version (update and rollback);
 * update/hermes can only move to the tool's newest release (no automatic rollback).
 */
export const agentCliNativeUpdaterSchema = z.enum([
  "claude",
  "kimi",
  "opencode",
  "update",
  "hermes",
]);
export type AgentCliNativeUpdater = z.infer<typeof agentCliNativeUpdaterSchema>;
export const agentCliPlanSchema = z.strictObject({
  kind: z.enum(["npm", "script", "native"]),
  executable: z.string().min(1),
  npm: z.string().nullable(),
  prefix: z.string().nullable(),
  packageName: z.string().nullable(),
  // Absent in journals written before native updaters existed.
  updater: agentCliNativeUpdaterSchema.nullable().default(null),
});
// Input type: callers and older journals may omit `updater` (defaults to null).
export type AgentCliPlan = z.input<typeof agentCliPlanSchema>;
/** Whether install(plan, version) can select an exact version, which rollback requires. */
export function agentCliPlanExact(plan: AgentCliPlan): boolean {
  return plan.kind !== "native" || ["claude", "kimi", "opencode"].includes(plan.updater ?? "");
}
export interface AgentCliInstallation {
  currentVersion: string;
  latestVersion: string | null;
  plan: AgentCliPlan;
  canUpdate: boolean;
  reason: AgentCliUpdateError | null;
}
export interface AgentCliUpdateDriver {
  inspect(agent: AgentCliUpdateId, cachedLatest?: string): Promise<AgentCliInstallation | null>;
  version(plan: AgentCliPlan): Promise<string>;
  /**
   * Install `version`. A plan that is not exact (agentCliPlanExact) moves to the tool's newest
   * release instead and refuses a rollback with ROLLBACK_UNSUPPORTED, running nothing.
   */
  install(plan: AgentCliPlan, version: string, rollback?: boolean): Promise<void>;
  busy(
    agent: AgentCliUpdateId,
    plan?: AgentCliPlan,
    releaseIdle?: boolean,
    targetVersion?: string,
  ): Promise<boolean>;
  ready(agent: AgentCliUpdateId): Promise<boolean>;
  cancel?(): void;
}

const EXTRAS: Partial<
  Record<AgentCliUpdateId, { command?: string; packages?: string[]; env?: string }>
> = {
  "claude-code": {
    command: "claude",
    packages: ["@anthropic-ai/claude-code"],
    env: "CODEXHOST_CLAUDE_COMMAND",
  },
  pi: { packages: ["@earendil-works/pi-coding-agent"], env: "PI_COMMAND" },
  omp: { packages: ["@oh-my-pi/pi-coding-agent"], env: "OMP_COMMAND" },
  "qwen-code": {
    command: "qwen",
    packages: ["@qwen-code/qwen-code"],
    env: "CODEXHOST_QWEN_COMMAND",
  },
  devin: { command: "devin" },
  "kimi-code": { packages: ["@moonshot-ai/kimi-code"], env: "CODEXHOST_KIMI_COMMAND" },
  "kiro-cli": { env: "CODEXHOST_KIRO_COMMAND" },
  "cursor-cli": { command: "cursor-agent", env: "CODEXHOST_CURSOR_COMMAND" },
  "qoder-cn": { env: "CODEXHOST_QODERCN_COMMAND" },
};

export function createAgentCliUpdateDriver(options: {
  environment: () => Promise<NodeJS.ProcessEnv>;
  platform: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  get: () => Promise<UpdateHttpGet>;
  hosts: () => Promise<readonly HubHostRequest[]>;
  installing: (agent: AgentCliUpdateId) => boolean;
  run?: typeof runInstallationCommand;
  discover?: (agent: AgentCliUpdateId, env: NodeJS.ProcessEnv) => string | null;
  npmOptions?: NpmInstallationOptions;
  writable?: typeof access;
  occupied?: (
    plan: AgentCliPlan,
    environment: NodeJS.ProcessEnv,
    idleHostPids?: readonly number[],
  ) => Promise<boolean>;
  now?: () => number;
}): AgentCliUpdateDriver {
  const { platform } = options;
  const controller = new AbortController();
  const lastRelease = new Map<string, number>();
  const run =
    options.run ??
    ((command, args, env, timeout) =>
      runInstallationCommand(command, args, env, timeout, platform, { signal: controller.signal }));
  const json = async (url: string) => getUpdateJson(await options.get(), url);
  const envFor = async (): Promise<NodeJS.ProcessEnv> => ({
    ...(await options.environment()),
    KIMI_CODE_NO_AUTO_UPDATE: "1",
  });
  const hosts = async () => {
    const clients = await options.hosts();
    if (!clients.length) throw new Error("HOST_UNAVAILABLE");
    return clients;
  };
  const resolve = async (
    agent: AgentCliUpdateId,
    env: NodeJS.ProcessEnv,
  ): Promise<string | null> => {
    const configured = await new HarnessLaunchSettingsStore(env).initialCommand(agent);
    if (configured) {
      for (const host of await hosts()) {
        const setting = harnessLaunchSettingsSchema.parse(
          await hostCall(host, HARNESS_LAUNCH_SETTINGS_GET_METHOD, { harnessId: agent }),
        );
        if (setting.restartRequired || setting.path !== configured)
          throw new Error("ORIGINAL_INSTALLER");
      }
      // Directory settings depend on Adapter-specific entrypoint selection. Never substitute PATH.
      if (!(await stat(configured)).isFile()) throw new Error("ORIGINAL_INSTALLER");
      return configured;
    }
    if (options.discover) return options.discover(agent, env);
    const extra = EXTRAS[agent];
    const command = extra?.command ?? RLY0_AGENT_RECIPES[agent]?.detectionCommand;
    if (!command) return null;
    return (
      resolveHarnessExecutable(
        {
          id: agent,
          command,
          commandEnvironmentVariable:
            extra?.env ?? `CODEXHOST_${agent.replaceAll("-", "_").toUpperCase()}_COMMAND`,
          installRoots: {
            posix: [
              `~/.${agent}/bin`,
              "~/.local/bin",
              "~/.npm-global/bin",
              VERSION_MANAGER_ROOTS,
              "/opt/homebrew/bin",
              "/usr/local/bin",
            ],
            windows: [`~/.${agent}/bin`, "${APPDATA}/npm", "~/.local/bin", VERSION_MANAGER_ROOTS],
          },
        },
        { environment: env, platform },
      )?.executable ?? null
    );
  };
  const version = async (plan: AgentCliPlan) =>
    versionFromOutput(
      await run(plan.executable, ["--version"], { ...(await envFor()), DISABLE_AUTOUPDATER: "1" }),
    );
  /** Native updaters choose their target from the selected installation; keep its directory first. */
  const nativeEnv = (env: NodeJS.ProcessEnv, executable: string): NodeJS.ProcessEnv => {
    const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
    const delimiter = platform === "win32" ? ";" : ":";
    const directory = (platform === "win32" ? path.win32 : path.posix).dirname(executable);
    return { ...env, [key]: `${directory}${delimiter}${env[key] ?? ""}` };
  };
  /** Small plain-text release endpoints, on the Hub HTTP transport (proxy settings). */
  const text = async (url: string): Promise<string> => {
    const response = await (await options.get())(url, {});
    try {
      if (response.status !== 200) throw new Error("CHECK_FAILED");
      let body = "";
      for await (const chunk of response.body) {
        body += Buffer.from(chunk).toString("utf8");
        if (body.length > 1024) throw new Error("CHECK_FAILED");
      }
      return body;
    } finally {
      response.cancel();
    }
  };
  const npmLatest = async (npm: string | null, prefix: string, packageName: string) => {
    if (!npm) return null;
    try {
      return installationVersion(
        JSON.parse(
          await run(
            npm,
            ["view", "--prefix", prefix, `${packageName}@latest`, "version", "--json"],
            await envFor(),
          ),
        ),
      );
    } catch {
      return null;
    }
  };
  /** Claude Code's own release channel (settings autoUpdatesChannel), as its updater reads it. */
  const claudeSettings = async (env: NodeJS.ProcessEnv) => {
    const home = env.HOME ?? env.USERPROFILE ?? "";
    const config = env.CLAUDE_CONFIG_DIR
      ? path.resolve(home, env.CLAUDE_CONFIG_DIR)
      : path.join(home, ".claude");
    const settings = await readFile(path.join(config, "settings.json"), "utf8")
      .then((raw) => z.record(z.string(), z.unknown()).parse(JSON.parse(raw)))
      .catch(() => ({}) as Record<string, unknown>);
    const channel = settings.autoUpdatesChannel === "stable" ? "stable" : "latest";
    const settingsEnv = z.record(z.string(), z.string()).safeParse(settings.env);
    const disable = settingsEnv.success
      ? (settingsEnv.data.DISABLE_UPDATES ?? env.DISABLE_UPDATES)
      : env.DISABLE_UPDATES;
    return { channel, disabled: !!disable && disable !== "0" };
  };
  /** On POSIX a native Claude Code update never replaces a file that a running process uses. */
  const versionedClaude = (plan: AgentCliPlan) =>
    plan.kind === "native" && plan.updater === "claude" && platform !== "win32";
  const hostCall = async (host: HubHostRequest, method: string, params: unknown) => {
    try {
      return await host(method, params, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw new Error("INTERRUPTED");
      throw new Error("HOST_UNAVAILABLE", { cause: error });
    }
  };
  return {
    cancel: () => controller.abort(),
    version,
    async inspect(agent, cachedLatest) {
      // No runnable Host means no trustworthy busy/connection check. In particular an isolated
      // source test must never fall through to a developer's globally installed commands.
      await Promise.all(
        (await hosts()).map(async (host) =>
          agentCliBusyResultSchema.parse(await hostCall(host, AGENT_CLI_BUSY_METHOD, { agent })),
        ),
      );
      const env = await envFor();
      const executable = await resolve(agent, env);
      if (!executable) return null;
      const packages = [
        ...(EXTRAS[agent]?.packages ?? []),
        ...(RLY0_AGENT_RECIPES[agent]?.attempts.flatMap((attempt) =>
          attempt.kind === "npm" ? [attempt.packageName.replace(/@[^/]+$/, "")] : [],
        ) ?? []),
      ];
      const npm = packages.length
        ? await npmInstallation(executable, packages, env, {
            ...options.npmOptions,
            platform,
            run,
            resolveNpm:
              options.npmOptions?.resolveNpm ??
              ((environment) =>
                resolveHarnessExecutable({ id: "npm", command: "npm" }, { environment, platform })
                  ?.executable ?? null),
            fetchText: async (url) => JSON.stringify(await json(url)),
          })
        : null;
      const plan: AgentCliPlan = {
        kind: npm ? "npm" : "script",
        executable,
        npm: null,
        prefix: npm?.prefix ?? null,
        packageName: npm?.packageName ?? null,
        updater: null,
      };
      if (npm) {
        plan.npm = npm.npmExecutable;
        // The selected CLI, not just package.json, must report the saved rollback version.
        const currentVersion = await version(plan);
        if (!npm.canUpdate || currentVersion !== npm.currentVersion)
          return {
            currentVersion,
            // Still say whether a newer release exists, even though Hub will not install it.
            latestVersion:
              cachedLatest ?? (await npmLatest(npm.npmExecutable, npm.prefix, npm.packageName)),
            plan,
            canUpdate: false,
            reason: "ORIGINAL_INSTALLER",
          };
        const pinned = RLY0_AGENT_RECIPES[agent]?.attempts.some(
          (attempt) =>
            attempt.kind === "npm" && attempt.packageName.startsWith(`${npm.packageName}@`),
        );
        if (pinned)
          return {
            currentVersion,
            latestVersion: currentVersion,
            plan,
            canUpdate: false,
            reason: "VERSION_PINNED",
          };
        try {
          await assertCliWritable(plan, platform, options.writable);
        } catch (error) {
          return {
            currentVersion,
            latestVersion:
              cachedLatest ?? (await npmLatest(npm.npmExecutable, npm.prefix, npm.packageName)),
            plan,
            canUpdate: false,
            reason:
              error instanceof Error && error.message === "COMMAND_FILE_IN_USE"
                ? "INSTALL_FILE_BUSY"
                : "PERMISSION_DENIED",
          };
        }
        return {
          currentVersion,
          latestVersion:
            cachedLatest ??
            installationVersion(
              JSON.parse(
                await run(
                  npm.npmExecutable ?? "",
                  [
                    "view",
                    "--prefix",
                    npm.prefix,
                    `${npm.packageName}@latest`,
                    "version",
                    "--json",
                  ],
                  env,
                ),
              ),
            ),
          plan,
          canUpdate: npm.canUpdate && currentVersion === npm.currentVersion,
          reason:
            npm.canUpdate && currentVersion === npm.currentVersion ? null : "ORIGINAL_INSTALLER",
        };
      }
      const currentVersion = await version(plan);
      let latestVersion: string | null = null;
      let canUpdate = false;
      let reason: AgentCliUpdateError = "NO_OFFICIAL_UPDATER";
      const home = env.HOME ?? env.USERPROFILE ?? "";
      const selected = await realpath(executable).catch(() => executable);
      // Package-manager stores are immutable; their own manager must update them.
      const managed = /[\\/]nix[\\/]store[\\/]|[\\/]Cellar[\\/]/i.test(selected);
      const native = (updater: AgentCliNativeUpdater) => {
        if (managed) {
          reason = "ORIGINAL_INSTALLER";
          return;
        }
        plan.kind = "native";
        plan.updater = updater;
        canUpdate = true;
      };
      // Never run an installer script again: only each tool's own official update command.
      if (agent === "claude-code") {
        const settings = await claudeSettings(env);
        latestVersion =
          cachedLatest ??
          installationVersion(
            await text(`https://downloads.claude.ai/claude-code-releases/${settings.channel}`),
          );
        const launcher = path.join(
          home,
          ".local",
          "bin",
          platform === "win32" ? "claude.exe" : "claude",
        );
        const versions = path.join(home, ".local", "share", "claude", "versions") + path.sep;
        const nativeInstall =
          path.resolve(executable) === launcher &&
          (selected.startsWith(versions) || (platform === "win32" && selected === launcher));
        if (settings.disabled) reason = "VERSION_PINNED";
        else if (nativeInstall) native("claude");
        else reason = "ORIGINAL_INSTALLER";
      } else if (agent === "opencode") {
        latestVersion =
          cachedLatest ??
          installationVersion(
            z
              .object({ tag_name: z.string() })
              .parse(await json("https://api.github.com/repos/anomalyco/opencode/releases/latest"))
              .tag_name,
          );
        const standard = path.join(home, ".opencode", "bin", "opencode");
        if (
          platform !== "win32" &&
          path.resolve(executable) === standard &&
          selected === standard
        ) {
          // The installer location: the original exact-version curl upgrade.
          canUpdate = true;
        } else native("opencode"); // `opencode upgrade <v>` detects its own install method.
      } else if (agent === "pi") {
        latestVersion =
          cachedLatest ??
          installationVersion(
            z.object({ version: z.string() }).parse(await json("https://pi.dev/api/latest-version"))
              .version,
          );
        native("update");
      } else if (agent === "antigravity") {
        const system = platform === "win32" ? "windows" : platform;
        const arch = options.arch ?? process.arch;
        if (!["darwin", "linux", "windows"].includes(system) || !["arm64", "x64"].includes(arch))
          throw new Error("CHECK_FAILED");
        latestVersion = installationVersion(
          z
            .object({ version: z.string() })
            .parse(
              await json(
                `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${system}_${arch === "arm64" ? "arm64" : "amd64"}.json`,
              ),
            ).version,
        );
        native("update");
      } else if (agent === "grok") {
        const data: unknown = JSON.parse(
          await run(executable, ["update", "--check", "--json"], env),
        );
        latestVersion = installationVersion(
          z.object({ latestVersion: z.string(), updateAvailable: z.boolean() }).parse(data)
            .latestVersion,
        );
        native("update");
      } else if (agent === "cursor-cli") {
        const data: unknown = JSON.parse(await run(executable, ["about", "--format", "json"], env));
        const about = z
          .object({ latestVersion: z.string(), latestStatus: z.string().optional() })
          .parse(data);
        latestVersion = installationVersion(about.latestVersion);
        // Cursor reports its own update checks as disabled/unavailable otherwise.
        if (
          about.latestStatus === undefined ||
          ["up_to_date", "update_available"].includes(about.latestStatus)
        )
          native("update");
      } else if (agent === "omp" || agent === "qoder" || agent === "qoder-cn") {
        if (
          agent !== "qoder-cn" ||
          (await run(executable, ["update", "--help"], env)).includes("--check")
        ) {
          const output = await run(executable, ["update", "--check"], nativeEnv(env, executable));
          const available =
            agent === "omp"
              ? output.match(/New version available:\s*(\S+)/i)
              : output.match(/Update available:\s*\S+\s*(?:->|\u2192)\s*(\S+)/i);
          if (available?.[1]) latestVersion = installationVersion(available[1]);
          else if (
            /already up to date|already\s+(?:on|at)\s+(?:the\s+)?latest|up.to.date|no updates?\s+available/i.test(
              output,
            )
          )
            latestVersion = currentVersion;
          else throw new Error("CHECK_FAILED");
          native("update");
        }
      } else if (agent === "hermes") {
        const help = await run(executable, ["update", "--help"], env);
        if (help.includes("--check") && help.includes("--plan")) {
          const output = await run(executable, ["update", "--check"], env);
          const release = output.match(/Selected release available:\s*([\w.+-]+)/i)?.[1];
          latestVersion = release
            ? installationVersion(release)
            : /up.to.date/i.test(output)
              ? currentVersion
              : null;
          // Hermes's own safe non-interactive conditions: a git install updatable in place, a
          // clean checkout, and Gateway restarts deferred. A tracking branch has no version.
          const updatePlan = await run(executable, ["update", "--plan"], env);
          const root = (await run(executable, ["--version"], env))
            .match(/^Install directory:\s*(.+)$/m)?.[1]
            ?.trim();
          const clean = root
            ? await run("git", ["-C", root, "status", "--porcelain"], env).then(
                (status) => !status.trim(),
                () => false,
              )
            : false;
          if (
            release &&
            clean &&
            /Install:\s*git\b/i.test(updatePlan) &&
            !/NOT updatable in place/i.test(updatePlan) &&
            help.includes("--yes") &&
            help.includes("--no-gateway-restart")
          )
            native("hermes");
          else reason = "ORIGINAL_INSTALLER";
        }
      } else if (agent === "kimi-code") {
        const region = await readFile(
          path.join(env.KIMI_CODE_HOME ?? path.join(home, ".kimi-code"), "region"),
          "utf8",
        ).catch(() => "");
        latestVersion =
          cachedLatest ??
          installationVersion(
            await text(
              `https://code.kimi.${region.trim() === "global" ? "ai" : "com"}/kimi-code/latest`,
            ),
          );
        // Kimi's public upgrade is interactive; its staging worker takes an exact version when
        // the native binary advertises --manual (the same check as the console adapter).
        const file = await open(executable, "r");
        let magic = "";
        try {
          const header = Buffer.alloc(4);
          await file.read(header, 0, 4, 0);
          magic = header.toString("hex");
        } finally {
          await file.close();
        }
        const binary =
          ["cffaedfe", "cefaedfe", "cafebabe", "7f454c46"].includes(magic) ||
          magic.startsWith("4d5a");
        if (
          binary &&
          /--manual/.test(
            await run(executable, ["__update_download", "--help"], env).catch(() => ""),
          )
        )
          native("kimi");
      }
      return { currentVersion, latestVersion, plan, canUpdate, reason: canUpdate ? null : reason };
    },
    async install(plan, version, rollback = false) {
      const selected = installationVersion(version);
      // Refuse before any effect: a latest-only updater cannot put an old version back.
      if (rollback && !agentCliPlanExact(plan)) throw new Error("ROLLBACK_UNSUPPORTED");
      const env = await envFor();
      await assertCliWritable(plan, platform, options.writable);
      if (
        !versionedClaude(plan) &&
        (await (options.occupied ?? ((p, env) => cliProcessBusy(p, env, platform, run)))(plan, env))
      )
        throw new Error("BUSY");
      if (plan.kind === "npm" && plan.npm && plan.prefix && plan.packageName) {
        await run(
          plan.npm,
          ["install", "--global", "--prefix", plan.prefix, `${plan.packageName}@${selected}`],
          env,
          300_000,
        );
      } else if (plan.kind === "script") {
        await run(plan.executable, ["upgrade", selected, "--method", "curl"], env, 300_000);
      } else if (plan.kind === "native" && plan.updater) {
        const nenv = nativeEnv(env, plan.executable);
        const args: Record<AgentCliNativeUpdater, string[]> = {
          // --force: switch back to an already-downloaded version on rollback as well.
          claude: ["install", selected, "--force"],
          kimi: ["__update_download", selected, "--manual"],
          opencode: ["upgrade", selected],
          update: ["update"],
          hermes: ["update", "--yes", "--no-gateway-restart"],
        };
        await run(plan.executable, args[plan.updater], nenv, 300_000);
        // Kimi swaps the staged build in at its next native start.
        if (plan.updater === "kimi") await run(plan.executable, ["--version"], nenv);
      } else throw new Error("ORIGINAL_INSTALLER");
    },
    async busy(agent, plan, releaseIdle = false, targetVersion) {
      if (options.installing(agent)) return true;
      const clients = await hosts();
      const states = await Promise.all(
        clients.map(async (host) =>
          agentCliBusyResultSchema.parse(await hostCall(host, AGENT_CLI_BUSY_METHOD, { agent })),
        ),
      );
      if (states.some((state) => state.busy)) return true;
      // A native Claude Code install adds a new versions/<v> file and repoints the launcher;
      // running sessions keep their own file. Wait only for running turns, never close sessions.
      if (plan && versionedClaude(plan)) return false;
      const occupied =
        options.occupied ??
        ((p, env, hostPids) => cliProcessBusy(p, env, platform, run, realpath, hostPids));
      const env = await envFor();
      // Idle Host-owned CLI processes are releasable; external terminals/other owners are not.
      if (
        plan &&
        (await occupied(
          plan,
          env,
          releaseIdle ? states.flatMap((s) => (s.hostPid ? [s.hostPid] : [])) : [],
        ))
      )
        return true;
      if (!releaseIdle) return false;
      const key = JSON.stringify([agent, plan?.executable, targetVersion]);
      const now = (options.now ?? Date.now)();
      const previous = lastRelease.get(key);
      if (previous !== undefined && now - previous < 15 * 60_000) return true;
      // Count attempts as well as successes: a failed close must not be retried every minute.
      lastRelease.set(key, now);
      const released = await Promise.all(
        clients.map(async (host) =>
          agentCliBusyResultSchema.parse(await hostCall(host, AGENT_CLI_RELEASE_METHOD, { agent })),
        ),
      );
      if (released.some((state) => state.busy) || options.installing(agent)) return true;
      // Do not exclude any Host processes after release, or immediately before install.
      return plan ? occupied(plan, env, []) : false;
    },
    async ready(agent) {
      const states = await Promise.all(
        (await hosts()).map(async (host) =>
          harnessInspectionSchema
            .parseAsync(await hostCall(host, AGENT_CLI_INSPECT_METHOD, { agent }))
            .catch(() => {
              throw new Error("HOST_UNAVAILABLE");
            }),
        ),
      );
      return states.every((state) => state.status === "ready");
    },
  };
}

export { newerInstallationVersion };
