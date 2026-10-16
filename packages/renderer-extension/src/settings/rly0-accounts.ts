import type {
  Rly0Account,
  Rly0AccountsAddLoginCancelParams,
  Rly0AccountsAddLoginCancelResult,
  Rly0AccountsAddLoginStartParams,
  Rly0AccountsAddLoginStartResult,
  Rly0AccountsAddLoginStatusParams,
  Rly0AccountsAddLoginStatusResult,
  Rly0AccountsImportCurrentParams,
  Rly0AccountsImportCurrentResult,
  Rly0AccountsRemoveParams,
  Rly0AccountsRemoveResult,
  Rly0AccountsRenameParams,
  Rly0AccountsRenameResult,
  Rly0AccountsSwitchParams,
  Rly0AccountsSwitchResult,
  Rly0AccountsListResult,
  Rly0AccountsUsageAllResult,
  Rly0AccountsUsageParams,
  Rly0AccountsUsageResult,
  Rly0AccountUsage,
  Rly0AccountUsageEntry,
  Rly0CoreStatusResult,
} from "@codexhost/shared-contracts";
import { renderAccountUsage } from "./accounts-usage.js";
import { switchResultMessage } from "./rly0-account-messages.js";
import type { RendererSettingsMessages } from "./localization.js";
import {
  formatRly0RelativeTime,
  rly0ErrorCode,
  rly0UsageErrorMessage,
  rly0UsageToCredits,
} from "./rly0-usage.js";

export interface RendererRly0AccountClient {
  rly0CoreStatus?(): Promise<Rly0CoreStatusResult>;
  listRly0Accounts?(): Promise<Rly0AccountsListResult>;
  importCurrentRly0Account?(
    input: Rly0AccountsImportCurrentParams,
  ): Promise<Rly0AccountsImportCurrentResult>;
  switchRly0Account?(input: Rly0AccountsSwitchParams): Promise<Rly0AccountsSwitchResult>;
  renameRly0Account?(input: Rly0AccountsRenameParams): Promise<Rly0AccountsRenameResult>;
  removeRly0Account?(input: Rly0AccountsRemoveParams): Promise<Rly0AccountsRemoveResult>;
  rly0AccountUsage?(input: Rly0AccountsUsageParams): Promise<Rly0AccountsUsageResult>;
  rly0AccountUsageAll?(): Promise<Rly0AccountsUsageAllResult>;
  startRly0AddAccountLogin?(
    input: Rly0AccountsAddLoginStartParams,
  ): Promise<Rly0AccountsAddLoginStartResult>;
  rly0AddAccountLoginStatus?(
    input: Rly0AccountsAddLoginStatusParams,
  ): Promise<Rly0AccountsAddLoginStatusResult>;
  cancelRly0AddAccountLogin?(
    input: Rly0AccountsAddLoginCancelParams,
  ): Promise<Rly0AccountsAddLoginCancelResult>;
}

const ADD_LOGIN_POLL_MS = 1_500;

function addLoginErrorMessage(
  code: string | null | undefined,
  messages: RendererSettingsMessages["rly0Accounts"],
): string {
  if (code === "LOGIN_TIMEOUT") return messages.addTimeout;
  if (code === "LOGIN_FAILED" || code === "LOGIN_NOT_COMPLETED") return messages.addLoginFailed;
  if (code === "RLY0_CORE_UNAVAILABLE") return messages.unavailableHint;
  return messages.addFailed;
}

/** Per saved account: the newest known usage (live or the core's cached snapshot) and last error. */
interface Rly0UsageState {
  usage?: Rly0AccountUsage;
  error?: string | null;
  loading: boolean;
}

type DialogMode = "save" | "add" | "switch" | "rename" | "remove" | "terms";

/** Set once the person acknowledged the multi-account notice; it is shown only once. */
export const RLY0_MULTI_ACCOUNT_TERMS_STORAGE_KEY = "codexhost.rly0-multi-account-terms.v1";

export function rly0AccountDisplayName(account: Rly0Account): string {
  return account.alias?.trim() || account.email || account.id;
}

/**
 * "已保存账号" / "Saved accounts" section, rendered below the live Codex account table. Backed by
 * the optional closed-source `rly0-core` bridge: hidden buttons and a small notice when it is not
 * installed, a simple list with switch/rename/remove otherwise. Switching and removing always go
 * through an explicit confirmation dialog; a switch never restarts Codex itself, it only tells the
 * person to do so.
 */
