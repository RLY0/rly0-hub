import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  // The Hub window patrol has its own config (hub-patrol.config.js).
  testIgnore: ["hub-patrol.spec.ts"],
  reporter: "list",
  use: {
    trace: "retain-on-failure",
  },
});
