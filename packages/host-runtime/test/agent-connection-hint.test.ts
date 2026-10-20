import path from "node:path";
import { describe, expect, it } from "vitest";

import { withAgentInstallPaths } from "../src/rly0-agents/install-paths.js";
import {
  describeAgentConnection,
  withConnectionHints,
} from "../src/rly0-hub-service/agent-connection-hint.js";
import { listRly0HubAgents } from "../src/rly0-hub-service/agents.js";

const LOCAL = "C:\\Users\\me\\AppData\\Local";
const AGY = path.win32.join(LOCAL, "agy", "bin", "agy.exe");
const IDE = path.win32.join(LOCAL, "Programs", "Antigravity", "bin", "antigravity.cmd");
const environment = { PATH: "C:\\Windows", LOCALAPPDATA: LOCAL, PATHEXT: ".EXE;.CMD" };
const antigravity = (files: string[]) =>
  listRly0HubAgents(environment, "win32", (file) => files.includes(file)).find(
    (agent) => agent.id === "antigravity",
  );

describe("finding Antigravity's agy", () => {
  it("looks in the official installer's folder even when PATH predates the install", () => {
    expect(withAgentInstallPaths(environment, "win32").PATH?.split(";")).toContain(
      path.win32.join(LOCAL, "agy", "bin"),
    );
    expect(antigravity([AGY])).toMatchObject({ installed: true });
    expect(antigravity([AGY])?.desktopOnly).toBeUndefined();
  });

  it("tells the desktop app from the command line tool", () => {
    expect(antigravity([IDE])).toMatchObject({ installed: false, desktopOnly: true });
    expect(antigravity([])?.desktopOnly).toBeUndefined();
  });
});

describe("connection hints", () => {
  const missing = { status: "notInstalled", code: "notInstalled" } as const;
  it("says why Codex cannot find an agent", () => {
    const base = { id: "antigravity", name: "Antigravity" };
    expect(describeAgentConnection({ ...base, installed: false, desktopOnly: true }, missing)).toBe(
      "桌面版 Antigravity 已装，但命令行版 agy 没装（Codex 需要 agy）：在这里点“安装”装上 agy",
    );
    expect(describeAgentConnection({ ...base, installed: true }, missing)).toBe(
      "Antigravity（agy） 已经装好，但 Codex 启动时还没有它：点上面的“检测连接”，仍不行再重启一次 Codex",
    );
    expect(describeAgentConnection({ ...base, installed: false }, missing)).toContain(
      "先在这里安装它",
    );
    expect(
      describeAgentConnection({ id: "grok", name: "Grok", installed: true }, missing),
    ).toContain("Grok 已经装好，但 Codex 启动时还没有它");
  });

  it("keeps the other cases and attaches hints only to failures", () => {
    const grok = { id: "grok", name: "Grok", installed: true } as const;
    expect(describeAgentConnection(grok, { status: "error", message: "auth_required" })).toContain(
      "还没有可用的模型来源",
    );
    expect(describeAgentConnection(grok, { status: "error", message: "boom" })).toBe(
      "连接失败，下面是具体原因",
    );
    expect(describeAgentConnection(grok, { status: "ready" })).toBeNull();
    const report = withConnectionHints(
      {
        requestId: null,
        checkedAt: 1,
        agents: { grok: { status: "ready" }, antigravity: missing },
      },
      listRly0HubAgents(environment, "win32", (file) => file === AGY),
    );
    expect(report.agents.grok).toEqual({ status: "ready" });
    expect((report.agents.antigravity as { hint?: string }).hint).toContain("已经装好");
  });
});
