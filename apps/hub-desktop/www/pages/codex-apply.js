"use strict";
// One way for every setting to reach the running Codex without manual steps (service side:
// codex-apply.ts). `backend`: Codex swaps its backend in place. `window`: Codex reopens itself,
// right away when idle or once the running work ends. Only when the Hub cannot see Codex's state
// does it ask, and then one click does the rest.
window.registerHubCodexApply = ({ h, call, toast }) => {
  // `lead` says what was just saved, e.g. "已开启"; the rest says how it reaches Codex.
  const done = {
    reloaded: (lead) => `${lead}，已经生效，不用重启 Codex`,
    deferred: (lead) => `${lead}，Codex 回复完这一条就生效`,
    notRunning: (lead) => `${lead}，下次打开 Codex 时自动生效`,
    restarting: (lead) => `${lead}，Codex 正在重新打开`,
    scheduled: (lead) => `${lead}，Codex 忙完手上的任务后会自动重新打开`,
    failed: (lead) => `${lead}，但没能自动重新打开 Codex，下次打开时生效`,
  };

  function askOnce(scope, what) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      const ui = window.HubUI.dialog({
        title: "立即应用",
        sub: what,
        onClose: () => {
          if (settled) return;
          toast(done.notRunning(what));
          finish("later");
        },
      });
      const now = h("button", { class: "btn paper", type: "button" }, "立即应用");
      now.addEventListener("click", async () => {
        now.disabled = true;
        settled = true;
        const r = await call("codex.applySettings", { scope, restartNow: true }).catch(() => null);
        const outcome = (r && r.outcome) || "failed";
        toast((done[outcome] || done.failed)(what));
        resolve(outcome);
        ui.close();
      });
      ui.body.append(
        h("p", null, "这个 Codex 不是从 Hub 打开的，需要重启才能生效。"),
        h("p", { class: "sub" }, "Codex 会关闭再打开，正在进行的回复会中断。"),
      );
      ui.foot.append(
        h("span", { class: "spacer" }),
        h("button", { class: "btn quiet", type: "button", onclick: () => ui.close() }, "稍后"),
        now,
      );
      requestAnimationFrame(() => now.focus());
    });
  }

  /** Applies a just-saved change; `what` is the lead of the message (e.g. "已开启"). */
  async function apply(scope, what) {
    const r = await call("codex.applySettings", { scope }).catch(() => null);
    const outcome = (r && r.outcome) || "failed";
    if (outcome === "needsRestart") return askOnce(scope, what);
    toast((done[outcome] || done.failed)(what));
    return outcome;
  }

  return { apply };
};
