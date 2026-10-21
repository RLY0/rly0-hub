import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { ChatReadableRecovery } from "../src/rly0-maintenance/chat-recovery.js";
import { createHubManagementRoutes } from "../src/rly0-hub-service/management-routes.js";
import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import type { Rly0CodexControl } from "../src/rly0-hub-service/codex-control.js";

const id = (n: number) => `aaaaaaaa-1111-4111-8111-${String(n).padStart(12, "0")}`;
const line = (type: string, payload: unknown) => JSON.stringify({ type, payload }) + "\n";
const message = (role: string, text: string, phase?: string) =>
  line("response_item", {
    type: "message",
    role,
    ...(phase ? { phase } : role === "assistant" ? { phase: "final" } : {}),
    content: [{ type: role === "user" ? "input_text" : "output_text", text }],
  });
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-readable-history-"));
  const codex = path.join(home, "codex"),
    data = path.join(home, "hub");
  const sessions = path.join(codex, "sessions");
  await fs.mkdir(sessions, { recursive: true });
  await fs.writeFile(path.join(codex, "config.toml"), "model_provider = 'openai'\n");
  const database = path.join(codex, "state_5.sqlite");
  const db = new DatabaseSync(database);
  db.exec(
    "create table threads (id text primary key, rollout_path text, model_provider text, title text, archived integer, updated_at integer)",
  );
  db.close();
  const environment = {
    CODEX_HOME: codex,
    CODEXHOST_DATA_DIR: data,
    CLAUDE_CONFIG_DIR: path.join(home, "claude"),
  };
  async function add(
    n: number,
    text: string | Buffer,
    options: {
      compressed?: boolean;
      indexed?: boolean;
      provider?: string;
      archived?: boolean;
    } = {},
  ) {
    const file = path.join(
      sessions,
      `rollout-2026-10-21-${id(n)}.jsonl${options.compressed ? ".zst" : ""}`,
    );
    await fs.writeFile(file, options.compressed ? zstdCompressSync(Buffer.from(text)) : text);
    if (options.indexed !== false) {
      const db = new DatabaseSync(database);
      try {
        db.prepare("insert into threads values (?, ?, ?, ?, ?, 1)").run(
          id(n),
          file,
          options.provider ?? "old-provider",
          `<script>title-${n}</script>`,
          options.archived ? 1 : 0,
        );
      } finally {
        db.close();
      }
    }
    return file;
  }
  return { home, codex, data, database, environment, add };
}

