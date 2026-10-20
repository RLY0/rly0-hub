import type { AgentConnectionStatus } from "../rly0-maintenance/backend-reload-channel.js";
import type { Rly0HubAgent } from "./agents.js";

/**
 * What a failed connection check on the AI 助手 page means, in plain words, combining the Codex
 * side's report (`entry`) with what the Hub sees on this computer (`agent`). The raw message stays
 * available under it.
 */
export function describeAgentConnection(
  agent: Pick<Rly0HubAgent, "id" | "name" | "installed" | "desktopOnly"> | undefined,
  entry: AgentConnectionStatus,
): string | null {
  if (entry.status === "ready") return null;
  const name = agent?.name ?? "这个助手";
  if (entry.status === "notInstalled") {
    if (agent?.desktopOnly)
      return "桌面版 Antigravity 已装，但命令行版 agy 没装（Codex 需要 agy）：在这里点“安装”装上 agy";
    if (agent?.installed === true) {
      const command = agent.id === "antigravity" ? "（agy）" : "";
      return `${name}${command} 已经装好，但 Codex 启动时还没有它：点上面的“检测连接”，仍不行再重启一次 Codex`;
    }
    return `Codex 找不到 ${name}：先在这里安装它，装好后点“检测连接”`;
  }
  const text = `${entry.code ?? ""} ${entry.message ?? ""}`;
  if (/AUTH|auth_required|not configured|no provider|No API key|No models available/iu.test(text))
    return "还没有可用的模型来源：接入方式选零号中转或其他中转，或者登录官方账号";
  if (/interpreter not found/iu.test(text))
    return `${name} 的运行环境没找到，可能是安装没完成，点“再装一次”或检测连接重试`;
  return "连接失败，下面是具体原因";
}

/** The report with each failed entry's plain-words hint attached. */
export function withConnectionHints<
  R extends { agents: Readonly<Record<string, AgentConnectionStatus>> },
>(report: R, agents: readonly Rly0HubAgent[]): R {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return {
    ...report,
    agents: Object.fromEntries(
      Object.entries(report.agents).map(([id, entry]) => {
        const hint = describeAgentConnection(byId.get(id), entry);
        return [id, hint ? { ...entry, hint } : entry];
      }),
    ),
  };
}
