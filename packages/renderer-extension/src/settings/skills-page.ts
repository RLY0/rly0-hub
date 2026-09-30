import type {
  Rly0SkillBackupEntry,
  Rly0SkillEntry,
  Rly0SkillsDeactivateResult,
  Rly0SkillsImportResult,
  Rly0SkillsListResult,
  Rly0SkillsRestoreResult,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { SkillsMessages } from "./skills-messages.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererSkillsClient {
  listRly0Skills?(): Promise<Rly0SkillsListResult>;
  deactivateRly0Skill?(input: { name: string }): Promise<Rly0SkillsDeactivateResult>;
  restoreRly0Skill?(input: { backupId: string }): Promise<Rly0SkillsRestoreResult>;
  importRly0Skill?(input: { sourcePath: string; name?: string }): Promise<Rly0SkillsImportResult>;
}

type SkillsTab = "installed" | "backup";

function requireClient(getClient: () => RendererSkillsClient | null): RendererSkillsClient {
  const client = getClient();
  if (!client) throw new Error("Skills client is unavailable");
  return client;
}

/**
 * "Skills 管理" / "Skills" page. Open-source only: reads `SKILL.md` front matter and moves skill
 * directories to/from a backup folder on the host's filesystem. Deletion is always "move to
 * backup", never a permanent delete.
 */
