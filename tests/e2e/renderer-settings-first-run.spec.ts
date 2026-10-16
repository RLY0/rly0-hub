import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

import { tailwindEsbuildPlugin } from "../../packages/renderer-extension/scripts/tailwind-esbuild-plugin.mjs";

test.use({ timezoneId: "Asia/Shanghai" });
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import { createDashboardSettingsPage } from "./packages/renderer-extension/src/settings/dashboard-page.ts";
      import { createMaintenanceSettingsPage } from "./packages/renderer-extension/src/settings/maintenance-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupFirstRun = ({ theme = "dark", page = "dashboard" } = {}) => {
        document.documentElement.style.colorScheme = theme;
        const client = {
          rly0MaintenanceBackupStatus: async () => ({
            available: true, codexHome: "C:/Users/me/.codex", createdAt: 1792137600,
            files: [{ name: "config.toml", existed: true }, { name: "AGENTS.md", existed: false }],
          }),
          rly0MaintenanceRestoreBackup: async () => ({
            ok: true, restored: ["config.toml"], removed: ["AGENTS.md"],
            safetyBackupDir: "C:/Users/me/.rly0-hub/backups/before-restore-2026-10-16", backendReload: "reloaded",
          }),
          rly0MaintenanceDiagnostics: async () => ({
            generatedAt: "2026-10-16T08:20:00.000Z", codexHome: "C:/Users/me/.codex", codexHomeExists: true,
            authJsonExists: true, configTomlExists: true, configTomlParses: true, sessionsDirExists: true,
            core: { available: true }, advice: [],
          }),
          rly0MaintenanceCacheInfo: async () => ({ entries: [], totalBytes: 0 }),
          rly0MaintenanceRestartCodex: async () => ({ supported: true, ok: true }),
          rly0MaintenanceForceQuitCodex: async () => ({ supported: true, ok: true }),
        };
        const messages = rendererSettingsMessages("zh-CN");
        const registry = createRendererSettingsPageRegistry([
          createDashboardSettingsPage(messages, () => client),
          createMaintenanceSettingsPage(messages, () => client),
        ]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, page);
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-first-run-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2024",
  loader: { ".css": "text", ".png": "dataurl", ".svg": "dataurl", ".jpg": "dataurl" },
  plugins: [tailwindEsbuildPlugin()],
  write: false,
});
const bundle = outputFiles[0]?.text ?? "";
if (!bundle) throw new Error("First-run fixture bundle missing");

async function setup(page: Page, options = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/first-run-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/first-run-test");
  await page.clock.install({ time: new Date("2026-10-16T08:20:00Z") });
  await page.clock.pauseAt(new Date("2026-10-16T08:20:00Z"));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupFirstRun")(options), options);
}

for (const theme of ["dark", "light"] as const) {
  test(`welcome card guides a new user and can be dismissed for good (${theme})`, async ({
    page,
  }, testInfo) => {
    await setup(page, { theme });
    const welcome = page.locator(".settings-rly0-welcome");
    await expect(welcome.getByRole("heading", { name: "欢迎使用 RLY/0 Hub" })).toBeVisible();
    await expect(welcome.locator(".settings-rly0-welcome__step")).toHaveCount(5);
    await welcome.screenshot({ path: testInfo.outputPath(`welcome-${theme}.png`) });

    await welcome.getByRole("button", { name: "知道了，不再显示" }).click();
    await expect(welcome).toHaveCount(0);
    await page.reload();
    await page.clock.install({ time: new Date("2026-10-16T08:20:00Z") });
    await page.addScriptTag({ content: bundle });
    await page.evaluate((options) => Reflect.get(globalThis, "setupFirstRun")(options), { theme });
    await expect(page.locator(".settings-rly0-welcome")).toHaveCount(0);
  });
}

test("welcome card buttons open the right pages", async ({ page }) => {
  await setup(page);
  await page.locator(".settings-rly0-welcome").getByRole("button", { name: "查看" }).click();
  await expect(page.getByRole("heading", { name: "还原 Codex 设置" })).toBeVisible();
});

test("maintenance shows the saved settings copy and restores it after confirmation", async ({
  page,
}, testInfo) => {
  await setup(page, { page: "maintenance" });
  const section = page.locator(".settings-rly0-maintenance__restore");
  await expect(section).toContainText("config.toml");
  await expect(section).toContainText("AGENTS.md（当时不存在，还原时会删除）");
  await section.scrollIntoViewIfNeeded();
  await section.screenshot({ path: testInfo.outputPath("restore-section.png") });
  await section.getByRole("button", { name: "还原已保存的设置" }).click();
  const dialog = page.locator("dialog.settings-credential-dialog");
  await expect(dialog).toContainText("还原前会先另存一份当前文件");
  await page.screenshot({ path: testInfo.outputPath("restore-dialog.png") });
  await dialog.getByRole("button", { name: "还原", exact: true }).click();
  await expect(section).toContainText("已还原，Codex 已在使用还原后的设置");
  await section.screenshot({ path: testInfo.outputPath("restore-done.png") });
});
