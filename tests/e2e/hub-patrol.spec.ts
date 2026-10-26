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

type Target = {
  id: string;
  kind: "rail" | "settings" | "accounts" | "wizard" | "bridge";
  label?: string;
};
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
      ["remote", "远程连接"],
      ["usage", "用量统计"],
      ["updates", "更新"],
    ] as const
  ).map(([id, label]): Target => ({ id: `settings-${id}`, kind: "settings", label })),
  // 打通设置: its own rail entry with one tab per kind.
  ...(
    [
      ["bridge", "概览"],
      ["mcp", "MCP"],
      ["skills", "技能"],
      ["memory", "记忆"],
      ["threads", "线程"],
    ] as const
  ).map(([id, label]): Target => ({ id: `bridge-${id}`, kind: "bridge", label })),
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
            document.querySelector(".bridge-tabs button.on")?.textContent,
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
        } else if (target.kind === "bridge") {
          await page.click('.rail button[data-page="bridge"]');
          await settle(150);
          await page
            .locator(".bridge-tabs button", { hasText: target.label ?? "" })
            .first()
            .click();
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
              // .sr-only: text kept for screen readers, clipped on purpose.
              if (el.matches("input, textarea, select, svg, svg *, option, .pick-native, .sr-only"))
                continue;
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

// Saved Claude subscription tokens (pages/mock.js `?claudeKey=` varies the ····QwAA one): each is
// its own card ("Claude 订阅令牌 · 订阅令牌 · ····last4") with quota read off a model response, the
// probe failing on the network, and a dead token. The empty draft card stays hidden (0.11.8).
test("claude setup-token quota: tiles, network failure, invalid token", async ({ page }) => {
  const open = async (query: string) => {
    await page.setViewportSize({ width: 1240, height: HEIGHT });
    await page.goto(`/index.html${query}`);
    await page.click('.rail button[data-page="accounts"]');
    const close = page.locator(".dialog-backdrop.show .dialog-x");
    if (await close.isVisible().catch(() => false)) await close.click();
    await page.click('.account-tabs button[aria-label^="Anthropic"]');
    const tokens = page.locator(".key-card:not([hidden])");
    await expect(tokens).toHaveCount(2);
    await expect(tokens.filter({ hasText: "cd34" })).toContainText("剩 61%");
    const card = tokens.filter({ hasText: "QwAA" });
    await expect(card).toContainText("Claude 订阅令牌");
    await expect(card).toContainText("订阅令牌");
    // Not bound to Claude Code in the default mock: it can be switched to.
    await expect(card).not.toHaveClass(/in-use/u);
    await expect(card.locator('button:has-text("切换到这个")')).toBeVisible();
    return card;
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
  await expect(card.locator(".quota-fresh")).toContainText("刚刚");
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

// 维护 → 修复聊天记录 (pages/mock.js): every chat is checked; each problem says why and whether
// the repair fixes it.
test("maintenance: chat repair lists every problem with its reason", async ({ page }) => {
  const dir = path.join(runDir, "chat-repair");
  mkdirSync(dir, { recursive: true });
  for (const width of WIDTHS) {
    for (const query of ["", "?chats=clean"]) {
      await page.setViewportSize({ width, height: HEIGHT });
      await page.goto(`/index.html${query}`);
      const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
      await update.waitFor({ timeout: 5000 }).catch(() => undefined);
      if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();
      await page.click('.rail button[data-page="maintenance"]');
      await page.click('button:has-text("检查并修复")');
      const detail = page.locator(".tool-detail:not([hidden])", { hasText: "检查了" });
      if (query) {
        await expect(detail).toContainText("检查了 510 条聊天，没有发现问题");
      } else {
        // ec1d1bfd: problems are "需检查"; ones Hub cannot fix say what further recovery needs.
        await expect(detail).toContainText("检查了 510 条聊天，发现 7 条需检查：");
        await expect(detail).toContainText("→ 可以修复：从旧版复制过来");
        await expect(detail).toContainText("→ 可以修复：换成新内容（旧内容另存一份）");
        await expect(detail).toContainText("（1 条已归档）");
        await expect(detail).toContainText("当前 Claude Code 记录目录中未找到会话文件");
        await expect(detail).toContainText("→ 需要进一步恢复：需检查旧目录、备份或隔离环境");
        await expect(detail).toContainText("旧服务商未在当前配置中");
        await expect(detail).not.toContainText("无法修复");
        await expect(detail.locator('button:has-text("修复 2 条")')).toBeVisible();
        await expect(detail).toContainText("含已删除的 1 条");
      }
      await detail.scrollIntoViewIfNeeded();
      await page.waitForFunction(
        () => !document.getElementById("boot")?.classList.contains("show"),
      );
      await page.waitForTimeout(400);
      await page.screenshot({
        path: path.join(dir, `${query ? "clean" : "problems"}-${width}.png`),
      });
    }
  }
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
  // Since 0.11.8 the mock runs Claude Code on its own login (no relay or token bound), so the
  // current login is the credential in use: 使用中, not 当前登录 (that is for a login that is
  // signed in while a token or relay is used, see the in-use test with ?claudeUses=key).
  const inUse = page.locator(".account-card.in-use");
  await expect(inUse).toHaveCount(1);
  await expect(inUse).toContainText("me@example.com");
  await expect(card("me@example.com").locator(".tag.in-use")).toHaveText("使用中");
  await expect(card("me@example.com")).not.toContainText("当前登录");
  await expect(card("me@example.com")).toContainText("剩 58%");
  await expect(card("me@example.com")).not.toContainText("切换到这个");
  await expect(card("工作号")).toContainText("剩 85%");
  await expect(card("工作号")).toContainText("切换到这个");
  await expect(card("旧号")).toContainText("登录已失效");
  // Auto-switch is offered (off) with the terms risk spelled out; see the auto-switch test.
  await expect(page.locator(".auto-switch")).toContainText("可能违反 Anthropic 的使用条款");
  await expect(page.locator('.auto-switch button[role="switch"]')).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await card("旧号").scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(dir, "cards.png") });

  // 网页登录 → dialog → paste a code → saved. Back to the top first: scrolling closes menus.
  await dismiss();
  await page.locator("#page").evaluate((element) => element.scrollTo(0, 0));
  await page.waitForTimeout(200);
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
  await expect(card("me@example.com")).toContainText("使用中");

  // 从文件导入: a wrong file first, then Claude Code's .credentials.json.
  const pick = async (name: string, content: string) => {
    await dismiss();
    await page.locator("#page").evaluate((element) => element.scrollTo(0, 0));
    await page.waitForTimeout(200);
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
  await expect(page.locator("#toast")).toContainText("新开的 Claude Code 对话生效");
  await expect(inUse).toHaveCount(1);
  await expect(card("工作号").locator(".tag.in-use")).toHaveText("使用中");
  await expect(card("me@example.com")).toContainText("切换到这个");
});

// Grok (测试版, pages/mock.js): a weekly and a monthly account and one whose saved login expired;
// adding one by `grok login` (finishes on its own, no code) and by an auth.json file.
// Live quota (pages/quota-live.js): every quota says how fresh it is and where it came from; a
// reply's numbers pushed by the service repaint 账号 and 首页 without a request; the Claude reset
// card opens claude.ai's usage page in a Hub window for that account and re-reads it on close.
test("live quota: freshness labels, pushed numbers, Claude reset window", async ({ page }) => {
  const dir = path.join(runDir, "live-quota");
  mkdirSync(dir, { recursive: true });
  const settled = async () => {
    await page.waitForFunction(() => !document.getElementById("boot")?.classList.contains("show"));
    await page.waitForTimeout(500);
  };
  const dismiss = await openAccountsTab(page, "OpenAI");
  const me = page.locator(".account-card", { hasText: "me@example.com" }).first();
  // quota.live (mock): a reply on the current account just brought its numbers.
  await expect(me.locator(".quota-fresh")).toContainText("刚刚");
  await expect(me.locator(".quota-fresh")).toContainText("随对话更新");
  const team = page.locator(".account-card", { hasText: "团队号" });
  await expect(team.locator(".quota-fresh")).toContainText("定时刷新");
  await expect(team.locator(".quota-fresh .info-tip")).toHaveAttribute("data-tip", /每 5 分钟/u);
  // A pushed reply for 团队号 replaces its numbers at once.
  await page.evaluate(() =>
    (window as unknown as { __hubShellMessage: (m: unknown) => void }).__hubShellMessage({
      event: "quota",
      params: {
        provider: "codex",
        id: "1123456789ab",
        usage: {
          windows: [{ kind: "primary", usedPercent: 70 }],
          fetchedAt: Math.floor(Date.now() / 1000),
          source: "live",
        },
        observedAt: Date.now() + 1000,
        source: "conversation",
      },
    }),
  );
  await expect(team).toContainText("剩 30%");
  await expect(team.locator(".quota-fresh")).toContainText("随对话更新");
  await dismiss();
  await settled();
  await page.screenshot({ path: path.join(dir, "accounts-codex.png"), fullPage: true });

  await page.click('.account-tabs button[aria-label^="Anthropic"]');
  const claude = page.locator(".account-card", { hasText: "工作号" });
  await expect(claude.locator(".quota-fresh")).toContainText("刚刚");
  const open = claude.locator('.reset-card.cards button:has-text("打开兑换页")');
  await expect(open).toBeVisible();
  await open.click();
  const opened = await page.evaluate(
    () => (window as unknown as { __hubClaudeUsageOpened?: unknown[] }).__hubClaudeUsageOpened,
  );
  expect(opened).toEqual([{ accountId: "abcdefabcdef", label: "work@example.com" }]);
  await settled();
  await page.screenshot({ path: path.join(dir, "accounts-claude.png"), fullPage: true });
  // Closing the window re-reads that account.
  await page.evaluate(() =>
    (window as unknown as { __hubShellMessage: (m: unknown) => void }).__hubShellMessage({
      event: "claudeUsageClosed",
      accountId: "abcdefabcdef",
    }),
  );
  await expect(claude.locator(".quota-fresh")).toContainText("手动");

  await page.click('.rail button[data-page="home"]');
  const work = page.locator(".work-quota");
  await expect(work.locator(".quota-fresh")).toContainText("刚刚");
  await settled();
  await page.screenshot({ path: path.join(dir, "home.png"), fullPage: true });
});

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
  await expect(page.locator(".account-head .beta-tag")).toHaveText("测试版");
  await expect(card("me@example.com")).toContainText("使用中");
  await expect(card("me@example.com")).toContainText("每周额度");
  await expect(card("SuperGrok 号")).toContainText("每月额度");
  await expect(card("SuperGrok 号")).toContainText("剩 36%");
  await expect(card("旧号")).toContainText("切换一次即可更新额度");
  await expect(page.locator(".auto-switch .beta-tag")).toHaveText("测试版");
  await expect(page.locator(".auto-switch")).toContainText("每周 / 每月额度");
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
    await page.locator("#page").evaluate((element) => element.scrollTo(0, 0));
    await page.waitForTimeout(200);
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

// Claude and Grok auto-switch (agent-auto-switch.ts, pages/account-cards.js): off by default, the
// same controls as Codex, and a one-time terms-risk confirmation before the first turn-on.
test("auto-switch: Claude and Grok need a one-time confirmation, Gemini stays off", async ({
  page,
}) => {
  const dir = path.join(runDir, "auto-switch");
  mkdirSync(dir, { recursive: true });
  for (const [tab, agent, vendor, fields] of [
    ["Anthropic", "claude", "Anthropic", ["5 小时额度", "每周额度", "到阈值时"]],
    ["xAI", "grok", "xAI", ["每周 / 每月额度", "到阈值时"]],
  ] as const) {
    const dismiss = await openAccountsTab(page, tab);
    const card = page.locator(`.auto-switch[data-agent="${agent}"]`);
    const toggle = card.locator('button[role="switch"]');
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    await expect(card).toContainText("自动切换账号");
    for (const field of fields)
      await expect(card.locator(".field", { hasText: field })).toBeVisible();
    await expect(card.locator('select[aria-label="切换方式"]')).toHaveValue("ask");
    await expect(card.locator('select[aria-label="切换方式"] option')).toHaveText([
      "先提醒我",
      "直接切换，自动生效",
    ]);
    await expect(card).toContainText("不会切到额度读不到的账号");
    if (agent === "grok") await expect(card.locator(".beta-tag")).toHaveText("测试版");
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, `${agent}-off.png`) });

    // First turn-on: the risk in plain words; 取消 leaves it off.
    await dismiss();
    await toggle.click();
    const dialog = page.locator('.dialog-backdrop.show .dialog[aria-label="开启自动切换？"]');
    await expect(dialog).toContainText(
      `自动在多个订阅账号之间轮换来绕开额度限制，可能违反 ${vendor} 的使用条款，存在账号被限制或封禁的风险。确定开启吗？`,
    );
    await page.waitForTimeout(400);
    await dialog.screenshot({ path: path.join(dir, `${agent}-confirm.png`) });
    await dialog.locator('button:has-text("取消")').click();
    await expect(dialog).toHaveCount(0);
    await expect(toggle).toHaveAttribute("aria-checked", "false");

    await toggle.click();
    await dialog.locator('button:has-text("确定开启")').click();
    await expect(page.locator("#toast")).toContainText("自动切换已开启");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    // The threshold and action controls save on change, like Codex's.
    await card.locator('select[aria-label="切换方式"]').selectOption("auto");
    await expect(card.locator('select[aria-label="切换方式"]')).toHaveValue("auto");
    // Off and on again: the confirmation is remembered, no second dialog.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".dialog-backdrop.show")).toHaveCount(0);
    await expect(card.locator('select[aria-label="切换方式"]')).toHaveValue("auto");
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(dir, `${agent}-on.png`) });
  }

  await openAccountsTab(page, "Google");
  const gemini = page.locator(".auto-switch");
  await expect(gemini).toHaveClass(/unsupported/u);
  await expect(gemini.locator('button[role="switch"]')).toHaveAttribute("aria-disabled", "true");
  await gemini.locator('button[role="switch"]').click({ force: true });
  await expect(page.locator(".dialog-backdrop.show")).toHaveCount(0);
  await page.screenshot({ path: path.join(dir, "gemini-off.png") });
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
  // Antigravity cannot keep accounts: the auto-switch card stays off with the reason.
  await expect(page.locator(".auto-switch")).toContainText("系统钥匙串");
  await expect(page.locator(".auto-switch")).toContainText("暂不支持");
  await expect(page.locator('.auto-switch button[role="switch"]')).toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await expect(page.locator('button:has-text("保存登录")')).toHaveAttribute(
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

// One no-account switch on 首页, 账号 → OpenAI and 中转站 (pages/no-account.js), and a reset card
// that is only used after a confirmation naming the account, the one card and the windows.
test("no-account switch everywhere, auto-applied; reset card confirm", async ({ page }) => {
  const dir = path.join(runDir, "settings-apply");
  mkdirSync(dir, { recursive: true });
  const settled = async () => {
    await page.waitForFunction(() => !document.getElementById("boot")?.classList.contains("show"));
    await page.waitForTimeout(400);
  };
  const dismiss = await openAccountsTab(page, "OpenAI");
  const accountsSwitch = page.locator(".no-account").first();
  await expect(accountsSwitch).toContainText("免登录用中转");
  await settled();
  await page.screenshot({ path: path.join(dir, "accounts-codex.png"), fullPage: true });

  // 0 cards: 使用 is disabled; >0: 使用 opens a confirmation and consumes nothing yet.
  const team = page.locator(".account-card", { hasText: "团队号" });
  await expect(team.locator(".reset-card.cards button")).toBeDisabled();
  const me = page.locator(".account-card", { hasText: "me@example.com" }).first();
  await me.locator('.reset-card.cards button:has-text("使用")').click();
  const confirm = page.locator('.dialog-backdrop.show .dialog[aria-label^="使用 1 张额度重置卡"]');
  await expect(confirm).toContainText("me@example.com");
  await expect(confirm).toContainText("现有 2 张，用后剩 1 张");
  await expect(confirm).toContainText("5 小时额度（现在剩");
  await page.waitForTimeout(300);
  await confirm.screenshot({ path: path.join(dir, "reset-confirm.png") });
  await confirm.locator('button:has-text("确认使用 1 张")').click();
  await expect(confirm).toContainText("额度已刷新");
  await confirm.screenshot({ path: path.join(dir, "reset-done.png") });
  await confirm.locator('button:has-text("完成")').click();

  // Turning it on from 账号 applies by itself; 首页 and 中转站 show the same state.
  await accountsSwitch.locator('button[role="switch"]').click();
  const enable = page.locator('.dialog-backdrop.show .dialog[aria-label="免登录用中转"]');
  await expect(enable).toContainText("自动让 Codex 重新打开一次");
  await enable.locator('button:has-text("开启并应用")').click();
  await expect(page.locator("#toast")).toContainText("Codex 正在自动重新打开");
  await expect(accountsSwitch).toContainText("已开启 · 默认模型 gpt-6-astra");
  await page.click('.rail button[data-page="home"]');
  await dismiss();
  const home = page.locator(".home-switch.no-account");
  await expect(home).toContainText("已开启 · 默认模型 gpt-6-astra");
  await expect(home.locator('button[role="switch"]')).toHaveAttribute("aria-checked", "true");
  await settled();
  await page.screenshot({ path: path.join(dir, "home.png"), fullPage: true });
  await page.click('.rail button[data-page="relays"]');
  await expect(page.locator(".relay-top .no-account")).toContainText("并自动应用到 Codex");
  await settled();
  await page.screenshot({ path: path.join(dir, "relays.png"), fullPage: true });
  await expect(page.locator("body")).not.toContainText("重启 Codex 生效");
});

// 开启 Hub 转发: a required first-run dialog with a single 开启 button (no ×, Esc or outside
// click) that names 设置 → 恢复纯净 as the way back. 统一渠道 is no longer a switch on any page.
test("hub routing: required one-button dialog, no switch on pages, 恢复纯净 in settings", async ({
  page,
}) => {
  const dir = path.join(runDir, "hub-routing");
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: WIDTHS[0] ?? 1240, height: HEIGHT });
  await page.goto("/index.html?gate");
  const gate = page.locator('.dialog-backdrop.show .dialog[aria-label="开启 Hub 转发"]');
  await gate.waitFor();
  await expect(gate.locator(".dialog-x")).toHaveCount(0);
  await expect(gate.locator(".dialog-foot button")).toHaveCount(1);
  await expect(gate).toContainText("设置 → 恢复纯净");
  await page.screenshot({ path: path.join(dir, "gate.png") });
  await page.keyboard.press("Escape");
  await expect(gate).toBeVisible();
  await gate.getByRole("button", { name: "开启" }).click();
  await expect(gate).toBeHidden();
  for (const target of ["home", "relays", "accounts"]) {
    await page.click(`.rail button[data-page="${target}"]`);
    await expect(page.locator(".unified-channel")).toHaveCount(0);
  }
  await expect(page.locator("body")).not.toContainText("代理在线");
  await page.click('.rail button[data-page="settings"]');
  await page.click('.settings-menu button:has-text("恢复纯净")');
  const pure = page.locator(".pure");
  await expect(pure).toContainText("已保存的账号、中转站和 Key 会保留");
  const restore = pure.getByRole("button", { name: "恢复纯净状态" });
  await restore.click();
  await expect(restore).toHaveClass(/armed/);
  await pure.getByRole("button", { name: "确认恢复" }).click();
  await expect(pure).toContainText("已恢复纯净状态");
  await page.screenshot({ path: path.join(dir, "pure.png"), fullPage: true });
});

