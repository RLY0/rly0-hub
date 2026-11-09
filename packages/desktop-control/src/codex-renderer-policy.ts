import { readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { codexRendererPolicySchema, type CodexRendererPolicy } from "@codexhost/shared-contracts";
const CORE: CodexRendererPolicy = { schemaVersion: 1, mode: "core", disabled: [] };
/** Hub publishes only a policy, never code or a remote URL to evaluate. */
export async function readCodexRendererPolicy(
  environment = process.env,
): Promise<CodexRendererPolicy> {
  const directory = environment.CODEXHOST_DATA_DIR ?? path.join(os.homedir(), ".rly0-hub");
  try {
    const bytes = await readFile(path.join(directory, "codex-renderer-policy.json"));
    if (bytes.length > 16 * 1024) return CORE;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("policy" in value) ||
      !("desktopVersion" in value)
    )
      return CORE;
    const expected = environment.CODEXHOST_CODEX_VERSION;
    if (!expected || value.desktopVersion !== expected) return CORE;
    return codexRendererPolicySchema.parse(value.policy);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return CORE;
    try {
      return codexRendererPolicySchema.parse(
        JSON.parse(environment.CODEXHOST_RENDERER_POLICY ?? "null"),
      );
    } catch {
      return CORE;
    }
  }
}
export function rendererPolicyBootstrap(policy: CodexRendererPolicy): string {
  return `globalThis.__codexhostFeaturePolicyV1 = ${JSON.stringify(policy)};`;
}
