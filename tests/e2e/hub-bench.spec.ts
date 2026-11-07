// Functional bench of the macOS RLY/0 Hub: every page and its functions against the real Hub
// service of a built RLY0 Hub.app (tests/e2e/hub-bench/fixture.ts). All data is synthetic and
// lives in a throwaway HOME; the service is sandboxed away from the live Codex, Hub and Core.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "@playwright/test";

import { expect, test, type Hub } from "./hub-bench/fixture.js";

const runDir = process.env.HUB_BENCH_RUN || path.resolve(".local-test/bench/manual");

async function settled(page: Page) {
  await expect(page.locator("#boot")).not.toHaveClass(/\bshow\b/u, { timeout: 30_000 });
  await page.waitForTimeout(400);
}

/** The synthetic relay of a test run with `benchFakeRelay`. */
function fakeRelay(hub: Hub) {
  if (!hub.relay) throw new Error("this test needs test.use({ benchFakeRelay: true })");
  return hub.relay;
}

async function start(hub: Hub, page: Page) {
  await hub.open();
  await settled(page);
}

async function rail(page: Page, id: string) {
  await page.click(`.rail button[data-page="${id}"]`);
  await settled(page);
}

async function settingsSection(page: Page, label: string) {
  await rail(page, "settings");
  await page.locator(".settings-menu button", { hasText: label }).first().click();
  await settled(page);
}

async function bridgeTab(page: Page, label: string) {
  await rail(page, "bridge");
  await page.locator(".bridge-tabs button", { hasText: label }).first().click();
  await settled(page);
}

async function accountsTab(page: Page, label: string) {
  await rail(page, "accounts");
  await page.click(`.account-tabs button[aria-label^="${label}"]`);
  await settled(page);
}

/** Skips the first-run gate and wizard the way a returning user would see the Hub. */
async function onboarded(hub: Hub) {
  await hub.service.call("hub.enableChannel", {});
  await hub.service.call("hub.finishOnboarding", {});
}

function record(name: string, value: unknown) {
  const directory = path.join(runDir, "records");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

function failedCalls(hub: Hub) {
  return hub.calls
    .filter((call) => call.error)
    .map((call) => ({ method: call.method, params: call.params, error: call.error }));
}

type Stop = { id: string; go: (page: Page) => Promise<void> };
const TOUR: Stop[] = [
  ...["home", "relays", "agents", "maintenance", "support"].map((id): Stop => ({
    id,
    go: (page) => rail(page, id),
  })),
  ...(
    [
      ["codex", "OpenAI"],
      ["claude", "Anthropic"],
      ["gemini", "Google"],
      ["grok", "xAI"],
    ] as const
  ).map(([id, label]): Stop => ({ id: `accounts-${id}`, go: (page) => accountsTab(page, label) })),
  ...(
    [
      ["general", "通用"],
      ["instructions", "自定义指令"],
      ["network", "网络代理"],
      ["backup", "备份"],
      ["pure", "恢复纯净"],
      ["remote", "远程连接"],
      ["usage", "用量统计"],
      ["updates", "更新"],
    ] as const
  ).map(([id, label]): Stop => ({
    id: `settings-${id}`,
    go: (page) => settingsSection(page, label),
  })),
  ...(
    [
      ["overview", "概览"],
      ["mcp", "MCP"],
      ["skills", "技能"],
      ["memory", "记忆"],
      ["threads", "线程"],
    ] as const
  ).map(([id, label]): Stop => ({ id: `bridge-${id}`, go: (page) => bridgeTab(page, label) })),
];

test.describe("page tour (real service)", () => {
  for (const stop of TOUR) {
    test(`tour ${stop.id}`, async ({ page, hub }) => {
      await onboarded(hub);
      await hub.open();
      await settled(page);
      await stop.go(page);
      // Let page pollers make their first round of calls.
      await page.waitForTimeout(2500);
      const shots = path.join(runDir, "tour");
      mkdirSync(shots, { recursive: true });
      // caret "initial": no injected style (the Hub's CSP would refuse it and log an error).
      await page.screenshot({
        path: path.join(shots, `${stop.id}.png`),
        fullPage: true,
        caret: "initial",
      });
      const failures = failedCalls(hub);
      record(`tour-${stop.id}`, {
        failures,
        issues: hub.issues,
        calls: hub.calls.map((c) => c.method),
      });
      const pageErrors = hub.issues.filter((issue) =>
        [
          "pageerror",
          "resource-rejected",
          "resource-missing",
          "remote-load",
          "bridge-rejected",
        ].includes(issue.type),
      );
      expect(pageErrors, "page errors / rejected resources").toEqual([]);
    });
  }
});

/* ---------- functions ---------- */

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A synthetic Codex ChatGPT login (auth.json); tokens are placeholders, never valid anywhere. */
function syntheticCodexAuth(name: string, plan = "plus") {
  const payload = {
    email: `${name}@bench.invalid`,
    "https://api.openai.com/auth": {
      chatgpt_plan_type: plan,
      chatgpt_account_id: `acc-bench-${name}`,
    },
  };
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `${b64url({ alg: "none" })}.${b64url(payload)}.synthetic`,
      access_token: `synthetic-access-${name}`,
      refresh_token: `synthetic-refresh-${name}`,
      account_id: `acc-bench-${name}`,
    },
    last_refresh: new Date().toISOString(),
  });
}

