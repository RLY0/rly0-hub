"use strict";
// Provider-specific reset actions. Uses the existing tile/dialog/button components.
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
        title: attempt ? "核实上次重置" : "使用一张额度重置卡",
        sub: account.email || account.alias || "所选 Codex 账号",
        onClose: () => {
          closed = true;
          if (!submitting) busy.delete(account.id);
        },
      });
      const result = h("p", { class: "sub", role: "status" });
      dialog.body.append(
        h(
          "p",
          null,
          attempt
            ? "上次结果尚未确认，将用原请求核实同一张卡。"
            : "将消耗所选账号的一张卡，重置官方允许的 Codex 额度窗口；不能撤销，也不会切换当前登录。",
        ),
        !attempt && ready.expiresAt
          ? h("p", { class: "sub" }, `到期时间：${ready.expiresAt}`)
          : h("span"),
        result,
      );
      const confirm = h(
        "button",
        { class: "btn paper", type: "button" },
        attempt ? "核实上次使用结果" : "确认使用一张",
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
            reset: "官方确认已使用一张重置卡。正在重新查询额度。",
            alreadyRedeemed: "官方确认这次请求此前已使用，未重复消耗。正在查询额度。",
            nothingToReset: "官方确认当前没有可重置的额度窗口。",
            noCredit: "官方确认没有可用的重置卡。",
          };
          if (!response || !messages[response.outcome]) throw new Error("RESET_RESULT_UNKNOWN");
          // Never fake 100% or decrement a cached count. Read actual usage after confirmation.
          result.textContent = messages[response.outcome];
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
            } catch {
              result.textContent += " 额度刷新失败，请稍后刷新核实。";
            }
          }
        } catch (error) {
          result.textContent = errors[error.message] || "无法确认使用结果。请稍后核实同一请求。";
          confirm.textContent = "核实上次使用结果";
          confirm.disabled = false;
        } finally {
          submitting = false;
          if (closed) busy.delete(account.id);
        }
      };
      dialog.foot.append(
        h("button", { class: "btn", type: "button", onclick: dialog.close }, "关闭"),
        confirm,
      );
    } catch (error) {
      toast(errors[error.message] || "无法读取重置卡，未发起新的使用操作。");
    } finally {
      if (!dialog) busy.delete(account.id);
    }
  }
  function tile(count, options = {}) {
    const { vendor, account, refreshed } = options;
    if (vendor === "openai" && account && account.plan !== "api-key")
      return resetCardTile(count, {
        onUse: () => use(account, refreshed),
        reason: "点击核实官方库存，再确认使用所选账号的一张卡。",
        action: "使用重置卡",
      });
    if (vendor === "anthropic")
      return resetCardTile(undefined, {
        status: "官方查看",
        reason:
          "可用次数需在 Claude 官方页面核实；请确认网页登录的是这张卡对应的账号。使用后回 Hub 刷新额度。",
        action: "前往官方重置",
        onUse: () =>
          call("links.open", { target: "claudeUsage" }).catch(() => toast("打开官方页面失败")),
      });
    return resetCardTile(undefined, {
      status: vendor === "api-key" ? "不适用" : vendor === "openai" ? "待保存" : "未接通",
      reason:
        vendor === "api-key"
          ? "API Key 按用量计费，不适用订阅额度重置卡。"
          : vendor === "openai"
            ? "请先保存这个登录，再核实和使用重置卡。"
            : "尚未核实到此平台可用的重置卡接口，Hub 无法执行重置。",
    });
  }
  return { tile };
};
