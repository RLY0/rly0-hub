import { readCoreUsageSnapshot } from "./core-usage-snapshot.js";
import { readCodexRendererPolicy, rendererPolicyBootstrap } from "./codex-renderer-policy.js";
import { createCoreRendererSession } from "./core-renderer-session.js";
import type { CodexRendererPolicy } from "@codexhost/shared-contracts";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { openRendererLocalPage } from "./renderer-local-page.js";
import { CdpClient, CdpConnectionClosedError, listCdpTargets } from "./cdp-client.js";
import { remoteConnectionsExpression } from "./remote-connections-control.js";
import { remoteConnectionsReplySchema } from "@codexhost/shared-contracts";

import {
  startControllerAttachmentServer,
  type ControllerAttachmentServer,
  type StartControllerAttachmentServerOptions,
} from "./controller-attachment-server.js";
import {
  createControllerStatusPublisher,
  createRendererStatusReporter,
  type DesktopControllerStatusDocument,
} from "./controller-status.js";
import {
  installRendererCdpControlSession,
  selectPrimaryRendererTarget,
  type RendererCdpControlSession,
} from "./renderer-cdp-control-session.js";

export interface DesktopControllerOptions {
  rendererCdpEndpoint: string;
  rendererPath: string;
  attachmentPort: number;
  attachmentNonce: string;
  /**
   * Safe mode: keep the handshake, attachment server and status, but never inject the
   * Renderer Extension or its native RPC patches. The Hub decides when to ask for it.
   */
  noRenderer?: true;
}

export interface DesktopControllerReadiness {
  schemaVersion: 2;
  state: "compatible";
  issues: [];
}

export interface DesktopControllerDependencies {
  readRenderer(filePath: string): Promise<string>;
  readPolicy?(): Promise<CodexRendererPolicy>;
  readCoreUsage?(): Promise<unknown>;
  installCore?(options: {
    rendererCdpEndpoint: string;
    policy: CodexRendererPolicy;
  }): Promise<RendererCdpControlSession>;
  install(options: {
    rendererCdpEndpoint: string;
    rendererSource: string;
    enabledAgents?: readonly string[];
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<RendererCdpControlSession>;
  startAttachmentServer(
    options: StartControllerAttachmentServerOptions,
  ): Promise<ControllerAttachmentServer>;
  ready(readiness: DesktopControllerReadiness): void;
  /** Publishes Renderer integration state for the codexhost console. */
  publishStatus?(document: DesktopControllerStatusDocument): void;
  sleep(milliseconds: number): Promise<void>;
  /** Safe mode only: brings the Desktop window forward without installing anything. */
  bringToFront?(rendererCdpEndpoint: string): Promise<void>;
  now?(): number;
  monitorIntervalMs: number;
}

const PRODUCTION_INSTALL_TIMEOUT_MS = 90_000;
const RENDERER_CSP_BOOTSTRAP =
  "globalThis.__zod_globalConfig ??= {}; globalThis.__zod_globalConfig.jitless = true;";
const DESKTOP_CONTROLLER_READINESS_MAX_BYTES = 512;
const TRANSIENT_INSTALL_ATTEMPTS = 3;
const TRANSIENT_INSTALL_RETRY_MS = 250;
const RECOVERY_RETRY_INITIAL_MS = 30_000;
const RECOVERY_RETRY_MAX_MS = 300_000;
const startupTraceStartedAt = Date.now();

function startupTrace(stage: string, detail?: unknown): void {
  if (process.env.CODEXHOST_STARTUP_TRACE !== "1") return;
  const suffix =
    detail === undefined ? "" : `: ${detail instanceof Error ? detail.message : String(detail)}`;
  console.error(
    `[codexhost startup +${Date.now() - startupTraceStartedAt}ms] controller: ${stage}${suffix}`,
  );
}

export function serializeDesktopControllerReadiness(readiness: DesktopControllerReadiness): string {
  if (
    readiness.schemaVersion !== 2 ||
    readiness.state !== "compatible" ||
    !Array.isArray(readiness.issues) ||
    readiness.issues.length !== 0 ||
    Object.keys(readiness).length !== 3
  ) {
    throw new Error("Desktop Controller readiness is invalid");
  }
  const line = JSON.stringify(readiness);
  if (Buffer.byteLength(line, "utf8") > DESKTOP_CONTROLLER_READINESS_MAX_BYTES) {
    throw new Error("Desktop Controller readiness exceeds its size limit");
  }
  return line;
}

/** Plain `Page.bringToFront` on the primary window; nothing is evaluated in the page. */
async function bringRendererToFront(rendererCdpEndpoint: string): Promise<void> {
  const target = selectPrimaryRendererTarget(await listCdpTargets(rendererCdpEndpoint));
  if (!target) throw new Error("Codex Desktop window is not available");
  const client = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await client.command("Page.bringToFront");
  } finally {
    client.close();
  }
}

export const RENDERER_DISABLED_MESSAGE = "Renderer integration is disabled in safe mode";

const defaultDependencies: DesktopControllerDependencies = {
  readPolicy: () => readCodexRendererPolicy(),
  readCoreUsage: () => readCoreUsageSnapshot(),
  readRenderer: (filePath) => readFile(filePath, "utf8"),
  install: installRendererCdpControlSession,
  startAttachmentServer: startControllerAttachmentServer,
  ready: (readiness) => {
    process.stdout.write(`${serializeDesktopControllerReadiness(readiness)}\n`);
  },
  publishStatus: createControllerStatusPublisher(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  bringToFront: bringRendererToFront,
  monitorIntervalMs: 500,
};

function rendererCdpEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    (url.pathname !== "/" && url.pathname !== "") ||
    url.search ||
    url.hash
  ) {
    throw new Error("--renderer-cdp-endpoint must be a loopback HTTP origin with an explicit port");
  }
  return url.origin;
}

