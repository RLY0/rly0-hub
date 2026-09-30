import type {
  Rly0Account,
  Rly0AccountsImportCurrentParams,
  Rly0AccountsImportCurrentResult,
  Rly0AccountsRemoveParams,
  Rly0AccountsRemoveResult,
  Rly0AccountsRenameParams,
  Rly0AccountsRenameResult,
  Rly0AccountsSwitchParams,
  Rly0AccountsSwitchResult,
  Rly0AccountsListResult,
  Rly0CoreStatusResult,
} from "@codexhost/shared-contracts";
import type { Rly0AccountMessages } from "./rly0-account-messages.js";

export interface RendererRly0AccountClient {
  rly0CoreStatus?(): Promise<Rly0CoreStatusResult>;
  listRly0Accounts?(): Promise<Rly0AccountsListResult>;
  importCurrentRly0Account?(
    input: Rly0AccountsImportCurrentParams,
  ): Promise<Rly0AccountsImportCurrentResult>;
  switchRly0Account?(input: Rly0AccountsSwitchParams): Promise<Rly0AccountsSwitchResult>;
  renameRly0Account?(input: Rly0AccountsRenameParams): Promise<Rly0AccountsRenameResult>;
  removeRly0Account?(input: Rly0AccountsRemoveParams): Promise<Rly0AccountsRemoveResult>;
}

type DialogMode = "save" | "switch" | "rename" | "remove";

function accountDisplayName(account: Rly0Account): string {
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
  messages: Rly0AccountMessages,
  changed: () => void,
) {
  const document = root.ownerDocument;
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
  title.textContent = messages.sectionTitle;
  header.append(title);
  const saveButton = document.createElement("button");
  saveButton.type = "button";
  saveButton.className = "settings-command-button settings-command-button--secondary";
  saveButton.textContent = messages.save;
  saveButton.addEventListener("click", () => openDialog("save", null));
  header.append(saveButton);
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
  };

  const renderRow = (account: Rly0Account): HTMLElement => {
    const row = document.createElement("div");
    row.className = "settings-rly0-accounts__row";
    row.tabIndex = -1;
    row.dataset.rly0AccountId = account.id;
    const name = accountDisplayName(account);
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
    row.append(identity, actions);
    rows.set(account.id, row);
    return row;
  };

  const render = (): void => {
    saveButton.disabled = busy || !available;
    saveButton.hidden = !available;
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
    if (!available) {
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

  const openDialog = (mode: DialogMode, account: Rly0Account | null): void => {
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

    const name = account ? accountDisplayName(account) : "";

    if (mode === "save") {
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
                  : { text: messages.switchRequiresRestart.replace("{name}", name), tone: "info" };
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

  signal.addEventListener("abort", () => dialog?.remove(), { once: true });
  render();

  return {
    section: section as HTMLElement,
    refresh: async (): Promise<void> => {
      const rly0Client = getClient();
      if (!rly0Client?.rly0CoreStatus) {
        available = false;
        render();
        changed();
        return;
      }
      try {
        const status = await rly0Client.rly0CoreStatus();
        if (signal.aborted) return;
        available = status.available;
      } catch {
        if (!signal.aborted) available = false;
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