async function toastText(page: Page) {
  const toast = page.locator("#toast");
  await expect(toast).not.toHaveText("", { timeout: 15_000 });
  return (await toast.textContent()) || "";
}

async function addMenu(page: Page, item: string) {
  await page.getByRole("button", { name: "+ 添加" }).first().click();
  await page.getByText(item, { exact: false }).first().click();
}

test.describe("functions (real service)", () => {
  test("界面大小: opens at 100% and changes for this run only", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    await settingsSection(page, "通用");
    const sizes = page.locator('.zoom-steps[aria-label="界面大小"]');
    await expect(sizes.locator('button[aria-checked="true"]')).toContainText("标准");
    await expect(page.getByText("当前 100%，重开 Hub 恢复 100%")).toBeVisible();
    await sizes.locator("button", { hasText: "大" }).filter({ hasText: "110%" }).click();
    await expect(page.getByText("当前 110%，重开 Hub 恢复 100%")).toBeVisible();
    await expect(sizes.locator('button[aria-checked="true"]')).toContainText("110%");
  });

  test.describe(() => {
    test.use({ benchFakeRelay: true });
    test("中转站: add, test, pick models, save, disable, delete", async ({ page, hub }) => {
      const { GOOD_KEY, MODELS } = await import("./hub-bench/fake-relay.mjs");
      const relay = fakeRelay(hub);
      {
        await onboarded(hub);
        await start(hub, page);
        await rail(page, "relays");
        await page
          .getByRole("button", { name: /添加中转站/u })
          .first()
          .click();
        const dialog = page.locator(".dialog-backdrop.show .dialog").first();
        await dialog.getByLabel("中转站地址").fill(relay.baseUrl);
        await dialog.getByLabel("API Key").fill(GOOD_KEY);
        await dialog.getByRole("button", { name: "测试" }).click();
        await expect(dialog.locator(".relay-test")).toContainText("连通", { timeout: 30_000 });
        for (const model of MODELS) await expect(dialog.getByText(model).first()).toBeVisible();
        await dialog.getByRole("button", { name: "保存" }).click();
        await expect(dialog).toBeHidden({ timeout: 15_000 });
        const card = page.locator(".relay-card").filter({ hasText: "127.0.0.1" }).first();
        await expect(card).toBeVisible();
        await expect(card).toContainText("12.34", { timeout: 30_000 });
        const list = (await hub.service.call("relay.list")) as {
          relays: { id: string; enabled: boolean; models: string[] }[];
        };
        expect(list.relays).toHaveLength(1);
        expect(list.relays[0]?.enabled).toBe(true);
        expect(list.relays[0]?.models.length).toBeGreaterThan(0);
        await card.locator("button.switch").click();
        await expect
          .poll(
            async () => ((await hub.service.call("relay.list")) as typeof list).relays[0]?.enabled,
          )
          .toBe(false);
        // Armed buttons animate their countdown, so they never count as "stable".
        await card.getByRole("button", { name: "删除" }).click({ force: true });
        await card.getByRole("button", { name: "确认删除" }).click({ force: true });
        await expect
          .poll(async () => ((await hub.service.call("relay.list")) as typeof list).relays.length)
          .toBe(0);
        expect(relay.requests.some((r) => r.path === "/v1/models" && r.auth)).toBe(true);
      }
    });

    test("中转站: a wrong key is reported, nothing is saved", async ({ page, hub }) => {
      const relay = fakeRelay(hub);
      {
        await onboarded(hub);
        await start(hub, page);
        await rail(page, "relays");
        await page
          .getByRole("button", { name: /添加中转站/u })
          .first()
          .click();
        const dialog = page.locator(".dialog-backdrop.show .dialog").first();
        await dialog.getByLabel("中转站地址").fill(relay.baseUrl);
        await dialog.getByLabel("API Key").fill("sk-bench-synthetic-wrong-key");
        await dialog.getByRole("button", { name: "测试" }).click();
        await expect(dialog.locator(".relay-test")).toContainText("没通过", { timeout: 30_000 });
        await dialog.getByRole("button", { name: "取消" }).click();
        await expect
          .poll(
            async () =>
              ((await hub.service.call("relay.list")) as { relays: unknown[] }).relays.length,
          )
          .toBe(0);
      }
    });
  });

  test("账号 OpenAI: save the current login, import a file, rename, switch, delete", async ({
    page,
    hub,
  }) => {
    const { writeFileSync: write, mkdirSync: mkdir } = await import("node:fs");
    await onboarded(hub);
    mkdir(path.join(hub.service.home, ".codex"), { recursive: true });
    write(path.join(hub.service.home, ".codex", "auth.json"), syntheticCodexAuth("alpha"));
    await start(hub, page);
    await accountsTab(page, "OpenAI");
    await page.getByRole("button", { name: "保存登录" }).click();
    expect(await toastText(page)).toContain("已保存当前登录");
    await expect(page.getByText("alpha@bench.invalid").first()).toBeVisible();
    // Import a second login through the file picker.
    const chooser = page.waitForEvent("filechooser");
    await addMenu(page, "导入登录文件");
    await (
      await chooser
    ).setFiles({
      name: "auth.json",
      mimeType: "application/json",
      buffer: Buffer.from(syntheticCodexAuth("beta", "pro")),
    });
    await expect(page.getByText("beta@bench.invalid").first()).toBeVisible({ timeout: 15_000 });
    const listed = (await hub.service.call("accounts.list")) as {
      accounts: { id: string; email?: string; current?: boolean }[];
    };
    expect(listed.accounts.map((a) => a.email).sort()).toEqual([
      "alpha@bench.invalid",
      "beta@bench.invalid",
    ]);
    record("accounts-codex-list", listed);
  });

  test("账号 Anthropic: save an API key, rename it, delete it", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    await accountsTab(page, "Anthropic");
    await addMenu(page, "订阅令牌 / API Key");
    const input = page.locator('.key-card input[type="password"]').first();
    await input.fill("sk-ant-api03-bench-synthetic-0011223344556677");
    await page.locator(".key-card").getByRole("button", { name: "保存" }).first().click();
    expect(await toastText(page)).toContain("已独立保存");
    await expect
      .poll(async () => JSON.stringify(await hub.service.call("agents.officialKeys.list")))
      .toContain("6677");
    record("accounts-claude-keys", await hub.service.call("agents.officialKeys.list"));
  });

  test("打通 MCP: add a stdio server, disable it, remove it", async ({ page, hub }) => {
    const { readFileSync: read, existsSync: exists } = await import("node:fs");
    await onboarded(hub);
    await start(hub, page);
    await bridgeTab(page, "MCP");
    await page.getByRole("button", { name: "+ 添加" }).first().click();
    await page.getByPlaceholder("例如：docs").fill("bench-echo");
    await page.getByPlaceholder("例如：npx").fill("/bin/echo");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(page.getByText("bench-echo").first()).toBeVisible({ timeout: 15_000 });
    const config = path.join(hub.service.home, ".codex", "config.toml");
    await expect.poll(() => (exists(config) ? read(config, "utf8") : "")).toContain("bench-echo");
    record("mcp-config", { config: read(config, "utf8") });
  });

  test("打通 记忆: remember, pin, forget", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    await bridgeTab(page, "记忆");
    const text = "合成测试记忆：bench 只用于验证";
    await page.getByRole("button", { name: "+ 添加" }).first().click();
    await page.getByPlaceholder("要所有助手记住的事，不要写密钥").fill(text);
    await page.getByRole("button", { name: "记住" }).click();
    await expect(page.getByText(text).first()).toBeVisible({ timeout: 15_000 });
    record(
      "memory-list",
      await hub.service.call("memory.list", { scope: "global", pinned: false }),
    );
  });

  test("自定义指令: preview, apply, clear", async ({ page, hub }) => {
    const { readFileSync: read, existsSync: exists } = await import("node:fs");
    await onboarded(hub);
    await start(hub, page);
    await settingsSection(page, "自定义指令");
    const content = "# 合成测试指令\n只用于 bench 验证。\n";
    await page.locator("textarea").first().fill(content);
    await page.getByRole("button", { name: /预览并应用/u }).click();
    await page.getByRole("button", { name: /确认应用/u }).click();
    const agents = path.join(hub.service.home, ".codex", "AGENTS.md");
    await expect.poll(() => (exists(agents) ? read(agents, "utf8") : "")).toContain("合成测试指令");
  });

  test("首次打开: the channel gate, then the guide can be skipped", async ({ page, hub }) => {
    await hub.open();
    const gate = page.locator(".dialog-backdrop.show .dialog").first();
    await expect(gate).toBeVisible({ timeout: 20_000 });
    await gate.getByRole("button", { name: "开启" }).click();
    await expect(page.getByRole("button", { name: "跳过引导" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: "跳过引导" }).click();
    await settled(page);
    const state = (await hub.service.call("hub.state")) as {
      onboarded?: boolean;
      channelConsented?: boolean;
    };
    expect(state.channelConsented).toBe(true);
    expect(state.onboarded).toBe(true);
  });

  test("打开 Codex: answered without touching the running Codex", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    // The button pulses while Codex is closed; a pulsing element never counts as "stable".
    await page.click("#codexFab", { force: true });
    const text = await toastText(page);
    record("codex-open", { toast: text, calls: hub.callsTo("codex.open") });
    expect(hub.callsTo("codex.open").length).toBeGreaterThan(0);
  });

  test("更新: offline check is reported, nothing is installed", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    await settingsSection(page, "更新");
    await page.getByRole("button", { name: /重新检查/u }).click();
    await page.waitForTimeout(3000);
    record("updates-offline", { calls: hub.callsTo("updates.status"), issues: hub.issues });
    expect(hub.callsTo("updates.install")).toHaveLength(0);
  });

  test("维护: diagnostics run and report", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    await rail(page, "maintenance");
    await page.getByRole("button", { name: /运行诊断/u }).click();
    await hub.waitForCall("maintenance.diagnostics");
    await page.waitForTimeout(2000);
    record("maintenance-diagnostics", { calls: hub.callsTo("maintenance.diagnostics") });
    expect(hub.callsTo("maintenance.diagnostics")[0]?.error).toBeUndefined();
  });
});

