import type {
  CodexAccountListResult,
  CodexAccountSummary,
  CodexAccountUsageParams,
  CodexAccountUsageResult,
  Rly0AccountsListResult,
  Rly0CoreStatusResult,
  Rly0DashboardHealthResult,
  Rly0DashboardThreadStatsResult,
  Rly0McpListResult,
  Rly0SkillsListResult,
  Rly0HubOpenResult,
} from "@codexhost/shared-contracts";

import { codexAccountDisplayName } from "../renderer-codex-account-options.js";
import { accountPlanLabel } from "./accounts-list.js";
import {
  accountUsageColumnLabel,
  renderAccountUsage,
  type AccountUsageViewState,
} from "./accounts-usage.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { DashboardMessages } from "./dashboard-messages.js";
import type { RendererSettingsMessages } from "./localization.js";
import { mountRly0QuotaAlert, type RendererRly0QuotaAlertClient } from "./rly0-quota-alert.js";
import { createRly0Showcase } from "./rly0-showcase.js";
import { createRly0HubEntry } from "./rly0-hub-entry.js";
import { createRly0Welcome } from "./rly0-welcome.js";
import { formatByteSize } from "./threads-page.js";

export interface RendererDashboardClient extends RendererRly0QuotaAlertClient {
  rly0CoreStatus?(): Promise<Rly0CoreStatusResult>;
  listRly0Accounts?(): Promise<Rly0AccountsListResult>;
  listRly0Mcp?(): Promise<Rly0McpListResult>;
  listRly0Skills?(): Promise<Rly0SkillsListResult>;
  rly0DashboardHealth?(): Promise<Rly0DashboardHealthResult>;
  rly0DashboardThreadStats?(): Promise<Rly0DashboardThreadStatsResult>;
  listCodexAccounts?(): Promise<CodexAccountListResult>;
  inspectCodexAccountUsage?(input: CodexAccountUsageParams): Promise<CodexAccountUsageResult>;
  rly0OpenHub?(): Promise<Rly0HubOpenResult>;
}

/** `undefined` while loading, `null` when the source failed or is unavailable. */
type Loadable<T> = T | null | undefined;

type SavedAccountsState =
  { readonly status: "ready"; readonly count: number } | { readonly status: "unavailable" };

type CurrentAccountState =
  | { readonly status: "ready"; readonly account: CodexAccountSummary }
  | { readonly status: "none" }
  | { readonly status: "error" };

/**
 * Mirrors `rly0-accounts.ts`: without a `rly0CoreStatus` bridge, or when the core reports itself
 * unavailable (or the probe throws), saved accounts are "unavailable" rather than zero.
 */