// The former web console lives in the Hub: the shell's navigate event (Launcher / Codex entries)
// opens these pages, and nothing opens a browser page.
test("web console functions inside the Hub: remote hosts, usage, session import", async ({
  page,
  context,
}) => {
  const dir = path.join(runDir, "console-features");
  mkdirSync(dir, { recursive: true });
  const popups: string[] = [];
  context.on("page", (popup) => popups.push(popup.url()));
  await page.setViewportSize({ width: WIDTHS[0] ?? 1240, height: HEIGHT });
  await page.goto("/index.html");
  const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
  await update.waitFor({ timeout: 5000 }).catch(() => undefined);
  if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();
  const navigate = (target: string) =>
    page.evaluate((name) => {
      const w = window as unknown as { __hubShellMessage: (data: unknown) => void };
      w.__hubShellMessage({ event: "navigate", page: name });
    }, target);

  await navigate("remote");
  await expect(page.locator("#title")).toHaveText("设置");
  await expect(page.locator(".settings-menu button.on")).toHaveText("远程连接");
  const row = page.locator(".remote-row", { hasText: "开发机" });
  await expect(row).toContainText("未连接");
  await expect(row.locator('button:has-text("连接")')).toBeVisible();
  await page.screenshot({ path: path.join(dir, "remote.png"), fullPage: true });

  await navigate("usage");
  await expect(page.locator(".usage-tiles")).toContainText("1.8K");
  await expect(page.locator(".usage-table")).toContainText("claude-code");
  await page.locator('.segment button:has-text("30 天")').click();
  await expect(page.locator(".usage-tiles")).toContainText("$38.42");
  await page.screenshot({ path: path.join(dir, "usage.png"), fullPage: true });

  // Unknown pages are ignored (accounts became a page Codex may ask for).
  await navigate("no-such-page");
  await expect(page.locator(".settings-menu button.on")).toHaveText("用量统计");

  await navigate("maintenance");
  await page.locator('.tool:has-text("会话导入") button:has-text("导入会话")').click();
  const dialog = page.locator('.dialog-backdrop.show .dialog[aria-label="会话导入"]');
  await expect(dialog).toContainText("重构登录流程");
  await page.waitForTimeout(300);
  await dialog.screenshot({ path: path.join(dir, "session-import.png") });
  await dialog.locator('.session-row button:has-text("导入")').click();
  await expect(page.locator("#toast")).toContainText("已导入");
  expect(popups).toEqual([]);
});

