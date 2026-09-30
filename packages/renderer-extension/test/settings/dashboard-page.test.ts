import { describe, expect, it, vi } from "vitest";
import type {
  CodexAccountListResult,
  Rly0DashboardActivityDay,
  Rly0DashboardHealthResult,
  Rly0DashboardThreadStatsResult,
} from "@codexhost/shared-contracts";

vi.mock("../../src/settings/icons.js", () => ({
  createRendererSettingsIcon: () => "icon",
}));

import {
  activityLevel,
  createDashboardSettingsPage,
  loadSavedAccountsState,
  type RendererDashboardClient,
} from "../../src/settings/dashboard-page.js";
import { RendererSettingsPageScope } from "../../src/settings/core.js";
import { rendererSettingsMessages } from "../../src/settings/localization.js";

class FakeElement {
  readonly children: unknown[] = [];
  readonly attributes = new Map<string, string>();
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, () => void>();
  className = "";
  textContent = "";
  title = "";
  type = "";
  scope = "";
  colSpan = 1;
  translate = true;
  disabled = false;
  hidden = false;
  constructor(readonly tagName: string) {}
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, listener);
  }
  append(...children: unknown[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: unknown[]): void {
    this.children.length = 0;
    this.children.push(...children);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  focus(): void {
    // Not asserted in these tests.
  }
}

const fakeDocument = {
  createElement: (tagName: string) => new FakeElement(tagName),
} as unknown as Document;

function descendants(root: FakeElement): FakeElement[] {
  return [
    root,
    ...root.children.flatMap((child) => (child instanceof FakeElement ? descendants(child) : [])),
  ];
}
function text(root: FakeElement): string {
  return descendants(root)
    .map((el) => el.textContent)
    .filter(Boolean)
    .join(" | ");
}
function statCard(root: FakeElement, id: string): FakeElement {
  const card = descendants(root).find((el) => el.dataset.stat === id);
  if (!card) throw new Error(`Missing stat card ${id}`);
  return card;
}

const messages = rendererSettingsMessages("zh-CN");

function mountPage(getClient: () => RendererDashboardClient | null) {
  const page = createDashboardSettingsPage(messages, getClient);
  const root = new FakeElement("div") as unknown as HTMLElement;
  Object.assign(root, { ownerDocument: fakeDocument });
  const scope = new RendererSettingsPageScope();
  const navigate = vi.fn();
  page.mount({
    content: root,
    signal: scope.signal,
    runLatest: (operation, handlers) => scope.runLatest(operation, handlers),
    navigate,
  });
  return { root: root as unknown as FakeElement, scope, navigate };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function activity(counts: Record<number, number> = {}): Rly0DashboardActivityDay[] {
  return Array.from({ length: 84 }, (_, index) => {
    const date = new Date(2026, 8, 30 - (83 - index));
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    return { date: key, count: counts[index] ?? 0 };
  });
}

const threadStats: Rly0DashboardThreadStatsResult = {
  sessionsRoot: "/tmp/fake/sessions",
  rootExists: true,
  stats: { totalThreads: 12, totalBytes: 3 * 1024 * 1024, activeDays: 4, averagePerActiveDay: 3 },
  activity: activity({ 83: 4, 82: 1 }),
};

const health: Rly0DashboardHealthResult = {
  codexHome: "/tmp/fake",
  codexHomeExists: true,
  authJsonExists: true,
  configTomlExists: true,
  configTomlParses: true,
  sessionsDirExists: true,
};

const accounts: CodexAccountListResult = {
  version: 2,
  currentAccountId: "acct-1",
  phase: "ready",
  revision: 1,
  accounts: [{ accountId: "acct-1", label: "Work", email: "me@example.com", planType: "plus" }],
};

describe("dashboard helpers", () => {
  it("buckets activity levels relative to the busiest day", () => {
    expect(activityLevel(0, 10)).toBe(0);
    expect(activityLevel(1, 0)).toBe(0);
    expect(activityLevel(1, 10)).toBe(1);
    expect(activityLevel(10, 10)).toBe(4);
  });

  it("treats a missing or unavailable core as unavailable, not zero", async () => {
    expect(await loadSavedAccountsState(null)).toEqual({ status: "unavailable" });
    expect(await loadSavedAccountsState({ listRly0Accounts: vi.fn() })).toEqual({
      status: "unavailable",
    });
    expect(
      await loadSavedAccountsState({
        rly0CoreStatus: async () => ({ available: false }),
        listRly0Accounts: vi.fn(),
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await loadSavedAccountsState({
        rly0CoreStatus: async () => {
          throw new Error("boom");
        },
        listRly0Accounts: vi.fn(),
      }),
    ).toEqual({ status: "unavailable" });
  });
});

describe("createDashboardSettingsPage", () => {
  it("renders all four stats, the current account quota, health and the heat map", async () => {
    const inspect = vi.fn(async () => ({
      accountId: "acct-1",
      usage: null,
      freshness: "live" as const,
      observedAt: null,
      accountCredits: { usedPercent: 25, periodType: "five_hour" as const },
    }));
    const { root, navigate } = mountPage(() => ({
      rly0CoreStatus: async () => ({
        available: true,
        name: "rly0-core",
        version: "1.0.0",
        capabilities: [],
      }),
      listRly0Accounts: async () =>
        ({
          available: true,
          accounts: [{ id: "a1" }, { id: "a2" }],
        }) as Awaited<ReturnType<NonNullable<RendererDashboardClient["listRly0Accounts"]>>>,
      rly0DashboardThreadStats: async () => threadStats,
      rly0DashboardHealth: async () => health,
      listRly0Mcp: async () => ({
        configPath: "/tmp/fake/config.toml",
        configExists: true,
        totalCount: 5,
        enabledCount: 3,
        servers: [],
      }),
      listRly0Skills: async () => ({
        skillsRoot: "/tmp/fake/skills",
        rootExists: true,
        installedCount: 7,
        installed: [],
        backups: [],
      }),
      listCodexAccounts: async () => accounts,
      inspectCodexAccountUsage: inspect,
    }));
    await flush();

    expect(statCard(root, "accounts").children[0]).toMatchObject({ textContent: "2" });
    expect(text(statCard(root, "sessions"))).toContain("12");
    expect(text(statCard(root, "sessions"))).toContain("3 MB");
    expect(text(statCard(root, "mcp"))).toContain("3 / 5");
    expect(text(statCard(root, "skills"))).toContain("7");

    expect(inspect).toHaveBeenCalledWith({ accountId: "acct-1" });
    const rendered = text(root);
    expect(rendered).toContain("me@example.com");
    expect(rendered).toContain("Plus");
    // Quota bars come from renderAccountUsage (the accounts page renderer).
    expect(
      descendants(root).filter((el) => el.className === "settings-account-usage-cell"),
    ).toHaveLength(2);

    const goButton = descendants(root).find((el) => el.dataset.action === "go-accounts");
    expect(goButton?.textContent).toBe(messages.dashboard.goToAccounts);
    goButton?.listeners.get("click")?.();
    expect(navigate).toHaveBeenCalledWith("accounts");

    expect(rendered).toContain("/tmp/fake");
    const heatCells = descendants(root).filter(
      (el) => el.className === "settings-rly0-dashboard__heat-cell" && el.dataset.date,
    );
    expect(heatCells).toHaveLength(84);
    expect(heatCells.at(-1)?.dataset.level).toBe("4");
    expect(heatCells.at(-2)?.dataset.level).toBe("1");
    expect(heatCells[0]?.dataset.level).toBe("0");
    const heatmap = descendants(root).find(
      (el) => el.className === "settings-rly0-dashboard__heatmap",
    );
    const padding = (heatmap?.children ?? []).filter(
      (child) => child instanceof FakeElement && child.className.includes("is-padding"),
    );
    expect(padding.length).toBe(new Date(`${threadStats.activity[0]?.date}T00:00:00`).getDay());
  });

  it("degrades gracefully when the core and every data source are missing", async () => {
    const { root } = mountPage(() => ({}));
    await flush();

    const accountsCard = statCard(root, "accounts");
    expect(text(accountsCard)).toContain("—");
    expect(text(accountsCard)).toContain(messages.dashboard.requiresCore);
    for (const id of ["sessions", "mcp", "skills"]) {
      expect(text(statCard(root, id))).toContain("—");
    }
    const rendered = text(root);
    expect(rendered).toContain(messages.dashboard.noCurrentAccount);
    expect(rendered).toContain(messages.dashboard.healthFailed);
    expect(rendered).toContain(messages.dashboard.activityFailed);
  });

  it("shows '—' with the core hint when the core reports unavailable", async () => {
    const { root } = mountPage(() => ({
      rly0CoreStatus: async () => ({ available: false }),
      listRly0Accounts: async () => ({ available: false, accounts: [] }),
    }));
    await flush();
    const accountsCard = statCard(root, "accounts");
    expect(text(accountsCard)).toContain("—");
    expect(text(accountsCard)).toContain("需要零号核心");
  });

  it("shows missing files in the health block", async () => {
    const { root } = mountPage(() => ({
      rly0DashboardHealth: async () => ({
        codexHome: "/tmp/nowhere",
        codexHomeExists: false,
        authJsonExists: false,
        configTomlExists: true,
        configTomlParses: false,
        sessionsDirExists: false,
      }),
      rly0DashboardThreadStats: async () => ({
        ...threadStats,
        rootExists: false,
        stats: { totalThreads: 0, totalBytes: 0, activeDays: 0, averagePerActiveDay: 0 },
        activity: activity(),
      }),
    }));
    await flush();

    const checks = Object.fromEntries(
      descendants(root)
        .filter((el) => el.dataset.check)
        .map((el) => {
          const value = el.children[1] as FakeElement;
          return [el.dataset.check, { text: value.textContent, state: value.dataset.state }];
        }),
    );
    expect(checks.codexHome).toEqual({ text: "/tmp/nowhere", state: "bad" });
    expect(checks.authJson).toEqual({ text: messages.dashboard.missing, state: "bad" });
    expect(checks.configToml?.text).toContain(messages.dashboard.parseFailed);
    expect(checks.configToml?.state).toBe("bad");
    expect(checks.sessionsDir).toEqual({ text: messages.dashboard.missing, state: "bad" });
    expect(text(statCard(root, "sessions"))).toContain("0");
    const heatCells = descendants(root).filter(
      (el) => el.className === "settings-rly0-dashboard__heat-cell" && el.dataset.date,
    );
    expect(heatCells.every((cell) => cell.dataset.level === "0")).toBe(true);
  });

  it("shows an error state for the current account and keeps the navigation button", async () => {
    const { root, navigate } = mountPage(() => ({
      listCodexAccounts: async () => {
        throw new Error("offline");
      },
    }));
    await flush();
    expect(text(root)).toContain(messages.dashboard.accountLoadFailed);
    descendants(root)
      .find((el) => el.dataset.action === "go-accounts")
      ?.listeners.get("click")?.();
    expect(navigate).toHaveBeenCalledWith("accounts");
  });
});
