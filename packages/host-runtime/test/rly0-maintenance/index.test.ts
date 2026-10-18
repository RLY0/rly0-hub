import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  rly0MaintenanceCacheInfoResultSchema,
  rly0MaintenanceClearCacheResultSchema,
  rly0MaintenanceDiagnosticsResultSchema,
  rly0MaintenanceExportDiagnosticsResultSchema,
  rly0MaintenanceProcessActionResultSchema,
} from "@codexhost/shared-contracts";

import {
  Rly0MaintenanceManager,
  rly0MaintenanceRpcError,
  type Rly0CodexProcessControl,
} from "../../src/rly0-maintenance/index.js";

// Diagnostics never reach the network in tests: the endpoint probe is replaced.
const reachable = async () => ({
  url: "https://chatgpt.com/backend-api/codex",
  source: "default" as const,
  providerId: "openai",
  local: false,
  reachable: true,
  httpStatus: 401,
});

describe("Rly0MaintenanceManager", () => {
  let dataDir: string;
  let codexHome: string;
  let environment: NodeJS.ProcessEnv;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-maintenance-data-"));
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-maintenance-home-"));
    environment = { CODEXHOST_DATA_DIR: dataDir, CODEX_HOME: codexHome };
  });

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
    await fs.rm(codexHome, { recursive: true, force: true });
  });

  describe("diagnostics", () => {
    it("collects advice codes for a fully missing CODEX_HOME and unavailable core", async () => {
      const manager = new Rly0MaintenanceManager({
        checkEndpoint: reachable,
        environment: { CODEXHOST_DATA_DIR: dataDir, CODEX_HOME: path.join(codexHome, "missing") },
      });
      const result = rly0MaintenanceDiagnosticsResultSchema.parse(await manager.diagnostics());
      expect(result.core).toEqual({ available: false });
      expect(result.advice).toEqual(
        expect.arrayContaining([
          "CODEX_HOME_MISSING",
          "AUTH_JSON_MISSING",
          "CONFIG_TOML_MISSING",
          "SESSIONS_DIR_MISSING",
          "CORE_UNAVAILABLE",
        ]),
      );
      expect(result.advice).not.toContain("CONFIG_TOML_INVALID");
    });

    it("reports config.toml as invalid distinct from missing, and forwards an available core", async () => {
      await fs.writeFile(path.join(codexHome, "config.toml"), "model = = [broken\n", "utf8");
      const manager = new Rly0MaintenanceManager({
        checkEndpoint: reachable,
        environment,
        core: {
          status: async () => ({
            available: true,
            name: "rly0-core",
            version: "1.0.0",
            capabilities: [],
          }),
        },
      });
      const result = await manager.diagnostics();
      expect(result.advice).toContain("CONFIG_TOML_INVALID");
      expect(result.advice).not.toContain("CONFIG_TOML_MISSING");
      expect(result.advice).not.toContain("CORE_UNAVAILABLE");
      expect(result.core).toEqual({
        available: true,
        name: "rly0-core",
        version: "1.0.0",
        capabilities: [],
      });
    });

    it("flags a Codex endpoint that does not answer", async () => {
      const down = async () => ({
        url: "http://127.0.0.1:17841/v1",
        source: "openai_base_url" as const,
        providerId: "openai",
        local: true,
        reachable: false,
        failure: "REFUSED" as const,
      });
      const launched: string[] = [];
      const manager = new Rly0MaintenanceManager({
        // A home without any known bridge; never the real user profile.
        environment: { ...environment, USERPROFILE: codexHome, LOCALAPPDATA: codexHome },
        checkEndpoint: down,
        launchApp: (app) => launched.push(app.id),
      });
      const result = rly0MaintenanceDiagnosticsResultSchema.parse(await manager.diagnostics());
      expect(result.advice).toContain("CODEX_ENDPOINT_DOWN");
      expect(result.codexEndpoint).toMatchObject({ local: true, reachable: false });
      // Nothing recognized on that port: there is no app to start.
      expect(await manager.startEndpointApp()).toEqual({ ok: false });
      expect(launched).toEqual([]);
    });

    it("never touches auth.json content", async () => {
      await fs.writeFile(path.join(codexHome, "auth.json"), '{"secret":"do-not-read"}', "utf8");
      const manager = new Rly0MaintenanceManager({ checkEndpoint: reachable, environment });
      const result = await manager.diagnostics();
      expect(JSON.stringify(result)).not.toContain("do-not-read");
      expect(result.authJsonExists).toBe(true);
    });
  });

  describe("cacheInfo / clearCache", () => {
    it("reports zero for a nonexistent cache directory", async () => {
      const manager = new Rly0MaintenanceManager({ checkEndpoint: reachable, environment });
      const result = rly0MaintenanceCacheInfoResultSchema.parse(await manager.cacheInfo());
      expect(result.totalBytes).toBe(0);
      expect(result.entries.every((entry) => !entry.exists)).toBe(true);
    });

    it("measures and clears only the known cache subdirectories", async () => {
      const cacheFile = path.join(dataDir, "cache", "nested", "a.bin");
      await fs.mkdir(path.dirname(cacheFile), { recursive: true });
      await fs.writeFile(cacheFile, "hello", "utf8");
      const tmpFile = path.join(dataDir, "tmp", "b.bin");
      await fs.mkdir(path.dirname(tmpFile), { recursive: true });
      await fs.writeFile(tmpFile, "hi", "utf8");
      // A sibling directory outside the known cache entries must survive clearCache.
      const untouched = path.join(dataDir, "diagnostics", "keep.json");
      await fs.mkdir(path.dirname(untouched), { recursive: true });
      await fs.writeFile(untouched, "{}", "utf8");

      const manager = new Rly0MaintenanceManager({ checkEndpoint: reachable, environment });
      const info = await manager.cacheInfo();
      expect(info.totalBytes).toBe(7);

      const cleared = rly0MaintenanceClearCacheResultSchema.parse(await manager.clearCache());
      expect(cleared.clearedBytes).toBe(7);
      expect(cleared.clearedEntries.sort()).toEqual(["cache", "tmp"]);
      await expect(fs.stat(path.join(dataDir, "cache"))).rejects.toThrow();
      await expect(fs.stat(path.join(dataDir, "tmp"))).rejects.toThrow();
      await expect(fs.stat(untouched)).resolves.toBeDefined();
    });
  });

  describe("exportDiagnostics", () => {
    it("writes a JSON file under the diagnostics directory with the home directory redacted, and never leaks config.toml content", async () => {
      await fs.writeFile(
        path.join(codexHome, "config.toml"),
        `# contact admin@example.com\nmodel = "gpt"\n`,
        "utf8",
      );
      const manager = new Rly0MaintenanceManager({
        checkEndpoint: reachable,
        environment,
        now: () => new Date("2026-09-30T01:02:03.000Z"),
      });
      const result = rly0MaintenanceExportDiagnosticsResultSchema.parse(
        await manager.exportDiagnostics(),
      );
      expect(result.filePath).toContain(path.join(dataDir, "diagnostics"));
      expect(result.filePath.endsWith(".json")).toBe(true);
      expect(result.sizeBytes).toBeGreaterThan(0);
      const content = await fs.readFile(result.filePath, "utf8");
      // The health check only ever reports whether config.toml parses, never its content.
      expect(content).not.toContain("admin@example.com");
      const home = os.homedir();
      if (home && codexHome.startsWith(home)) {
        expect(content).not.toContain(home);
        expect(content).toContain("<home>");
      }
      expect(JSON.parse(content)).toMatchObject({ diagnostics: { configTomlParses: true } });
    });
  });

  describe("process control", () => {
    it("reports unsupported when no process control is wired up", async () => {
      const manager = new Rly0MaintenanceManager({ checkEndpoint: reachable, environment });
      expect(
        rly0MaintenanceProcessActionResultSchema.parse(await manager.forceQuitCodex()),
      ).toEqual({ supported: false });
      expect(rly0MaintenanceProcessActionResultSchema.parse(await manager.restartCodex())).toEqual({
        supported: false,
      });
    });

    it("delegates to an injected process control and never spawns a real process", async () => {
      let forceQuitCalls = 0;
      let restartCalls = 0;
      const fake: Rly0CodexProcessControl = {
        forceQuit: async () => {
          forceQuitCalls += 1;
          return true;
        },
        restart: async () => {
          restartCalls += 1;
          return false;
        },
      };
      const manager = new Rly0MaintenanceManager({
        checkEndpoint: reachable,
        environment,
        processControl: fake,
      });
      expect(await manager.forceQuitCodex()).toEqual({ supported: true, ok: true });
      expect(await manager.restartCodex()).toEqual({ supported: true, ok: false });
      expect(forceQuitCalls).toBe(1);
      expect(restartCalls).toBe(1);
    });
  });

  it("maps errors to a fixed code", () => {
    expect(rly0MaintenanceRpcError()).toEqual({
      code: -32000,
      message: "MAINTENANCE_OPERATION_FAILED",
    });
  });
});