export function createSkillsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererSkillsClient | null,
): RendererSettingsPageDefinition {
  const text: SkillsMessages = messages.skills;
  return Object.freeze({
    id: "skills",
    label: messages.pageLabels.skills,
    icon: "skills",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let result: Rly0SkillsListResult | null = null;
      let loadError: string | null = null;
      let busy = false;
      let tab: SkillsTab = "installed";
      let dialog: HTMLDialogElement | undefined;

      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = text.pageTitle;
      const description = document.createElement("p");
      description.className = "settings-rly0-mcp__description";

      const toolbar = document.createElement("div");
      toolbar.className = "settings-account-toolbar";
      const summary = document.createElement("div");
      summary.className = "settings-rly0-mcp__summary";
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = "settings-command-button settings-command-button--secondary";
      refreshButton.textContent = text.refresh;
      refreshButton.addEventListener("click", () => load());
      const importButton = document.createElement("button");
      importButton.type = "button";
      importButton.className = "settings-command-button";
      importButton.textContent = text.importAction;
      importButton.addEventListener("click", () => openImportDialog());
      toolbar.append(summary, refreshButton, importButton);

      const notice = document.createElement("p");
      notice.className = "settings-rly0-mcp__notice";
      notice.setAttribute("role", "status");

      const tabs = document.createElement("div");
      tabs.className = "settings-tabs";
      tabs.setAttribute("role", "tablist");
      const installedTab = document.createElement("button");
      installedTab.type = "button";
      installedTab.setAttribute("role", "tab");
      installedTab.textContent = text.tabInstalled;
      installedTab.addEventListener("click", () => {
        tab = "installed";
        render();
      });
      const backupTab = document.createElement("button");
      backupTab.type = "button";
      backupTab.setAttribute("role", "tab");
      backupTab.textContent = text.tabBackup;
      backupTab.addEventListener("click", () => {
        tab = "backup";
        render();
      });
      tabs.append(installedTab, backupTab);

      const list = document.createElement("div");
      list.className = "settings-rly0-mcp__list";

      context.content.append(heading, description, toolbar, notice, tabs, list);

      const renderInstalledRow = (skill: Rly0SkillEntry): HTMLElement => {
        const row = document.createElement("div");
        row.className = "settings-rly0-mcp__row";
        const identity = document.createElement("div");
        identity.className = "settings-rly0-mcp__identity";
        const name = document.createElement("strong");
        name.textContent = skill.title ?? skill.name;
        name.translate = false;
        identity.append(name);
        if (skill.title && skill.title !== skill.name) {
          const idLine = document.createElement("div");
          idLine.className = "settings-rly0-mcp__detail";
          idLine.textContent = skill.name;
          idLine.translate = false;
          identity.append(idLine);
        }
        if (skill.description) {
          const descriptionLine = document.createElement("div");
          descriptionLine.className = "settings-rly0-mcp__detail";
          descriptionLine.textContent = skill.description;
          identity.append(descriptionLine);
        }
        const actions = document.createElement("div");
        actions.className = "settings-rly0-accounts__actions";
        const deactivateButton = document.createElement("button");
        deactivateButton.type = "button";
        deactivateButton.className = "settings-account-action settings-pi-accounts__remove";
        deactivateButton.textContent = text.deactivateAction;
        deactivateButton.disabled = busy;
        deactivateButton.addEventListener("click", () => openDeactivateDialog(skill));
        actions.append(deactivateButton);
        row.append(identity, actions);
        return row;
      };

      const renderBackupRow = (entry: Rly0SkillBackupEntry): HTMLElement => {
        const row = document.createElement("div");
        row.className = "settings-rly0-mcp__row";
        const identity = document.createElement("div");
        identity.className = "settings-rly0-mcp__identity";
        const name = document.createElement("strong");
        name.textContent = entry.title ?? entry.name;
        name.translate = false;
        identity.append(name);
        const idLine = document.createElement("div");
        idLine.className = "settings-rly0-mcp__detail";
        idLine.textContent = entry.backedUpAt
          ? `${text.backedUpAt}: ${entry.backedUpAt}`
          : entry.name;
        identity.append(idLine);
        const actions = document.createElement("div");
        actions.className = "settings-rly0-accounts__actions";
        const restoreButton = document.createElement("button");
        restoreButton.type = "button";
        restoreButton.className = "settings-account-action";
        restoreButton.textContent = text.restoreAction;
        restoreButton.disabled = busy;
        restoreButton.addEventListener("click", () => openRestoreDialog(entry));
        actions.append(restoreButton);
        row.append(identity, actions);
        return row;
      };

      const render = (): void => {
        description.textContent = text.description.replace(
          "{path}",
          result?.skillsRoot ?? "skills",
        );
        importButton.disabled = busy;
        refreshButton.disabled = busy;
        installedTab.setAttribute("aria-selected", String(tab === "installed"));
        backupTab.setAttribute("aria-selected", String(tab === "backup"));
        installedTab.className = tab === "installed" ? "settings-tab is-active" : "settings-tab";
        backupTab.className = tab === "backup" ? "settings-tab is-active" : "settings-tab";
        summary.textContent = result ? `${text.installedCount}: ${result.installedCount}` : "";
        if (loadError) {
          notice.textContent = loadError;
          notice.hidden = false;
        } else if (result && !result.rootExists) {
          notice.textContent = text.rootMissing;
          notice.hidden = false;
        } else {
          notice.hidden = true;
        }
        if (!result) {
          list.replaceChildren();
          return;
        }
        if (tab === "installed") {
          if (result.installed.length === 0) {
            const empty = document.createElement("p");
            empty.className = "settings-rly0-accounts__empty";
            empty.textContent = text.emptyInstalled;
            list.replaceChildren(empty);
            return;
          }
          list.replaceChildren(...result.installed.map(renderInstalledRow));
        } else {
          if (result.backups.length === 0) {
            const empty = document.createElement("p");
            empty.className = "settings-rly0-accounts__empty";
            empty.textContent = text.emptyBackup;
            list.replaceChildren(empty);
            return;
          }
          list.replaceChildren(...result.backups.map(renderBackupRow));
        }
      };

      const load = (): void => {
        loadError = null;
        void context.runLatest(
          () =>
            requireClient(getClient).listRly0Skills?.() ?? Promise.reject(new Error("unavailable")),
          {
            success(next) {
              result = next;
              render();
            },
            failure() {
              loadError = text.loadFailed;
              render();
            },
          },
        );
      };

      const closeDialog = (): void => {
        dialog?.close();
      };

      const openDeactivateDialog = (skill: Rly0SkillEntry): void => {
        if (dialog) return;
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const title = document.createElement("h2");
        title.textContent = text.deactivateConfirmTitle;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";
        const note = document.createElement("p");
        note.textContent = text.deactivateConfirmBody.replace("{name}", skill.title ?? skill.name);
        body.append(note);
        const error = document.createElement("p");
        error.className = "settings-credential-dialog__error";
        error.setAttribute("role", "alert");
        const controls = document.createElement("div");
        controls.className = "settings-credential-dialog__actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-command-button settings-command-button--secondary";
        cancel.textContent = text.cancel;
        cancel.addEventListener("click", closeDialog);
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className =
          "settings-command-button settings-command-button--secondary settings-command-button--danger";
        confirm.textContent = text.deactivateConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            busy = true;
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              await requireClient(getClient).deactivateRly0Skill?.({ name: skill.name });
              closeDialog();
              load();
            } catch {
              error.textContent = text.deactivateFailed;
              confirm.disabled = false;
              cancel.disabled = false;
            } finally {
              busy = false;
            }
          })();
        });
        controls.append(cancel, confirm);
        modal.append(title, body, error, controls);
        modal.addEventListener("close", () => {
          modal.remove();
          dialog = undefined;
          render();
        });
        context.content.append(modal);
        modal.showModal();
      };

      const openRestoreDialog = (entry: Rly0SkillBackupEntry): void => {
        if (dialog) return;
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const title = document.createElement("h2");
        title.textContent = text.restoreConfirmTitle;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";
        const note = document.createElement("p");
        note.textContent = text.restoreConfirmBody.replace("{name}", entry.title ?? entry.name);
        body.append(note);
        const error = document.createElement("p");
        error.className = "settings-credential-dialog__error";
        error.setAttribute("role", "alert");
        const controls = document.createElement("div");
        controls.className = "settings-credential-dialog__actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-command-button settings-command-button--secondary";
        cancel.textContent = text.cancel;
        cancel.addEventListener("click", closeDialog);
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "settings-command-button";
        confirm.textContent = text.restoreConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            busy = true;
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              await requireClient(getClient).restoreRly0Skill?.({ backupId: entry.backupId });
              closeDialog();
              load();
            } catch (submitError) {
              error.textContent =
                submitError instanceof Error && submitError.message.includes("ALREADY_EXISTS")
                  ? text.alreadyExists
                  : text.restoreFailed;
              confirm.disabled = false;
              cancel.disabled = false;
            } finally {
              busy = false;
            }
          })();
        });
        controls.append(cancel, confirm);
        modal.append(title, body, error, controls);
        modal.addEventListener("close", () => {
          modal.remove();
          dialog = undefined;
          render();
        });
        context.content.append(modal);
        modal.showModal();
      };

      const openImportDialog = (): void => {
        if (dialog) return;
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const title = document.createElement("h2");
        title.textContent = text.importTitle;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";

        const pathLabel = document.createElement("label");
        pathLabel.className = "settings-credential-dialog__field";
        const pathCaption = document.createElement("span");
        pathCaption.textContent = text.importPathLabel;
        const pathInput = document.createElement("input");
        pathInput.type = "text";
        pathInput.autocomplete = "off";
        pathLabel.append(pathCaption, pathInput);

        const nameLabel = document.createElement("label");
        nameLabel.className = "settings-credential-dialog__field";
        const nameCaption = document.createElement("span");
        nameCaption.textContent = text.importNameLabel;
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.autocomplete = "off";
        nameInput.maxLength = 64;
        nameLabel.append(nameCaption, nameInput);

        body.append(pathLabel, nameLabel);

        const error = document.createElement("p");
        error.className = "settings-credential-dialog__error";
        error.setAttribute("role", "alert");
        const controls = document.createElement("div");
        controls.className = "settings-credential-dialog__actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-command-button settings-command-button--secondary";
        cancel.textContent = text.cancel;
        cancel.addEventListener("click", closeDialog);
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className = "settings-command-button";
        confirm.textContent = text.importConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            error.textContent = "";
            const sourcePath = pathInput.value.trim();
            if (!sourcePath) {
              error.textContent = text.invalidSourcePath;
              return;
            }
            const name = nameInput.value.trim();
            if (name && !/^[A-Za-z0-9._-]{1,64}$/u.test(name)) {
              error.textContent = text.invalidName;
              return;
            }
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              await requireClient(getClient).importRly0Skill?.({
                sourcePath,
                ...(name ? { name } : {}),
              });
              closeDialog();
              load();
            } catch (submitError) {
              const message = submitError instanceof Error ? submitError.message : "";
              error.textContent = message.includes("ALREADY_EXISTS")
                ? text.alreadyExists
                : message.includes("SOURCE_INVALID")
                  ? text.sourceInvalid
                  : text.importFailed;
              confirm.disabled = false;
              cancel.disabled = false;
            }
          })();
        });
        controls.append(cancel, confirm);
        modal.append(title, body, error, controls);
        modal.addEventListener("close", () => {
          modal.remove();
          dialog = undefined;
        });
        context.content.append(modal);
        modal.showModal();
        pathInput.focus();
      };

      render();
      load();
      return undefined;
    },
  });
}
