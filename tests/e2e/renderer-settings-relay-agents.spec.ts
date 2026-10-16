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
      import { createRelaySettingsPage } from "./packages/renderer-extension/src/settings/relay-page.ts";
      import { createRendererSettingsPageRegistry } from "./packages/renderer-extension/src/settings/core.ts";
      import { rendererSettingsMessages } from "./packages/renderer-extension/src/settings/localization.ts";
      import { mountRendererSettingsShell } from "./packages/renderer-extension/src/settings/shell.ts";

      globalThis.setupRelay = ({ locale = "zh-CN", theme = "dark", scenario = "live" } = {}) => {
        document.documentElement.style.colorScheme = theme;
        const now = Date.now();
        const calls = [];
        let failCheck = scenario === "failing";
        const relay = {
          id:"relay-1",name:"RLY/0 零号中转",baseUrl:"https://api.rly0.com/v1",protocol:"responses",
          models:["claude-opus-5","gpt-5.5","deepseek-*"],enabled:true,hasKey:true,keyMask:"sk-…7f3a",
        };
        const client = {
          listRly0Relays: async () => ({ available:true, relays:[relay] }),
          rly0ProxyStatus: async () => ({ available:true, running:true, port:25817, baseUrl:"http://127.0.0.1:25817/v1", requests:0, routed:0, unrouted:0, failed:0, recent:[] }),
          rly0RelayCodexConfigStatus: async () => ({ configPath:"C:/Users/me/.codex/config.toml", configExists:true, providerPresent:false, applied:false }),
          rly0RelayAgentsGet: async () => ({ claudeCode: globalThis.__agent ?? null, active: { claudeCode: null }, restartRequired: false }),
          rly0RelayAgentsSet: async ({ claudeCode }) => { globalThis.__agent = claudeCode; return { claudeCode, active: { claudeCode: null }, restartRequired: claudeCode !== null }; },
          rly0MaintenanceRestartCodex: async () => ({ supported: true, ok: true }),
          rly0RelayModelCatalogStatus: async (input = {}) => {
            calls.push(input);
            if (scenario === "unread" && !input.refresh) return { official:null, appended:["claude-opus-5"], shadowed:["gpt-5.5"] };
            if (input.refresh && failCheck) {
              return { official: scenario === "failing" ? { fetchedAt: now - 42*60000, count: 11, via:"codex" } : null,
                lastError:{ at: Date.now(), message:"OFFICIAL_CATALOG_FAILED" }, appended:["claude-opus-5"], shadowed:["gpt-5.5"] };
            }
            return {
              official: input.refresh ? { fetchedAt: Date.now(), count: 12, via:"hub" } : { fetchedAt: now - 3*60000, count: 11, via:"codex" },
              appended:["claude-opus-5"], shadowed:["gpt-5.5"],
            };
          },
        };
        globalThis.relayFixture = { calls };
        const messages = rendererSettingsMessages(locale);
        const registry = createRendererSettingsPageRegistry([createRelaySettingsPage(messages, () => client)]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "relay");
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-relay-agents-e2e-entry.ts",
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
if (!bundle) throw new Error("Relay settings fixture bundle missing");

async function setup(page: Page, options = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/relay-agents-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/relay-agents-test");
  await page.clock.install({ time: new Date("2026-10-16T08:20:00Z") });
  await page.clock.pauseAt(new Date("2026-10-16T08:20:00Z"));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupRelay")(options), options);
}

for (const theme of ["dark", "light"] as const) {
  test(`Claude Code can be pointed at a relay, with a restart prompt (${theme})`, async ({
    page,
  }, testInfo) => {
    await setup(page, { theme });
    const card = page.locator(".settings-rly0-relay__agents");
    await expect(card.getByRole("heading", { name: "原生 Agent 使用中转" })).toBeVisible();
    const select = card.getByRole("combobox", { name: "Claude Code" });
    await expect(select).toHaveValue("");
    await card.screenshot({ path: testInfo.outputPath(`agents-default-${theme}.png`) });
    await select.selectOption({ label: "RLY/0 零号中转" });
    await expect(card).toContainText("重启 Codex 后，新的 Claude Code 对话按这个选择运行");
    await card.screenshot({ path: testInfo.outputPath(`agents-relay-${theme}.png`) });
    await card.getByRole("button", { name: "立即重启 Codex" }).click();
    await expect(card.getByRole("button", { name: "正在重启 Codex…" })).toBeDisabled();
  });
}
