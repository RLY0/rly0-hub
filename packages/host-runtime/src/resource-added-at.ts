import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveRly0DataDir } from "./rly0-maintenance/paths.js";

/** Sorting metadata only: an unavailable timestamp must not hide an otherwise usable resource. */
export async function resourceAddedAt(
  environment: NodeJS.ProcessEnv,
  kind: "skill" | "mcp",
  name: string,
  sourcePath: string,
): Promise<number | undefined> {
  const source = path.resolve(sourcePath);
  const key = createHash("sha256")
    .update(JSON.stringify([name, process.platform === "win32" ? source.toLowerCase() : source]))
    .digest("hex");
  const file = path.join(resolveRly0DataDir(environment), "resource-added-at", kind, `${key}.json`);
  const read = async () => {
    const value: unknown = JSON.parse(await fs.readFile(file, "utf8"));
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : undefined;
  };
  try {
    let previous: number | undefined;
    try {
      previous = await read();
      if (previous === undefined || kind === "mcp") return previous;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
    }
    const stat = await fs.stat(source).catch(() => null);
    if (!stat) return previous;
    const hasBirthtime = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0;
    const initial = kind === "skill" && hasBirthtime ? stat.birthtimeMs : stat.mtimeMs;
    const addedAt = Math.floor(initial);
    if (!Number.isSafeInteger(addedAt) || addedAt < 0) return undefined;
    // Only a newer directory creation time identifies a reinstall. Content edits, unavailable
    // birthtime, and temporarily unreadable/missing sources keep the last recorded value.
    if (previous !== undefined && (!hasBirthtime || addedAt <= previous)) return previous;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(addedAt), { flag: "wx", mode: 0o600 });
      if (previous !== undefined) {
        await fs.rename(temp, file); // Atomic replacement for an observed skill reinstall.
      } else {
        // First observation wins; interrupted writes never publish a partial record.
        try {
          await fs.link(temp, file);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
    } finally {
      await fs.unlink(temp).catch(() => undefined);
    }
    return await read();
  } catch {
    return undefined;
  }
}

export function backupAddedAt(backedUpAt: string): { addedAt?: number } {
  const value = Date.parse(backedUpAt);
  return Number.isSafeInteger(value) && value >= 0 ? { addedAt: value } : {};
}
