import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { rly0CodexPreferenceValuesSchema } from "@codexhost/shared-contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  readCodexPreferences,
  writeCodexPreferences,
} from "../src/rly0-appearance/codex-preferences.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("Codex preferences file shared by the Hub and the Host", () => {
  it("merges each change, stamps it newer every time and ignores a broken file", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-prefs-"));
    roots.push(root);
    const environment = { CODEXHOST_DATA_DIR: root };
    expect(await readCodexPreferences(environment)).toBeNull();
    const first = await writeCodexPreferences(environment, { reasoningSoftWrap: true }, () => 5);
    expect(first).toEqual({ reasoningSoftWrap: true, updatedAt: 5 });
    // The clock did not move: the stamp still increases so Codex applies the second change.
    const second = await writeCodexPreferences(environment, { accentColor: "green" }, () => 5);
    expect(second).toEqual({ reasoningSoftWrap: true, accentColor: "green", updatedAt: 6 });
    expect(await readCodexPreferences(environment)).toEqual(second);
    await fs.writeFile(path.join(root, "codex-preferences.json"), "{ not json", "utf8");
    expect(await readCodexPreferences(environment)).toBeNull();
  });

  it("saves the new-Thread defaults whole and rejects ids no catalog could hold", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-prefs-"));
    roots.push(root);
    const environment = { CODEXHOST_DATA_DIR: root };
    await writeCodexPreferences(environment, { reasoningSoftWrap: true }, () => 5);
    const saved = await writeCodexPreferences(
      environment,
      rly0CodexPreferenceValuesSchema.parse({
        agentDefaults: {
          "claude-code": { permissionModeId: "plan", model: { id: "opus" } },
          opencode: { model: { id: "gpt-5.5" } },
        },
      }),
      () => 6,
    );
    expect(saved.agentDefaults).toEqual({
      "claude-code": { permissionModeId: "plan", model: { id: "opus" } },
      opencode: { model: { id: "gpt-5.5" } },
    });
    // The Hub sends the whole map: a cleared agent is gone, other preferences stay.
    const cleared = await writeCodexPreferences(
      environment,
      rly0CodexPreferenceValuesSchema.parse({
        agentDefaults: { opencode: { model: { id: "gpt-5.5" } } },
      }),
      () => 7,
    );
    expect(cleared).toEqual({
      reasoningSoftWrap: true,
      agentDefaults: { opencode: { model: { id: "gpt-5.5" } } },
      updatedAt: 7,
    });
    expect(await readCodexPreferences(environment)).toEqual(cleared);
    for (const bad of [
      { "claude-code": { model: { id: "has spaces" } } },
      { "../escape": {} },
      { "claude-code": { permissionModeId: "plan", extra: true } },
    ]) {
      expect(rly0CodexPreferenceValuesSchema.safeParse({ agentDefaults: bad }).success).toBe(false);
    }
  });
});
