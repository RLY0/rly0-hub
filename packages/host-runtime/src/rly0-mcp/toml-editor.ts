/**
 * Minimal, format- and comment-preserving line-level editor for the `[mcp_servers.*]` tables in
 * a Codex `config.toml`.
 *
 * Why not a full TOML AST library: `smol-toml` (already a dependency elsewhere in this repo, see
 * `packages/adapters/kimi-code`) parses and stringifies but does not round-trip comments or
 * formatting — a full re-serialize would silently drop every comment and reformat the whole file.
 * A CST-preserving editor (e.g. `@ltd/j-toml` in "no reformat" mode, or a `toml-eslint-parser`
 * based codemod) is the "correct" general answer, but it is a new, fairly heavy dependency for a
 * narrow need: this feature only ever touches whole `[mcp_servers.<name>]` blocks (add / remove)
 * or a single `enabled = ...` line inside one. A dependency-free line editor that only recognizes
 * TOML *table headers* (`[...]` / `[[...]]`) and never attempts to parse arbitrary values keeps
 * every other line — comments, blank lines, unrelated tables, unrelated keys — byte-for-byte
 * intact. Reading (`parseMcpServersForDisplay`) still goes through `smol-toml`, since a full
 * parse is exactly what's needed there and there is nothing to preserve on a read.
 *
 * Trade-off accepted: only single-line scalar/array values are supported for the fields this
 * editor writes (`enabled`, and the fields synthesized by `buildServerBlock`). Hand-written
 * multi-line arrays for `enabled` are not expected and are not specially handled; the search for
 * an existing `enabled = ...` line only looks at direct (non-continuation) lines of the table.
 */

const TOP_LEVEL_TABLE_KEY = "mcp_servers";

interface HeaderMatch {
  /** Full dotted-path segments, unquoted (e.g. ["mcp_servers", "foo", "env"]). */
  readonly segments: readonly string[];
  readonly isArrayTable: boolean;
}

/** Splits the inside of a TOML table header on unquoted dots, unquoting quoted segments. */
function splitTomlKeyPath(raw: string): string[] | null {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let sawContent = false;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === undefined) continue;
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < raw.length) {
        current += char + raw[index + 1];
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      sawContent = true;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    if (/\s/u.test(char)) continue;
    current += char;
    sawContent = true;
  }
  if (quote) return null;
  segments.push(current.trim());
  if (!sawContent && segments.length === 1 && segments[0] === "") return null;
  return segments.some((segment) => segment.length === 0) ? null : segments;
}

/** Parses a line as a TOML table header, or returns null if it is not one. */
function matchTableHeader(line: string): HeaderMatch | null {
  const trimmed = line.trim();
  const arrayMatch = /^\[\[(.+)\]\]$/u.exec(trimmed);
  const tableMatch = arrayMatch ? null : /^\[(.+)\]$/u.exec(trimmed);
  const inner = arrayMatch?.[1] ?? tableMatch?.[1];
  if (inner === undefined) return null;
  const segments = splitTomlKeyPath(inner);
  if (!segments) return null;
  return { segments, isArrayTable: Boolean(arrayMatch) };
}

function isMcpServerHeader(header: HeaderMatch, name: string): boolean {
  return (
    header.segments.length >= 2 &&
    header.segments[0] === TOP_LEVEL_TABLE_KEY &&
    header.segments[1] === name
  );
}

/** [start, directEnd, blockEnd) line indices (0-based) for `[mcp_servers.<name>]`, or null. */
export interface McpTableRange {
  /** Index of the `[mcp_servers.<name>]` header line itself. */
  readonly start: number;
  /** End (exclusive) of the header's own scalar keys, i.e. the next header line of any kind. */
  readonly directEnd: number;
  /** End (exclusive) of the whole block, including any `mcp_servers.<name>.*` subtables. */
  readonly blockEnd: number;
}

