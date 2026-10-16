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
      import { consumePendingNewChat, openNewChatWith } from "./packages/renderer-extension/src/settings/rly0-quick-start.ts";

      globalThis.quickStartHelpers = { consumePendingNewChat, openNewChatWith };
      globalThis.setupQuickStart = ({ theme = "dark", loggedIn = false } = {}) => {
        document.documentElement.style.colorScheme = theme;
        const newChat = document.createElement("button");
        newChat.setAttribute("aria-label", "新聊天");
        newChat.textContent = "+";
        newChat.addEventListener("click", () => { globalThis.newChatClicks = (globalThis.newChatClicks ?? 0) + 1; });
        document.body.append(newChat);
        const calls = [];
        let relays = [];
        let agent = null;
        const client = {
          rly0ClaudeCodeAuthStatus: async () => loggedIn
            ? { installed: true, loggedIn: true, email: "me@example.com", plan: "max" }
            : { installed: true, loggedIn: false },
          rly0ClaudeCodeLogin: async () => { calls.push("login"); return { started: true, url: "https://claude.ai/oauth/authorize" }; },
          rly0RelayAgentsGet: async () => ({ claudeCode: agent, active: { claudeCode: null }, restartRequired: false }),
          rly0RelayAgentsSet: async ({ claudeCode }) => { calls.push("agents:" + claudeCode); agent = claudeCode; return { claudeCode, active: { claudeCode: null }, restartRequired: true }; },
          listRly0Relays: async () => ({ available: true, relays }),
          addRly0Relay: async (input) => {
            calls.push("add:" + input.baseUrl + ":" + (input.apiKey ? "key" : "nokey"));
            const relay = { id: "relay-9", name: input.name, baseUrl: input.baseUrl, protocol: "responses", models: [], enabled: true, hasKey: true, keyMask: "sk-…abcd" };
            relays = [relay];
            return { available: true, id: relay.id, relay };
          },
          testRly0Relay: async () => { calls.push("test"); return { available: true, ok: true, latencyMs: 300, modelCount: 2, models: ["claude-opus-4-7", "claude-sonnet-5"] }; },
          updateRly0Relay: async (input) => { calls.push("models:" + input.models.length); return { available: true, relay: relays[0] }; },
          rly0MaintenanceRestartCodex: async () => { calls.push("restart"); return { supported: true, ok: true }; },
        };
        globalThis.quickStartCalls = calls;
        const diagnostics = {
          snapshot: () => ({
            adapter: { state: "ready", reason: "ready", modelUpdates: 1, hook: "request-bridge" },
            hosts: [{ hostId: "local", active: true, agents: [{ agent: "claude-code", availability: "ready", error: null }] }],
          }),
          refresh: async () => undefined,
          subscribe: () => () => undefined,
          quickStartClient: () => client,
        };
        const messages = rendererSettingsMessages("zh-CN");
        const registry = createRendererSettingsPageRegistry([createConnectionsSettingsPage(messages, () => diagnostics)]);
        const shell = mountRendererSettingsShell(registry, document, messages);
        shell.openSettings(undefined, "connections");
      };
    `,
    resolveDir: path.resolve(import.meta.dirname, "../.."),
    sourcefile: "settings-quick-start-e2e-entry.ts",
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
if (!bundle) throw new Error("Quick start fixture bundle missing");

async function setup(page: Page, options = {}) {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route("http://localhost/quick-start-test", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><html><body></body></html>" }),
  );
  await page.goto("http://localhost/quick-start-test");
  await page.addScriptTag({ content: bundle });
  await page.evaluate((options) => Reflect.get(globalThis, "setupQuickStart")(options), options);
  await page.getByText("Claude Code", { exact: true }).first().click();
}

test("signed-in Claude Code opens a new chat with one click", async ({ page }, testInfo) => {
  await setup(page, { loggedIn: true });
  const block = page.locator(".settings-rly0-quick-start");
  await expect(block).toContainText("已可以使用，登录账号：me@example.com");
  await page.screenshot({ path: testInfo.outputPath("quick-start-ready.png") });
  await block.getByRole("button", { name: "开始一个 Claude Code 对话" }).click();
  expect(await page.evaluate(() => Reflect.get(globalThis, "newChatClicks"))).toBe(1);
  const preference = await page.evaluate(() =>
    localStorage.getItem("codexhost.new-thread-preference.v1"),
  );
  expect(JSON.parse(preference ?? "{}").lastAgent).toBe("claude-code");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
});

test("a pasted RLY/0 key sets everything up and restarts into a Claude Code chat", async ({
  page,
}, testInfo) => {
  await setup(page);
  const block = page.locator(".settings-rly0-quick-start");
  await expect(block).toContainText("选一种方式使用 Claude Code");
  await page.screenshot({ path: testInfo.outputPath("quick-start-setup.png") });
  await block.getByLabel("粘贴零号中转的 API Key").fill("sk-test-key");
  await block.getByRole("button", { name: "保存并自动配置" }).click();
  await expect(block).toContainText("正在重启 Codex");
  await page.screenshot({ path: testInfo.outputPath("quick-start-restarting.png") });
  expect(await page.evaluate(() => Reflect.get(globalThis, "quickStartCalls"))).toEqual([
    "add:https://api.rly0.com:key",
    "test",
    "models:2",
    "agents:relay-9",
    "restart",
  ]);
  // After the restart, the pending chat opens once.
  const opened = await page.evaluate(() => {
    const helpers = Reflect.get(globalThis, "quickStartHelpers");
    const agent = helpers.consumePendingNewChat(document);
    if (agent) helpers.openNewChatWith(document, agent);
    return { agent, again: helpers.consumePendingNewChat(document) };
  });
  expect(opened).toEqual({ agent: "claude-code", again: null });
});

test("signing in with a Claude subscription waits for the browser", async ({ page }) => {
  await setup(page);
  const block = page.locator(".settings-rly0-quick-start");
  await block.getByRole("button", { name: "用 Claude 账号登录" }).click();
  await expect(block).toContainText("请在浏览器里完成登录");
  await expect(block.getByRole("link", { name: "打开登录页 ↗" })).toBeVisible();
});
