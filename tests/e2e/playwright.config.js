import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // The Hub window patrol and the macOS Hub bench have their own configs.
  testIgnore: ["hub-patrol.spec.ts", "hub-bench.spec.ts"],
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
