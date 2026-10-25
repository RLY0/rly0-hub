"use strict";
// One quota store for 首页 and 账号: numbers the service pushes when a real reply carried them
// (`quota` events, no request of their own), what each page read and how (timed or by hand),
// and the freshness line under each quota ("刚刚 / 3 分钟前 / 12:30" + ⓘ with the source).
// The timed refresh runs only while the window is visible: the current account every minute,
// the others every 5 minutes, slower after failures; numbers a reply brought within the interval
// count as fresh, so an active account is usually never read at all.
window.registerHubQuotaLive = ({ h, now = () => Date.now(), doc = globalThis.document } = {}) => {
  const SOURCES = {
    conversation: {
      label: "随对话更新",
      detail: "随对话更新：回复里自带的额度数字，没有额外请求。",
    },
    scheduled: {
      label: "定时刷新",
      detail: "定时刷新：账号页开着时，当前账号每分钟、其他账号每 5 分钟读一次；窗口最小化时暂停。",
    },
    manual: { label: "手动", detail: "手动：点刷新按钮读到的额度。" },
  };
  const CURRENT_MS = 60_000;
  const OTHERS_MS = 5 * 60_000;
  const MAX_BACKOFF_MS = 15 * 60_000;
  const pad = (n) => String(n).padStart(2, "0");

  /** "刚刚" under a minute, "N 分钟前" under an hour, then the clock time (and date if older). */
  function freshness(at, current = now()) {
    const age = current - at;
    if (age < 60_000) return "刚刚";
    if (age < 3_600_000) return `${Math.floor(age / 60_000)} 分钟前`;
    const d = new Date(at);
    const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === new Date(current).toDateString()
      ? time
      : `${d.getMonth() + 1}月${d.getDate()}日 ${time}`;
  }

  const pushed = new Map(); // "provider:id" → { usage, at }
  const marks = new Map(); // "provider" or "provider:id" → { at, source }
  const listeners = new Set();
  let shellVisible = true;

  const visible = () => shellVisible && !(doc && doc.hidden);

  function notify(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        // One page's failure never stops the others.
      }
    }
  }

  /** Shell / service events: quota, balance, visibility, claudeUsageClosed. */
  function onShellEvent(data) {
    if (!data || typeof data !== "object") return false;
    if (data.event === "quota" && data.params && typeof data.params === "object") {
      ingest(data.params);
      return true;
    }
    if (data.event === "visibility") {
      shellVisible = data.visible !== false;
      notify({ type: "visibility", visible: visible() });
      return true;
    }
    if (data.event === "balance") {
      notify({ type: "balance", balance: data.params || null });
      return true;
    }
    if (data.event === "claudeUsageClosed") {
      notify({ type: "claudeUsageClosed", accountId: data.accountId });
      return true;
    }
    return false;
  }

  function ingest(update) {
    const { provider, id, usage, observedAt } = update || {};
    if ((provider !== "codex" && provider !== "claude") || typeof id !== "string") return;
    if (!usage || !Array.isArray(usage.windows) || !usage.windows.length) return;
    const at = typeof observedAt === "number" ? observedAt : (usage.fetchedAt || 0) * 1000;
    const key = `${provider}:${id}`;
    if ((pushed.get(key)?.at ?? 0) > at) return;
    pushed.set(key, { usage, at });
    notify({ type: "quota", provider, id, usage, at });
  }

  /** A page read quota (all of a provider when `id` is null) as `source`. */
  function mark(provider, id, source, at = now()) {
    marks.set(id ? `${provider}:${id}` : provider, { at, source });
  }

  /**
   * The numbers to show for one account and where they came from: a pushed reply when it is newer
   * than what the page read, else the page's own read (timed unless the last read was by hand).
   */
  function pick(provider, id, usage) {
    const live = pushed.get(`${provider}:${id}`);
    const readAt = usage && usage.fetchedAt ? usage.fetchedAt * 1000 : 0;
    if (live && live.at >= readAt)
      return { usage: live.usage, at: live.at, source: "conversation" };
    if (!readAt) return { usage, at: 0, source: null };
    const marked = [marks.get(`${provider}:${id}`), marks.get(provider)]
      // A mark names the read that finished soon after it (a read never takes 3 minutes).
      .filter((m) => m && m.at <= readAt + 5_000 && readAt - m.at <= 180_000)
      .sort((a, b) => b.at - a.at)[0];
    return { usage, at: readAt, source: marked ? marked.source : "scheduled" };
  }

  /** Last time a reply brought this account's numbers (ms), 0 if never. */
  const pushedAt = (provider, id) => pushed.get(`${provider}:${id}`)?.at ?? 0;

  /** The freshness line: one short label, the source in the ⓘ. */
  function freshLine(fresh) {
    if (!fresh || !fresh.at) return null;
    const source = SOURCES[fresh.source] || SOURCES.scheduled;
    const stamp = new Date(fresh.at);
    const exact = `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}:${pad(stamp.getSeconds())}`;
    const label = h(
      "span",
      { class: "fresh-at", "data-at": String(fresh.at) },
      freshness(fresh.at),
    );
    const info =
      window.HubUI && window.HubUI.info
        ? window.HubUI.info(source.label, `${source.detail}（${exact} 读取）`)
        : h("span", { title: source.detail }, source.label);
    return h(
      "p",
      { class: "quota-fresh", "data-keep": "", "data-source": fresh.source },
      label,
      " · ",
      info,
    );
  }

  /** Keeps every freshness label current ("刚刚" → "1 分钟前" …). */
  function repaint(root = doc) {
    if (!root || !root.querySelectorAll) return;
    for (const element of root.querySelectorAll(".fresh-at[data-at]")) {
      const at = Number(element.getAttribute("data-at"));
      if (at) element.textContent = freshness(at);
    }
  }

  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * Timed refreshes for one page. `tasks`: [{ id, current, run(), skip?() }]; `current` ones run
   * every minute, the rest every 5 minutes. Nothing runs while the window is hidden or minimized;
   * a failing task waits twice as long each time (up to 15 minutes). The first run waits a full
   * interval: the page already read everything when it opened. `tick()` is one check (tests).
   */
  function scheduler(tasks, { alive = () => true } = {}) {
    const state = new Map(
      tasks.map((task) => [task.id, { last: now(), failures: 0, running: false }]),
    );
    const interval = (task) => {
      const base = task.current ? CURRENT_MS : OTHERS_MS;
      const s = state.get(task.id);
      return Math.min(MAX_BACKOFF_MS, base * 2 ** s.failures);
    };
    async function tick() {
      if (!alive() || !visible()) return [];
      const ran = [];
      for (const task of tasks) {
        const s = state.get(task.id);
        if (s.running || now() - s.last < interval(task)) continue;
        s.last = now();
        if (task.skip && task.skip()) continue;
        s.running = true;
        ran.push(task.id);
        try {
          await task.run();
          s.failures = 0;
        } catch {
          s.failures = Math.min(s.failures + 1, 4);
        } finally {
          s.running = false;
        }
      }
      return ran;
    }
    return {
      tick,
      /** A read that just happened outside the timer (manual refresh, a push) restarts the wait. */
      touched(id) {
        const s = state.get(id);
        if (s) s.last = now();
      },
      interval: (id) => {
        const task = tasks.find((t) => t.id === id);
        return task ? interval(task) : null;
      },
    };
  }

  /** Runs a page's scheduler every 15 s until the page goes away. */
  function every(tasks, { alive, pollers }) {
    const plan = scheduler(tasks, { alive });
    const timer = setInterval(() => {
      if (!alive()) {
        clearInterval(timer);
        return;
      }
      void plan.tick();
    }, 15_000);
    if (pollers) pollers.add(timer);
    return plan;
  }

  if (doc && typeof setInterval === "function" && doc.addEventListener) {
    setInterval(() => repaint(), 30_000);
    doc.addEventListener("visibilitychange", () =>
      notify({ type: "visibility", visible: visible() }),
    );
  }

  return {
    SOURCES,
    CURRENT_MS,
    OTHERS_MS,
    freshness,
    onShellEvent,
    ingest,
    mark,
    pick,
    pushedAt,
    freshLine,
    repaint,
    subscribe,
    scheduler,
    every,
    visible,
  };
};