export function parseDesktopControllerArguments(
  arguments_: readonly string[],
): DesktopControllerOptions {
  let endpoint: string | undefined;
  let rendererPath: string | undefined;
  let attachmentPort: number | undefined;
  let attachmentNonce: string | undefined;
  let noRenderer = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--renderer-cdp-endpoint") {
      if (endpoint !== undefined) {
        throw new Error("--renderer-cdp-endpoint may only be provided once");
      }
      if (!value) throw new Error("--renderer-cdp-endpoint requires a value");
      endpoint = rendererCdpEndpoint(value);
      index += 1;
      continue;
    }
    if (argument === "--renderer") {
      if (rendererPath !== undefined) throw new Error("--renderer may only be provided once");
      if (!value) throw new Error("--renderer requires a value");
      if (!path.isAbsolute(value)) throw new Error("--renderer must be an absolute path");
      rendererPath = path.normalize(value);
      index += 1;
      continue;
    }
    if (argument === "--attachment-port") {
      if (attachmentPort !== undefined) {
        throw new Error("--attachment-port may only be provided once");
      }
      const port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new Error("--attachment-port must be a valid TCP port");
      }
      attachmentPort = port;
      index += 1;
      continue;
    }
    if (argument === "--attachment-nonce") {
      if (attachmentNonce !== undefined) {
        throw new Error("--attachment-nonce may only be provided once");
      }
      if (value === undefined || !/^[0-9a-f]{32}$/.test(value)) {
        throw new Error("--attachment-nonce must be 32 lowercase hexadecimal characters");
      }
      attachmentNonce = value;
      index += 1;
      continue;
    }
    if (argument === "--no-renderer") {
      if (noRenderer) throw new Error("--no-renderer may only be provided once");
      noRenderer = true;
      continue;
    }
    throw new Error(`unknown Desktop Controller option: ${argument}`);
  }
  if (endpoint === undefined) throw new Error("--renderer-cdp-endpoint is required");
  if (rendererPath === undefined) throw new Error("--renderer is required");
  if (attachmentPort === undefined) throw new Error("--attachment-port is required");
  if (attachmentNonce === undefined) throw new Error("--attachment-nonce is required");
  return {
    rendererCdpEndpoint: endpoint,
    rendererPath,
    attachmentPort,
    attachmentNonce,
    ...(noRenderer ? { noRenderer: true as const } : {}),
  };
}

function isTransientRendererInstallError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof CdpConnectionClosedError) return true;
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Execution context was destroyed") ||
      message.includes("Promise was collected")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
    if (current === undefined) break;
  }
  return false;
}