// Explanations show one short line; the whole sentence is behind an ⓘ that hover, keyboard focus
// and tap all open, and that screen readers get through aria-describedby. Warnings stay visible.
test("short explanations keep their full text in an accessible ⓘ tooltip", async ({ page }) => {
  const dir = path.join(runDir, "tooltips");
  mkdirSync(dir, { recursive: true });
  await page.setViewportSize({ width: WIDTHS[0] ?? 1240, height: HEIGHT });
  await page.goto("/index.html");
  const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
  await update.waitFor({ timeout: 5000 }).catch(() => undefined);
  if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();
  await page.click('.rail button[data-page="maintenance"]');
  const diagnose = page.locator(".tool", { hasText: "系统诊断" });
  await expect(diagnose.locator(".brief-text")).toHaveText(
    "检查连接、模型、配置、登录和代理，给出修复",
  );
  const info = diagnose.locator(".info-tip");
  const full =
    "一次检查 Codex 能否连上模型服务、模型是否被拒、配置、登录、零号核心和本地中转代理；发现问题直接给出修复按钮，修好后可一键重启 Codex。";
  const describedBy = await info.getAttribute("aria-describedby");
  await expect(page.locator(`#${describedBy}`)).toHaveText(full);
  const bubble = page.locator(".tip-bubble");
  await info.focus();
  await expect(bubble).toHaveClass(/show/u);
  await expect(bubble).toHaveText(full);
  await page.screenshot({ path: path.join(dir, "focus.png") });
  await page.keyboard.press("Escape");
  await expect(bubble).not.toHaveClass(/show/u);
  await info.click();
  await expect(bubble).toHaveClass(/show/u);
  await page.mouse.click(5, 5);
  await expect(bubble).not.toHaveClass(/show/u);
  // The terms risk stays readable without opening anything.
  await page.click('.rail button[data-page="accounts"]');
  await page.click('.account-tabs button:has-text("Anthropic")');
  await expect(page.locator(".auto-switch .quota-note .brief-text").first()).toContainText(
    "使用条款",
  );
});

