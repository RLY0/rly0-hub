import { expect, test, type Page } from "@playwright/test";
import { build } from "esbuild";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const { outputFiles } = await build({
  stdin: {
    contents: `
      import {
        mountRendererAgentPicker,
        renderRendererAgentPicker,
      } from "./packages/renderer-extension/src/renderer-agent-picker.ts";

      import { createAgentGroupPreferenceStore } from "./packages/renderer-extension/src/agent-group-preference.ts";

      globalThis.setupInstallationOrderPicker = () => {
        const preference = createAgentGroupPreferenceStore(null);
        const control = mountRendererAgentPicker(
          "installation-order", ["codex", "pi", "claude-code", "grok", "omp"],
          () => {}, () => {}, undefined, preference,
        );
        document.body.append(control.root);
        globalThis.updateInstallationOrderPicker = (availability) => {
          renderRendererAgentPicker(control, { agent: "codex", phase: "draft" }, "ready", false, availability);
        };
        globalThis.groupInstallationOrderPicker = () => {
          preference.moveAgent("pi", "more");
          preference.moveAgent("grok", "more");
        };
      };

      globalThis.setupHandoffPicker = () => {
        const preference = createAgentGroupPreferenceStore(null);
        globalThis.handoffSelections = [];
        const shell = document.createElement("div");
        shell.style.cssText = "position:fixed;left:0;right:0;bottom:24px;display:flex;justify-content:center";
        const control = mountRendererAgentPicker(
          "handoff-composer", ["codex", "claude-code", "grok", "pi"],
          (agent) => globalThis.handoffSelections.push(agent), () => {}, undefined, preference,
        );
        shell.append(control.root);
        document.body.append(shell);
        renderRendererAgentPicker(
          control, { agent: "claude-code", phase: "locked" }, "ready", false,
          { "claude-code": "ready", grok: "ready", pi: "notInstalled" },
          null, false,
          {
            handoff: true,
            sharedSummary: {
              summary: "共享：MCP 14 · 技能 44 · 记忆 1",
              detail: "MCP：basic-memory, codegraph, node_repl",
            },
          },
        );
      };

      globalThis.setupRendererAgentPicker = () => {
        document.documentElement.style.setProperty("--codex-window-zoom", "1.6");

        const shell = document.createElement("div");
        shell.style.position = "fixed";
        shell.style.inset = "0";
        shell.style.display = "flex";
        shell.style.alignItems = "flex-end";
        shell.style.justifyContent = "center";
        shell.style.boxSizing = "border-box";
        shell.style.paddingBottom = "60px";
        shell.style.width = "calc(100vw / var(--codex-window-zoom))";
        shell.style.height = "calc(100vh / var(--codex-window-zoom))";
        shell.style.zoom = "var(--codex-window-zoom)";

        const control = mountRendererAgentPicker(
          "test-composer",
          ["codex", "pi"],
          () => {},
          () => {},
        );
        shell.append(control.root);
        document.body.append(shell);
        renderRendererAgentPicker(
          control,
          { agent: "codex", phase: "draft" },
          "ready",
          false,
          { pi: "ready" },
        );
      };
    `,
    resolveDir: repositoryRoot,
    sourcefile: "renderer-agent-picker-e2e-entry.ts",
    loader: "ts",
  },
  bundle: true,
  format: "iife",
  loader: { ".png": "dataurl", ".svg": "dataurl" },
  platform: "browser",
  target: "es2024",
  write: false,
});

const browserBundle = outputFiles[0]?.text;
if (!browserBundle) throw new Error("Renderer Agent picker E2E bundle was not generated");

