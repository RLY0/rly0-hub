// Tier A UI patrol of the RLY/0 Hub window in mock mode (no WebView bridge, pages/mock.js
// answers every call). For each page × width: full-page screenshot, click every visible enabled
// control in the main area, collect console errors / page errors / unhandled rejections / failed
// requests, and check for overflow. Results land in .local-test/patrol/<run>/; report.mjs
// (globalTeardown) folds them into report.json and report.md.
import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const browserExecutable = process.env.CODEXHOST_PLAYWRIGHT_EXECUTABLE_PATH;
if (browserExecutable) test.use({ launchOptions: { executablePath: browserExecutable } });

const runDir = process.env.HUB_PATROL_RUN || path.resolve(".local-test/patrol/manual");
// 760 is the narrowest window; at the default 110% interface size its CSS width is ~690.
const WIDTHS = (process.env.HUB_PATROL_WIDTHS || "1240,760").split(",").map(Number);
const HEIGHT = 820;

type Target = { id: string; kind: "rail" | "settings" | "accounts" | "wizard"; label?: string };
const TARGETS: Target[] = [
  ...["home", "relays", "agents", "maintenance", "support"].map((id): Target => ({
    id,
    kind: "rail",
  })),
  // 账号: one target per provider tab.
  ...(
    [
      ["codex", "OpenAI"],
      ["claude", "Anthropic"],
      ["gemini", "Google"],
      ["grok", "xAI"],
    ] as const
  ).map(([id, label]): Target => ({ id: `accounts-${id}`, kind: "accounts", label })),
  ...(
    [
      ["general", "通用"],
      ["instructions", "自定义指令"],
      ["network", "网络代理"],
      ["backup", "备份"],
      ["mcp", "MCP"],
      ["skills", "Skills"],
      ["threads", "线程"],
      ["updates", "更新"],
    ] as const
  ).map(([id, label]): Target => ({ id: `settings-${id}`, kind: "settings", label })),
  { id: "wizard", kind: "wizard" },
];

// Buttons that leave the app (browser, other programs) are not clicked.
const EXTERNAL =
  /安装说明|发布页|下载页|GitHub|Star 支持|rly0\.com|在浏览器|官网|文档|教程|打开网页|购买|充值/u;

type Issue = { type: string; text: string; during: string };
type Warning = { type: string; text: string; during: string; detail?: unknown };

test.describe.configure({ mode: "parallel" });

