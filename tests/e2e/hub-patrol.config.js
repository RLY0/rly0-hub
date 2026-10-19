import { defineConfig } from "@playwright/test";
import path from "node:path";

// Tier A UI patrol of the RLY/0 Hub window (apps/hub-desktop/www) in mock mode.
// One run folder per invocation; workers inherit it through the environment.
const port = Number(process.env.HUB_PATROL_PORT || 47317);
if (!process.env.HUB_PATROL_RUN) {
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "");
  process.env.HUB_PATROL_RUN = path.resolve(import.meta.dirname, "../../.local-test/patrol", stamp);
}

export default defineConfig({
  testDir: ".",
  testMatch: /hub-patrol\.spec\.ts$/u,
  reporter: "list",
  timeout: 300_000,
  fullyParallel: true,
  outputDir: path.join(process.env.HUB_PATROL_RUN, "test-results"),
  globalTeardown: "./hub-patrol/report.mjs",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    locale: "zh-CN",
    trace: "retain-on-failure",
    actionTimeout: 5000,
    navigationTimeout: 15000,
  },
  webServer: {
    command: `node tests/e2e/hub-patrol/server.mjs ${port}`,
    cwd: path.resolve(import.meta.dirname, "../.."),
    url: `http://127.0.0.1:${port}/index.html`,
    reuseExistingServer: false,
    timeout: 20_000,
  },
});
