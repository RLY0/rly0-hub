import os from "node:os";
import path from "node:path";
import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";

/** HOME does not isolate cfprefsd or the macOS login session's applications. */
export function codexNativeUpdateControlAllowed(
  environment: NodeJS.ProcessEnv,
  platform = process.platform,
  realHome = os.userInfo().homedir,
): boolean {
  return (
    platform === "darwin" &&
    environment.RLY0_CODEX_UPDATE_CONTROL !== "0" &&
    environment.RLY0_HUB_MACOS_DEV_HOME !== "1" &&
    !environment.VITEST &&
    environment.NODE_ENV !== "test" &&
    path.resolve(environment.HOME ?? realHome) === path.resolve(realHome) &&
    resolveRly0DataDir(environment) === path.join(realHome, ".rly0-hub")
  );
}

/** Exclusive native control for Hubs sharing a directory. A live owner is never evicted. */
export async function acquireCodexUpdateControl(directory: string): Promise<() => Promise<void>> {
  const { promises: fs } = await import("node:fs");
  const { randomUUID } = await import("node:crypto");
  const file = path.join(directory, "codex-update-owner.json");
  const id = randomUUID();
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${id}`;
  await fs.writeFile(temporary, JSON.stringify({ id, pid: process.pid }), { mode: 0o600 });
  try {
    try {
      await fs.link(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Serialize stale-owner reclamation as well as ordinary acquisition.
      const reclaim = `${file}.reclaim`;
      const handle = await fs.open(reclaim, "wx", 0o600);
      try {
        const owner = JSON.parse(await fs.readFile(file, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0)
          throw new Error("CODEX_UPDATE_OWNER_INVALID");
        let dead = false;
        try {
          process.kill(owner.pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") dead = true;
          else throw probe;
        }
        if (!dead) throw new Error("CODEX_UPDATE_OWNER_BUSY");
        await fs.unlink(file);
        await fs.link(temporary, file);
      } finally {
        await handle.close();
        await fs.rm(reclaim, { force: true });
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return async () => {
    const owner = await fs.readFile(file, "utf8").catch(() => null);
    if (owner && JSON.parse(owner).id === id) await fs.unlink(file);
  };
}
