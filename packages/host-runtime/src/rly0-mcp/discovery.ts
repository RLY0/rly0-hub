import {
  mcpDigest as digest,
  matchesMcpOwnership,
  readMcpOwnership,
  writeMcpOwnership,
  type McpOwnership,
} from "./ownership.js";
import { redactMemoryText } from "../rly0-memory/redaction.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { parse, stringify } from "smol-toml";
import type { Rly0McpServer } from "@codexhost/shared-contracts";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { userHome } from "../rly0-skills/discovery.js";
import { backupAndWriteAtomic, resolveCodexHome } from "./file-io.js";
import { removeMcpServer } from "./toml-editor.js";
import { parseMcpServersForDisplay } from "./reader.js";

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export interface ExternalMcp {
  name: string;
  source: string;
  sourcePath: string;
  raw: Record<string, unknown>;
}
export function externalMcpLocations(env: NodeJS.ProcessEnv) {
  const home = userHome(env);
  return [
    ["claude", path.join(home, ".claude.json")],
    ["claude", path.join(env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"), ".claude.json")],
    ["cursor", path.join(home, ".cursor", "mcp.json")],
    ["gemini", path.join(home, ".gemini", "settings.json")],
    ["antigravity", path.join(home, ".gemini", "config", "mcp_config.json")],
  ] as const;
}
const controlFile = (env: NodeJS.ProcessEnv) =>
  path.join(resolveRly0DataDir(env), "bridge", "external-mcp-controls.json");
async function readControls(
  env: NodeJS.ProcessEnv,
): Promise<Record<string, "enabled" | "disabled" | "removed">> {
  const text = await fs.readFile(controlFile(env), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}";
    throw error;
  });
  const data: unknown = JSON.parse(text);
  if (
    !record(data) ||
    Object.values(data).some((v) => !["enabled", "disabled", "removed"].includes(String(v)))
  )
    throw new Error("GLOBAL_CONFIG_MCP_STATE_INVALID");
  return data as Record<string, "enabled" | "disabled" | "removed">;
}
export async function controlExternalMcp(
  env: NodeJS.ProcessEnv,
  name: string,
  state: "enabled" | "disabled" | "removed",
): Promise<boolean> {
  const entries = await externalMcp(env, true);
  if (!entries.some((v) => v.name === name)) return false;
  const current = await readCodexMcp(env);
  if (Object.hasOwn(current, name)) {
    const manifest = await readMcpOwnership(env);
    if (!matchesMcpOwnership(manifest[name], current[name])) return false;
  }
  const controls = await readControls(env);
  controls[name] = state;
  if (state === "enabled") {
    const manifest = await readMcpOwnership(env);
    if (manifest[name]?.disposed) {
      Reflect.deleteProperty(manifest, name);
      await writeMcpOwnership(env, manifest);
    }
  }
  const file = controlFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(controls), { flag: "wx", mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch(() => undefined);
  }
  return true;
}
export async function externalMcp(
  env: NodeJS.ProcessEnv,
  ignoreDisposition = false,
  unavailable: string[] = [],
): Promise<ExternalMcp[]> {
  const controls = await readControls(env);
  const ownership = await readMcpOwnership(env);
  const locations = externalMcpLocations(env);
  const result: ExternalMcp[] = [];
  const seen = new Set<string>();
  for (const [source, sourcePath] of locations) {
    try {
      const stat = await fs.lstat(sourcePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) continue;
      const data: unknown = JSON.parse(await fs.readFile(sourcePath, "utf8"));
      // Only user-level maps, never Claude's projects section or OAuth/credential stores.
      if (!record(data) || !record(data.mcpServers)) continue;
      for (const [name, raw] of Object.entries(data.mcpServers).slice(0, 64)) {
        if (
          !/^[A-Za-z0-9_-]{1,64}$/u.test(name) ||
          /^(?:codex_|rly0[-_])/u.test(name) ||
          ["__proto__", "constructor", "prototype"].includes(name) ||
          seen.has(name) ||
          !record(raw)
        )
          continue;
        // Untranslatable policies/auth must not be lost or silently enabled.
        const supported = new Set([
          "type",
          "command",
          "args",
          "env",
          "url",
          "serverUrl",
          "headers",
          "enabled",
          "disabled",
        ]);
        if (Object.keys(raw).some((key) => !supported.has(key))) continue;
        if (
          raw.type !== undefined &&
          !["stdio", "http", "sse", "streamable-http"].includes(String(raw.type))
        )
          continue;
        if (
          raw.args !== undefined &&
          (!Array.isArray(raw.args) || raw.args.some((v) => typeof v !== "string"))
        )
          continue;
        if (
          [raw.env, raw.headers].some(
            (v) =>
              v !== undefined &&
              (!record(v) || Object.values(v).some((x) => typeof x !== "string")),
          )
        )
          continue;
        const normalized = { ...raw };
        delete normalized.type;
        delete normalized.disabled;
        delete normalized.serverUrl;
        normalized.enabled = raw.enabled !== false && raw.disabled !== true;
        if (raw.url ?? raw.serverUrl) normalized.url = raw.url ?? raw.serverUrl;
        if (typeof normalized.command !== "string" && typeof normalized.url !== "string") continue;
        if (normalized.command && normalized.url) continue;
        if (normalized.url) {
          try {
            const url = new URL(String(normalized.url));
            if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
              continue;
          } catch {
            continue;
          }
        }
        if (controls[name]) normalized.enabled = controls[name] === "enabled";
        if (!ignoreDisposition && ownership[name]?.disposed) normalized.enabled = false;
        seen.add(name);
        result.push({ name, source, sourcePath, raw: normalized });
      }
    } catch (error) {
      /* Missing/malformed third-party files remain untouched and unavailable. */
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") unavailable.push(sourcePath);
    }
  }
  return result;
}
export function externalMcpDisplay(entry: ExternalMcp): Rly0McpServer {
  const view = parseMcpServersForDisplay(
    stringify({ mcp_servers: { [entry.name]: entry.raw } }),
  )[0];
  if (!view) throw new Error("GLOBAL_CONFIG_MCP_CONFIG_INVALID");
  return { ...view, source: entry.source, sourcePath: entry.sourcePath, external: true };
}
export async function readCodexMcp(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const file = path.join(resolveCodexHome(env), "config.toml");
  const text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const config: unknown = parse(text);
  return record(config) && record(config.mcp_servers) ? config.mcp_servers : {};
}

