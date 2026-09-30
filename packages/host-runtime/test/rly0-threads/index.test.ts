import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RLY0_THREADS_LIST_MAX,
  rly0ThreadRelPathSchema,
  rly0ThreadsListParamsSchema,
  rly0ThreadsListResultSchema,
  rly0ThreadsListTrashParamsSchema,
  rly0ThreadsMoveParamsSchema,
  rly0ThreadsMoveResultSchema,
} from "@codexhost/shared-contracts";

import {
  Rly0ThreadsManager,
  computeActivity,
  computeThreadStats,
  rly0ThreadsRpcError,
} from "../../src/rly0-threads/index.js";
import { isStrictlyInside, resolveInsideRoot } from "../../src/rly0-threads/paths.js";
import {
  ROLLOUT_HEADER_MAX_BYTES,
  cleanRolloutTitle,
  readRolloutHeader,
} from "../../src/rly0-threads/rollout-header.js";

const REL = "2026/09/01/rollout-2026-09-01T10-00-00-abc.jsonl";

function rolloutLines(options: { cwd?: string; message?: string } = {}): string {
  const lines: unknown[] = [
    {
      timestamp: "2026-09-01T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "abc",
        timestamp: "2026-09-01T10:00:00.000Z",
        ...(options.cwd ? { cwd: options.cwd } : {}),
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "<environment_context>ignored</environment_context>" },
        ],
      },
    },
  ];
  if (options.message) {
    lines.push({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: options.message }],
      },
    });
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

async function writeRollout(
  root: string,
  relPath: string,
  content: string,
  mtime?: Date,
): Promise<string> {
  const file = path.join(root, ...relPath.split("/"));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  if (mtime) await fs.utimes(file, mtime, mtime);
  return file;
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.stat(candidate);
    return true;
  } catch {
    return false;
  }
}

