import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { chatHealthPaths } from "../src/rly0-maintenance/chat-health.js";
import {
  lastChatProviderRepair,
  repairChatProviders,
  undoChatProviderRepair,
} from "../src/rly0-maintenance/chat-provider-repair.js";
import { ChatRepair } from "../src/rly0-maintenance/chat-repair.js";

const SESSION = (n: number) => `eeeeeeee-0000-4000-8000-${String(n).padStart(12, "0")}`;
const STAMP = "20261108T030405123Z";

interface Row {
  readonly id: string;
  readonly provider: string;
  readonly rollout?: boolean;
}

/** A synthetic `~/.codex` whose config.toml says `model_provider = "rly0"`. */
function makeCodex(rows: readonly Row[]) {
  const home = mkdtempSync(path.join(os.tmpdir(), "rly0-chat-provider-"));
  const codex = path.join(home, ".codex");
  const day = path.join(codex, "sessions", "2026", "11", "06");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    path.join(codex, "config.toml"),
    'model_provider = "rly0"\n[model_providers.rly0]\nname = "rly0"\n',
  );
  const database = path.join(codex, "state_5.sqlite");
  const db = new DatabaseSync(database);
  db.exec(
    "create table threads (id text primary key, rollout_path text not null, created_at integer not null, updated_at integer not null, source text not null, model_provider text not null, cwd text not null, title text not null, archived integer not null default 0, model text)",
  );
  const insert = db.prepare(
    "insert into threads values (?, ?, 1, 1790000000, 'vscode', ?, '/synthetic', ?, 0, 'gpt-6.1-sol')",
  );
  for (const [index, row] of rows.entries()) {
    const file = path.join(day, `rollout-2026-11-06T00-00-0${index}-${row.id}.jsonl`);
    if (row.rollout !== false) writeFileSync(file, "{}\n");
    insert.run(row.id, file, row.provider, `chat ${index}`);
  }
  db.close();
  return { home, codex, database, paths: chatHealthPaths({}, home) };
}

function providers(database: string): Record<string, string> {
  const db = new DatabaseSync(database);
  try {
    const rows = db.prepare("select id, model_provider from threads").all() as unknown as {
      id: string;
      model_provider: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.id, row.model_provider]));
  } finally {
    db.close();
  }
}

