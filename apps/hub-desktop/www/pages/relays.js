"use strict";
// "中转站" page: 零号中转 first, each relay with its own site logo, balance and multiplier, and a
// model list that a test fills in automatically (that list is what reaches Codex's model menu).
// Other relays are added from a folded form so the page stays about the relays you have.
window.registerHubRelays = ({
  pages,
  h,
  call,
  toast,
  failed,
  explain,
  money,
  isRly0,
  isOfficialKey,
  moneyBadge,
  rateBadge,
}) => {
  const RLY0_BASE = "https://api.rly0.com/v1";
  const put = (element, ...items) =>
    element.replaceChildren(
      ...items
        .flat(Infinity)
        .filter((item) => item !== null && item !== undefined && item !== false),
    );
  const logos = new Map();

  function relayLogo(relay, size = 44) {
    const tile = h("span", {
      class: "agent-logo relay-logo",
      style: { width: `${size}px`, height: `${size}px` },
    });
    const letter = () => put(tile, h("b", null, relay.name.slice(0, 1).toUpperCase()));
    if (isRly0(relay)) {
      put(tile, h("img", { src: "brand/rly0-ip-tight.svg", alt: "零号中转" }));
      tile.classList.add("dark");
      return tile;
    }
    letter();
    if (!logos.has(relay.id))
      logos.set(
        relay.id,
        call("relay.logo", { id: relay.id }).catch(() => null),
      );
    logos.get(relay.id).then((result) => {
      if (result && typeof result.logo === "string" && result.logo.startsWith("data:image/")) {
        put(tile, h("img", { src: result.logo, alt: `${relay.name} 图标` }));
      }
    });
    return tile;
  }

  const hostOf = (url) => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  };

  /** Test a relay and, when it lists no models yet, keep what the relay reports. */
  async function testAndFill(relay) {
    const result = await call("relay.test", { id: relay.id }).catch(() => null);
    if (
      result &&
      result.available &&
      result.ok &&
      result.models &&
      result.models.length &&
      !relay.models.length
    ) {
      await call("relay.update", { id: relay.id, models: result.models.slice(0, 256) }).catch(
        () => undefined,
      );
      return { result, filled: Math.min(result.models.length, 256) };
    }
    return { result, filled: 0 };
  }

  // Codex is OpenAI's agent: only these relay models can appear in its model menu.
  const isGptModel = (model) => /^(?:gpt-|chatgpt-|codex-|o\d)/iu.test(model.trim());
  // People paste the site address or the API address; relays answer under /v1.
  function normalizeBase(text) {
    let value = text.trim().replace(/\/+$/u, "");
    if (!value) return "";
    if (!/^https?:\/\//iu.test(value)) value = `https://${value}`;
    if (!/\/v1$/iu.test(value)) value = `${value}/v1`;
    return value;
  }
  const nameFromHost = (url) => {
    try {
      return new URL(url).hostname.replace(/^(api|www)\./u, "").slice(0, 40);
    } catch {
      return "中转站";
    }
  };

  /**
   * Add or edit a relay in one dialog: address + key → 测试 (reads the site's logo and name and
   * every model) → tick the GPT models to show in Codex → 保存. A relay being added is saved
   * switched off while testing and removed again when the dialog is cancelled.
   */
  function relayDialog({ relay, onDone }) {
    const editing = Boolean(relay);
    let draft = relay || null; // the saved relay this dialog works on
    let saved = false;
    const ui = window.HubUI.dialog({
      title: editing ? `编辑 ${relay.name}` : "添加中转站",
      sub: "填地址和 API Key，测试后选择要显示在 Codex 里的 GPT 模型",
      wide: true,
      onClose: () => {
        if (!editing && draft && !saved)
          call("relay.remove", { id: draft.id }).catch(() => undefined);
      },
    });
    const baseUrl = h("input", {
      class: "input",
      placeholder: "中转站地址，例如 https://api.example.com",
      spellcheck: "false",
      value: editing ? relay.baseUrl : "",
      "aria-label": "中转站地址",
    });
    const apiKey = h("input", {
      class: "input",
      type: "password",
      placeholder: editing ? "API Key（留空 = 不改）" : "API Key，例如 sk-…",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "API Key",
    });
    const testButton = h("button", { class: "btn paper", type: "button" }, "测试");
    const result = h("div", { class: "relay-test" });
    const saveButton = h("button", { class: "btn paper", type: "button", disabled: true }, "保存");
    const cancelButton = h(
      "button",
      { class: "btn quiet", type: "button", onclick: () => ui.close() },
      "取消",
    );
    put(
      ui.body,
      h("label", { class: "field" }, h("span", null, "地址"), baseUrl),
      h(
        "label",
        { class: "field" },
        h("span", null, "API Key"),
        h("div", { class: "row wide" }, apiKey, testButton),
      ),
      result,
    );
    put(ui.foot, h("span", { class: "spacer" }), cancelButton, saveButton);
    let picked = null; // { name, gpt: Map<model, checkbox>, others: string[] }

    async function runTest() {
      const base = normalizeBase(baseUrl.value);
      const key = apiKey.value.trim();
      if (!base) return toast("先填中转站地址");
      if (!editing && !key) return toast("先填 API Key");
      testButton.disabled = true;
      saveButton.disabled = true;
      put(result, h("p", { class: "sub" }, "正在连接中转站、读取名称和模型…"));
      try {
        if (!draft) {
          const added = await call("relay.add", {
            name: nameFromHost(base),
            baseUrl: base,
            apiKey: key,
            enabled: false,
          });
          if (!added.available) throw new Error("HUB_ERROR");
          draft = added.relay;
        } else {
          const params = { id: draft.id, baseUrl: base };
          if (key) params.apiKey = key;
          const updated = await call("relay.update", params);
          if (!updated.available) throw new Error("HUB_ERROR");
          draft = updated.relay;
        }
        logos.delete(draft.id);
        const [test, site] = await Promise.all([
          call("relay.test", { id: draft.id }).catch(() => null),
          isRly0(draft)
            ? Promise.resolve({ siteName: "零号中转" })
            : call("relay.logo", { id: draft.id }).catch(() => null),
        ]);
        if (!test || !test.available || !test.ok) {
          put(
            result,
            h("p", { class: "warn-text" }, `测试没通过：${explain(test && test.error)}`),
            h("p", { class: "sub" }, "检查地址和 API Key 后再点一次测试。"),
          );
          return;
        }
        showModels(test, (site && site.siteName) || (editing ? relay.name : nameFromHost(base)));
      } catch (error) {
        put(result, h("p", { class: "warn-text" }, explain(error && error.message)));
      } finally {
        testButton.disabled = false;
      }
    }

    function showModels(test, siteName) {
      const models = [...new Set(test.models || [])];
      const gpt = models.filter(isGptModel);
      const others = models.filter((m) => !isGptModel(m));
      // Editing keeps the person's earlier choice; a new relay starts with every GPT model on.
      const before = editing ? new Set(relay.models) : null;
      const name = h("input", {
        class: "input",
        maxlength: "40",
        value: siteName,
        "aria-label": "名称",
      });
      const boxes = new Map();
      const all = h("input", { type: "checkbox" });
      const syncAll = () => {
        const values = [...boxes.values()];
        all.checked = values.length > 0 && values.every((box) => box.checked);
        all.indeterminate = !all.checked && values.some((box) => box.checked);
        count.textContent = `已选 ${values.filter((box) => box.checked).length} / ${values.length}`;
      };
      all.addEventListener("change", () => {
        for (const box of boxes.values()) box.checked = all.checked;
        syncAll();
      });
      const count = h("span", { class: "sub tabular" });
      const list = h(
        "div",
        { class: "model-checks" },
        gpt.map((model) => {
          const box = h("input", { type: "checkbox" });
          box.checked = before ? before.has(model) || before.size === 0 : true;
          box.addEventListener("change", syncAll);
          boxes.set(model, box);
          return h("label", { class: "model-check" }, box, h("span", null, model));
        }),
        // Every other model is listed too; only GPT models can go into Codex's menu.
        others.map((model) =>
          h(
            "label",
            {
              class: "model-check off",
              "data-tip": "不是 GPT 模型，不能放进 Codex 菜单；Claude Code、Pi 等助手可以用",
            },
            h("input", { type: "checkbox", disabled: true }),
            h("span", null, model),
          ),
        ),
      );
      put(
        result,
        h(
          "div",
          { class: "relay-found" },
          relayLogo(draft, 44),
          h(
            "div",
            { class: "who" },
            h("b", null, `连通 · ${test.latencyMs} ms`),
            h("span", null, `读到 ${models.length} 个模型，其中 GPT 系列 ${gpt.length} 个`),
          ),
        ),
        h("label", { class: "field" }, h("span", null, "名称（自动识别，可改）"), name),
        models.length
          ? h(
              "div",
              { class: "field" },
              h(
                "div",
                { class: "row" },
                h("span", null, "勾选要显示在 Codex 模型菜单里的模型（只有 GPT 系列能勾）"),
                h("span", { class: "spacer" }),
                gpt.length ? count : null,
                gpt.length
                  ? h("label", { class: "model-check all" }, all, h("span", null, "全选"))
                  : null,
              ),
              list,
              others.length
                ? h(
                    "p",
                    { class: "sub" },
                    `灰色的 ${others.length} 个不是 GPT 模型，不进 Codex 菜单，但 Claude Code、Pi、Hermes 等助手可以用。`,
                  )
                : null,
            )
          : h("p", { class: "sub" }, "这个中转站没有返回模型列表。"),
      );
      syncAll();
      picked = { name, boxes, others };
      saveButton.disabled = false;
    }

    saveButton.addEventListener("click", async () => {
      if (!draft || !picked) return;
      const chosen = [...picked.boxes].filter(([, box]) => box.checked).map(([model]) => model);
      try {
        const updated = await call("relay.update", {
          id: draft.id,
          name: picked.name.value.trim() || nameFromHost(draft.baseUrl),
          models: [...chosen, ...picked.others].slice(0, 256),
          enabled: true,
        });
        if (!updated.available) throw new Error("HUB_ERROR");
        saved = true;
        toast(
          chosen.length
            ? `已保存，${chosen.length} 个 GPT 模型会出现在 Codex 模型菜单（新开对话生效）`
            : "已保存",
        );
        ui.close();
        onDone();
      } catch (error) {
        failed(error);
      }
    });
    testButton.addEventListener("click", runTest);
    for (const input of [baseUrl, apiKey])
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") runTest();
      });
    (editing ? apiKey : baseUrl).focus();
    if (editing) runTest();
  }

  pages.relays = (root, alive, options) => {
    const addTile = h(
      "button",
      { class: "m add-tile span-3", type: "button", onclick: () => relayDialog({ onDone: load }) },
      h("span", { class: "plus", "aria-hidden": "true" }, "+"),
      h(
        "span",
        { class: "who" },
        h("b", null, "添加中转站"),
        h("span", null, "填地址和 API Key，自动识别名称、图标和模型"),
      ),
    );
    const noAccount = h("section", { class: "m span-3 no-account" });
    const rly0Module = h("section", { class: "m bal span-6 rly0-connect" });
    const list = h("div", { class: "grid compact" });
    const proxyLine = h("div", { class: "row proxy-line" });
    root.append(
      h("div", { class: "grid compact relay-top" }, addTile, noAccount),
      h("div", { class: "grid compact" }, rly0Module),
      h("h2", { class: "section-title" }, "我的中转站", proxyLine),
      list,
    );

    // No-account mode is a switch. It changes ~/.codex/config.toml, so turning it on shows the
    // exact changes first; it can only be turned on once a relay offers GPT models.
    async function loadNoAccount() {
      const status = await call("relay.noAccountStatus").catch(() => null);
      if (!alive() || !status) return;
      const blocked = status.enabled
        ? null
        : status.models.length
          ? null
          : "先添加一个有 GPT 模型的中转站，才能打开";
      const toggle = h("button", {
        class: `switch ${blocked ? "off" : ""}`,
        type: "button",
        role: "switch",
        "aria-checked": String(Boolean(status.enabled)),
        "aria-disabled": blocked ? "true" : null,
        "data-tip": blocked,
        "aria-label": "不登录 OpenAI 也能用",
        onclick: () => {
          if (blocked) return toast(blocked);
          if (status.enabled)
            call("relay.noAccountDisable").then(() => {
              toast("已恢复原来的 Codex 设置，重启 Codex 生效");
              loadNoAccount();
            }, failed);
          else enableDialog(status.models);
        },
      });
      put(
        noAccount,
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "who" },
            h("b", null, "不登录 OpenAI 也能用"),
            h(
              "span",
              null,
              status.enabled
                ? `已开启 · 默认模型 ${status.model || ""}`
                : "没有 OpenAI 账号时，Codex 直接用中转站的 GPT 模型",
            ),
          ),
          h("span", { class: "spacer" }),
          toggle,
        ),
        status.enabled
          ? h(
              "p",
              { class: "sub" },
              "请保持 Hub 在托盘里运行。关掉开关会恢复原来的设置，重启 Codex 生效。",
            )
          : h("p", { class: "sub" }, blocked || "打开前会先列出要改的设置，改之前自动备份。"),
      );
    }

    function enableDialog(models) {
      const ui = window.HubUI.dialog({
        title: "不登录 OpenAI 也能用",
        sub: "会修改 Codex 的设置文件，改之前先备份，随时可以关掉恢复",
      });
      const model = h(
        "select",
        { class: "input", "aria-label": "默认模型" },
        models.map((m) => h("option", { value: m }, m)),
      );
      const plan = h("div");
      const confirm = h(
        "button",
        { class: "btn red", type: "button", disabled: true },
        "我已了解，开启",
      );
      const preview = async () => {
        confirm.disabled = true;
        const result = await call("relay.noAccountPreview", { model: model.value }).catch(
          (error) => {
            failed(error);
            return null;
          },
        );
        if (!result) return;
        put(
          plan,
          h("span", { class: "label" }, "会修改"),
          h("p", { class: "sub tabular" }, result.configPath),
          h("pre", { class: "plan-lines" }, result.changes.join("\n")),
          h(
            "ul",
            { class: "plan-notes" },
            h("li", null, "开启后 Codex 只用中转站的模型，官方模型暂时不可用。"),
            h("li", null, "Hub 要一直在托盘里运行（开机自启已默认打开）。"),
            h("li", null, "重启 Codex 后生效。"),
          ),
        );
        confirm.disabled = false;
      };
      model.addEventListener("change", preview);
      confirm.addEventListener("click", () =>
        call("relay.noAccountEnable", { model: model.value, confirmed: true }).then((r) => {
          toast(r.noAccount ? "已开启，重启 Codex 生效" : "没有开启成功");
          ui.close();
          loadNoAccount();
        }, failed),
      );
      put(ui.body, h("label", { class: "field" }, h("span", null, "默认模型"), model), plan);
      put(
        ui.foot,
        h("span", { class: "spacer" }),
        h("button", { class: "btn quiet", type: "button", onclick: () => ui.close() }, "取消"),
        confirm,
      );
      preview();
    }

    const rly0Key = h("input", {
      class: "input on-red",
      type: "password",
      placeholder: "粘贴零号中转的 API 密钥 sk-…",
      autocomplete: "off",
      spellcheck: "false",
    });
    async function connectRly0() {
      const key = rly0Key.value.trim();
      if (!key) {
        toast("先粘贴密钥");
        return;
      }
      try {
        const added = await call("relay.add", {
          name: "零号中转",
          baseUrl: RLY0_BASE,
          apiKey: key,
        });
        if (!added.available) throw new Error("HUB_ERROR");
        rly0Key.value = "";
        const { result, filled } = await testAndFill(added.relay);
        toast(
          result && result.ok
            ? `零号中转已接入${filled ? `，读到 ${filled} 个模型` : ""}`
            : "已保存，但测试没通过",
        );
        load();
      } catch (error) {
        failed(error);
      }
    }

    function renderRly0(present) {
      rly0Module.hidden = present;
      if (present) return;
      put(
        rly0Module,
        h(
          "div",
          { class: "row" },
          relayLogo({ id: "rly0", name: "零号中转", baseUrl: RLY0_BASE }, 40),
          h("span", { class: "label" }, "RLY/0 零号中转 · 推荐"),
        ),
        h("h3", null, "一个密钥，Claude、GPT、Gemini、Grok 都能用"),
        h(
          "div",
          { class: "row wide" },
          rly0Key,
          h("button", { class: "btn", type: "button", onclick: connectRly0 }, "接入"),
        ),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn ghost",
              type: "button",
              onclick: () => call("links.open", { target: "site" }).catch(failed),
            },
            "还没有账号？去注册",
          ),
          h(
            "button",
            {
              class: "btn ghost",
              type: "button",
              onclick: () => call("links.open", { target: "keys" }).catch(failed),
            },
            "去复制密钥",
          ),
        ),
      );
    }

    async function load() {
      const [relays, proxy] = await Promise.all([
        call("relay.list").catch(() => null),
        call("proxy.status").catch(() => null),
      ]);
      if (!alive()) return;
      // Claude Code's own Anthropic API key is kept like a relay but managed on the AI 助手 page.
      const items = ((relays && relays.relays) || []).filter((r) => !isOfficialKey(r));
      const running = Boolean(proxy && proxy.running);
      put(
        proxyLine,
        h("span", { class: `pulse ${running ? "" : "off"}` }),
        h(
          "span",
          { class: "sub tabular" },
          running ? `本地代理 127.0.0.1:${proxy.port}` : "本地代理未开启",
        ),
        h(
          "button",
          {
            class: "btn quiet sm",
            type: "button",
            onclick: () => call(running ? "proxy.stop" : "proxy.start").then(load, failed),
          },
          running ? "停止" : "开启",
        ),
      );
      renderRly0(items.some((relay) => relay.hasKey && isRly0(relay)));
      put(
        list,
        items.length
          ? items.map(card)
          : h("p", { class: "empty span-6" }, "还没有中转站。点上面的“添加中转站”。"),
      );
      loadNoAccount();
    }

    function card(relay) {
      const element = h("section", { class: `m span-3 relay-card ${isRly0(relay) ? "tone" : ""}` });
      const money_ = h("div", { class: "quota-line" }, h("span", { class: "sub" }, "余额读取中…"));
      let confirmTap = () => true;
      const remove = h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          onclick: () => {
            if (!confirmTap()) return;
            call("relay.remove", { id: relay.id }).then(() => {
              toast("已删除");
              load();
            }, failed);
          },
        },
        "删除",
      );
      confirmTap = window.HubUI.armable(remove, { armedText: "确认删除" });
      const toggle = h("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(relay.enabled),
        "aria-label": `启用 ${relay.name}`,
        onclick: () =>
          call("relay.setEnabled", { id: relay.id, enabled: !relay.enabled }).then(load, failed),
      });
      const gpt = relay.models.filter(isGptModel).length;
      put(
        element,
        h(
          "div",
          { class: "row agent-head" },
          relayLogo(relay),
          h(
            "div",
            { class: "who" },
            h("b", null, relay.name),
            h("span", { class: "tabular" }, hostOf(relay.baseUrl)),
          ),
          toggle,
        ),
        money_,
        h(
          "div",
          { class: "sub" },
          relay.models.length
            ? `${relay.models.length} 个模型 · ${gpt} 个显示在 Codex 菜单`
            : "还没有模型，点“编辑”测试并选择",
        ),
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn sm",
              type: "button",
              onclick: () => relayDialog({ relay, onDone: load }),
            },
            "编辑 / 选模型",
          ),
          h("span", { class: "spacer" }),
          remove,
        ),
      );
      call("relay.balance", { id: relay.id })
        .catch(() => null)
        .then((balance) => {
          if (!alive()) return;
          if (balance && balance.available && balance.ok) {
            put(
              money_,
              moneyBadge(balance.balance, balance.unit),
              typeof balance.rate === "number" ? rateBadge(balance.rate) : null,
            );
          } else
            put(
              money_,
              h("span", { class: "sub" }, balance ? explain(balance.error) : "读不到余额"),
            );
        });
      return element;
    }

    load();
    if (options.preset === "rly0") setTimeout(() => rly0Key.focus(), 0);
    if (options.preset === "add") setTimeout(() => relayDialog({ onDone: load }), 0);
  };

  /** Home strip: every relay at a glance, 零号 first, with its logo and balance. */
  return {
    relayLogo,
    relayStrip(alive) {
      const strip = h(
        "section",
        { class: "m span-6 relay-strip" },
        h("span", { class: "label" }, "Relays"),
      );
      call("relay.list")
        .catch(() => null)
        .then((relays) => {
          if (!alive()) return;
          const items = ((relays && relays.relays) || []).filter(
            (r) => r.enabled && !isOfficialKey(r),
          );
          if (!items.length) {
            strip.append(h("p", { class: "sub" }, "还没有启用的中转站"));
            return;
          }
          const row = h("div", { class: "ready-list" });
          strip.append(row);
          for (const relay of items) {
            const balance = h("span", { class: "strip-money" }, "…");
            row.append(
              h(
                "div",
                { class: "ready-item" },
                relayLogo(relay, 28),
                h("div", { class: "who" }, h("b", null, relay.name), balance),
              ),
            );
            call("relay.balance", { id: relay.id })
              .catch(() => null)
              .then((b) => {
                if (b && b.available && b.ok) {
                  put(
                    balance,
                    moneyBadge(b.balance, b.unit),
                    typeof b.rate === "number" ? rateBadge(b.rate) : null,
                  );
                } else balance.textContent = "余额未知";
              });
          }
        });
      return strip;
    },
  };
};