describe("SYNTHETIC readable history recovery", () => {
  it("creates private visible-text copies from plain/zstd/orphan histories, never rewriting originals", async () => {
    const f = await fixture();
    try {
      const content =
        line("session_meta", { id: id(1) }) +
        message("user", "<img src=x onerror=alert(1)>") +
        message("assistant", "可见回复", "final") +
        line("response_item", {
          type: "message",
          role: "assistant",
          phase: null,
          content: [{ type: "output_text", text: "旧格式可见回复" }],
        }) +
        message("assistant", "HIDDEN_ANALYSIS_SENTINEL", "analysis") +
        line("response_item", {
          type: "message",
          role: "assistant",
          phase: "final",
          content: [{ type: "text", text: "UNVERIFIED_TEXT_SENTINEL" }],
        }) +
        line("response_item", { type: "reasoning", summary: "HIDDEN_REASONING_SENTINEL" }) +
        line("response_item", { type: "function_call_output", output: "TOOL_SECRET_SENTINEL" });
      const files = [
        await f.add(1, content, { archived: true }),
        await f.add(2, message("user", "压缩历史"), { compressed: true }),
        await f.add(3, content, { indexed: false, compressed: true }),
      ];
      await f.add(4, message("user", "HEALTHY_NOT_REQUESTED"), { provider: "openai" });
      const healthyCompressed = await f.add(
        5,
        message("user", "HEALTHY_COMPRESSED_NOT_REQUESTED"),
        { provider: "openai", compressed: true },
      );
      const db = new DatabaseSync(f.database);
      try {
        db.prepare("update threads set rollout_path = ? where id = ?").run(
          healthyCompressed.slice(0, -4),
          id(5),
        );
      } finally {
        db.close();
      }
      const before = await Promise.all([...files, f.database].map((file) => fs.readFile(file)));
      const recovery = new ChatReadableRecovery(f.environment, f.home);
      await recovery.start();
      await recovery.start(); // Same running job, no duplicate export.
      const status = await recovery.wait();
      expect(status).toMatchObject({
        phase: "completed",
        total: 3,
        processed: 3,
        recovered: 3,
        partial: 2,
        failed: 0,
      });
      const directory = path.dirname(await recovery.completedIndex());
      const html = await fs.readFile(path.join(directory, `${id(1)}.html`), "utf8");
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
      expect(html).toContain("&lt;script&gt;title-1&lt;/script&gt;");
      expect(html).toContain("原记录已归档");
      expect(html).not.toContain("旧格式可见回复");
      expect(html).not.toMatch(
        /HIDDEN_ANALYSIS_SENTINEL|HIDDEN_REASONING_SENTINEL|TOOL_SECRET_SENTINEL|UNVERIFIED_TEXT_SENTINEL|HEALTHY_NOT_REQUESTED/u,
      );
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        originalDataModified: false,
        nativeResumptionRepaired: false,
      });
      expect(
        manifest.entries.find((entry: { id: string }) => entry.id === id(3)).metadataMismatch,
      ).toBe(true);
      const after = await Promise.all([...files, f.database].map((file) => fs.readFile(file)));
      expect(after).toEqual(before);
      const reopened = new ChatReadableRecovery(f.environment, f.home);
      expect(await reopened.status()).toEqual(status);
      expect(await reopened.completedIndex()).toBe(await recovery.completedIndex());
    } finally {
      await fs.rm(f.home, { recursive: true, force: true });
    }
  });

  it("reports malformed/oversized content as partial, not a repaired native session", async () => {
    const f = await fixture();
    try {
      await f.add(
        1,
        message("user", "保留这条") +
          "{broken\n" +
          "x".repeat(4 * 1024 * 1024 + 1) +
          "\n" +
          message("assistant", "后面的正常回复"),
      );
      const recovery = new ChatReadableRecovery(f.environment, f.home);
      await recovery.start();
      expect(await recovery.wait()).toMatchObject({ recovered: 1, partial: 1, failed: 0 });
      const html = await fs.readFile(
        path.join(path.dirname(await recovery.completedIndex()), `${id(1)}.html`),
        "utf8",
      );
      expect(html).toContain("保留这条");
      expect(html).toContain("后面的正常回复");
      expect(html).toContain("内容不完整");
      expect(html).toContain("尚未恢复原生列表或续聊");
    } finally {
      await fs.rm(f.home, { recursive: true, force: true });
    }
  });

  it("continues after an unreadable compressed file and does not invent missing text", async () => {
    const f = await fixture();
    try {
      const broken = await f.add(1, "temporary", { compressed: true });
      await fs.writeFile(broken, "NOT_ZSTD");
      await f.add(2, message("assistant", "仍然找回"));
      const recovery = new ChatReadableRecovery(f.environment, f.home);
      await recovery.start();
      expect(await recovery.wait()).toMatchObject({ phase: "completed", recovered: 1, failed: 1 });
    } finally {
      await fs.rm(f.home, { recursive: true, force: true });
    }
  });

  it("rejects invalid persistent pointers and cannot open an arbitrary local path", async () => {
    const f = await fixture();
    try {
      await fs.mkdir(path.join(f.data, "chat-recovery"), { recursive: true });
      await fs.writeFile(
        path.join(f.data, "chat-recovery", "latest.json"),
        JSON.stringify({ phase: "completed", folder: "../../private" }),
      );
      const recovery = new ChatReadableRecovery(f.environment, f.home);
      expect(await recovery.status()).toMatchObject({ phase: "idle" });
      await expect(recovery.completedIndex()).rejects.toThrow("HISTORY_RECOVERY_NOT_READY");
    } finally {
      await fs.rm(f.home, { recursive: true, force: true });
    }
  });

  it("classifies the 501st existing file as a processing limit, not missing history", async () => {
    const f = await fixture();
    try {
      const files = Array.from({ length: 501 }, (_, i) =>
        path.join(f.codex, "sessions", `rollout-synthetic-${id(i + 1)}.jsonl`),
      );
      await Promise.all(
        files.map((file) => fs.writeFile(file, message("user", "synthetic visible text"))),
      );
      const db = new DatabaseSync(f.database);
      try {
        db.exec("begin");
        const insert = db.prepare(
          "insert into threads values (?, ?, 'old-provider', 'SYNTHETIC', 0, 1)",
        );
        files.forEach((file, i) => insert.run(id(i + 1), file));
        db.exec("commit");
      } finally {
        db.close();
      }
      const recovery = new ChatReadableRecovery(f.environment, f.home);
      await recovery.start();
      expect(await recovery.wait()).toMatchObject({
        phase: "completed",
        recovered: 500,
        failed: 0,
        unavailable: 0,
        limited: 1,
      });
    } finally {
      await fs.rm(f.home, { recursive: true, force: true });
    }
  });

  it("classifies the work deadline as a limit, never as a corrupt source", async () => {
    const f = await fixture();
    const now = vi.spyOn(Date, "now");
    try {
      await f.add(1, message("user", "source is present"));
      const recovery = new ChatReadableRecovery(f.environment, f.home);
      now.mockReturnValueOnce(0).mockReturnValue(120001);
      await recovery.start();
      expect(await recovery.wait()).toMatchObject({
        phase: "completed",
        recovered: 0,
        failed: 0,
        unavailable: 0,
        limited: 1,
      });
    } finally {
      now.mockRestore();
      await fs.rm(f.home, { recursive: true, force: true });
    }
  });

  it("integrates strict routes without login, provider switching or stopping Codex", async () => {
    const f = await fixture();
    try {
      await f.add(1, message("user", "route proof"));
      const calls: string[] = [],
        opened: string[] = [];
      const codex = {
        forceQuit: async () => {
          calls.push("quit");
          return { ok: true };
        },
        open: async () => {
          calls.push("open");
          return { ok: true };
        },
        status: async () => {
          calls.push("status");
          return { running: true };
        },
      } as unknown as Rly0CodexControl;
      const routes = createHubManagementRoutes({
        environment: f.environment,
        installRoot: f.home,
        core: {} as Rly0CoreBridge,
        codex,
        openFolder: (file) => opened.push(file),
      });
      await expect(
        routes["maintenance.chatRecoverReadable"]({ file: "/arbitrary" }),
      ).rejects.toThrow("INVALID_PARAMS");
      await routes["maintenance.chatRecoverReadable"]({});
      let state;
      for (let i = 0; i < 100; ++i) {
        state = (await routes["maintenance.chatRecoverStatus"]({})) as { phase: string };
        if (state.phase !== "running") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(state).toMatchObject({ phase: "completed", recovered: 1 });
      await routes["maintenance.openRecoveredHistory"]({});
      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatch(/chat-recovery[/\\]recovery-[A-Za-z0-9]{6}[/\\]index\.html$/u);
      expect(calls).toEqual([]);
    } finally {
      await fs.rm(f.home, { recursive: true, force: true });
    }
  });
});
