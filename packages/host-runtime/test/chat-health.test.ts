import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { chatHealthPaths, scanChatHealth } from "../src/rly0-maintenance/chat-health.js";
import { ChatRepair } from "../src/rly0-maintenance/chat-repair.js";

const ID = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SESSION = (n: number) => `dddddddd-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CWD = "F:/Projects/demo";

function makeHome() {
  const home = mkdtempSync(path.join(os.tmpdir(), "rly0-chat-health-"));
  const store = path.join(home, ".rly0-hub", "mapping-store");
  mkdirSync(path.join(store, "threads"), { recursive: true });
  mkdirSync(path.join(store, "backups"), { recursive: true });
  mkdirSync(path.join(home, ".claude", "projects", CWD.replace(/[^A-Za-z0-9]/gu, "-")), {
    recursive: true,
  });
  return { home, store };
}

function record(n: number, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    formatVersion: 1,
    revision: 1,
    hostThreadId: ID(n),
    createRequestId: `r${n}`,
    harnessId: "claude-code",
    state: "ready",
    nativeSessionRef: { formatVersion: 1, harnessId: "claude-code", nativeSessionId: SESSION(n) },
    cwd: CWD,
    title: `chat ${n}`,
    archived: false,
    transportModelId: "codexhost/claude-code-native",
    ephemeral: false,
    historyMode: "paginated",
    turnMappings: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: `2026-10-${String(n).padStart(2, "0")}T00:00:00.000Z`,
    ...extra,
  });
}

function putThread(home: string, n: number, content: string, backup?: string) {
  const store = path.join(home, ".rly0-hub", "mapping-store");
  writeFileSync(path.join(store, "threads", `${ID(n)}.json`), content);
  if (backup !== undefined) writeFileSync(path.join(store, "backups", `${ID(n)}.json`), backup);
}

function putTranscript(home: string, n: number, project = CWD.replace(/[^A-Za-z0-9]/gu, "-")) {
  const directory = path.join(home, ".claude", "projects", project);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${SESSION(n)}.jsonl`), "{}\n");
}

interface CodexRow {
  id: string;
  rollout: string | null;
  provider?: string;
  archived?: boolean;
}

/** `~/.codex` with a state database like Codex's and the rollout files named by `rows`. */
function makeCodex(home: string, rows: CodexRow[], providers = ["custom"]) {
  const codex = path.join(home, ".codex");
  const day = path.join(codex, "sessions", "2026", "10", "01");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(codex, "config.toml"),
    providers.map((p) => `[model_providers.${p}]\nname = "${p}"\n`).join("\n"),
  );
  const db = new DatabaseSync(path.join(codex, "state_5.sqlite"));
  db.exec(
    "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, archived integer not null default 0)",
  );
  const insert = db.prepare("insert into threads values (?, ?, 1, ?, 'vscode', ?, ?, ?, ?)");
  for (const [index, row] of rows.entries()) {
    const file = path.join(day, `rollout-2026-10-01T00-00-0${index}-${row.id}.jsonl`);
    if (row.rollout !== null) writeFileSync(row.rollout === "zst" ? `${file}.zst` : file, "{}\n");
    insert.run(
      row.id,
      index === 0 ? `\\\\?\\${file}` : file,
      1_790_000_000 + index,
      row.provider ?? "openai",
      CWD,
      `codex ${index}`,
      row.archived ? 1 : 0,
    );
  }
  db.close();
  return { codex, day };
}

const kinds = (groups: readonly { kind: string; count: number }[]) =>
  Object.fromEntries(groups.map((g) => [g.kind, g.count]));
const scan = (home: string, environment: NodeJS.ProcessEnv = {}) =>
  scanChatHealth(chatHealthPaths(environment, home));

function codexControl() {
  const calls: string[] = [];
  return {
    calls,
    control: {
      status: async () => ({ running: false }),
      forceQuit: async () => (calls.push("quit"), { ok: true }),
      open: async () => (calls.push("open"), { ok: true }),
    },
  };
}