async function installProductionSession(
  options: Parameters<DesktopControllerDependencies["install"]>[0],
  dependencies: DesktopControllerDependencies,
): Promise<RendererCdpControlSession> {
  for (let attempt = 1; attempt <= TRANSIENT_INSTALL_ATTEMPTS; attempt += 1) {
    try {
      return await dependencies.install(options);
    } catch (error) {
      if (attempt === TRANSIENT_INSTALL_ATTEMPTS || !isTransientRendererInstallError(error)) {
        throw error;
      }
      await dependencies.sleep(TRANSIENT_INSTALL_RETRY_MS);
    }
  }
  throw new Error("Desktop Controller exhausted Renderer installation attempts");
}

/** Policy refresh tears down injected owners before a new mode starts; Desktop keeps running. */
export async function runDesktopController(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies = defaultDependencies,
): Promise<void> {
  if (!dependencies.readPolicy)
    return runDesktopControllerSession(options, signal, dependencies, {
      schemaVersion: 1,
      mode: "full",
      disabled: [],
    });
  let policy = await dependencies.readPolicy();
  while (!signal.aborted) {
    const transition = new AbortController();
    const combined = AbortSignal.any([signal, transition.signal]);
    let next: CodexRendererPolicy | null = null;
    let polling = false;
    const timer = setInterval(() => {
      if (polling || combined.aborted) return;
      polling = true;
      void dependencies
        .readPolicy?.()
        .then((candidate) => {
          if (JSON.stringify(candidate) !== JSON.stringify(policy)) {
            next = candidate;
            transition.abort();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          polling = false;
        });
    }, 2000);
    try {
      await runDesktopControllerSession(options, combined, dependencies, policy);
    } finally {
      clearInterval(timer);
    }
    if (!next || signal.aborted) return;
    policy = next;
  }
}

async function runDesktopControllerSession(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies,
  policy: CodexRendererPolicy,
): Promise<void> {
  const now = dependencies.now ?? Date.now;
  let session: RendererCdpControlSession | undefined;
  let nextRecoveryAt = 0;
  let recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
  const status = createRendererStatusReporter(
    (document) => dependencies.publishStatus?.(document),
    now,
  );
  const recordRecoveryFailure = (error: unknown): void => {
    nextRecoveryAt = now() + recoveryDelayMs;
    recoveryDelayMs = Math.min(recoveryDelayMs * 2, RECOVERY_RETRY_MAX_MS);
    status.failed(error);
  };
  const recordRecoverySuccess = (): void => {
    nextRecoveryAt = 0;
    recoveryDelayMs = RECOVERY_RETRY_INITIAL_MS;
    if (policy.mode === "core") status.core();
    else status.installed();
  };
  const createSession = async (): Promise<RendererCdpControlSession> => {
    status.installing();
    if (policy.mode === "core")
      return (dependencies.installCore ?? createCoreRendererSession)({
        rendererCdpEndpoint: options.rendererCdpEndpoint,
        policy,
      });
    startupTrace("reading Renderer bundle");
    const rendererSource = await dependencies.readRenderer(options.rendererPath);
    if (rendererSource.trim().length === 0) throw new Error("production Renderer Bundle is empty");
    startupTrace("installing Renderer Session");
    const installed = await installProductionSession(
      {
        rendererCdpEndpoint: options.rendererCdpEndpoint,
        rendererSource: `${RENDERER_CSP_BOOTSTRAP}\n${rendererPolicyBootstrap(policy)}\n${rendererSource}`,
        // External Agents are discovered from each target Host after installation.
        timeoutMs: PRODUCTION_INSTALL_TIMEOUT_MS,
        signal,
      },
      dependencies,
    );
    startupTrace("Renderer Session installed");
    return installed;
  };
  startupTrace("initialization started");

  let operation = Promise.resolve<unknown>(undefined);
  const useSession = <T>(callback: () => Promise<T>): Promise<T> => {
    const next = operation.then(callback, callback);
    operation = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  const resetSession = async (): Promise<void> => {
    if (session?.dispose) await session.dispose();
    else session?.close();
    session = undefined;
  };
  const ensureSession = async (): Promise<RendererCdpControlSession> => {
    if (!session) session = await createSession();
    else await session.ensureInstalled();
    return session;
  };
  const recoverSession = async (): Promise<RendererCdpControlSession> => {
    try {
      const current = await ensureSession();
      recordRecoverySuccess();
      return current;
    } catch (error) {
      await resetSession();
      recordRecoveryFailure(error);
      throw error;
    }
  };

  if (options.noRenderer || policy.mode === "safe") {
    await runWithoutRenderer(options, signal, dependencies, status);
    return;
  }

  let coreFailed = false;
  let attachmentServer: ControllerAttachmentServer | undefined;
  try {
    startupTrace("starting attachment server");
    attachmentServer = await dependencies.startAttachmentServer({
      port: options.attachmentPort,
      nonce: options.attachmentNonce,
      remoteConnections: async (request) => {
        if (policy.mode !== "full" || coreFailed) throw new Error(RENDERER_DISABLED_MESSAGE);
        // Serialize session recovery, not the native request: the renderer can await Host
        // responses while other settings reads run. Never retry a submitted mutation.
        const current = await useSession(() => recoverSession());
        return remoteConnectionsReplySchema.parse(
          await current.executeRenderer(remoteConnectionsExpression(request)),
        );
      },
      openLocalPage: (url) =>
        openRendererLocalPage(
          (expression) =>
            useSession(async () => (await recoverSession()).executeRenderer(expression)),
          url,
          () => listCdpTargets(options.rendererCdpEndpoint),
        ),
      attach: () =>
        useSession(async () => {
          const current = await recoverSession();
          await current.activateDesktop();
        }),
    });
    startupTrace("attachment server ready");
    startupTrace("publishing readiness");
    dependencies.ready({
      schemaVersion: 2,
      state: "compatible",
      issues: [],
    });
    await useSession(async () => {
      if (session) return;
      try {
        session = await createSession();
        recordRecoverySuccess();
      } catch (error) {
        startupTrace("initial Renderer Session unavailable", error);
        session = undefined;
        recordRecoveryFailure(error);
        if (policy.mode === "core") {
          coreFailed = true;
          status.disabled();
        }
      }
    });
    while (!signal.aborted) {
      await dependencies.sleep(dependencies.monitorIntervalMs);
      if (signal.aborted) continue;
      await useSession(async () => {
        if (coreFailed || (!session && now() < nextRecoveryAt)) return;
        try {
          const current = await recoverSession();
          if (policy.mode === "core" && dependencies.readCoreUsage) {
            const usage = await dependencies.readCoreUsage();
            await current.executeRenderer(
              `globalThis.__codexhostCoreUsageV1 = ${JSON.stringify(usage)}; globalThis.dispatchEvent(new CustomEvent('codexhost:core-usage')); true`,
            );
          }
        } catch {
          if (policy.mode === "core") {
            await resetSession();
            coreFailed = true;
            status.disabled();
          }
          // Full integration retries; a failed core bridge stays without injection until reopen.
        }
      });
    }
  } finally {
    await attachmentServer?.close();
    await operation;
    await resetSession();
  }
}

/**
 * Safe mode: the Launcher's readiness and supervision contract is unchanged (handshake, attachment
 * server, status file), but there is no Renderer Session and no recovery loop. Requests that need
 * the injected interface are refused instead of silently installing it.
 */
async function runWithoutRenderer(
  options: DesktopControllerOptions,
  signal: AbortSignal,
  dependencies: DesktopControllerDependencies,
  status: ReturnType<typeof createRendererStatusReporter>,
): Promise<void> {
  const refuse = (): Promise<never> => Promise.reject(new Error(RENDERER_DISABLED_MESSAGE));
  let attachmentServer: ControllerAttachmentServer | undefined;
  try {
    startupTrace("starting attachment server (safe mode)");
    attachmentServer = await dependencies.startAttachmentServer({
      port: options.attachmentPort,
      nonce: options.attachmentNonce,
      remoteConnections: refuse,
      openLocalPage: refuse,
      // The Desktop is running either way; a window that cannot be raised is not a failed attach.
      attach: async () => {
        await dependencies.bringToFront?.(options.rendererCdpEndpoint).catch((error: unknown) => {
          startupTrace("safe-mode activation unavailable", error);
        });
      },
    });
    status.disabled();
    startupTrace("publishing readiness (safe mode)");
    dependencies.ready({ schemaVersion: 2, state: "compatible", issues: [] });
    while (!signal.aborted) await dependencies.sleep(dependencies.monitorIntervalMs);
  } finally {
    await attachmentServer?.close();
  }
}
