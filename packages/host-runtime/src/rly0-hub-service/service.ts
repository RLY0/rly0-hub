import { spawn } from "node:child_process";
import path from "node:path";

import {
  rly0AccountsAddLoginStartParamsSchema,
  rly0AccountsImportCurrentParamsSchema,
  rly0AccountsRemoveParamsSchema,
  rly0AccountsRenameParamsSchema,
  rly0AccountsSwitchParamsSchema,
  rly0AccountsUsageParamsSchema,
  rly0AgentAuthLoginParamsSchema,
  rly0AgentIdParamsSchema,
  rly0AppearanceAutostartSetParamsSchema,
  rly0ProxySettingsSetParamsSchema,
  rly0RelayAddParamsSchema,
  rly0RelayAgentsSetParamsSchema,
  rly0RelayBalanceParamsSchema,
  rly0RelayRemoveParamsSchema,
  rly0RelaySetEnabledParamsSchema,
  rly0RelayTestParamsSchema,
  rly0RelayUpdateParamsSchema,
  RLY0_GITHUB_REPOSITORY_URL,
  RLY0_GITHUB_RELEASES_LATEST_URL,
  type Rly0AccountUsage,
  type Rly0Relay,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import { AgentInstaller } from "../rly0-agents/agent-installer.js";
import { ClaudeCodeAuth } from "../rly0-agents/claude-code-auth.js";
import { Rly0AppearanceManager } from "../rly0-appearance/index.js";
import { WindowsRegistryAutostart } from "../rly0-appearance/windows-autostart.js";
import { applyProxyEnvironment, Rly0CoreBridge } from "../rly0-core/index.js";
import {
  codexHeartbeatAlive,
  readAgentStatus,
  requestAgentCheck,
  requestBackendReload,
} from "../rly0-maintenance/backend-reload-channel.js";
import { Rly0FirstRunBackup } from "../rly0-maintenance/first-run-backup.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { RLY0_RELAY_AGENTS, Rly0AgentRelaySettings } from "../rly0-relay/agent-relays.js";
import {
  officialVendorOf,
  RLY0_OFFICIAL_VENDORS,
  Rly0OfficialKeyModels,
} from "../rly0-relay/official-keys.js";
import { Rly0RelayModelRouter } from "../rly0-relay/model-routing.js";
import { createHubManagementRoutes } from "./management-routes.js";
import type { HostUpdateCoordinator } from "../update-coordinator.js";
import { apiKeyLogin, importLogin, parseLoginFile } from "./account-import.js";
import {
  importClaudeCredentials,
  isAnthropicOfficial,
  parseClaudeImport,
  saveAnthropicApiKey,
} from "./claude-official.js";
import { listRly0HubAgents, rly0HubAgentDocsUrl } from "./agents.js";
import { fetchRelayLogo } from "./relay-logo.js";
import {
  cleanAlertSettings,
  evaluateRly0HubAlerts,
  RLY0_ALERT_DEFAULTS,
  type Rly0HubAlert,
} from "./alerts.js";
import {
  cleanAutoSwitchSettings,
  decideAutoSwitch,
  RLY0_AUTO_SWITCH_DEFAULTS,
} from "./auto-switch.js";
import { Rly0CodexControl } from "./codex-control.js";
import { noAccountStatus, relayCodexModels } from "./no-account.js";
import { Rly0RelayCodexConfigManager } from "../rly0-relay/codex-config.js";
import { Rly0HubStateStore, type Rly0HubState } from "./hub-state.js";
import { Rly0HubAddLogin } from "./add-login.js";

/** 零号中转 itself: the relay the home page shows a balance for. */
const RLY0_HOSTS = /(^|\.)rly0\.com$/iu;
/** Fixed pages the Hub may open in the browser; nothing the page sends becomes a URL. */
export const RLY0_HUB_LINKS = {
  site: "https://rly0.com",
  recharge: "https://rly0.com/purchase?tab=recharge",
  github: RLY0_GITHUB_REPOSITORY_URL,
  nodejs: "https://nodejs.org",
  releases: RLY0_GITHUB_RELEASES_LATEST_URL,
  keys: "https://rly0.com/keys",
} as const;

const empty = z.object({}).strict();
const addLoginIdParams = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/u) }).strict();
const linkParams = z
  .object({ target: z.enum(["site", "recharge", "github", "nodejs", "releases", "keys"]) })
  .strict();

type Handler = (params: unknown) => Promise<unknown>;

