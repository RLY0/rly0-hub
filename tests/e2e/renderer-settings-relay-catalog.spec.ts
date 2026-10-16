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
          rly0RelayModelCatalogStatus: async (input = {}) => {
            calls.push(input);
            if (scenario === "unread" && !input.refresh) return { official:null, appended: ["gpt-relay-1"], shadowed:["gpt-5.5"], delegated:["claude-opus-4-7"] };
            if (input.refresh && failCheck) {
              return { official: scenario === "failing" ? { fetchedAt: now - 42*60000, count: 11, via:"codex" } : null,
                lastError:{ at: Date.now(), message:"OFFICIAL_CATALOG_FAILED" }, appended: ["gpt-relay-1"], shadowed:["gpt-5.5"], delegated:["claude-opus-4-7"] };
            }
            return {
              official: input.refresh ? { fetchedAt: Date.now(), count: 12, via:"hub" } : { fetchedAt: now - 3*60000, count: 11, via:"codex" },
              appended: ["gpt-relay-1"], shadowed:["gpt-5.5"], delegated:["claude-opus-4-7"],
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
    sourcefile: "settings-relay-catalog-e2e-entry.ts",
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
  await page.route("http://localhost/relay-test", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body></body></html>",
    }),
  );
  await page.goto("http://localhost/relay-test");
  await page.clock.install({ time: new Date("2026-10-16T08:20:00Z") });
  await page.clock.pauseAt(new Date("2026-10-16T08:20:00Z"));
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupRelay")(options), options);
}

const card = ".settings-rly0-relay__catalog";

for (const theme of ["dark", "light"] as const) {
  test(`shows the live official catalog and checks it on demand (${theme})`, async ({
    page,
  }, testInfo) => {
    await setup(page, { theme });
    const catalog = page.locator(card);
    await expect(catalog.getByRole("heading", { name: "模型菜单" })).toBeVisible();
    await expect(catalog).toContainText("官方实时列表");
    await expect(catalog).toContainText("11");
    await expect(catalog).toContainText("3 分钟前");
    await expect(catalog).toContainText("追加在末尾的中转模型：gpt-relay-1");
    await expect(catalog).toContainText("与官方模型同名，按官方处理：gpt-5.5");
    await catalog.scrollIntoViewIfNeeded();
    await catalog.screenshot({ path: testInfo.outputPath(`catalog-${theme}.png`) });
    await page.screenshot({ path: testInfo.outputPath(`relay-page-${theme}.png`), fullPage: true });

    await catalog.getByRole("button", { name: "重新检查" }).click();
    await expect(catalog).toContainText("12");
    await expect(catalog).toContainText("RLY/0 Hub 检查");
    expect(await page.evaluate(() => Reflect.get(globalThis, "relayFixture").calls)).toEqual([
      {},
      { refresh: true },
    ]);
  });
}

test("says plainly when the list was never read and when a check fails", async ({
  page,
}, testInfo) => {
  await setup(page, { scenario: "unread" });
  const catalog = page.locator(card);
  await expect(catalog).toContainText("尚未读取");
  await expect(catalog).toContainText("本次启动后 Codex 还没读取官方列表");
  await catalog.screenshot({ path: testInfo.outputPath("catalog-unread.png") });

  await page.evaluate(() => Reflect.get(globalThis, "relayFixture").calls.splice(0));
  await setup(page, { scenario: "failing" });
  await page.locator(card).getByRole("button", { name: "重新检查" }).click();
  await expect(page.locator(card).getByRole("alert")).toContainText(
    "最近一次检查没能读到官方列表（刚刚）",
  );
  // The last good read stays visible next to the failure.
  await expect(page.locator(card)).toContainText("官方实时列表");
  await page.locator(card).screenshot({ path: testInfo.outputPath("catalog-failed.png") });
});
