import type { SharedResourcesInspectResult } from "@codexhost/shared-contracts";

type Kind = "mcp" | "skills" | "memory";
const KINDS: readonly Kind[] = ["mcp", "skills", "memory"];

const LABELS: Record<"zh" | "en", Record<Kind, string>> = {
  zh: { mcp: "MCP", skills: "技能", memory: "记忆" },
  en: { mcp: "MCP", skills: "skills", memory: "memory" },
};

/**
 * The Agent menu's "共享自 Codex" line for an external Agent Thread. Counts come from what the
 * Host actually handed this Agent for this project; before its first session they show what
 * the settings will share. MCP names only: never options, which may carry credentials.
 */
export function sharedResourcesSummary(
  result: SharedResourcesInspectResult | null,
  locale: string,
): string | null {
  if (!result?.applicable) return null;
  const zh = locale === "zh-CN";
  const labels = LABELS[zh ? "zh" : "en"];
  if (!KINDS.some((kind) => result.support[kind])) {
    return zh
      ? "这个助手暂不接收 Codex 的 MCP / 技能 / 记忆"
      : "This agent does not receive Codex MCP / skills / memory";
  }
  if (result.blocked)
    return zh ? `未共享 Codex 资源：${result.blocked}` : `Not shared: ${result.blocked}`;
  const delivered = result.delivered;
  const part = (kind: Kind): string => {
    const label = labels[kind];
    if (!result.support[kind]) return zh ? `${label} 不支持` : `${label} unsupported`;
    if (!result.settings[kind]) return zh ? `${label} 未共享` : `${label} off`;
    if (!delivered) return zh ? `${label} 已开启` : `${label} on`;
    if (kind === "mcp") {
      const names = delivered.mcpServers;
      const shown = names.slice(0, 3).join(", ");
      const more = names.length > 3 ? (zh ? ` 等` : ", …") : "";
      return names.length
        ? zh
          ? `MCP ${names.length} 个（${shown}${more}）`
          : `MCP ${names.length} (${shown}${more})`
        : zh
          ? "MCP 0 个"
          : "MCP 0";
    }
    const count = kind === "skills" ? delivered.skills : delivered.memory;
    return zh ? `${label} ${count} ${kind === "skills" ? "个" : "段"}` : `${label} ${count}`;
  };
  const prefix = delivered
    ? zh
      ? "这个助手在本项目收到的 Codex 资源："
      : "Codex resources this agent received here: "
    : zh
      ? "共享自 Codex（下一条消息起）："
      : "Shared from Codex (from the next message): ";
  return `${prefix}${KINDS.map(part).join(" · ")}`;
}
