import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { compareCodexVersions } from "@codexhost/shared-contracts";
import type { CodexUpdateDriver } from "./codex-update-manager.js";
import type { UpdateHttpGet } from "./hub-update-net.js";

export function parseCodexAppcast(xml: string): string[] {
  const versions = [...xml.matchAll(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gu)].flatMap(([block]) => {
    if (!/<enclosure\s/u.test(block)) return [];
    const version =
      /<sparkle:shortVersionString>\s*([\d.]+)\s*<\//u.exec(block)?.[1] ??
      /sparkle:shortVersionString="([\d.]+)"/u.exec(block)?.[1];
    return version && /^\d+(?:\.\d+)+$/u.test(version) ? [version] : [];
  });
  return [...new Set(versions)].sort((a, b) => compareCodexVersions(b, a));
}
export async function latestCodexAppcast(options: {
  environment: NodeJS.ProcessEnv;
  current: string;
  get: UpdateHttpGet;
  arch?: string;
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
    const latest = parseCodexAppcast(Buffer.concat(chunks).toString("utf8"))[0];
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
      if (process.env.VITEST || process.env.NODE_ENV === "test") {
        reject(new Error("CODEX_UPDATER_TEST_ISOLATION"));
        return;
      }
      execFile(
        file,
        args,
        { env: environment, timeout: 15_000, maxBuffer: 256 * 1024 },
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
          if (
            (await exec("/usr/bin/plutil", [
              "-extract",
              "CFBundleShortVersionString",
              "raw",
              plist,
            ])) !== version
          )
            continue;
          await exec("/usr/bin/codesign", ["--verify", "--deep", "--strict", child]);
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
}): CodexUpdateDriver {
  const exec = options.exec ?? nativeExec(options.environment);
  const defaults = ["com.openai.codex", "SUAutomaticallyUpdate"];
  return {
    async readAutoUpdate() {
      try {
        const value = await exec("/usr/bin/defaults", ["read", ...defaults]);
        if (value !== "0" && value !== "1") throw new Error("CODEX_PREFERENCES_FAILED");
        return value === "1";
      } catch (error) {
        const stderr = (error as { stderr?: unknown }).stderr;
        if (typeof stderr === "string" && /does not exist/u.test(stderr)) return null;
        throw error;
      }
    },
    async writeAutoUpdate(value) {
      if (value === null) {
        // Deleting an already absent key is idempotent; other errors must remain visible.
        try {
          await exec("/usr/bin/defaults", ["delete", ...defaults]);
        } catch (error) {
          if (!/does not exist/u.test(String((error as { stderr?: unknown }).stderr))) throw error;
        }
      } else await exec("/usr/bin/defaults", ["write", ...defaults, "-bool", String(value)]);
    },
    currentVersion: options.currentVersion,
    latestVersion: async (current) =>
      latestCodexAppcast({ environment: options.environment, current, get: await options.get() }),
    async requestCheck() {
      // Codex has no documented update CLI. Invoke its real menu command, without fake arguments.
      // Missing menu / Accessibility permission is an explicit failure; no force launch fallback.
      await exec("/usr/bin/osascript", [
        "-e",
        `tell application "System Events"
set apps to every application process whose bundle identifier is "com.openai.codex"
if (count of apps) is not 1 then error "Codex not running"
tell item 1 of apps
set candidates to every menu item of menu 1 of menu bar item 1 of menu bar 1 whose name contains "Check for Updates"
if (count of candidates) is 0 then set candidates to every menu item of menu 1 of menu bar item 1 of menu bar 1 whose name contains "检查更新"
if (count of candidates) is not 1 then error "Codex update command unavailable"
click item 1 of candidates
end tell
end tell`,
      ]);
    },
    downloadReady: (version) =>
      stagedSparkleUpdate(options.environment.HOME ?? os.homedir(), version, exec),
    async quit() {
      await exec("/usr/bin/osascript", ["-e", 'tell application id "com.openai.codex" to quit']);
    },
    async installationStopped() {
      const processes = await exec("/bin/ps", ["-axo", "args="]);
      if (
        /(?:^|\n).*\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/u.test(
          processes,
        )
      )
        return false;
      // A different Sparkle installer may delay recovery; never reopen during an installer.
      return !/(?:^|\n).*\/(?:Autoupdate|Updater\.app\/Contents\/MacOS\/Updater)(?:\s|$)/u.test(
        processes,
      );
    },
    reopen: options.reopen,
    healthy: options.healthy,
  };
}
