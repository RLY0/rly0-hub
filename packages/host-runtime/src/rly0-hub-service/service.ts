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
import { ClaudeIsolation } from "./claude-isolation.js";
import {
  sandboxConfigureSchema,
  sandboxPrepareSchema,
  sandboxSelectSchema,
  sandboxLoginIdSchema,
  sandboxLoginSubmitSchema,
} from "@codexhost/shared-contracts";
import { ClaudeCodeAuth } from "../rly0-agents/claude-code-auth.js";
import { Rly0AppearanceManager } from "../rly0-appearance/index.js";
import { WindowsRegistryAutostart } from "../rly0-appearance/windows-autostart.js";
import { applyProxyEnvironment, Rly0CoreBridge } from "../rly0-core/index.js";
import {
  codexHeartbeatAlive,
  codexHeartbeatBusy,
  readAgentStatus,
  type AgentStatusReport,
  requestAgentCheck,
  requestBackendReload,
} from "../rly0-maintenance/backend-reload-channel.js";
import { Rly0FirstRunBackup } from "../rly0-maintenance/first-run-backup.js";
import { Rly0DesktopCompatibility } from "../rly0-maintenance/desktop-compatibility.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { RLY0_RELAY_AGENTS, Rly0AgentRelaySettings } from "../rly0-relay/agent-relays.js";
import {
  keyFromAccountExport,
  officialVendorOf,
  RLY0_OFFICIAL_VENDORS,
  Rly0OfficialKeyModels,
  type Rly0OfficialVendor,
} from "../rly0-relay/official-keys.js";
import { Rly0OfficialKeyUsage } from "../rly0-relay/official-key-usage.js";
import { Rly0RelayModelRouter } from "../rly0-relay/model-routing.js";
import { createHubManagementRoutes } from "./management-routes.js";
import { Rly0LocalDiscovery } from "./local-discovery.js";
import { checkHubUpdate } from "./update-check.js";
import { Rly0HubUpdater } from "./hub-updater.js";
import { Rly0HubReleaseSource } from "./hub-release.js";
import {
  createUpdateHttpGet,
  downloadResumable,
  readWindowsSystemProxy,
  resolveUpdateProxy,
} from "./hub-update-net.js";
import { harnessLaunchPathSchema, type UpdateCheckResult } from "@codexhost/shared-contracts";
import { HarnessLaunchSettingsStore } from "@codexhost/harness-plugin-files";
import type { HostUpdateCoordinator } from "../update-coordinator.js";
import { apiKeyLogin, importLogin, parseLoginFile } from "./account-import.js";
import {
  importClaudeCredentials,
  parseClaudeImport,
  saveAnthropicApiKey,
} from "./claude-official.js";
import {
  listRly0HubAgents,
  rly0HubAgentDocsUrl,
  rly0HubAgentSharing,
  rly0HubAgentTakesLaunchPath,
} from "./agents.js";
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
import type { Rly0AgentAutoSwitchDeps } from "./agent-auto-switch.js";
import { createAgentAutoSwitch } from "./agent-auto-switch-routes.js";
import { createAgentAutoSwitchSources } from "./agent-auto-switch-sources.js";
import { codexApplyParams, Rly0CodexApplier } from "./codex-apply.js";
import { Rly0CodexControl } from "./codex-control.js";
import { noAccountStatus, relayCodexModels } from "./no-account.js";
import {
  createHostConsoleRoutes,
  createHubHostRequest,
  type HubHostRequest,
} from "./host-console-routes.js";
import { Rly0RelayCodexConfigManager } from "../rly0-relay/codex-config.js";
import { Rly0HubStateStore, type Rly0HubState } from "./hub-state.js";
import { Rly0HubAddLogin } from "./add-login.js";
import { ClaudeAddLogin, importClaudeAccountFile } from "./claude-add-login.js";
import { GrokAddLogin } from "./grok-add-login.js";
import { createAgentAccountRoutes } from "./agent-account-routes.js";
import { withConnectionHints } from "./agent-connection-hint.js";
import { AntigravityUsageReader } from "../rly0-agents/antigravity-usage.js";
import {
  DEFAULT_SHARED_RESOURCE_SETTINGS,
  setSharedResourceSettings,
  sharedResourceSettings,
} from "../shared-harness-resources.js";
import { sharedResourceStatus } from "../shared-resource-status.js";
import { resetPrepareParams, resetConsumeParams, resetAcknowledgeParams } from "./reset-credits.js";

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
  codexWebGpt: "https://github.com/miuuyy/codex-chatgpt-web/releases",
  claudeUsage: "https://claude.ai/settings/usage",
} as const;

