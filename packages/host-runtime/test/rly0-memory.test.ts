import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { importCodexMemories } from "../src/rly0-memory/codex-import.js";
import { rly0MemoryServerLaunch } from "../src/rly0-memory/launch.js";
import { callMemoryTool, handleMemoryRpc } from "../src/rly0-memory/mcp-server.js";
import { redactMemoryText } from "../src/rly0-memory/redaction.js";
import { MemoryStore, normalizeProjectKey } from "../src/rly0-memory/store.js";

const roots: string[] = [];
async function temp(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "rly0-memory-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(root: string, name: string): Promise<string> {
  const folder = path.join(root, name);
  await mkdir(path.join(folder, ".git"), { recursive: true });
  await mkdir(path.join(folder, "src", "deep"), { recursive: true });
  return folder;
}

describe("rly0-memory redaction", () => {
  it.each([
    ["api_key=sk-proj-abcdefghijklmnopqrstuvwxyz0123", "sk-proj-abc"],
    ["token: ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abc"],
    ["Authorization: Bearer abcdefghijklmnopqrstu.vwxyz", "abcdefghijklmnop"],
    ["db postgres://admin:hunter2secret@db.local:5432/app", "hunter2secret"],
    ["Server=x;User Id=sa;Password=P@ssw0rd!;", "P@ssw0rd!"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----", "MIIEow"],
    ['{"password": "correct-horse"}', "correct-horse"],
    ["aws AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
    ["<private>my diary</private>", "my diary"],
  ])("removes %s", (input, secret) => {
    const result = redactMemoryText(input);
    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(secret);
  });
  it("keeps ordinary text", () => {
    const text = "Use pnpm, not npm. The password field on the login form is optional.";
    expect(redactMemoryText(text)).toEqual({ text, redacted: false });
  });
});

describe("rly0-memory store", () => {
  it("scopes records by repository root and global, persists, and forgets from disk", async () => {
    const root = await temp();
    const a = await project(root, "a");
    const b = await project(root, "b");
    const store = new MemoryStore(path.join(root, "memory"));
    const inA = await store.remember({ text: "A uses vitest", agent: "claude-code", scope: "project", cwd: path.join(a, "src", "deep") });
    await store.remember({ text: "B uses jest", agent: "grok", scope: "project", cwd: b });
    await store.remember({ text: "Reply in Chinese", agent: "codex", scope: "global" });
    expect(inA.project).toBe(normalizeProjectKey(a));

    const reopened = new MemoryStore(path.join(root, "memory"));
    const visible = await reopened.query({ cwd: a });
    expect(visible.map((r) => r.text).sort()).toEqual(["A uses vitest", "Reply in Chinese"]);
    expect((await reopened.query({ cwd: a, query: "jest", scope: "all" })).map((r) => r.text)).toEqual(["B uses jest"]);
    expect(await reopened.query({ cwd: a, query: "jest" })).toEqual([]);
    expect((await reopened.query({ scope: "global" })).map((r) => r.agent)).toEqual(["codex"]);

    expect(await reopened.forget(inA.id, "hub")).toBe(true);
    expect(await readFile(path.join(root, "memory", "records.jsonl"), "utf8")).not.toContain("vitest");
    const audit = await readFile(path.join(root, "memory", "audit.jsonl"), "utf8");
    expect(audit).toContain('"op":"forget"');
    expect(audit).not.toContain("vitest");
  });

  it("redacts on write and enforces limits", async () => {
    const root = await temp();
    const store = new MemoryStore(path.join(root, "memory"));
    const saved = await store.remember({ text: "deploy key is sk-ant-abcdefghijklmnopqrstuvwxyz", agent: "pi", scope: "global" });
    expect(saved.text).not.toContain("sk-ant-abc");
    expect(await readFile(path.join(root, "memory", "records.jsonl"), "utf8")).not.toContain("sk-ant-abc");
    expect(await readFile(path.join(root, "memory", "audit.jsonl"), "utf8")).toContain('"redacted":true');
    await expect(store.remember({ text: "x".repeat(4001), agent: "pi", scope: "global" })).rejects.toThrow("MEMORY_TEXT_TOO_LONG");
    await expect(store.remember({ text: "ok", tags: ["bad tag"], agent: "pi", scope: "global" })).rejects.toThrow("MEMORY_TAG_INVALID");
    await expect(store.remember({ text: "ok", agent: "pi", scope: "project" })).rejects.toThrow("MEMORY_PROJECT_REQUIRED");
  });

  it("redacts records again on read", async () => {
    const root = await temp();
    const dir = path.join(root, "memory");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "records.jsonl"),
      `${JSON.stringify({ id: "1", text: "old ghp_abcdefghijklmnopqrstuvwxyz0123456789", tags: [], agent: "x", scope: "global", time: 1 })}\n{"partial":`,
    );
    const [only] = await new MemoryStore(dir).query({});
    expect(only?.text).not.toContain("ghp_abc");
  });

  it("serializes concurrent writers from separate store instances", async () => {
    const root = await temp();
    const dir = path.join(root, "memory");
    const writers = Array.from({ length: 4 }, () => new MemoryStore(dir));
    await Promise.all(
      writers.flatMap((store, w) =>
        Array.from({ length: 15 }, (_, i) => store.remember({ text: `w${w}-${i}`, agent: `a${w}`, scope: "global" })),
      ),
    );
    const all = await new MemoryStore(dir).all();
    expect(all).toHaveLength(60);
    expect(new Set(all.map((r) => r.text)).size).toBe(60);
  });
});

