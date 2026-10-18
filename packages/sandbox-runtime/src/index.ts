import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { promisify } from "node:util";
import { resolveHarnessExecutable } from "@codexhost/harness-discovery";
import {
  RLY0_HOME_DATA_DIRECTORY_NAME,
  sandboxSettingsSchema,
  type SandboxSettings,
  type SandboxProject,
} from "@codexhost/shared-contracts";

const execute = promisify(execFile);
export { SANDBOX_GUEST_GUARD } from "./guest.js";
export const SANDBOX_SETTINGS_FILE = "claude-isolation.json";
export const SANDBOX_DENIED_NETWORKS = [
  "host.docker.internal",
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "169.254.0.0/16",
];
export interface SandboxBinding {
  settings: SandboxSettings;
  project: SandboxProject;
  command: string;
}
export interface DockerSandbox {
  name: string;
  id: string;
  agent: string;
  status: string;
  workspaces: string[];
}

export function sandboxSettingsFile(environment: NodeJS.ProcessEnv): string {
  return path.join(
    environment.CODEXHOST_DATA_DIR ?? path.join(os.homedir(), RLY0_HOME_DATA_DIRECTORY_NAME),
    SANDBOX_SETTINGS_FILE,
  );
}

/** Missing configuration means local mode; unreadable or damaged configuration never does. */
export function readSandboxSettings(environment: NodeJS.ProcessEnv): SandboxSettings | null {
  let contents: string;
  try {
    contents = readFileSync(sandboxSettingsFile(environment), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("ISOLATION_CONFIG_UNREADABLE");
  }
  try {
    return sandboxSettingsSchema.parse(JSON.parse(contents));
  } catch {
    throw new Error("ISOLATION_CONFIG_INVALID");
  }
}

export async function writeSandboxSettings(
  environment: NodeJS.ProcessEnv,
  settings: SandboxSettings,
): Promise<void> {
  const parsed = sandboxSettingsSchema.parse(settings);
  const file = sandboxSettingsFile(environment);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
}

export function resolveSandboxCommand(environment: NodeJS.ProcessEnv): string {
  const found = resolveHarnessExecutable(
    {
      id: "docker-sandboxes",
      command: "sbx",
      installRoots: { windows: ["${LOCALAPPDATA}/DockerSandboxes/bin"] },
    },
    { environment },
  );
  if (!found) throw new Error("ISOLATION_DOCKER_MISSING");
  return found.executable;
}

export function sandboxEnvironment(
  environment: NodeJS.ProcessEnv,
  settings: SandboxSettings,
): NodeJS.ProcessEnv {
  // Only the native Docker CLI receives this data-root override. Never change the Host's globals.
  return {
    ...environment,
    LOCALAPPDATA: settings.runtimeRoot,
    NO_PROXY: "",
    no_proxy: "",
    DOCKER_SANDBOXES_NO_PROXY: "",
  };
}

export function sameProject(left: string, right: string): boolean {
  return (
    path.win32
      .resolve(left)
      .replace(/[\\/]+$/u, "")
      .toLowerCase() ===
    path.win32
      .resolve(right)
      .replace(/[\\/]+$/u, "")
      .toLowerCase()
  );
}

export function guestProjectPath(project: string): string {
  if (!/^[A-Za-z]:\\/u.test(project) || project.includes("\0"))
    throw new Error("ISOLATION_PROJECT_INVALID");
  return `/${project.slice(0, 1).toLowerCase()}${project.slice(2).replaceAll("\\", "/")}`;
}

export async function validateSandboxProject(
  project: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  if (!path.win32.isAbsolute(project) || project.startsWith("\\\\"))
    throw new Error("ISOLATION_PROJECT_INVALID");
  const canonical = await realpath(project);
  const home = environment.USERPROFILE ?? os.homedir();
  const protectedPaths = [home, path.dirname(sandboxSettingsFile(environment))];
  if (
    !(await stat(canonical)).isDirectory() ||
    sameProject(canonical, path.parse(canonical).root) ||
    protectedPaths.some(
      (p) => sameProject(canonical, p) || path.relative(canonical, p).split(path.sep)[0] !== "..",
    )
  )
    throw new Error("ISOLATION_PROJECT_TOO_BROAD");
  return canonical;
}

export function resolveSandboxBinding(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  settings = readSandboxSettings(environment),
): SandboxBinding | null {
  if (!settings?.enabled) return null;
  if (process.platform !== "win32") throw new Error("ISOLATION_WINDOWS_ONLY");
  const project = settings.projects.find((entry) => sameProject(entry.project, cwd));
  if (!project)
    throw new Error("ISOLATION_PROJECT_NOT_AUTHORIZED: choose this project in Hub first");
  return { settings, project, command: resolveSandboxCommand(environment) };
}

export async function runSandboxCommand(
  environment: NodeJS.ProcessEnv,
  settings: SandboxSettings,
  args: readonly string[],
  timeout = 20000,
  allowedExitCodes: readonly number[] = [],
): Promise<string> {
  try {
    const result = await execute(resolveSandboxCommand(environment), [...args], {
      env: sandboxEnvironment(environment, settings),
      windowsHide: true,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const failure = error as { code?: unknown; stdout?: unknown };
    if (
      typeof failure.code === "number" &&
      allowedExitCodes.includes(failure.code) &&
      typeof failure.stdout === "string"
    )
      return failure.stdout.trim();
    throw new Error("ISOLATION_DOCKER_COMMAND_FAILED");
  }
}

export function parseDockerSandboxes(contents: string): DockerSandbox[] {
  const raw: unknown = JSON.parse(contents);
  if (
    !Array.isArray(raw) ||
    raw.some(
      (r) =>
        !r ||
        typeof r.name !== "string" ||
        typeof r.id !== "string" ||
        typeof r.agent !== "string" ||
        typeof r.status !== "string" ||
        !Array.isArray(r.workspaces) ||
        r.workspaces.some((p: unknown) => typeof p !== "string"),
    )
  )
    throw new Error("ISOLATION_DOCKER_RESPONSE_INVALID");
  return raw as DockerSandbox[];
}

export async function listDockerSandboxes(
  environment: NodeJS.ProcessEnv,
  settings: SandboxSettings,
): Promise<DockerSandbox[]> {
  return parseDockerSandboxes(await runSandboxCommand(environment, settings, ["ls", "--json"]));
}

export function verifySandboxWorkspace(
  sandboxes: DockerSandbox[],
  project: Omit<SandboxProject, "id"> & { id?: string },
): DockerSandbox {
  const sandbox = sandboxes.find((entry) => entry.name === project.name);
  if (
    !sandbox ||
    (project.id !== undefined && sandbox.id !== project.id) ||
    sandbox.agent !== "claude" ||
    sandbox.workspaces.length !== 1 ||
    !sameProject(sandbox.workspaces[0] ?? "", project.project)
  )
    throw new Error("ISOLATION_WORKSPACE_MISMATCH");
  return sandbox;
}

export async function verifySandboxProxy(
  environment: NodeJS.ProcessEnv,
  settings: SandboxSettings,
): Promise<void> {
  const configured = await runSandboxCommand(environment, settings, ["settings", "get", "proxy"]);
  if (configured !== settings.proxy) throw new Error("ISOLATION_PROXY_CHANGED");
  const url = new URL(settings.proxy);
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({
      host: url.hostname.replace(/^\[|\]$/gu, ""),
      port: Number(url.port),
    });
    socket.setTimeout(3000);
    const finish = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.once("connect", () => finish());
    socket.once("error", () => finish(new Error("ISOLATION_PROXY_UNAVAILABLE")));
    socket.once("timeout", () => finish(new Error("ISOLATION_PROXY_UNAVAILABLE")));
  });
}

export async function verifySandboxBinding(
  binding: SandboxBinding,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const current = readSandboxSettings(environment);
  const authorized = current?.projects.find((project) =>
    sameProject(project.project, binding.project.project),
  );
  if (
    !current?.enabled ||
    !sameProject(current.runtimeRoot, binding.settings.runtimeRoot) ||
    current.proxy !== binding.settings.proxy ||
    authorized?.name !== binding.project.name ||
    authorized?.id !== binding.project.id
  )
    throw new Error("ISOLATION_CONFIGURATION_CHANGED: reload the assistant from Hub");
  await verifySandboxProxy(environment, binding.settings);
  verifySandboxWorkspace(await listDockerSandboxes(environment, binding.settings), binding.project);
  const canonical = await realpath(binding.project.project);
  if (!sameProject(canonical, binding.project.project))
    throw new Error("ISOLATION_PROJECT_CHANGED");
}
