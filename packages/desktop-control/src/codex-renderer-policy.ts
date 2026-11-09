import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  codexRendererPolicySchema,
  compareCodexVersions,
  type CodexRendererPolicy,
} from "@codexhost/shared-contracts";
const CORE: CodexRendererPolicy = { schemaVersion: 1, mode: "core", disabled: [] };
/** Launcher records the inspected identity before spawning Controller, including direct launches.
 * Match the actual parent PID, never the latest unrelated historical successful launch. */
export async function readLauncherCodexVersion(
  environment: NodeJS.ProcessEnv,
  parentPid = process.ppid,
): Promise<string | null> {
  const directory =
    environment.CODEXHOST_DATA_DIR && path.isAbsolute(environment.CODEXHOST_DATA_DIR)
      ? environment.CODEXHOST_DATA_DIR
      : path.join(environment.HOME ?? os.homedir(), ".codexhost");
  try {
    const bytes = await readFile(path.join(directory, "diagnostics", "launcher-startup-v1.json"));
    if (bytes.length > 256 * 1024) return null;
    const raw = JSON.parse(bytes.toString("utf8"));
    if (raw.schemaVersion !== 1 || !Array.isArray(raw.records)) return null;
    // The Launcher inserts newest first; a reused PID must resolve to the newest record.
    const record = raw.records.find((record: { pid?: unknown }) => record.pid === parentPid);
    const version: unknown = record?.desktop?.version;
    return typeof version === "string" && /^\d+(?:\.\d+)+$/u.test(version) ? version : null;
  } catch {
    return null;
  }
}
/** Hub publishes only a policy, never code or a remote URL to evaluate. */
export async function readCodexRendererPolicy(
  environment = process.env,
  readVersion = () => readLauncherCodexVersion(environment),
): Promise<CodexRendererPolicy> {
  const directory =
    environment.CODEXHOST_DATA_DIR ?? path.join(environment.HOME ?? os.homedir(), ".rly0-hub");
  let bytes: Buffer;
  try {
    bytes = await readFile(path.join(directory, "codex-renderer-policy.json"));
  } catch (error) {
    // A runtime I/O failure is not a policy transition. The stateful reader retains its last policy.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    try {
      return codexRendererPolicySchema.parse(
        JSON.parse(environment.CODEXHOST_RENDERER_POLICY ?? "null"),
      );
    } catch {
      return CORE;
    }
  }
  try {
    if (bytes.length > 16 * 1024) return CORE;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("policy" in value) ||
      !("desktopVersion" in value)
    )
      return CORE;
    // A current Launcher identity takes precedence over a possibly inherited Hub environment.
    const expected = (await readVersion()) ?? environment.CODEXHOST_CODEX_VERSION;
    if (
      !expected ||
      typeof value.desktopVersion !== "string" ||
      compareCodexVersions(value.desktopVersion, expected) !== 0
    )
      return CORE;
    return codexRendererPolicySchema.parse(value.policy);
  } catch {
    return CORE;
  }
}
/** Startup defaults to core; transient filesystem errors during a session preserve its policy. */
export function createCodexRendererPolicyReader(read = () => readCodexRendererPolicy()) {
  let current = CORE;
  return async () => {
    try {
      current = await read();
    } catch {
      /* Keep last known policy. */
    }
    return current;
  };
}
export function rendererPolicyBootstrap(policy: CodexRendererPolicy): string {
  return `globalThis.__codexhostFeaturePolicyV1 = ${JSON.stringify(policy)};`;
}
