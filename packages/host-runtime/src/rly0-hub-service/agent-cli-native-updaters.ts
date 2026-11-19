import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { installationVersion, newerInstallationVersion } from "@codexhost/harness-discovery";
import type { AgentCliUpdateError, AgentCliUpdateId } from "@codexhost/shared-contracts";
import { z } from "zod";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

/**
 * Official native updaters. claude/kimi install an exact version (update and rollback);
 * update/hermes can only move to the tool's newest release (no automatic rollback).
 */
export const agentCliNativeUpdaterSchema = z.enum(["claude", "kimi", "update", "hermes"]);
export type AgentCliNativeUpdater = z.infer<typeof agentCliNativeUpdaterSchema>;

export function nativeUpdateArguments(updater: AgentCliNativeUpdater, version: string): string[] {
  switch (updater) {
    case "claude":
      // --force: also switches back to an already-downloaded version on rollback.
      return ["install", version, "--force"];
    case "kimi":
      return ["__update_download", version, "--manual"];
    case "update":
      return ["update"];
    case "hermes":
      return ["update", "--yes", "--no-gateway-restart"];
  }
}

const flavor = (platform: NodeJS.Platform) => (platform === "win32" ? path.win32 : path.posix);
const homeOf = (env: NodeJS.ProcessEnv) => env.HOME ?? env.USERPROFILE ?? "";

/** Native updaters choose their target from the selected installation; keep its directory first. */
export function nativeUpdateEnvironment(
  env: NodeJS.ProcessEnv,
  executable: string,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") ?? "PATH";
  const delimiter = platform === "win32" ? ";" : ":";
  return { ...env, [key]: `${flavor(platform).dirname(executable)}${delimiter}${env[key] ?? ""}` };
}

/** Claude Code's native launcher and the versions directory it points into. */
export function claudeNativeLayout(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const p = flavor(platform);
  const home = homeOf(env);
  return {
    launcher: p.join(home, ".local", "bin", platform === "win32" ? "claude.exe" : "claude"),
    versions: p.join(home, ".local", "share", "claude", "versions"),
  };
}

/** The retained binary of a previous Claude Code version, used to run its own rollback. */
export async function claudeRetainedVersion(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  version: string,
): Promise<string | null> {
  const { versions } = claudeNativeLayout(env, platform);
  const p = flavor(platform);
  for (const name of platform === "win32" ? [`${version}.exe`, version] : [version]) {
    const file = p.join(versions, name);
    if (
      await stat(file).then(
        (s) => s.isFile(),
        () => false,
      )
    )
      return file;
  }
  return null;
}

const enabled = (value: string | undefined) => !!value && value !== "0";

/**
 * Claude Code's own update policy, as packages/adapters/claude-code/src/installation.ts reads it:
 * user and managed settings, release channel, DISABLE_UPDATES and the version bounds. Hub also
 * treats DISABLE_AUTOUPDATER as the user's choice not to update.
 */
export async function claudeUpdatePolicy(input: {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  managedSettingsFile?: string;
  latest: (channel: "latest" | "stable") => Promise<string>;
  cachedLatest?: string | undefined;
}): Promise<{ latestVersion: string; reason: AgentCliUpdateError | null }> {
  const { env, platform } = input;
  const read = async (file: string) => {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("CHECK_FAILED");
    }
    const parsed = z
      .object({
        autoUpdatesChannel: z.string().optional(),
        minimumVersion: z.string().optional(),
        requiredMaximumVersion: z.string().optional(),
        env: z.record(z.string(), z.string()).optional(),
      })
      .safeParse(JSON.parse(text));
    if (!parsed.success) throw new Error("CHECK_FAILED");
    return parsed.data;
  };
  const p = flavor(platform);
  const home = homeOf(env);
  const config = env.CLAUDE_CONFIG_DIR
    ? p.resolve(home, env.CLAUDE_CONFIG_DIR)
    : p.join(home, ".claude");
  const managedFile =
    input.managedSettingsFile ??
    (platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : platform === "win32"
        ? p.join(env.ProgramFiles ?? "C:\\Program Files", "ClaudeCode", "managed-settings.json")
        : "/etc/claude-code/managed-settings.json");
  const user = await read(p.join(config, "settings.json"));
  const managed = await read(managedFile);
  const settings = { ...user, ...managed, env: { ...user.env, ...managed.env } };
  const effective = { ...env, ...settings.env };
  const channel = settings.autoUpdatesChannel ?? "latest";
  // An unknown channel is Claude's own configuration error; never guess a release.
  if (channel !== "latest" && channel !== "stable") throw new Error("CHECK_FAILED");
  const latestVersion = installationVersion(input.cachedLatest ?? (await input.latest(channel)));
  if (enabled(effective.DISABLE_UPDATES) || enabled(effective.DISABLE_AUTOUPDATER))
    return { latestVersion, reason: "DISABLED_BY_TOOL_SETTINGS" };
  const pinned =
    (!!settings.minimumVersion &&
      newerInstallationVersion(latestVersion, installationVersion(settings.minimumVersion))) ||
    (!!settings.requiredMaximumVersion &&
      newerInstallationVersion(
        installationVersion(settings.requiredMaximumVersion),
        latestVersion,
      ));
  return { latestVersion, reason: pinned ? "VERSION_PINNED" : null };
}

