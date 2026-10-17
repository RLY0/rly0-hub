import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  composeInstructions,
  RLY0_INSTRUCTIONS_END,
  RLY0_INSTRUCTIONS_START,
  Rly0InstructionsManager,
} from "../src/rly0-instructions/index.js";

let directory: string | undefined;
afterEach(async () => {
  if (directory) await fs.rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function setup(initial?: string) {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-instructions-"));
  const codexHome = path.join(directory, "codex");
  await fs.mkdir(codexHome, { recursive: true });
  const file = path.join(codexHome, "AGENTS.md");
  if (initial !== undefined) await fs.writeFile(file, initial, "utf8");
  let now = 1_800_000_000;
  const manager = new Rly0InstructionsManager({
    environment: { CODEX_HOME: codexHome, CODEXHOST_DATA_DIR: path.join(directory, "hub") },
    now: () => now++,
  });
  return { manager, file };
}

describe("Global custom instructions", () => {
  it("only changes its own block and keeps everything else byte for byte", async () => {
    const mine = "# My rules\r\n\r\nNever push on Fridays.\r\n";
    const { manager, file } = await setup(mine);
    await manager.apply("用中文回答。", "chinese");
    const written = await fs.readFile(file, "utf8");
    expect(written.startsWith(mine)).toBe(true);
    expect(written).toContain(`${RLY0_INSTRUCTIONS_START}\n用中文回答。\n${RLY0_INSTRUCTIONS_END}`);

    await manager.apply("先计划再动手。");
    expect(await fs.readFile(file, "utf8")).toBe(
      `${mine}\n${RLY0_INSTRUCTIONS_START}\n先计划再动手。\n${RLY0_INSTRUCTIONS_END}\n`,
    );
    await manager.clear();
    expect((await fs.readFile(file, "utf8")).trimEnd()).toBe(mine.trimEnd());
  });

  it("creates the file when there is none, and previews without writing", async () => {
    const { manager, file } = await setup();
    expect(await manager.preview("A")).toEqual({ current: "", next: "A" });
    await expect(fs.access(file)).rejects.toThrow();
    const state = await manager.apply("A");
    expect(state).toMatchObject({ managed: true, content: "A", fileExists: true });
  });

  it("keeps a short history that can be rolled back", async () => {
    const { manager } = await setup("");
    await manager.apply("one");
    await manager.apply("two");
    const before = await manager.state();
    expect(before.history.map((h) => h.preview)).toEqual(["two", "one"]);
    const target = before.history[1];
    if (!target) throw new Error("missing history");
    const after = await manager.rollback(target.id);
    expect(after.content).toBe("one");
    expect(after.history[0]).toMatchObject({ action: "rollback", preview: "one" });
    for (let i = 0; i < 12; i += 1) await manager.apply(`v${i}`);
    expect((await manager.state()).history).toHaveLength(10);
  });

  it("refuses to write when its markers are damaged, and leaves other tools' blocks alone", async () => {
    const damaged = `${RLY0_INSTRUCTIONS_START}\nhalf\n`;
    const { manager, file } = await setup(damaged);
    expect((await manager.state()).protected).toBe(true);
    await expect(manager.apply("x")).rejects.toThrow("INSTRUCTIONS_MARKERS_DAMAGED");
    expect(await fs.readFile(file, "utf8")).toBe(damaged);

    const aimami =
      "<!-- AIMAMI_CUSTOM_INSTRUCTIONS_START -->\nkeep\n<!-- AIMAMI_CUSTOM_INSTRUCTIONS_END -->\n";
    expect(composeInstructions(aimami, "mine")).toContain(aimami);
    await fs.writeFile(file, aimami, "utf8");
    expect((await manager.state()).otherBlocks).toEqual(["AiMaMi"]);
    await expect(manager.apply(`x ${RLY0_INSTRUCTIONS_END}`)).rejects.toThrow(
      "INSTRUCTIONS_CONTENT_REJECTED",
    );
  });
});