export function findMcpServerRange(lines: readonly string[], name: string): McpTableRange | null {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = matchTableHeader(lines[index] ?? "");
    if (header && header.segments.length === 2 && isMcpServerHeader(header, name)) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;
  let directEnd = lines.length;
  let blockEnd = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const header = matchTableHeader(lines[index] ?? "");
    if (!header) continue;
    if (directEnd === lines.length) directEnd = index;
    if (!isMcpServerHeader(header, name)) {
      blockEnd = index;
      break;
    }
  }
  return { start, directEnd, blockEnd };
}

export function listMcpServerNames(lines: readonly string[]): string[] {
  const names: string[] = [];
  for (const line of lines) {
    const header = matchTableHeader(line);
    if (header && header.segments.length >= 2 && header.segments[0] === TOP_LEVEL_TABLE_KEY) {
      const name = header.segments[1];
      if (name !== undefined && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

function splitLines(content: string): string[] {
  return content.split(/\r\n|\n/u);
}

function joinLines(lines: readonly string[], usesCrLf: boolean): string {
  return lines.join(usesCrLf ? "\r\n" : "\n");
}

const ENABLED_LINE_PATTERN = /^(\s*)enabled(\s*=\s*)(true|false)\s*(#.*)?$/u;

/**
 * Sets or clears the `enabled = false` override inside an existing `[mcp_servers.<name>]` block.
 * Enabling removes the line entirely (default state), disabling sets/inserts `enabled = false`,
 * so the file only ever carries an explicit line for servers a person turned off.
 */
export function setMcpServerEnabled(content: string, name: string, enabled: boolean): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  const range = findMcpServerRange(lines, name);
  if (!range) throw new Error(`MCP_SERVER_NOT_FOUND`);
  let enabledLineIndex = -1;
  for (let index = range.start + 1; index < range.directEnd; index += 1) {
    if (ENABLED_LINE_PATTERN.test(lines[index] ?? "")) {
      enabledLineIndex = index;
      break;
    }
  }
  if (enabled) {
    if (enabledLineIndex !== -1) lines.splice(enabledLineIndex, 1);
  } else if (enabledLineIndex !== -1) {
    lines[enabledLineIndex] = "enabled = false";
  } else {
    lines.splice(range.start + 1, 0, "enabled = false");
  }
  return joinLines(lines, usesCrLf);
}

/** Removes an entire `[mcp_servers.<name>]` block, including any of its subtables. */
export function removeMcpServer(content: string, name: string): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  const range = findMcpServerRange(lines, name);
  if (!range) throw new Error("MCP_SERVER_NOT_FOUND");
  let end = range.blockEnd;
  // Absorb one trailing blank line so deleting a block doesn't leave a double blank behind.
  if (end < lines.length && (lines[end] ?? "").trim() === "" && range.start > 0) end += 1;
  lines.splice(range.start, end - range.start);
  return joinLines(lines, usesCrLf);
}

function tomlQuotedString(value: string): string {
  return `"${value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`;
}

export interface NewStdioMcpServer {
  readonly type: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args?: readonly string[];
}

export interface NewHttpMcpServer {
  readonly type: "http";
  readonly name: string;
  readonly url: string;
}

/** Appends a new `[mcp_servers.<name>]` block at the end of the file. */
export function appendMcpServer(
  content: string,
  server: NewStdioMcpServer | NewHttpMcpServer,
): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  if (findMcpServerRange(lines, server.name)) {
    throw new Error("MCP_SERVER_ALREADY_EXISTS");
  }
  const block: string[] = [`[${TOP_LEVEL_TABLE_KEY}.${tomlQuotedString(server.name)}]`];
  if (server.type === "stdio") {
    block.push(`command = ${tomlQuotedString(server.command)}`);
    if (server.args && server.args.length > 0) {
      block.push(`args = [${server.args.map(tomlQuotedString).join(", ")}]`);
    }
  } else {
    block.push(`url = ${tomlQuotedString(server.url)}`);
  }
  // Trim any trailing blank lines before appending, then separate with exactly one blank line.
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  const next = lines.length === 0 ? block : [...lines, "", ...block];
  return `${joinLines(next, usesCrLf)}${usesCrLf ? "\r\n" : "\n"}`;
}

/* -------------------------------------------------------------------------------------------- *
 * Generic helpers used by the relay page to inject `[model_providers.rly0]` and top-level
 * `model_provider` / `model` keys. Same line-level, comment-preserving approach as above; callers
 * must re-parse the result with `smol-toml` and verify the values they meant to write.
 * -------------------------------------------------------------------------------------------- */

export interface TomlTableRange {
  readonly start: number;
  readonly directEnd: number;
  readonly blockEnd: number;
}

function isSegmentPrefix(prefix: readonly string[], segments: readonly string[]): boolean {
  return (
    segments.length >= prefix.length &&
    prefix.every((segment, index) => segments[index] === segment)
  );
}

/** Locates the plain table `[a.b.c]` whose path equals `segments` exactly (subtables included). */
export function findTableRange(
  lines: readonly string[],
  segments: readonly string[],
): TomlTableRange | null {
  let start = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const header = matchTableHeader(lines[index] ?? "");
    if (
      header &&
      !header.isArrayTable &&
      header.segments.length === segments.length &&
      isSegmentPrefix(segments, header.segments)
    ) {
      start = index;
      break;
    }
  }
  if (start === -1) return null;
  let directEnd = lines.length;
  let blockEnd = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const header = matchTableHeader(lines[index] ?? "");
    if (!header) continue;
    if (directEnd === lines.length) directEnd = index;
    if (!isSegmentPrefix(segments, header.segments) || header.segments.length === segments.length) {
      blockEnd = index;
      break;
    }
  }
  return { start, directEnd, blockEnd };
}

