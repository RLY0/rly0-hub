import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

export interface McpOwnership {
  digest: string;
  sourcePath: string;
  disposed?: boolean;
  digestVersion?: 2;
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(value) ?? "null")
    .digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical); // argv order is significant.
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .filter(
        ([key, child]) =>
          !(["env", "headers"].includes(key) && record(child) && Object.keys(child).length === 0),
      )
      .map(([key, child]) => [key, canonical(child)]),
  );
}
/** TOML may move empty env/header tables and reorder keys; these are not user dispositions. */
export const mcpDigest = (value: unknown) => hash(canonical(value));
export function matchesMcpOwnership(owner: McpOwnership | undefined, value: unknown): boolean {
  if (!owner) return false;
  if (owner.digestVersion === 2) return owner.digest === mcpDigest(value);
  if (owner.digest === hash(value)) return true;
  if (!record(value)) return false;
  // Legacy hashes included insertion order. Only the two known empty transport maps can move
  // behind scalar TOML keys; enumerate those bounded interleavings without ignoring any value.
  const entries = Object.entries(value);
  const empty = entries.filter(
    ([key, child]) =>
      ["env", "headers"].includes(key) && record(child) && Object.keys(child).length === 0,
  );
  const scalar = entries.filter((entry) => !empty.includes(entry));
  let variants = [scalar];
  for (const entry of empty) {
    const next = [...variants];
    for (const variant of variants)
      for (let index = 0; index <= variant.length; index++)
        next.push([...variant.slice(0, index), entry, ...variant.slice(index)]);
    variants = next;
  }
  return variants.some((variant) => owner.digest === hash(Object.fromEntries(variant)));
}
const manifestFile = (env: NodeJS.ProcessEnv) =>
  path.join(resolveRly0DataDir(env), "bridge", "external-mcp.json");
export async function readMcpOwnership(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, McpOwnership>> {
  const text = await fs
    .readFile(manifestFile(env), "utf8")
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "{}";
      throw error;
    });
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.values(value).some(
      (v) =>
        typeof v !== "object" ||
        v === null ||
        typeof v.digest !== "string" ||
        typeof v.sourcePath !== "string" ||
        (v.disposed !== undefined && typeof v.disposed !== "boolean") ||
        (v.digestVersion !== undefined && v.digestVersion !== 2),
    )
  )
    throw new Error("GLOBAL_CONFIG_MCP_MANIFEST_INVALID");
  return value as Record<string, McpOwnership>;
}
export async function writeMcpOwnership(
  env: NodeJS.ProcessEnv,
  value: Record<string, McpOwnership>,
) {
  const file = manifestFile(env);
  const text = JSON.stringify(value);
  if ((await fs.readFile(file, "utf8").catch(() => "")) === text) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text, { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
}