export interface Rly0HubServiceOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly installRoot: string;
  /** How long an account switch waits for Codex to reload its backend in place. */
  readonly backendReloadTimeoutMs?: number;
  /** What "开机自启" registers; omitted when this build has no Hub executable. */
  readonly autostartCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly core?: Rly0CoreBridge;
  readonly updates?: Pick<HostUpdateCoordinator, "check">;
  readonly codex?: Rly0CodexControl;
  readonly appearance?: Rly0AppearanceManager;
  readonly openUrl?: (url: string) => void;
  /** "Add account" sign-ins; built from `core` when omitted. */
  readonly addLogin?: Rly0HubAddLogin;
}

export function isRly0Relay(relay: Pick<Rly0Relay, "baseUrl">): boolean {
  try {
    return RLY0_HOSTS.test(new URL(relay.baseUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * rly0.com shows balances in US dollars, whatever unit its usage endpoint reports; the Hub shows
 * 零号's balance the same way as the site so the two never disagree.
 */
function rly0Dollars<T extends { readonly available: boolean }>(result: T): T {
  return result.available && "unit" in result ? { ...result, unit: "USD" } : result;
}

/** 零号中转 is listed first everywhere; other relays keep their own order. */
function rly0First<
  T extends { readonly available: boolean; readonly relays?: readonly Rly0Relay[] },
>(result: T): T {
  if (!result.available || !result.relays) return result;
  const relays = [...result.relays].sort((a, b) => Number(isRly0Relay(b)) - Number(isRly0Relay(a)));
  return { ...result, relays };
}

function openInBrowser(url: string): void {
  // url.dll's protocol handler gives the URL to the default browser. explorer.exe is not used: it
  // mis-parses long sign-in URLs (commas, `+`) and opens the Documents folder instead.
  const handler = path.join(
    process.env.SystemRoot ?? process.env.windir ?? "C:\\Windows",
    "System32",
    "rundll32.exe",
  );
  const child = spawn(handler, ["url.dll,FileProtocolHandler", url], {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {
    const fallback = spawn("explorer.exe", [url], { detached: true, stdio: "ignore" });
    fallback.on("error", () => undefined);
    fallback.unref();
  });
  child.unref();
}

/**
 * Backend of the standalone RLY/0 Hub window: the same relay, account, agent and backup managers
 * the in-Codex settings use, reachable without Codex running. Every method has a fixed name and a
 * validated parameter shape; secrets (relay keys, sign-ins) stay inside rly0-core and the agents'
 * own CLIs.
 */
function codedHubError(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

export class Rly0HubService {
  readonly #options: Rly0HubServiceOptions;
  readonly #core: Rly0CoreBridge;
  readonly #codex: Rly0CodexControl;
  readonly #appearance: Rly0AppearanceManager;
  readonly #router: Rly0RelayModelRouter;
  readonly #backup: Rly0FirstRunBackup;
  readonly #agentRelays: Rly0AgentRelaySettings;
  readonly #officialModels: Rly0OfficialKeyModels;
  readonly #installer: AgentInstaller;
  readonly #claudeCode: ClaudeCodeAuth;
  readonly #state: Rly0HubStateStore;
  readonly #codexConfig: Rly0RelayCodexConfigManager;
  readonly #addLogin: Rly0HubAddLogin;
  readonly #relayLogos = new Map<
    string,
    Promise<{ logo: string | null; siteName: string | null }>
  >();

  #rememberLogo(baseUrl: string): Promise<{ logo: string | null; siteName: string | null }> {
    const pending = fetchRelayLogo(baseUrl).catch(() => ({ logo: null, siteName: null }));
    this.#relayLogos.set(baseUrl, pending);
    return pending;
  }
  readonly #routes: Readonly<Record<string, Handler>>;

  constructor(options: Rly0HubServiceOptions) {
    this.#options = options;
    const { environment } = options;
    const windows = (options.platform ?? process.platform) === "win32";
    this.#core = options.core ?? new Rly0CoreBridge({ environment });
    this.#codex =
      options.codex ??
      new Rly0CodexControl({
        environment,
        installRoot: options.installRoot,
        heartbeatAlive: () => codexHeartbeatAlive(resolveRly0DataDir(environment)),
        ...(options.platform ? { platform: options.platform } : {}),
      });
    this.#appearance =
      options.appearance ??
      new Rly0AppearanceManager(
        windows && options.autostartCommand
          ? { registry: new WindowsRegistryAutostart(), launcherCommand: options.autostartCommand }
          : {},
      );
    this.#router = new Rly0RelayModelRouter(this.#core);
    this.#backup = new Rly0FirstRunBackup({ environment });
    this.#agentRelays = new Rly0AgentRelaySettings({ environment });
    this.#officialModels = new Rly0OfficialKeyModels(environment);
    this.#installer = new AgentInstaller({
      environment,
      ...(options.platform ? { platform: options.platform } : {}),
      downloadEnvironment: () => applyProxyEnvironment(environment, this.#core.getProxySettings()),
    });
    this.#claudeCode = new ClaudeCodeAuth({
      environment,
      ...(options.platform ? { platform: options.platform } : {}),
    });
    this.#state = new Rly0HubStateStore(environment);
    this.#codexConfig = new Rly0RelayCodexConfigManager({ environment });
    this.#addLogin =
      options.addLogin ??
      new Rly0HubAddLogin({
        environment,
        ...(options.platform ? { platform: options.platform } : {}),
        core: this.#core,
        openUrl: (url) => (options.openUrl ?? openInBrowser)(url),
      });
    this.#routes = this.#buildRoutes();
  }

  get methods(): readonly string[] {
    return Object.keys(this.#routes);
  }

  async handle(method: string, params: unknown): Promise<unknown> {
    const handler = Object.hasOwn(this.#routes, method) ? this.#routes[method] : undefined;
    if (!handler) throw Object.assign(new Error("METHOD_NOT_FOUND"), { code: -32601 });
    return handler(params ?? {});
  }

  /** First run turns autostart on (the confirmed default); later runs respect the toggle. */
  async start(): Promise<void> {
    const state = await this.#state.read();
    // Without a Hub executable to register (source checkout) the default waits for a real build.
    if (!state.autostartDefaulted && this.#appearance.supported) {
      await this.#appearance.setAutostart(true).catch(() => undefined);
      await this.#state.update({ autostartDefaulted: true });
    }
    await this.#backup.ensure().catch(() => false);
    await this.#ensureProxyForRelays().catch(() => undefined);
  }

  /** Tray notices to show now; each is remembered so it is not repeated. */
  async #checkAlerts(): Promise<unknown> {
    const zero = await this.#zeroRelay();
    let balance: { amount: number; unit: "USD" | "CNY" } | null = null;
    if (zero?.enabled && zero.hasKey) {
      const result = await this.#core.relayBalance({ id: zero.id }).catch(() => null);
      if (result?.available && result.ok && typeof result.balance === "number" && result.unit) {
        balance = { amount: result.balance, unit: result.unit };
      }
    }
    let quota: { usedPercent: number; resetsAt?: number } | null = null;
    const usage = await this.#core.usageCurrent().catch(() => null);
    if (usage?.available) {
      const window = usage.usage.windows.find((w) => w.kind === "primary");
      if (window) {
        quota = {
          usedPercent: window.usedPercent,
          ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
        };
      }
    }
    const before = await this.#state.read();
    const switching = usage?.available ? await this.#autoSwitch(usage.usage, before) : null;
    // An auto-switch notice already covers a low Codex quota.
    const { alerts, state } = evaluateRly0HubAlerts(
      { balance, quota: switching ? null : quota },
      switching ? { ...before, ...switching.state } : before,
      cleanAlertSettings(before.alerts ?? RLY0_ALERT_DEFAULTS),
    );
    if (JSON.stringify(state) !== JSON.stringify(before)) await this.#state.update(state);
    return { alerts: switching?.alert ? [switching.alert, ...alerts] : alerts };
  }

  /** At most one notice (or switch) per account, window and reset time. */
  async #autoSwitch(
    usage: Rly0AccountUsage,
    state: Rly0HubState,
  ): Promise<{ alert: Rly0HubAlert | null; state: Partial<Rly0HubState> } | null> {
    const settings = cleanAutoSwitchSettings(state.autoSwitch ?? RLY0_AUTO_SWITCH_DEFAULTS);
    if (!settings.enabled) return null;
    const live = await this.#core.currentAccount().catch(() => ({ loggedIn: false as const }));
    const current = { ...(live.loggedIn && live.id ? { id: live.id } : {}), usage };
    const list = async () => {
      const accounts = await this.#core.listAccounts().catch(() => null);
      return accounts?.available ? accounts.accounts : [];
    };
    let decision = decideAutoSwitch(settings, current, await list());
    if (!decision) return null;
    const key = `${current.id ?? "live"}:${decision.reason.window}:${decision.reason.resetsAt ?? 0}`;
    if (state.autoSwitchHandledFor === key) return { alert: null, state: {} };
    // Low now: read every saved account fresh before choosing.
    await this.#core.usageAll().catch(() => undefined);
    decision = decideAutoSwitch(settings, current, await list()) ?? decision;
    const window = decision.reason.window === "5h" ? "5 小时" : "每周";
    const handled = { autoSwitchHandledFor: key };
    if (!decision.target) {
      return {
        alert: {
          id: "all-low",
          title: `Codex ${window}额度只剩 ${decision.reason.left}%`,
          body: "保存的账号额度都不多了，可以先用 Claude Code 等其他 AI。",
          action: "open",
        },
        state: handled,
      };
    }
    const target = decision.target;
    if (settings.mode === "auto") {
      const switched = await this.#switchAndRestart(target.id).catch(() => ({ switched: false }));
      if (switched.switched) {
        return {
          alert: {
            id: "switched",
            title: `已切换到 ${target.name}`,
            body: `原账号${window}额度只剩 ${decision.reason.left}%，新账号还有 ${target.left}%。`,
            action: "open",
          },
          state: handled,
        };
      }
    }
    return {
      alert: {
        id: "switch-suggest",
        title: `Codex ${window}额度只剩 ${decision.reason.left}%`,
        body: `点这里切换到 ${target.name}（还有 ${target.left}%），Codex 会自动重启。`,
        action: "switch",
        accountId: target.id,
      },
      state: handled,
    };
  }

  /** Only a GPT-family model some enabled relay lists; the proxy is the Hub's own. */
  async #noAccountParams(model: string) {
    const relays = await this.#core.listRelays();
    if (!relayCodexModels(relays.available ? relays.relays : []).includes(model)) {
      throw Object.assign(new Error("NO_ACCOUNT_MODEL_UNKNOWN"), { code: -32602 });
    }
    const baseUrl = await this.#router.ensureProxy();
    return { baseUrl, setDefault: true, model, noAccount: true } as const;
  }

  /** Switch the live Codex login and restart Codex when it is running so the switch takes effect. */
  /**
   * Switches the saved account. When Codex is open, its official backend is reloaded in place
   * (the window and conversations stay; a running reply finishes first). Only when the Codex side
   * does not answer (an older build) is Codex restarted as before.
   */
  async #switchAndRestart(
    id: string,
  ): Promise<{ switched: boolean; restarted: boolean; reloaded?: "reloaded" | "deferred" }> {
    const result = await this.#core.switchAccount({ id });
    if (!result.available || !result.switched) return { switched: false, restarted: false };
    const codex = await this.#codex.status();
    // Ask the Codex side even when Codex does not look open: it answers if it is there.
    const reload = await requestBackendReload(resolveRly0DataDir(this.#options.environment), {
      timeoutMs: codex.running ? (this.#options.backendReloadTimeoutMs ?? 15_000) : 5_000,
    }).catch(() => null);
    if (reload === "reloaded" || reload === "deferred") {
      return { switched: true, restarted: false, reloaded: reload };
    }
    if (!codex.running) return { switched: true, restarted: false };
    const restarted = (await this.#codex.restart()).ok;
    return { switched: true, restarted };
  }

  async dispose(): Promise<void> {
    await this.#addLogin.close().catch(() => undefined);
    await this.#core.dispose();
  }

  async #ensureProxyForRelays(): Promise<void> {
    const relays = await this.#core.listRelays();
    if (relays.available && relays.relays.some((relay) => relay.enabled)) {
      await this.#router.ensureProxy();
    }
  }

  async #zeroRelay(): Promise<Rly0Relay | null> {
    const relays = await this.#core.listRelays();
    if (!relays.available) return null;
    return (
      relays.relays.find((relay) => relay.enabled && relay.hasKey && isRly0Relay(relay)) ??
      relays.relays.find((relay) => isRly0Relay(relay)) ??
      null
    );
  }

  #buildRoutes(): Record<string, Handler> {
    const core = this.#core;
    const route =
      <S extends z.ZodTypeAny>(
        schema: S,
        run: (params: z.infer<S>) => Promise<unknown> | unknown,
      ) =>
      async (raw: unknown): Promise<unknown> => {
        const parsed = schema.safeParse(raw);
        if (!parsed.success) throw Object.assign(new Error("INVALID_PARAMS"), { code: -32602 });
        return run(parsed.data);
      };
    return {
      ...createHubManagementRoutes({
        environment: this.#options.environment,
        installRoot: this.#options.installRoot,
        core,
        codex: this.#codex,
        ...(this.#options.updates ? { updates: this.#options.updates } : {}),
      }),
      "home.summary": route(empty, async () => {
        const [codex, proxy, zero, live] = await Promise.all([
          this.#codex.status(),
          core.proxyStatus(),
          this.#zeroRelay(),
          core.currentAccount().catch(() => ({ loggedIn: false as const })),
        ]);
        return {
          codex,
          proxy,
          zeroRelay: zero ? { id: zero.id, name: zero.name, hasKey: zero.hasKey } : null,
          currentAccount: live.loggedIn ? live : null,
        };
      }),
      "balance.get": route(empty, async () => {
        const zero = await this.#zeroRelay();
        if (!zero) return { configured: false };
        return {
          configured: true,
          relayId: zero.id,
          ...rly0Dollars(await core.relayBalance({ id: zero.id })),
        };
      }),
      "hub.state": route(empty, async () => {
        const state = await this.#state.read();
        return { onboarded: state.onboarded === true };
      }),
      "hub.finishOnboarding": route(empty, async () => {
        await this.#state.update({ onboarded: true });
        return { ok: true };
      }),
      "alerts.check": route(empty, () => this.#checkAlerts()),
      "accounts.autoSwitchGet": route(empty, async () =>
        cleanAutoSwitchSettings((await this.#state.read()).autoSwitch ?? RLY0_AUTO_SWITCH_DEFAULTS),
      ),
      "accounts.autoSwitchSet": route(
        z
          .object({
            enabled: z.boolean(),
            remain5h: z.number().int().min(1).max(90),
            remainWeekly: z.number().int().min(1).max(90),
            mode: z.enum(["ask", "auto"]),
          })
          .strict(),
        async (p) => {
          const settings = cleanAutoSwitchSettings(p);
          await this.#state.update({ autoSwitch: settings });
          return settings;
        },
      ),
      "relay.noAccountStatus": route(empty, async () => {
        const relays = await core.listRelays();
        return noAccountStatus(this.#codexConfig, relays.available ? relays.relays : []);
      }),
      "relay.noAccountPreview": route(
        z.object({ model: z.string().min(1).max(128) }).strict(),
        async (p) => this.#codexConfig.preview(await this.#noAccountParams(p.model)),
      ),
      "relay.noAccountEnable": route(
        z.object({ model: z.string().min(1).max(128), confirmed: z.literal(true) }).strict(),
        async (p) => {
          const result = await this.#codexConfig.apply(await this.#noAccountParams(p.model));
          return { ok: result.ok, noAccount: result.status.noAccount === true };
        },
      ),
      "relay.noAccountDisable": route(empty, async () => {
        const result = await this.#codexConfig.restore();
        return { ok: result.ok };
      }),
      "alerts.settingsGet": route(empty, async () =>
        cleanAlertSettings((await this.#state.read()).alerts ?? RLY0_ALERT_DEFAULTS),
      ),
      "alerts.settingsSet": route(
        z
          .object({
            balanceUsd: z.number().min(0).max(1000),
            quotaUsedPercent: z.number().int().min(50).max(100),
          })
          .strict(),
        async (p) => {
          const settings = cleanAlertSettings(p);
          await this.#state.update({ alerts: settings });
          return settings;
        },
      ),
      "accounts.importAuthFile": route(
        z
          .object({
            content: z
              .string()
              .min(2)
              .max(256 * 1024),
            alias: z.string().trim().min(1).max(40).optional(),
          })
          .strict(),
        async (p) => {
          const logins = parseLoginFile(p.content);
          const ids: string[] = [];
          for (const login of logins) {
            const alias = logins.length === 1 ? (p.alias ?? login.alias) : login.alias;
            ids.push((await importLogin(core, login.json, alias)).id);
          }
          return { id: ids[0], ids, count: ids.length };
        },
      ),
      "accounts.addApiKey": route(
        z
          .object({
            apiKey: z.string().min(1).max(400),
            alias: z.string().trim().min(1).max(40).optional(),
          })
          .strict(),
        (p) => {
          const login = apiKeyLogin(p.apiKey);
          return importLogin(core, login.json, p.alias ?? login.alias);
        },
      ),
      "accounts.switchAndRestart": route(rly0AccountsSwitchParamsSchema, (p) =>
        this.#switchAndRestart(p.id),
      ),
      "links.agentDocs": route(z.object({ agent: z.string().max(40) }).strict(), (p) => {
        const url = rly0HubAgentDocsUrl(p.agent);
        if (!url) throw Object.assign(new Error("INVALID_PARAMS"), { code: -32602 });
        (this.#options.openUrl ?? openInBrowser)(url);
        return { ok: true };
      }),
      "relay.logo": route(rly0RelayBalanceParamsSchema, async (p) => {
        const relays = await core.listRelays();
        const relay = relays.available ? relays.relays.find((r) => r.id === p.id) : undefined;
        if (!relay) return { logo: null, siteName: null };
        if (isRly0Relay(relay)) return { logo: "rly0", siteName: "零号中转" };
        return this.#relayLogos.get(relay.baseUrl) ?? this.#rememberLogo(relay.baseUrl);
      }),
      "links.open": route(linkParams, (p) => {
        (this.#options.openUrl ?? openInBrowser)(RLY0_HUB_LINKS[p.target]);
        return { ok: true };
      }),

      "codex.status": route(empty, () => this.#codex.status()),
      "codex.open": route(empty, () => this.#codex.open()),
      "codex.restart": route(empty, () => this.#codex.restart()),

      "relay.list": route(empty, async () => rly0First(await core.listRelays())),
      "relay.add": route(rly0RelayAddParamsSchema, async (p) => {
        const result = await core.addRelay(p);
        await this.#ensureProxyForRelays().catch(() => undefined);
        return result;
      }),
      "relay.update": route(rly0RelayUpdateParamsSchema, (p) => core.updateRelay(p)),
      "relay.setEnabled": route(rly0RelaySetEnabledParamsSchema, async (p) => {
        const result = await core.setRelayEnabled(p);
        await this.#ensureProxyForRelays().catch(() => undefined);
        return result;
      }),
      "relay.remove": route(rly0RelayRemoveParamsSchema, (p) => core.removeRelay(p)),
      "relay.test": route(rly0RelayTestParamsSchema, (p) => core.testRelay(p)),
      "relay.balance": route(rly0RelayBalanceParamsSchema, async (p) => {
        const relays = await core.listRelays();
        const relay = relays.available ? relays.relays.find((r) => r.id === p.id) : undefined;
        const result = await core.relayBalance(p);
        return relay && isRly0Relay(relay) ? rly0Dollars(result) : result;
      }),

      "proxy.settingsGet": route(empty, () => ({ settings: core.getProxySettings() })),
      "proxy.settingsSet": route(rly0ProxySettingsSetParamsSchema, (p) =>
        core.setProxySettings(p.settings),
      ),
      "proxy.status": route(empty, () => core.proxyStatus()),
      "proxy.start": route(empty, async () => {
        await this.#router.ensureProxy();
        return core.proxyStatus();
      }),
      "proxy.stop": route(empty, () => core.proxyStop()),

      "accounts.list": route(empty, () => core.listAccounts()),
      "accounts.usage": route(rly0AccountsUsageParamsSchema, (p) => core.usage(p)),
      "accounts.current": route(empty, () => core.currentAccount()),
      "accounts.usageCurrent": route(empty, () => core.usageCurrent()),
      "accounts.usageAll": route(empty, () => core.usageAll()),
      "accounts.switch": route(rly0AccountsSwitchParamsSchema, (p) => core.switchAccount(p)),
      "accounts.rename": route(rly0AccountsRenameParamsSchema, (p) => core.rename(p)),
      "accounts.remove": route(rly0AccountsRemoveParamsSchema, (p) => core.remove(p)),
      "accounts.importCurrent": route(rly0AccountsImportCurrentParamsSchema, (p) =>
        core.importCurrent(p),
      ),
      // Sign in another ChatGPT account in a throw-away CODEX_HOME; the live login is untouched.
      "accounts.addLoginStart": route(rly0AccountsAddLoginStartParamsSchema, (p) =>
        this.#addLogin.start(p),
      ),
      "accounts.addLoginStatus": route(addLoginIdParams, (p) => this.#addLogin.status(p.id)),
      "accounts.addLoginCancel": route(addLoginIdParams, (p) => this.#addLogin.cancel(p.id)),

      "agents.list": route(empty, async () => ({
        agents: listRly0HubAgents(
          await this.#installer.searchEnvironment(),
          this.#options.platform,
        ),
      })),
      "agents.installStart": route(rly0AgentIdParamsSchema, (p) => this.#installer.start(p.agent)),
      "agents.installStatus": route(rly0AgentIdParamsSchema, (p) =>
        this.#installer.status(p.agent),
      ),
      "agents.openLogin": route(rly0AgentIdParamsSchema, async (p) => ({
        ok: await this.#installer.openLogin(p.agent),
      })),
      "agents.claudeCode.status": route(empty, () => this.#claudeCode.status()),
      "agents.claudeCode.login": route(rly0AgentAuthLoginParamsSchema, (p) =>
        this.#claudeCode.login(p.mode),
      ),
      "agents.claudeCode.logout": route(empty, async () => ({
        ok: await this.#claudeCode.logout(),
      })),
      "agents.claudeCode.setApiKey": route(
        z.object({ apiKey: z.string().min(1).max(400) }).strict(),
        async (p) => {
          const { id } = await saveAnthropicApiKey(core, p.apiKey);
          await this.#agentRelays.set({ claudeCode: id });
          await this.#ensureProxyForRelays().catch(() => undefined);
          return { ok: true, id };
        },
      ),
      "agents.claudeCode.importCredentials": route(
        z
          .object({
            content: z
              .string()
              .min(2)
              .max(256 * 1024),
          })
          .strict(),
        async (p) => {
          const parsed = parseClaudeImport(p.content);
          if (parsed.kind === "token") {
            // A subscription token or key from a Sub2API export: kept encrypted by rly0-core.
            const { id } = await saveAnthropicApiKey(core, parsed.token);
            await this.#agentRelays.set({ claudeCode: id });
            await this.#ensureProxyForRelays().catch(() => undefined);
            return { ok: true, backup: null, token: true };
          }
          const result = await importClaudeCredentials(this.#options.environment, p.content);
          // An imported login means the official account, not a pinned relay or key.
          await this.#agentRelays.set({ claudeCode: null });
          return result;
        },
      ),
      // Connection checks run on the Codex side (it owns the agents); the Hub shows them.
      "agents.connectionStatus": route(empty, async () => ({
        report: await readAgentStatus(resolveRly0DataDir(this.#options.environment)),
      })),
      "agents.checkConnections": route(empty, async () => {
        const codex = await this.#codex.status();
        if (!codex.running) return { report: null, codexRunning: false };
        return {
          report: await requestAgentCheck(resolveRly0DataDir(this.#options.environment)),
          codexRunning: true,
        };
      }),
      // Claude Code's own accounts, kept like Codex accounts (rly0-core encrypts them). Switching
      // takes effect for new Claude Code conversations; no Codex restart.
      "agents.claudeAccounts.list": route(empty, async () => {
        const result = await core.claudeAccounts("list");
        if (!result) throw codedHubError("RLY0_CORE_UNAVAILABLE");
        return result;
      }),
      "agents.claudeAccounts.importCurrent": route(
        z.object({ alias: z.string().trim().min(1).max(40).optional() }).strict(),
        async (p) => {
          const result = await core.claudeAccounts(
            "importCurrent",
            p.alias ? { alias: p.alias } : {},
          );
          if (!result) throw codedHubError("RLY0_CORE_UNAVAILABLE");
          return result;
        },
      ),
      "agents.claudeAccounts.switch": route(
        z.object({ id: z.string().regex(/^[a-f0-9]{12}$/u) }).strict(),
        async (p) => {
          const result = await core.claudeAccounts("switch", { id: p.id });
          if (!result) throw codedHubError("RLY0_CORE_UNAVAILABLE");
          // An account login means the official account, not a relay or API key.
          if (result.switched) await this.#agentRelays.set({ claudeCode: null });
          return result;
        },
      ),
      "agents.claudeAccounts.rename": route(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{12}$/u),
            alias: z.string().trim().min(1).max(40),
          })
          .strict(),
        async (p) => (await core.claudeAccounts("rename", p)) ?? { ok: false },
      ),
      "agents.claudeAccounts.remove": route(
        z.object({ id: z.string().regex(/^[a-f0-9]{12}$/u) }).strict(),
        async (p) => (await core.claudeAccounts("remove", p)) ?? { ok: false },
      ),
      // What the saved official key/subscription token is: account and usage for a token,
      // validity for an API key. The key itself stays in rly0-core.
      "agents.claudeCode.keyInfo": route(empty, async () => {
        const relays = await core.listRelays();
        const entry = relays.available ? relays.relays.find(isAnthropicOfficial) : undefined;
        if (!entry) return { info: null };
        return { info: await core.claudeAccounts("keyInfo", { relayId: entry.id }) };
      }),
      "agents.claudeAccounts.usageAll": route(empty, async () => {
        const result = await core.claudeAccounts("usageAll");
        if (!result) throw codedHubError("RLY0_CORE_UNAVAILABLE");
        return result;
      }),
      // Official API keys of the four vendors (kept by rly0-core; models listed separately so
      // Codex's own requests never route to them).
      "agents.officialKeys.list": route(empty, async () => {
        const relays = await core.listRelays();
        const models = await this.#officialModels.read();
        const keys = (relays.available ? relays.relays : []).flatMap((relay) => {
          const vendor = officialVendorOf(relay);
          return vendor && relay.hasKey
            ? [
                {
                  vendor,
                  id: relay.id,
                  keyMask: relay.keyMask ?? null,
                  models: models[vendor] ?? [],
                },
              ]
            : [];
        });
        return { keys };
      }),
      "agents.officialKeys.set": route(
        z
          .object({
            vendor: z.enum(["openai", "anthropic", "google", "xai"]),
            apiKey: z.string().min(1).max(400),
          })
          .strict(),
        async (p) => {
          const spec = RLY0_OFFICIAL_VENDORS[p.vendor];
          const key = p.apiKey.trim();
          if (!spec.pattern.test(key)) throw codedHubError("API_KEY_INVALID");
          const relays = await core.listRelays();
          if (!relays.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
          const existing = relays.relays.find((relay) => officialVendorOf(relay) === p.vendor);
          let id: string;
          if (existing) {
            const updated = await core.updateRelay({
              id: existing.id,
              apiKey: key,
              enabled: true,
              models: [],
            });
            if (!updated.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
            id = existing.id;
          } else {
            const added = await core.addRelay({
              name: spec.name,
              baseUrl: spec.baseUrl,
              apiKey: key,
              models: [],
              enabled: true,
            });
            if (!added.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
            id = added.id;
          }
          const test = await core.testRelay({ id }).catch(() => null);
          const models = test && test.available && test.ok ? (test.models ?? []) : [];
          await this.#officialModels.set(p.vendor, models);
          if (p.vendor === "anthropic") await this.#agentRelays.set({ claudeCode: id });
          await this.#ensureProxyForRelays().catch(() => undefined);
          return {
            ok: true,
            id,
            valid: Boolean(test && test.available && test.ok),
            error: test && test.available && !test.ok ? (test.error ?? null) : null,
            modelCount: models.length,
          };
        },
      ),
      "agents.officialKeys.info": route(
        z.object({ vendor: z.enum(["openai", "anthropic", "google", "xai"]) }).strict(),
        async (p) => {
          const relays = await core.listRelays();
          const relay = relays.available
            ? relays.relays.find((entry) => officialVendorOf(entry) === p.vendor && entry.hasKey)
            : undefined;
          if (!relay) return { info: null };
          if (p.vendor === "anthropic")
            return { info: await core.claudeAccounts("keyInfo", { relayId: relay.id }) };
          const test = await core.testRelay({ id: relay.id }).catch(() => null);
          const ok = Boolean(test && test.available && test.ok);
          if (ok && test && test.available && test.models?.length)
            await this.#officialModels.set(p.vendor, test.models);
          return {
            info: {
              kind: "apiKey",
              keyMask: relay.keyMask ?? null,
              ...(ok
                ? { valid: true }
                : test && test.available && test.error === "RELAY_UNAUTHORIZED"
                  ? { valid: false }
                  : {}),
              ...(test && test.available && !test.ok && test.error ? { error: test.error } : {}),
              modelCount: (await this.#officialModels.read())[p.vendor]?.length ?? 0,
            },
          };
        },
      ),
      "agents.officialKeys.remove": route(
        z.object({ vendor: z.enum(["openai", "anthropic", "google", "xai"]) }).strict(),
        async (p) => {
          const relays = await core.listRelays();
          const relay = relays.available
            ? relays.relays.find((entry) => officialVendorOf(entry) === p.vendor)
            : undefined;
          if (relay) await core.removeRelay({ id: relay.id });
          await this.#officialModels.set(p.vendor, null);
          const selection = await this.#agentRelays.get();
          if (relay && selection.claudeCode === relay.id)
            await this.#agentRelays.set({ claudeCode: null });
          for (const [agent, choice] of Object.entries(selection.agents ?? {}))
            if (relay && choice?.relayId === relay.id)
              await this.#agentRelays.setAgent(agent as "pi" | "hermes" | "opencode", null);
          return { ok: true };
        },
      ),
      "agents.relays.get": route(empty, () => this.#agentRelays.get()),
      "agents.relays.setAgent": route(
        z
          .object({
            agent: z.enum(RLY0_RELAY_AGENTS),
            relayId: z.string().min(1).max(64).nullable(),
            model: z
              .string()
              .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/u)
              .nullable()
              .optional(),
          })
          .strict(),
        async (p) => {
          const next = await this.#agentRelays.setAgent(
            p.agent,
            p.relayId ? { relayId: p.relayId, model: p.model ?? null } : null,
          );
          if (p.relayId) await this.#ensureProxyForRelays().catch(() => undefined);
          return next;
        },
      ),
      "agents.relays.set": route(rly0RelayAgentsSetParamsSchema, (p) =>
        this.#agentRelays.set({ claudeCode: p.claudeCode }),
      ),

      "backup.status": route(empty, () => this.#backup.status()),
      "backup.restore": route(empty, () => this.#backup.restore()),

      "autostart.get": route(empty, () => this.#appearance.autostartStatus()),
      "autostart.set": route(rly0AppearanceAutostartSetParamsSchema, (p) =>
        this.#appearance.setAutostart(p.enabled),
      ),
    };
  }
}
