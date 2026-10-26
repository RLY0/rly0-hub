import type { SharedResourcesInspectResult } from "@codexhost/shared-contracts";

type Kind = "mcp" | "skills" | "memory";
const KINDS: readonly Kind[] = ["mcp", "skills", "memory"];
const MCP_NAMES_SHOWN = 12;

const LABELS: Record<"zh" | "en", Record<Kind, string>> = {
  zh: { mcp: "MCP", skills: "技能", memory: "记忆" },
  en: { mcp: "MCP", skills: "skills", memory: "memory" },
};

/** What the Agent menu's info popover says about Codex resources shared with this Agent. */
export interface SharedResourcesLine {
  /** One short line, e.g. "共享：MCP 14 · 技能 44 · 记忆 1". */
  readonly summary: string;
  /** The MCP server names behind the count, or null. */
  readonly detail: string | null;
}

/**
 * The Agent menu's sharing line for an external Agent Thread. Counts come from what the Host
 * actually handed this Agent for this project; before its first session they show what the
 * settings will share. MCP names only: never options, which may carry credentials.
 */
export function sharedResourcesSummary(
  result: SharedResourcesInspectResult | null,
  locale: string,
): SharedResourcesLine | null {
  if (!result?.applicable) return null;
  const zh = locale === "zh-CN";
  const labels = LABELS[zh ? "zh" : "en"];
  if (!KINDS.some((kind) => result.support[kind])) {
    return {
      summary: zh
        ? "这个助手暂不接收 Codex 的 MCP / 技能 / 记忆"
        : "This agent does not receive Codex MCP / skills / memory",
      detail: null,
    };
  }
  if (result.blocked)
    return {
      summary: zh ? `未共享 Codex 资源：${result.blocked}` : `Not shared: ${result.blocked}`,
      detail: null,
    };
  const delivered = result.delivered;
  const part = (kind: Kind): string => {
    const label = labels[kind];
    if (!result.support[kind]) return zh ? `${label} 不支持` : `${label} unsupported`;
    if (!result.settings[kind]) return zh ? `${label} 未共享` : `${label} off`;
    if (!delivered) return zh ? `${label} 已开启` : `${label} on`;
    if (kind === "mcp") return `${label} ${delivered.mcpServers.length}`;
    return `${label} ${kind === "skills" ? delivered.skills : delivered.memory}`;
  };
  const prefix = delivered
    ? zh
      ? "共享："
      : "Shared: "
    : zh
      ? "共享（下一条消息起）："
      : "Shared from the next message: ";
  const names = result.support.mcp && result.settings.mcp ? (delivered?.mcpServers ?? []) : [];
  const shown = names.slice(0, MCP_NAMES_SHOWN).join(", ");
  const more = names.length > MCP_NAMES_SHOWN ? (zh ? " 等" : ", …") : "";
  return {
    summary: `${prefix}${KINDS.map(part).join(" · ")}`,
    detail: names.length ? `MCP${zh ? "：" : ": "}${shown}${more}` : null,
  };
}
