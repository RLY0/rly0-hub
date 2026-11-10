import {
  execFileSync,
  spawn,
  type ExecFileSyncOptionsWithStringEncoding,
} from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCliOwnerProbe, liveCliOwners } from "../src/rly0-agents/cli-update-owner.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function isolated() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-owner-"));
  roots.push(root);
  return {
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, "codex"),
    CODEXHOST_DATA_DIR: root,
    RLY0_MEMORY_DIR: path.join(root, "memory"),
    RLY0_SKIP_LEGACY_IMPORT: "1",
  };
}
describe("review 2 lock identity (synthetic owners, injected OS drivers)", () => {
  it.each(["UTC", "Asia/Shanghai", "America/New_York"])(
    "forces UTC and C locale even with caller TZ=%s",
    async (TZ) => {
      const env = await isolated();
      const exec = vi.fn(() => "Tue Nov 10 10:12:01 2026\n");
      const probe = createCliOwnerProbe({
        exec,
        platform: "darwin",
        environment: { ...env, TZ, LC_ALL: "zh_CN.UTF-8" },
      });
      expect(probe.start(424242)).toBe("Tue Nov 10 10:12:01 2026");
      expect(exec).toHaveBeenCalledWith(
        "/bin/ps",
        ["-o", "lstart=", "-p", "424242"],
        expect.objectContaining({
          env: expect.objectContaining({ TZ: "UTC", LC_ALL: "C", HOME: env.HOME }),
        }),
      );
    },
  );
  it("caches a verified matching lock briefly, rechecks expiry, and never trusts a reused PID for a new owner", async () => {
    const env = await isolated();
    const directory = path.join(env.CODEXHOST_DATA_DIR, "pi.lock");
    await mkdir(directory);
    const file = path.join(directory, "owner.json");
    await writeFile(
      file,
      JSON.stringify({
        pid: 424242,
        startedAt: "Tue Nov 10 10:12:01 2026",
        id: "synthetic-owner-a",
      }),
    );
    const probe = { start: vi.fn(() => "Tue Nov 10 10:12:01 2026"), signal: vi.fn() };
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    expect(liveCliOwners(directory, probe)).toEqual(["owner.json"]);
    for (let i = 0; i < 5; i++) expect(liveCliOwners(directory, probe)).toEqual(["owner.json"]);
    expect(probe.start).toHaveBeenCalledTimes(1);
    expect(probe.signal).toHaveBeenCalledTimes(6);
    vi.setSystemTime(11_001);
    liveCliOwners(directory, probe);
    expect(probe.start).toHaveBeenCalledTimes(2);
    await writeFile(
      file,
      JSON.stringify({
        pid: 424242,
        startedAt: "Tue Nov 10 10:13:01 2026",
        id: "synthetic-owner-b",
      }),
    );
    probe.start.mockReturnValue("Tue Nov 10 10:13:01 2026");
    expect(liveCliOwners(directory, probe)).toEqual(["owner.json"]);
    expect(probe.start).toHaveBeenCalledTimes(3);
    probe.signal.mockImplementation(() => {
      throw Object.assign(new Error("synthetic dead process"), { code: "ESRCH" });
    });
    expect(liveCliOwners(directory, probe)).toEqual([]);
  });
  it.runIf(process.platform !== "win32")(
    "keeps a real harmless child's lock live across three caller timezones",
    async () => {
      const env = await isolated();
      const spawnOwned = () => spawn("/bin/sleep", ["103"], { env, stdio: "ignore" });
      const child = spawnOwned();
      const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
      const pid = child.pid;
      if (!pid) throw new Error("Synthetic sleep failed to start");
      const exec = (
        command: string,
        args: readonly string[],
        options: ExecFileSyncOptionsWithStringEncoding,
      ) => {
        if (command !== "/bin/ps" || args.join(" ") !== `-o lstart= -p ${pid}`)
          throw new Error("Non-owned system probe");
        return execFileSync(command, args, options);
      };
      try {
        const directory = path.join(env.CODEXHOST_DATA_DIR, "pi.lock");
        await mkdir(directory);
        const startedAt = createCliOwnerProbe({
          exec,
          environment: { ...env, TZ: "Asia/Shanghai" },
        }).start(pid);
        expect(startedAt).toMatch(/\d{4}$/);
        for (const TZ of ["UTC", "Asia/Shanghai", "America/New_York"]) {
          const file = `${TZ.replaceAll("/", "-")}.json`;
          await writeFile(
            path.join(directory, file),
            JSON.stringify({ pid, id: `synthetic-${TZ}`, startedAt }),
          );
          expect(
            liveCliOwners(directory, createCliOwnerProbe({ exec, environment: { ...env, TZ } })),
          ).toContain(file);
        }
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    },
  );
});