for (const width of WIDTHS) {
  for (const target of TARGETS) {
    test(`patrol ${target.id} @${width}`, async ({ page, context }) => {
      const shotDir = path.join(runDir, String(width));
      mkdirSync(shotDir, { recursive: true });
      const errors: Issue[] = [];
      const warnings: Warning[] = [];
      const clicked: string[] = [];
      const skipped: { label: string; reason: string }[] = [];
      const dialogs: { label: string; screenshot: string; during: string }[] = [];
      let during = "加载";

      page.on("console", (message) => {
        if (message.type() === "error")
          errors.push({ type: "console.error", text: message.text(), during });
      });
      page.on("pageerror", (error) =>
        errors.push({ type: "pageerror", text: String(error.stack || error.message), during }),
      );
      page.on("requestfailed", (request) =>
        errors.push({
          type: "requestfailed",
          text: `${request.url()} ${request.failure()?.errorText || ""}`,
          during,
        }),
      );
      page.on("response", (response) => {
        if (response.status() >= 400)
          errors.push({ type: "http", text: `${response.status()} ${response.url()}`, during });
      });
      page.on("dialog", (dialog) => void dialog.dismiss());
      page.on("filechooser", () => undefined);
      context.on("page", (popup) => {
        warnings.push({ type: "popup", text: `打开了新窗口 ${popup.url()}`, during });
        void popup.close();
      });
      await page.addInitScript(() => {
        const w = window as unknown as { __patrolRejections: string[] };
        w.__patrolRejections = [];
        window.addEventListener("unhandledrejection", (event) => {
          const reason = event.reason as { stack?: string } | undefined;
          w.__patrolRejections.push(String((reason && reason.stack) || event.reason));
        });
      });
      await page.setViewportSize({ width, height: HEIGHT });

      const drainRejections = async () => {
        const list = await page
          .evaluate(() => {
            const w = window as unknown as { __patrolRejections: string[] };
            return w.__patrolRejections.splice(0);
          })
          .catch(() => [] as string[]);
        for (const text of list) errors.push({ type: "unhandledrejection", text, during });
      };

      const settle = async (ms = 350) => {
        await page
          .waitForFunction(
            () => !document.getElementById("boot")?.classList.contains("show"),
            null,
            {
              timeout: 8000,
            },
          )
          .catch(() => warnings.push({ type: "loading", text: "加载遮罩 8 秒内没有消失", during }));
        await page.waitForTimeout(ms);
      };

      const viewState = () =>
        page.evaluate(() =>
          [
            document.getElementById("title")?.textContent,
            document.querySelector(".rail button.on")?.getAttribute("data-page"),
            document.querySelector(".settings-menu button.on")?.textContent,
            document.body.classList.contains("guided"),
          ].join("|"),
        );

      async function open() {
        await page.goto(target.kind === "wizard" ? "/index.html?wizard" : "/index.html");
        await settle(150);
        if (target.kind === "wizard") {
          await page.waitForFunction(() => document.body.classList.contains("guided"));
        } else if (target.kind === "rail") {
          if (target.id !== "home") await page.click(`.rail button[data-page="${target.id}"]`);
        } else if (target.kind === "accounts") {
          await page.click('.rail button[data-page="accounts"]');
          await settle(150);
          await page.click(`.account-tabs button[aria-label^="${target.label}"]`);
        } else {
          await page.click('.rail button[data-page="settings"]');
          await page
            .locator(".settings-menu button", { hasText: target.label ?? "" })
            .first()
            .click();
        }
        await settle();
      }

      async function closeOverlays(label: string, record: boolean) {
        const dialog = page.locator(".dialog-backdrop.show .dialog").first();
        if (await dialog.isVisible().catch(() => false)) {
          const name =
            (await dialog.getAttribute("aria-label", { timeout: 1000 }).catch(() => null)) ||
            "对话框";
          if (record && !dialogs.some((d) => d.label === name)) {
            const file = path.join(shotDir, `${target.id}__dialog-${dialogs.length + 1}.png`);
            await page.waitForTimeout(250);
            await page.screenshot({ path: file });
            dialogs.push({ label: name, screenshot: path.relative(runDir, file), during: label });
            await checkOverflow(`对话框「${name}」`, ".dialog-backdrop.show .dialog");
          }
          await page
            .locator(".dialog-backdrop.show .dialog-x")
            .first()
            .click({ timeout: 2000 })
            .catch(() => page.keyboard.press("Escape"));
          await page.waitForTimeout(250);
        }
        if (await page.locator(".menu-panel.show, .pick-list.show").count()) {
          await page.keyboard.press("Escape");
          await page.waitForTimeout(200);
        }
      }

      async function checkOverflow(where: string, scope: string) {
        const result = await page.evaluate((scopeSelector) => {
          const pathOf = (el: Element) => {
            const parts: string[] = [];
            for (
              let node: Element | null = el;
              node && parts.length < 4;
              node = node.parentElement
            ) {
              const cls = [...node.classList].slice(0, 2).join(".");
              parts.unshift(
                node.tagName.toLowerCase() +
                  (node.id ? `#${node.id}` : "") +
                  (cls ? `.${cls}` : ""),
              );
              if (node.id) break;
            }
            return parts.join(" > ");
          };
          const doc = document.documentElement;
          const main = document.getElementById("page");
          const pageLevel: string[] = [];
          if (doc.scrollWidth > doc.clientWidth + 1)
            pageLevel.push(`document ${doc.scrollWidth} > ${doc.clientWidth}`);
          if (main && main.scrollWidth > main.clientWidth + 1)
            pageLevel.push(`#page ${main.scrollWidth} > ${main.clientWidth}`);
          const text: { path: string; text: string; scrollWidth: number; clientWidth: number }[] =
            [];
          for (const root of document.querySelectorAll(scopeSelector)) {
            for (const el of root.querySelectorAll<HTMLElement>("*")) {
              if (el.matches("input, textarea, select, svg, svg *, option, .pick-native")) continue;
              // A text box: own text, or only inline children carrying it (a <b> in a <p>).
              const hasText = [...el.childNodes].some(
                (n) => n.nodeType === Node.TEXT_NODE && (n.textContent || "").trim(),
              );
              const inlineOnly =
                el.children.length > 0 &&
                [...el.children].every((c) => getComputedStyle(c).display.startsWith("inline")) &&
                (el.textContent || "").trim();
              if (!hasText && !inlineOnly) continue;
              const box = el.getBoundingClientRect();
              if (!box.width || !box.height || !el.clientWidth) continue;
              const style = getComputedStyle(el);
              if (style.visibility === "hidden" || style.display === "inline") continue;
              if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
              if (style.textOverflow === "ellipsis") continue;
              if (el.scrollWidth > el.clientWidth + 1)
                text.push({
                  path: pathOf(el),
                  text: (el.textContent || "").trim().slice(0, 60),
                  scrollWidth: el.scrollWidth,
                  clientWidth: el.clientWidth,
                });
            }
          }
          return { pageLevel, text };
        }, scope);
        for (const item of result.pageLevel)
          if (!errors.some((e) => e.type === "horizontal-scroll" && e.text === item))
            errors.push({ type: "horizontal-scroll", text: item, during: where });
        for (const item of result.text) {
          const key = `${item.path}|${item.text}`;
          if (!warnings.some((w) => w.type === "text-overflow" && w.text === key))
            warnings.push({ type: "text-overflow", text: key, during: where, detail: item });
        }
      }

      // Tag the clickable controls of the main area with a stable key (label + ordinal).
      const enumerate = () =>
        page.evaluate(() => {
          const seen = new Map<string, number>();
          const out: { key: string; label: string; external: boolean; disabled: boolean }[] = [];
          const controls = document.querySelectorAll<HTMLElement>(
            '#page button, #page summary, #page [role="switch"], #page input[type="checkbox"], #page input[type="radio"], #page a[href]',
          );
          for (const el of controls) {
            const box = el.getBoundingClientRect();
            const style = getComputedStyle(el);
            if (!box.width || !box.height || style.visibility === "hidden") continue;
            if (el.closest("[hidden]")) continue;
            // Inside a closed <details> (other than its summary): laid out but not shown.
            const fold = el.closest("details:not([open])");
            if (fold && !el.closest("summary")) continue;
            if (
              el.checkVisibility &&
              !el.checkVisibility({ opacityProperty: false, visibilityProperty: true })
            )
              continue;
            const label = (
              el.getAttribute("aria-label") ||
              el.textContent ||
              el.getAttribute("title") ||
              el.tagName
            )
              .replace(/\s+/gu, " ")
              .trim()
              .slice(0, 40);
            const n = (seen.get(label) || 0) + 1;
            seen.set(label, n);
            const key = `${label}#${n}`;
            el.dataset.patrolKey = key;
            out.push({
              key,
              label,
              external: el.tagName === "A",
              disabled:
                (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true",
            });
          }
          return out;
        });

      await open();
      during = "首屏";
      await drainRejections();

      // Full-page screenshot: #page scrolls on its own, so grow the viewport to fit it.
      const extra = await page.evaluate(() => {
        const main = document.getElementById("page");
        return main ? Math.max(0, main.scrollHeight - main.clientHeight) : 0;
      });
      const shot = path.join(shotDir, `${target.id}.png`);
      if (extra) {
        await page.setViewportSize({ width, height: Math.min(HEIGHT + extra, 8000) });
        await page.waitForTimeout(300);
      }
      await checkOverflow("首屏", "#page");
      await page.screenshot({ path: shot, fullPage: true });
      if (extra) {
        await page.setViewportSize({ width, height: HEIGHT });
        await page.waitForTimeout(200);
      }
      await closeOverlays("首屏", true);

      const home = await viewState();
      const queue = await enumerate();
      const done = new Set<string>();
      for (const planned of queue) {
        if (done.has(planned.key)) continue;
        if (done.size >= 150) {
          warnings.push({ type: "limit", text: "点击数超过 150，后面的按钮没有点", during });
          break;
        }
        done.add(planned.key);
        if (planned.external || EXTERNAL.test(planned.label)) {
          skipped.push({ label: planned.key, reason: "外部链接" });
          continue;
        }
        if ((await viewState()) !== home) {
          await open();
        }
        await closeOverlays(planned.key, true);
        const now = await enumerate();
        const entry = now.find((c) => c.key === planned.key);
        if (!entry) {
          skipped.push({ label: planned.key, reason: "状态变化后不存在" });
          continue;
        }
        if (entry.disabled) {
          skipped.push({ label: planned.key, reason: "不可用" });
          continue;
        }
        during = `点击「${planned.key}」`;
        if (process.env.HUB_PATROL_DEBUG)
          console.log(`[${target.id}@${width}] ${during} ${new Date().toISOString()}`);
        const locator = page
          .locator(`[data-patrol-key="${planned.key.replace(/"/gu, '\\"')}"]`)
          .first();
        const tap = async () => {
          await locator.scrollIntoViewIfNeeded({ timeout: 2000 });
          await locator.click({ timeout: 3000 });
        };
        try {
          // The update prompt can pop up over the page, or a late reply redraw the control: close
          // overlays, tag again and retry once.
          await tap().catch(async () => {
            await closeOverlays(planned.key, true);
            await enumerate();
            await tap();
          });
          clicked.push(planned.key);
        } catch (error) {
          warnings.push({
            type: "click",
            text: `${planned.key}: ${String(error).split("\n")[0]}`,
            during,
          });
          continue;
        }
        await page.waitForTimeout(300);
        // Two-step confirm buttons: the second tap goes ahead.
        const armed = await locator
          .evaluate((el) => el.classList.contains("armed"), null, { timeout: 500 })
          .catch(() => false);
        if (armed) {
          await locator.click({ timeout: 2000 }).catch(() => undefined);
          await page.waitForTimeout(300);
        }
        await settle(250);
        await drainRejections();
        await checkOverflow(during, "#page");
        await closeOverlays(planned.key, true);
        // New controls revealed by this click (detail panels) join the queue.
        if ((await viewState()) === home)
          for (const extraControl of await enumerate())
            if (!queue.some((q) => q.key === extraControl.key)) queue.push(extraControl);
      }
      during = "结束";
      await page.waitForTimeout(300);
      await drainRejections();

      const result = {
        width,
        page: target.id,
        screenshot: path.relative(runDir, shot),
        clicked,
        skipped,
        dialogs,
        errors,
        warnings,
      };
      mkdirSync(path.join(runDir, "results"), { recursive: true });
      writeFileSync(
        path.join(runDir, "results", `${width}-${target.id}.json`),
        JSON.stringify(result, null, 2),
      );
      expect(errors, JSON.stringify(errors, null, 2)).toEqual([]);
      if (target.id === "maintenance") {
        // 反馈问题 must be reachable and, in mock mode, end with a saved path and its folder button.
        expect(clicked).toContain("反馈问题#1");
        expect(clicked).toContain("打开文件夹#1");
      }
      // 刷新额度 works on every provider tab in the mock (Codex succeeds with one account failing,
      // Claude fails outright, Grok has an expired account, Antigravity's /usage then times out).
      if (target.id.startsWith("accounts-")) expect(clicked).toContain("刷新额度#1");
    });
  }
}

// 刷新额度 on the 账号 page, both outcomes the mock produces.
test("accounts quota refresh: loading, cooldown, partial and full failure", async ({ page }) => {
  await page.goto("/index.html");
  await page.click('.rail button[data-page="accounts"]');
  const button = page.locator(".refresh-btn");
  const when = page.locator(".refresh-when");
  // The update prompt can pop up over the page at any time.
  const dismiss = async () => {
    const close = page.locator(".dialog-backdrop.show .dialog-x");
    if (await close.isVisible().catch(() => false)) await close.click();
  };
  const tab = async (label: string) => {
    await dismiss();
    await page.click(`.account-tabs button[aria-label^="${label}"]`);
  };
  // Opening the tab reads quota once; the API-key account cannot be read.
  await expect(when).toContainText("更新于");
  await expect(when).toContainText("1 个账号刷新失败");
  await dismiss();
  await button.click();
  await expect(button).toHaveAttribute("aria-busy", "true");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(when).toHaveText("刷新中…");
  await expect(when).toContainText("2 个账号刷新失败");
  await expect(page.locator(".account-card", { hasText: "Pro 号" })).toContainText(
    "刷新失败：暂时连不上官方接口，显示的是上次读到的额度",
  );
  await expect(page.locator(".account-card", { hasText: "Pro 号" })).toContainText("剩 8%");
  // Cooling down after a manual refresh.
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(button).toHaveAttribute("data-tip", "刚刷新过，稍等几秒再刷新");

  await tab("Anthropic");
  await expect(when).toContainText("更新于");
  await dismiss();
  await button.click();
  await expect(when).toContainText("刷新失败 · 仍是");
  await expect(when).toHaveClass(/bad/u);
  await expect(page.locator(".account-card", { hasText: "me@example.com" })).toContainText(
    "剩 58%",
  );

  await tab("Google");
  await expect(button).toHaveAttribute("aria-disabled", "true");
  await expect(when).toHaveText("无法查询额度");
});

// The saved Claude setup-token (pages/mock.js `?claudeKey=`): quota read off a model response,
// the probe failing on the network, and a dead token.
test("claude setup-token quota: tiles, network failure, invalid token", async ({ page }) => {
  const open = async (query: string) => {
    await page.setViewportSize({ width: 1240, height: HEIGHT });
    await page.goto(`/index.html${query}`);
    await page.click('.rail button[data-page="accounts"]');
    const close = page.locator(".dialog-backdrop.show .dialog-x");
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.click('.account-tabs button[aria-label^="Anthropic"]');
    return page.locator(".key-card");
  };
  // After the assertions: the card has rendered and its entrance animation has settled.
  const shot = async (card: Locator, name: string) => {
    mkdirSync(path.join(runDir, "setup-token"), { recursive: true });
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await card.screenshot({ path: path.join(runDir, "setup-token", `${name}.png`) });
  };
  let card = await open("");
  await expect(card).toContainText("5 小时额度");
  await expect(card).toContainText("剩 61%");
  await expect(card).toContainText("每周额度");
  await expect(card).toContainText("剩 82%");
  await expect(card).toContainText("更新于");
  await expect(card).not.toContainText("官方不允许");
  await shot(card, "usage");

  card = await open("?claudeKey=network");
  await expect(card).toContainText("网络连不上官方，点刷新重试");
  await expect(card).not.toContainText("不支持");
  await expect(page.locator(".refresh-btn")).not.toHaveAttribute("aria-disabled", "true");
  await shot(card, "network");

  card = await open("?claudeKey=rateLimited");
  await expect(card).toContainText("官方暂时限制查询，稍后点刷新");
  await shot(card, "rate-limited");

  card = await open("?claudeKey=invalid");
  await expect(card).toContainText("令牌失效了");
  await expect(card).toContainText("已失效");
  await shot(card, "invalid");
});

// The credential each agent actually runs on glows and says 使用中; the others stay plain.
test("accounts: the card in use is marked on every provider tab", async ({ page }) => {
  const dir = path.join(runDir, "in-use");
  mkdirSync(dir, { recursive: true });
  for (const width of WIDTHS) {
    for (const [tab, query, expected] of [
      ["OpenAI", "", "me@example.com"],
      ["Anthropic", "?claudeUses=key", "Claude 订阅令牌"],
      ["xAI", "", "me@example.com"],
    ] as const) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(`/index.html${query}`);
      await page.click('.rail button[data-page="accounts"]');
      const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
      await update.waitFor({ timeout: 5000 }).catch(() => undefined);
      if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();
      await page.click(`.account-tabs button[aria-label^="${tab}"]`);
      const inUse = page.locator(".account-card.in-use");
      await expect(inUse).toHaveCount(1);
      await expect(inUse).toContainText(expected);
      await expect(inUse.locator(".tag.in-use")).toHaveText("使用中");
      if (tab === "Anthropic")
        await expect(page.locator(".account-card", { hasText: "me@example.com" })).toContainText(
          "当前登录",
        );
      await inUse.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () => !document.getElementById("boot")?.classList.contains("show"),
      );
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(dir, `${tab}-${width}.png`) });
    }
  }
});

