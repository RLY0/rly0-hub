import type {
  Rly0ThreadEntry,
  Rly0ThreadsListResult,
  Rly0ThreadsListTrashResult,
  Rly0ThreadsMoveResult,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import type { ThreadsMessages } from "./threads-messages.js";

export interface RendererThreadsClient {
  listRly0Threads?(input?: { limit?: number }): Promise<Rly0ThreadsListResult>;
  listRly0ThreadsTrash?(): Promise<Rly0ThreadsListTrashResult>;
  trashRly0Threads?(input: { relPaths: string[] }): Promise<Rly0ThreadsMoveResult>;
  restoreRly0Threads?(input: { relPaths: string[] }): Promise<Rly0ThreadsMoveResult>;
}

type ThreadsTab = "sessions" | "trash";

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** Human-readable byte size (`1.5 MB`), 1024-based. */
export function formatByteSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))} ${BYTE_UNITS[unit]}`;
}

function formatThreadTime(entry: Rly0ThreadEntry, locale: string): string {
  const date = new Date(entry.mtimeMs);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Groups entries by `session_meta.cwd`, keeping the (newest-first) input order within groups. */
export function groupThreadsByProject(
  threads: readonly Rly0ThreadEntry[],
  unknownLabel: string,
): { label: string; unknown: boolean; threads: Rly0ThreadEntry[] }[] {
  const groups = new Map<string, { label: string; unknown: boolean; threads: Rly0ThreadEntry[] }>();
  for (const thread of threads) {
    const cwd = thread.cwd?.trim();
    const key = cwd ? `cwd:${cwd}` : "unknown";
    let group = groups.get(key);
    if (!group) {
      group = { label: cwd || unknownLabel, unknown: !cwd, threads: [] };
      groups.set(key, group);
    }
    group.threads.push(thread);
  }
  return [...groups.values()];
}

function requireClient(getClient: () => RendererThreadsClient | null): RendererThreadsClient {
  const client = getClient();
  if (!client) throw new Error("Threads client is unavailable");
  return client;
}

/**
 * "线程管理" / "Threads" page. Lists Codex rollout files (header-only parse on the host), and
 * moves them to/from a trash folder. Nothing is ever deleted permanently.
 */
export function createThreadsSettingsPage(
  messages: RendererSettingsMessages,
  getClient: () => RendererThreadsClient | null,
): RendererSettingsPageDefinition {
  const text: ThreadsMessages = messages.threads;
  return Object.freeze({
    id: "threads",
    label: messages.pageLabels.threads,
    icon: "threads",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      let result: Rly0ThreadsListResult | null = null;
      let trash: Rly0ThreadsListTrashResult | null = null;
      let loadError: string | null = null;
      let actionNotice: string | null = null;
      let busy = false;
      let tab: ThreadsTab = "sessions";
      const selected = new Set<string>();
      let dialog: HTMLDialogElement | undefined;

      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = text.pageTitle;
      const description = document.createElement("p");
      description.className = "settings-rly0-mcp__description";

      const stats = document.createElement("div");
      stats.className = "settings-rly0-dashboard__stats";

      const toolbar = document.createElement("div");
      toolbar.className = "settings-account-toolbar";
      const summary = document.createElement("div");
      summary.className = "settings-rly0-mcp__summary";
      const refreshButton = document.createElement("button");
      refreshButton.type = "button";
      refreshButton.className = "settings-command-button settings-command-button--secondary";
      refreshButton.textContent = text.refresh;
      refreshButton.addEventListener("click", () => load());
      const trashButton = document.createElement("button");
      trashButton.type = "button";
      trashButton.className =
        "settings-command-button settings-command-button--secondary settings-command-button--danger";
      trashButton.textContent = text.trashAction;
      trashButton.addEventListener("click", () => openTrashDialog());
      toolbar.append(summary, refreshButton, trashButton);

      const notice = document.createElement("p");
      notice.className = "settings-rly0-mcp__notice";
      notice.setAttribute("role", "status");

      const tabs = document.createElement("div");
      tabs.className = "settings-tabs";
      tabs.setAttribute("role", "tablist");
      const sessionsTab = document.createElement("button");
      sessionsTab.type = "button";
      sessionsTab.setAttribute("role", "tab");
      sessionsTab.textContent = text.tabSessions;
      sessionsTab.addEventListener("click", () => {
        tab = "sessions";
        actionNotice = null;
        render();
      });
      const trashTab = document.createElement("button");
      trashTab.type = "button";
      trashTab.setAttribute("role", "tab");
      trashTab.textContent = text.tabTrash;
      trashTab.addEventListener("click", () => {
        tab = "trash";
        actionNotice = null;
        render();
      });
      tabs.append(sessionsTab, trashTab);

      const list = document.createElement("div");
      list.className = "settings-rly0-mcp__list";

      context.content.append(heading, description, stats, toolbar, notice, tabs, list);

      const statCard = (label: string, value: string): HTMLElement => {
        const card = document.createElement("div");
        card.className = "settings-rly0-dashboard__card";
        const valueElement = document.createElement("strong");
        valueElement.className = "settings-rly0-dashboard__value";
        valueElement.textContent = value;
        const labelElement = document.createElement("span");
        labelElement.className = "settings-rly0-dashboard__label";
        labelElement.textContent = label;
        card.append(valueElement, labelElement);
        return card;
      };

      const renderThreadRow = (thread: Rly0ThreadEntry, mode: ThreadsTab): HTMLElement => {
        const row = document.createElement("div");
        row.className = "settings-rly0-mcp__row settings-rly0-threads__row";
        if (mode === "sessions") {
          const checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.className = "settings-rly0-threads__check";
          checkbox.checked = selected.has(thread.relPath);
          checkbox.disabled = busy;
          checkbox.setAttribute("aria-label", text.selectThread.replace("{title}", thread.title));
          checkbox.addEventListener("change", () => {
            if (checkbox.checked) selected.add(thread.relPath);
            else selected.delete(thread.relPath);
            renderToolbar();
          });
          row.append(checkbox);
        }
        const identity = document.createElement("div");
        identity.className = "settings-rly0-mcp__identity";
        const title = document.createElement("strong");
        title.textContent = thread.title;
        title.title = thread.relPath;
        title.translate = false;
        const detail = document.createElement("div");
        detail.className = "settings-rly0-mcp__detail";
        detail.textContent = `${formatThreadTime(thread, messages.locale)} · ${formatByteSize(thread.sizeBytes)}`;
        identity.append(title, detail);
        row.append(identity);
        if (mode === "trash") {
          const actions = document.createElement("div");
          actions.className = "settings-rly0-accounts__actions";
          const restoreButton = document.createElement("button");
          restoreButton.type = "button";
          restoreButton.className = "settings-account-action";
          restoreButton.textContent = text.restoreAction;
          restoreButton.disabled = busy;
          restoreButton.addEventListener("click", () => restore(thread));
          actions.append(restoreButton);
          row.append(actions);
        }
        return row;
      };

      const renderGroups = (threads: readonly Rly0ThreadEntry[], mode: ThreadsTab): HTMLElement[] =>
        groupThreadsByProject(threads, text.unknownProject).map((group) => {
          const section = document.createElement("section");
          section.className = "settings-rly0-threads__group";
          const label = document.createElement("div");
          label.className = "settings-rly0-threads__group-label";
          label.textContent = `${group.label} (${group.threads.length})`;
          label.translate = group.unknown;
          section.append(label, ...group.threads.map((thread) => renderThreadRow(thread, mode)));
          return section;
        });

      const renderToolbar = (): void => {
        refreshButton.disabled = busy;
        trashButton.hidden = tab !== "sessions";
        trashButton.disabled = busy || selected.size === 0;
        summary.textContent =
          tab === "sessions" && selected.size > 0
            ? text.selectedCount.replace("{count}", String(selected.size))
            : "";
      };

      const renderEmpty = (message: string): HTMLElement => {
        const empty = document.createElement("p");
        empty.className = "settings-rly0-accounts__empty";
        empty.textContent = message;
        return empty;
      };

      const render = (): void => {
        description.textContent = text.description.replace(
          "{path}",
          result?.sessionsRoot ?? "sessions",
        );
        sessionsTab.setAttribute("aria-selected", String(tab === "sessions"));
        trashTab.setAttribute("aria-selected", String(tab === "trash"));
        sessionsTab.className = tab === "sessions" ? "settings-tab is-active" : "settings-tab";
        trashTab.className = tab === "trash" ? "settings-tab is-active" : "settings-tab";
        if (result) {
          stats.replaceChildren(
            statCard(text.totalThreads, String(result.stats.totalThreads)),
            statCard(text.totalBytes, formatByteSize(result.stats.totalBytes)),
            statCard(text.activeDays, String(result.stats.activeDays)),
            statCard(text.averagePerDay, result.stats.averagePerActiveDay.toFixed(1)),
          );
        } else {
          stats.replaceChildren();
        }
        const noticeText =
          loadError ??
          actionNotice ??
          (result && !result.rootExists && tab === "sessions" ? text.rootMissing : null) ??
          (tab === "sessions" && result?.truncated
            ? text.truncated.replace("{count}", String(result.threads.length))
            : null) ??
          (tab === "trash" && trash ? text.trashLocation.replace("{path}", trash.trashRoot) : null);
        notice.textContent = noticeText ?? "";
        notice.hidden = !noticeText;
        renderToolbar();
        if (tab === "sessions") {
          if (!result) {
            list.replaceChildren();
            return;
          }
          if (result.threads.length === 0) {
            list.replaceChildren(renderEmpty(text.empty));
            return;
          }
          const selectAllLabel = document.createElement("label");
          selectAllLabel.className = "settings-rly0-threads__select-all";
          const selectAll = document.createElement("input");
          selectAll.type = "checkbox";
          selectAll.disabled = busy;
          selectAll.checked = result.threads.every((thread) => selected.has(thread.relPath));
          const threads = result.threads;
          selectAll.addEventListener("change", () => {
            for (const thread of threads) {
              if (selectAll.checked) selected.add(thread.relPath);
              else selected.delete(thread.relPath);
            }
            render();
          });
          const selectAllText = document.createElement("span");
          selectAllText.textContent = text.selectAll;
          selectAllLabel.append(selectAll, selectAllText);
          list.replaceChildren(selectAllLabel, ...renderGroups(threads, "sessions"));
          return;
        }
        if (!trash) {
          list.replaceChildren();
          return;
        }
        if (trash.threads.length === 0) {
          list.replaceChildren(renderEmpty(text.emptyTrash));
          return;
        }
        list.replaceChildren(...renderGroups(trash.threads, "trash"));
      };

      const load = (): void => {
        loadError = null;
        void context.runLatest(
          async () => {
            const client = requireClient(getClient);
            if (!client.listRly0Threads || !client.listRly0ThreadsTrash) {
              throw new Error("unavailable");
            }
            const [nextResult, nextTrash] = await Promise.all([
              client.listRly0Threads(),
              client.listRly0ThreadsTrash(),
            ]);
            return { nextResult, nextTrash };
          },
          {
            success({ nextResult, nextTrash }) {
              result = nextResult;
              trash = nextTrash;
              const present = new Set(nextResult.threads.map((thread) => thread.relPath));
              for (const relPath of [...selected])
                if (!present.has(relPath)) selected.delete(relPath);
              render();
            },
            failure() {
              loadError = text.loadFailed;
              render();
            },
          },
        );
      };

      const describeFailures = (outcome: Rly0ThreadsMoveResult): string | null => {
        if (outcome.failed.length === 0) return null;
        if (outcome.failed.every((failure) => failure.code === "THREAD_ALREADY_EXISTS")) {
          return text.alreadyExists;
        }
        return text.partialFailure.replace("{count}", String(outcome.failed.length));
      };

      const restore = (thread: Rly0ThreadEntry): void => {
        void (async () => {
          busy = true;
          actionNotice = null;
          render();
          try {
            const client = requireClient(getClient);
            if (!client.restoreRly0Threads) throw new Error("unavailable");
            const outcome = await client.restoreRly0Threads({ relPaths: [thread.relPath] });
            if (context.signal.aborted) return;
            actionNotice = describeFailures(outcome);
          } catch {
            if (context.signal.aborted) return;
            actionNotice = text.restoreFailed;
          } finally {
            busy = false;
          }
          load();
        })();
      };

      const closeDialog = (): void => {
        dialog?.close();
      };

      const openTrashDialog = (): void => {
        if (dialog || selected.size === 0) return;
        const relPaths = [...selected];
        const modal = document.createElement("dialog");
        dialog = modal;
        modal.className = "settings-account-dialog settings-credential-dialog";
        const title = document.createElement("h2");
        title.textContent = text.trashConfirmTitle;
        const body = document.createElement("div");
        body.className = "settings-credential-dialog__body";
        const note = document.createElement("p");
        note.textContent = text.trashConfirmBody
          .replace("{count}", String(relPaths.length))
          .replace("{path}", trash?.trashRoot ?? "threads-trash");
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
        confirm.textContent = text.trashConfirm;
        confirm.addEventListener("click", () => {
          void (async () => {
            busy = true;
            confirm.disabled = true;
            cancel.disabled = true;
            try {
              const client = requireClient(getClient);
              if (!client.trashRly0Threads) throw new Error("unavailable");
              const outcome = await client.trashRly0Threads({ relPaths });
              for (const relPath of relPaths) selected.delete(relPath);
              actionNotice = describeFailures(outcome);
              closeDialog();
              load();
            } catch {
              error.textContent = text.trashFailed;
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

      render();
      load();
      return undefined;
    },
  });
}
