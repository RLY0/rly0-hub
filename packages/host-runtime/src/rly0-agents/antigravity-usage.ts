import { spawn } from "node:child_process";
import os from "node:os";

import { commandExists } from "./claude-code-auth.js";

/**
 * The quota of whoever Antigravity is signed in with now, from the CLI's own `/usage` command
 * (`agy --print=/usage --output-format stream-json`), as the Antigravity adapter reads it. The
 * login itself lives in the operating system's keyring entry shared by the Antigravity App, CLI
 * and IDE extensions; the Hub never reads, copies or switches it (see
 * docs/harnesses/antigravity/multi-account-research.md). Read only on request: an unsigned agy
 * may start its own sign-in.
 */
export interface AntigravityUsageWindow {
  kind: "primary" | "secondary" | "other";
  label: string;
  usedPercent: number;
  resetsAt?: number;
  windowSeconds?: number;
}
export interface AntigravityUsage {
  windows: AntigravityUsageWindow[];
  /** Unix seconds. */
  fetchedAt: number;
}
export interface AntigravityUsageStatus {
  installed: boolean;
  usage?: AntigravityUsage;
  /** Why the last read failed: ANTIGRAVITY_NOT_LOGGED_IN, TIMEOUT, USAGE_BAD_RESPONSE, … */
  error?: string;
  checkedAt?: number;
}

export type AntigravityUsageRunner = (
  environment: NodeJS.ProcessEnv,
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;

const ARGS = ["--print=/usage", "--output-format", "stream-json"] as const;
const TIMEOUT_MS = 20_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One window per `/usage` bucket, consumed side (the CLI reports `remaining_fraction`). */
export function parseAntigravityUsage(stdout: string, now: number): AntigravityUsage | null {
  for (const line of stdout.split(/\r?\n/u)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record(event) || event.event !== "command_result" || !record(event.command)) continue;
    const command = event.command;
    if (command.name !== "usage" || !record(command.data) || !Array.isArray(command.data.groups))
      continue;
    const windows: AntigravityUsageWindow[] = [];
    for (const group of command.data.groups) {
      if (!record(group) || !Array.isArray(group.buckets)) continue;
      const groupName = typeof group.name === "string" ? group.name.trim().slice(0, 60) : "";
      for (const bucket of group.buckets) {
        if (!record(bucket)) continue;
        const remaining = bucket.remaining_fraction;
        if (typeof remaining !== "number" || !Number.isFinite(remaining)) continue;
        const window = typeof bucket.window === "string" ? bucket.window.trim().toLowerCase() : "";
        const kind = window === "5h" ? "primary" : window === "weekly" ? "secondary" : "other";
        const name = kind === "primary" ? "5 小时额度" : kind === "secondary" ? "每周额度" : "额度";
        const used = (1 - Math.min(1, Math.max(0, remaining))) * 100;
        const reset = typeof bucket.reset_time === "string" ? Date.parse(bucket.reset_time) : NaN;
        windows.push({
          kind,
          label: groupName ? `${groupName} · ${name}` : name,
          usedPercent: Math.round(used * 100) / 100,
          ...(Number.isFinite(reset) ? { resetsAt: Math.floor(reset / 1000) } : {}),
          ...(kind === "primary" ? { windowSeconds: 5 * 3600 } : {}),
          ...(kind === "secondary" ? { windowSeconds: 7 * 86400 } : {}),
        });
      }
    }
    if (windows.length) return { windows, fetchedAt: Math.floor(now / 1000) };
  }
  return null;
}

function defaultRunner(platform: NodeJS.Platform, cwd: string): AntigravityUsageRunner {
  return (environment) =>
    new Promise((resolve) => {
      const windows = platform === "win32";
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const child = spawn(windows ? '"agy"' : "agy", [...ARGS], {
        cwd,
        env: environment,
        shell: windows,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        timedOut = true;
        if (windows && child.pid !== undefined)
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => child.kill());
        else child.kill();
      }, TIMEOUT_MS);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout = (stdout + chunk.toString()).slice(-256 * 1024);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-16 * 1024);
      });
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ code: null, stdout, stderr, timedOut });
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr, timedOut });
      });
    });
}

export class AntigravityUsageReader {
  readonly #environment: () => Promise<NodeJS.ProcessEnv>;
  readonly #platform: NodeJS.Platform;
  readonly #run: AntigravityUsageRunner;
  readonly #fileExists: ((file: string) => boolean) | undefined;
  readonly #now: () => number;
  #last: Omit<AntigravityUsageStatus, "installed"> = {};
  #inFlight: Promise<AntigravityUsageStatus> | null = null;

  constructor(options: {
    environment: () => Promise<NodeJS.ProcessEnv>;
    platform?: NodeJS.Platform;
    run?: AntigravityUsageRunner;
    fileExists?: (file: string) => boolean;
    now?: () => number;
  }) {
    this.#environment = options.environment;
    this.#platform = options.platform ?? process.platform;
    this.#run = options.run ?? defaultRunner(this.#platform, os.tmpdir());
    this.#fileExists = options.fileExists;
    this.#now = options.now ?? Date.now;
  }

  async #installed(): Promise<{ installed: boolean; environment: NodeJS.ProcessEnv }> {
    const environment = await this.#environment();
    return {
      installed: commandExists("agy", environment, this.#platform, this.#fileExists),
      environment,
    };
  }

  /** What is known without running agy: installed, and the last read (if any). */
  async status(): Promise<AntigravityUsageStatus> {
    const { installed } = await this.#installed();
    return { installed, ...this.#last };
  }

  /** Runs `/usage` now (one read at a time); the last numbers stay when it fails. */
  refresh(): Promise<AntigravityUsageStatus> {
    this.#inFlight ??= this.#read().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  async #read(): Promise<AntigravityUsageStatus> {
    const { installed, environment } = await this.#installed();
    if (!installed) return { installed: false };
    const result = await this.#run(environment).catch(() => null);
    const now = this.#now();
    const usage = result ? parseAntigravityUsage(result.stdout, now) : null;
    if (usage) this.#last = { usage, checkedAt: Math.floor(now / 1000) };
    else {
      const output = result ? `${result.stdout}\n${result.stderr}` : "";
      const error = !result
        ? "ANTIGRAVITY_START_FAILED"
        : result.timedOut
          ? "TIMEOUT"
          : /sign[ -]?in|authenticat|credential|log ?in|unauthori[sz]ed/iu.test(output)
            ? "ANTIGRAVITY_NOT_LOGGED_IN"
            : "USAGE_BAD_RESPONSE";
      this.#last = { ...this.#last, error, checkedAt: Math.floor(now / 1000) };
      // A failed read must not keep showing someone's quota as current.
      if (error === "ANTIGRAVITY_NOT_LOGGED_IN") delete this.#last.usage;
    }
    return { installed: true, ...this.#last };
  }
}
