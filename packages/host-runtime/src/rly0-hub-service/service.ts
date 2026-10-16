import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

import {
  rly0AccountsImportCurrentParamsSchema,
  rly0AccountsRemoveParamsSchema,
  rly0AccountsRenameParamsSchema,
  rly0AccountsSwitchParamsSchema,
  rly0AccountsUsageParamsSchema,
  rly0AgentAuthLoginParamsSchema,
  rly0AgentIdParamsSchema,
  rly0AppearanceAutostartSetParamsSchema,
  rly0RelayAddParamsSchema,
  rly0RelayAgentsSetParamsSchema,
  rly0RelayBalanceParamsSchema,
  rly0RelayRemoveParamsSchema,
  rly0RelaySetEnabledParamsSchema,
  rly0RelayTestParamsSchema,
  rly0RelayUpdateParamsSchema,
  type Rly0Relay,
} from "@codexhost/shared-contracts";
import { z } from "zod";

import { AgentInstaller } from "../rly0-agents/agent-installer.js";
import { ClaudeCodeAuth } from "../rly0-agents/claude-code-auth.js";
import { Rly0AppearanceManager } from "../rly0-appearance/index.js";
import { WindowsRegistryAutostart } from "../rly0-appearance/windows-autostart.js";
import { applyProxyEnvironment, Rly0CoreBridge } from "../rly0-core/index.js";
import { Rly0FirstRunBackup } from "../rly0-maintenance/first-run-backup.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { Rly0AgentRelaySettings } from "../rly0-relay/agent-relays.js";
import { Rly0RelayModelRouter } from "../rly0-relay/model-routing.js";
import { listRly0HubAgents } from "./agents.js";
import { Rly0CodexControl } from "./codex-control.js";

/** 零号中转 itself: the relay the home page shows a balance for. */
const RLY0_HOSTS = /(^|\.)rly0\.com$/iu;
/** Fixed pages the Hub may open in the browser; nothing the page sends becomes a URL. */
export const RLY0_HUB_LINKS = {
  site: "https://rly0.com",
  recharge: "https://rly0.com/purchase",
} as const;
const HUB_STATE_FILE = "hub-desktop.json";

const empty = z.object({}).strict();
const linkParams = z.object({ target: z.enum(["site", "recharge"]) }).strict();

type Handler = (params: unknown) => Promise<unknown>;

export interface Rly0HubServiceOptions {
  readonly environment: NodeJS.ProcessEnv;
  readonly installRoot: string;
  /** What "开机自启" registers; omitted when this build has no Hub executable. */
  readonly autostartCommand?: string;
  readonly platform?: NodeJS.Platform;
  readonly core?: Rly0CoreBridge;
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
      downloadEnvironment: () => applyProxyEnvironment(environment, this.#core.getProxySettings()),
    });
    this.#claudeCode = new ClaudeCodeAuth({ environment });
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
    const statePath = path.join(resolveRly0DataDir(this.#options.environment), HUB_STATE_FILE);
    let firstRun = false;
    try {
      await fs.access(statePath);
    } catch {
      firstRun = true;
    }
    // Without a Hub executable to register (source checkout) the default waits for a real build.
    if (firstRun && this.#appearance.supported) {
      await this.#appearance.setAutostart(true).catch(() => undefined);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(
        statePath,
        `${JSON.stringify({ version: 1, autostartDefaulted: true })}\n`,
      );
    }
    await this.#backup.ensure().catch(() => false);
    await this.#ensureProxyForRelays().catch(() => undefined);
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
      "home.summary": route(empty, async () => {
        const [codex, proxy, zero, accounts] = await Promise.all([
          this.#codex.status(),
          core.proxyStatus(),
          this.#zeroRelay(),
          core.listAccounts(),
        ]);
        const current = accounts.available
          ? (accounts.accounts.find((account) => account.current) ?? null)
          : null;
        return {
          codex,
          proxy,
          zeroRelay: zero ? { id: zero.id, name: zero.name, hasKey: zero.hasKey } : null,
          currentAccount: current,
        };
      }),
      "balance.get": route(empty, async () => {
        const zero = await this.#zeroRelay();
        if (!zero) return { configured: false };
        return {
          configured: true,
          relayId: zero.id,
          ...(await core.relayBalance({ id: zero.id })),
        };
      }),
      "links.open": route(linkParams, (p) => {
        (this.#options.openUrl ?? openInBrowser)(RLY0_HUB_LINKS[p.target]);
        return { ok: true };
      }),

      "codex.status": route(empty, () => this.#codex.status()),
      "codex.open": route(empty, () => this.#codex.open()),
      "codex.restart": route(empty, () => this.#codex.restart()),

      "relay.list": route(empty, () => core.listRelays()),
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
      "relay.balance": route(rly0RelayBalanceParamsSchema, (p) => core.relayBalance(p)),

      "proxy.status": route(empty, () => core.proxyStatus()),
      "proxy.start": route(empty, async () => {
        await this.#router.ensureProxy();
        return core.proxyStatus();
      }),
      "proxy.stop": route(empty, () => core.proxyStop()),

      "accounts.list": route(empty, () => core.listAccounts()),
      "accounts.usage": route(rly0AccountsUsageParamsSchema, (p) => core.usage(p)),
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
