"use strict";
// "Already on this computer": keys, subscription tokens and relays the installed agents are set up
// with outside a sign-in (env vars, Claude Code settings.json, Codex config, Gemini/Grok CLI).
// The service only ever sends masked values; importing names entries by id.
window.registerHubDiscovery = ({ h, call, toast, failed }) => {
  const AGENT = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok CLI" };
  const VENDOR = { anthropic: "Claude", openai: "OpenAI", google: "Gemini", xai: "Grok" };
  const DISMISS = "rly0.discovery.dismissed";
  const dismissed = () => {
    try {
      return new Set(JSON.parse(localStorage.getItem(DISMISS) || "[]"));
    } catch {
      return new Set();
    }
  };
  const dismiss = (ids) => {
    try {
      localStorage.setItem(DISMISS, JSON.stringify([...new Set([...dismissed(), ...ids])]));
    } catch {
      /* per-viewer convenience only */
    }
  };

  /** A card that fills itself in when something new is found; empty otherwise. */
  function banner(alive, onImported, filter) {
    const card = h("section", { class: "m discover", hidden: true });
    void (async () => {
      const result = await call("discovery.scan").catch(() => null);
      if (!alive() || !result || !result.coreAvailable) return;
      const skip = dismissed();
      const items = result.items.filter(
        (item) => item.state !== "saved" && !skip.has(item.id) && (!filter || filter(item)),
      );
      if (!items.length) return;
      const picked = new Set(items.map((item) => item.id));
      const importButton = h(
        "button",
        {
          class: "btn paper sm",
          type: "button",
          onclick: async () => {
            if (!picked.size) {
              toast("先勾选要导入的项");
              return;
            }
            importButton.disabled = true;
            try {
              const done = await call("discovery.import", { ids: [...picked] });
              const failedCount = done.results.length - done.imported;
              toast(`已导入 ${done.imported} 项${failedCount ? `，${failedCount} 项没成功` : ""}`);
              if (onImported) onImported();
            } catch (error) {
              failed(error);
            } finally {
              importButton.disabled = false;
            }
          },
        },
        `导入所选（${picked.size}）`,
      );
      const refreshCount = () => {
        importButton.textContent = `导入所选（${picked.size}）`;
      };
      card.replaceChildren(
        h(
          "div",
          { class: "row" },
          h(
            "div",
            { class: "who" },
            h("b", null, `本机找到 ${items.length} 项 Key / 中转`),
            h(
              "span",
              null,
              "来自已装 AI 助手的现有配置。导入后可在 Hub 里查看额度、一键切换；原来的配置不会改动，正在用的登录也不会被切换。",
            ),
          ),
        ),
        h(
          "ul",
          { class: "discover-list" },
          items.map((item) =>
            h(
              "li",
              null,
              h("input", {
                type: "checkbox",
                checked: true,
                "aria-label": `导入 ${item.name}`,
                onchange: (event) => {
                  if (event.currentTarget.checked) picked.add(item.id);
                  else picked.delete(item.id);
                  refreshCount();
                },
              }),
              h(
                "div",
                { class: "who" },
                h(
                  "b",
                  null,
                  item.kind === "relay"
                    ? `${item.name} · ${VENDOR[item.vendor]} 中转站`
                    : item.name,
                ),
                h(
                  "span",
                  null,
                  [item.keyMask, item.model ? `模型 ${item.model}` : null, item.source]
                    .filter(Boolean)
                    .join(" · "),
                ),
              ),
              h("span", { class: "spacer" }),
              item.state === "differs"
                ? h(
                    "span",
                    { class: "tag warn" },
                    item.kind === "officialKey" && item.vendor === "anthropic"
                      ? "另存为独立令牌"
                      : "会替换已存的 Key",
                  )
                : null,
              item.agent !== "any" ? h("span", { class: "tag" }, AGENT[item.agent]) : null,
            ),
          ),
        ),
        h(
          "div",
          { class: "row" },
          importButton,
          h(
            "button",
            {
              class: "btn quiet sm",
              type: "button",
              onclick: () => {
                dismiss(items.map((item) => item.id));
                card.hidden = true;
              },
            },
            "不用了",
          ),
        ),
      );
      card.hidden = false;
    })();
    return card;
  }

  return { discoveryBanner: banner };
};
