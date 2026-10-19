import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  checkCodexModel,
  rejectedModel,
  setCodexModel,
} from "../src/rly0-maintenance/codex-model.js";

const REFUSAL =
  '{"detail":"The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account."}';

const turn = (at: string, error: string | null) =>
  JSON.stringify({
    timestamp: at,
    type: "event_msg",
    payload: { type: "task_complete", ...(error ? { error: { message: error } } : {}) },
  });

function makeHome(config = 'model = "gpt-6.1-sol"\n\n[features]\nx = true\n'): string {
  const home = mkdtempSync(path.join(os.tmpdir(), "rly0-codex-model-"));
  writeFileSync(path.join(home, "config.toml"), config);
  writeFileSync(
    path.join(home, "models_cache.json"),
    JSON.stringify({
      models: [
        { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
        { slug: "gpt-6-sol", display_name: "GPT-6-Sol", visibility: "list" },
        { slug: "gpt-reserve", display_name: "Hidden", visibility: "hide" },
      ],
    }),
  );
  return home;
}

function writeSession(home: string, day: string, name: string, lines: string[], mtime: number) {
  const directory = path.join(home, "sessions", "2026", "10", day);
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  utimesSync(file, mtime, mtime);
}

describe("Codex model check", () => {
  it("names the model in a refusal", () => {
    expect(rejectedModel(REFUSAL)).toBe("gpt-6.1-sol");
    expect(rejectedModel("model_not_found")).toBeNull();
    expect(rejectedModel("stream disconnected before completion")).toBeUndefined();
  });

  it("reports when the newest task was refused because of its model", async () => {
    const home = makeHome();
    writeSession(home, "14", "rollout-a.jsonl", [turn("2026-10-14T08:00:00.000Z", null)], 1);
    writeSession(
      home,
      "19",
      "rollout-b.jsonl",
      ['{"cut in half', turn("2026-10-19T08:07:21.104Z", REFUSAL)],
      2,
    );
    const result = await checkCodexModel(home);
    expect(result.configModel).toBe("gpt-6.1-sol");
    expect(result.rejection).toEqual({
      model: "gpt-6.1-sol",
      at: "2026-10-19T08:07:21.104Z",
      message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
    });
    expect(result.choices).toEqual([{ slug: "gpt-6-sol", name: "GPT-6-Sol" }]);
  });

  it("stays quiet once a later task went through", async () => {
    const home = makeHome();
    writeSession(
      home,
      "19",
      "rollout-b.jsonl",
      [turn("2026-10-19T08:07:21.104Z", REFUSAL), turn("2026-10-19T09:00:00.000Z", null)],
      2,
    );
    expect((await checkCodexModel(home)).rejection).toBeNull();
  });

  it("changes only the model line and keeps a backup", async () => {
    const home = makeHome('# mine\r\nmodel = "gpt-6.1-sol"\r\nmodel_provider = "openai"\r\n');
    const result = await setCodexModel(home, "gpt-6-sol", () => new Date(0));
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(home, "config.toml"), "utf8")).toBe(
      '# mine\r\nmodel = "gpt-6-sol"\r\nmodel_provider = "openai"\r\n',
    );
    expect(readFileSync(result.backupPath!, "utf8")).toContain('model = "gpt-6.1-sol"');
  });

  it("adds a model line above the first table when there is none", async () => {
    const home = makeHome('[features]\nmodel = "not-top-level"\n');
    expect((await setCodexModel(home, "gpt-6-sol")).ok).toBe(true);
    expect(readFileSync(path.join(home, "config.toml"), "utf8")).toBe(
      'model = "gpt-6-sol"\n[features]\nmodel = "not-top-level"\n',
    );
  });

  it("refuses models Codex does not list, and profile-set models", async () => {
    const home = makeHome();
    expect(await setCodexModel(home, "gpt-reserve")).toEqual({
      ok: false,
      reason: "UNKNOWN_MODEL",
    });
    const profiled = makeHome('profile = "p"\n[profiles.p]\nmodel = "gpt-6.1-sol"\n');
    expect(await setCodexModel(profiled, "gpt-6-sol")).toEqual({
      ok: false,
      reason: "PROFILE_MODEL",
    });
    expect(readdirSync(profiled).some((n) => n.includes(".bak-"))).toBe(false);
  });
});