describe("Codex chat provider repair (synthetic database)", () => {
  it("moves chats on another provider onto the current one, after a copy of the database", async () => {
    const { database, paths } = makeCodex([
      { id: SESSION(1), provider: "openai" },
      { id: SESSION(2), provider: "rly0" },
      { id: SESSION(3), provider: "aimai1" },
      { id: SESSION(4), provider: "openai", rollout: false },
      { id: SESSION(5), provider: "" },
    ]);
    const before = readFileSync(database);
    expect(await repairChatProviders(paths, STAMP)).toBe(2);
    expect(providers(database)).toEqual({
      [SESSION(1)]: "rly0",
      [SESSION(2)]: "rly0",
      [SESSION(3)]: "rly0",
      // Gone conversation file and an empty provider: left as they were.
      [SESSION(4)]: "openai",
      [SESSION(5)]: "",
    });
    const backup = path.join(paths.dataDir, "chat-repair-backups", STAMP);
    expect(readFileSync(path.join(backup, "codex-state", "state_5.sqlite")).equals(before)).toBe(
      true,
    );
    const record = JSON.parse(readFileSync(path.join(backup, "provider-changes.json"), "utf8"));
    expect(record).toMatchObject({
      schemaVersion: 1,
      to: "rly0",
      changes: [
        { id: SESSION(1), from: "openai" },
        { id: SESSION(3), from: "aimai1" },
      ],
    });
    expect(lastChatProviderRepair(paths)).toEqual({ stamp: STAMP, count: 2 });
  });

  it("changes nothing and keeps no record when every chat is on the current provider", async () => {
    const { database, paths } = makeCodex([{ id: SESSION(6), provider: "rly0" }]);
    const before = readFileSync(database);
    expect(await repairChatProviders(paths, STAMP)).toBe(0);
    expect(readFileSync(database).equals(before)).toBe(true);
    expect(existsSync(path.join(paths.dataDir, "chat-repair-backups", STAMP))).toBe(false);
    expect(lastChatProviderRepair(paths)).toBeNull();
  });

  it("undoes exactly what it changed, leaving chats changed since alone", async () => {
    const { database, paths } = makeCodex([
      { id: SESSION(7), provider: "openai" },
      { id: SESSION(8), provider: "openai" },
      { id: SESSION(9), provider: "rly0" },
    ]);
    await repairChatProviders(paths, STAMP);
    // Moved elsewhere after the repair: an undo must not take it back.
    const db = new DatabaseSync(database);
    db.prepare("update threads set model_provider = 'custom' where id = ?").run(SESSION(8));
    db.close();
    expect(await undoChatProviderRepair(paths, STAMP)).toBe(1);
    expect(providers(database)).toEqual({
      [SESSION(7)]: "openai",
      [SESSION(8)]: "custom",
      [SESSION(9)]: "rly0",
    });
    expect(lastChatProviderRepair(paths)).toBeNull();
    // A second undo of the same repair does nothing.
    expect(await undoChatProviderRepair(paths, STAMP)).toBe(0);
  });

  it("refuses stamps that are not a repair's and another database than the repaired one", async () => {
    const { codex, paths } = makeCodex([{ id: SESSION(10), provider: "openai" }]);
    await expect(repairChatProviders(paths, "../x")).rejects.toThrow("CHAT_REPAIR_STAMP_INVALID");
    await expect(undoChatProviderRepair(paths, "../x")).rejects.toThrow(
      "CHAT_REPAIR_STAMP_INVALID",
    );
    await repairChatProviders(paths, STAMP);
    // Codex moved on to a newer database: the record no longer applies to what is there.
    writeFileSync(path.join(codex, "state_6.sqlite"), "");
    expect(await undoChatProviderRepair(paths, STAMP)).toBe(0);
  });

  it("writes nothing while another process still has Codex's database open", async () => {
    const { home, database, paths } = makeCodex([{ id: SESSION(14), provider: "openai" }]);
    const before = readFileSync(database);
    const busy = { openers: async () => [4242], waitMs: 0 };
    await expect(repairChatProviders(paths, STAMP, busy)).rejects.toThrow("CODEX_DATABASE_IN_USE");
    expect(readFileSync(database).equals(before)).toBe(true);
    expect(lastChatProviderRepair(paths)).toBeNull();
    const repair = new ChatRepair({
      environment: {},
      home,
      codex: {
        status: async () => ({ running: false }),
        forceQuit: async () => ({ ok: true }),
        open: async () => ({ ok: true }),
      },
      sleep: async () => undefined,
      now: () => new Date("2026-11-08T03:04:05.123Z"),
      providerRepair: busy,
    });
    expect(await repair.repair()).toMatchObject({
      ok: false,
      providers: 0,
      reason: "CODEX_DATABASE_IN_USE",
    });
    expect(providers(database)).toEqual({ [SESSION(14)]: "openai" });
  });

  it("is part of 修复聊天记录: Codex is closed, repaired, reopened, and the change can be undone", async () => {
    const { home, database } = makeCodex([
      { id: SESSION(11), provider: "openai" },
      { id: SESSION(12), provider: "aimai1" },
      { id: SESSION(13), provider: "rly0" },
    ]);
    let running = true;
    const calls: string[] = [];
    const repair = new ChatRepair({
      environment: {},
      home,
      codex: {
        status: async () => ({ running }),
        forceQuit: async () => {
          calls.push("quit");
          running = false;
          return { ok: true };
        },
        open: async () => {
          calls.push("open");
          running = true;
          return { ok: true };
        },
      },
      sleep: async () => undefined,
      now: () => new Date("2026-11-08T03:04:05.123Z"),
    });
    const found = await repair.scan();
    expect(found.broken).toBe(2);
    expect(found.groups.filter((g) => g.repairable).map((g) => [g.kind, g.count])).toEqual(
      expect.arrayContaining([
        ["codex-provider-not-current", 1],
        ["codex-provider-missing", 1],
      ]),
    );
    expect(found.providerUndo).toBeNull();

    const result = await repair.repair();
    expect(result).toMatchObject({ ok: true, repaired: 2, providers: 2, codexRestarted: true });
    expect(calls).toEqual(["quit", "open"]);
    expect(Object.values(providers(database))).toEqual(["rly0", "rly0", "rly0"]);
    const after = await repair.scan();
    expect(after.broken).toBe(0);
    expect(after.providerUndo).toEqual({ stamp: STAMP, count: 2 });

    const undone = await repair.undoProviders(STAMP);
    expect(undone).toMatchObject({ ok: true, providers: 2, codexRestarted: true });
    expect(calls).toEqual(["quit", "open", "quit", "open"]);
    expect(providers(database)).toEqual({
      [SESSION(11)]: "openai",
      [SESSION(12)]: "aimai1",
      [SESSION(13)]: "rly0",
    });
    expect((await repair.scan()).providerUndo).toBeNull();
  });
});
