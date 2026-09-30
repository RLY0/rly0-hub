import { describe, expect, it } from "vitest";

import {
  rly0AccountIdSchema,
  rly0AccountsImportCurrentParamsSchema,
  rly0AccountsListResultSchema,
  rly0AccountsRemoveParamsSchema,
  rly0AccountsRenameParamsSchema,
  rly0AccountsSwitchParamsSchema,
  rly0AliasSchema,
  rly0CoreStatusResultSchema,
} from "../src/rly0-core.js";

describe("rly0AccountIdSchema", () => {
  it("accepts exactly 12 lowercase hex characters", () => {
    expect(rly0AccountIdSchema.safeParse("abcdef012345").success).toBe(true);
  });

  it.each([
    ["too short", "abc123"],
    ["too long", "abcdef0123456"],
    ["uppercase", "ABCDEF012345"],
    ["non-hex", "zzzzzzzzzzzz"],
    ["empty", ""],
  ])("rejects %s", (_name, value) => {
    expect(rly0AccountIdSchema.safeParse(value).success).toBe(false);
  });
});

describe("rly0AliasSchema", () => {
  it("trims and accepts 1..40 characters", () => {
    const parsed = rly0AliasSchema.safeParse("  work  ");
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe("work");
  });

  it("rejects an empty (or whitespace-only) alias", () => {
    expect(rly0AliasSchema.safeParse("").success).toBe(false);
    expect(rly0AliasSchema.safeParse("   ").success).toBe(false);
  });

  it("rejects an alias longer than 40 characters", () => {
    expect(rly0AliasSchema.safeParse("a".repeat(41)).success).toBe(false);
  });
});

describe("rly0 params schemas reject malformed input", () => {
  it("accounts/switch requires a valid id", () => {
    expect(rly0AccountsSwitchParamsSchema.safeParse({ id: "not-hex" }).success).toBe(false);
    expect(rly0AccountsSwitchParamsSchema.safeParse({ id: "abcdef012345" }).success).toBe(true);
  });

  it("accounts/rename requires both a valid id and a non-blank alias", () => {
    expect(
      rly0AccountsRenameParamsSchema.safeParse({ id: "abcdef012345", alias: "" }).success,
    ).toBe(false);
    expect(
      rly0AccountsRenameParamsSchema.safeParse({ id: "bad", alias: "ok" }).success,
    ).toBe(false);
    expect(
      rly0AccountsRenameParamsSchema.safeParse({ id: "abcdef012345", alias: "ok" }).success,
    ).toBe(true);
  });

  it("accounts/remove requires a valid id", () => {
    expect(rly0AccountsRemoveParamsSchema.safeParse({ id: "abcdef012345" }).success).toBe(true);
    expect(rly0AccountsRemoveParamsSchema.safeParse({}).success).toBe(false);
  });

  it("accounts/importCurrent accepts an optional alias but rejects a blank one", () => {
    expect(rly0AccountsImportCurrentParamsSchema.safeParse({}).success).toBe(true);
    expect(rly0AccountsImportCurrentParamsSchema.safeParse({ alias: "mine" }).success).toBe(true);
    expect(rly0AccountsImportCurrentParamsSchema.safeParse({ alias: "" }).success).toBe(false);
  });

  it("rejects unknown extra fields (strict objects)", () => {
    expect(
      rly0AccountsSwitchParamsSchema.safeParse({ id: "abcdef012345", extra: true }).success,
    ).toBe(false);
  });
});

describe("rly0 result schemas", () => {
  it("accepts the unavailable variant of core/status", () => {
    expect(rly0CoreStatusResultSchema.safeParse({ available: false }).success).toBe(true);
  });

  it("accepts the available variant of core/status", () => {
    expect(
      rly0CoreStatusResultSchema.safeParse({
        available: true,
        name: "rly0-core",
        version: "1.0.0",
        capabilities: ["accounts"],
      }).success,
    ).toBe(true);
  });

  it("rejects accounts/list with a non-empty accounts array while unavailable", () => {
    expect(
      rly0AccountsListResultSchema.safeParse({
        available: false,
        accounts: [{ id: "abcdef012345", current: true }],
      }).success,
    ).toBe(false);
  });
});
