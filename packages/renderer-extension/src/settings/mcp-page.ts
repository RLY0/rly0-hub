import type {
  Rly0McpAddParams,
  Rly0McpListResult,
  Rly0McpMutationResult,
  Rly0McpServer,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { McpMessages } from "./mcp-messages.js";
import type { RendererSettingsMessages } from "./localization.js";

export interface RendererMcpClient {
  listRly0Mcp?(): Promise<Rly0McpListResult>;
  setRly0McpEnabled?(input: { name: string; enabled: boolean }): Promise<Rly0McpMutationResult>;
  removeRly0Mcp?(input: { name: string }): Promise<Rly0McpMutationResult>;
  addRly0Mcp?(input: Rly0McpAddParams): Promise<Rly0McpMutationResult>;
}

function requireClient(getClient: () => RendererMcpClient | null): RendererMcpClient {
  const client = getClient();
  if (!client) throw new Error("MCP client is unavailable");
  return client;
}

/**
 * "MCP 管理" / "MCP servers" page. Fully open-source: it talks only to the host's filesystem-backed
 * `Rly0McpManager` (no dependency on the closed-source rly0-core bridge). Secret-shaped values
 * (env var values, header/token values) are never rendered — only their key names, as enforced by
 * the shared-contracts schema on the host side.
 */
export function createMcpSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererMcpClient | null,
): RendererSettingsPageDefinition {
  const text: McpMessages = messages.mcp;
  return Object.freeze({
    id: "mcp",
    label: messages.pageLabels.mcp,
    icon: "mcp",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let result: Rly0McpListResult | null = null;
      let loadError: string | null = null;
      let busyName: string | null = null;
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
      const addButton = document.createElement("button");
      addButton.type = "button";
      addButton.className = "settings-command-button";
      addButton.textContent = text.add;
      addButton.addEventListener("click", () => openAddDialog());
      toolbar.append(summary, refreshButton, addButton);

      const notice = document.createElement("p");
      notice.className = "settings-rly0-mcp__notice";
      notice.setAttribute("role", "status");

      const list = document.createElement("div");
      list.className = "settings-rly0-mcp__list";

      context.content.append(heading, description, toolbar, notice, list);

      const renderRow = (server: Rly0McpServer): HTMLElement => {
        const row = document.createElement("div");
        row.className = "settings-rly0-mcp__row";
        row.dataset.mcpName = server.name;

        const identity = document.createElement("div");
        identity.className = "settings-rly0-mcp__identity";
        const name = document.createElement("strong");
        name.textContent = server.name;
        name.translate = false;
        const meta = document.createElement("div");
        meta.className = "settings-account-metadata";
        const typeSpan = document.createElement("span");
        typeSpan.textContent = server.type === "stdio" ? text.typeStdio : text.typeHttp;
        const stateSpan = document.createElement("span");
        stateSpan.className = server.enabled
          ? "settings-account-active"
          : "settings-rly0-mcp__disabled-badge";
        stateSpan.textContent = server.enabled ? text.enabledBadge : text.disabledBadge;
        meta.append(typeSpan, stateSpan);
        const detail = document.createElement("div");
        detail.className = "settings-rly0-mcp__detail";
        detail.textContent = server.type === "stdio" ? (server.command ?? "") : (server.url ?? "");
        detail.translate = false;
        identity.append(name, meta, detail);

        const keys: string[] = [];
        if (server.envKeys?.length) keys.push(`${text.envKeysLabel}: ${server.envKeys.join(", ")}`);
        if (server.headerKeys?.length) {
          keys.push(`${text.headerKeysLabel}: ${server.headerKeys.join(", ")}`);
        }
        if (keys.length > 0) {
          const keysLine = document.createElement("div");
          keysLine.className = "settings-rly0-mcp__keys";
          keysLine.textContent = keys.join(" · ");
          identity.append(keysLine);
        }

        const actions = document.createElement("div");
        actions.className = "settings-rly0-accounts__actions";
        const toggleButton = document.createElement("button");
        toggleButton.type = "button";
        toggleButton.className = "settings-account-action";
        toggleButton.textContent = server.enabled ? text.disableAction : text.enableAction;
        toggleButton.disabled = busyName !== null;
        toggleButton.addEventListener("click", () => void toggle(server));
        const removeButton = document.createElement("button");
        removeButton.type = "button";
        removeButton.className = "settings-account-action settings-pi-accounts__remove";
        removeButton.textContent = text.removeAction;
        removeButton.disabled = busyName !== null;
        removeButton.addEventListener("click", () => openRemoveDialog(server));
        actions.append(toggleButton, removeButton);

        row.append(identity, actions);
        return row;
      };

      const render = (): void => {
        description.textContent = text.description.replace(
          "{path}",
          result?.configPath ?? "config.toml",
        );
        addButton.disabled = busyName !== null;
        refreshButton.disabled = busyName !== null;
        if (result) {
          summary.textContent = `${text.totalCount}: ${result.totalCount} · ${text.enabledCount}: ${result.enabledCount}`;
        } else {
          summary.textContent = "";
        }
        if (loadError) {
          notice.textContent = loadError;
          notice.hidden = false;
        } else if (result?.parseError) {
          notice.textContent = text.parseError;
          notice.hidden = false;
        } else if (result && !result.configExists) {
          notice.textContent = text.configMissing;
          notice.hidden = false;
        } else {
          notice.hidden = true;
        }
        if (!result || result.servers.length === 0) {
          const empty = document.createElement("p");
          empty.className = "settings-rly0-accounts__empty";
          empty.textContent = text.empty;
          list.replaceChildren(empty);
          return;
        }
        list.replaceChildren(...result.servers.map(renderRow));
      };

      const load = (): void => {
        loadError = null;
        void context.runLatest(
          () =>
            requireClient(getClient).listRly0Mcp?.() ?? Promise.reject(new Error("unavailable")),
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

      const toggle = async (server: Rly0McpServer): Promise<void> => {
        if (busyName) return;
        busyName = server.name;
        render();
        try {
          await requireClient(getClient).setRly0McpEnabled?.({
            name: server.name,
            enabled: !server.enabled,
          });
          load();
        } catch {
          loadError = text.toggleFailed;
        } finally {
          busyName = null;
          render();
        }
      };

      const closeDialog = (): void => {
        dialog?.close();
      };

      const openRemoveDialog = (server: Rly0McpServer): void => {
        if (dialog) return;
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const title = document.createElement("h2");
        title.textContent = text.removeConfirmTitle;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";
        const note = document.createElement("p");
        note.textContent = text.removeConfirmBody.replace("{name}", server.name);
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
        confirm.textContent = text.removeConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              await requireClient(getClient).removeRly0Mcp?.({ name: server.name });
              closeDialog();
              load();
            } catch {
              error.textContent = text.removeFailed;
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
      };

      const openAddDialog = (): void => {
        if (dialog) return;
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const title = document.createElement("h2");
        title.textContent = text.addTitle;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";

        const nameLabel = document.createElement("label");
        nameLabel.className = "settings-credential-dialog__field";
        const nameCaption = document.createElement("span");
        nameCaption.textContent = text.addNameLabel;
        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.autocomplete = "off";
        nameInput.maxLength = 64;
        const nameHint = document.createElement("small");
        nameHint.textContent = text.addNameHint;
        nameLabel.append(nameCaption, nameInput, nameHint);

        const typeLabel = document.createElement("label");
        typeLabel.className = "settings-credential-dialog__field";
        const typeCaption = document.createElement("span");
        typeCaption.textContent = text.addTypeLabel;
        const typeSelect = document.createElement("select");
        const stdioOption = document.createElement("option");
        stdioOption.value = "stdio";
        stdioOption.textContent = text.typeStdio;
        const httpOption = document.createElement("option");
        httpOption.value = "http";
        httpOption.textContent = text.typeHttp;
        typeSelect.append(stdioOption, httpOption);
        typeLabel.append(typeCaption, typeSelect);

        const commandLabel = document.createElement("label");
        commandLabel.className = "settings-credential-dialog__field";
        const commandCaption = document.createElement("span");
        commandCaption.textContent = text.addCommandLabel;
        const commandInput = document.createElement("input");
        commandInput.type = "text";
        commandInput.autocomplete = "off";
        commandLabel.append(commandCaption, commandInput);

        const argsLabel = document.createElement("label");
        argsLabel.className = "settings-credential-dialog__field";
        const argsCaption = document.createElement("span");
        argsCaption.textContent = text.addArgsLabel;
        const argsInput = document.createElement("textarea");
        argsInput.rows = 3;
        argsLabel.append(argsCaption, argsInput);

        const urlLabel = document.createElement("label");
        urlLabel.className = "settings-credential-dialog__field";
        const urlCaption = document.createElement("span");
        urlCaption.textContent = text.addUrlLabel;
        const urlInput = document.createElement("input");
        urlInput.type = "text";
        urlInput.autocomplete = "off";
        urlLabel.append(urlCaption, urlInput);

        const updateTypeVisibility = (): void => {
          const stdio = typeSelect.value === "stdio";
          commandLabel.hidden = !stdio;
          argsLabel.hidden = !stdio;
          urlLabel.hidden = stdio;
        };
        typeSelect.addEventListener("change", updateTypeVisibility);
        updateTypeVisibility();

        body.append(nameLabel, typeLabel, commandLabel, argsLabel, urlLabel);

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
        confirm.textContent = text.addConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            error.textContent = "";
            const name = nameInput.value.trim();
            if (!/^[A-Za-z0-9._-]{1,64}$/u.test(name)) {
              error.textContent = text.invalidName;
              return;
            }
            let params: Rly0McpAddParams;
            if (typeSelect.value === "stdio") {
              const command = commandInput.value.trim();
              if (!command) {
                error.textContent = text.invalidCommand;
                return;
              }
              const args = argsInput.value
                .split("\n")
                .map((line) => line.trim())
                .filter((line) => line.length > 0);
              params = { type: "stdio", name, command, ...(args.length ? { args } : {}) };
            } else {
              const url = urlInput.value.trim();
              if (!url) {
                error.textContent = text.invalidUrl;
                return;
              }
              params = { type: "http", name, url };
            }
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              await requireClient(getClient).addRly0Mcp?.(params);
              closeDialog();
              load();
            } catch (submitError) {
              error.textContent =
                submitError instanceof Error && submitError.message.includes("ALREADY_EXISTS")
                  ? text.alreadyExists
                  : text.addFailed;
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
        nameInput.focus();
      };

      render();
      load();
      return undefined;
    },
  });
}