export async function loadSavedAccountsState(
  client: RendererDashboardClient | null,
): Promise<SavedAccountsState> {
  if (!client?.rly0CoreStatus || !client.listRly0Accounts) return { status: "unavailable" };
  try {
    const status = await client.rly0CoreStatus();
    if (!status.available) return { status: "unavailable" };
    const result = await client.listRly0Accounts();
    return result.available
      ? { status: "ready", count: result.accounts.length }
      : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}

/** Heat-map intensity bucket 0–4 relative to the busiest day in the window. */
export function activityLevel(count: number, max: number): number {
  if (count <= 0 || max <= 0) return 0;
  return Math.min(4, Math.max(1, Math.ceil((count / max) * 4)));
}

function settle<T>(promise: Promise<T> | undefined): Promise<T | null> {
  if (!promise) return Promise.resolve(null);
  return promise.then(
    (value) => value,
    () => null,
  );
}

/**
 * "仪表盘" / "Dashboard" page. Read-only overview: counts from the accounts / MCP / Skills / threads
 * sources, the current Codex account with its quota bars (rendered by `renderAccountUsage`, the
 * same function the accounts page uses), a data-health check, and an 84-day activity heat map.
 */
export function createDashboardSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererDashboardClient | null,
): RendererSettingsPageDefinition {
  const text: DashboardMessages = messages.dashboard;
  return Object.freeze({
    id: "dashboard",
    label: messages.pageLabels.dashboard,
    icon: "dashboard",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let generation = 0;
      let savedAccounts: Loadable<SavedAccountsState>;
      let threadStats: Loadable<Rly0DashboardThreadStatsResult>;
      let mcp: Loadable<Rly0McpListResult>;
      let skills: Loadable<Rly0SkillsListResult>;
      let health: Loadable<Rly0DashboardHealthResult>;
      let current: CurrentAccountState | undefined;
      let usage: AccountUsageViewState | undefined;

      const header = document.createElement("div");
      header.className = "settings-account-toolbar";
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = text.pageTitle;
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = "settings-command-button settings-command-button--secondary";
      refreshButton.textContent = text.refresh;
      refreshButton.addEventListener("click", () => load());
      header.append(heading, refreshButton);
      const description = document.createElement("p");
      description.className = "settings-rly0-mcp__description";
      description.textContent = text.description;

      const stats = document.createElement("div");
      stats.className = "settings-rly0-dashboard__stats";
      const accountSection = document.createElement("section");
      accountSection.className = "settings-rly0-dashboard__panel settings-rly0-dashboard__account";
      const healthSection = document.createElement("section");
      healthSection.className = "settings-rly0-dashboard__panel settings-rly0-dashboard__health";
      const activitySection = document.createElement("section");
      activitySection.className =
        "settings-rly0-dashboard__panel settings-rly0-dashboard__activity";

      const quotaAlert = mountRly0QuotaAlert(context.content, context.signal, getClient, messages, {
        ...(context.navigate ? { onOpenRelay: () => context.navigate?.("relay") } : {}),
      });
      const showcase = createRly0Showcase(document, messages.relay, { compact: true });
      const welcome = createRly0Welcome(document, messages.locale, context.navigate);
      const openHub = getClient()?.rly0OpenHub;
      const hubClient = getClient();
      const hubEntry =
        openHub && hubClient
          ? createRly0HubEntry(document, messages.locale, () => openHub.call(hubClient))
          : null;
      context.content.append(
        quotaAlert.element,
        header,
        description,
        ...(hubEntry ? [hubEntry] : []),
        ...(welcome ? [welcome] : []),
        showcase,
        stats,
        accountSection,
        healthSection,
        activitySection,
      );

      const panelTitle = (label: string): HTMLElement => {
        const title = document.createElement("h2");
        title.className = "settings-rly0-dashboard__panel-title";
        title.textContent = label;
        return title;
      };

      const statCard = (id: string, label: string, value: string, hint?: string): HTMLElement => {
        const card = document.createElement("div");
        card.className = "settings-rly0-dashboard__card";
        card.dataset.stat = id;
        const valueElement = document.createElement("strong");
        valueElement.className = "settings-rly0-dashboard__value";
        valueElement.textContent = value;
        const labelElement = document.createElement("span");
        labelElement.className = "settings-rly0-dashboard__label";
        labelElement.textContent = label;
        card.append(valueElement, labelElement);
        if (hint) {
          const hintElement = document.createElement("span");
          hintElement.className = "settings-rly0-dashboard__hint";
          hintElement.textContent = hint;
          card.append(hintElement);
        }
        return card;
      };

      const renderStats = (): void => {
        const accountsCard =
          savedAccounts === undefined
            ? statCard("accounts", text.savedAccounts, "…")
            : savedAccounts?.status === "ready"
              ? statCard("accounts", text.savedAccounts, String(savedAccounts.count))
              : statCard("accounts", text.savedAccounts, "—", text.requiresCore);
        const sessionsCard =
          threadStats === undefined
            ? statCard("sessions", text.sessions, "…")
            : threadStats === null
              ? statCard("sessions", text.sessions, "—", text.loadFailed)
              : statCard(
                  "sessions",
                  text.sessions,
                  String(threadStats.stats.totalThreads),
                  text.sessionsSize.replace("{size}", formatByteSize(threadStats.stats.totalBytes)),
                );
        const mcpCard =
          mcp === undefined
            ? statCard("mcp", text.mcpEnabled, "…")
            : mcp === null
              ? statCard("mcp", text.mcpEnabled, "—", text.loadFailed)
              : statCard("mcp", text.mcpEnabled, `${mcp.enabledCount} / ${mcp.totalCount}`);
        const skillsCard =
          skills === undefined
            ? statCard("skills", text.skills, "…")
            : skills === null
              ? statCard("skills", text.skills, "—", text.loadFailed)
              : statCard("skills", text.skills, String(skills.installedCount));
        stats.replaceChildren(accountsCard, sessionsCard, mcpCard, skillsCard);
      };

      const renderAccount = (): void => {
        const title = panelTitle(text.currentAccount);
        const goButton = document.createElement("button");
        goButton.type = "button";
        goButton.className = "settings-command-button settings-command-button--secondary";
        goButton.dataset.action = "go-accounts";
        goButton.textContent = text.goToAccounts;
        goButton.addEventListener("click", () => context.navigate?.("accounts"));
        const titleRow = document.createElement("div");
        titleRow.className = "settings-rly0-dashboard__panel-header";
        titleRow.append(title, goButton);
        if (!current || current.status !== "ready") {
          const message = document.createElement("p");
          message.className = "settings-rly0-accounts__empty";
          message.textContent = !current
            ? "…"
            : current.status === "none"
              ? text.noCurrentAccount
              : text.accountLoadFailed;
          accountSection.replaceChildren(titleRow, message);
          return;
        }
        const account = current.account;
        const identity = document.createElement("div");
        identity.className = "settings-rly0-mcp__identity";
        const name = document.createElement("strong");
        name.textContent = codexAccountDisplayName(account).full;
        name.translate = false;
        identity.append(name);
        const plan = accountPlanLabel(account.planType);
        if (plan) {
          const planLine = document.createElement("div");
          planLine.className = "settings-rly0-mcp__detail";
          planLine.textContent = plan;
          identity.append(planLine);
        }
        // Reuse the accounts page's quota renderer verbatim; it produces table cells.
        const table = document.createElement("table");
        table.className = "settings-account-table settings-rly0-dashboard__usage";
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        // Upstream packs the actual windows two per row; each window carries its own label.
        const headCell = document.createElement("th");
        headCell.scope = "col";
        headCell.colSpan = 2;
        headCell.textContent = accountUsageColumnLabel("remaining", messages);
        headRow.append(headCell);
        head.append(headRow);
        const body = document.createElement("tbody");
        const rendered = renderAccountUsage(document, usage, messages, "remaining", () =>
          loadUsage(account, generation),
        );
        const row = document.createElement("tr");
        row.append(...rendered.cells);
        body.append(row);
        for (const cells of rendered.continuationCells) {
          const continuation = document.createElement("tr");
          continuation.append(...cells);
          body.append(continuation);
        }
        table.append(head, body);
        accountSection.replaceChildren(titleRow, identity, table);
      };

      const healthRow = (label: string, value: string, ok: boolean | null): HTMLElement => {
        const row = document.createElement("div");
        row.className = "settings-rly0-dashboard__health-row";
        const labelElement = document.createElement("span");
        labelElement.className = "settings-rly0-dashboard__health-label";
        labelElement.textContent = label;
        labelElement.translate = false;
        const valueElement = document.createElement("span");
        valueElement.className = "settings-rly0-dashboard__health-value";
        valueElement.dataset.state = ok === null ? "neutral" : ok ? "ok" : "bad";
        valueElement.textContent = value;
        row.append(labelElement, valueElement);
        return row;
      };

      const renderHealth = (): void => {
        const title = panelTitle(text.health);
        if (health === undefined) {
          healthSection.replaceChildren(title);
          return;
        }
        if (health === null) {
          const message = document.createElement("p");
          message.className = "settings-rly0-mcp__notice";
          message.textContent = text.healthFailed;
          healthSection.replaceChildren(title, message);
          return;
        }
        const presence = (value: boolean): string => (value ? text.present : text.missing);
        const configValue = !health.configTomlExists
          ? text.missing
          : health.configTomlParses
            ? `${text.present} · ${text.parses}`
            : `${text.present} · ${text.parseFailed}`;
        const home = healthRow(text.codexHome, health.codexHome, health.codexHomeExists);
        home.dataset.check = "codexHome";
        const auth = healthRow(
          text.authJson,
          presence(health.authJsonExists),
          health.authJsonExists,
        );
        auth.dataset.check = "authJson";
        const config = healthRow(
          text.configToml,
          configValue,
          health.configTomlExists ? health.configTomlParses === true : false,
        );
        config.dataset.check = "configToml";
        const sessions = healthRow(
          text.sessionsDir,
          presence(health.sessionsDirExists),
          health.sessionsDirExists,
        );
        sessions.dataset.check = "sessionsDir";
        healthSection.replaceChildren(title, home, auth, config, sessions);
      };

      const renderActivity = (): void => {
        const days = threadStats?.activity ?? [];
        const title = panelTitle(text.activity.replace("{days}", String(days.length || 84)));
        if (threadStats === undefined) {
          activitySection.replaceChildren(title);
          return;
        }
        if (threadStats === null) {
          const message = document.createElement("p");
          message.className = "settings-rly0-mcp__notice";
          message.textContent = text.activityFailed;
          activitySection.replaceChildren(title, message);
          return;
        }
        const grid = document.createElement("div");
        grid.className = "settings-rly0-dashboard__heatmap";
        grid.setAttribute("role", "img");
        grid.setAttribute("aria-label", title.textContent ?? "");
        const max = days.reduce((highest, day) => Math.max(highest, day.count), 0);
        // Pad the first column so each column is a Sunday–Saturday week (7 rows).
        const firstDay = days[0] ? new Date(`${days[0].date}T00:00:00`).getDay() : 0;
        for (let index = 0; index < firstDay; index += 1) {
          const pad = document.createElement("span");
          pad.className = "settings-rly0-dashboard__heat-cell is-padding";
          pad.setAttribute("aria-hidden", "true");
          grid.append(pad);
        }
        for (const day of days) {
          const cell = document.createElement("span");
          cell.className = "settings-rly0-dashboard__heat-cell";
          cell.dataset.level = String(activityLevel(day.count, max));
          cell.dataset.date = day.date;
          cell.title = text.activityCell
            .replace("{date}", day.date)
            .replace("{count}", String(day.count));
          grid.append(cell);
        }
        const legend = document.createElement("div");
        legend.className = "settings-rly0-dashboard__legend";
        const less = document.createElement("span");
        less.textContent = text.less;
        legend.append(less);
        for (let level = 0; level <= 4; level += 1) {
          const swatch = document.createElement("span");
          swatch.className = "settings-rly0-dashboard__heat-cell";
          swatch.dataset.level = String(level);
          swatch.setAttribute("aria-hidden", "true");
          legend.append(swatch);
        }
        const more = document.createElement("span");
        more.textContent = text.more;
        legend.append(more);
        activitySection.replaceChildren(title, grid, legend);
      };

      const render = (): void => {
        renderStats();
        renderAccount();
        renderHealth();
        renderActivity();
      };

      const isStale = (loadGeneration: number): boolean =>
        context.signal.aborted || loadGeneration !== generation;

      const loadUsage = (account: CodexAccountSummary, loadGeneration: number): void => {
        const inspect = getClient()?.inspectCodexAccountUsage;
        if (!inspect) {
          usage = { status: "empty" };
          render();
          return;
        }
        usage = { status: "loading" };
        render();
        void inspect({ accountId: account.accountId }).then(
          (result) => {
            if (isStale(loadGeneration)) return;
            usage = result.accountCredits
              ? {
                  status: "ready",
                  credits: result.accountCredits,
                  freshness: result.freshness,
                  observedAt: result.observedAt,
                }
              : { status: "empty" };
            render();
          },
          () => {
            if (isStale(loadGeneration)) return;
            usage = { status: "error" };
            render();
          },
        );
      };

      const load = (): void => {
        generation += 1;
        const loadGeneration = generation;
        savedAccounts = undefined;
        threadStats = undefined;
        mcp = undefined;
        skills = undefined;
        health = undefined;
        current = undefined;
        usage = undefined;
        render();
        const client = getClient();
        const apply = <T>(promise: Promise<T>, assign: (value: T) => void): void => {
          void promise.then((value) => {
            if (isStale(loadGeneration)) return;
            assign(value);
            render();
          });
        };
        apply(loadSavedAccountsState(client), (value) => (savedAccounts = value));
        apply(settle(client?.rly0DashboardThreadStats?.()), (value) => (threadStats = value));
        apply(settle(client?.listRly0Mcp?.()), (value) => (mcp = value));
        apply(settle(client?.listRly0Skills?.()), (value) => (skills = value));
        apply(settle(client?.rly0DashboardHealth?.()), (value) => (health = value));
        apply(settle(client?.listCodexAccounts?.()), (value) => {
          if (!value) {
            current = { status: client?.listCodexAccounts ? "error" : "none" };
            return;
          }
          const account = value.accounts.find(
            (candidate) => candidate.accountId === value.currentAccountId,
          );
          current = account ? { status: "ready", account } : { status: "none" };
          if (account) queueMicrotask(() => loadUsage(account, loadGeneration));
        });
      };

      render();
      load();
      return undefined;
    },
  });
}
