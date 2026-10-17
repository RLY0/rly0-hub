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
      put(tile, h("img", { src: "brand/rly0-ip-on-dark.svg", alt: "零号中转" }));
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
  const parseModels = (text) =>
    [
      ...new Set(
        text
          .split(/[\s,，]+/u)
          .map((m) => m.trim())
          .filter(Boolean),
      ),
    ].slice(0, 256);

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

  pages.relays = (root, alive, options) => {
    const rly0Module = h("section", { class: "m bal span-6 rly0-connect" });
    const list = h("div", { class: "grid compact" });
    const proxyLine = h("div", { class: "row proxy-line" });
    const addHolder = h("div", { class: "grid compact" });
    const noAccount = h("section", { class: "m span-6 no-account" });
    root.append(
      h("div", { class: "grid compact" }, rly0Module),
      h("h2", { class: "section-title" }, "我的中转站", proxyLine),
      list,
      addHolder,
      h(
        "h2",
        { class: "section-title" },
        "不登录 OpenAI 也能用",
        h("span", { class: "tag" }, "实验"),
      ),
      h("div", { class: "grid compact" }, noAccount),
    );

    // No-account mode changes ~/.codex/config.toml, so it shows the exact changes first.
    async function loadNoAccount() {
      const status = await call("relay.noAccountStatus").catch(() => null);
      if (!alive() || !status) return;
      if (status.enabled) {
        put(
          noAccount,
          h(
            "div",
            { class: "row" },
            h("span", { class: "dot ok" }),
            h("b", null, `已开启 · 默认模型 ${status.model || ""}`),
          ),
          h(
            "p",
            { class: "sub" },
            "Codex 不需要 OpenAI 账号，中转站的 GPT 模型通过本机 Hub 运行。请保持 Hub 在托盘里运行。",
          ),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              {
                class: "btn",
                type: "button",
                onclick: () =>
                  call("relay.noAccountDisable").then(() => {
                    toast("已恢复原来的 Codex 设置，重启 Codex 生效");
                    loadNoAccount();
                  }, failed),
              },
              "恢复原来的设置",
            ),
            h(
              "button",
              {
                class: "btn quiet",
                type: "button",
                onclick: () =>
                  call("codex.restart").then(
                    (r) => toast(r.ok ? "Codex 正在重启" : "Codex 没在运行"),
                    failed,
                  ),
              },
              "重启 Codex",
            ),
          ),
        );
        return;
      }
      if (!status.models.length) {
        put(
          noAccount,
          h(
            "p",
            { class: "sub" },
            "没有 OpenAI 账号时，可以让 Codex 直接用中转站的 GPT 模型。先在上面的中转站里点“测试”，读出 GPT 系列模型。",
          ),
        );
        return;
      }
      const model = h(
        "select",
        { class: "input compact-select", "aria-label": "默认模型" },
        status.models.map((m) => h("option", { value: m }, m)),
      );
      const plan = h("div");
      put(
        noAccount,
        h(
          "p",
          { class: "sub" },
          "没有 OpenAI 账号时，让 Codex 直接用中转站的 GPT 模型。会修改 Codex 的设置文件，改之前会先备份，可以一键恢复。",
        ),
        h(
          "div",
          { class: "row" },
          h("label", { class: "field" }, h("span", null, "默认模型"), model),
          h(
            "button",
            {
              class: "btn",
              type: "button",
              onclick: async () => {
                const preview = await call("relay.noAccountPreview", { model: model.value }).catch(
                  (error) => {
                    failed(error);
                    return null;
                  },
                );
                if (!preview || !alive()) return;
                put(
                  plan,
                  h(
                    "div",
                    { class: "relay-editor" },
                    h("span", { class: "label" }, "Will change"),
                    h("p", { class: "sub tabular" }, preview.configPath),
                    h("pre", { class: "plan-lines" }, preview.changes.join("\n")),
                    h(
                      "ul",
                      { class: "plan-notes" },
                      h("li", null, "开启后 Codex 只能用中转站的模型，官方模型暂时不可用。"),
                      h("li", null, "Hub 要一直在托盘里运行（开机自启已默认打开）。"),
                      h("li", null, "需要重启 Codex 才生效；随时可以一键恢复。"),
                    ),
                    h(
                      "div",
                      { class: "row" },
                      h(
                        "button",
                        {
                          class: "btn red",
                          type: "button",
                          onclick: () =>
                            call("relay.noAccountEnable", {
                              model: model.value,
                              confirmed: true,
                            }).then((r) => {
                              toast(r.noAccount ? "已开启，重启 Codex 生效" : "没有开启成功");
                              loadNoAccount();
                            }, failed),
                        },
                        "我已了解，开启",
                      ),
                      h(
                        "button",
                        { class: "btn quiet", type: "button", onclick: () => put(plan) },
                        "取消",
                      ),
                    ),
                  ),
                );
              },
            },
            "查看会改什么",
          ),
        ),
        plan,
      );
    }
    loadNoAccount();

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

    function renderAdd(open) {
      if (!open) {
        put(
          addHolder,
          h(
            "button",
            { class: "m add-tile span-6", type: "button", onclick: () => renderAdd(true) },
            h("span", { class: "plus", "aria-hidden": "true" }, "+"),
            h("span", null, "添加其他中转站"),
          ),
        );
        return;
      }
      const name = h("input", { class: "input", maxlength: "40", placeholder: "名称" });
      const baseUrl = h("input", {
        class: "input",
        placeholder: "https://…/v1",
        spellcheck: "false",
      });
      const apiKey = h("input", {
        class: "input",
        type: "password",
        placeholder: "密钥 sk-…",
        autocomplete: "off",
        spellcheck: "false",
      });
      const add = async () => {
        const params = { name: name.value.trim(), baseUrl: baseUrl.value.trim() };
        if (apiKey.value.trim()) params.apiKey = apiKey.value.trim();
        if (!params.name || !params.baseUrl) {
          toast("名称和地址都要填");
          return;
        }
        try {
          const added = await call("relay.add", params);
          if (!added.available) throw new Error("HUB_ERROR");
          const { result, filled } = await testAndFill(added.relay);
          toast(
            result && result.ok
              ? `已添加${filled ? `，读到 ${filled} 个模型` : ""}`
              : `已添加，但测试没通过：${explain(result && result.error)}`,
          );
          renderAdd(false);
          load();
        } catch (error) {
          failed(error);
        }
      };
      put(
        addHolder,
        h(
          "section",
          { class: "m span-6" },
          h(
            "div",
            { class: "row" },
            h("span", { class: "label" }, "Other relay"),
            h("span", { class: "spacer" }),
            h(
              "button",
              { class: "btn quiet sm", type: "button", onclick: () => renderAdd(false) },
              "收起",
            ),
          ),
          h(
            "div",
            { class: "form" },
            name,
            baseUrl,
            apiKey,
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn paper", type: "button", onclick: add }, "添加并测试"),
            ),
          ),
          h("p", { class: "sub" }, "添加后会自动测试，并读出这个中转站的模型。"),
        ),
      );
      name.focus();
    }

    async function load() {
      const [relays, proxy] = await Promise.all([
        call("relay.list").catch(() => null),
        call("proxy.status").catch(() => null),
      ]);
      if (!alive()) return;
      // Claude Code's own Anthropic API key is kept like a relay but managed on the AI 助手 page.
      if (relays && relays.relays) relays.relays = relays.relays.filter((r) => !isOfficialKey(r));
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
      const items = (relays && relays.relays) || [];
      renderRly0(items.some((relay) => relay.hasKey && isRly0(relay)));
      put(
        list,
        items.length ? items.map(card) : h("p", { class: "empty span-6" }, "还没有中转站。"),
      );
    }

    function card(relay) {
      const element = h("section", { class: `m span-3 relay-card ${isRly0(relay) ? "tone" : ""}` });
      const money_ = h("div", { class: "quota-line" }, h("span", { class: "sub" }, "余额读取中…"));
      const note = h("p", { class: "sub" });
      const editor = h("div");
      let confirmRemove = false;
      const remove = h(
        "button",
        {
          class: "btn quiet sm",
          type: "button",
          onclick: () => {
            if (!confirmRemove) {
              confirmRemove = true;
              remove.textContent = "确认删除";
              setTimeout(() => {
                confirmRemove = false;
                remove.textContent = "删除";
              }, 3000);
              return;
            }
            call("relay.remove", { id: relay.id }).then(() => {
              toast("已删除");
              load();
            }, failed);
          },
        },
        "删除",
      );
      const toggle = h("button", {
        class: "switch",
        type: "button",
        role: "switch",
        "aria-checked": String(relay.enabled),
        "aria-label": `启用 ${relay.name}`,
        onclick: () =>
          call("relay.setEnabled", { id: relay.id, enabled: !relay.enabled }).then(load, failed),
      });
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
            ? `${relay.models.length} 个模型${relay.routeLocked ? " · 未列出的模型也走这里" : ""}`
            : "还没有模型列表，点“测试”自动读取",
        ),
        note,
        editor,
        h(
          "div",
          { class: "row" },
          h(
            "button",
            {
              class: "btn sm",
              type: "button",
              onclick: async () => {
                note.textContent = "测试中…";
                const { result, filled } = await testAndFill(relay);
                note.textContent =
                  result && result.available
                    ? result.ok
                      ? `连通 · ${result.latencyMs} ms${result.modelCount ? ` · ${result.modelCount} 个模型` : ""}${filled ? " · 已填入模型列表" : ""}`
                      : explain(result.error)
                    : "测试没有成功";
                if (filled) load();
              },
            },
            "测试",
          ),
          h("button", { class: "btn sm", type: "button", onclick: () => edit() }, "编辑"),
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

      function edit() {
        if (editor.childElementCount) {
          put(editor);
          return;
        }
        const name = h("input", {
          class: "input",
          maxlength: "40",
          value: relay.name,
          "aria-label": "名称",
        });
        const baseUrl = h("input", {
          class: "input",
          value: relay.baseUrl,
          spellcheck: "false",
          "aria-label": "地址",
        });
        const apiKey = h("input", {
          class: "input",
          type: "password",
          placeholder: "留空 = 不改密钥",
          autocomplete: "off",
          "aria-label": "新密钥",
        });
        const models = h("textarea", {
          class: "input models",
          rows: "4",
          spellcheck: "false",
          "aria-label": "模型列表",
        });
        models.value = relay.models.join("\n");
        let locked = Boolean(relay.routeLocked);
        const lock = h("button", {
          class: "switch",
          type: "button",
          role: "switch",
          "aria-checked": String(locked),
          "aria-label": "未列出的模型也走这个中转站",
          onclick: () => {
            locked = !locked;
            lock.setAttribute("aria-checked", String(locked));
          },
        });
        const save = async () => {
          const params = {
            id: relay.id,
            name: name.value.trim(),
            baseUrl: baseUrl.value.trim(),
            models: parseModels(models.value),
            routeLocked: locked,
          };
          if (apiKey.value.trim()) params.apiKey = apiKey.value.trim();
          try {
            const result = await call("relay.update", params);
            if (!result.available) throw new Error("HUB_ERROR");
            toast("已保存。Codex 新开的对话会用新的模型列表");
            load();
          } catch (error) {
            failed(error);
          }
        };
        put(
          editor,
          h(
            "div",
            { class: "relay-editor" },
            h("label", { class: "field" }, h("span", null, "名称"), name),
            h("label", { class: "field" }, h("span", null, "地址"), baseUrl),
            h("label", { class: "field" }, h("span", null, "密钥"), apiKey),
            h(
              "label",
              { class: "field" },
              h("span", null, "模型（每行一个；GPT 系列会出现在 Codex 模型菜单）"),
              models,
            ),
            h(
              "div",
              { class: "row" },
              lock,
              h("span", { class: "sub" }, "没列出的模型也走这个中转站"),
            ),
            h(
              "div",
              { class: "row" },
              h("button", { class: "btn paper sm", type: "button", onclick: save }, "保存"),
              h(
                "button",
                { class: "btn quiet sm", type: "button", onclick: () => put(editor) },
                "取消",
              ),
            ),
          ),
        );
      }
      return element;
    }

    renderAdd(false);
    load();
    if (options.preset === "rly0") setTimeout(() => rly0Key.focus(), 0);
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