describe("chat health scan", () => {
  it("counts every chat and finds nothing wrong with healthy ones", async () => {
    const { home } = makeHome();
    putThread(home, 1, record(1));
    putTranscript(home, 1);
    // The transcript under another project folder (the chat's folder was renamed) still counts.
    putThread(home, 2, record(2, { cwd: "F:/Projects/renamed" }));
    putTranscript(home, 2, "F--Projects-elsewhere");
    makeCodex(home, [
      { id: SESSION(90), rollout: "plain" },
      { id: SESSION(91), rollout: "zst", provider: "custom" },
    ]);
    const result = await scan(home);
    expect(result).toEqual({ agentChats: 2, codexChats: 2, groups: [] });
  });

  it("finds damaged records and whether their backup can put them back", async () => {
    const { home } = makeHome();
    putThread(home, 3, "{not json", record(3));
    putThread(home, 4, "{not json");
    putThread(home, 5, record(99)); // someone else's id in this file: unusable too
    const groups = (await scan(home)).groups;
    expect(kinds(groups)).toEqual({ "record-damaged": 1, "record-lost": 2 });
    expect(groups.find((g) => g.kind === "record-damaged")).toMatchObject({
      repairable: true,
      items: [{ id: ID(3), title: "chat 3", harnessId: "claude-code" }],
    });
    expect(groups.find((g) => g.kind === "record-lost")?.repairable).toBe(false);
  });

  it("finds chats never finished being created", async () => {
    const { home } = makeHome();
    putThread(home, 6, record(6, { state: "creating", nativeSessionRef: undefined }));
    expect(kinds((await scan(home)).groups)).toEqual({ "stuck-creating": 1 });
  });

  it("finds Claude Code chats whose own conversation file is gone, counting archived ones", async () => {
    const { home } = makeHome();
    putThread(home, 7, record(7));
    putThread(home, 8, record(8, { archived: true }));
    // A pending session (never started) has no transcript by design.
    putThread(
      home,
      9,
      record(9, {
        nativeSessionRef: {
          formatVersion: 1,
          harnessId: "claude-code",
          nativeSessionId: SESSION(9),
          locator: "pending",
        },
      }),
    );
    const group = (await scan(home)).groups[0];
    expect(group).toMatchObject({ kind: "session-missing", count: 2, archived: 1 });
    expect(group?.repairable).toBe(false);
    // Under isolation the transcripts live in the sandbox: not checked.
    writeFileSync(path.join(home, ".rly0-hub", "claude-isolation.json"), "{}");
    expect((await scan(home)).groups).toEqual([]);
  });

  it("finds Codex chats with a missing file, a removed provider, and unlisted files", async () => {
    const { home } = makeHome();
    const { codex, day } = makeCodex(home, [
      { id: SESSION(20), rollout: null },
      { id: SESSION(21), rollout: "plain", provider: "removed-relay", archived: true },
      { id: SESSION(22), rollout: "plain" },
    ]);
    writeFileSync(path.join(day, `rollout-2026-10-01T09-00-00-${SESSION(23)}.jsonl`), "{}\n");
    const database = path.join(codex, "state_5.sqlite");
    const before = { bytes: readFileSync(database), mtime: statSync(database).mtimeMs };
    const result = await scan(home);
    expect(result.codexChats).toBe(3);
    expect(kinds(result.groups)).toEqual({
      "codex-rollout-missing": 1,
      "codex-provider-missing": 1,
      "codex-unlisted-rollout": 1,
    });
    expect(result.groups.find((g) => g.kind === "codex-provider-missing")?.archived).toBe(1);
    expect(result.groups.every((g) => !g.repairable)).toBe(true);
    // Codex's database is only read, through a copy.
    expect(readFileSync(database).equals(before.bytes)).toBe(true);
    expect(statSync(database).mtimeMs).toBe(before.mtime);
    expect(existsSync(`${database}-wal`)).toBe(false);
  });

  it("reports Codex as unread when it has no database", async () => {
    const { home } = makeHome();
    expect((await scan(home)).codexChats).toBeNull();
  });
});

describe("ChatRepair across all chats", () => {
  it("lists every kind, says how many were checked, and repairs only what it can", async () => {
    const { home, store } = makeHome();
    putThread(home, 3, "{not json", record(3));
    putTranscript(home, 3);
    putThread(home, 7, record(7));
    makeCodex(home, [{ id: SESSION(20), rollout: null }]);
    const c = codexControl();
    const repair = new ChatRepair({
      environment: {},
      home,
      codex: c.control,
      now: () => new Date("2026-10-20T01:02:03.000Z"),
    });
    const found = await repair.scan();
    expect(found).toMatchObject({
      available: true,
      broken: 1,
      checked: { agent: 2, codex: 1, legacy: 0 },
    });
    expect(kinds(found.groups)).toEqual({
      "record-damaged": 1,
      "session-missing": 1,
      "codex-rollout-missing": 1,
    });

    const result = await repair.repair();
    expect(result).toMatchObject({ ok: true, repaired: 1, codexRestarted: false });
    const backup = path.join(home, ".rly0-hub", "chat-repair-backups", "20261020T010203000Z");
    expect(result.backupDir).toBe(backup);
    // Backed up as it was, the damaged file kept, the backup copy put back.
    expect(readFileSync(path.join(backup, "threads", `${ID(3)}.json`), "utf8")).toBe("{not json");
    expect(readFileSync(path.join(backup, "damaged", `${ID(3)}.json`), "utf8")).toBe("{not json");
    expect(readFileSync(path.join(store, "threads", `${ID(3)}.json`), "utf8")).toBe(record(3));
    expect(existsSync(path.join(store, "threads", `${ID(7)}.json`))).toBe(true);

    const after = await repair.scan();
    expect(after.broken).toBe(0);
    expect(kinds(after.groups)).toEqual({ "session-missing": 1, "codex-rollout-missing": 1 });
  });

  it("leaves Codex and every file alone when nothing can be repaired", async () => {
    const { home } = makeHome();
    putThread(home, 4, "{not json");
    const c = codexControl();
    const repair = new ChatRepair({ environment: {}, home, codex: c.control });
    expect(await repair.repair()).toEqual({
      ok: true,
      repaired: 0,
      codexRestarted: false,
      reopenFailed: false,
      fixedOnCodexStart: 0,
    });
    expect(c.calls).toEqual([]);
    expect(existsSync(path.join(home, ".rly0-hub", "chat-repair-backups"))).toBe(false);
  });
});
