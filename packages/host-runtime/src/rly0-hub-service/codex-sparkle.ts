import { codexPreferences, restoreCodexCheckPreferences } from "./codex-check-preferences.js";
import { CodexSkippedVersion, compareSparkleBuilds } from "./codex-skipped-version.js";
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

export interface CodexAppcastUpdate {
  version: string;
  build: string | null;
  minimumAutoupdateVersion?: string;
  ignoreSkippedUpgradesBelowVersion?: string;
}
export function parseCodexAppcastUpdates(
  xml: string,
  systemVersion?: string,
): CodexAppcastUpdate[] {
  return [...xml.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gu)].flatMap(([block]) => {
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
    const build =
      /<sparkle:version>\s*([\d.]+)\s*<\//u.exec(block)?.[1] ??
      /sparkle:version="([\d.]+)"/u.exec(block)?.[1] ??
      null;
    if (build !== null && !/^\d+(?:\.\d+)*$/u.test(build)) throw new Error("CODEX_APPCAST_FAILED");
    const upgrade: Pick<
      CodexAppcastUpdate,
      "minimumAutoupdateVersion" | "ignoreSkippedUpgradesBelowVersion"
    > = {};
    for (const key of ["minimumAutoupdateVersion", "ignoreSkippedUpgradesBelowVersion"] as const) {
      const value = new RegExp(`<sparkle:${key}>\\s*([\\d.]+)\\s*<\\/`, "u").exec(block)?.[1];
      if (block.includes(`<sparkle:${key}`) && (!value || !/^\d+(?:\.\d+)*$/u.test(value)))
        throw new Error("CODEX_APPCAST_FAILED");
      if (value) upgrade[key] = value;
    }
    return [{ version, build, ...upgrade }];
  });
}
export function parseCodexAppcast(xml: string, systemVersion?: string): string[] {
  const versions = parseCodexAppcastUpdates(xml, systemVersion).map((update) => update.version);
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
  onUpdates?: (updates: CodexAppcastUpdate[], eligible: CodexAppcastUpdate[]) => void;
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
    options.onUpdates?.(
      parseCodexAppcastUpdates(xml),
      parseCodexAppcastUpdates(xml, options.systemVersion),
    );
    return latest;
  } finally {
    response.cancel();
  }
}

/** A Launcher process line from `ps -axo args=`: `…/bin/codexhost` or `…/bin/codexhost launch …`. */
export function codexLauncherProcess(line: string): boolean {
  return /\/bin\/codexhost(?:\s+launch(?:\s.*)?)?$/u.test(line.trim());
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
  const preferences = codexPreferences(exec);
  const { read, write, readBoolean } = preferences;
  const skipped = new CodexSkippedVersion(resolveRly0DataDir(options.environment), preferences);
  const cache = new Map<string, string>();
  let updates: CodexAppcastUpdate[] = [];
  let eligibleUpdates: CodexAppcastUpdate[] = [];
  let versions: string[] = [];
  let eligibleVersions: string[] = [];
  let feedIdentity: string | null = null;
  let lastRevalidatedAt = -Infinity;
  const lastFailedProbes = new Map<string, number>();
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
    hasVersionAlertHold: () => skipped.pending(),
    hasUnconfirmedVersionAlertHold: () => skipped.unconfirmed(),
    restoreVersionAlerts: () => skipped.restore(),
    async holdVersionAlerts(current) {
      const newer = updates.filter((update) => compareCodexVersions(update.version, current) > 0);
      if (!newer.length) return;
      const builds = newer
        .map((update) => {
          if (!update.build) throw new Error("CODEX_APPCAST_FAILED");
          return update.build;
        })
        .sort((a, b) => compareSparkleBuilds(b, a));
      await skipped.hold(builds[0] ?? "");
    },
    async isVersionSkipped(version) {
      const candidates = eligibleUpdates.filter(
        (update) => compareCodexVersions(update.version, version) === 0,
      );
      if (!candidates.length) throw new Error("CODEX_APPCAST_FAILED");
      const userSkip = await skipped.userSkip();
      const remaining = candidates.filter((update) => {
        if (!update.build) throw new Error("CODEX_APPCAST_FAILED");
        return userSkip === null || compareSparkleBuilds(userSkip, update.build) < 0;
      });
      if (!remaining.length) return true;
      if (remaining.some((update) => !update.minimumAutoupdateVersion)) return false;
      // Sparkle 2.9.1 SUAppcastDriver containsSkippedUpdate: also compares the installed build
      // against the skipped major's minimum-autoupdate build, never the display-version family.
      const major = await preferences.readScalar("SUSkippedMajorVersion");
      if (major?.type !== "string") return false;
      const app = (await runningBundle()) ?? (await readLauncherCodexBundle(options.environment));
      if (!app) throw new Error("CODEX_PREFERENCES_FAILED");
      const installedBuild = await exec("/usr/bin/plutil", [
        "-extract",
        "CFBundleVersion",
        "raw",
        path.join(app, "Contents/Info.plist"),
      ]);
      if (compareSparkleBuilds(installedBuild, major.value) >= 0) return false;
      const subrelease = remaining.some((update) => update.ignoreSkippedUpgradesBelowVersion)
        ? await preferences.readScalar("SUSkippedMajorSubreleaseVersion")
        : null;
      return remaining.every(
        (update) =>
          update.minimumAutoupdateVersion !== undefined &&
          compareSparkleBuilds(major.value, update.minimumAutoupdateVersion) >= 0 &&
          (!update.ignoreSkippedUpgradesBelowVersion ||
            (subrelease?.type === "string" &&
              compareSparkleBuilds(subrelease.value, update.ignoreSkippedUpgradesBelowVersion) >=
                0)),
      );
    },
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
        onUpdates: (offered, eligible) => {
          updates = offered;
          eligibleUpdates = eligible;
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
    async launcherRunning() {
      // The development Hub's wrapper refuses to start while any `bin/codexhost launch` runs; the
      // packaged Hub starts its Launcher as a bare `bin/codexhost`. Subcommands are short-lived.
      const processes = await exec("/bin/ps", ["-axo", "args="]);
      return processes.split("\n").some((line) => codexLauncherProcess(line));
    },
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
