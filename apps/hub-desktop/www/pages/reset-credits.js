"use strict";
// Codex reset-card actions (the only platform whose reset cards the Hub can use). Uses the existing tile/dialog/button components.
window.registerHubResetCredits = ({ h, call, toast, resetCardTile }) => {
  const busy = new Set();
  const errors = {
    RESET_RESULT_UNKNOWN: "使用结果暂时无法确认。再次点击只会核实同一张卡，不会另用一张。",
    RESET_ACCOUNT_CHANGED: "这个账号的登录已变化，已停止使用。请重新核对账号和上次使用结果。",
    RESET_NOT_ELIGIBLE: "官方未允许这次重置，请到官方额度页核实。",
    USAGE_RATE_LIMITED: "官方暂时限制查询，请稍后再试。",
    USAGE_TOKEN_EXPIRED: "登录已过期，请重新登录这个账号后重试。",
    METHOD_NOT_FOUND: "后台版本还不支持使用重置卡，请更新完整安装包。",
    RLY0_CORE_UNAVAILABLE: "后台服务还没准备好。",
    RESET_BUSY: "上次使用仍在执行，请稍后核实。",
    RESET_PENDING: "后台保留了未确认的使用记录，请先核实上一次结果。",
    RESET_STATE_UNAVAILABLE: "重置卡使用记录暂时无法读取或保存，已停止操作。",
  };
  async function use(account, refreshed) {
    if (busy.has(account.id)) return;
    busy.add(account.id);
    let dialog;
    let submitting = false;
    let closed = false;
    try {
      // Core's durable journal owns pending requests, even after browser data is cleared.
      const ready = await call("accounts.resetPrepare", { id: account.id });
      let attempt =
        ready && ready.pendingRequestId
          ? {
              id: account.id,
              requestId: ready.pendingRequestId,
              creditId: ready.creditId,
              revision: ready.revision,
              confirmed: true,
            }
          : null;
      if (!attempt && (!ready || !ready.creditId || ready.availableCount < 1)) {
        toast("这个账号没有可在 Hub 使用的重置卡。未知类型请到官方额度页核实。");
        return;
      }
      dialog = window.HubUI.dialog({
        title: attempt ? "核实上次重置" : "使用 1 张额度重置卡？",
        sub: attempt
          ? account.email || account.alias || "所选 Codex 账号"
          : "确认后才会使用，取消不会消耗",
        onClose: () => {
          closed = true;
          if (!submitting) busy.delete(account.id);
        },
      });
      const result = h("p", { class: "sub reset-result", role: "status", "aria-live": "polite" });
      const name = account.email || account.alias || "所选 Codex 账号";
      const windows = (account.lastUsage && account.lastUsage.windows) || [];
      const windowText = windows.length
        ? windows
            .map(
              (w) =>
                `${w.label || (w.kind === "primary" ? "5 小时额度" : "每周额度")}（现在剩 ${Math.max(0, Math.round(100 - w.usedPercent))}%）`,
            )
            .join("、")
        : "5 小时额度和每周额度";
      const fact = (label, text) =>
        h("div", { class: "reset-fact" }, h("span", { class: "label" }, label), h("b", null, text));
      dialog.body.append(
        attempt
          ? h("p", null, "上次使用的结果还没确认。这次只会用原来的请求核实同一张卡，不会另用一张。")
          : h(
              "div",
              { class: "reset-facts" },
              fact("账号", name),
              fact(
                "消耗",
                `1 张额度重置卡（现有 ${ready.availableCount} 张，用后剩 ${ready.availableCount - 1} 张）`,
              ),
              fact("重置", `这个账号的 ${windowText}，以官方实际重置为准`),
              ready.expiresAt ? fact("这张卡到期", ready.expiresAt) : null,
            ),
        attempt ? h("span") : h("p", { class: "sub" }, "用掉后不能撤销。"),
        result,
      );
      const confirm = h(
        "button",
        { class: "btn paper", type: "button" },
        attempt ? "核实上次使用结果" : "确认使用 1 张",
      );
      const close = h(
        "button",
        { class: "btn", type: "button", style: { "margin-left": "auto" }, onclick: dialog.close },
        "取消",
      );
      confirm.onclick = async () => {
        if (confirm.disabled) return;
        confirm.disabled = true;
        submitting = true;
        result.textContent = "正在向官方确认，请稍候…";
        try {
          if (!attempt) {
            attempt = {
              id: account.id,
              requestId: crypto.randomUUID(),
              creditId: ready.creditId,
              revision: ready.revision,
              confirmed: true,
            };
          }
          const response = await call("accounts.resetConsume", attempt);
          const messages = {
            reset: "成功：官方确认已用掉 1 张重置卡，额度已重置。",
            alreadyRedeemed: "官方确认这次请求此前已经用过，没有重复消耗。",
            nothingToReset: "官方确认现在没有可以重置的额度窗口，没有消耗重置卡。",
            noCredit: "官方确认这个账号没有可用的重置卡，没有消耗。",
          };
          if (!response || !messages[response.outcome]) throw new Error("RESET_RESULT_UNKNOWN");
          // Never fake 100% or decrement a cached count. Read actual usage after confirmation.
          const refreshes = response.outcome === "reset" || response.outcome === "alreadyRedeemed";
          result.textContent = messages[response.outcome] + (refreshes ? " 正在刷新额度…" : "");
          if (closed) toast(messages[response.outcome]);
          try {
            await call("accounts.resetAcknowledge", {
              id: account.id,
              requestId: attempt.requestId,
            });
          } catch {
            result.textContent += " 本机结果记录尚未完成，下次会继续显示本次结果。";
          }
          if (refreshed) {
            try {
              await refreshed();
              if (refreshes)
                result.textContent = `${messages[response.outcome]} 额度已刷新，卡片上是最新数字。`;
            } catch {
              result.textContent += " 额度刷新失败，请稍后刷新核实。";
            }
          }
          close.textContent = "完成";
        } catch (error) {
          result.textContent = errors[error.message] || "无法确认使用结果。请稍后核实同一请求。";
          confirm.textContent = "核实上次使用结果";
          confirm.disabled = false;
        } finally {
          submitting = false;
          if (closed) busy.delete(account.id);
        }
      };
      dialog.foot.append(close, confirm);
      // Focus starts on 取消, so Enter alone never uses a card.
      if (typeof close.focus === "function") setTimeout(() => close.focus(), 0);
    } catch (error) {
      toast(errors[error.message] || "无法读取重置卡，未发起新的使用操作。");
    } finally {
      if (!dialog) busy.delete(account.id);
    }
  }
  function tile(count, options = {}) {
    const { vendor, account, refreshed } = options;
    if (vendor === "openai" && account && account.plan !== "api-key") {
      // Never consumes on click: "使用" opens the confirmation, which checks the official stock.
      if (count === 0)
        return resetCardTile(0, {
          reason: "暂时没有官方赠送的重置卡",
          action: "使用",
          disabledReason: "没有可用的重置卡",
        });
      return resetCardTile(count, {
        onUse: () => use(account, refreshed),
        reason: Number.isInteger(count)
          ? "点“使用”先核对，确认后才消耗"
          : "张数待核实；点“核实”向官方查询，确认后才会使用",
        action: Number.isInteger(count) ? "使用" : "核实",
        primary: Number.isInteger(count),
        label: `使用一张额度重置卡：${account.email || account.alias || "所选 Codex 账号"}`,
      });
    }
    // Only Codex (OpenAI subscription) cards can be used from the Hub. A Codex login that is not
    // saved yet says so; every other platform and API keys get no tile at all.
    if (vendor !== "openai" || (account && account.plan === "api-key")) return null;
    return resetCardTile(undefined, {
      status: "待保存",
      reason: "保存后可用",
    });
  }
  return { tile };
};
