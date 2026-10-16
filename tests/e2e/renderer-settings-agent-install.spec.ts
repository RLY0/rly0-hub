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
      import { createConnectionsSettingsPage } from "./packages/renderer-extension/src/settings/connections-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupInstall = ({ theme = "dark", outcome = "succeeded" } = {}) => {
        document.documentElement.style.colorScheme = theme;
        let polls = 0;
        const diagnostics = {
          snapshot: () => ({
            adapter: { state: "ready", reason: "ready", modelUpdates: 1, hook: "request-bridge" },
            hosts: [{ hostId: "local", active: true, agents: [
              { agent: "claude-code", availability: "notInstalled", error: null },
              { agent: "opencode", availability: "notInstalled", error: null },
            ] }],
          }),
          refresh: async () => undefined,
          subscribe: () => () => undefined,
          installAgent: async () => ({ state: "running", automatic: true, step: "officialInstaller", startedAt: Date.now() }),
          installStatus: async () => {
            polls += 1;
            if (polls < 3) return { state: "running", automatic: true, step: polls < 2 ? "officialInstaller" : "npmMirror", startedAt: Date.now() - 42000 };
            return outcome === "succeeded"
              ? { state: "succeeded", automatic: true, canOpenLogin: true }
              : { state: "failed", automatic: true, error: "NETWORK", log: ["Invoke-RestMethod : Unable to connect to the remote server", "npm ERR! network request to https://registry.npmjs.org failed, reason: ETIMEDOUT"].join(String.fromCharCode(10)) };
          },
          openAgentLogin: async () => true,
        };
        const messages = rendererSettingsMessages("zh-CN");
        const registry = createRendererSettingsPageRegistry([createConnectionsSettingsPage(messages, () => diagnostics)]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "connections");
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-install-e2e-entry.ts",
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
if (!bundle) throw new Error("Install fixture bundle missing");

async function setup(page: Page, options = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/install-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/install-test");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupInstall")(options), options);
}

for (const outcome of ["succeeded", "failed"] as const) {
  test(`one-click install shows progress and the outcome (${outcome})`, async ({
    page,
  }, testInfo) => {
    await setup(page, { outcome });
    const row = page.locator(".settings-connection-install-link").first();
    await expect(row).toContainText("一键安装");
    await page.screenshot({ path: testInfo.outputPath(`install-row-${outcome}.png`) });
    await row.click();
    const panel = page.locator(".settings-harness-installation-auto");
    await expect(panel).toContainText("正在运行官方安装程序");
    await page.screenshot({ path: testInfo.outputPath(`install-running-${outcome}.png`) });
    if (outcome === "succeeded") {
      await expect(panel).toContainText("下一步：登录 Claude Code", { timeout: 10_000 });
    } else {
      await expect(panel).toContainText("连不上下载服务器", { timeout: 10_000 });
      await panel.getByText("安装日志").click();
    }
    await page.screenshot({ path: testInfo.outputPath(`install-${outcome}.png`) });
  });
}
