import { defineConfig } from "@playwright/test";
import path from "node:path";

// Functional bench of the macOS RLY/0 Hub (tests/e2e/hub-bench/): the pages of a built
// `RLY0 Hub.app` in WebKit, each test with its own real Hub service in a sandbox (fresh
// synthetic HOME, throwaway Keychain, no reach to the live Codex/Hub/Core). macOS only.
//   HUB_BENCH_APP=<path to RLY0 Hub.app> npx playwright test --config tests/e2e/hub-bench.config.js
if (!process.env.HUB_BENCH_RUN) {
  const stamp = new Date().toISOString().replace(/[-:]/gu, "").replace(/\..*$/u, "");
  process.env.HUB_BENCH_RUN = path.resolve(import.meta.dirname, "../../.local-test/bench", stamp);
}

export default defineConfig({
  testDir: ".",
  testMatch: /hub-bench\.spec\.ts$/u,
  reporter: [
    ["list"],
    ["json", { outputFile: path.join(process.env.HUB_BENCH_RUN, "report.json") }],
  ],
  timeout: 180_000,
  workers: Number(process.env.HUB_BENCH_WORKERS || 3),
  fullyParallel: true,
  globalSetup: "./hub-bench/guard.mjs",
  outputDir: path.join(process.env.HUB_BENCH_RUN, "test-results"),
  use: {
    browserName: "webkit",
    locale: "zh-CN",
    viewport: { width: 1240, height: 820 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
  },
});
