import { describe, expect, it } from "vitest";

import {
  rly0MaintenanceCacheInfoResultSchema,
  rly0MaintenanceClearCacheResultSchema,
  rly0MaintenanceDiagnosticsResultSchema,
  rly0MaintenanceExportDiagnosticsResultSchema,
  rly0MaintenanceProcessActionResultSchema,
} from "../src/rly0-maintenance.js";
import {
  rly0AppearanceAutostartResultSchema,
  rly0AppearanceAutostartSetParamsSchema,
} from "../src/rly0-appearance.js";

describe("rly0MaintenanceDiagnosticsResultSchema", () => {
  it("accepts a full diagnostics result", () => {
    expect(
      rly0MaintenanceDiagnosticsResultSchema.safeParse({
        generatedAt: "2026-09-30T00:00:00.000Z",
        codexHome: "~/.codex",
        codexHomeExists: true,
        authJsonExists: true,
        configTomlExists: true,
        configTomlParses: true,
        sessionsDirExists: true,
        core: { available: false },
        advice: [],
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown advice code", () => {
    expect(
      rly0MaintenanceDiagnosticsResultSchema.safeParse({
        generatedAt: "2026-09-30T00:00:00.000Z",
        codexHome: "~/.codex",
        codexHomeExists: false,
        authJsonExists: false,
        configTomlExists: false,
        configTomlParses: null,
        sessionsDirExists: false,
        core: { available: false },
        advice: ["NOT_A_REAL_CODE"],
      }).success,
    ).toBe(false);
  });
});

describe("rly0MaintenanceExportDiagnosticsResultSchema", () => {
  it("accepts a file path and non-negative size", () => {
    expect(
      rly0MaintenanceExportDiagnosticsResultSchema.safeParse({
        filePath: "~/.rly0-hub/diagnostics/rly0-diag-20260930.json",
        sizeBytes: 1024,
      }).success,
    ).toBe(true);
  });

  it("rejects a negative size", () => {
    expect(
      rly0MaintenanceExportDiagnosticsResultSchema.safeParse({
        filePath: "x",
        sizeBytes: -1,
      }).success,
    ).toBe(false);
  });
});

describe("rly0MaintenanceCacheInfoResultSchema / rly0MaintenanceClearCacheResultSchema", () => {
  it("accepts a list of cache entries", () => {
    expect(
      rly0MaintenanceCacheInfoResultSchema.safeParse({
        entries: [{ name: "cache", exists: true, sizeBytes: 10, fileCount: 2 }],
        totalBytes: 10,
      }).success,
    ).toBe(true);
  });

  it("accepts a clear-cache result", () => {
    expect(
      rly0MaintenanceClearCacheResultSchema.safeParse({
        clearedBytes: 10,
        clearedEntries: ["cache"],
      }).success,
    ).toBe(true);
  });
});

describe("rly0MaintenanceProcessActionResultSchema", () => {
  it("accepts the unsupported variant without an ok field", () => {
    expect(rly0MaintenanceProcessActionResultSchema.safeParse({ supported: false }).success).toBe(
      true,
    );
    expect(
      rly0MaintenanceProcessActionResultSchema.safeParse({ supported: false, ok: true }).success,
    ).toBe(false);
  });

  it("accepts the supported variant with an ok flag", () => {
    expect(
      rly0MaintenanceProcessActionResultSchema.safeParse({ supported: true, ok: true }).success,
    ).toBe(true);
  });
});

describe("rly0 appearance autostart schemas", () => {
  it("accepts a get result", () => {
    expect(
      rly0AppearanceAutostartResultSchema.safeParse({ supported: true, enabled: false }).success,
    ).toBe(true);
  });

  it("requires a boolean enabled flag on set params", () => {
    expect(rly0AppearanceAutostartSetParamsSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(rly0AppearanceAutostartSetParamsSchema.safeParse({}).success).toBe(false);
  });
});