/** A bounded suspicion check; it deliberately favors process-only delivery over persistence. */
export function suspectedMcpCredentials(raw: Record<string, unknown>): boolean {
  if ([raw.env, raw.headers].some((v) => record(v) && Object.keys(v).length > 0)) return true;
  const text = JSON.stringify(raw);
  if (
    redactMemoryText(text).redacted ||
    /token|secret|password|api[_-]?key|authorization|bearer|\bkey\s*[=:]|\bgh[pousr]_|github_pat_/iu.test(
      text,
    )
  )
    return true;
  const args = Array.isArray(raw.args)
    ? raw.args.filter((v): v is string => typeof v === "string")
    : [];
  for (const value of [...args, ...(typeof raw.url === "string" ? [raw.url] : [])]) {
    if (/^https?:\/\//iu.test(value)) {
      try {
        const url = new URL(value);
        if (
          url.search ||
          url.hash ||
          url.pathname
            .split("/")
            .some(
              (v) =>
                /%[0-9a-f]{2}/iu.test(v) ||
                /^(?:key|auth)$/iu.test(v) ||
                /^[A-Za-z0-9_+=-]{24,}$/u.test(v),
            )
        )
          return true;
      } catch {
        return true;
      }
    } else if (/^[A-Za-z0-9_+=/-]{24,}$/u.test(value) && !value.startsWith("--")) return true;
  }
  return false;
}