// Claude accounts (pages/mock.js): three saved accounts, one signed out elsewhere; adding one by
// web login (code pasted) and by a credentials file, both without touching the current login.
test("claude accounts: cards, add by web login, import from file", async ({ page }) => {
  const dir = path.join(runDir, "claude-accounts");
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: 1240, height: HEIGHT });
  await page.goto("/index.html");
  await page.click('.rail button[data-page="accounts"]');
  // The mock's update prompt pops up shortly after start; get it out of the way first.
  const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
  await update.waitFor({ timeout: 5000 }).catch(() => undefined);
  const dismiss = async () => {
    if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();
  };
  await dismiss();
  await page.click('.account-tabs button[aria-label^="Anthropic"]');
  const card = (text: string) => page.locator(".account-card", { hasText: text });
  await expect(card("me@example.com")).toContainText("当前登录");
  await expect(card("工作号")).toContainText("剩 85%");
  await expect(card("工作号")).toContainText("切换到这个");
  // The mock binds Claude Code to the 零号中转 relay: its login is signed in but not in use.
  await expect(page.locator(".account-card.in-use")).toHaveCount(0);
  await expect(card("旧号")).toContainText("登录已失效");
  await expect(page.locator(".auto-switch")).toContainText("违反 Anthropic 的使用条款");
  await card("旧号").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(dir, "cards.png") });

  // 网页登录 → dialog → paste a code → saved.
  await dismiss();
  await page.click('button.menu-trigger:has-text("+ 添加")');
  await page.click('.menu-item:has-text("网页登录")');
  const dialog = page.locator('.dialog-backdrop.show .dialog[aria-label="添加 Claude 账号"]');
  await expect(dialog).toContainText("添加 Claude 账号");
  await expect(dialog).toContainText("当前登录不受影响");
  await expect(dialog.locator('input[aria-label="Claude 授权码"]')).toBeVisible();
  await page.waitForTimeout(400);
  await dialog.screenshot({ path: path.join(dir, "add-web-login.png") });
  await dialog.locator('input[aria-label="Claude 授权码"]').fill("no-state");
  await dialog.locator('button:has-text("提交授权码")').click();
  await expect(page.locator("#toast")).toContainText("授权码不完整");
  await dialog.locator('input[aria-label="Claude 授权码"]').fill("synthetic-code#synthetic-state");
  await dialog.locator('button:has-text("提交授权码")').click();
  await expect(dialog).toHaveCount(0, { timeout: 8000 });
  await expect(card("new@example.com")).toBeVisible();
  await expect(card("me@example.com")).toContainText("当前登录");

  // 从文件导入: a wrong file first, then Claude Code's .credentials.json.
  const pick = async (name: string, content: string) => {
    await dismiss();
    await page.click('button.menu-trigger:has-text("+ 添加")');
    const chooser = page.waitForEvent("filechooser");
    await page.click('.menu-item:has-text("从文件导入")');
    await (
      await chooser
    ).setFiles({ name, mimeType: "application/json", buffer: Buffer.from(content) });
  };
  await page.click('button.menu-trigger:has-text("+ 添加")');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, "add-menu.png") });
  await page.keyboard.press("Escape");
  await pick("wrong.json", '{"hello":1}');
  await expect(page.locator("#toast")).toContainText("文件里没有 Claude 登录");
  await pick(
    ".credentials.json",
    JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", refreshToken: "synthetic" } }),
  );
  await expect(page.locator("#toast")).toContainText("已导入 file@example.com");
  await expect(card("file@example.com")).toBeVisible();
  await card("file@example.com").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(dir, "after-import.png") });

  // Switching is manual and per card.
  await card("工作号").locator('button:has-text("切换到这个")').click();
  await expect(card("工作号")).toContainText("当前登录");
});

