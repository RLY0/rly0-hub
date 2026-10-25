"use strict";
// Shared controls drawn by the Hub itself instead of the system's:
// - every <select class="input"> becomes a rounded picker whose list opens joined to it;
// - menuButton(): a button that opens a small menu of choices (e.g. the three ways to sign in);
// - [data-tip]: a small hint bubble on hover, also for disabled choices.
// Menus and tips float above the page so cards (overflow: hidden) never clip them.
window.HubUI = (() => {
  const make = (tag, props, ...children) => {
    const element = document.createElement(tag);
    for (const [key, value] of Object.entries(props || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class") element.className = value;
      else if (key.startsWith("on")) element.addEventListener(key.slice(2), value);
      else if (value === true) element.setAttribute(key, "");
      else element.setAttribute(key, String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      element.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return element;
  };
  const chevron = () => {
    const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    icon.setAttribute("viewBox", "0 0 24 24");
    icon.setAttribute("aria-hidden", "true");
    icon.setAttribute("class", "pick-chevron");
    icon.innerHTML = '<path d="M7 10l5 5 5-5"/>'; // fixed markup
    return icon;
  };

  /* ---------- One floating layer at a time ---------- */
  let openLayer = null;
  function closeLayer() {
    if (!openLayer) return;
    const { panel, owner, onClose } = openLayer;
    openLayer = null;
    panel.classList.remove("show");
    owner.classList.remove("open");
    owner.setAttribute("aria-expanded", "false");
    setTimeout(() => panel.remove(), 160);
    if (onClose) onClose();
  }
  function openPanel(owner, panel, { joined, align, onClose } = {}) {
    closeLayer();
    const box = owner.getBoundingClientRect();
    document.body.append(panel);
    panel.style.minWidth = `${Math.round(box.width)}px`;
    const below = window.innerHeight - box.bottom;
    const height = panel.offsetHeight;
    const up = below < height + 16 && box.top > below;
    const top = up ? box.top - height + (joined ? 1 : -6) : box.bottom + (joined ? -1 : 6);
    let left = align === "right" ? box.right - panel.offsetWidth : box.left;
    left = Math.max(8, Math.min(left, window.innerWidth - panel.offsetWidth - 8));
    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(Math.max(8, top))}px`;
    panel.classList.toggle("up", up);
    owner.classList.toggle("open-up", up);
    owner.classList.add("open");
    owner.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => panel.classList.add("show"));
    openLayer = { panel, owner, onClose };
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!openLayer) return;
      const target = event.target;
      if (openLayer.panel.contains(target) || openLayer.owner.contains(target)) return;
      closeLayer();
    },
    true,
  );
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && openLayer) {
      const owner = openLayer.owner;
      closeLayer();
      owner.focus();
    }
  });
  window.addEventListener("resize", closeLayer);
  document.addEventListener(
    "scroll",
    (event) => {
      if (openLayer && !openLayer.panel.contains(event.target)) closeLayer();
    },
    true,
  );

  /* ---------- Rounded picker in place of <select> ---------- */
  function enhanceSelect(select) {
    if (select.dataset.picked) return;
    select.dataset.picked = "1";
    const label = make("span", { class: "pick-label" });
    const button = make(
      "button",
      {
        type: "button",
        class: `pick ${select.className.replace(/\binput\b/u, "")}`.trim(),
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-label": select.getAttribute("aria-label") || null,
      },
      label,
      chevron(),
    );
    const sync = () => {
      const option = select.options[select.selectedIndex];
      label.textContent = option ? option.textContent : "";
      button.disabled = select.disabled;
    };
    const choose = (index) => {
      closeLayer();
      if (index !== select.selectedIndex) {
        select.selectedIndex = index;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }
      sync();
      button.focus();
    };
    const open = () => {
      if (openLayer && openLayer.owner === button) {
        closeLayer();
        return;
      }
      const items = [...select.options].map((option, index) =>
        make(
          "button",
          {
            type: "button",
            role: "option",
            class: "pick-option",
            "aria-selected": String(index === select.selectedIndex),
            disabled: option.disabled,
            onclick: () => choose(index),
          },
          option.textContent,
        ),
      );
      const panel = make("div", { class: "pick-list", role: "listbox" }, items);
      panel.addEventListener("keydown", (event) => {
        const list = items.filter((item) => !item.disabled);
        const at = list.indexOf(document.activeElement);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const next = event.key === "ArrowDown" ? at + 1 : at - 1;
          (list[(next + list.length) % list.length] || list[0]).focus();
        }
      });
      openPanel(button, panel, { joined: true });
      (items[select.selectedIndex] || items[0])?.focus();
    };
    button.addEventListener("click", open);
    button.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        open();
      }
    });
    select.addEventListener("change", sync);
    // Pages sometimes set .value or .disabled from code; keep the label in step.
    new MutationObserver(sync).observe(select, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    select.classList.add("pick-native");
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    select.after(button);
    sync();
    requestAnimationFrame(sync);
  }
  const enhanceAll = (root) => {
    if (root.matches && root.matches("select.input")) enhanceSelect(root);
    if (root.querySelectorAll) root.querySelectorAll("select.input").forEach(enhanceSelect);
  };
  new MutationObserver((records) => {
    for (const record of records)
      for (const node of record.addedNodes) if (node.nodeType === 1) enhanceAll(node);
  }).observe(document.documentElement, { childList: true, subtree: true });

  /* ---------- Menu button ---------- */
  // items: [{ title, desc, icon (fixed svg markup), onSelect, disabled, tip }]
  function menuButton(label, items, { className = "btn paper", align = "left" } = {}) {
    const button = make(
      "button",
      { type: "button", class: `${className} menu-trigger`, "aria-haspopup": "menu" },
      label,
      chevron(),
    );
    button.addEventListener("click", () => {
      if (openLayer && openLayer.owner === button) {
        closeLayer();
        return;
      }
      const entries = items.map((item) => {
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24");
        icon.setAttribute("aria-hidden", "true");
        icon.innerHTML = item.icon || ""; // fixed markup from the page
        return make(
          "button",
          {
            type: "button",
            role: "menuitem",
            class: `menu-item ${item.disabled ? "off" : ""}`,
            "aria-disabled": item.disabled ? "true" : null,
            "data-tip": item.disabled && item.tip ? item.tip : null,
            onclick: () => {
              if (item.disabled) return;
              closeLayer();
              item.onSelect();
            },
          },
          make("span", { class: "menu-icon" }, icon),
          make(
            "span",
            { class: "menu-text" },
            make("b", null, item.title),
            item.desc ? make("small", null, item.desc) : null,
          ),
        );
      });
      const panel = make("div", { class: "menu-panel", role: "menu" }, entries);
      openPanel(button, panel, { align });
      entries.find((entry) => !entry.classList.contains("off"))?.focus();
    });
    return button;
  }

  /* ---------- Hint bubbles ---------- */
  const bubble = make("div", { class: "tip-bubble", role: "tooltip" });
  let tipFor = null;
  // Shown on hover, on keyboard focus of an ⓘ, and on tap (touch) of an ⓘ; Esc hides it.
  document.addEventListener("pointerover", (event) => {
    const target = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
    if (target === tipFor) return;
    showTip(target);
  });
  document.addEventListener("focusin", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".info-tip") : null;
    if (target) showTip(target);
  });
  document.addEventListener("focusout", (event) => {
    if (event.target === tipFor) showTip(null);
  });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".info-tip") : null;
    if (!target) return;
    // A tap has no hover: it shows the tip; tapping anywhere else hides it.
    event.stopPropagation();
    showTip(target);
  });
  document.addEventListener("pointerdown", (event) => {
    if (!(event.target instanceof Element && event.target.closest(".info-tip"))) showTip(null);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tipFor && bubble.classList.contains("show")) showTip(null);
  });
  function showTip(target) {
    tipFor = target;
    if (!target) {
      bubble.classList.remove("show");
      return;
    }
    bubble.textContent = target.getAttribute("data-tip");
    if (!bubble.isConnected) document.body.append(bubble);
    const box = target.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const left = Math.max(
      8,
      Math.min(box.left + box.width / 2 - width / 2, innerWidth - width - 8),
    );
    const above = box.top - bubble.offsetHeight - 8;
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(above > 8 ? above : box.bottom + 8)}px`;
    bubble.classList.add("show");
  }

  /* ---------- Short text, the rest behind an ⓘ ---------- */
  // Explanations show one short line; the full text sits in a tooltip on an ⓘ (hover, keyboard
  // focus, tap) and stays in the page for screen readers (aria-describedby). Nothing is lost: the
  // tooltip always holds the whole original sentence. Pages either pass a hand-written short line
  // (`info(short, full)` or `data-brief` on the element), or long plain explanations matching
  // BRIEF_SELECTOR are shortened to their first clause. Warnings and results stay as they are.
  let tipSeq = 0;
  function infoButton(full) {
    const id = `info-tip-${++tipSeq}`;
    return [
      make(
        "button",
        {
          type: "button",
          class: "info-tip",
          "aria-label": "详细说明",
          "aria-describedby": id,
          "data-tip": full,
        },
        "i",
      ),
      make("span", { id, class: "sr-only" }, full),
    ];
  }
  /** A short line plus its ⓘ: `info("短句", "完整说明")`. */
  function info(short, full) {
    return make(
      "span",
      { class: "brief" },
      make("span", { class: "brief-text" }, short),
      " ",
      infoButton(full),
    );
  }
  const BRIEF_SELECTOR =
    "p.sub, .tool-text p, .page-note, .reset-when, .who > span, .mod-title > span, .access-detail p, .quota-note, .page-head > .sub, [data-brief]";
  const BRIEF_SKIP =
    ".warn-text, .warn, .err, .error, [role=alert], [role=status], [data-keep], .tool-detail, .dialog-body .result";
  const MIN_BRIEF = 28;
  /** First clause of a long explanation (the full text goes in the tooltip). */
  function briefOf(text) {
    const first = text.split(/[。；！？]/u)[0].trim();
    if (first && first.length <= 34 && first.length < text.length) return first;
    const comma = first.indexOf("，");
    if (comma >= 8 && comma <= 34) return first.slice(0, comma);
    const head = first.slice(0, 32);
    const pause = head.lastIndexOf("、");
    return pause >= 10 ? head.slice(0, pause) : `${head.slice(0, 28)}…`;
  }
  function applyBrief(element) {
    if (element.querySelector(".brief-text")) return;
    // A hand-written short line (data-brief) applies everywhere, warnings included.
    if (!element.hasAttribute("data-brief") && element.closest(BRIEF_SKIP)) return;
    if (element.children.length > 0) return;
    const full = element.textContent.trim();
    const long = full.replace(/[。.]$/u, "").length > MIN_BRIEF && /[，。；：]/u.test(full);
    const short = element.getAttribute("data-brief") || (long ? briefOf(full) : null);
    if (!short || short === full) return;
    element.replaceChildren(make("span", { class: "brief-text" }, short), " ", ...infoButton(full));
    element.classList.add("brief");
  }
  function briefAll(root) {
    if (!(root instanceof Element)) return;
    if (root.matches(BRIEF_SELECTOR)) applyBrief(root);
    root.querySelectorAll(BRIEF_SELECTOR).forEach(applyBrief);
  }
  const briefObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData") {
        const parent = record.target.parentElement;
        if (parent) briefAll(parent.closest(BRIEF_SELECTOR) || parent);
        continue;
      }
      briefAll(record.target instanceof Element ? record.target.closest(BRIEF_SELECTOR) : null);
      record.addedNodes.forEach((node) => briefAll(node));
    }
  });
  const startBrief = () => {
    briefAll(document.body);
    briefObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  };
  if (document.body) startBrief();
  else document.addEventListener("DOMContentLoaded", startBrief);

  /* ---------- Dialog ---------- */
  // A centred panel over a dimmed page. `onClose` runs however it closes (button, Esc, backdrop).
  function dialog({ title, sub, onClose, wide } = {}) {
    closeLayer();
    const body = make("div", { class: "dialog-body" });
    const foot = make("div", { class: "dialog-foot" });
    const closeButton = make(
      "button",
      { type: "button", class: "dialog-x", "aria-label": "关闭" },
      "×",
    );
    const panel = make(
      "div",
      {
        class: `dialog ${wide ? "wide" : ""}`,
        role: "dialog",
        "aria-modal": "true",
        "aria-label": title,
      },
      make(
        "div",
        { class: "dialog-head" },
        make(
          "div",
          { class: "mod-title" },
          make("b", null, title),
          sub ? make("span", null, sub) : null,
        ),
        closeButton,
      ),
      body,
      foot,
    );
    const backdrop = make("div", { class: "dialog-backdrop" }, panel);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener("keydown", onKey, true);
      backdrop.classList.remove("show");
      setTimeout(() => backdrop.remove(), 180);
      if (onClose) onClose();
    };
    const onKey = (event) => {
      if (event.key === "Escape" && !openLayer) {
        event.stopPropagation();
        close();
      }
    };
    closeButton.addEventListener("click", close);
    backdrop.addEventListener("pointerdown", (event) => {
      if (event.target === backdrop) close();
    });
    document.addEventListener("keydown", onKey, true);
    document.body.append(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("show"));
    return { panel, body, foot, close };
  }

  /**
   * Two-step confirm for destructive buttons. The first tap arms the button: it turns brand red
   * with its confirm text and a thin bar running out until it disarms on its own (`ms`); a second
   * tap in that time goes ahead. Call the returned function at the top of the click handler:
   *   if (!confirmTap()) return;
   * `textEl` is the part whose text changes (the button itself by default).
   */
  function armable(el, { armedText, ms = 4000, textEl, onExpire } = {}) {
    const target = textEl || el;
    let timer = null;
    let original = "";
    const reset = () => {
      clearTimeout(timer);
      timer = null;
      target.textContent = original;
      el.classList.remove("armed");
    };
    return () => {
      if (timer !== null) {
        reset();
        return true;
      }
      original = target.textContent;
      target.textContent = armedText;
      el.style.setProperty("--arm-ms", `${ms}ms`);
      el.classList.add("armed");
      timer = setTimeout(() => {
        reset();
        if (onExpire) onExpire();
      }, ms);
      return false;
    };
  }

  return { menuButton, enhanceSelect, closeLayer, dialog, armable, info };
})();