test("keeps the Agent menu anchored inside the Codex window zoom", async ({ page }) => {
  await page.setViewportSize({ width: 1_920, height: 1_440 });
  await page.setContent('<!doctype html><body style="margin:0"></body>');
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => {
    const setup = Reflect.get(globalThis, "setupRendererAgentPicker");
    if (typeof setup !== "function") throw new Error("Agent picker setup is unavailable");
    setup();
  });

  const trigger = page.locator(
    '[data-codexhost-agent-control="test-composer"] > button[aria-haspopup="menu"]',
  );
  const menu = page.locator("#test-composer-agent-menu");
  await trigger.click();
  await expect(menu).toBeVisible();
  await expect(menu.locator('button[data-agent="codex"]')).toHaveCount(1);
  await expect(menu.locator("[data-codex-account-id]")).toHaveCount(0);

  const [triggerBox, menuBox] = await Promise.all([trigger.boundingBox(), menu.boundingBox()]);
  if (!triggerBox || !menuBox) throw new Error("Agent picker geometry is unavailable");

  expect(menuBox.x + menuBox.width).toBeCloseTo(triggerBox.x + triggerBox.width, 0);
  expect(menuBox.width).toBeCloseTo(224 * 1.6, 0);
  expect(triggerBox.y - (menuBox.y + menuBox.height)).toBeCloseTo(6 * 1.6, 0);
});

test("defaults uninstalled Harnesses to More and restores order after installation", async ({
  page,
}) => {
  await page.setContent("<!doctype html><body></body>");
  await page.addScriptTag({ content: browserBundle });
  await page.evaluate(() => Reflect.get(globalThis, "setupInstallationOrderPicker")());
  const rows = page.locator("#installation-order-agent-menu button[data-agent]");
  const order = () =>
    rows.evaluateAll((buttons) => buttons.map((button) => button.getAttribute("data-agent")));
  const update = async (availability: Record<string, string>) => {
    await page.evaluate(
      (value) => Reflect.get(globalThis, "updateInstallationOrderPicker")(value),
      availability,
    );
  };
  const defaults = ["codex", "pi", "claude-code", "grok", "omp"];
  await update({});
  expect(await order()).toEqual(defaults);
  await update({
    pi: "notInstalled",
    "claude-code": "error",
    grok: "notInstalled",
    omp: "checking",
  });
  expect(await order()).toEqual(["codex", "claude-code", "omp", "pi", "grok"]);
  await update({ pi: "ready", "claude-code": "unavailable", grok: "ready", omp: "ready" });
  expect(await order()).toEqual(defaults);
  await update({
    pi: "notInstalled",
    "claude-code": "notInstalled",
    grok: "notInstalled",
    omp: "notInstalled",
  });
  expect(await order()).toEqual(defaults);
  await update({ pi: "notInstalled", "claude-code": "notInstalled", grok: "ready", omp: "ready" });
  await page.evaluate(() => Reflect.get(globalThis, "groupInstallationOrderPicker")());
  // Explicit groups win; untouched missing Harnesses still default to More.
  expect(await order()).toEqual(["codex", "omp", "grok", "claude-code", "pi"]);
  await update({ pi: "ready", "claude-code": "ready", grok: "ready", omp: "ready" });
  expect(await order()).toEqual(["codex", "claude-code", "omp", "pi", "grok"]);
});

const shotDirectory = process.env.HANDOFF_SCREENSHOT_DIR;

