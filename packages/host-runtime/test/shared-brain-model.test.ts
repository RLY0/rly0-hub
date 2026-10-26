import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DelegationControlApi } from "../src/delegation-types.js";
import { openRly0MemoryStore } from "../src/rly0-memory/launch.js";
import {
  createFixture,
  answerOfficialParentCwd,
  readJsonLine,
  stopFixture,
  writeRequest,
  requestId,
} from "./app-server-host-fixture.js";

describe("HUB-50 official Codex defaults and preference transport (synthetic)", () => {
  it("uses a ChatGPT-compatible native default instead of a configured relay, without developer preference injection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hub50-model-"));
    const environment = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
    };
    await mkdir(path.join(root, ".git"));
    const store = openRly0MemoryStore(environment);
    await store.remember(
      {
        text: "始终中文\n原文第二行",
        scope: "global",
        tags: ["preference"],
        agent: "hub",
      },
      true,
    );
    await store.remember(
      {
        text: "当前项目规则",
        scope: "project",
        cwd: root,
        tags: ["preference"],
        agent: "hub",
      },
      true,
    );
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      environment,
      accountControl: {
        currentAccountId: () => "synthetic-account",
        snapshot: () => ({
          version: 2,
          phase: "ready",
          revision: 0,
          currentAccountId: "synthetic-account",
          accounts: [
            { accountId: "synthetic-account", email: "synthetic@example.test", label: "synthetic" },
          ],
        }),
      },
      onDelegationApi: (registration) => {
        api = registration;
      },
    });
    const reply = (id: unknown, result: unknown) =>
      fixture.official.stdout.write(JSON.stringify({ id, result }) + "\n");
    try {
      await fixture.ready;
      if (!api) throw new Error("No delegation API");
      const pending = api.start({
        harnessId: "codex",
        task: "synthetic task",
        cwd: root,
        parentThreadId: "parent-thread",
      });
      await answerOfficialParentCwd(fixture);
      const catalog = await readJsonLine(fixture.official.stdin);
      expect(catalog.method).toBe("model/list");
      reply(catalog.id, {
        data: [
          { model: "rly0/provider/gpt-6.1-sol", isDefault: true },
          { model: "cfg/private/any", isDefault: true },
          { model: "gpt-6.1-sol", isDefault: false },
        ],
      });
      const start = await readJsonLine(fixture.official.stdin);
      expect(start).toMatchObject({ method: "thread/start", params: { model: "gpt-6.1-sol" } });
      expect(start.params).not.toHaveProperty("developerInstructions");
      expect(JSON.stringify(start.params)).not.toContain("当前项目规则");
      reply(start.id, { thread: { id: "synthetic-child" }, model: "gpt-6.1-sol" });
      const name = await readJsonLine(fixture.official.stdin);
      expect(name.method).toBe("thread/name/set");
      reply(name.id, {});
      const turn = await readJsonLine(fixture.official.stdin);
      expect(turn).toMatchObject({ method: "turn/start", params: { model: "gpt-6.1-sol" } });
      reply(turn.id, { turn: { id: "synthetic-turn" } });
      await expect(pending).resolves.toMatchObject({
        threadId: "synthetic-child",
        status: "running",
      });
    } finally {
      await stopFixture(fixture);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps ordinary Codex thread/start caller instructions unchanged; native AGENTS is the preference source", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hub50-direct-"));
    const environment = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
    };
    const fixture = createFixture({ environment });
    await openRly0MemoryStore(environment).remember(
      {
        text: "始终中文",
        scope: "global",
        tags: ["preference"],
        agent: "hub",
      },
      true,
    );
    try {
      await fixture.ready;
      writeRequest(fixture.desktopInput, {
        id: 500,
        method: "thread/start",
        params: { cwd: root, model: "gpt-6.1-sol", developerInstructions: "caller instructions" },
      });
      const start = await readJsonLine(fixture.official.stdin);
      expect(start.method).toBe("thread/start");
      expect(start.params).toMatchObject({
        developerInstructions: expect.stringContaining("caller instructions"),
      });
      expect(start.params).toMatchObject({ developerInstructions: "caller instructions" });
      expect(JSON.stringify(start.params)).not.toContain("始终中文");
      fixture.official.stdout.write(
        JSON.stringify({ id: start.id, result: { thread: { id: "native-direct" } } }) + "\n",
      );
      await fixture.collector.waitFor((message) => requestId(message, 500));
    } finally {
      await stopFixture(fixture);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['model="gpt-compatible"\nmodel_provider="openai"\n', "gpt-compatible"],
    ['model="rly0/provider/custom"\nmodel_provider="rly0"\n', "gpt-default"],
    ['model="retired-model"\n', "gpt-default"],
    [
      'model="gpt-default"\nprofile="personal"\n[profiles.personal]\nmodel="gpt-compatible"\nmodel_provider="openai"\n',
      "gpt-compatible",
    ],
  ])(
    "respects compatible configuration or falls back only when incompatible: %s",
    async (config, expected) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "hub50-config-synthetic-"));
      const environment = {
        HOME: root,
        USERPROFILE: root,
        CODEX_HOME: path.join(root, ".codex"),
        CODEXHOST_DATA_DIR: path.join(root, "hub"),
        RLY0_MEMORY_DIR: path.join(root, "memory"),
      };
      await mkdir(environment.CODEX_HOME, { recursive: true });
      await writeFile(path.join(environment.CODEX_HOME, "config.toml"), config);
      let api: DelegationControlApi | undefined;
      const fixture = createFixture({
        environment,
        accountControl: {
          currentAccountId: () => "synthetic-account",
          snapshot: () => ({
            version: 2,
            phase: "ready",
            revision: 0,
            currentAccountId: "synthetic-account",
            accounts: [
              {
                accountId: "synthetic-account",
                email: "synthetic@example.test",
                label: "synthetic",
              },
            ],
          }),
        },
        onDelegationApi: (registration) => {
          api = registration;
        },
      });
      const reply = (id: unknown, result: unknown) =>
        fixture.official.stdout.write(JSON.stringify({ id, result }) + "\n");
      try {
        await fixture.ready;
        if (!api) throw new Error("No delegation API");
        const input = {
          harnessId: "codex" as const,
          task: "synthetic",
          cwd: root,
          parentThreadId: "parent-thread",
          requestId: "synthetic-same-request",
        };
        const pending = api.start(input);
        await answerOfficialParentCwd(fixture);
        const catalog = await readJsonLine(fixture.official.stdin);
        expect(catalog.method).toBe("model/list");
        reply(catalog.id, {
          data: [{ model: "gpt-default", isDefault: true }, { model: "gpt-compatible" }],
        });
        const start = await readJsonLine(fixture.official.stdin);
        expect(start).toMatchObject({ method: "thread/start", params: { model: expected } });
        reply(start.id, { thread: { id: "synthetic-child" }, model: expected });
        const name = await readJsonLine(fixture.official.stdin);
        reply(name.id, {});
        const turn = await readJsonLine(fixture.official.stdin);
        reply(turn.id, { turn: { id: "synthetic-turn" } });
        await expect(pending).resolves.toMatchObject({ threadId: "synthetic-child" });
        // A changed default must not turn a retry of the original user input into a conflict,
        // nor require a catalog read before returning the existing task.
        await writeFile(
          path.join(environment.CODEX_HOME, "config.toml"),
          'model="changed-default"\n',
        );
        const retry = api.start(input);
        await answerOfficialParentCwd(fixture);
        await expect(retry).resolves.toMatchObject({ threadId: "synthetic-child" });
      } finally {
        await stopFixture(fixture);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("uses the native default when account refresh fails, without aborting a delegation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "hub50-identity-synthetic-"));
    const environment = {
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, ".codex"),
      CODEXHOST_DATA_DIR: path.join(root, "hub"),
      RLY0_MEMORY_DIR: path.join(root, "memory"),
    };
    let api: DelegationControlApi | undefined;
    const fixture = createFixture({
      environment,
      accountControl: {
        currentAccountId: () => null,
        snapshot: () => ({
          version: 2,
          phase: "ready",
          revision: 0,
          currentAccountId: null,
          accounts: [],
        }),
        refresh: async () => {
          throw new Error("synthetic refresh failure");
        },
      },
      onDelegationApi: (registration) => {
        api = registration;
      },
    });
    const reply = (id: unknown, result: unknown) =>
      fixture.official.stdout.write(JSON.stringify({ id, result }) + "\n");
    try {
      await fixture.ready;
      if (!api) throw new Error("No delegation API");
      const pending = api.start({
        harnessId: "codex",
        task: "synthetic",
        cwd: root,
        parentThreadId: "parent-thread",
      });
      await answerOfficialParentCwd(fixture);
      const start = await readJsonLine(fixture.official.stdin);
      expect(start.method).toBe("thread/start");
      expect(start.params).not.toHaveProperty("model");
      reply(start.id, { thread: { id: "synthetic-child" } });
      const name = await readJsonLine(fixture.official.stdin);
      reply(name.id, {});
      const turn = await readJsonLine(fixture.official.stdin);
      reply(turn.id, { turn: { id: "synthetic-turn" } });
      await expect(pending).resolves.toMatchObject({ threadId: "synthetic-child" });
    } finally {
      await stopFixture(fixture);
      await rm(root, { recursive: true, force: true });
    }
  });
});