// Everything the in-Codex settings panel had now lives here: Codex opens these Hub pages by name
// (`rly0-hub.exe --page`), the 更多 agents unfold with the same cards, 首页 has the Codex overview
// and 设置 → 通用 has the options for Codex itself.
for (const width of WIDTHS) {
  test(`former in-Codex settings pages @${width}`, async ({ page }) => {
    const dir = path.join(runDir, "merged", String(width));
    mkdirSync(dir, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error.message)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto("/index.html");
    const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
    await update.waitFor({ timeout: 5000 }).catch(() => undefined);
    if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();

    // 首页 → Codex 概况 (the old 仪表盘).
    const overview = page.locator(".codex-overview");
    await expect(overview.locator(".overview-stat")).toHaveCount(4);
    await expect(overview.locator(".activity-day")).toHaveCount(84);
    await expect(overview.locator(".activity-head")).toContainText("最近 12 周");
    await overview.screenshot({ path: path.join(dir, "home-overview.png") });

    // Codex asks for pages by name; every former settings page has one.
    const send = (pageName: string) =>
      page.evaluate((name) => {
        (window as unknown as { __hubShellMessage(data: unknown): void }).__hubShellMessage({
          event: "navigate",
          page: name,
        });
      }, pageName);
    for (const [name, title] of [
      ["agents", "AI 助手"],
      ["threads", "打通设置"],
      ["mcp", "打通设置"],
      ["skills", "打通设置"],
      ["general", "设置"],
      ["remote", "设置"],
      ["usage", "设置"],
      ["accounts", "账号"],
      ["relays", "中转站"],
      ["support", "支持"],
      ["maintenance", "维护工具"],
    ] as const) {
      await send(name);
      await expect(page.locator("#title")).toHaveText(title);
    }
    await send("sessions");
    await expect(
      page.locator('.dialog-backdrop.show .dialog[aria-label="会话导入"]'),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    // AI 助手 → 更多 Agent: folded, then the same cards with install and 应用路径.
    await send("agents");
    const more = page.locator("details[data-agent-more]");
    await expect(more).not.toHaveAttribute("open", "");
    await expect(more.locator(":scope > summary")).toContainText("更多 Agent（8）");
    await more.locator(":scope > summary").click();
    await expect(more.locator(".agent-card")).toHaveCount(8);
    const zcode = more.locator(".agent-card", { hasText: "ZCode" });
    await zcode.locator("details.launch-path summary").click();
    await zcode.locator("details.launch-path input").fill("D:\\Apps\\ZCode");
    await zcode.locator("details.launch-path button", { hasText: "保存" }).click();
    await expect(page.locator(".toast").last()).toContainText("重启 Codex 后生效");
    await zcode.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(dir, "agents-more.png") });

    // 设置 → 通用 → Codex 里.
    await send("general");
    const prefs = page.locator(".codex-prefs");
    await expect(prefs.locator(".pref-row")).toHaveCount(5);
    await prefs.locator('select[aria-label="强调色"]').selectOption("blue");
    await expect(page.locator(".toast").last()).toContainText("回到 Codex 窗口就生效");
    await prefs.screenshot({ path: path.join(dir, "general-codex.png") });

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);
    expect(errors).toEqual([]);
  });
}