test.describe("handoff on a started Thread", () => {
  test.use({ locale: "zh-CN" });

  const openHandoffMenu = async (page: Page, width: number) => {
    await page.setViewportSize({ width, height: 560 });
    await page.setContent(
      '<!doctype html><body style="margin:0;background:#1e1e1e;color:#eee"></body>',
    );
    await page.addScriptTag({ content: browserBundle });
    await page.evaluate(() => Reflect.get(globalThis, "setupHandoffPicker")());
    const trigger = page.locator(
      '[data-codexhost-agent-control="handoff-composer"] > button[aria-haspopup="menu"]',
    );
    const menu = page.locator("#handoff-composer-agent-menu");
    return { trigger, menu };
  };

  test("enables the Agent control with an honest tooltip and keyboard handoff", async ({
    page,
  }) => {
    const { trigger, menu } = await openHandoffMenu(page, 760);
    await expect(trigger).toBeEnabled();
    await expect(trigger).toHaveAttribute(
      "title",
      "claude-code · 换个助手接着聊：会新开一个对话并带上之前的内容",
    );
    await expect(trigger).toHaveAttribute("aria-label", "换个助手接着聊，当前：claude-code");
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(menu).toBeVisible();

    // One compact header row; the long notes live in the ⓘ tooltip only.
    const header = menu.locator("[data-codexhost-agent-note]");
    const info = header.locator("button[data-codexhost-agent-note-info]");
    const tooltip = menu.locator('[role="tooltip"]');
    await expect(header.locator("[data-codexhost-agent-note-title]")).toHaveText("换个助手接着聊");
    const headerBox = await header.boundingBox();
    expect(headerBox?.height).toBeLessThanOrEqual(30);
    await expect(tooltip).toBeHidden();
    await expect(info).toHaveAttribute("aria-describedby", "handoff-composer-agent-note");
    const firstRow = await menu.locator('button[data-agent="codex"]').boundingBox();
    const menuBox = await menu.boundingBox();
    if (!firstRow || !menuBox) throw new Error("Agent menu geometry is unavailable");
    expect(firstRow.y - menuBox.y).toBeLessThan(40);

    await expect(menu.locator('button[data-agent="claude-code"]')).toBeDisabled();
    await expect(menu.locator('button[data-agent="pi"]')).toBeDisabled();
    await expect(menu.locator('button[data-agent="codex"]')).toBeFocused();
    if (shotDirectory) await page.screenshot({ path: `${shotDirectory}/handoff-picker-760.png` });

    // Hover shows the full explanation and the sharing line.
    await info.hover();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("原对话保持不变");
    await expect(tooltip).toContainText("共享：MCP 14 · 技能 44 · 记忆 1");
    await expect(tooltip).toContainText("basic-memory, codegraph, node_repl");
    const tooltipBox = await tooltip.boundingBox();
    if (!tooltipBox) throw new Error("Agent note tooltip geometry is unavailable");
    expect(tooltipBox.width).toBeLessThanOrEqual(280);
    expect(tooltipBox.x).toBeGreaterThanOrEqual(0);
    expect(tooltipBox.x + tooltipBox.width).toBeLessThanOrEqual(760);
    expect(tooltipBox.y).toBeGreaterThanOrEqual(0);
    if (shotDirectory)
      await page.screenshot({ path: `${shotDirectory}/handoff-picker-760-info.png` });
    await page.mouse.move(5, 5);
    await expect(tooltip).toBeHidden();
    await expect(menu).toBeVisible();

    // Keyboard: Shift+Tab reaches ⓘ (focus shows the tooltip), Escape closes only the tooltip.
    await expect(menu.locator('button[data-agent="codex"]')).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(info).toBeFocused();
    await expect(tooltip).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(tooltip).toBeHidden();
    await expect(menu).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(menu.locator('button[data-agent="codex"]')).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator('button[data-agent="grok"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => Reflect.get(globalThis, "handoffSelections"))).toEqual([
      "grok",
    ]);
  });

  test("keeps the ⓘ tooltip inside a narrow window", async ({ page }) => {
    const { trigger, menu } = await openHandoffMenu(page, 360);
    await trigger.click();
    await expect(menu).toBeVisible();
    const info = menu.locator("button[data-codexhost-agent-note-info]");
    const tooltip = menu.locator('[role="tooltip"]');
    if (shotDirectory) await page.screenshot({ path: `${shotDirectory}/handoff-picker-360.png` });
    await info.click();
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText("原对话保持不变");
    const box = await tooltip.boundingBox();
    if (!box) throw new Error("Agent note tooltip geometry is unavailable");
    expect(box.x).toBeGreaterThanOrEqual(8);
    expect(box.x + box.width).toBeLessThanOrEqual(352);
    expect(box.y).toBeGreaterThanOrEqual(8);
    if (shotDirectory)
      await page.screenshot({ path: `${shotDirectory}/handoff-picker-360-info.png` });
    // Clicking ⓘ pins the tooltip; clicking it again closes only the tooltip.
    await info.click();
    await expect(tooltip).toBeHidden();
    await expect(menu).toBeVisible();
  });
});
