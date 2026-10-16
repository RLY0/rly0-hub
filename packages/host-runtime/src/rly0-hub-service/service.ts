import { spawn } from "node:child_process";

import {
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
  type Rly0Relay,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import { AgentInstaller } from "../rly0-agents/agent-installer.js";
import { ClaudeCodeAuth } from "../rly0-agents/claude-code-auth.js";
import { Rly0AppearanceManager } from "../rly0-appearance/index.js";
import { WindowsRegistryAutostart } from "../rly0-appearance/windows-autostart.js";
import { applyProxyEnvironment, Rly0CoreBridge } from "../rly0-core/index.js";
import { Rly0FirstRunBackup } from "../rly0-maintenance/first-run-backup.js";
import { Rly0AgentRelaySettings } from "../rly0-relay/agent-relays.js";
import { Rly0RelayModelRouter } from "../rly0-relay/model-routing.js";
import { createHubManagementRoutes } from "./management-routes.js";
import type { HostUpdateCoordinator } from "../update-coordinator.js";
import { listRly0HubAgents } from "./agents.js";
import { evaluateRly0HubAlerts } from "./alerts.js";
import { Rly0CodexControl } from "./codex-control.js";
import { Rly0HubStateStore } from "./hub-state.js";

/** 零号中转 itself: the relay the home page shows a balance for. */
const RLY0_HOSTS = /(^|\.)rly0\.com$/iu;
/** Fixed pages the Hub may open in the browser; nothing the page sends becomes a URL. */
export const RLY0_HUB_LINKS = {
  site: "https://rly0.com",
  recharge: "https://rly0.com/purchase?tab=recharge",
  github: RLY0_GITHUB_REPOSITORY_URL,
  nodejs: "https://nodejs.org",
  releases: RLY0_GITHUB_RELEASES_LATEST_URL,
} as const;

const empty = z.object({}).strict();
const linkParams = z
  .object({ target: z.enum(["site", "recharge", "github", "nodejs", "releases"]) })
  .strict();

type Handler = (params: unknown) => Promise<unknown>;

export interface Rly0HubServiceOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly installRoot: string;
  /** What "开机自启" registers; omitted when this build has no Hub executable. */
  readonly autostartCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly core?: Rly0CoreBridge;
  readonly updates?: Pick<HostUpdateCoordinator, "check">;
  readonly codex?: Rly0CodexControl;
  readonly appearance?: Rly0AppearanceManager;
  readonly openUrl?: (url: string) => void;
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
  // explorer.exe hands a URL to the default browser; the URL is one of the fixed links above.
  const child = spawn("explorer.exe", [url], { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

/**
 * Backend of the standalone RLY/0 Hub window: the same relay, account, agent and backup managers
 * the in-Codex settings use, reachable without Codex running. Every method has a fixed name and a
 * validated parameter shape; secrets (relay keys, sign-ins) stay inside rly0-core and the agents'
 * own CLIs.
 */
export class Rly0HubService {
  readonly #options: Rly0HubServiceOptions;
  readonly #core: Rly0CoreBridge;
  readonly #codex: Rly0CodexControl;
  readonly #appearance: Rly0AppearanceManager;
  readonly #router: Rly0RelayModelRouter;
  readonly #backup: Rly0FirstRunBackup;
  readonly #agentRelays: Rly0AgentRelaySettings;
  readonly #installer: AgentInstaller;
  readonly #claudeCode: ClaudeCodeAuth;
  readonly #state: Rly0HubStateStore;
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
    const { alerts, state } = evaluateRly0HubAlerts({ balance, quota }, before);
    if (JSON.stringify(state) !== JSON.stringify(before)) await this.#state.update(state);
    return { alerts };
  }

  async dispose(): Promise<void> {
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

      "agents.list": route(empty, () => ({
        agents: listRly0HubAgents(this.#options.environment, this.#options.platform),
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
      "agents.relays.get": route(empty, () => this.#agentRelays.get()),
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