// Grok (测试版, pages/mock.js): a weekly and a monthly account and one whose saved login expired;
// adding one by `grok login` (finishes on its own, no code) and by an auth.json file.
async function openAccountsTab(page: Page, tab: string) {
  await page.setViewportSize({ width: 1240, height: HEIGHT });
  await page.goto("/index.html");
  await page.click('.rail button[data-page="accounts"]');
  const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
  await update.waitFor({ timeout: 5000 }).catch(() => undefined);
  const dismiss = async () => {
    if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();
  };
  await dismiss();
  await page.click(`.account-tabs button[aria-label^="${tab}"]`);
  return dismiss;
}

test("grok accounts: cards, expired login, add by web login, import from file", async ({
  page,
}) => {
  const dir = path.join(runDir, "grok-accounts");
  mkdirSync(dir, { recursive: true });
  const dismiss = await openAccountsTab(page, "xAI");
  const card = (text: string) => page.locator(".account-card", { hasText: text });
  await expect(page.locator(".beta-tag")).toHaveText("测试版");
  await expect(card("me@example.com")).toContainText("使用中");
  await expect(card("me@example.com")).toContainText("每周额度");
  await expect(card("SuperGrok 号")).toContainText("每月额度");
  await expect(card("SuperGrok 号")).toContainText("剩 36%");
  await expect(card("旧号")).toContainText("切换一次即可更新额度");
  await expect(page.locator(".auto-switch")).toContainText("只能手动切换");
  await card("旧号").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(dir, "cards.png"), fullPage: true });

  await dismiss();
  await page.locator("#page").evaluate((element) => element.scrollTo(0, 0));
  await page.waitForTimeout(200);
  await page.click('button.menu-trigger:has-text("+ 添加")');
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(dir, "add-menu.png") });
  await page.click('.menu-item:has-text("网页登录")');
  const dialog = page.locator('.dialog-backdrop.show .dialog[aria-label="添加 Grok 账号"]');
  await expect(dialog).toContainText("xAI 官方登录页");
  await expect(dialog.locator("input")).toHaveCount(0);
  await dialog.screenshot({ path: path.join(dir, "add-web-login.png") });
  await expect(dialog).toHaveCount(0, { timeout: 10000 });
  await expect(card("new@example.com")).toBeVisible();
  await expect(card("me@example.com")).toContainText("使用中");

  const pick = async (name: string, content: string) => {
    await dismiss();
    await page.click('button.menu-trigger:has-text("+ 添加")');
    const chooser = page.waitForEvent("filechooser");
    await page.click('.menu-item:has-text("从文件导入")');
    await (
      await chooser
    ).setFiles({ name, mimeType: "application/json", buffer: Buffer.from(content) });
  };
  await pick("wrong.json", '{"hello":1}');
  await expect(page.locator("#toast")).toContainText("文件里没有 Grok 登录");
  await pick("auth.json", JSON.stringify({ "https://auth.x.ai::synthetic": { key: "synthetic" } }));
  await expect(page.locator("#toast")).toContainText("切换过去后 Grok 会自动续期");
  await expect(card("file@example.com")).toBeVisible();

  await card("旧号").locator('button:has-text("切换到这个")').click();
  await expect(page.locator("#toast")).toContainText("Grok 会自动续期这个登录");
  await expect(card("旧号")).toContainText("使用中");
  await page.waitForTimeout(800);
  await card("旧号").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, "after-switch.png"), fullPage: true });
});