function tableHeaderLine(segments: readonly string[]): string {
  return `[${segments
    .map((segment) => (/^[A-Za-z0-9_-]+$/u.test(segment) ? segment : tomlQuotedString(segment)))
    .join(".")}]`;
}

/** TOML literal for a string value (basic string, escaped). */
export function tomlString(value: string): string {
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\r")
    .replace(/\t/gu, "\\t")}"`;
}

/** Removes the table at `segments` (and its subtables). Returns the content unchanged if absent. */
export function removeTable(content: string, segments: readonly string[]): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  const range = findTableRange(lines, segments);
  if (!range) return content;
  let end = range.blockEnd;
  if (end < lines.length && (lines[end] ?? "").trim() === "" && range.start > 0) end += 1;
  lines.splice(range.start, end - range.start);
  return joinLines(lines, usesCrLf);
}

/**
 * Replaces the table at `segments` with a freshly written block holding `entries` (key, already
 * TOML-encoded literal), or appends it at the end of the file when absent. Trailing blank lines
 * that separated the old block from the next table are kept.
 */
export function upsertTable(
  content: string,
  segments: readonly string[],
  entries: readonly (readonly [key: string, literal: string])[],
): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  const block = [
    tableHeaderLine(segments),
    ...entries.map(([key, literal]) => `${key} = ${literal}`),
  ];
  const range = findTableRange(lines, segments);
  if (range) {
    let end = range.blockEnd;
    while (end > range.start + 1 && (lines[end - 1] ?? "").trim() === "") end -= 1;
    lines.splice(range.start, end - range.start, ...block);
    return joinLines(lines, usesCrLf);
  }
  while (lines.length > 0 && (lines.at(-1) ?? "").trim() === "") lines.pop();
  const next = lines.length === 0 ? block : [...lines, "", ...block];
  return `${joinLines(next, usesCrLf)}${usesCrLf ? "\r\n" : "\n"}`;
}

/** Index of the first table header (end of the top-level key region). */
function topLevelEnd(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    if (matchTableHeader(lines[index] ?? "")) return index;
  }
  return lines.length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function topLevelKeyPattern(key: string): RegExp {
  const escaped = escapeRegExp(key);
  return new RegExp(`^(\\s*(?:${escaped}|"${escaped}"|'${escaped}')\\s*=\\s*)(.*)$`, "u");
}