const empty = z.object({}).strict();
const addLoginIdParams = z.object({ id: z.string().regex(/^[0-9a-f]{16}$/u) }).strict();
const linkParams = z
  .object({
    target: z.enum([
      "site",
      "recharge",
      "github",
      "nodejs",
      "releases",
      "keys",
      "codexWebGpt",
      "claudeUsage",
    ]),
  })
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
  readonly compatibility?: Pick<Rly0DesktopCompatibility, "check" | "takeNotice">;
  /** Ends Codex directly when the Launcher cannot (see `codex-processes.ts`); production only. */
  readonly killCodexProcesses?: () => Promise<number>;
  readonly appearance?: Rly0AppearanceManager;
  readonly openUrl?: (url: string) => void;
  /** "Add account" sign-ins; built from `core` when omitted. */
  readonly addLogin?: Rly0HubAddLogin;
  /** Claude / Grok auto-switch timing and busy signal (tests); the Codex heartbeat otherwise. */
  /** The local Host console channel (remote Hosts, usage statistics, session import); tests. */
  readonly hostRequest?: HubHostRequest;
  readonly agentAutoSwitch?: Partial<
    Pick<Rly0AgentAutoSwitchDeps, "busy" | "now" | "sleep" | "pollMs" | "maxWaitMs">
  >;
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
  readonly #compatibility: Pick<Rly0DesktopCompatibility, "check" | "takeNotice">;
  readonly #appearance: Rly0AppearanceManager;
  readonly #router: Rly0RelayModelRouter;
  readonly #backup: Rly0FirstRunBackup;
  readonly #agentRelays: Rly0AgentRelaySettings;
  readonly #officialModels: Rly0OfficialKeyModels;
  readonly #officialUsage: Rly0OfficialKeyUsage;
  #usageSequence = 0;
  readonly #usageReads = new Map<string, number>();
  readonly #discovery: Rly0LocalDiscovery;
  readonly #installer: AgentInstaller;
  readonly #isolation: ClaudeIsolation;
  readonly #claudeAdd: ClaudeAddLogin;
  readonly #grokAdd: GrokAddLogin;
  readonly #antigravity: AntigravityUsageReader;
  readonly #claudeCode: ClaudeCodeAuth;
  readonly #state: Rly0HubStateStore;
  readonly #codexConfig: Rly0RelayCodexConfigManager;
  readonly #addLogin: Rly0HubAddLogin;
  readonly #applier: Rly0CodexApplier;
  readonly #agentSwitch: ReturnType<typeof createAgentAutoSwitch>;
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
    this.#compatibility =
      options.compatibility ??
      new Rly0DesktopCompatibility({ environment, installRoot: options.installRoot });
    this.#codex =
      options.codex ??
      new Rly0CodexControl({
        environment,
        installRoot: options.installRoot,
        heartbeatAlive: () => codexHeartbeatAlive(resolveRly0DataDir(environment)),
        ...(options.killCodexProcesses ? { killProcesses: options.killCodexProcesses } : {}),
        ...(options.platform ? { platform: options.platform } : {}),
      });
    const dataDirectory = resolveRly0DataDir(environment);
    this.#applier = new Rly0CodexApplier({
      status: () => this.#codex.status(),
      restart: () => this.#codex.restart(),
      requestReload: (timeoutMs) => requestBackendReload(dataDirectory, { timeoutMs }),
      busy: () => codexHeartbeatBusy(dataDirectory),
      ...(options.backendReloadTimeoutMs === undefined
        ? {}
        : { reloadTimeoutMs: options.backendReloadTimeoutMs }),
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
    this.#officialUsage = new Rly0OfficialKeyUsage(environment);
    this.#discovery = new Rly0LocalDiscovery({
      environment,
      ...(options.platform ? { platform: options.platform } : {}),
    });
    this.#installer = new AgentInstaller({
      environment,
      ...(options.platform ? { platform: options.platform } : {}),
      downloadEnvironment: () => applyProxyEnvironment(environment, this.#core.getProxySettings()),
    });
    this.#claudeCode = new ClaudeCodeAuth({
      environment,
      ...(options.platform ? { platform: options.platform } : {}),
    });
    this.#isolation = new ClaudeIsolation(environment, options.platform ?? process.platform, {
      openUrl: (url) => (options.openUrl ?? openInBrowser)(url),
    });
    this.#claudeAdd = new ClaudeAddLogin({
      environment,
      ...(options.platform ? { platform: options.platform } : {}),
      core: this.#core,
      openUrl: (url) => (options.openUrl ?? openInBrowser)(url),
    });
    // Grok and Antigravity are found where the installer looks for them (PATH as it is now).
    this.#grokAdd = new GrokAddLogin({
      environment: () => this.#installer.searchEnvironment(),
      ...(options.platform ? { platform: options.platform } : {}),
      core: this.#core,
      openUrl: (url) => (options.openUrl ?? openInBrowser)(url),
    });
    this.#antigravity = new AntigravityUsageReader({
      environment: () => this.#installer.searchEnvironment(),
      snapshotPath: path.join(
        resolveRly0DataDir(environment),
        "quota-cache",
        "antigravity-usage.json",
      ),
      ...(options.platform ? { platform: options.platform } : {}),
    });
    this.#state = new Rly0HubStateStore(environment);
    const agentSources = createAgentAutoSwitchSources({
      core: this.#core,
      claudeSelection: async () => (await this.#agentRelays.get()).claudeCode ?? null,
      recordTokenUsage: (relay, info) => this.#officialUsage.record(relay, info),
      handle: (method, params) => this.handle(method, params),
    });
    this.#agentSwitch = createAgentAutoSwitch(this.#state, {
      candidates: agentSources.candidates,
      switchTo: agentSources.switchTo,
      busy: () => codexHeartbeatBusy(dataDirectory),
      ...options.agentAutoSwitch,
    });
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
    // Local metadata only: no model request and no change to the running client.
    await this.#compatibility.check().catch(() => undefined);
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
    // A new Hub version: one tray notice per version (the window also shows its own prompt).
    const update = await this.#updateStatus(false).catch(() => null);
    let next = state;
    const extra: Rly0HubAlert[] = [];
    const compatibilityNotice = await this.#compatibility.takeNotice().catch(() => null);
    if (compatibilityNotice)
      extra.push({ id: "compatibility", ...compatibilityNotice, action: "open" });
    if (
      update?.updateAvailable &&
      update.latestVersion &&
      state.updateNotifiedFor !== update.latestVersion
    ) {
      extra.push({
        id: "update",
        title: `RLY/0 Hub ${update.latestVersion} 可以更新了`,
        body: "点这里打开 Hub，查看更新内容并更新。",
        action: "open",
      });
      next = { ...state, updateNotifiedFor: update.latestVersion };
    }
    // Only what changed here: the Claude / Grok auto-switch writes its own keys meanwhile.
    const changed = Object.fromEntries(
      Object.entries(next).filter(
        ([key, value]) =>
          JSON.stringify(value) !== JSON.stringify(before[key as keyof Rly0HubState]),
      ),
    );
    if (Object.keys(changed).length) await this.#state.update(changed);
    // Claude / Grok keep their own state, written after the Codex part above.
    const agents = await this.#agentSwitch.switcher.check().catch(() => []);
    return {
      alerts: [...(switching?.alert ? [switching.alert] : []), ...agents, ...alerts, ...extra],
    };
  }

  #updater: Rly0HubUpdater | null = null;

  #releaseSource: Rly0HubReleaseSource | null = null;

  /** GitHub through the proxy chosen in 设置 → 网络代理 (or HTTPS_PROXY / the system proxy). */
  #updateProxy(): Promise<string | null> {
    return resolveUpdateProxy({
      settings: this.#core.getProxySettings(),
      environment: this.#options.environment,
      systemProxy: () => readWindowsSystemProxy(this.#options.platform ?? process.platform),
    });
  }

  /** Shared by the check and the update, so 立即更新 reuses what the check just found. */
  #releases(): Rly0HubReleaseSource {
    this.#releaseSource ??= new Rly0HubReleaseSource({
      get: async () => createUpdateHttpGet({ proxy: await this.#updateProxy(), timeoutMs: 15_000 }),
    });
    return this.#releaseSource;
  }

  #hubUpdater(): Rly0HubUpdater {
    this.#updater ??= new Rly0HubUpdater({
      installRoot: this.#options.installRoot,
      downloadDir: path.join(resolveRly0DataDir(this.#options.environment), "updates"),
      release: () => this.#releases().latest(),
      download: async (source, partial, onProgress) =>
        downloadResumable(
          createUpdateHttpGet({ proxy: await this.#updateProxy(), timeoutMs: 60_000 }),
          source,
          partial,
          onProgress,
        ),
    });
    return this.#updater;
  }

  /**
   * Downloads and installs the latest version. Codex holds the bundled runtime open, so it is
   * closed first (only when the window confirmed it) and the installer opens it again.
   */
  async #installUpdate(closeCodex: boolean) {
    const codex = await this.#codex.status();
    if (codex.running) {
      if (!closeCodex) return { ...this.#hubUpdater().progress(), needsCodexClose: true };
      await this.#codex.forceQuit().catch(() => ({ ok: false }));
      // Give Codex a moment to let go of the files; the installer closes what is still open.
      for (let i = 0; i < 20 && (await this.#codex.status()).running; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { ...this.#hubUpdater().start({ reopenCodex: codex.running }), needsCodexClose: false };
  }

  #updateCache: { at: number; result: UpdateCheckResult } | null = null;
  #updateRunning: Promise<UpdateCheckResult> | null = null;

  /** Checks GitHub at most every 6 hours (or now when asked); the result is shared. */
  async #updateStatus(force: boolean): Promise<UpdateCheckResult> {
    const fresh = this.#updateCache && Date.now() - this.#updateCache.at < 6 * 60 * 60_000;
    if (!force && fresh && this.#updateCache) return this.#updateCache.result;
    this.#updateRunning ??= checkHubUpdate(this.#options.installRoot, () =>
      this.#releases().latest(force ? { maxAgeMs: 0 } : {}),
    )
      .then((result) => {
        if (!result.error) this.#updateCache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        this.#updateRunning = null;
      });
    return this.#updateRunning;
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

  /**
   * Keys and relays already set up on this computer (see `local-discovery.ts`), each marked
   * whether the Hub has it already. Values never leave this process.
   */
  async #discoveryScan(core: Rly0CoreBridge) {
    const [items, relays] = await Promise.all([this.#discovery.scan(), core.listRelays()]);
    const saved = relays.available ? relays.relays : [];
    const last4 = (mask: string | null | undefined) => (mask ?? "").slice(-4);
    const norm = (base: string) => base.toLowerCase().replace(/\/+$/u, "");
    return {
      coreAvailable: relays.available,
      items: items.map((item) => {
        const match = saved.find((relay) =>
          item.kind === "officialKey"
            ? officialVendorOf(relay) === item.vendor
            : item.baseUrl !== null && norm(relay.baseUrl) === norm(item.baseUrl),
        );
        const state = !match
          ? "new"
          : match.hasKey && last4(match.keyMask) === last4(item.keyMask)
            ? "saved"
            : "differs";
        return { ...item, state };
      }),
    };
  }

  async #discoveryImport(core: Rly0CoreBridge, ids: readonly string[]) {
    const secrets = await this.#discovery.scanSecrets();
    const relays = await core.listRelays();
    if (!relays.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      const item = secrets.find((entry) => entry.id === id);
      if (!item) {
        results.push({ id, ok: false, error: "DISCOVERY_ITEM_GONE" });
        continue;
      }
      try {
        if (item.kind === "officialKey") {
          await this.#saveOfficialKey(core, item.vendor, item.secret);
        } else if (item.baseUrl) {
          const base = item.baseUrl.toLowerCase();
          const existing = relays.relays.find(
            (relay) => relay.baseUrl.toLowerCase().replace(/\/+$/u, "") === base,
          );
          if (existing) {
            const updated = await core.updateRelay({ id: existing.id, apiKey: item.secret });
            if (!updated.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
          } else {
            // No models: Codex keeps going to this relay the way it did; routing models through
            // the Hub is a choice made on the relay page.
            const added = await core.addRelay({
              name: item.name.slice(0, 40),
              baseUrl: item.baseUrl,
              apiKey: item.secret,
              models: [],
              enabled: true,
            });
            if (!added.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
          }
        }
        results.push({ id, ok: true });
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z_]+$/u.test(error.message)
            ? error.message
            : "IMPORT_FAILED";
        results.push({ id, ok: false, error: code });
      }
    }
    await this.#ensureProxyForRelays().catch(() => undefined);
    return { results, imported: results.filter((r) => r.ok).length };
  }

  async #saveOfficialKey(
    core: Rly0CoreBridge,
    vendor: Rly0OfficialVendor,
    apiKey: string,
    replaceId?: string,
  ): Promise<Record<string, unknown>> {
    const spec = RLY0_OFFICIAL_VENDORS[vendor];
    const key = apiKey.trim();
    if (!spec.pattern.test(key)) throw codedHubError("API_KEY_INVALID");
    const relays = await core.listRelays();
    if (!relays.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
    const existing = relays.relays.find(
      (relay) => officialVendorOf(relay) === vendor && (!replaceId || relay.id === replaceId),
    );
    if (replaceId && !existing) throw codedHubError("OFFICIAL_KEY_NOT_FOUND");
    if (
      vendor === "anthropic" &&
      replaceId &&
      (await this.#agentRelays.get()).claudeCode === replaceId
    )
      throw codedHubError("OFFICIAL_KEY_IN_USE");
    let id: string;
    if (vendor === "anthropic") {
      ({ id } = await saveAnthropicApiKey(core, key, replaceId));
    } else if (existing) {
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
    await this.#officialModels.set(vendor, models);
    // Adding a credential never switches the active identity. Selection is a separate command.
    await this.#ensureProxyForRelays().catch(() => undefined);
    return {
      ok: true,
      id,
      valid: Boolean(test && test.available && test.ok),
      error: test && test.available && !test.ok ? (test.error ?? null) : null,
      modelCount: models.length,
    };
  }

  async #officialKey(core: Rly0CoreBridge, vendor: Rly0OfficialVendor, id?: string) {
    const listed = await core.listRelays();
    if (!listed.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
    const entries = listed.relays.filter((entry) => officialVendorOf(entry) === vendor);
    if (id) {
      const found = entries.find((entry) => entry.id === id);
      if (!found) throw codedHubError("OFFICIAL_KEY_NOT_FOUND");
      return found;
    }
    const selected = vendor === "anthropic" ? (await this.#agentRelays.get()).claudeCode : null;
    return entries.find((entry) => entry.id === selected) ?? entries[0];
  }

  async dispose(): Promise<void> {
    this.#isolation.close();
    this.#claudeAdd.close();
    this.#grokAdd.close();
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

  async #hinted(report: AgentStatusReport | null): Promise<AgentStatusReport | null> {
    if (!report) return null;
    const agents = listRly0HubAgents(
      await this.#installer.searchEnvironment(),
      this.#options.platform,
    );
    return withConnectionHints(report, agents);
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
        compatibility: this.#compatibility,
        updateBusy: () =>
          ["downloading", "verifying", "installing"].includes(
            this.#updater?.progress().phase ?? "idle",
          ),
        updates: this.#options.updates ?? {
          check: () =>
            checkHubUpdate(this.#options.installRoot, () =>
              this.#releases().latest({ maxAgeMs: 0 }),
            ),
        },
      }),
      ...createHostConsoleRoutes(
        this.#options.hostRequest ??
          createHubHostRequest({ environment: this.#options.environment }),
      ),
      ...createAgentAccountRoutes({
        core,
        grokAdd: this.#grokAdd,
        antigravity: this.#antigravity,
        saveXaiKeyFile: (content) =>
          this.#saveOfficialKey(core, "xai", keyFromAccountExport(content, "xai")),
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
      // Background update state for the window: cached, re-checked every 6 hours or on demand.
      "updates.status": route(z.object({ force: z.boolean().optional() }).strict(), (p) =>
        this.#updateStatus(p.force === true),
      ),
      "updates.install": route(z.object({ closeCodex: z.boolean().optional() }).strict(), (p) =>
        this.#installUpdate(p.closeCodex === true),
      ),
      "updates.progress": route(empty, () => this.#hubUpdater().progress()),
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
      ...this.#agentSwitch.routes,
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

      "codex.status": route(empty, async () => ({
        ...(await this.#codex.status()),
        restartPending: this.#applier.pending,
      })),
      "codex.open": route(empty, () => this.#codex.open()),
      "codex.restart": route(empty, () => this.#codex.restart()),
      // After a settings change: apply it to the running Codex (see codex-apply.ts).
      "codex.applySettings": route(codexApplyParams, (p) => this.#applier.apply(p)),
      "codex.applyCancel": route(empty, async () => this.#applier.cancel()),

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
      "resources.sharingGet": route(empty, () => this.#sharingState()),
      "resources.sharingSet": route(
        z
          .object({
            mcp: z.boolean().optional(),
            skills: z.boolean().optional(),
            memory: z.boolean().optional(),
            /** The former single switch: sets all three. */
            enabled: z.boolean().optional(),
          })
          .strict(),
        async (p) => {
          const all = p.enabled;
          await setSharedResourceSettings(this.#options.environment, {
            ...(all === undefined ? {} : { mcp: all, skills: all, memory: all }),
            ...(p.mcp === undefined ? {} : { mcp: p.mcp }),
            ...(p.skills === undefined ? {} : { skills: p.skills }),
            ...(p.memory === undefined ? {} : { memory: p.memory }),
          });
          return this.#sharingState();
        },
      ),
      "accounts.usage": route(rly0AccountsUsageParamsSchema, (p) => core.usage(p)),
      "accounts.current": route(empty, () => core.currentAccount()),
      "accounts.usageCurrent": route(empty, () => core.usageCurrent()),
      "accounts.usageAll": route(empty, () => core.usageAll()),
      "accounts.resetPrepare": route(resetPrepareParams, (p) => core.resetPrepare(p)),
      "accounts.resetConsume": route(resetConsumeParams, (p) => core.resetConsume(p)),
      "accounts.resetAcknowledge": route(resetAcknowledgeParams, (p) => core.resetAcknowledge(p)),
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
      "agents.isolation.status": route(empty, () => this.#isolation.status()),
      "agents.isolation.configure": route(sandboxConfigureSchema, (p) =>
        this.#isolation.configure(p),
      ),
      "agents.isolation.prepare": route(sandboxPrepareSchema, (p) => this.#isolation.prepare(p)),
      "agents.isolation.cancel": route(empty, () => this.#isolation.cancel()),
      "agents.isolation.forget": route(sandboxSelectSchema, (p) =>
        this.#isolation.forget(p.project),
      ),
      "agents.isolation.disable": route(empty, () => this.#isolation.disable()),
      "agents.isolation.login": route(sandboxSelectSchema, (p) => this.#isolation.login(p.project)),
      "agents.isolation.loginSubmit": route(sandboxLoginSubmitSchema, (p) =>
        this.#isolation.loginSubmit(p.id, p.code),
      ),
      "agents.isolation.loginCancel": route(sandboxLoginIdSchema, (p) =>
        this.#isolation.loginCancel(p.id),
      ),
      "agents.isolation.loginOpen": route(sandboxLoginIdSchema, (p) =>
        this.#isolation.loginOpen(p.id),
      ),
      "agents.isolation.dockerLogin": route(empty, () => this.#isolation.login()),
      "agents.isolation.install": route(empty, () => this.#isolation.install()),
      "agents.installStart": route(rly0AgentIdParamsSchema, (p) => this.#installer.start(p.agent)),
      "agents.installStatus": route(rly0AgentIdParamsSchema, (p) =>
        this.#installer.status(p.agent),
      ),
      // 应用路径 for desktop-app agents (ZCode, WorkBuddy): the same per-plugin file the Host reads
      // at start, so a change applies after Codex restarts.
      "agents.launchPathGet": route(rly0AgentIdParamsSchema, async (p) => {
        if (!rly0HubAgentTakesLaunchPath(p.agent)) throw codedHubError("LAUNCH_PATH_UNSUPPORTED");
        return await new HarnessLaunchSettingsStore(this.#options.environment).get(p.agent);
      }),
      "agents.launchPathSet": route(
        z
          .object({
            agent: z.string().max(40),
            path: harnessLaunchPathSchema.nullable(),
          })
          .strict(),
        async (p) => {
          if (!rly0HubAgentTakesLaunchPath(p.agent)) throw codedHubError("LAUNCH_PATH_UNSUPPORTED");
          // A relative path or one that does not exist is refused by the store.
          return await new HarnessLaunchSettingsStore(this.#options.environment)
            .set(p.agent, p.path)
            .catch(() => {
              throw codedHubError("LAUNCH_PATH_INVALID");
            });
        },
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
            await saveAnthropicApiKey(core, parsed.token);
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
      // Each failed entry gets a plain-words hint that also uses what the Hub sees here (an agent
      // installed after Codex started, or only its desktop app).
      "agents.connectionStatus": route(empty, async () => ({
        report: await this.#hinted(
          await readAgentStatus(resolveRly0DataDir(this.#options.environment)),
        ),
      })),
      "agents.checkConnections": route(empty, async () => {
        const codex = await this.#codex.status();
        if (!codex.running) return { report: null, codexRunning: false };
        return {
          report: await this.#hinted(
            await requestAgentCheck(resolveRly0DataDir(this.#options.environment)),
          ),
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
      // Add another account without signing the current one out: the official browser login
      // in a throw-away CLAUDE_CONFIG_DIR (claude-add-login.ts), or a credentials file.
      "agents.claudeAccounts.addLoginStart": route(
        z.object({ alias: z.string().trim().min(1).max(40).optional() }).strict(),
        (p) => this.#claudeAdd.start(p.alias),
      ),
      "agents.claudeAccounts.addLoginStatus": route(empty, () => this.#claudeAdd.status()),
      "agents.claudeAccounts.addLoginSubmit": route(sandboxLoginSubmitSchema, (p) =>
        this.#claudeAdd.submit(p.id, p.code),
      ),
      "agents.claudeAccounts.addLoginOpen": route(sandboxLoginIdSchema, (p) =>
        this.#claudeAdd.reopen(p.id),
      ),
      "agents.claudeAccounts.addLoginCancel": route(sandboxLoginIdSchema, (p) =>
        this.#claudeAdd.cancel(p.id),
      ),
      "agents.claudeAccounts.importFile": route(
        z
          .object({
            content: z
              .string()
              .min(2)
              .max(256 * 1024),
            alias: z.string().trim().min(1).max(40).optional(),
          })
          .strict(),
        (p) =>
          importClaudeAccountFile(core, p.content, {
            ...(p.alias ? { alias: p.alias } : {}),
            saveToken: async (token) => {
              await saveAnthropicApiKey(core, token);
              await this.#ensureProxyForRelays().catch(() => undefined);
            },
          }),
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
        const entry = await this.#officialKey(core, "anthropic");
        if (!entry) return { info: null };
        return { info: await core.claudeAccounts("keyInfo", { relayId: entry.id }) };
      }),
      // One account's quota; a saved (not current) account's expired token is renewed first.
      "agents.claudeAccounts.usage": route(
        z.object({ id: z.string().regex(/^[a-f0-9]{12}$/u) }).strict(),
        async (p) => {
          const result = await core.claudeAccounts("usage", { id: p.id });
          if (!result) throw codedHubError("RLY0_CORE_UNAVAILABLE");
          return result;
        },
      ),
      "agents.claudeAccounts.usageAll": route(empty, async () => {
        const result = await core.claudeAccounts("usageAll");
        if (!result) throw codedHubError("RLY0_CORE_UNAVAILABLE");
        return result;
      }),
      // Official API keys of the four vendors (kept by rly0-core; models listed separately so
      // Codex's own requests never route to them).
      "discovery.scan": route(empty, () => this.#discoveryScan(core)),
      "discovery.import": route(
        z
          .object({
            ids: z
              .array(z.string().regex(/^[0-9a-f]{16}$/u))
              .min(1)
              .max(50),
          })
          .strict(),
        (p) => this.#discoveryImport(core, p.ids),
      ),
      "agents.officialKeys.list": route(empty, async () => {
        const [relays, models, snapshots] = await Promise.all([
          core.listRelays(),
          this.#officialModels.read(),
          this.#officialUsage.read(),
        ]);
        const keys = (relays.available ? relays.relays : []).flatMap((relay) => {
          const vendor = officialVendorOf(relay);
          return vendor && relay.hasKey
            ? [
                {
                  vendor,
                  id: relay.id,
                  name: relay.name,
                  keyMask: relay.keyMask ?? null,
                  keyRevision: relay.keyRevision,
                  lastUsage: this.#officialUsage.forRelay(relay, snapshots)?.usage,
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
            id: z
              .string()
              .regex(/^[a-f0-9]{12}$/u)
              .optional(),
          })
          .strict(),
        (p) => this.#saveOfficialKey(core, p.vendor, p.apiKey, p.id),
      ),
      "agents.officialKeys.rename": route(
        z
          .object({
            vendor: z.enum(["openai", "anthropic", "google", "xai"]),
            id: z
              .string()
              .regex(/^[a-f0-9]{12}$/u)
              .optional(),
            name: z.string().trim().min(1).max(40),
          })
          .strict(),
        async (p) => {
          const relay = await this.#officialKey(core, p.vendor, p.id);
          if (!relay || !relay.hasKey) throw codedHubError("OFFICIAL_KEY_NOT_FOUND");
          const result = await core.updateRelay({ id: relay.id, name: p.name });
          if (!result.available) throw codedHubError("RLY0_CORE_UNAVAILABLE");
          return { ok: true, id: relay.id, name: p.name };
        },
      ),
      // A Sub2API account export: the vendor's key in it is saved like a typed one.
      "agents.officialKeys.importFile": route(
        z
          .object({
            vendor: z.enum(["openai", "anthropic", "google", "xai"]),
            content: z
              .string()
              .min(2)
              .max(256 * 1024),
          })
          .strict(),
        (p) => this.#saveOfficialKey(core, p.vendor, keyFromAccountExport(p.content, p.vendor)),
      ),
      "agents.officialKeys.info": route(
        z
          .object({
            vendor: z.enum(["openai", "anthropic", "google", "xai"]),
            id: z
              .string()
              .regex(/^[a-f0-9]{12}$/u)
              .optional(),
          })
          .strict(),
        async (p) => {
          const relay = await this.#officialKey(core, p.vendor, p.id);
          if (!relay) return { info: null };
          if (p.vendor === "anthropic") {
            const sequence = ++this.#usageSequence;
            this.#usageReads.set(relay.id, sequence);
            if (this.#usageReads.size > 256)
              this.#usageReads.delete(this.#usageReads.keys().next().value ?? "");
            const info = await core.claudeAccounts("keyInfo", { relayId: relay.id });
            if (!info) throw codedHubError("RLY0_CORE_UNAVAILABLE");
            const current = await this.#officialKey(core, p.vendor, relay.id);
            if (!current || (relay.keyRevision && current.keyRevision !== relay.keyRevision))
              throw codedHubError("OFFICIAL_KEY_CHANGED");
            const saved =
              this.#usageReads.get(relay.id) === sequence
                ? await this.#officialUsage.record(relay, info)
                : true;
            const previous = this.#officialUsage.forRelay(
              current,
              await this.#officialUsage.read(),
            );
            const fallback =
              !info.usage && info.valid !== false && info.usageError !== "USAGE_TOKEN_EXPIRED"
                ? previous?.usage
                : undefined;
            const final = await this.#officialKey(core, p.vendor, relay.id);
            if (!final || (relay.keyRevision && final.keyRevision !== relay.keyRevision))
              throw codedHubError("OFFICIAL_KEY_CHANGED");
            return {
              info: {
                ...info,
                ...(fallback ? { usage: fallback, usageCached: true } : {}),
                ...(saved ? {} : { cacheError: "USAGE_CACHE_SAVE_FAILED" }),
                id: relay.id,
                name: final.name,
                keyRevision: final.keyRevision,
              },
            };
          }
          const test = await core.testRelay({ id: relay.id }).catch(() => null);
          const ok = Boolean(test && test.available && test.ok);
          if (ok && test && test.available && test.models?.length)
            await this.#officialModels.set(p.vendor, test.models);
          return {
            info: {
              kind: "apiKey",
              id: relay.id,
              name: relay.name,
              keyMask: relay.keyMask ?? null,
              keyRevision: relay.keyRevision,
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
        z
          .object({
            vendor: z.enum(["openai", "anthropic", "google", "xai"]),
            id: z
              .string()
              .regex(/^[a-f0-9]{12}$/u)
              .optional(),
          })
          .strict(),
        async (p) => {
          const relay = await this.#officialKey(core, p.vendor, p.id);
          const selection = await this.#agentRelays.get();
          if (p.vendor === "anthropic" && relay && selection.claudeCode === relay.id)
            throw codedHubError("OFFICIAL_KEY_IN_USE");
          if (relay) await core.removeRelay({ id: relay.id });
          if (p.vendor !== "anthropic") await this.#officialModels.set(p.vendor, null);
          if (relay && selection.claudeCode === relay.id)
            await this.#agentRelays.set({ claudeCode: null });
          for (const [agent, choice] of Object.entries(selection.agents ?? {}))
            if (relay && choice?.relayId === relay.id)
              await this.#agentRelays.setAgent(agent as "pi" | "hermes" | "opencode", null);
          return { ok: true };
        },
      ),
      "agents.officialKeys.select": route(
        z
          .object({ vendor: z.literal("anthropic"), id: z.string().regex(/^[a-f0-9]{12}$/u) })
          .strict(),
        async (p) => {
          const relay = await this.#officialKey(core, p.vendor, p.id);
          if (!relay || !relay.enabled || !relay.hasKey)
            throw codedHubError("OFFICIAL_KEY_NOT_AVAILABLE");
          await this.#ensureProxyForRelays();
          await this.#agentRelays.set({ claudeCode: relay.id });
          return { ok: true, id: relay.id };
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

  /**
   * Codex MCP / skills / memory shared with other Agents. Agents read the settings each time
   * they open a session or send a turn (shared-harness-resources.ts), so a change reaches the
   * next conversation or message without restarting Codex.
   */
  async #sharingState() {
    const environment = this.#options.environment;
    const settings = await sharedResourceSettings(environment);
    const agents = listRly0HubAgents(
      await this.#installer.searchEnvironment(),
      this.#options.platform,
    );
    return {
      ...settings,
      enabled: settings.mcp || settings.skills || settings.memory,
      defaults: DEFAULT_SHARED_RESOURCE_SETTINGS,
      agents: await Promise.all(
        agents.map(async (agent) => {
          const status = await sharedResourceStatus({ environment, harnessId: agent.id, settings });
          return {
            id: agent.id,
            name: agent.name,
            installed: agent.installed,
            support: status.support,
            blocked: status.blocked,
            note: rly0HubAgentSharing(agent.id).note ?? null,
          };
        }),
      ),
    };
  }
}