describe("rly0-memory MCP", () => {
  it("answers initialize with the one-line instruction and lists four tools", async () => {
    const root = await temp();
    const context = { store: new MemoryStore(root), agent: "kiro-cli", cwd: root };
    const init = await handleMemoryRpc(context, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    expect(init).toMatchObject({ result: { protocolVersion: "2025-03-26", serverInfo: { name: "rly0-memory" } } });
    expect(String((init?.result as { instructions: string }).instructions)).toContain("recall");
    const list = await handleMemoryRpc(context, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((list?.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(["remember", "recall", "search", "forget"]);
    expect(await handleMemoryRpc(context, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("remember by one agent is recalled by another, then forgotten", async () => {
    const root = await temp();
    const repo = await project(root, "repo");
    const store = new MemoryStore(path.join(root, "memory"));
    const saved = await callMemoryTool({ store, agent: "pi", cwd: repo }, "remember", { text: "Run npm run typecheck before commits", tags: ["workflow"] });
    const id = (saved.structuredContent?.saved as { id: string }).id;
    const recalled = await callMemoryTool({ store, agent: "claude-code", cwd: path.join(repo, "src") }, "recall", { query: "typecheck" });
    expect(recalled.structuredContent?.memories).toEqual([expect.objectContaining({ id, agent: "pi", scope: "project", tags: ["workflow"] })]);
    const other = await project(root, "other");
    expect((await callMemoryTool({ store, agent: "grok", cwd: other }, "recall", {})).structuredContent?.memories).toEqual([]);
    expect((await callMemoryTool({ store, agent: "grok", cwd: other }, "search", { query: "typecheck", scope: "all" })).structuredContent?.memories).toHaveLength(1);
    expect((await callMemoryTool({ store, agent: "codex", cwd: repo }, "forget", { id })).structuredContent).toEqual({ forgotten: true });
    const tooLong = await callMemoryTool({ store, agent: "pi", cwd: repo }, "remember", { text: "x".repeat(5000) });
    expect(tooLong.isError).toBe(true);
  });

  it("serves several real stdio processes writing at once", async () => {
    const root = await temp();
    const memoryDir = path.join(root, "memory");
    const dist = path.resolve(fileURLToPath(import.meta.url), "../../dist/installed-harness-plugins.js");
    const launch = rly0MemoryServerLaunch({ environment: { RLY0_MEMORY_DIR: memoryDir }, agent: "fake", entryUrl: pathToFileURL(dist).href });
    expect(launch.args[0]).toMatch(/rly0-memory[\\/]server-main\.js$/u);
    const run = (agent: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(launch.command, launch.args, {
          env: { ...process.env, ...launch.env, RLY0_MEMORY_AGENT: agent, RLY0_MEMORY_CWD: root },
          stdio: ["pipe", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
        child.once("error", reject);
        child.once("close", () => resolve(out));
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} })}\n`);
        for (let i = 0; i < 10; i += 1)
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: "remember", arguments: { text: `${agent} note ${i}`, scope: "global" } } })}\n`);
        child.stdin.end();
      });
    const outputs = await Promise.all(["one", "two", "three"].map(run));
    for (const out of outputs) expect(out.trim().split("\n")).toHaveLength(11);
    const all = await new MemoryStore(memoryDir).all();
    expect(all).toHaveLength(30);
    expect(new Set(all.map((r) => r.agent))).toEqual(new Set(["one", "two", "three"]));
  }, 30_000);
});

describe("Codex memory import", () => {
  it("imports durable sections once without touching Codex files", async () => {
    const root = await temp();
    const codex = path.join(root, ".codex");
    const memories = path.join(codex, "memories");
    await mkdir(memories, { recursive: true });
    const memory = [
      "# Task Group: Hub work",
      "scope: x",
      `applies_to: cwd=${path.join(root, "repo")}; reuse_rule=x`,
      "## Task 1: thing, outcome success",
      "rollout",
      "## User preferences",
      "- wants short reports",
      "## Reusable knowledge",
      "- run sync-workspace-copies after tsc",
      "# Task Group: Without scope",
      "## Failures and how to do differently",
      "- do not guess",
    ].join("\n");
    await writeFile(path.join(memories, "MEMORY.md"), memory);
    await writeFile(path.join(memories, "memory_summary.md"), "## User Profile\nDeveloper\n## What's in Memory\nindex\n");
    const store = new MemoryStore(path.join(root, "memory"));
    const result = await importCodexMemories(store, { CODEX_HOME: codex });
    expect(result).toEqual({ imported: 4, skipped: null });
    const all = await store.all();
    expect(all.filter((r) => r.scope === "project")).toHaveLength(2);
    expect(all.every((r) => r.agent === "codex" && r.source === "import" && r.tags.includes("codex-import"))).toBe(true);
    expect(all.some((r) => r.text.includes("index"))).toBe(false);
    expect(await importCodexMemories(store, { CODEX_HOME: codex })).toEqual({ imported: 0, skipped: "already-imported" });
    expect(await readFile(path.join(memories, "MEMORY.md"), "utf8")).toBe(memory);
  });
});
