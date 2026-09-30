import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export function resolveCodexHome(environment: NodeJS.ProcessEnv): string {
  return path.resolve(
    environment.CODEX_HOME ?? path.join(environment.HOME ?? os.homedir(), ".codex"),
  );
}

function backupTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/gu, "").replace(".", "");
}

/**
 * Writes a timestamped backup of the file's current content (if it exists) next to it, then
 * writes the new content atomically (temp file + rename on the same directory/filesystem).
 */
export async function backupAndWriteAtomic(filePath: string, nextContent: string): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  try {
    const current = await fs.readFile(filePath, "utf8");
    const backupPath = `${filePath}.rly0-bak-${backupTimestamp()}`;
    await fs.writeFile(backupPath, current, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tempPath = path.join(directory, `.${path.basename(filePath)}.rly0-tmp-${randomUUID()}`);
  await fs.writeFile(tempPath, nextContent, "utf8");
  await fs.rename(tempPath, filePath);
}