/**
 * Where each tool's official installer puts its command. Hub updates only these; package
 * managers, version managers and custom locations stay with whatever installed them.
 */
export function officialInstallLocation(
  agent: AgentCliUpdateId,
  executable: string,
  selected: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): boolean {
  const p = flavor(platform);
  const home = homeOf(env);
  const local = env.LOCALAPPDATA ?? p.join(home, "AppData", "Local");
  const user = (...parts: string[]) => p.join(home, ...parts);
  const win = platform === "win32";
  const roots: Partial<Record<AgentCliUpdateId, string[]>> = {
    pi: [user(".local", "bin"), user(".pi", "bin")],
    omp: [user(".local", "bin"), user(".omp", "bin")],
    grok: [user(".grok", "bin"), user(".local", "bin")],
    antigravity: win ? [p.join(local, "agy", "bin")] : [user(".local", "bin")],
    "cursor-cli": win ? [p.join(local, "cursor-agent")] : [user(".local", "bin")],
    qoder: win
      ? [p.join(local, "Programs", "Qoder"), p.join(local, "Qoder"), user(".qoder", "bin")]
      : [user(".local", "bin"), user(".qoder", "bin")],
    "qoder-cn": win
      ? [p.join(local, "Programs", "QoderCN"), p.join(local, "QoderCN"), user(".qoder-cn", "bin")]
      : [user(".local", "bin"), user(".qoder-cn", "bin")],
    "kimi-code": [user(".kimi-code", "bin")],
    hermes: [user(".local", "bin")],
  };
  const normalize = (file: string) =>
    win ? p.resolve(file).replaceAll("\\", "/").toLowerCase() : p.resolve(file);
  const directory = normalize(p.dirname(executable));
  // A launcher in an official directory may still point into a package-manager store.
  if (/[\\/](?:nix[\\/]store|Cellar|homebrew|node_modules)[\\/]/i.test(selected)) return false;
  return (roots[agent] ?? []).some((root) => normalize(root) === directory);
}

/**
 * A copy of the binary being replaced, so a rollback runs the old, known-good updater rather
 * than the version that just failed. One copy per installation; settle() removes it.
 */
export function agentCliBackup(env: NodeJS.ProcessEnv, executable: string): string {
  const id = createHash("sha256").update(executable).digest("hex").slice(0, 16);
  return path.join(
    resolveRly0DataDir(env),
    "agent-cli-backups",
    `${id}-${path.basename(executable)}`,
  );
}
export async function saveAgentCliBackup(env: NodeJS.ProcessEnv, executable: string) {
  const backup = agentCliBackup(env, executable);
  await mkdir(path.dirname(backup), { recursive: true, mode: 0o700 });
  await copyFile(await realpath(executable), backup);
}
export async function existingAgentCliBackup(env: NodeJS.ProcessEnv, executable: string) {
  const backup = agentCliBackup(env, executable);
  return (await stat(backup).then(
    (s) => s.isFile(),
    () => false,
  ))
    ? backup
    : null;
}
export async function removeAgentCliBackup(env: NodeJS.ProcessEnv, executable: string) {
  await rm(agentCliBackup(env, executable), { force: true });
}
