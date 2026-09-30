import type {
  Rly0MaintenanceAdviceCode,
  Rly0MaintenanceCacheInfoResult,
  Rly0MaintenanceClearCacheResult,
  Rly0MaintenanceDiagnosticsResult,
  Rly0MaintenanceExportDiagnosticsResult,
  Rly0MaintenanceProcessActionResult,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { MaintenanceMessages } from "./maintenance-messages.js";
import type { RendererSettingsMessages } from "./localization.js";
import { formatByteSize } from "./threads-page.js";
import { createPreferenceGroup, createPreferenceItem, preferenceId } from "./preference-ui.js";

export interface RendererMaintenanceClient {
  rly0MaintenanceDiagnostics?(): Promise<Rly0MaintenanceDiagnosticsResult>;
  rly0MaintenanceExportDiagnostics?(): Promise<Rly0MaintenanceExportDiagnosticsResult>;
  rly0MaintenanceCacheInfo?(): Promise<Rly0MaintenanceCacheInfoResult>;
  rly0MaintenanceClearCache?(): Promise<Rly0MaintenanceClearCacheResult>;
  rly0MaintenanceForceQuitCodex?(): Promise<Rly0MaintenanceProcessActionResult>;
  rly0MaintenanceRestartCodex?(): Promise<Rly0MaintenanceProcessActionResult>;
}

function requireClient(
  getClient: () => RendererMaintenanceClient | null,
): RendererMaintenanceClient {
  const client = getClient();
  if (!client) throw new Error("Maintenance client is unavailable");
  return client;
}

function adviceText(text: MaintenanceMessages, code: Rly0MaintenanceAdviceCode): string {
  switch (code) {
    case "CODEX_HOME_MISSING":
      return text.adviceCodexHomeMissing;
    case "AUTH_JSON_MISSING":
      return text.adviceAuthJsonMissing;
    case "CONFIG_TOML_MISSING":
      return text.adviceConfigTomlMissing;
    case "CONFIG_TOML_INVALID":
      return text.adviceConfigTomlInvalid;
    case "SESSIONS_DIR_MISSING":
      return text.adviceSessionsDirMissing;
    case "CORE_UNAVAILABLE":
      return text.adviceCoreUnavailable;
    default:
      return code;
  }
}

/**
 * "维护工具" / "Maintenance" page. Read-only diagnostics, a sanitized local-only diagnostics
 * export, cache housekeeping scoped to this program's own `~/.rly0-hub` state, best-effort Codex
 * process controls behind a second confirmation, and disabled placeholders for the two
 * closed-source content filters.
 */
export function createMaintenanceSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererMaintenanceClient | null,
): RendererSettingsPageDefinition {
  const text: MaintenanceMessages = messages.maintenance;
  return Object.freeze({
    id: "maintenance",
    label: messages.pageLabels.maintenance,
    icon: "diagnose",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let diagnostics: Rly0MaintenanceDiagnosticsResult | null = null;
      let diagnosticsError: string | null = null;
      let cache: Rly0MaintenanceCacheInfoResult | null = null;
      let exportNotice: string | null = null;
      let exportBusy = false;
      let clearBusy = false;
      let processBusy = false;
      let dialog: HTMLDialogElement | undefined;

      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = text.pageTitle;
      const description = document.createElement("p");
      description.className = "settings-rly0-mcp__description";
      description.textContent = text.description;

      // --- Diagnostics section -------------------------------------------------
      const diagnosticsSection = document.createElement("section");
      diagnosticsSection.className = "settings-rly0-dashboard__panel";
      const diagnosticsHeader = document.createElement("div");
      diagnosticsHeader.className = "settings-rly0-dashboard__panel-header";
      const diagnosticsTitle = document.createElement("h2");
      diagnosticsTitle.className = "settings-rly0-dashboard__panel-title";
      diagnosticsTitle.textContent = text.diagnosticsTitle;
      const diagnosticsRefresh = document.createElement("button");
      diagnosticsRefresh.type = "button";
      diagnosticsRefresh.className = "settings-command-button settings-command-button--secondary";
      diagnosticsRefresh.textContent = text.refresh;
      diagnosticsRefresh.addEventListener("click", () => loadDiagnostics());
      diagnosticsHeader.append(diagnosticsTitle, diagnosticsRefresh);
      const diagnosticsBody = document.createElement("div");
      const diagnosticsAdvice = document.createElement("div");

      const healthRow = (label: string, value: string, ok: boolean | null): HTMLElement => {
        const row = document.createElement("div");
        row.className = "settings-rly0-dashboard__health-row";
        const labelElement = document.createElement("span");
        labelElement.className = "settings-rly0-dashboard__health-label";
        labelElement.textContent = label;
        labelElement.translate = false;
        const valueElement = document.createElement("span");
        valueElement.className = "settings-rly0-dashboard__health-value";
        valueElement.dataset.state = ok === null ? "neutral" : ok ? "ok" : "bad";
        valueElement.textContent = value;
        row.append(labelElement, valueElement);
        return row;
      };

      const renderDiagnostics = (): void => {
        if (diagnosticsError) {
          const message = document.createElement("p");
          message.className = "settings-rly0-mcp__notice";
          message.textContent = diagnosticsError;
          diagnosticsBody.replaceChildren(message);
          diagnosticsAdvice.replaceChildren();
          return;
        }
        if (!diagnostics) {
          diagnosticsBody.replaceChildren();
          diagnosticsAdvice.replaceChildren();
          return;
        }
        const configValue = !diagnostics.configTomlExists
          ? text.missing
          : diagnostics.configTomlParses
            ? `${text.present} · ${text.parses}`
            : `${text.present} · ${text.parseFailed}`;
        const home = healthRow(text.codexHome, diagnostics.codexHome, diagnostics.codexHomeExists);
        const auth = healthRow(
          text.authJson,
          diagnostics.authJsonExists ? text.present : text.missing,
          diagnostics.authJsonExists,
        );
        const config = healthRow(
          text.configToml,
          configValue,
          diagnostics.configTomlExists ? diagnostics.configTomlParses === true : false,
        );
        const sessions = healthRow(
          text.sessionsDir,
          diagnostics.sessionsDirExists ? text.present : text.missing,
          diagnostics.sessionsDirExists,
        );
        const core = healthRow(
          text.core,
          diagnostics.core.available ? text.coreAvailable : text.coreUnavailable,
          diagnostics.core.available,
        );
        diagnosticsBody.replaceChildren(home, auth, config, sessions, core);
        if (diagnostics.advice.length === 0) {
          diagnosticsAdvice.replaceChildren();
          return;
        }
        const adviceTitle = document.createElement("div");
        adviceTitle.className = "settings-rly0-dashboard__panel-title";
        adviceTitle.textContent = text.adviceTitle;
        const list = document.createElement("ul");
        list.className = "settings-rly0-mcp__description";
        for (const code of diagnostics.advice) {
          const item = document.createElement("li");
          item.textContent = adviceText(text, code);
          list.append(item);
        }
        diagnosticsAdvice.replaceChildren(adviceTitle, list);
      };

      const loadDiagnostics = (): void => {
        diagnosticsError = null;
        void context.runLatest(
          () =>
            requireClient(getClient).rly0MaintenanceDiagnostics?.() ??
            Promise.reject(new Error("unavailable")),
          {
            success(result) {
              diagnostics = result;
              renderDiagnostics();
            },
            failure() {
              diagnosticsError = text.loadFailed;
              renderDiagnostics();
            },
          },
        );
      };

      diagnosticsSection.append(diagnosticsHeader, diagnosticsBody, diagnosticsAdvice);

      // --- Diagnostics export section ------------------------------------------
      const exportSection = document.createElement("section");
      exportSection.className = "settings-rly0-dashboard__panel";
      const exportTitle = document.createElement("h2");
      exportTitle.className = "settings-rly0-dashboard__panel-title";
      exportTitle.textContent = text.exportTitle;
      const exportDescription = document.createElement("p");
      exportDescription.className = "settings-rly0-mcp__description";
      exportDescription.textContent = text.exportDescription;
      const exportButton = document.createElement("button");
      exportButton.type = "button";
      exportButton.className = "settings-command-button";
      exportButton.textContent = text.exportAction;
      const exportNoticeElement = document.createElement("p");
      exportNoticeElement.className = "settings-rly0-mcp__notice";
      exportNoticeElement.setAttribute("role", "status");
      const renderExport = (): void => {
        exportButton.disabled = exportBusy;
        exportButton.textContent = exportBusy ? text.exportInProgress : text.exportAction;
        exportNoticeElement.textContent = exportNotice ?? "";
        exportNoticeElement.hidden = !exportNotice;
      };
      exportButton.addEventListener("click", () => {
        void (async () => {
          exportBusy = true;
          exportNotice = null;
          renderExport();
          try {
            const client = requireClient(getClient);
            if (!client.rly0MaintenanceExportDiagnostics) throw new Error("unavailable");
            const result = await client.rly0MaintenanceExportDiagnostics();
            if (context.signal.aborted) return;
            exportNotice = text.exportSucceeded
              .replace("{path}", result.filePath)
              .replace("{size}", formatByteSize(result.sizeBytes));
          } catch {
            if (context.signal.aborted) return;
            exportNotice = text.exportFailed;
          } finally {
            exportBusy = false;
            renderExport();
          }
        })();
      });
      exportSection.append(exportTitle, exportDescription, exportButton, exportNoticeElement);

      // --- Cache section ---------------------------------------------------------
      const cacheSection = document.createElement("section");
      cacheSection.className = "settings-rly0-dashboard__panel";
      const cacheHeader = document.createElement("div");
      cacheHeader.className = "settings-rly0-dashboard__panel-header";
      const cacheTitle = document.createElement("h2");
      cacheTitle.className = "settings-rly0-dashboard__panel-title";
      cacheTitle.textContent = text.cacheTitle;
      const cacheRefreshButton = document.createElement("button");
      cacheRefreshButton.type = "button";
      cacheRefreshButton.className = "settings-command-button settings-command-button--secondary";
      cacheRefreshButton.textContent = text.cacheRefresh;
      cacheRefreshButton.addEventListener("click", () => loadCache());
      cacheHeader.append(cacheTitle, cacheRefreshButton);
      const cacheDescription = document.createElement("p");
      cacheDescription.className = "settings-rly0-mcp__description";
      cacheDescription.textContent = text.cacheDescription;
      const cacheSize = document.createElement("p");
      cacheSize.className = "settings-rly0-mcp__notice";
      const clearCacheButton = document.createElement("button");
      clearCacheButton.type = "button";
      clearCacheButton.className =
        "settings-command-button settings-command-button--secondary settings-command-button--danger";
      clearCacheButton.textContent = text.clearCacheAction;
      clearCacheButton.addEventListener("click", () => openClearCacheDialog());
      const renderCache = (): void => {
        cacheSize.hidden = false;
        cacheSize.textContent = cache
          ? cache.totalBytes > 0
            ? text.cacheSize.replace("{size}", formatByteSize(cache.totalBytes))
            : text.cacheEmpty
          : "…";
        clearCacheButton.disabled = clearBusy || !cache || cache.totalBytes <= 0;
      };
      const loadCache = (): void => {
        cache = null;
        renderCache();
        void context.runLatest(
          () =>
            requireClient(getClient).rly0MaintenanceCacheInfo?.() ??
            Promise.reject(new Error("unavailable")),
          {
            success(result) {
              cache = result;
              renderCache();
            },
            failure() {
              renderCache();
            },
          },
        );
      };
      cacheSection.append(cacheHeader, cacheDescription, cacheSize, clearCacheButton);

      // --- Process control section -------------------------------------------
      const processSection = document.createElement("section");
      processSection.className = "settings-rly0-dashboard__panel";
      const processTitle = document.createElement("h2");
      processTitle.className = "settings-rly0-dashboard__panel-title";
      processTitle.textContent = text.processTitle;
      const processDescription = document.createElement("p");
      processDescription.className = "settings-rly0-mcp__description";
      processDescription.textContent = text.processDescription;
      const processNotice = document.createElement("p");
      processNotice.className = "settings-rly0-mcp__notice";
      processNotice.setAttribute("role", "status");
      const processActions = document.createElement("div");
      processActions.className = "settings-rly0-accounts__actions";
      const forceQuitButton = document.createElement("button");
      forceQuitButton.type = "button";
      forceQuitButton.className =
        "settings-command-button settings-command-button--secondary settings-command-button--danger";
      forceQuitButton.textContent = text.forceQuitAction;
      forceQuitButton.addEventListener("click", () =>
        openProcessDialog("forceQuit", text.forceQuitConfirmTitle),
      );
      const restartButton = document.createElement("button");
      restartButton.type = "button";
      restartButton.className = "settings-command-button settings-command-button--secondary";
      restartButton.textContent = text.restartAction;
      restartButton.addEventListener("click", () =>
        openProcessDialog("restart", text.restartConfirmTitle),
      );
      processActions.append(forceQuitButton, restartButton);
      const renderProcess = (): void => {
        forceQuitButton.disabled = processBusy;
        restartButton.disabled = processBusy;
        processNotice.hidden = true;
      };
      processSection.append(processTitle, processDescription, processActions, processNotice);

      // --- Closed-source filter placeholders ----------------------------------
      const filtersSection = document.createElement("section");
      filtersSection.className = "settings-rly0-dashboard__panel";
      const filtersTitle = document.createElement("h2");
      filtersTitle.className = "settings-rly0-dashboard__panel-title";
      filtersTitle.textContent = text.filtersTitle;
      const filtersDescription = document.createElement("p");
      filtersDescription.className = "settings-rly0-mcp__description";
      filtersDescription.textContent = text.filtersDescription;
      const { group: filtersGroup, card: filtersCard } = createPreferenceGroup(document, "");
      filtersGroup.querySelector(".mb-2")?.remove();
      const filterRow = (title: string): void => {
        const id = preferenceId("maintenance-filter");
        const row = createPreferenceItem(document, {
          title,
          description: text.requiresCore,
          controlId: id,
        });
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.id = id;
        toggle.setAttribute("role", "switch");
        toggle.disabled = true;
        toggle.className =
          "relative m-0 h-5 w-9 shrink-0 cursor-not-allowed appearance-none rounded-full bg-settings-surface-hover opacity-50 ring-1 ring-settings-border";
        row.item.append(toggle);
        filtersCard.append(row.item);
      };
      filterRow(text.imageFilterLabel);
      filterRow(text.webSearchFilterLabel);
      filtersSection.append(filtersTitle, filtersDescription, filtersGroup);

      context.content.append(
        heading,
        description,
        diagnosticsSection,
        exportSection,
        cacheSection,
        processSection,
        filtersSection,
      );

      // --- Dialogs -------------------------------------------------------------
      const closeDialog = (): void => {
        dialog?.close();
      };

      const openClearCacheDialog = (): void => {
        if (dialog || !cache || cache.totalBytes <= 0) return;
        const size = formatByteSize(cache.totalBytes);
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const title = document.createElement("h2");
        title.textContent = text.clearCacheConfirmTitle;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";
        const note = document.createElement("p");
        note.textContent = text.clearCacheConfirmBody.replace("{size}", size);
        body.append(note);
        const error = document.createElement("p");
        error.className = "settings-credential-dialog__error";
        error.setAttribute("role", "alert");
        const controls = document.createElement("div");
        controls.className = "settings-credential-dialog__actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-command-button settings-command-button--secondary";
        cancel.textContent = text.clearCacheCancel;
        cancel.addEventListener("click", closeDialog);
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className =
          "settings-command-button settings-command-button--secondary settings-command-button--danger";
        confirm.textContent = text.clearCacheConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            clearBusy = true;
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              const client = requireClient(getClient);
              if (!client.rly0MaintenanceClearCache) throw new Error("unavailable");
              const cleared: Rly0MaintenanceClearCacheResult =
                await client.rly0MaintenanceClearCache();
              exportNotice = null;
              closeDialog();
              loadCache();
              cacheSize.textContent = text.clearCacheSucceeded.replace(
                "{size}",
                formatByteSize(cleared.clearedBytes),
              );
            } catch {
              error.textContent = text.clearCacheFailed;
              confirm.disabled = false;
              cancel.disabled = false;
            } finally {
              clearBusy = false;
            }
          })();
        });
        controls.append(cancel, confirm);
        modal.append(title, body, error, controls);
        modal.addEventListener("close", () => {
          modal.remove();
          dialog = undefined;
          renderCache();
        });
        context.content.append(modal);
        modal.showModal();
      };

      const openProcessDialog = (action: "forceQuit" | "restart", title: string): void => {
        if (dialog) return;
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const heading2 = document.createElement("h2");
        heading2.textContent = title;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";
        const note = document.createElement("p");
        note.textContent = text.processConfirmBody;
        body.append(note);
        const error = document.createElement("p");
        error.className = "settings-credential-dialog__error";
        error.setAttribute("role", "alert");
        const controls = document.createElement("div");
        controls.className = "settings-credential-dialog__actions";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "settings-command-button settings-command-button--secondary";
        cancel.textContent = text.processCancel;
        cancel.addEventListener("click", closeDialog);
        const confirm = document.createElement("button");
        confirm.type = "button";
        confirm.className =
          "settings-command-button settings-command-button--secondary settings-command-button--danger";
        confirm.textContent = text.processConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            processBusy = true;
            confirm.disabled = true;
            cancel.disabled = true;
            renderProcess();
            try {
              const client = requireClient(getClient);
              const call =
                action === "forceQuit"
                  ? client.rly0MaintenanceForceQuitCodex
                  : client.rly0MaintenanceRestartCodex;
              if (!call) throw new Error("unavailable");
              const result = await call();
              closeDialog();
              processNotice.hidden = false;
              processNotice.textContent = !result.supported
                ? text.processUnsupported
                : result.ok
                  ? text.processSucceeded
                  : text.processFailed;
            } catch {
              error.textContent = text.processFailed;
              confirm.disabled = false;
              cancel.disabled = false;
            } finally {
              processBusy = false;
              renderProcess();
            }
          })();
        });
        controls.append(cancel, confirm);
        modal.append(heading2, body, error, controls);
        modal.addEventListener("close", () => {
          modal.remove();
          dialog = undefined;
        });
        context.content.append(modal);
        modal.showModal();
      };

      // The page has a single shared request scope, so the initial diagnostics
      // and cache fetches must run as one `runLatest` call (Promise.all) rather
      // than two separate calls -- otherwise the second call would abort the
      // first before it resolves. Subsequent manual refreshes use the
      // individual loaders above, since a user only triggers one at a time.
      diagnosticsError = null;
      cache = null;
      renderCache();
      void context.runLatest(
        async () => {
          const client = requireClient(getClient);
          const [diagnosticsSettled, cacheSettled] = await Promise.allSettled([
            client.rly0MaintenanceDiagnostics?.() ?? Promise.reject(new Error("unavailable")),
            client.rly0MaintenanceCacheInfo?.() ?? Promise.reject(new Error("unavailable")),
          ]);
          return { diagnosticsSettled, cacheSettled };
        },
        {
          success({ diagnosticsSettled, cacheSettled }) {
            if (diagnosticsSettled.status === "fulfilled") {
              diagnostics = diagnosticsSettled.value;
            } else {
              diagnosticsError = text.loadFailed;
            }
            if (cacheSettled.status === "fulfilled") {
              cache = cacheSettled.value;
            }
            renderDiagnostics();
            renderCache();
          },
          failure() {
            diagnosticsError = text.loadFailed;
            renderDiagnostics();
            renderCache();
          },
        },
      );
      renderExport();
      renderProcess();
      return undefined;
    },
  });
}
