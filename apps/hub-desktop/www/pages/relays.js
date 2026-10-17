"use strict";
// "中转站" page: 零号中转 first, each relay with its own site logo, balance and multiplier, and a
// model list that a test fills in automatically (that list is what reaches Codex's model menu).
// Other relays are added from a folded form so the page stays about the relays you have.
window.registerHubRelays = ({ pages, h, call, toast, failed, explain, money, isRly0 }) => {
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
    root.append(
      h("div", { class: "grid compact" }, rly0Module),
      h("h2", { class: "section-title" }, "我的中转站", proxyLine),
      list,
      addHolder,
    );

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
              h("b", { class: "tabular" }, money(balance.balance, balance.unit)),
              typeof balance.rate === "number"
                ? h("span", { class: "sub tabular" }, `倍率 ×${balance.rate}`)
                : null,
              typeof balance.todayCost === "number"
                ? h("span", { class: "sub tabular" }, `今日 −${balance.todayCost.toFixed(2)}`)
                : null,
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
          const items = ((relays && relays.relays) || []).filter((r) => r.enabled);
          if (!items.length) {
            strip.append(h("p", { class: "sub" }, "还没有启用的中转站"));
            return;
          }
          const row = h("div", { class: "ready-list" });
          strip.append(row);
          for (const relay of items) {
            const balance = h("span", { class: "tabular" }, "…");
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
                balance.textContent =
                  b && b.available && b.ok
                    ? `${money(b.balance, b.unit)}${typeof b.rate === "number" ? ` · ×${b.rate}` : ""}`
                    : "余额未知";
              });
          }
        });
      return strip;
    },
  };
};
