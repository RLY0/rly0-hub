import { describe, expect, it } from "vitest";

import { sharedResourcesSummary } from "../src/renderer-shared-resources.js";

const base = {
  applicable: true,
  settings: { mcp: true, skills: true, memory: false },
  support: { mcp: true, skills: true, memory: true },
  blocked: null,
  delivered: null,
};

describe("Composer shared Codex resources line", () => {
  it("shows what the Agent received, MCP by name only", () => {
    expect(
      sharedResourcesSummary(
        {
          ...base,
          delivered: { mcpServers: ["docs", "github", "files", "db"], skills: 12, memory: 0 },
        },
        "zh-CN",
      ),
    ).toBe(
      "这个助手在本项目收到的 Codex 资源：MCP 4 个（docs, github, files 等） · 技能 12 个 · 记忆 未共享",
    );
  });

  it("shows the settings before the Agent's first session", () => {
    expect(sharedResourcesSummary(base, "zh-CN")).toBe(
      "共享自 Codex（下一条消息起）：MCP 已开启 · 技能 已开启 · 记忆 未共享",
    );
    expect(sharedResourcesSummary(base, "en")).toBe(
      "Shared from Codex (from the next message): MCP on · skills on · memory off",
    );
  });

  it("is honest about Agents that cannot receive a kind or are isolated", () => {
    expect(
      sharedResourcesSummary(
        { ...base, support: { mcp: false, skills: true, memory: true } },
        "zh-CN",
      ),
    ).toContain("MCP 不支持");
    expect(
      sharedResourcesSummary(
        { ...base, support: { mcp: false, skills: false, memory: false } },
        "zh-CN",
      ),
    ).toBe("这个助手暂不接收 Codex 的 MCP / 技能 / 记忆");
    expect(
      sharedResourcesSummary({ ...base, blocked: "Claude 隔离模式开启时不共享" }, "zh-CN"),
    ).toBe("未共享 Codex 资源：Claude 隔离模式开启时不共享");
    expect(sharedResourcesSummary({ ...base, applicable: false }, "zh-CN")).toBeNull();
    expect(sharedResourcesSummary(null, "zh-CN")).toBeNull();
  });
});