// Gemini (测试版): Antigravity keeps one shared keyring login, so no accounts; its /usage quota is
// read only on request, and a later failure keeps the last numbers.
test("gemini: current Antigravity login quota on request, multi-account unsupported", async ({
  page,
}) => {
  const dir = path.join(runDir, "gemini-accounts");
  mkdirSync(dir, { recursive: true });
  await openAccountsTab(page, "Google");
  const card = page.locator(".account-card", { hasText: "Antigravity 当前登录" });
  await expect(page.locator(".beta-tag")).toHaveText("测试版");
  await expect(card).toContainText("点右上角刷新");
  await expect(page.locator(".auto-switch")).toContainText("系统钥匙串");
  await expect(page.locator('button:has-text("保存当前登录")')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.screenshot({ path: path.join(dir, "before.png"), fullPage: true });
  await page.click('button[aria-label="刷新额度"]');
  await expect(card).toContainText("Gemini Models · 5 小时额度");
  await expect(card).toContainText("Claude and GPT models · 每周额度");
  await expect(card).toContainText("使用中");
  await expect(card).toHaveClass(/in-use/u);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(dir, "quota.png"), fullPage: true });
  await page.waitForTimeout(10_500);
  await page.click('button[aria-label="刷新额度"]');
  await expect(card).toContainText("显示的是上次读到的额度");
  await expect(card).toContainText("Gemini Models · 每周额度");
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(dir, "stale.png"), fullPage: true });
});