export function mountRly0Accounts(
  root: HTMLElement,
  signal: AbortSignal,
  getClient: () => RendererRly0AccountClient | null,
  settingsMessages: RendererSettingsMessages,
  changed: () => void,
  loginOnly = false,
) {
  const messages = settingsMessages.rly0Accounts;
  const document = root.ownerDocument;
  const usageById = new Map<string, Rly0UsageState>();
  let available = false;
  let accounts: readonly Rly0Account[] = [];
  let busy = false;
  let notice: { text: string; tone: "error" | "info" } | null = null;
  let dialog: HTMLDialogElement | undefined;

  const section = document.createElement("section");
  section.className = "settings-rly0-accounts";
  section.tabIndex = -1;
  section.setAttribute("aria-label", messages.sectionTitle);
  const header = document.createElement("div");
  header.className = "settings-rly0-accounts__header";
  const title = document.createElement("strong");
  title.textContent = loginOnly ? messages.addTitle : messages.sectionTitle;
  header.append(title);
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "settings-command-button settings-command-button--secondary";
  saveButton.textContent = messages.save;
  saveButton.addEventListener("click", () => requestAccountDialog("save"));
  const addButton = document.createElement("button");
  addButton.type = "button";
  addButton.className = "settings-command-button";
  addButton.textContent = messages.add;
  addButton.addEventListener("click", () => requestAccountDialog("add"));
  const refreshAllButton = document.createElement("button");
  refreshAllButton.type = "button";
  refreshAllButton.className = "settings-command-button settings-command-button--secondary";
  refreshAllButton.textContent = messages.usageRefreshAll;
  refreshAllButton.addEventListener("click", () => void refreshAllUsage());
  const headerActions = document.createElement("div");
  headerActions.className = "settings-rly0-accounts__header-actions";
  headerActions.append(refreshAllButton, saveButton, addButton);
  header.append(headerActions);
  const card = document.createElement("div");
  card.className = "settings-rly0-accounts__card";
  const noticeElement = document.createElement("p");
  noticeElement.className = "settings-rly0-accounts__notice";
  noticeElement.setAttribute("role", "status");
  section.append(header, noticeElement, card);

  const rows = new Map<string, HTMLElement>();

  const run = async <T extends { available: boolean }>(
    action: () => Promise<T>,
    onSuccess: (result: Extract<T, { available: true }>) => void,
    failureMessage: string,
  ): Promise<boolean> => {
    if (busy || signal.aborted) return false;
    busy = true;
    render();
    let ok = false;
    try {
      const result = await action();
      if (signal.aborted) return false;
      if (!result.available) {
        notice = { text: messages.unavailableHint, tone: "error" };
        available = false;
      } else {
        notice = null;
        onSuccess(result as Extract<T, { available: true }>);
        ok = true;
      }
    } catch {
      notice = { text: failureMessage, tone: "error" };
    } finally {
      busy = false;
      if (!signal.aborted) {
        render();
        changed();
      }
    }
    return ok;
  };

  const seedUsage = (): void => {
    const keep = new Set(accounts.map((account) => account.id));
    for (const id of [...usageById.keys()]) if (!keep.has(id)) usageById.delete(id);
    for (const account of accounts) {
      const state = usageById.get(account.id) ?? { loading: false };
      const cached = account.lastUsage;
      if (cached && (!state.usage || state.usage.fetchedAt < cached.fetchedAt)) {
        state.usage = cached;
      }
      usageById.set(account.id, state);
    }
  };

  const refreshAccounts = async (): Promise<void> => {
    const client = getClient();
    const listAccounts = client?.listRly0Accounts;
    if (!listAccounts) return;
    try {
      const result = await listAccounts();
      if (signal.aborted) return;
      accounts = result.available ? result.accounts : [];
    } catch {
      if (!signal.aborted) accounts = [];
    }
    seedUsage();
  };

  const applyUsageResults = (results: readonly Rly0AccountUsageEntry[]): void => {
    for (const entry of results) {
      const state = usageById.get(entry.id);
      if (!state) continue;
      if ("usage" in entry) {
        state.usage = entry.usage;
        state.error = null;
      } else {
        state.error = entry.error;
      }
    }
  };

  const refreshUsage = async (account: Rly0Account): Promise<void> => {
    const lookup = getClient()?.rly0AccountUsage;
    const state = usageById.get(account.id);
    if (!lookup || !state || state.loading || signal.aborted) return;
    state.loading = true;
    render();
    try {
      const result = await lookup({ id: account.id });
      if (signal.aborted) return;
      if (result.available) {
        state.usage = result.usage;
        state.error = null;
      } else {
        state.error = "RLY0_CORE_UNAVAILABLE";
      }
    } catch (error) {
      if (!signal.aborted) state.error = rly0ErrorCode(error) ?? "USAGE_FAILED";
    } finally {
      state.loading = false;
      if (!signal.aborted) {
        render();
        changed();
      }
    }
  };

  let refreshingAll = false;
  const refreshAllUsage = async (): Promise<void> => {
    const lookupAll = getClient()?.rly0AccountUsageAll;
    if (!lookupAll || refreshingAll || signal.aborted || accounts.length === 0) return;
    refreshingAll = true;
    for (const state of usageById.values()) state.loading = true;
    render();
    try {
      const result = await lookupAll();
      if (signal.aborted) return;
      if (result.available) applyUsageResults(result.results);
      else notice = { text: messages.unavailableHint, tone: "error" };
    } catch (error) {
      if (!signal.aborted) {
        notice = { text: rly0UsageErrorMessage(rly0ErrorCode(error), messages), tone: "error" };
      }
    } finally {
      refreshingAll = false;
      for (const state of usageById.values()) state.loading = false;
      if (!signal.aborted) {
        render();
        changed();
      }
    }
  };

  const renderUsage = (account: Rly0Account): HTMLElement => {
    const state = usageById.get(account.id) ?? { loading: false };
    const wrapper = document.createElement("div");
    wrapper.className = "settings-rly0-accounts__usage";
    const credits = state.usage ? rly0UsageToCredits(state.usage) : null;
    if (credits) {
      const rendered = renderAccountUsage(
        document,
        {
          status: "ready",
          credits,
          freshness: state.usage?.source === "live" ? "live" : "cached",
          observedAt: null,
        },
        settingsMessages,
        "remaining",
        () => void refreshUsage(account),
      );
      const table = document.createElement("table");
      table.className = "settings-account-table settings-rly0-accounts__usage-table";
      const body = document.createElement("tbody");
      for (const cells of [rendered.cells, ...rendered.continuationCells]) {
        const tableRow = document.createElement("tr");
        tableRow.append(...cells);
        body.append(tableRow);
      }
      table.append(body);
      wrapper.append(table);
      if (rendered.additional) wrapper.append(rendered.additional);
    }
    const status = document.createElement("div");
    status.className = "settings-rly0-accounts__usage-status";
    const statusText = document.createElement("span");
    if (state.loading) statusText.textContent = messages.usageRefreshing;
    else if (state.usage) {
      const updated = messages.usageUpdated.replace(
        "{time}",
        formatRly0RelativeTime(state.usage.fetchedAt, messages),
      );
      statusText.textContent =
        state.usage.source === "snapshot" ? `${updated} · ${messages.usageCached}` : updated;
    } else statusText.textContent = messages.usageEmpty;
    status.append(statusText);
    if (state.error && !state.loading) {
      const errorText = document.createElement("span");
      errorText.className = "settings-rly0-accounts__usage-error";
      errorText.setAttribute("role", "alert");
      errorText.textContent = rly0UsageErrorMessage(state.error, messages);
      status.append(errorText);
    }
    const refreshButton = document.createElement("button");
    refreshButton.type = "button";
    refreshButton.className = "settings-account-action";
    refreshButton.textContent = messages.usageRefresh;
    refreshButton.disabled = state.loading || !getClient()?.rly0AccountUsage;
    refreshButton.addEventListener("click", () => void refreshUsage(account));
    status.append(refreshButton);
    wrapper.append(status);
    return wrapper;
  };

  const renderRow = (account: Rly0Account): HTMLElement => {
    const row = document.createElement("div");
    row.className = "settings-rly0-accounts__row";
    row.tabIndex = -1;
    row.dataset.rly0AccountId = account.id;
    const name = rly0AccountDisplayName(account);
    row.setAttribute("aria-label", name);
    const identity = document.createElement("div");
    identity.className = "settings-rly0-accounts__identity";
    const label = document.createElement("strong");
    label.className = "settings-account-email";
    label.textContent = name;
    label.translate = false;
    const meta = document.createElement("div");
    meta.className = "settings-account-metadata";
    const parts: string[] = [];
    if (account.email && account.email !== name) parts.push(account.email);
    if (account.plan) parts.push(account.plan);
    parts.forEach((part, index) => {
      if (index > 0) {
        const separator = document.createElement("span");
        separator.textContent = "·";
        separator.setAttribute("aria-hidden", "true");
        meta.append(separator);
      }
      const span = document.createElement("span");
      span.textContent = part;
      span.translate = false;
      meta.append(span);
    });
    if (account.current) {
      const badge = document.createElement("span");
      badge.className = "settings-account-active";
      badge.textContent = messages.currentBadge;
      meta.append(badge);
    }
    identity.append(label);
    if (meta.childElementCount) identity.append(meta);
    const actions = document.createElement("div");
    actions.className = "settings-rly0-accounts__actions";
    const switchButton = document.createElement("button");
    switchButton.type = "button";
    switchButton.className = "settings-account-action";
    switchButton.textContent = messages.switchAction;
    switchButton.disabled = busy || account.current;
    switchButton.addEventListener("click", () => openDialog("switch", account));
    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "settings-account-action";
    renameButton.textContent = messages.renameAction;
    renameButton.disabled = busy;
    renameButton.addEventListener("click", () => openDialog("rename", account));
    const removeButton = document.createElement("button");
    removeButton.type = "button";
    removeButton.className = "settings-account-action settings-pi-accounts__remove";
    removeButton.textContent = messages.removeAction;
    removeButton.disabled = busy;
    removeButton.addEventListener("click", () => openDialog("remove", account));
    actions.append(switchButton, renameButton, removeButton);
    const top = document.createElement("div");
    top.className = "settings-rly0-accounts__row-top";
    top.append(identity, actions);
    row.append(top, renderUsage(account));
    rows.set(account.id, row);
    return row;
  };

  const render = (): void => {
    saveButton.disabled = busy || !available;
    saveButton.hidden = loginOnly || !available;
    const canAdd = Boolean(addLoginClient());
    addButton.disabled = busy || !available || !canAdd;
    addButton.hidden = !available || !canAdd;
    refreshAllButton.hidden = loginOnly || !available || accounts.length === 0;
    refreshAllButton.disabled =
      refreshingAll || !getClient()?.rly0AccountUsageAll || accounts.length === 0;
    refreshAllButton.textContent = refreshingAll
      ? messages.usageRefreshing
      : messages.usageRefreshAll;
    const baseNoticeClass = "settings-rly0-accounts__notice";
    if (notice) {
      noticeElement.textContent = notice.text;
      noticeElement.hidden = false;
      noticeElement.className =
        notice.tone === "error" ? `${baseNoticeClass} ${baseNoticeClass}--error` : baseNoticeClass;
    } else if (!available) {
      noticeElement.textContent = messages.unavailableHint;
      noticeElement.hidden = false;
      noticeElement.className = baseNoticeClass;
    } else {
      noticeElement.hidden = true;
    }
    rows.clear();
    if (loginOnly || !available) {
      card.replaceChildren();
      return;
    }
    if (accounts.length === 0) {
      const empty = document.createElement("p");
      empty.className = "settings-rly0-accounts__empty";
      empty.textContent = messages.empty;
      card.replaceChildren(empty);
      return;
    }
    card.replaceChildren(...accounts.map(renderRow));
  };

  const termsAcknowledged = (): boolean => {
    try {
      return (
        document.defaultView?.localStorage.getItem(RLY0_MULTI_ACCOUNT_TERMS_STORAGE_KEY) === "1"
      );
    } catch {
      return false;
    }
  };
  /** Saving or adding a second account first shows the terms notice once. */
  const requestAccountDialog = (mode: "save" | "add"): void => {
    if (accounts.length >= 1 && !termsAcknowledged()) openDialog("terms", null, mode);
    else openDialog(mode, null);
  };

  const openDialog = (
    mode: DialogMode,
    account: Rly0Account | null,
    next?: "save" | "add",
  ): void => {
    if (busy || dialog || signal.aborted) return;
    const modal = document.createElement("dialog");
    dialog = modal;
    modal.className = "settings-account-dialog settings-credential-dialog";
    const heading = document.createElement("h2");
    const body = document.createElement("div");
    body.className = "settings-credential-dialog__body";
    const error = document.createElement("p");
    error.className = "settings-credential-dialog__error";
    error.setAttribute("role", "alert");
    const controls = document.createElement("div");
    controls.className = "settings-credential-dialog__actions";
    modal.append(heading, body, error, controls);

    const command = (
      text: string,
      onClick: () => void | Promise<void>,
      variant: "primary" | "secondary" | "danger" = "secondary",
    ): HTMLButtonElement => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = text;
      button.className =
        variant === "primary"
          ? "settings-command-button"
          : variant === "danger"
            ? "settings-command-button settings-command-button--secondary settings-command-button--danger"
            : "settings-command-button settings-command-button--secondary";
      button.addEventListener("click", () => void onClick());
      return button;
    };
    const note = (text: string): HTMLElement => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    };
    const setBusy = (value: boolean): void => {
      for (const child of controls.children) (child as HTMLButtonElement).disabled = value;
    };
    const close = (): void => modal.close();
    let onDialogClose: (() => void) | undefined;

    const name = account ? rly0AccountDisplayName(account) : "";

    if (mode === "terms") {
      heading.textContent = messages.termsTitle;
      body.append(note(messages.termsBody));
      controls.append(
        command(messages.cancel, close),
        command(
          messages.termsAcknowledge,
          () => {
            try {
              document.defaultView?.localStorage.setItem(RLY0_MULTI_ACCOUNT_TERMS_STORAGE_KEY, "1");
            } catch {
              // Storage unavailable: the notice simply shows again next time.
            }
            if (next) onDialogClose = () => queueMicrotask(() => openDialog(next, null));
            close();
          },
          "primary",
        ),
      );
    } else if (mode === "add") {
      heading.textContent = messages.addTitle;
      const label = document.createElement("label");
      label.className = "settings-credential-dialog__field";
      const caption = document.createElement("span");
      caption.textContent = messages.aliasColumn;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.autocomplete = "off";
      label.append(caption, input);
      const status = document.createElement("p");
      status.className = "settings-rly0-accounts__add-status";
      status.setAttribute("role", "status");
      status.hidden = true;
      const linkRow = document.createElement("div");
      linkRow.className = "settings-rly0-accounts__add-link";
      linkRow.hidden = true;
      body.append(note(messages.addBody), label, status, linkRow);

      let loginId: string | null = null;
      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let pollErrors = 0;
      const stopPolling = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
      };
      onDialogClose = () => {
        stopPolling();
        // Closing the dialog while the browser sign-in is still open abandons that login.
        if (loginId && !finished) {
          void addLoginClient()
            ?.cancelRly0AddAccountLogin({ loginId })
            .catch(() => {});
        }
      };
      const cancelButton = command(messages.cancel, close);
      const startButton = command(
        messages.addStart,
        async () => {
          const api = addLoginClient();
          if (!api) {
            error.textContent = messages.addFailed;
            return;
          }
          error.textContent = "";
          startButton.disabled = true;
          startButton.textContent = messages.addStarting;
          input.disabled = true;
          const alias = input.value.trim();
          try {
            const started = await api.startRly0AddAccountLogin(alias ? { alias } : {});
            if (!started.available) {
              resetStart(messages.unavailableHint);
              return;
            }
            if (!modal.open || signal.aborted) {
              void api.cancelRly0AddAccountLogin({ loginId: started.loginId }).catch(() => {});
              return;
            }
            loginId = started.loginId;
            finished = false;
            showLink(started.authUrl);
            poll();
          } catch (failure) {
            resetStart(addLoginErrorMessage(rly0ErrorCode(failure), messages));
          }
        },
        "primary",
      );
      const resetStart = (message: string): void => {
        stopPolling();
        loginId = null;
        error.textContent = message;
        status.hidden = true;
        linkRow.hidden = true;
        linkRow.replaceChildren();
        input.disabled = false;
        startButton.hidden = false;
        startButton.disabled = false;
        startButton.textContent = messages.addStart;
      };
      const showLink = (authUrl: string): void => {
        const hint = document.createElement("span");
        hint.textContent = messages.addLinkHint;
        const link = document.createElement("a");
        link.className = "settings-command-button settings-command-button--secondary";
        link.href = authUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = messages.addOpenLink;
        const copy = document.createElement("button");
        copy.type = "button";
        copy.className = "settings-command-button settings-command-button--secondary";
        copy.textContent = messages.addCopyLink;
        copy.addEventListener("click", () => {
          void document.defaultView?.navigator.clipboard
            ?.writeText(authUrl)
            .then(() => {
              copy.textContent = messages.addCopied;
            })
            .catch(() => {});
        });
        linkRow.replaceChildren(hint, link, copy);
        linkRow.hidden = false;
        status.textContent = messages.addWaiting;
        status.hidden = false;
        startButton.hidden = true;
        // Same path as any external link on this page: Codex hands it to the system browser.
        link.click();
      };
      const poll = (): void => {
        stopPolling();
        timer = setTimeout(() => {
          timer = undefined;
          const api = addLoginClient();
          const id = loginId;
          if (!api || !id || !modal.open || signal.aborted) return;
          void api.rly0AddAccountLoginStatus({ loginId: id }).then(
            async (result) => {
              if (!modal.open || signal.aborted || loginId !== id) return;
              pollErrors = 0;
              if (result.state === "pending") {
                poll();
                return;
              }
              finished = true;
              if (result.state === "completed") {
                await refreshAccounts();
                const added = accounts.find((entry) => entry.id === result.id);
                notice = {
                  text: messages.addDone.replace(
                    "{name}",
                    added ? rly0AccountDisplayName(added) : result.id,
                  ),
                  tone: "info",
                };
                close();
                return;
              }
              if (result.state === "cancelled") {
                resetStart("");
                return;
              }
              resetStart(addLoginErrorMessage(result.error, messages));
            },
            () => {
              pollErrors += 1;
              if (pollErrors >= 5) resetStart(messages.addFailed);
              else poll();
            },
          );
        }, ADD_LOGIN_POLL_MS);
      };
      controls.append(cancelButton, startButton);
      input.focus();
    } else if (mode === "save") {
      heading.textContent = messages.save;
      const label = document.createElement("label");
      label.className = "settings-credential-dialog__field";
      const caption = document.createElement("span");
      caption.textContent = messages.aliasColumn;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.autocomplete = "off";
      label.append(caption, input);
      body.append(label);
      controls.append(
        command(messages.cancel, close),
        command(
          messages.save,
          async () => {
            error.textContent = "";
            setBusy(true);
            const alias = input.value.trim();
            const ok = await run(
              () => client().importCurrentRly0Account(alias ? { alias } : {}),
              async () => {
                await refreshAccounts();
              },
              messages.saveFailed,
            );
            if (!ok) {
              error.textContent = messages.saveFailed;
              setBusy(false);
              return;
            }
            close();
          },
          "primary",
        ),
      );
    } else if (mode === "switch" && account) {
      heading.textContent = messages.switchConfirmTitle;
      body.append(note(messages.switchConfirmBody.replace("{name}", name)));
      const cancel = command(messages.cancel, close);
      controls.append(
        cancel,
        command(
          messages.switchConfirm,
          async () => {
            error.textContent = "";
            setBusy(true);
            const ok = await run<Rly0AccountsSwitchResult>(
              () => client().switchRly0Account({ id: account.id }),
              async (result) => {
                await refreshAccounts();
                notice = result.alreadyCurrent
                  ? { text: messages.switchAlreadyCurrent.replace("{name}", name), tone: "info" }
                  : {
                      text: switchResultMessage(messages, result).replace("{name}", name),
                      tone: "info",
                    };
              },
              messages.switchFailed,
            );
            if (!ok) {
              error.textContent = messages.switchFailed;
              setBusy(false);
              return;
            }
            close();
          },
          "primary",
        ),
      );
      cancel.focus();
    } else if (mode === "remove" && account) {
      heading.textContent = messages.removeConfirmTitle;
      body.append(note(messages.removeConfirmBody.replace("{name}", name)));
      const cancel = command(messages.cancel, close);
      controls.append(
        cancel,
        command(
          messages.removeConfirm,
          async () => {
            error.textContent = "";
            setBusy(true);
            const ok = await run(
              () => client().removeRly0Account({ id: account.id }),
              async () => {
                await refreshAccounts();
              },
              messages.removeFailed,
            );
            if (!ok) {
              error.textContent = messages.removeFailed;
              setBusy(false);
              return;
            }
            close();
          },
          "danger",
        ),
      );
      cancel.focus();
    } else if (mode === "rename" && account) {
      heading.textContent = messages.renameTitle;
      const label = document.createElement("label");
      label.className = "settings-credential-dialog__field";
      const caption = document.createElement("span");
      caption.textContent = messages.renameLabel;
      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 40;
      input.autocomplete = "off";
      input.value = account.alias ?? "";
      label.append(caption, input);
      body.append(label);
      controls.append(
        command(messages.cancel, close),
        command(
          messages.renameConfirm,
          async () => {
            error.textContent = "";
            const alias = input.value.trim();
            if (alias.length < 1 || alias.length > 40) {
              error.textContent = messages.invalidAlias;
              input.focus();
              return;
            }
            setBusy(true);
            const ok = await run(
              () => client().renameRly0Account({ id: account.id, alias }),
              async () => {
                await refreshAccounts();
              },
              messages.renameFailed,
            );
            if (!ok) {
              error.textContent = messages.renameFailed;
              setBusy(false);
              return;
            }
            close();
          },
          "primary",
        ),
      );
      input.focus();
    }

    modal.addEventListener("cancel", (event) => {
      if (busy) event.preventDefault();
    });
    modal.addEventListener("close", () => {
      onDialogClose?.();
      modal.remove();
      dialog = undefined;
      const target = account ? rows.get(account.id) : undefined;
      (target?.isConnected ? target : section).focus();
      render();
      changed();
    });
    root.append(modal);
    modal.showModal();
  };

  const client = (): Required<RendererRly0AccountClient> => {
    const value = getClient();
    if (
      !value?.rly0CoreStatus ||
      !value.listRly0Accounts ||
      !value.importCurrentRly0Account ||
      !value.switchRly0Account ||
      !value.renameRly0Account ||
      !value.removeRly0Account
    ) {
      throw new Error("rly0-core bridge is unavailable");
    }
    return value as Required<RendererRly0AccountClient>;
  };

  /** The optional "add account" methods; absent with an older Host. */
  const addLoginClient = (): Pick<
    Required<RendererRly0AccountClient>,
    "startRly0AddAccountLogin" | "rly0AddAccountLoginStatus" | "cancelRly0AddAccountLogin"
  > | null => {
    const value = getClient();
    if (
      !value?.startRly0AddAccountLogin ||
      !value.rly0AddAccountLoginStatus ||
      !value.cancelRly0AddAccountLogin
    ) {
      return null;
    }
    return value as Required<RendererRly0AccountClient>;
  };

  signal.addEventListener("abort", () => dialog?.remove(), { once: true });
  render();

  return {
    section: section as HTMLElement,
    /** Folds results fetched elsewhere (the low-quota alert's poll) into the saved-account cards. */
    applyUsage(results: readonly Rly0AccountUsageEntry[]): void {
      if (signal.aborted) return;
      applyUsageResults(results);
      render();
      changed();
    },
    /** Re-reads the saved list (after a switch made elsewhere, e.g. from the low-quota alert). */
    async reload(): Promise<void> {
      if (!available) return;
      await refreshAccounts();
      if (!signal.aborted) {
        render();
        changed();
      }
    },
    refresh: async (): Promise<void> => {
      const rly0Client = getClient();
      if (!rly0Client?.rly0CoreStatus) {
        available = false;
        render();
        changed();
        return;
      }
      notice = null;
      // A proxy-settings change restarts rly0-core, which rejects an in-flight hello; one retry
      // after a short pause keeps that transient from reading as "rly0-core is missing".
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const status = await rly0Client.rly0CoreStatus();
          if (signal.aborted) return;
          available = status.available;
          break;
        } catch {
          if (signal.aborted) return;
          available = false;
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
      if (available) await refreshAccounts();
      else accounts = [];
      if (!signal.aborted) {
        render();
        changed();
      }
    },
  };
}
