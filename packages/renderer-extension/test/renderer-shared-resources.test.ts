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
    ).toEqual({
      summary: "共享：MCP 4 · 技能 12 · 记忆 未共享",
      detail: "MCP：docs, github, files, db",
    });
    const many = Array.from({ length: 14 }, (_, index) => `s${index}`);
    expect(
      sharedResourcesSummary(
        { ...base, delivered: { mcpServers: many, skills: 44, memory: 1 } },
        "en",
      ),
    ).toEqual({
      summary: "Shared: MCP 14 · skills 44 · memory off",
      detail: `MCP: ${many.slice(0, 12).join(", ")}, …`,
    });
  });

  it("shows the settings before the Agent's first session", () => {
    expect(sharedResourcesSummary(base, "zh-CN")).toEqual({
      summary: "共享（下一条消息起）：MCP 已开启 · 技能 已开启 · 记忆 未共享",
      detail: null,
    });
    expect(sharedResourcesSummary(base, "en")?.summary).toBe(
      "Shared from the next message: MCP on · skills on · memory off",
    );
  });

  it("is honest about Agents that cannot receive a kind or are isolated", () => {
    expect(
      sharedResourcesSummary(
        { ...base, support: { mcp: false, skills: true, memory: true } },
        "zh-CN",
      )?.summary,
    ).toContain("MCP 不支持");
    expect(
      sharedResourcesSummary(
        { ...base, support: { mcp: false, skills: false, memory: false } },
        "zh-CN",
      )?.summary,
    ).toBe("这个助手暂不接收 Codex 的 MCP / 技能 / 记忆");
    expect(
      sharedResourcesSummary({ ...base, blocked: "Claude 隔离模式开启时不共享" }, "zh-CN")?.summary,
    ).toBe("未共享 Codex 资源：Claude 隔离模式开启时不共享");
    expect(sharedResourcesSummary({ ...base, applicable: false }, "zh-CN")).toBeNull();
    expect(sharedResourcesSummary(null, "zh-CN")).toBeNull();
  });
});
