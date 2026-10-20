import { promises as fs } from "node:fs";
import path from "node:path";
import type { Rly0AccountUsage, Rly0Relay } from "@codexhost/shared-contracts";
import { sanitizeRly0Usage } from "../rly0-core/index.js";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { officialVendorOf } from "./official-keys.js";
import { writePrivateQuotaCache } from "../rly0-maintenance/private-quota-cache.js";

export interface OfficialKeyUsageSnapshot {
  id: string;
  revision: string;
  usage: Rly0AccountUsage;
}

/** Usage only: no credential, profile, validity claim, or replacement of fetchedAt. */
export class Rly0OfficialKeyUsage {
  readonly #file: string;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(environment: NodeJS.ProcessEnv) {
    this.#file = path.join(
      resolveRly0DataDir(environment),
      "quota-cache",
      "official-key-usage.json",
    );
  }

  async read(): Promise<ReadonlyMap<string, OfficialKeyUsageSnapshot>> {
    try {
      const text = await fs.readFile(this.#file, "utf8");
      if (text.length > 1024 * 1024) return new Map();
      const raw: unknown = JSON.parse(text);
      if (!Array.isArray(raw)) return new Map();
      const result = new Map<string, OfficialKeyUsageSnapshot>();
      for (const value of raw.slice(0, 256)) {
        if (typeof value !== "object" || !value) continue;
        const entry = value as Record<string, unknown>;
        const usage = sanitizeRly0Usage(entry.usage);
        if (
          typeof entry.id === "string" &&
          /^[a-f0-9]{12}$/u.test(entry.id) &&
          typeof entry.revision === "string" &&
          /^[a-f0-9]{64}$/u.test(entry.revision) &&
          usage?.windows.length
        )
          result.set(`${entry.id}:${entry.revision}`, {
            id: entry.id,
            revision: entry.revision,
            usage: { ...usage, source: "snapshot" },
          });
      }
      return result;
    } catch {
      return new Map();
    }
  }

  forRelay(relay: Rly0Relay, snapshots: ReadonlyMap<string, OfficialKeyUsageSnapshot>) {
    const entry = snapshots.get(`${relay.id}:${relay.keyRevision}`);
    return officialVendorOf(relay) === "anthropic" &&
      relay.hasKey &&
      relay.keyRevision &&
      entry?.revision === relay.keyRevision
      ? entry
      : undefined;
  }

  /** Serialize local writers so concurrent token refreshes retain each other's snapshots. */
  record(relay: Rly0Relay, info: Record<string, unknown>): Promise<boolean> {
    if (!relay.keyRevision || officialVendorOf(relay) !== "anthropic") return Promise.resolve(true);
    const invalid = info.valid === false || info.usageError === "USAGE_TOKEN_EXPIRED";
    const usage = sanitizeRly0Usage(info.usage);
    if (!invalid && (info.kind !== "subscription" || !usage?.windows.length))
      return Promise.resolve(true);
    const revision = relay.keyRevision;
    const write = this.#writes
      .then(async () => {
        const entries = new Map(await this.read());
        const key = `${relay.id}:${revision}`;
        if (!invalid && usage && (entries.get(key)?.usage.fetchedAt ?? -1) > usage.fetchedAt)
          return true;
        if (invalid) entries.delete(key);
        else if (usage)
          entries.set(key, { id: relay.id, revision, usage: { ...usage, source: "snapshot" } });
        const retained = [...entries.values()]
          .sort((a, b) => b.usage.fetchedAt - a.usage.fetchedAt)
          .slice(0, 256);
        await writePrivateQuotaCache(this.#file, retained);
        return true;
      })
      .catch(() => false);
    this.#writes = write;
    return write;
  }
}
