import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  idleReleaseSettingsSchema,
  rly0AgentDefaultsSetParamsSchema,
  rly0CodexPreferencesGetResultSchema,
} from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  agentDefaultsFile,
  codexPreferencesGetResult,
  readAgentDefaults,
  writeAgentDefaults,
} from "../src/rly0-appearance/agent-defaults.js";
import {
  codexPreferencesFile,
  readCodexPreferences,
  writeCodexPreferences,
} from "../src/rly0-appearance/codex-preferences.js";

// The strict schemas 0.11.27 (2c19323e) and older use for codex-preferences.json and for the
// codexPreferences/get result, copied verbatim: a rolled-back build must still read both.
const legacyPreferencesSchema = z
  .object({
    reasoningSoftWrap: z.boolean().optional(),
    accentColor: z.enum(["signal", "blue", "purple", "green", "orange", "rose"]).optional(),
    quotaRefresh: z.enum(["30s", "1m", "3m", "5m"]).optional(),
    quotaAlert: z
      .object({ enabled: z.boolean(), thresholdPercent: z.number().int().min(1).max(90) })
      .strict()
      .optional(),
    idleRelease: idleReleaseSettingsSchema.optional(),
  })
  .strict()
  .extend({ updatedAt: z.number().int().nonnegative() })
  .strict();
const legacyGetResultSchema = z
  .object({ preferences: legacyPreferencesSchema.nullable() })
  .strict();

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});
async function dataDir() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-defaults-"));
  roots.push(root);
  return { CODEXHOST_DATA_DIR: root };
}
const agents = rly0AgentDefaultsSetParamsSchema.parse({
  agents: {
    "claude-code": { permissionModeId: "plan", model: { id: "opus" }, thinkingOptionId: "high" },
    opencode: { model: { id: "gpt-5.5" } },
  },
}).agents;

describe("New-Thread defaults file beside the Codex preferences", () => {
  it("never touches codex-preferences.json, which still parses with the 0.11.27 schema", async () => {
    const environment = await dataDir();
    await writeCodexPreferences(
      environment,
      { reasoningSoftWrap: true, quotaAlert: { enabled: true, thresholdPercent: 15 } },
      () => 5,
    );
    const before = await fs.readFile(codexPreferencesFile(environment), "utf8");

    await writeAgentDefaults(environment, agents, () => 9);
    await writeAgentDefaults(environment, {}, () => 9);

    const after = await fs.readFile(codexPreferencesFile(environment), "utf8");
    expect(after).toBe(before);
    expect(legacyPreferencesSchema.safeParse(JSON.parse(after)).success).toBe(true);
    // A later Codex preference change still writes the old format only.
    await writeCodexPreferences(environment, { accentColor: "green" }, () => 6);
    const changed = JSON.parse(await fs.readFile(codexPreferencesFile(environment), "utf8"));
    expect(legacyPreferencesSchema.parse(changed)).not.toHaveProperty("agentDefaults");
  });

  it("saves the whole map with a version and a newer stamp each time", async () => {
    const environment = await dataDir();
    const first = await writeAgentDefaults(environment, agents, () => 9);
    expect(first).toEqual({ version: 1, updatedAt: 9, agents });
    const cleared = await writeAgentDefaults(
      environment,
      { opencode: { model: { id: "gpt-5.5" } } } as never,
      () => 9,
    );
    expect(cleared).toEqual({
      version: 1,
      updatedAt: 10,
      agents: { opencode: { model: { id: "gpt-5.5" } } },
    });
    expect(await readAgentDefaults(environment)).toEqual(cleared);
    for (const bad of [
      { "claude-code": { model: { id: "has spaces" } } },
      { "../escape": {} },
      { "claude-code": { permissionModeId: "plan", extra: true } },
    ]) {
      expect(rly0AgentDefaultsSetParamsSchema.safeParse({ agents: bad }).success).toBe(false);
    }
  });

  it("treats an absent or corrupt file as unset without throwing or deleting it", async () => {
    const environment = await dataDir();
    expect(await readAgentDefaults(environment)).toBeNull();
    const file = agentDefaultsFile(environment);
    await fs.writeFile(file, "{ not json", "utf8");
    expect(await readAgentDefaults(environment)).toBeNull();
    await fs.writeFile(file, JSON.stringify({ version: 2, updatedAt: 1, agents: {} }), "utf8");
    expect(await readAgentDefaults(environment)).toBeNull();
    expect(await fs.readFile(file, "utf8")).toContain('"version":2');
    // Saving over a corrupt file works and leaves the Codex preferences alone.
    await writeCodexPreferences(environment, { reasoningSoftWrap: false }, () => 3);
    await writeAgentDefaults(environment, agents, () => 4);
    expect((await readAgentDefaults(environment))?.agents).toEqual(agents);
    expect(await readCodexPreferences(environment)).toEqual({
      reasoningSoftWrap: false,
      updatedAt: 3,
    });
  });

  it("adds the defaults to codexPreferences/get only for a renderer that asks", async () => {
    const environment = await dataDir();
    await writeCodexPreferences(environment, { quotaRefresh: "3m" }, () => 2);
    const preferences = await readCodexPreferences(environment);

    // A 0.11.27 renderer sends {} and parses strictly: it gets exactly the old shape.
    const plain = await codexPreferencesGetResult(environment, {});
    expect(plain).toEqual({ preferences });
    expect(legacyGetResultSchema.safeParse(plain).success).toBe(true);

    expect(await codexPreferencesGetResult(environment, { agentDefaults: true })).toEqual({
      preferences,
      agentDefaults: null,
    });
    const saved = await writeAgentDefaults(environment, agents, () => 8);
    const asked = await codexPreferencesGetResult(environment, { agentDefaults: true });
    expect(asked).toEqual({ preferences, agentDefaults: saved });
    expect(rly0CodexPreferencesGetResultSchema.parse(asked)).toEqual(asked);
    expect(rly0CodexPreferencesGetResultSchema.parse(plain)).toEqual(plain);
  });
});
