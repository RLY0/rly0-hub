import { describe, expect, it } from "vitest";
import { rly0SkillEntrySchema, rly0SkillBackupEntrySchema } from "../src/rly0-skills.js";
import { rly0McpServerSchema } from "../src/rly0-mcp.js";

describe.each([
  { name: "skill", schema: rly0SkillEntrySchema, entry: { name: "synthetic" } },
  {
    name: "backup",
    schema: rly0SkillBackupEntrySchema,
    entry: { name: "synthetic", backupId: "synthetic-20200102T030405006Z" },
  },
  {
    name: "MCP",
    schema: rly0McpServerSchema,
    entry: { name: "synthetic", type: "stdio", enabled: true },
  },
])("$name addedAt contract", ({ schema, entry }) => {
  it("remains optional for old results", () => {
    expect(schema.safeParse(entry).success).toBe(true);
  });
  it.each([0, 1700000000000])("accepts nonnegative integer %s", (addedAt) => {
    expect(schema.safeParse({ ...entry, addedAt }).success).toBe(true);
  });
  it.each([-1, 1.5, NaN, Infinity, "1700000000000", null])(
    "rejects invalid timestamp %s",
    (addedAt) => {
      expect(schema.safeParse({ ...entry, addedAt }).success).toBe(false);
    },
  );
});
