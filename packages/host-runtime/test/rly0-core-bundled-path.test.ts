import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildSync } from "esbuild";
import { describe, expect, it } from "vitest";

function bundledResolver(platform: "darwin" | "win32" = "darwin") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rly0-core-layout-")));
  const resources = path.join(root, "RLY0 Hub.app", "Contents", "Resources");
  const bundle = path.join(resources, "app", "host-runtime.mjs");
  const coreName = platform === "win32" ? "rly0-core.exe" : "rly0-core";
  buildSync({
    entryPoints: [fileURLToPath(new URL("../src/rly0-core/client.ts", import.meta.url))],
    outfile: bundle,
    bundle: true,
    platform: "node",
    format: "esm",
    define: {
      "process.execPath": JSON.stringify(path.join(root, "external-node", "node")),
      "process.platform": JSON.stringify(platform),
    },
  });
  return {
    core: path.join(resources, "runtime", coreName),
    legacyCore: path.join(root, "RLY0 Hub.app", "Contents", coreName),
    override: path.join(root, "override", coreName),
    resolve(environment: Record<string, string> = {}): string | null {
      const script = `import { resolveRly0CoreBinaryPath } from ${JSON.stringify(pathToFileURL(bundle).href)}; process.stdout.write(JSON.stringify(resolveRly0CoreBinaryPath(${JSON.stringify(environment)})));`;
      return JSON.parse(
        execFileSync(process.execPath, ["--input-type=module", "-e", script], {
          encoding: "utf8",
          timeout: 10_000,
          env: {},
        }),
      ) as string | null;
    },
    create(file: string) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, "synthetic core path fixture");
    },
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("bundled RLY/0 Core discovery with an external Node runtime", () => {
  it.each(["darwin", "win32"] as const)("finds the packaged %s Core", (platform) => {
    const layout = bundledResolver(platform);
    try {
      layout.create(layout.core);
      expect(layout.resolve()).toBe(layout.core);
    } finally {
      layout.dispose();
    }
  });

  it("keeps an explicit Core override ahead of the packaged Core", () => {
    const layout = bundledResolver();
    try {
      layout.create(layout.core);
      layout.create(layout.override);
      expect(layout.resolve({ RLY0_CORE_PATH: layout.override })).toBe(layout.override);
    } finally {
      layout.dispose();
    }
  });

  it("retains the legacy bundle fallback", () => {
    const layout = bundledResolver();
    try {
      layout.create(layout.legacyCore);
      expect(layout.resolve()).toBe(layout.legacyCore);
    } finally {
      layout.dispose();
    }
  });

  it("reports unavailable when every candidate is missing", () => {
    const layout = bundledResolver();
    try {
      expect(layout.resolve()).toBeNull();
    } finally {
      layout.dispose();
    }
  });
});