/** Exclude each assistant's own user configuration, including its imported Codex mirrors. */
export async function sharedMcpEntries(
  env: NodeJS.ProcessEnv,
  native: Record<string, unknown>,
  harnessId?: string,
): Promise<Record<string, unknown>> {
  const external = await externalMcp(env);
  const ownership = await readMcpOwnership(env);
  const ownSource = (source: string) =>
    source === harnessId ||
    (source === "claude" && harnessId === "claude-code") ||
    (source === "cursor" && harnessId === "cursor-cli") ||
    (source === "antigravity" && harnessId === "agy");
  const ownNames = new Set(external.filter((v) => ownSource(v.source)).map((v) => v.name));
  const combined: Record<string, unknown> = Object.create(null);
  for (const entry of external) if (!ownNames.has(entry.name)) combined[entry.name] = entry.raw;
  for (const [name, value] of Object.entries(native)) {
    const origin = externalMcpLocations(env).find(
      ([, file]) => file === ownership[name]?.sourcePath,
    )?.[0];
    if (
      ownNames.has(name) ||
      (origin && ownSource(origin) && matchesMcpOwnership(ownership[name], value))
    )
      continue;
    // An unchanged mirror takes its current options/disposition from the installer source.
    if (matchesMcpOwnership(ownership[name], value) && Object.hasOwn(combined, name)) continue;
    combined[name] = value;
  }
  return combined;
}

/** Credential-bearing configurations are process-only; persist only credential-free copies. */
export async function syncExternalMcp(
  env: NodeJS.ProcessEnv,
  enabled: boolean,
  unavailable: string[] = [],
): Promise<void> {
  const file = path.join(resolveCodexHome(env), "config.toml");
  const old = await readMcpOwnership(env);
  const controls = await readControls(env);
  const external = enabled ? await externalMcp(env, false, unavailable) : [];
  if (!external.length && !Object.keys(old).length) return;
  const targetStat = await fs.lstat(file).catch(() => null);
  if (
    targetStat &&
    (!targetStat.isFile() ||
      targetStat.isSymbolicLink() ||
      targetStat.nlink > 1 ||
      targetStat.size > 512 * 1024)
  )
    throw new Error("GLOBAL_CONFIG_MCP_CONFIG_INVALID");
  let text = await fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  if (Buffer.byteLength(text) > 512 * 1024) throw new Error("GLOBAL_CONFIG_MCP_CONFIG_INVALID");
  let current: Record<string, unknown>;
  try {
    current = await readCodexMcp(env);
  } catch {
    throw new Error("GLOBAL_CONFIG_MCP_CONFIG_INVALID");
  }
  const originalText = text;
  const wanted = new Map(
    external
      .filter((v) => controls[v.name] !== "removed" && !suspectedMcpCredentials(v.raw))
      .map((v) => [v.name, v]),
  );
  const next: Record<string, McpOwnership> = Object.create(null);
  for (const [name, value] of Object.entries(old)) {
    if (enabled && unavailable.includes(value.sourcePath)) {
      // Keep the last known copy and its disposition until the original can be read again.
      next[name] = value;
      wanted.delete(name);
      continue;
    }
    if (value.disposed || !matchesMcpOwnership(value, current[name])) {
      // Keep a tombstone across scans: missing/edited is an explicit user disposition.
      next[name] = { ...value, disposed: true };
      wanted.delete(name);
      continue;
    }
    const source = wanted.get(name);
    if (source && digest(source.raw) === digest(current[name])) {
      next[name] = { digest: digest(source.raw), sourcePath: source.sourcePath, digestVersion: 2 };
      continue;
    }
    text = removeMcpServer(text, name);
    Reflect.deleteProperty(current, name);
    if (!source) continue;
  }
  for (const [name, entry] of wanted) {
    if (Object.hasOwn(current, name)) continue;
    text += `\n${stringify({ mcp_servers: { [name]: entry.raw } })}`;
    next[name] = { digest: digest(entry.raw), sourcePath: entry.sourcePath, digestVersion: 2 };
  }
  const before = await fs.readFile(file, "utf8").catch(() => "");
  if (before !== originalText) throw new Error("GLOBAL_CONFIG_MCP_CHANGED");
  if (text !== before) await backupAndWriteAtomic(file, text);
  if (!Object.keys(next).length && !Object.keys(old).length) return;
  await writeMcpOwnership(env, next);
}
