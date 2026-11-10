import type { access } from "node:fs/promises";
import { readFile, realpath, stat } from "node:fs/promises";
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

export const agentCliPlanSchema = z.strictObject({
  kind: z.enum(["npm", "script"]),
  executable: z.string().min(1),
  npm: z.string().nullable(),
  prefix: z.string().nullable(),
  packageName: z.string().nullable(),
});
export type AgentCliPlan = z.infer<typeof agentCliPlanSchema>;
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
  install(plan: AgentCliPlan, version: string): Promise<void>;
  busy(agent: AgentCliUpdateId, plan?: AgentCliPlan): Promise<boolean>;
  ready(agent: AgentCliUpdateId): Promise<boolean>;
  cancel?(): void;
}

const EXTRAS: Partial<
  Record<AgentCliUpdateId, { command?: string; packages?: string[]; env?: string }>
> = {
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
  occupied?: (plan: AgentCliPlan, environment: NodeJS.ProcessEnv) => Promise<boolean>;
}): AgentCliUpdateDriver {
  const { platform } = options;
  const controller = new AbortController();
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
    versionFromOutput(await run(plan.executable, ["--version"], await envFor()));
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
      };
      if (npm) {
        plan.npm = npm.npmExecutable;
        // The selected CLI, not just package.json, must report the saved rollback version.
        const currentVersion = await version(plan);
        if (!npm.canUpdate || currentVersion !== npm.currentVersion)
          return {
            currentVersion,
            latestVersion: null,
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
        } catch {
          return {
            currentVersion,
            latestVersion: null,
            plan,
            canUpdate: false,
            reason: "PERMISSION_DENIED",
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
      // Reuse the console adapters' fixed, non-installing native checks. Never run an installer
      // script again. Native updates lacking a version-pinned rollback remain detection-only.
      if (agent === "opencode") {
        latestVersion =
          cachedLatest ??
          installationVersion(
            z
              .object({ tag_name: z.string() })
              .parse(await json("https://api.github.com/repos/anomalyco/opencode/releases/latest"))
              .tag_name,
          );
        const standard = path.join(
          env.HOME ?? env.USERPROFILE ?? "",
          ".opencode",
          "bin",
          "opencode",
        );
        canUpdate =
          platform !== "win32" &&
          path.resolve(executable) === standard &&
          (await realpath(executable)) === standard;
        reason = "ORIGINAL_INSTALLER";
      } else if (agent === "pi") {
        latestVersion =
          cachedLatest ??
          installationVersion(
            z.object({ version: z.string() }).parse(await json("https://pi.dev/api/latest-version"))
              .version,
          );
        reason = "ROLLBACK_UNSUPPORTED";
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
        reason = "ROLLBACK_UNSUPPORTED";
      } else if (agent === "grok") {
        const data: unknown = JSON.parse(
          await run(executable, ["update", "--check", "--json"], env),
        );
        latestVersion = installationVersion(
          z.object({ latestVersion: z.string(), updateAvailable: z.boolean() }).parse(data)
            .latestVersion,
        );
        reason = "ROLLBACK_UNSUPPORTED";
      } else if (agent === "cursor-cli") {
        const data: unknown = JSON.parse(await run(executable, ["about", "--format", "json"], env));
        latestVersion = installationVersion(
          z.object({ latestVersion: z.string() }).parse(data).latestVersion,
        );
        reason = "ROLLBACK_UNSUPPORTED";
      } else if (agent === "omp" || agent === "qoder" || agent === "qoder-cn") {
        if (
          agent !== "qoder-cn" ||
          (await run(executable, ["update", "--help"], env)).includes("--check")
        ) {
          const output = await run(executable, ["update", "--check"], env);
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
          reason = "ROLLBACK_UNSUPPORTED";
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
          reason = "ROLLBACK_UNSUPPORTED";
        }
      } else if (agent === "kimi-code") {
        const region = await readFile(
          path.join(
            env.KIMI_CODE_HOME ?? path.join(env.HOME ?? env.USERPROFILE ?? "", ".kimi-code"),
            "region",
          ),
          "utf8",
        ).catch(() => "");
        // This endpoint returns plain text; keep its request on the Hub HTTP transport.
        const response = await (
          await options.get()
        )(`https://code.kimi.${region.trim() === "global" ? "ai" : "com"}/kimi-code/latest`, {});
        try {
          if (response.status !== 200) throw new Error("CHECK_FAILED");
          let text = "";
          for await (const chunk of response.body) {
            text += Buffer.from(chunk).toString("utf8");
            if (text.length > 1024) throw new Error("CHECK_FAILED");
          }
          latestVersion = installationVersion(text);
        } finally {
          response.cancel();
        }
        reason = "ROLLBACK_UNSUPPORTED";
      }
      return { currentVersion, latestVersion, plan, canUpdate, reason: canUpdate ? null : reason };
    },
    async install(plan, version) {
      const selected = installationVersion(version);
      const env = await envFor();
      await assertCliWritable(plan, platform, options.writable);
      if (
        await (options.occupied ?? ((p, env) => cliProcessBusy(p, env, platform, run)))(plan, env)
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
      } else throw new Error("ORIGINAL_INSTALLER");
    },
    async busy(agent, plan) {
      if (options.installing(agent)) return true;
      if (
        plan &&
        (await (options.occupied ?? ((p, env) => cliProcessBusy(p, env, platform, run)))(
          plan,
          await envFor(),
        ))
      )
        return true;
      const states = await Promise.all(
        (await hosts()).map(async (host) =>
          agentCliBusyResultSchema.parse(await hostCall(host, AGENT_CLI_BUSY_METHOD, { agent })),
        ),
      );
      return states.some((state) => state.busy);
    },
    async ready(agent) {
      const states = await Promise.all(
        (await hosts()).map(async (host) =>
          harnessInspectionSchema
            .parseAsync(
              await hostCall(host, "codexhost/harness/inspect", {
                harnessId: agent,
                refresh: true,
              }),
            )
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
