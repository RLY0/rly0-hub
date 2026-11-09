import { restoreCodexCheckPreferences } from "./codex-check-preferences.js";
import { parseLsappinfoBundlePath, readLauncherCodexBundle } from "./codex-bundle-location.js";
import { createHash } from "node:crypto";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import {
  acquireCodexUpdateControl,
  codexNativeUpdateControlAllowed,
} from "./codex-update-control.js";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareCodexVersions } from "@codexhost/shared-contracts";
import type { CodexUpdateDriver } from "./codex-update-manager.js";
import type { UpdateHttpGet } from "./hub-update-net.js";

export function parseCodexAppcast(xml: string, systemVersion?: string): string[] {
  const versions = [...xml.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gu)].flatMap(([block]) => {
    if (!/<enclosure(?:\s|\/?>)/u.test(block)) return [];
    const version =
      /<sparkle:shortVersionString>\s*([\d.]+)\s*<\//u.exec(block)?.[1] ??
      /sparkle:shortVersionString="([\d.]+)"/u.exec(block)?.[1];
    // A short version is required to map Sparkle build versions to our compatibility families.
    // Never silently remove an unknown enclosure from the authorization decision.
    if (!version || !/^\d+(?:\.\d+)+$/u.test(version)) throw new Error("CODEX_APPCAST_FAILED");
    const minimum = /<sparkle:minimumSystemVersion>\s*([\d.]+)\s*<\//u.exec(block)?.[1];
    if (/<sparkle:minimumSystemVersion/u.test(block) && !minimum)
      throw new Error("CODEX_APPCAST_FAILED");
    if (minimum && systemVersion && compareCodexVersions(systemVersion, minimum) < 0) return [];
    return [version];
  });
  return [...new Set(versions)].sort((a, b) => compareCodexVersions(b, a));
}
export async function latestCodexAppcast(options: {
  environment: NodeJS.ProcessEnv;
  current: string;
  get: UpdateHttpGet;
  arch?: string;
  onVersions?: (versions: string[]) => void;
  systemVersion?: string;
  onFeed?: (identity: string) => void;
  onEligibleVersions?: (versions: string[]) => void;
}): Promise<string> {
  const home = options.environment.HOME ?? os.homedir();
  const bootstrap: unknown = JSON.parse(
    await fs.readFile(
      path.join(
        home,
        "Library/Application Support/com.openai.codex/production-appcast-bootstrap.json",
      ),
      "utf8",
    ),
  );
  const id =
    typeof bootstrap === "object" && bootstrap !== null && "installationId" in bootstrap
      ? bootstrap.installationId
      : null;
  if (typeof id !== "string" || id.length < 1 || id.length > 200)
    throw new Error("CODEX_APPCAST_FAILED");
  const query = new URLSearchParams({
    installation_id: id,
    arch: (options.arch ?? process.arch) === "x64" ? "x86_64" : "arm64",
    app_version: options.current,
    beta: "false",
  });
  const response = await options.get(`https://updates.oaistatic.com/codex/app/appcast?${query}`, {
    accept: "application/xml",
    "user-agent": `Codex/${options.current} Sparkle`,
  });
  try {
    if (response.status !== 200) throw new Error("CODEX_APPCAST_FAILED");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 1024 * 1024) throw new Error("CODEX_APPCAST_FAILED");
      chunks.push(Buffer.from(chunk));
    }
    const xml = Buffer.concat(chunks).toString("utf8");
    const versions = parseCodexAppcast(xml);
    options.onEligibleVersions?.(parseCodexAppcast(xml, options.systemVersion));
    options.onFeed?.(createHash("sha256").update(xml).digest("hex"));
    options.onVersions?.(versions);
    const latest = versions[0];
    if (!latest) throw new Error("CODEX_APPCAST_FAILED");
    return latest;
  } finally {
    response.cancel();
  }
}