// 打通设置: one table of what every agent gets, the opt-in global blocks, and the shared memory.
for (const width of WIDTHS) {
  test(`打通设置 and shared memory @${width}`, async ({ page }) => {
    const dir = path.join(runDir, "bridge", String(width));
    mkdirSync(dir, { recursive: true });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error.message)));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.setViewportSize({ width, height: HEIGHT });
    await page.goto("/index.html");
    const update = page.locator('.dialog-backdrop.show .dialog[aria-label^="发现新版本"]');
    await update.waitFor({ timeout: 5000 }).catch(() => undefined);
    if (await update.isVisible().catch(() => false)) await update.locator(".dialog-x").click();
    const settled = async () => {
      await page.waitForFunction(
        () => !document.getElementById("boot")?.classList.contains("show"),
        null,
        { timeout: 8000 },
      );
      await page.waitForTimeout(500); // the loading cover fades out
    };
    const noOverflow = async () =>
      expect(
        await page.evaluate(() => {
          const el = document.getElementById("page");
          return Math.max(
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
            el ? el.scrollWidth - el.clientWidth : 0,
          );
        }),
      ).toBeLessThanOrEqual(1);

    await page.click('.rail button[data-page="bridge"]');
    await expect(page.locator("#title")).toHaveText("打通设置");
    const card = page.locator(".share-card");
    await expect(card.locator('button[role="switch"][aria-label="打通记忆"]')).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await expect(card.locator('tr[data-agent="codex"]')).toContainText("已接通");
    await expect(card.locator('tr[data-agent="pi"] td').nth(0)).toHaveText("✓ 已接通");
    await expect(card.locator('tr[data-agent="opencode"] td').nth(1)).toContainText("提示注入");
    await expect(card.locator('tr[data-agent="grok"] td').nth(0)).toHaveText("需要安装");
    await expect(card.locator('tr[data-agent="deepseek-harness"] td').nth(0)).toHaveText("不支持");
    await expect(card.locator('tr[data-agent="hermes"] td').nth(0)).toHaveText("需单独开启");
    await settled();
    await page.screenshot({ path: path.join(dir, "overview.png"), fullPage: false });
    await card.locator('[data-global="hermes"] button[role="switch"]').click();
    await expect(page.locator(".toast").last()).toContainText("备份");
    await expect(card.locator('tr[data-agent="hermes"] td').nth(0)).toHaveText("已接通 · 全局");
    await expect(card.locator('[data-global="hermes"]')).toContainText("带密钥未写入");
    await card.locator('button[role="switch"][aria-label="打通记忆"]').click();
    await expect(card.locator('tr[data-agent="pi"] td').nth(2)).toHaveText("已关闭");
    await card.locator('button[role="switch"][aria-label="打通记忆"]').click();
    await expect(card.locator('tr[data-agent="pi"] td').nth(2)).toHaveText("✓ 已接通");
    await noOverflow();
    await card.locator(".share-globals").scrollIntoViewIfNeeded();
    await settled();
    await page.screenshot({ path: path.join(dir, "overview-globals.png") });

    // 记忆: search, add, delete, export.
    await page.locator(".bridge-tabs button", { hasText: "记忆" }).click();
    const items = page.locator(".memory-item");
    await expect(items).toHaveCount(3);
    await page.locator('input[aria-label="搜索记忆"]').fill("typecheck");
    await expect(items).toHaveCount(1);
    await page.locator('input[aria-label="搜索记忆"]').fill("");
    await expect(items).toHaveCount(3);
    await page.locator('.memory-filter button[role="tab"]', { hasText: "全局" }).click();
    await expect(items).toHaveCount(1);
    await page.locator('.memory-filter button[role="tab"]', { hasText: "全部" }).click();
    await page.locator('textarea[aria-label="记忆内容"]').fill("所有助手都用 pnpm");
    await page.locator("button", { hasText: "记住" }).click();
    await expect(items).toHaveCount(4);
    const remove = items.first().locator("button", { hasText: "删除" });
    await remove.click();
    await expect(remove).toHaveText("确认删除");
    await remove.click();
    await expect(items).toHaveCount(3);
    await page.locator(".memory-actions button", { hasText: "导出" }).click();
    await expect(page.locator(".toast").last()).toContainText("已导出 3 条");
    await noOverflow();
    await page.locator(".memory-list").scrollIntoViewIfNeeded();
    await settled();
    await page.screenshot({ path: path.join(dir, "memory.png") });

    // MCP: edit keeps the list in one place.
    await page.locator(".bridge-tabs button", { hasText: "MCP" }).click();
    await expect(page.locator("#title")).toHaveText("打通设置");
    const first = page.locator(".grid.compact section.m").first();
    await first.locator("button", { hasText: "修改" }).click();
    await expect(page.locator("h2.section-title", { hasText: "修改" })).toBeVisible();
    await page.locator("button", { hasText: "取消修改" }).click();
    await page.locator(".bridge-tabs button", { hasText: "技能" }).click();
    await expect(page.locator("button", { hasText: "打开文件夹" })).toBeVisible();
    await page.locator(".bridge-tabs button", { hasText: "线程" }).click();
    await expect(page.locator(".bridge-tabs button.on")).toHaveText("线程");
    await noOverflow();

    // AI 助手 points here instead of holding the switches.
    await page.click('.rail button[data-page="agents"]');
    await page.locator(".share-link button", { hasText: "打通设置" }).click();
    await expect(page.locator(".bridge-tabs button.on")).toHaveText("概览");
    expect(errors).toEqual([]);
  });
}