/** Splits `"value" # comment` into the value part and a trailing comment (if safely detectable). */
function splitValueAndComment(rest: string): { comment: string } | null {
  const match = /^("(?:[^"\\]|\\.)*"|'[^']*'|[^\s#"'][^#]*?)(\s*#.*)?$/u.exec(rest.trimEnd());
  if (!match) return null;
  return { comment: match[2] ?? "" };
}

/** Line index of a top-level `key = ...` assignment, or -1. */
export function findTopLevelKeyLine(lines: readonly string[], key: string): number {
  const end = topLevelEnd(lines);
  const pattern = topLevelKeyPattern(key);
  for (let index = 0; index < end; index += 1) {
    if (pattern.test(lines[index] ?? "")) return index;
  }
  return -1;
}

/**
 * Sets a top-level `key = <literal>` (before the first table header). An existing assignment is
 * rewritten in place keeping its indentation and any trailing `# comment`; otherwise the line is
 * inserted after the last top-level assignment (or at the top of the file).
 */
export function setTopLevelKey(content: string, key: string, literal: string): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  const existing = findTopLevelKeyLine(lines, key);
  if (existing !== -1) {
    const match = topLevelKeyPattern(key).exec(lines[existing] ?? "");
    const prefix = match?.[1] ?? `${key} = `;
    const comment = splitValueAndComment(match?.[2] ?? "")?.comment ?? "";
    lines[existing] = `${prefix}${literal}${comment}`;
    return joinLines(lines, usesCrLf);
  }
  const end = topLevelEnd(lines);
  let insertAt = 0;
  for (let index = 0; index < end; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (trimmed !== "" && !trimmed.startsWith("#")) insertAt = index + 1;
  }
  lines.splice(insertAt, 0, `${key} = ${literal}`);
  if (content.length === 0) return `${lines[0]}${usesCrLf ? "\r\n" : "\n"}`;
  return joinLines(lines, usesCrLf);
}

/** Removes a top-level `key = ...` line. Returns the content unchanged if absent. */
export function removeTopLevelKey(content: string, key: string): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  const existing = findTopLevelKeyLine(lines, key);
  if (existing === -1) return content;
  lines.splice(existing, 1);
  return joinLines(lines, usesCrLf);
}

const CONNECTION_KEY = /^\s*(?:command|args|url|"command"|"args"|"url")\s*=/u;

/**
 * Edits how an existing `[mcp_servers.<name>]` connects (command + args, or url) and keeps
 * everything else in the block: env tables, tool policies, timeouts, comments.
 */
export function updateMcpServerConnection(
  content: string,
  server: NewStdioMcpServer | NewHttpMcpServer,
): string {
  const usesCrLf = content.includes("\r\n");
  const lines = splitLines(content);
  const range = findMcpServerRange(lines, server.name);
  if (!range) throw new Error("MCP_SERVER_NOT_FOUND");
  const kept: string[] = [];
  for (let index = range.start + 1; index < range.directEnd; index += 1) {
    const line = lines[index] ?? "";
    if (!CONNECTION_KEY.test(line)) {
      kept.push(line);
      continue;
    }
    // A multi-line `args = [` runs until its closing bracket.
    if (/=\s*\[/u.test(line) && !line.includes("]")) {
      while (index + 1 < range.directEnd && !(lines[index + 1] ?? "").includes("]")) index += 1;
      index += 1;
    }
  }
  const connection =
    server.type === "stdio"
      ? [
          `command = ${tomlQuotedString(server.command)}`,
          ...(server.args && server.args.length > 0
            ? [`args = [${server.args.map(tomlQuotedString).join(", ")}]`]
            : []),
        ]
      : [`url = ${tomlQuotedString(server.url)}`];
  lines.splice(range.start + 1, range.directEnd - range.start - 1, ...connection, ...kept);
  return joinLines(lines, usesCrLf);
}