export type SparkleExec = (file: string, args: string[]) => Promise<string>;
function nativeExec(environment: NodeJS.ProcessEnv): SparkleExec {
  return (file, args) =>
    new Promise((resolve, reject) => {
      // defaults/cfprefsd is per login session, not isolated by HOME. Unit tests MUST inject exec.
      if (!codexNativeUpdateControlAllowed(environment)) {
        reject(new Error("CODEX_UPDATER_TEST_ISOLATION"));
        return;
      }
      execFile(
        file,
        args,
        {
          env: environment,
          timeout: file === "/usr/bin/codesign" ? 120_000 : 15_000,
          // `ps -axo args=` lists every process with its full command line.
          maxBuffer: 8 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) reject(Object.assign(new Error("CODEX_NATIVE_COMMAND_FAILED"), { stderr }));
          else resolve(stdout.trim());
        },
      );
    });
}
/** Reads only Sparkle's staging cache. Never copies, patches or installs an App bundle. */
export async function stagedSparkleUpdate(
  home: string,
  version: string,
  exec: SparkleExec,
  cache?: Map<string, string>,
): Promise<boolean> {
  const root = path.join(
    home,
    "Library/Caches/com.openai.codex/org.sparkle-project.Sparkle/Installation",
  );
  let budget = 256;
  const visit = async (directory: string, depth: number): Promise<boolean> => {
    if (depth > 5 || --budget < 0) return false;
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name.endsWith(".app")) {
        try {
          const plist = path.join(child, "Contents/Info.plist");
          if (
            (await exec("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", plist])) !==
            "com.openai.codex"
          )
            continue;
          const stagedVersion = await exec("/usr/bin/plutil", [
            "-extract",
            "CFBundleShortVersionString",
            "raw",
            plist,
          ]);
          if (compareCodexVersions(stagedVersion, version) !== 0) continue;
          const stat = await fs.stat(child);
          const info = await fs.stat(plist).catch(() => null);
          const fingerprint = JSON.stringify([
            stat.dev,
            stat.ino,
            stat.mtimeMs,
            info?.mtimeMs,
            info?.size,
            stagedVersion,
          ]);
          if (cache?.get(child) !== fingerprint) {
            await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", child]);
            cache?.set(child, fingerprint);
          }
          return true;
        } catch {
          /* Incomplete staging is not readiness. */
        }
      } else if (await visit(child, depth + 1)) return true;
    }
    return false;
  };
  return visit(root, 0);
}
export function createMacCodexUpdateDriver(options: {
  environment: NodeJS.ProcessEnv;
  get: () => Promise<UpdateHttpGet>;
  currentVersion: () => Promise<string | null>;
  reopen: () => Promise<boolean>;
  healthy: () => Promise<boolean>;
  exec?: SparkleExec;
  startWatchdog?: (file: string, id: string, exited?: () => void) => Promise<void>;
}): CodexUpdateDriver {
  const exec = options.exec ?? nativeExec(options.environment);
  const domain = "com.openai.codex";
  const cache = new Map<string, string>();
  let versions: string[] = [];
  let eligibleVersions: string[] = [];
  let feedIdentity: string | null = null;
  let lastRevalidatedAt = -Infinity;
  const lastFailedProbes = new Map<string, number>();
  const read = async (key: string): Promise<string | null> => {
    try {
      return await exec("/usr/bin/defaults", ["read", domain, key]);
    } catch (error) {
      if (/does not exist/u.test(String((error as { stderr?: unknown }).stderr))) return null;
      throw error;
    }
  };
  const readBoolean = async (key: string) => {
    const value = await read(key);
    if (value === null) return null;
    if (value !== "0" && value !== "1") throw new Error("CODEX_PREFERENCES_FAILED");
    return value === "1";
  };
  const write = async (key: string, value: string | boolean | null) => {
    if (value === null) {
      try {
        await exec("/usr/bin/defaults", ["delete", domain, key]);
      } catch (error) {
        if (!/does not exist/u.test(String((error as { stderr?: unknown }).stderr))) throw error;
      }
    } else
      await exec("/usr/bin/defaults", [
        "write",
        domain,
        key,
        typeof value === "boolean" ? "-bool" : "-date",
        String(value),
      ]);
  };
  const isRunning = async () => {
    const result = await exec("/usr/bin/osascript", [
      "-e",
      'application id "com.openai.codex" is running',
    ]);
    if (result !== "true" && result !== "false") throw new Error("CODEX_PROCESS_STATE_INVALID");
    return result === "true";
  };
  let bundle: string | null = null;
  const runningBundle = async () => {
    try {
      // A successful but empty answer means Codex is not running: nothing to quit.
      return parseLsappinfoBundlePath(
        await exec("/usr/bin/lsappinfo", ["info", "-only", "bundlepath", "-app", domain]),
      );
    } catch {
      /* Fall back to the Launcher's record of the inspected bundle. */
    }
    return readLauncherCodexBundle(options.environment);
  };
  return {
    acquireControl: () =>
      acquireCodexUpdateControl(resolveRly0DataDir(options.environment), {
        processStart: (pid) =>
          // Locale-free (LC_ALL=C) so Hubs started with different locales compare equal.
          exec("/usr/bin/env", ["LC_ALL=C", "/bin/ps", "-o", "lstart=", "-p", String(pid)]).then(
            (started) => started || null,
            () => null,
          ),
      }),
    watchLease:
      options.startWatchdog ??
      ((file, id, exited) =>
        new Promise<void>((resolve, reject) => {
          if (process.env.VITEST || process.env.NODE_ENV === "test") {
            reject(new Error("CODEX_UPDATER_TEST_ISOLATION"));
            return;
          }
          const child = spawn(
            process.execPath,
            [fileURLToPath(new URL("./codex-update-watchdog.js", import.meta.url)), file, id],
            {
              env: options.environment,
              detached: true,
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            },
          );
          const timer = setTimeout(() => {
            if (child.connected) child.disconnect();
            child.unref();
            reject(new Error("CODEX_WATCHDOG_UNAVAILABLE"));
          }, 10_000);
          child.once("error", () => {
            clearTimeout(timer);
            reject(new Error("CODEX_WATCHDOG_UNAVAILABLE"));
          });
          child.once("exit", () => {
            exited?.();
            clearTimeout(timer);
            reject(new Error("CODEX_WATCHDOG_UNAVAILABLE"));
          });
          child.once("message", (message) => {
            if (
              typeof message === "object" &&
              message !== null &&
              "ready" in message &&
              message.ready === true
            ) {
              clearTimeout(timer);
              child.unref();
              resolve();
            }
          });
        })),
    readAutoUpdate: () => readBoolean("SUAutomaticallyUpdate"),
    writeAutoUpdate: (value) => write("SUAutomaticallyUpdate", value),
    async readCheckPreferences() {
      return {
        automaticChecks: await readBoolean("SUEnableAutomaticChecks"),
        lastCheckTime: await read("SULastCheckTime"),
      };
    },
    async restoreCheckPreferences(value) {
      await restoreCodexCheckPreferences(value, read, write);
    },
    currentVersion: options.currentVersion,
    feedIdentity: () => feedIdentity,
    latestVersion: async (current) =>
      latestCodexAppcast({
        systemVersion: await exec("/usr/bin/sw_vers", ["-productVersion"]),
        onEligibleVersions: (eligible) => {
          eligibleVersions = eligible;
        },
        onFeed: (identity) => {
          feedIdentity = identity;
        },
        environment: options.environment,
        current,
        get: await options.get(),
        onVersions: (offered) => {
          versions = offered;
        },
      }),
    availableVersions: async () => versions,
    installableVersions: () => eligibleVersions,
    async requestCheck() {
      // Sparkle's documented scheduled-check path. No menu/foreground check, fake
      // launch argument or App bundle edit. Manager waits idle, then quits/reopens.
      await write("SUEnableAutomaticChecks", true);
      await write("SULastCheckTime", null);
    },
    async downloadReady(version, revalidate = false) {
      // Revalidate at most once per short quit window, and immediately on identity changes.
      if (revalidate && performance.now() - lastRevalidatedAt > 15_000) {
        cache.clear();
        lastRevalidatedAt = performance.now();
      }
      if (!revalidate && Date.now() - (lastFailedProbes.get(version) ?? -Infinity) < 30_000)
        return false;
      const ready = await stagedSparkleUpdate(
        options.environment.HOME ?? os.homedir(),
        version,
        exec,
        cache,
      );
      if (!ready) lastFailedProbes.set(version, Date.now());
      return ready;
    },
    async quit() {
      // Record the running bundle before quitting; after quit only non-launching sources remain.
      const app = await runningBundle();
      if (!app) throw new Error("CODEX_INSTALLATION_UNAVAILABLE");
      bundle = app;
      // The guard keeps a Desktop that already exited from being launched by the quit event.
      await exec("/usr/bin/osascript", [
        "-e",
        'if application id "com.openai.codex" is running then tell application id "com.openai.codex" to quit',
      ]);
    },
    isRunning,
    async installationStopped() {
      if (await isRunning()) return false;
      // Resolve the bundle recorded while it ran (or by the Launcher), never by a query that
      // can launch the application, such as AppleScript `path to application`.
      const app = bundle ?? (await readLauncherCodexBundle(options.environment));
      if (!app) throw new Error("CODEX_INSTALLATION_UNAVAILABLE");
      const processes = await exec("/bin/ps", ["-axo", "args="]);
      return !processes
        .split("\n")
        .some(
          (line) =>
            (line.includes(`${app}/Contents/`) ||
              line.includes("/com.openai.codex/org.sparkle-project.Sparkle/")) &&
            /\/(?:Autoupdate|Updater\.app\/Contents\/MacOS\/Updater)(?:\s|$)/u.test(line),
        );
    },
    reopen: options.reopen,
    healthy: options.healthy,
  };
}
