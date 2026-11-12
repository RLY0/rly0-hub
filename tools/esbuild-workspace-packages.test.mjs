import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { workspacePackageDirectories } from "./esbuild-workspace-packages.mjs";

it("resolves fixed and nested Web workspaces to their own package directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workspace-packages-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ workspaces: ["packages/*", "apps/web-ui", "apps/web-ui/packages/*/*"] }),
    );
    const packages = {
      "packages/host-runtime": "@codexhost/host-runtime",
      "apps/web-ui": "@codexhost/web-ui",
      "apps/web-ui/packages/client/core": "@codexhost/web-core",
      "apps/web-ui/packages/client/vendor": "third-party",
    };
    for (const [relative, name] of Object.entries(packages)) {
      const directory = path.join(root, relative);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), JSON.stringify({ name }));
    }
    const resolved = await workspacePackageDirectories(root);
    expect([...resolved.keys()].sort()).toEqual([
      "@codexhost/host-runtime",
      "@codexhost/web-core",
      "@codexhost/web-ui",
    ]);
    for (const [relative, name] of Object.entries(packages)) {
      if (name.startsWith("@codexhost/")) expect(resolved.get(name)).toBe(path.join(root, relative));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
