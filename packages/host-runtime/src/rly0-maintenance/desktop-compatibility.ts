import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, mkdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { DesktopCompatibility } from "@codexhost/shared-contracts";
import { resolveRly0DiagnosticsDir } from "./paths.js";

const version = z.string().regex(/^\d[\w.+-]{0,95}$/u);
const timestamp = z.number().finite().nonnegative();
const pid = z.number().int().positive();
const inspectSchema = z.object({
  schemaVersion: z.literal(1),
  desktop: z.object({ version, processIds: z.array(pid).max(1024) }).nullable(),
  runtime: z.object({ running: z.boolean(), launcherPid: pid.nullable() }),
});
const startupSchema = z.object({
  schemaVersion: z.literal(1),
  records: z
    .array(
      z.object({
        pid,
        startedAtMs: timestamp,
        desktop: z.object({ version }).nullable(),
      }),
    )
    .max(32),
});
const controllerSchema = z.object({
  schemaVersion: z.literal(1),
  pid,
  startedAt: timestamp,
  renderer: z.object({
    state: z.enum(["installed", "installing", "unavailable"]),
    error: z.string().max(1000).nullable(),
    updatedAt: timestamp,
  }),
});
const savedSchema = z.object({
  schemaVersion: z.literal(1),
  lastCompatibleVersion: version.nullable(),
  notifiedFor: z.string().max(256).nullable(),
});
type SavedState = z.infer<typeof savedSchema>;

export interface DesktopCompatibilitySource {
  check(): Promise<DesktopCompatibility>;
}

interface Options {
  environment: NodeJS.ProcessEnv;
  installRoot?: string;
  /** Tests supply synthetic metadata; production only invokes the installed launcher's inspect. */
  inspect?: () => Promise<unknown>;
  isAlive?: (pid: number) => boolean;
  now?: () => number;
  cacheMs?: number;
}

/** Bounded read: never follows a log tail or reads account/configuration files. */
async function readJson(filePath: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(filePath, "r");
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) return null;
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) return null;
    return JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

function processAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

/** Observes the Controller's existing capability probe; never starts or stops Desktop. */
export class Rly0DesktopCompatibility implements DesktopCompatibilitySource {
  readonly #options: Options;
  readonly #now: () => number;
  readonly #directory: string;
  readonly #controllerDirectory: string;
  #saved: SavedState = { schemaVersion: 1, lastCompatibleVersion: null, notifiedFor: null };
  #loaded = false;
  #pending: Promise<DesktopCompatibility> | undefined;
  #cached: DesktopCompatibility | undefined;
  #cacheUntil = 0;

