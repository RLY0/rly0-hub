import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  codexCompatManifestSchema,
  codexRendererPolicy,
  codexVersionVerified,
  RLY0_GITHUB_RELEASES_LATEST_URL,
  type CodexCompatManifest,
} from "@codexhost/shared-contracts";
import { compareSemanticVersions } from "@codexhost/update-manager";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { installedHubVersion } from "./update-check.js";
import { getUpdateJson, type UpdateHttpGet } from "./hub-update-net.js";

export const CODEX_COMPAT_URL = `${RLY0_GITHUB_RELEASES_LATEST_URL}/download/codex-compat.json`;
export class CodexCompatibilityCatalog {
  #manifest: CodexCompatManifest | null = null;
  #hub = "0.0.0";
  #source: "builtin" | "cache" | "remote" = "builtin";
  #error: "COMPAT_UNAVAILABLE" | "COMPAT_INVALID" | "COMPAT_CACHE_WRITE_FAILED" | null = null;
  #pending: Promise<void> | null = null;
  #loaded = false;
  #holdUpdates = false;
  #publishedVersion: string | null = null;
  readonly file: string;
  constructor(
    readonly options: {
      environment: NodeJS.ProcessEnv;
      installRoot: string;
      get?: () => Promise<UpdateHttpGet>;
      hubVersion?: string;
    },
  ) {
    this.file = path.join(resolveRly0DataDir(options.environment), "codex-compat.json");
  }
  async load(): Promise<void> {
    if (this.#loaded) return;
    this.#hub =
      this.options.hubVersion ??
      (await installedHubVersion(this.options.installRoot).catch(() => "0.0.0"));
    try {
      const bytes = await fs.readFile(this.file);
      if (bytes.length > 256 * 1024) throw new Error("COMPAT_INVALID");
      this.#manifest = codexCompatManifestSchema.parse(JSON.parse(bytes.toString("utf8")));
      this.#source = "cache";
    } catch {
      /* Invalid/missing cache never widens the built-in table. */
    }
    this.#loaded = true;
  }
  async refresh(): Promise<void> {
    if (this.#pending) return this.#pending;
    this.#pending = this.#refresh().finally(() => {
      this.#pending = null;
    });
    return this.#pending;
  }
  async #refresh(): Promise<void> {
    await this.load();
    if (!this.options.get) return;
    if (this.options.environment.RLY0_VERSION_GATE_OFFLINE === "1") {
      this.#error = "COMPAT_UNAVAILABLE";
      return;
    }
    let raw: unknown;
    try {
      raw = await getUpdateJson(await this.options.get(), CODEX_COMPAT_URL, {}, 256 * 1024);
    } catch {
      this.#error = "COMPAT_UNAVAILABLE";
      return;
    }
    const parsed = codexCompatManifestSchema.safeParse(raw);
    if (!parsed.success) {
      this.#error = "COMPAT_INVALID";
      return;
    }
    this.#manifest = parsed.data;
    this.#source = "remote";
    this.#error = null;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      await fs.writeFile(temporary, JSON.stringify(parsed.data), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    } catch {
      this.#error = "COMPAT_CACHE_WRITE_FAILED";
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  /**
   * `holdUpdates` sits beside `policy`, not inside it: older Controllers parse `policy` strictly and
   * ignore unknown top-level keys. It applies to every Desktop version, not only the bound one.
   */
  async publishPolicy(version: string | null): Promise<void> {
    if (!version) return; // A transient inspection failure must not replace a running policy.
    const file = path.join(path.dirname(this.file), "codex-renderer-policy.json");
    const temporary = `${file}.${randomUUID()}.tmp`;
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await fs.writeFile(
      temporary,
      JSON.stringify({
        desktopVersion: version,
        policy: this.policy(version),
        holdUpdates: this.#holdUpdates,
      }),
      { mode: 0o600 },
    );
    await fs.rename(temporary, file);
    this.#publishedVersion = version;
  }
  /** Republishes the last version-bound policy when the update hold changes. */
  async setHoldUpdates(hold: boolean): Promise<void> {
    if (hold === this.#holdUpdates) return;
    const previous = this.#holdUpdates;
    this.#holdUpdates = hold;
    try {
      if (this.#publishedVersion) await this.publishPolicy(this.#publishedVersion);
    } catch (error) {
      this.#holdUpdates = previous; // A failed write is retried by the next change request.
      throw error;
    }
  }
  holdUpdates(): boolean {
    return this.#holdUpdates;
  }
  verified(version: string | null): boolean {
    return codexVersionVerified(version, this.#hub, this.#manifest, compareSemanticVersions);
  }
  policy(version: string | null) {
    return codexRendererPolicy(version, this.#hub, this.#manifest, compareSemanticVersions);
  }
  status() {
    return {
      source: this.#source,
      updatedAt: this.#manifest?.updatedAt ?? null,
      error: this.#error,
      hubVersion: this.#hub,
    };
  }
}
