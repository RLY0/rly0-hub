import { constants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import path from "node:path";
import type { runInstallationCommand } from "@codexhost/harness-discovery";
import type { AgentCliPlan } from "./agent-cli-update-driver.js";

/** Check the original directories, including an existing scoped package, without creating files. */
export async function assertCliWritable(
  plan: AgentCliPlan,
  platform: NodeJS.Platform,
  check = access,
): Promise<void> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const directories =
    plan.kind === "npm" && plan.prefix && plan.packageName
      ? [
          plan.prefix,
          ...(platform === "win32" ? [] : [p.join(plan.prefix, "bin")]),
          p.join(plan.prefix, ...(platform === "win32" ? [] : ["lib"]), "node_modules"),
          p.join(
            plan.prefix,
            ...(platform === "win32" ? [] : ["lib"]),
            "node_modules",
            ...plan.packageName.split("/"),
          ),
        ]
      : [p.dirname(plan.executable), plan.executable];
  try {
    for (const directory of directories) await check(directory, constants.W_OK);
  } catch (error) {
    throw new Error(
      platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM"
        ? "COMMAND_FILE_IN_USE"
        : "COMMAND_PERMISSION_DENIED",
    );
  }
}

/** Include idle native servers and terminals outside the Host, without matching every Node in a prefix. */
export async function cliProcessBusy(
  plan: AgentCliPlan,
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  run: typeof runInstallationCommand,
  canonical: (file: string) => Promise<string> = realpath,
  idleHostPids: readonly number[] = [],
): Promise<boolean> {
  const p = platform === "win32" ? path.win32 : path.posix;
  const normalize = (text: string) =>
    platform === "win32" ? text.replaceAll("\\", "/").toLowerCase() : text;
  const executable = normalize(plan.executable);
  const actual = normalize(await canonical(plan.executable));
  const packageRoot =
    plan.prefix && plan.packageName
      ? normalize(
          p.join(
            plan.prefix,
            ...(platform === "win32" ? [] : ["lib"]),
            "node_modules",
            ...plan.packageName.split("/"),
          ),
        ) + "/"
      : null;
  const output =
    platform === "win32"
      ? await run(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,ExecutablePath,CommandLine) | ConvertTo-Json -Compress",
          ],
          environment,
          5_000,
        )
      : await run("/bin/ps", ["-ww", "-axo", "pid=,ppid=,comm=,args="], environment, 5_000);
  const rows: { pid: number; parent: number; text: string }[] =
    platform === "win32"
      ? (
          [] as {
            ProcessId: number;
            ParentProcessId?: number;
            ExecutablePath?: string;
            CommandLine?: string;
          }[]
        )
          .concat(JSON.parse(output))
          .map((r) => ({
            pid: r.ProcessId,
            parent: r.ParentProcessId ?? 0,
            text: `${r.ExecutablePath ?? ""} ${r.CommandLine ?? ""}`,
          }))
      : output.split("\n").map((line) => {
          const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
          return { pid: Number(m?.[1]), parent: Number(m?.[2]), text: m?.[3] ?? "" };
        });
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const idleHosts = new Set(idleHostPids);
  const ownedByIdleHost = (pid: number): boolean => {
    const seen = new Set<number>();
    while (pid > 0 && !seen.has(pid)) {
      seen.add(pid);
      const branch = byPid.get(pid);
      if (!branch) return false;
      // Exclude only a CLI-rooted branch. A tool in another agent's session may itself run
      // this CLI; that is an external owner even though both descend from the same Host.
      if (idleHosts.has(branch.parent)) return matchesCli(branch.text);
      pid = branch.parent;
    }
    return false;
  };
  const contains = (text: string, target: string) => {
    let at = text.indexOf(target);
    while (at >= 0) {
      if (
        (at === 0 || /[\s"'=]/.test(text[at - 1] ?? "")) &&
        (target.endsWith("/") || /[\s"']/.test(text[at + target.length] ?? " "))
      )
        return true;
      at = text.indexOf(target, at + 1);
    }
    return false;
  };
  const matchesCli = (commandLine: string): boolean => {
    const text = normalize(commandLine);
    // Some native CLIs rewrite argv[0]/their process title to the bare command name.
    const shortName = normalize(p.basename(plan.executable)).replace(/\.(?:cmd|exe|bat)$/i, "");
    return (
      text.split(/\s+/)[0] === shortName ||
      [executable, actual, ...(packageRoot ? [packageRoot] : [])].some((target) =>
        contains(text, target),
      )
    );
  };
  return rows.some(
    (row) =>
      row.pid !== process.pid &&
      Number.isSafeInteger(row.pid) &&
      row.pid > 0 &&
      matchesCli(row.text) &&
      !ownedByIdleHost(row.pid),
  );
}

/** An absent explicit Hub proxy must leave npm's .npmrc/environment configuration intact. */
export function cliUpdateProxyEnvironment(
  env: NodeJS.ProcessEnv,
  proxy: string | null | undefined,
): NodeJS.ProcessEnv {
  return proxy
    ? {
        ...env,
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        http_proxy: proxy,
        https_proxy: proxy,
        npm_config_proxy: proxy,
        npm_config_https_proxy: proxy,
      }
    : { ...env };
}