  constructor(options: Options) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#directory = resolveRly0DiagnosticsDir(options.environment);
    this.#controllerDirectory = path.join(
      options.environment.CODEXHOST_DATA_DIR
        ? path.resolve(options.environment.CODEXHOST_DATA_DIR)
        : path.join(os.homedir(), ".codexhost"),
      "diagnostics",
    );
  }

  check(): Promise<DesktopCompatibility> {
    if (this.#pending) return this.#pending;
    if (this.#cached && this.#now() < this.#cacheUntil) return Promise.resolve(this.#cached);
    this.#pending = this.#observe()
      .then((result) => {
        this.#cached = result;
        this.#cacheUntil = this.#now() + (this.#options.cacheMs ?? 5000);
        return result;
      })
      .finally(() => {
        this.#pending = undefined;
      });
    return this.#pending;
  }

  async #inspect(): Promise<unknown> {
    if (this.#options.inspect) return this.#options.inspect();
    const configured = this.#options.environment.CODEXHOST_LAUNCHER_EXECUTABLE;
    const launcher = this.#options.installRoot
      ? path.join(
          this.#options.installRoot,
          "bin",
          process.platform === "win32" ? "codexhost.exe" : "codexhost",
        )
      : configured && path.isAbsolute(configured)
        ? configured
        : null;
    if (!launcher) return null;
    return new Promise((resolve) => {
      execFile(
        launcher,
        ["inspect", "--json"],
        {
          env: this.#options.environment,
          windowsHide: true,
          timeout: 5000,
          maxBuffer: 128 * 1024,
        },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          try {
            resolve(JSON.parse(stdout));
          } catch {
            resolve(null);
          }
        },
      );
    });
  }

  async #save(): Promise<void> {
    const temporary = path.join(this.#directory, `.compatibility-${randomUUID()}.tmp`);
    try {
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      await writeFile(temporary, JSON.stringify(this.#saved), { mode: 0o600, flag: "wx" });
      await rename(temporary, path.join(this.#directory, "desktop-compatibility-state-v1.json"));
    } catch {
      // A read-only data directory must not stop the native client or diagnostics.
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  async #observe(): Promise<DesktopCompatibility> {
    if (!this.#loaded) {
      const saved = savedSchema.safeParse(
        await readJson(path.join(this.#directory, "desktop-compatibility-state-v1.json")),
      );
      if (saved.success) this.#saved = saved.data;
      this.#loaded = true;
    }
    const result: DesktopCompatibility = {
      checkedAt: new Date(this.#now()).toISOString(),
      state: "unavailable",
      desktopVersion: null,
      previousCompatibleVersion: this.#saved.lastCompatibleVersion,
      versionChanged: false,
      issue: "STATUS_UNAVAILABLE",
      message: "暂时无法读取 Codex 状态，可使用“反馈问题”保存诊断。",
      checks: { managedRuntime: null, controllerAlive: null, interfaceConnected: null },
    };
    const finish = (
      state: DesktopCompatibility["state"],
      issue: DesktopCompatibility["issue"],
      message: string,
    ): DesktopCompatibility => ({ ...result, state, issue, message });
    const inspected = inspectSchema.safeParse(await this.#inspect().catch(() => null));
    if (!inspected.success) return result;
    const { desktop, runtime } = inspected.data;
    result.desktopVersion = desktop?.version ?? null;
    result.versionChanged =
      !!desktop &&
      !!this.#saved.lastCompatibleVersion &&
      desktop.version !== this.#saved.lastCompatibleVersion;
    result.checks.managedRuntime = runtime.running;
    if (!desktop || !desktop.processIds.length)
      return finish("not-running", "NONE", "Codex 未运行；启动后会自动检查界面连接。");
    if (!runtime.running || !runtime.launcherPid)
      return finish(
        "unverified",
        "UNMANAGED_RUNTIME",
        "当前 Codex 未由 Hub 接入；请从 Hub 打开后检查。",
      );
    const [startup, controller] = await Promise.all([
      readJson(path.join(this.#controllerDirectory, "launcher-startup-v1.json")),
      readJson(path.join(this.#controllerDirectory, "desktop-controller-v1.json")),
    ]);
    const records = startupSchema.safeParse(startup);
    const record = records.success
      ? records.data.records
          .filter((entry) => entry.pid === runtime.launcherPid)
          .sort((a, b) => b.startedAtMs - a.startedAtMs)[0]
      : undefined;
    if (
      !record ||
      record.desktop?.version !== desktop.version ||
      record.startedAtMs > this.#now()
    ) {
      return finish(
        "unverified",
        "SESSION_MISMATCH",
        "尚未取得当前 Codex 启动记录，可使用“反馈问题”保存诊断。",
      );
    }
    const parsed = controllerSchema.safeParse(controller);
    const status = parsed.success ? parsed.data : null;
    const alive = !!status && (this.#options.isAlive ?? processAlive)(status.pid);
    result.checks.controllerAlive = alive;
    if (
      !status ||
      !alive ||
      status.startedAt < record.startedAtMs ||
      status.startedAt > this.#now() ||
      status.renderer.updatedAt < status.startedAt
    ) {
      return finish(
        this.#now() - record.startedAtMs < 60_000 ? "checking" : "unavailable",
        "CONTROLLER_STATUS_MISSING",
        "尚未连接当前界面控制器；稍后复查，仍失败可使用“反馈问题”。",
      );
    }
    const renderer = status.renderer;
    result.checks.interfaceConnected = renderer.state === "installed";
    if (renderer.state === "installed") {
      if (
        this.#saved.lastCompatibleVersion !== desktop.version ||
        this.#saved.notifiedFor !== null
      ) {
        this.#saved = {
          schemaVersion: 1,
          lastCompatibleVersion: desktop.version,
          notifiedFor: null,
        };
        await this.#save();
      }
      return finish("ready", "NONE", "Codex 界面连接正常；模型服务和账号状态另行检查。");
    }
    if (renderer.state === "installing")
      return finish(
        this.#now() - status.startedAt < 60_000 ? "checking" : "unavailable",
        "INTEGRATION_PENDING",
        "正在连接 Codex 界面；持续未完成可使用“反馈问题”保存诊断。",
      );
    if (/request manager is unavailable/iu.test(renderer.error ?? "")) {
      return finish(
        "incompatible",
        "REQUEST_MANAGER_UNAVAILABLE",
        "Codex 界面接口未接通，可能需要兼容更新；请使用“反馈问题”保存诊断。",
      );
    }
    return finish(
      "unavailable",
      /CDP|websocket|ECONNREFUSED|target closed/iu.test(renderer.error ?? "")
        ? "CDP_UNAVAILABLE"
        : "INTEGRATION_UNAVAILABLE",
      "Codex 界面连接失败；请使用“反馈问题”保存诊断。",
    );
  }

  /** Unchanged version/issue is not repeated; a proven recovery resets the notice. */
  async takeNotice(): Promise<{ title: string; body: string } | null> {
    const result = await this.check();
    if (!result.checks.managedRuntime || !["incompatible", "unavailable"].includes(result.state))
      return null;
    const key = `${result.desktopVersion ?? "unknown"}:${result.issue}`;
    if (this.#saved.notifiedFor === key) return null;
    this.#saved = { ...this.#saved, notifiedFor: key };
    await this.#save();
    return {
      title: "Codex 界面连接需要检查",
      body: `${result.message} 打开 Hub → 设置 → 维护工具 → 反馈问题。`,
    };
  }
}