describe("rly0 threads contracts", () => {
  it("accepts well-formed rollout relative paths and rejects traversal / foreign names", () => {
    expect(rly0ThreadRelPathSchema.safeParse(REL).success).toBe(true);
    expect(rly0ThreadRelPathSchema.safeParse("rollout-a.jsonl").success).toBe(true);
    for (const bad of [
      "../rollout-a.jsonl",
      "2026/../../rollout-a.jsonl",
      "./rollout-a.jsonl",
      "/etc/rollout-a.jsonl",
      "C:\\x\\rollout-a.jsonl",
      "2026\\rollout-a.jsonl",
      "2026/notes.jsonl",
      "2026/rollout-a.json",
      "2026/rollout-a.jsonl.bak",
      "",
    ]) {
      expect(rly0ThreadRelPathSchema.safeParse(bad).success, bad).toBe(false);
    }
  });

  it("uses strict objects for params", () => {
    expect(rly0ThreadsListParamsSchema.safeParse({}).success).toBe(true);
    expect(rly0ThreadsListParamsSchema.safeParse({ limit: RLY0_THREADS_LIST_MAX }).success).toBe(
      true,
    );
    expect(
      rly0ThreadsListParamsSchema.safeParse({ limit: RLY0_THREADS_LIST_MAX + 1 }).success,
    ).toBe(false);
    expect(rly0ThreadsListParamsSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(rly0ThreadsListTrashParamsSchema.safeParse({ extra: 1 }).success).toBe(false);
    expect(rly0ThreadsMoveParamsSchema.safeParse({ relPaths: [] }).success).toBe(false);
    expect(rly0ThreadsMoveParamsSchema.safeParse({ relPaths: [REL], force: true }).success).toBe(
      false,
    );
    expect(
      rly0ThreadsMoveParamsSchema.safeParse({ relPaths: ["../x/rollout-a.jsonl"] }).success,
    ).toBe(false);
  });
});

describe("rly0 threads path guards", () => {
  const root = path.resolve(os.tmpdir(), "rly0-guard", "sessions");

  it("aligns the prefix check on a separator", () => {
    expect(isStrictlyInside(root, path.join(root, "a", "rollout-x.jsonl"))).toBe(true);
    expect(isStrictlyInside(root, `${root}-evil${path.sep}rollout-x.jsonl`)).toBe(false);
    expect(isStrictlyInside(root, root)).toBe(false);
  });

  it("throws THREAD_INVALID_PATH for traversal, absolute paths and non-rollout names", () => {
    for (const bad of [
      "../sessions-evil/rollout-x.jsonl",
      "../rollout-x.jsonl",
      "a/../../rollout-x.jsonl",
      path.join(root, "rollout-x.jsonl"),
      "/tmp/rollout-x.jsonl",
      "C:\\Windows\\rollout-x.jsonl",
      "a/notes.txt",
      "a/rollout-x.json",
      "",
      "a/rollout-\0.jsonl",
    ]) {
      expect(() => resolveInsideRoot(root, bad), bad).toThrow("THREAD_INVALID_PATH");
    }
    expect(resolveInsideRoot(root, REL)).toBe(path.join(root, ...REL.split("/")));
  });
});

describe("readRolloutHeader", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-header-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("extracts cwd, start time and the first real user message", async () => {
    const file = await writeRollout(
      dir,
      "rollout-a.jsonl",
      rolloutLines({ cwd: "/work/app", message: "  Fix   the build  " }),
    );
    const header = await readRolloutHeader(file);
    expect(header.cwd).toBe("/work/app");
    expect(header.startedAt).toBe("2026-09-01T10:00:00.000Z");
    expect(header.firstUserMessage).toBe("Fix the build");
  });

  it("truncates long titles to 80 characters", () => {
    const title = cleanRolloutTitle("x".repeat(200));
    expect(title).not.toBeNull();
    expect([...(title ?? "")].length).toBe(80);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("skips corrupt lines", async () => {
    const file = await writeRollout(
      dir,
      "rollout-b.jsonl",
      `{not json\n${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello" } })}\n`,
    );
    const header = await readRolloutHeader(file);
    expect(header.firstUserMessage).toBe("hello");
    expect(header.cwd).toBeUndefined();
  });

  it("reads at most 64KB from a large file", async () => {
    const filler = JSON.stringify({ type: "response_item", payload: { pad: "y".repeat(1000) } });
    const big = `${rolloutLines({ cwd: "/big" })}${`${filler}\n`.repeat(3000)}${JSON.stringify({
      type: "event_msg",
      payload: { type: "user_message", message: "far away" },
    })}\n`;
    const file = await writeRollout(dir, "rollout-big.jsonl", big);
    expect((await fs.stat(file)).size).toBeGreaterThan(ROLLOUT_HEADER_MAX_BYTES * 20);
    const readFileSpy = vi.spyOn(fs, "readFile");
    const header = await readRolloutHeader(file);
    expect(readFileSpy).not.toHaveBeenCalled();
    expect(header.bytesRead).toBeLessThanOrEqual(ROLLOUT_HEADER_MAX_BYTES);
    expect(header.bytesRead).toBe(ROLLOUT_HEADER_MAX_BYTES);
    expect(header.cwd).toBe("/big");
    // The user message sits past the cap, so it is never seen.
    expect(header.firstUserMessage).toBeUndefined();
    // Asking for more than the cap is clamped.
    expect((await readRolloutHeader(file, 10 * 1024 * 1024)).bytesRead).toBe(
      ROLLOUT_HEADER_MAX_BYTES,
    );
  });
});

describe("thread stats", () => {
  it("guards against division by zero", () => {
    expect(computeThreadStats([])).toEqual({
      totalThreads: 0,
      totalBytes: 0,
      activeDays: 0,
      averagePerActiveDay: 0,
    });
  });

  it("counts active days and builds an 84-day activity window", () => {
    const now = new Date(2026, 8, 30, 12);
    const day = (offset: number): number => new Date(2026, 8, 30 - offset, 9).getTime();
    const files = [day(0), day(0), day(1), day(100)].map((mtimeMs, index) => ({
      absolutePath: `/x/${index}`,
      relPath: `rollout-${index}.jsonl`,
      fileName: `rollout-${index}.jsonl`,
      sizeBytes: 10,
      mtimeMs,
    }));
    expect(computeThreadStats(files)).toEqual({
      totalThreads: 4,
      totalBytes: 40,
      activeDays: 3,
      averagePerActiveDay: 4 / 3,
    });
    const activity = computeActivity(files, now);
    expect(activity).toHaveLength(84);
    expect(activity.at(-1)).toEqual({ date: "2026-09-30", count: 2 });
    expect(activity.at(-2)).toEqual({ date: "2026-09-29", count: 1 });
    expect(activity.reduce((sum, entry) => sum + entry.count, 0)).toBe(3);
  });
});

describe("Rly0ThreadsManager", () => {
  let codexHome: string;
  let trashRoot: string;
  let manager: Rly0ThreadsManager;
  let sessionsRoot: string;

  beforeEach(async () => {
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-threads-home-"));
    trashRoot = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "rly0-threads-trash-")),
      "threads-trash",
    );
    sessionsRoot = path.join(codexHome, "sessions");
    manager = new Rly0ThreadsManager({ environment: { CODEX_HOME: codexHome }, trashRoot });
  });

  afterEach(async () => {
    await fs.rm(codexHome, { recursive: true, force: true });
    await fs.rm(path.dirname(trashRoot), { recursive: true, force: true });
  });

  it("defaults the trash root under an injected HOME, never the real home dir", () => {
    const fakeHome = path.join(os.tmpdir(), "rly0-fake-home");
    const defaulted = new Rly0ThreadsManager({
      environment: { CODEX_HOME: codexHome, HOME: fakeHome },
    });
    expect(defaulted.trashRoot()).toBe(path.resolve(fakeHome, ".rly0-hub", "threads-trash"));
    expect(defaulted.sessionsRoot()).toBe(path.join(codexHome, "sessions"));
  });

  it("reports a missing sessions dir without failing", async () => {
    const result = await manager.list();
    expect(rly0ThreadsListResultSchema.parse(result)).toEqual(result);
    expect(result.rootExists).toBe(false);
    expect(result.threads).toEqual([]);
    expect(result.stats.averagePerActiveDay).toBe(0);
  });

  it("lists rollouts newest first with cwd, title fallback and sizes", async () => {
    await writeRollout(
      sessionsRoot,
      "2026/09/01/rollout-old.jsonl",
      rolloutLines({ cwd: "/p/one", message: "Old task" }),
      new Date(2026, 8, 1, 10),
    );
    await writeRollout(
      sessionsRoot,
      "2026/09/02/rollout-new.jsonl",
      rolloutLines({}),
      new Date(2026, 8, 2, 10),
    );
    await writeRollout(sessionsRoot, "2026/09/02/notes.jsonl", "{}\n");
    await writeRollout(sessionsRoot, "2026/09/02/rollout-x.json", "{}\n");
    const result = rly0ThreadsListResultSchema.parse(await manager.list());
    expect(result.threads.map((thread) => thread.relPath)).toEqual([
      "2026/09/02/rollout-new.jsonl",
      "2026/09/01/rollout-old.jsonl",
    ]);
    const [newest, oldest] = result.threads;
    expect(newest?.title).toBe("rollout-new.jsonl");
    expect(newest?.titleFromMessage).toBe(false);
    expect(newest?.cwd).toBeUndefined();
    expect(oldest?.title).toBe("Old task");
    expect(oldest?.cwd).toBe("/p/one");
    expect(oldest?.sizeBytes).toBeGreaterThan(0);
    expect(result.stats.totalThreads).toBe(2);
    expect(result.stats.activeDays).toBe(2);
    expect(result.stats.averagePerActiveDay).toBe(1);
  });

  it("caps the listing and reports truncation", async () => {
    for (let index = 0; index < 5; index += 1) {
      await writeRollout(sessionsRoot, `rollout-${index}.jsonl`, rolloutLines({}));
    }
    const result = await manager.list(3);
    expect(result.threads).toHaveLength(3);
    expect(result.truncated).toBe(true);
    expect(result.stats.totalThreads).toBe(5);
  });

  it("moves to trash and restores, preserving the relative path", async () => {
    const source = await writeRollout(
      sessionsRoot,
      REL,
      rolloutLines({ cwd: "/p", message: "Keep me" }),
    );
    const trashed = rly0ThreadsMoveResultSchema.parse(await manager.trash([REL]));
    expect(trashed).toEqual({ movedCount: 1, failed: [] });
    expect(await pathExists(source)).toBe(false);
    const trashedFile = path.join(trashRoot, ...REL.split("/"));
    expect(await pathExists(trashedFile)).toBe(true);

    const trashList = await manager.listTrash();
    expect(trashList.trashRoot).toBe(trashRoot);
    expect(trashList.totalCount).toBe(1);
    expect(trashList.threads[0]).toMatchObject({ relPath: REL, title: "Keep me", cwd: "/p" });
    expect((await manager.list()).threads).toEqual([]);

    expect(await manager.restore([REL])).toEqual({ movedCount: 1, failed: [] });
    expect(await pathExists(source)).toBe(true);
    expect(await pathExists(trashedFile)).toBe(false);
    expect((await manager.listTrash()).totalCount).toBe(0);
  });

  it("reports missing and conflicting files per path", async () => {
    await writeRollout(sessionsRoot, REL, rolloutLines({}));
    await writeRollout(trashRoot, REL, rolloutLines({}));
    const result = await manager.trash([REL, "rollout-missing.jsonl"]);
    expect(result.movedCount).toBe(0);
    expect(result.failed).toEqual([
      { relPath: REL, code: "THREAD_ALREADY_EXISTS" },
      { relPath: "rollout-missing.jsonl", code: "THREAD_NOT_FOUND" },
    ]);
  });

  it("rejects the whole request on traversal before moving anything", async () => {
    const good = await writeRollout(sessionsRoot, REL, rolloutLines({}));
    const evilDir = `${sessionsRoot}-evil`;
    await writeRollout(evilDir, "rollout-evil.jsonl", rolloutLines({}));
    for (const bad of [
      "../sessions-evil/rollout-evil.jsonl",
      path.join(evilDir, "rollout-evil.jsonl"),
      "../../outside/rollout-x.jsonl",
      "2026/notes.txt",
    ]) {
      await expect(manager.trash([REL, bad]), bad).rejects.toThrow("THREAD_INVALID_PATH");
      await expect(manager.restore([bad]), bad).rejects.toThrow("THREAD_INVALID_PATH");
    }
    expect(await pathExists(good)).toBe(true);
    expect(await pathExists(path.join(evilDir, "rollout-evil.jsonl"))).toBe(true);
    expect(await pathExists(trashRoot)).toBe(false);
  });

  it("maps errors without leaking detail", () => {
    expect(rly0ThreadsRpcError(new Error("THREAD_INVALID_PATH"))).toEqual({
      code: -32000,
      message: "THREAD_INVALID_PATH",
    });
    expect(rly0ThreadsRpcError(new Error("EACCES: /secret/path"))).toEqual({
      code: -32000,
      message: "THREAD_OPERATION_FAILED",
    });
  });
});
