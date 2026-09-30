/** Minimal YAML front-matter reader for `SKILL.md`: only `name` and `description` are needed. */
export interface SkillFrontMatter {
  readonly name?: string;
  readonly description?: string;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed.at(-1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseSkillFrontMatter(content: string): SkillFrontMatter {
  const normalized = content.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n") && normalized !== "---") return {};
  const closingIndex = normalized.indexOf("\n---", 4);
  if (closingIndex === -1) return {};
  const block = normalized.slice(4, closingIndex);
  let name: string | undefined;
  let description: string | undefined;
  for (const line of block.split("\n")) {
    const match = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (key === "name") name = unquote(rawValue ?? "").slice(0, 200) || undefined;
    else if (key === "description") {
      description = unquote(rawValue ?? "").slice(0, 2000) || undefined;
    }
  }
  return { ...(name ? { name } : {}), ...(description ? { description } : {}) };
}