test.describe("functions, second round (real service)", () => {
  test("账号 OpenAI: rename, switch, delete a saved login", async ({ page, hub }) => {
    const { writeFileSync: write, mkdirSync: mkdir, readFileSync: read } = await import("node:fs");
    await onboarded(hub);
    const codexHome = path.join(hub.service.home, ".codex");
    mkdir(codexHome, { recursive: true });
    write(path.join(codexHome, "auth.json"), syntheticCodexAuth("gamma"));
    await hub.service.call("accounts.importCurrent", {});
    write(path.join(codexHome, "auth.json"), syntheticCodexAuth("delta"));
    await hub.service.call("accounts.importCurrent", {});
    await start(hub, page);
    await accountsTab(page, "OpenAI");
    const gamma = page.locator(".account-card").filter({ hasText: "gamma@bench.invalid" }).first();
    await expect(gamma).toBeVisible();
    // Rename by clicking the name.
    await gamma.locator(".renamable").click();
    await page.locator(".rename-input").fill("测试主号");
    await page.locator(".rename-input").press("Enter");
    expect(await toastText(page)).toContain("已改名");
    const renamed = page.locator(".account-card").filter({ hasText: "测试主号" }).first();
    // Switch to it: the live auth.json becomes gamma's.
    await renamed.getByRole("button", { name: "切换到这个" }).click();
    await expect
      .poll(() => read(path.join(codexHome, "auth.json"), "utf8"))
      .toContain("synthetic-refresh-gamma");
    await expect(renamed).toContainText("使用中", { timeout: 15_000 });
    // Delete the other one (two taps).
    const other = page.locator(".account-card").filter({ hasText: "delta@bench.invalid" }).first();
    await other.getByRole("button", { name: "删除" }).click({ force: true });
    await other.getByRole("button", { name: "确认删除" }).click({ force: true });
    await expect
      .poll(
        async () =>
          ((await hub.service.call("accounts.list")) as { accounts: unknown[] }).accounts.length,
      )
      .toBe(1);
    record("accounts-codex-second", { calls: failedCalls(hub) });
  });

  test("账号 Anthropic: a saved key can be deleted", async ({ page, hub }) => {
    await onboarded(hub);
    await hub.service
      .call("agents.officialKeys.set", {
        vendor: "anthropic",
        apiKey: "sk-ant-api03-bench-synthetic-8899aabbccddeeff",
      })
      .catch(() => undefined);
    await start(hub, page);
    await accountsTab(page, "Anthropic");
    const card = page.locator(".key-card").filter({ hasText: "eeff" }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.getByRole("button", { name: "删除" }).click({ force: true });
    await card.getByRole("button", { name: "确认删除" }).click({ force: true });
    await expect
      .poll(async () => JSON.stringify(await hub.service.call("agents.officialKeys.list")))
      .not.toContain("eeff");
  });

  test("打通 MCP: disable and remove a server", async ({ page, hub }) => {
    const { readFileSync: read } = await import("node:fs");
    await onboarded(hub);
    await hub.service.call("mcp.add", {
      name: "bench-two",
      type: "stdio",
      command: "/bin/echo",
      args: [],
    });
    await start(hub, page);
    await bridgeTab(page, "MCP");
    const row = page.locator(".m, .list-item, section").filter({ hasText: "bench-two" }).last();
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: /停用/u }).first().click({ force: true });
    await expect
      .poll(async () => JSON.stringify(await hub.service.call("mcp.list")))
      .toMatch(/"name":"bench-two"[^}]*"enabled":false|"enabled":false[^}]*"name":"bench-two"/u);
    record("mcp-after-disable", await hub.service.call("mcp.list"));
    const config = path.join(hub.service.home, ".codex", "config.toml");
    record("mcp-config-after-disable", { config: read(config, "utf8") });
  });

  test("打通 记忆: a memory can be forgotten", async ({ page, hub }) => {
    await onboarded(hub);
    await hub.service.call("memory.add", { text: "合成记忆：待删除", scope: "global" });
    await start(hub, page);
    await bridgeTab(page, "记忆");
    const item = page.locator(".memory-item").filter({ hasText: "合成记忆：待删除" }).first();
    await expect(item).toBeVisible({ timeout: 15_000 });
    await item.getByRole("button", { name: "删除" }).click({ force: true });
    await item.getByRole("button", { name: /确认/u }).click({ force: true });
    await expect
      .poll(async () =>
        JSON.stringify(await hub.service.call("memory.list", { scope: "global", pinned: false })),
      )
      .not.toContain("待删除");
  });

  test("打通 技能: import a skill folder", async ({ page, hub }) => {
    const { mkdirSync: mkdir, writeFileSync: write } = await import("node:fs");
    await onboarded(hub);
    const source = path.join(hub.service.root, "tmp", "bench-skill");
    mkdir(source, { recursive: true });
    write(
      path.join(source, "SKILL.md"),
      "---\nname: bench-skill\ndescription: 合成测试技能\n---\n只用于 bench。\n",
    );
    await hub.service.call("skills.import", { sourcePath: source });
    await start(hub, page);
    await bridgeTab(page, "技能");
    await expect(page.getByText("bench-skill").first()).toBeVisible({ timeout: 15_000 });
  });

  test("远程连接 / 用量统计: say Codex is not running instead of a generic error", async ({
    page,
    hub,
  }) => {
    await onboarded(hub);
    await start(hub, page);
    await settingsSection(page, "远程连接");
    await page.waitForTimeout(1500);
    const text = (await page.locator("#page").textContent()) || "";
    const toast = (await page.locator("#toast").textContent()) || "";
    record("remote-closed", { text: text.slice(0, 600), toast, calls: failedCalls(hub) });
    expect(`${text} ${toast}`).toMatch(/Codex/u);
    expect(toast).not.toContain("操作没有成功");
  });

  test("网络代理: a custom proxy needs an address; the field shows only for it", async ({
    page,
    hub,
  }) => {
    await onboarded(hub);
    await start(hub, page);
    await settingsSection(page, "网络代理");
    const url = page.getByLabel("代理地址");
    await expect(url).toBeHidden();
    await page.locator("select[aria-label='代理模式']").selectOption("custom", { force: true });
    await expect(url).toBeVisible();
    await page.getByRole("button", { name: "保存" }).click();
    expect(await toastText(page)).toContain("请填写代理地址");
    expect(hub.callsTo("proxy.settingsSet")).toHaveLength(0);
    await url.fill("http://127.0.0.1:9");
    await page.getByRole("button", { name: "保存" }).click();
    await hub.waitForCall("proxy.settingsSet");
    expect(hub.callsTo("proxy.settingsSet")[0]?.error).toBeUndefined();
  });

  test("Mac wording: notices, manual install, guide", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    await settingsSection(page, "通用");
    await expect(page.getByText("通知提醒").first()).toBeVisible();
    await expect(page.getByText("托盘提醒")).toHaveCount(0);
    await rail(page, "agents");
    const manual = page.locator("details.manual").first();
    if (await manual.count()) {
      await manual.locator("summary").click();
      await expect(manual).not.toContainText("PowerShell");
    }
    const body = (await page.locator("#page").textContent()) || "";
    expect(body).not.toMatch(/%USERPROFILE%|PowerShell|以管理员身份|托盘/u);
  });

  test("AI 助手: 检测连接 reports that Codex is not reachable", async ({ page, hub }) => {
    await onboarded(hub);
    await start(hub, page);
    await rail(page, "agents");
    await page
      .getByRole("button", { name: /检测连接/u })
      .first()
      .click();
    const text = await toastText(page);
    record("agents-check", { toast: text, calls: hub.callsTo("agents.checkConnections") });
    expect(text).toMatch(/Codex/u);
  });

  test.describe(() => {
    test.use({ benchFakeRelay: true });
    test("免登录用中转: turn on with a synthetic relay, Codex config follows, turn off restores", async ({
      page,
      hub,
    }) => {
      const { GOOD_KEY } = await import("./hub-bench/fake-relay.mjs");
      const { readFileSync: read } = await import("node:fs");
      await onboarded(hub);
      const added = (await hub.service.call("relay.add", {
        name: "合成中转",
        baseUrl: fakeRelay(hub).baseUrl,
        apiKey: GOOD_KEY,
      })) as { id: string };
      const tested = (await hub.service.call("relay.test", { id: added.id })) as {
        models?: string[];
      };
      await hub.service.call("relay.update", {
        id: added.id,
        models: tested.models ?? [],
        enabled: true,
      });
      const config = path.join(hub.service.home, ".codex", "config.toml");
      const before = read(config, "utf8");
      await start(hub, page);
      await page.locator('#topNoAccount [role="switch"]').click({ force: true });
      const dialog = page.locator(".dialog-backdrop.show .dialog").first();
      await expect(dialog).toContainText("免登录用中转");
      await expect(dialog.getByRole("button", { name: "开启并应用" })).toBeEnabled({
        timeout: 15_000,
      });
      await dialog.getByRole("button", { name: "开启并应用" }).click();
      await expect
        .poll(
          async () =>
            ((await hub.service.call("relay.noAccountStatus")) as { enabled: boolean }).enabled,
        )
        .toBe(true);
      const on = read(config, "utf8");
      expect(on).not.toBe(before);
      // The switch is drawn again from the new status before it can turn the mode off.
      await expect(page.locator('#topNoAccount [role="switch"]')).toHaveAttribute(
        "aria-checked",
        "true",
        {
          timeout: 15_000,
        },
      );
      await page.waitForTimeout(1000);
      await page.locator('#topNoAccount [role="switch"]').click({ force: true });
      await expect
        .poll(
          async () =>
            ((await hub.service.call("relay.noAccountStatus")) as { enabled: boolean }).enabled,
        )
        .toBe(false);
      record("no-account", { before, on, after: read(config, "utf8"), failed: failedCalls(hub) });
    });
  });
});
