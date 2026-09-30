import {
  rly0RelayBaseUrlSchema,
  rly0RelayModelSchema,
  rly0RelayNameSchema,
  type Rly0ProxyStatusResult,
  type Rly0ProxyStopResult,
  type Rly0Relay,
  type Rly0RelayAddParams,
  type Rly0RelayAddResult,
  type Rly0RelayCodexConfigApplyParams,
  type Rly0RelayCodexConfigMutationResult,
  type Rly0RelayCodexConfigStatusResult,
  type Rly0RelayListResult,
  type Rly0RelayMutationResult,
  type Rly0RelayRemoveParams,
  type Rly0RelayRemoveResult,
  type Rly0RelaySetEnabledParams,
  type Rly0RelayTestParams,
  type Rly0RelayTestResult,
  type Rly0RelayUpdateParams,
} from "@codexhost/shared-contracts";

import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { formatRly0RelativeTime, rly0ErrorCode } from "./rly0-usage.js";
import { createRly0Showcase } from "./rly0-showcase.js";

export interface RendererRelayClient {
  listRly0Relays?(): Promise<Rly0RelayListResult>;
  addRly0Relay?(input: Rly0RelayAddParams): Promise<Rly0RelayAddResult>;
  updateRly0Relay?(input: Rly0RelayUpdateParams): Promise<Rly0RelayMutationResult>;
  removeRly0Relay?(input: Rly0RelayRemoveParams): Promise<Rly0RelayRemoveResult>;
  setRly0RelayEnabled?(input: Rly0RelaySetEnabledParams): Promise<Rly0RelayMutationResult>;
  testRly0Relay?(input: Rly0RelayTestParams): Promise<Rly0RelayTestResult>;
  rly0ProxyStart?(input?: { port?: number }): Promise<Rly0ProxyStatusResult>;
  rly0ProxyStop?(): Promise<Rly0ProxyStopResult>;
  rly0ProxyStatus?(): Promise<Rly0ProxyStatusResult>;
  rly0RelayCodexConfigStatus?(): Promise<Rly0RelayCodexConfigStatusResult>;
  rly0RelayCodexConfigApply?(
    input: Rly0RelayCodexConfigApplyParams,
  ): Promise<Rly0RelayCodexConfigMutationResult>;
  rly0RelayCodexConfigRestore?(): Promise<Rly0RelayCodexConfigMutationResult>;
}

export { RLY0_RELAY_PROMO_URL } from "./rly0-showcase.js";

/** Splits the model textarea into names; `null` when any entry is not a valid model name. */
export function parseRelayModels(text: string): string[] | null {
  const models: string[] = [];
  for (const raw of text.split(/[\n,]/u)) {
    const model = raw.trim();
    if (!model) continue;
    if (!rly0RelayModelSchema.safeParse(model).success) return null;
    if (!models.includes(model)) models.push(model);
  }
  return models.length > 256 ? null : models;
}

/** Models offered for `model = ...` when writing the Codex config: enabled relays, no patterns. */
export function relayCodexModelOptions(relays: readonly Rly0Relay[]): string[] {
  const models: string[] = [];
  for (const relay of relays) {
    if (!relay.enabled) continue;
    for (const model of relay.models) {
      if (model.includes("*") || models.includes(model)) continue;
      models.push(model);
    }
  }
  return models;
}

type ProxyState = Extract<Rly0ProxyStatusResult, { available: true }>;
type RunningProxy = Extract<ProxyState, { running: true }>;

interface TestState {
  readonly loading: boolean;
  readonly result?: Extract<Rly0RelayTestResult, { available: true }>;
  readonly error?: string;
}

export function createRelaySettingsPage(
  settingsMessages: RendererSettingsMessages,
  getClient: () => RendererRelayClient | null,
): RendererSettingsPageDefinition {
  const messages = settingsMessages.relay;
  return Object.freeze({
    id: "relay",
    label: settingsMessages.pageLabels.relay,
    icon: "relay",
    mount(context: RendererSettingsPageMountContext) {
      const { signal } = context;
      const document = context.content.ownerDocument;
      const el = <K extends keyof HTMLElementTagNameMap>(
        tag: K,
        className?: string,
        text?: string,
      ): HTMLElementTagNameMap[K] => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      };
      const button = (
        text: string,
        variant: "" | "secondary" | "danger",
        onClick: () => void,
      ): HTMLButtonElement => {
        const node = el(
          "button",
          variant
            ? `settings-command-button settings-command-button--${variant}`
            : "settings-command-button",
          text,
        );
        node.type = "button";
        node.addEventListener("click", onClick);
        return node;
      };

      let relays: readonly Rly0Relay[] = [];
      let unavailable = false;
      let loadError: string | null = null;
      let proxy: ProxyState | null = null;
      let codex: Rly0RelayCodexConfigStatusResult | null = null;
      let notice: { text: string; error: boolean } | null = null;
      let busy = false;
      const tests = new Map<string, TestState>();
      let dialog: HTMLDialogElement | undefined;

      // ---- Static layout ----
      const header = el("div", "settings-account-header");
      const copy = el("div");
      copy.append(
        el("h1", "settings-section-label", messages.pageTitle),
        el("p", "settings-rly0-mcp__description", messages.description),
      );
      header.append(copy);
      const promo = el("div", "settings-rly0-relay__promo-slot");
      const status = el("p", "settings-rly0-mcp__notice");
      status.setAttribute("aria-live", "polite");
      const proxyCard = el("section", "settings-rly0-relay__card settings-rly0-relay__proxy");
      const codexCard = el("section", "settings-rly0-relay__card settings-rly0-relay__codex");
      const relaysSection = el("section", "settings-rly0-relay__relays");
      context.content.append(header, promo, status, proxyCard, codexCard, relaysSection);

      const setNotice = (text: string | null, error = false): void => {
        notice = text ? { text, error } : null;
        renderStatus();
      };
      const failureText = (error: unknown, fallback: string): string => {
        const code = rly0ErrorCode(error);
        if (code === "RLY0_CORE_UNAVAILABLE") return messages.unavailable;
        if (code === "PROXY_PORT_IN_USE" || code === "EADDRINUSE") return messages.proxyPortInUse;
        return fallback;
      };

      // ---- Promo ----
      const renderPromo = (): void => {
        promo.replaceChildren(createRly0Showcase(document, messages));
        promo.hidden = false;
      };

      const renderStatus = (): void => {
        status.replaceChildren();
        const text = unavailable ? messages.unavailable : (loadError ?? notice?.text ?? "");
        status.textContent = text;
        status.hidden = !text;
        if (loadError || notice?.error) status.setAttribute("role", "alert");
        else status.removeAttribute("role");
      };

      // ---- Proxy card ----
      const renderProxy = (): void => {
        proxyCard.replaceChildren();
        const top = el("div", "settings-rly0-relay__card-head");
        top.append(el("h2", "settings-rly0-relay__title", messages.proxyTitle));
        const client = getClient();
        if (unavailable || !proxy) {
          top.append(el("span", "settings-rly0-relay__state", messages.proxyStopped));
          proxyCard.append(top);
          if (unavailable)
            proxyCard.append(el("p", "settings-rly0-mcp__detail", messages.unavailable));
          return;
        }
        const running = proxy.running ? proxy : null;
        const state = el(
          "span",
          `settings-rly0-relay__state${running ? " settings-rly0-relay__state--on" : ""}`,
          running ? messages.proxyRunning : messages.proxyStopped,
        );
        top.append(state);
        const actions = el("div", "settings-rly0-relay__actions");
        if (running && client?.rly0ProxyStop) {
          const stop = button(messages.proxyStop, "secondary", () => void stopProxy());
          stop.disabled = busy;
          actions.append(stop);
        } else if (!running && client?.rly0ProxyStart) {
          const start = button(messages.proxyStart, "", () => void startProxy());
          start.disabled = busy;
          actions.append(start);
        }
        actions.append(button(messages.refresh, "secondary", () => void load()));
        top.append(actions);
        proxyCard.append(top, el("p", "settings-rly0-mcp__detail", messages.proxyDescription));
        if (!running) return;
        const stats = el("dl", "settings-rly0-relay__stats");
        const stat = (label: string, value: string): void => {
          const wrap = el("div");
          wrap.append(el("dt", undefined, label), el("dd", undefined, value));
          stats.append(wrap);
        };
        stat(messages.proxyAddress, running.baseUrl);
        stat(messages.proxyRequests, String(running.requests));
        stat(messages.proxyRouted, String(running.routed));
        if (running.official !== undefined) stat(messages.proxyOfficial, String(running.official));
        stat(messages.proxyUnrouted, String(running.unrouted));
        stat(messages.proxyFailed, String(running.failed));
        proxyCard.append(stats);
        proxyCard.append(el("h3", "settings-rly0-relay__subtitle", messages.proxyRecent));
        if (running.recent.length === 0) {
          proxyCard.append(el("p", "settings-rly0-mcp__detail", messages.proxyRecentEmpty));
          return;
        }
        const list = el("ul", "settings-rly0-relay__recent");
        for (const request of [...running.recent].reverse().slice(0, 20)) {
          const item = el("li");
          const failed = request.status >= 400 || request.status === 0;
          item.append(
            el(
              "span",
              `settings-rly0-relay__code${failed ? " settings-rly0-relay__code--error" : ""}`,
              String(request.status),
            ),
            el("span", undefined, `${request.method} ${request.path}`),
            el(
              "span",
              "settings-rly0-mcp__detail",
              [
                request.model,
                request.route === "official" ? messages.routeOfficial : request.relay,
                `${Math.round(request.ms)} ms`,
                formatRly0RelativeTime(request.at, settingsMessages.rly0Accounts),
              ]
                .filter(Boolean)
                .join(" · "),
            ),
          );
          list.append(item);
        }
        proxyCard.append(list);
      };

      // ---- Codex config card ----
      const runningProxy = (): RunningProxy | null => (proxy?.running ? proxy : null);
      const renderCodex = (): void => {
        codexCard.replaceChildren();
        const client = getClient();
        const top = el("div", "settings-rly0-relay__card-head");
        top.append(el("h2", "settings-rly0-relay__title", messages.codexTitle));
        if (!codex) {
          codexCard.hidden = !client?.rly0RelayCodexConfigStatus;
          codexCard.append(top);
          return;
        }
        codexCard.hidden = false;
        top.append(
          el(
            "span",
            `settings-rly0-relay__state${codex.applied || codex.providerPresent ? " settings-rly0-relay__state--on" : ""}`,
            codex.applied || codex.providerPresent
              ? messages.codexApplied
              : messages.codexNotApplied,
          ),
        );
        codexCard.append(top);
        codexCard.append(
          el(
            "p",
            "settings-rly0-mcp__description",
            messages.codexDescription.replace("{path}", codex.configPath),
          ),
          el(
            "p",
            "settings-rly0-mcp__detail",
            messages.codexCurrent
              .replace("{provider}", codex.modelProvider ?? messages.codexNone)
              .replace("{model}", codex.model ?? messages.codexNone),
          ),
        );
        if (codex.parseError) {
          const parse = el("p", "settings-credential-dialog__error", messages.codexParseError);
          parse.setAttribute("role", "alert");
          codexCard.append(parse);
        }
        const actions = el("div", "settings-rly0-relay__actions");
        if (client?.rly0RelayCodexConfigApply) {
          const apply = button(messages.codexApply, "", () => openApplyDialog());
          apply.disabled = busy || !runningProxy() || Boolean(codex.parseError);
          if (!runningProxy()) apply.title = messages.proxyStopped;
          actions.append(apply);
        }
        if (client?.rly0RelayCodexConfigRestore) {
          const restore = button(messages.codexRestore, "secondary", () => openRestoreDialog());
          restore.disabled =
            busy || (!codex.applied && !codex.providerPresent) || Boolean(codex.parseError);
          actions.append(restore);
        }
        codexCard.append(actions);
      };

      // ---- Relay list ----
      const renderRelays = (): void => {
        relaysSection.replaceChildren();
        const client = getClient();
        const top = el("div", "settings-rly0-relay__card-head");
        top.append(el("h2", "settings-rly0-relay__title", messages.relaysTitle));
        if (!unavailable && client?.addRly0Relay) {
          const add = button(messages.add, "", () => openRelayDialog(null));
          add.disabled = busy;
          top.append(add);
        }
        relaysSection.append(top);
        if (unavailable) return;
        if (relays.length === 0) {
          relaysSection.append(el("p", "settings-rly0-accounts__empty", messages.relaysEmpty));
          return;
        }
        const list = el("ul", "settings-rly0-relay__list");
        for (const relay of relays) list.append(renderRelay(relay));
        relaysSection.append(list);
      };

      const renderRelay = (relay: Rly0Relay): HTMLLIElement => {
        const client = getClient();
        const item = el("li", "settings-rly0-relay__card settings-rly0-relay__item");
        item.dataset.relayId = relay.id;
        const top = el("div", "settings-rly0-relay__card-head");
        const identity = el("div", "settings-rly0-mcp__identity");
        identity.append(
          el("strong", undefined, relay.name),
          el(
            "span",
            "settings-rly0-mcp__detail",
            [
              messages.protocolResponses,
              messages.modelCount.replace("{n}", String(relay.models.length)),
              relay.hasKey ? `${messages.keyLabel} ${relay.keyMask ?? "••••"}` : messages.noKey,
              ...(relay.routeLocked === true ? [messages.routeLocked] : []),
            ].join(" · "),
          ),
          el("span", "settings-rly0-relay__url", relay.baseUrl),
        );
        const toggleLabel = el("label", "settings-rly0-relay__toggle");
        const toggle = el("input");
        toggle.type = "checkbox";
        toggle.checked = relay.enabled;
        toggle.disabled = busy || !client?.setRly0RelayEnabled;
        toggle.setAttribute("aria-label", `${relay.name} ${messages.enabled}`);
        toggle.addEventListener("change", () => void setEnabled(relay, toggle.checked));
        toggleLabel.append(
          toggle,
          el("span", undefined, relay.enabled ? messages.enabled : messages.disabled),
        );
        top.append(identity, toggleLabel);
        item.append(top);

        if (relay.models.length > 0) {
          const tags = el("div", "settings-rly0-relay__tags");
          for (const model of relay.models.slice(0, 24))
            tags.append(el("span", "settings-rly0-relay__tag", model));
          if (relay.models.length > 24)
            tags.append(el("span", "settings-rly0-relay__tag", `+${relay.models.length - 24}`));
          item.append(tags);
        }

        const test = tests.get(relay.id);
        const testLine = el("p", "settings-rly0-mcp__detail");
        if (test?.loading) testLine.textContent = messages.testing;
        else if (test?.result?.ok)
          testLine.textContent = messages.testOk
            .replace("{ms}", String(Math.round(test.result.latencyMs)))
            .replace("{count}", String(test.result.modelCount ?? test.result.models?.length ?? 0));
        else if (test?.result || test?.error) {
          testLine.className = "settings-credential-dialog__error";
          testLine.textContent = [
            messages.testFailed,
            test.result?.error ?? test.error,
            test.result?.status,
          ]
            .filter((part) => part !== undefined && part !== "")
            .join(" · ");
        } else testLine.textContent = messages.notTested;
        item.append(testLine);

        const actions = el("div", "settings-rly0-relay__actions");
        if (client?.testRly0Relay) {
          const testButton = button(messages.test, "secondary", () => void testRelay(relay));
          testButton.disabled = busy || test?.loading === true;
          actions.append(testButton);
        }
        const found = test?.result?.ok ? (test.result.models ?? []) : [];
        const updateRelay = client?.updateRly0Relay;
        if (found.length > 0 && updateRelay) {
          const fill = button(
            messages.fillModels.replace("{n}", String(found.length)),
            "secondary",
            () => void mutate(() => updateRelay({ id: relay.id, models: found })),
          );
          fill.disabled = busy;
          actions.append(fill);
        }
        if (client?.updateRly0Relay) {
          const edit = button(messages.edit, "secondary", () => openRelayDialog(relay));
          edit.disabled = busy;
          actions.append(edit);
        }
        if (client?.removeRly0Relay) {
          const remove = button(messages.remove, "danger", () => openRemoveDialog(relay));
          remove.disabled = busy;
          actions.append(remove);
        }
        item.append(actions);
        return item;
      };

      const render = (): void => {
        if (signal.aborted) return;
        renderPromo();
        renderStatus();
        renderProxy();
        renderCodex();
        renderRelays();
      };

      // ---- Data ----
      const load = async (): Promise<void> => {
        const client = getClient();
        loadError = null;
        if (!client?.listRly0Relays) {
          unavailable = true;
        } else {
          try {
            const [listed, proxyStatus] = await Promise.all([
              client.listRly0Relays(),
              client.rly0ProxyStatus?.() ??
                Promise.resolve<Rly0ProxyStatusResult>({ available: false }),
            ]);
            if (signal.aborted) return;
            unavailable = !listed.available;
            relays = listed.available ? listed.relays : [];
            proxy = proxyStatus.available ? proxyStatus : null;
            for (const id of [...tests.keys()])
              if (!relays.some((relay) => relay.id === id)) tests.delete(id);
          } catch (error) {
            if (signal.aborted) return;
            if (rly0ErrorCode(error) === "RLY0_CORE_UNAVAILABLE") unavailable = true;
            else loadError = messages.loadFailed;
          }
        }
        await loadCodex();
        render();
      };
      const loadCodex = async (): Promise<void> => {
        const statusGetter = getClient()?.rly0RelayCodexConfigStatus;
        if (!statusGetter) return;
        try {
          const result = await statusGetter();
          if (!signal.aborted) codex = result;
        } catch {
          // Leave the previous config status; the card stays usable after the next refresh.
        }
      };

      const withBusy = async (operation: () => Promise<void>): Promise<void> => {
        if (busy || signal.aborted) return;
        busy = true;
        render();
        try {
          await operation();
        } finally {
          busy = false;
          render();
        }
      };

      const mutate = (
        operation: () => Promise<{ available: boolean }>,
        failure = messages.actionFailed,
      ): Promise<void> =>
        withBusy(async () => {
          try {
            const result = await operation();
            if (signal.aborted) return;
            if (!result.available) {
              unavailable = true;
              return;
            }
            setNotice(null);
            await load();
          } catch (error) {
            if (!signal.aborted) setNotice(failureText(error, failure), true);
          }
        });

      const setEnabled = (relay: Rly0Relay, enabled: boolean): Promise<void> => {
        const setter = getClient()?.setRly0RelayEnabled;
        if (!setter) return Promise.resolve();
        return mutate(() => setter({ id: relay.id, enabled }));
      };

      const testRelay = async (relay: Rly0Relay): Promise<void> => {
        const tester = getClient()?.testRly0Relay;
        if (!tester || tests.get(relay.id)?.loading) return;
        tests.set(relay.id, { loading: true });
        render();
        try {
          const result = await tester({ id: relay.id });
          if (signal.aborted) return;
          if (!result.available) {
            unavailable = true;
            tests.delete(relay.id);
          } else tests.set(relay.id, { loading: false, result });
        } catch (error) {
          if (signal.aborted) return;
          tests.set(relay.id, { loading: false, error: failureText(error, "") });
        }
        render();
      };

      const startProxy = (): Promise<void> =>
        withBusy(async () => {
          const start = getClient()?.rly0ProxyStart;
          if (!start) return;
          try {
            const result = await start({});
            if (signal.aborted) return;
            if (!result.available) unavailable = true;
            else proxy = result;
            setNotice(null);
            await loadCodex();
          } catch (error) {
            if (!signal.aborted) setNotice(failureText(error, messages.proxyStartFailed), true);
          }
        });

      const stopProxy = (): Promise<void> =>
        withBusy(async () => {
          const stop = getClient()?.rly0ProxyStop;
          if (!stop) return;
          try {
            const result = await stop();
            if (signal.aborted) return;
            if (!result.available) unavailable = true;
            setNotice(null);
          } catch (error) {
            if (!signal.aborted) setNotice(failureText(error, messages.proxyStopFailed), true);
          }
          await load();
        });

      // ---- Dialogs ----
      const openDialog = (
        title: string,
        build: (body: HTMLElement) => void,
        confirmText: string,
        onConfirm: (error: HTMLElement) => Promise<boolean>,
        danger = false,
      ): HTMLDialogElement | undefined => {
        if (dialog || signal.aborted) return undefined;
        const modal = el("dialog", "settings-account-dialog settings-credential-dialog");
        dialog = modal;
        const body = el("div", "settings-credential-dialog__body");
        build(body);
        const error = el("p", "settings-credential-dialog__error");
        error.setAttribute("role", "alert");
        const controls = el("div", "settings-credential-dialog__actions");
        let pending = false;
        const cancel = button(messages.cancel, "secondary", () => modal.close());
        const confirm = button(confirmText, danger ? "danger" : "", () => {
          if (pending) return;
          pending = true;
          cancel.disabled = true;
          confirm.disabled = true;
          error.textContent = "";
          void onConfirm(error)
            .then((done) => {
              if (done && !signal.aborted) modal.close();
            })
            .finally(() => {
              pending = false;
              cancel.disabled = false;
              confirm.disabled = false;
            });
        });
        controls.append(cancel, confirm);
        modal.append(el("h2", undefined, title), body, error, controls);
        modal.addEventListener("cancel", (event) => {
          if (pending) event.preventDefault();
        });
        modal.addEventListener("close", () => {
          modal.remove();
          dialog = undefined;
        });
        context.content.append(modal);
        modal.showModal();
        return modal;
      };

      const field = (label: string, control: HTMLElement, hint?: string): HTMLLabelElement => {
        const wrap = el("label", "settings-credential-dialog__field");
        wrap.append(el("span", undefined, label), control);
        if (hint) wrap.append(el("small", "settings-rly0-mcp__detail", hint));
        return wrap;
      };
      const inputClass =
        "h-8 w-full rounded-md border border-settings-border bg-settings-surface px-2 text-[13px] leading-5 text-settings-text outline-none transition-colors focus-visible:border-settings-focus";

      const openRelayDialog = (relay: Rly0Relay | null): void => {
        const client = getClient();
        const addRelay = client?.addRly0Relay;
        const updateRelay = client?.updateRly0Relay;
        const testRelayCall = client?.testRly0Relay;
        if (relay ? !updateRelay : !addRelay) return;
        const name = el("input", inputClass);
        name.type = "text";
        name.name = "relay-name";
        name.autocomplete = "off";
        name.value = relay?.name ?? "";
        const baseUrl = el("input", inputClass);
        baseUrl.type = "url";
        baseUrl.name = "relay-base-url";
        baseUrl.autocomplete = "off";
        baseUrl.spellcheck = false;
        baseUrl.placeholder = messages.formBaseUrlHint;
        baseUrl.value = relay?.baseUrl ?? "";
        const apiKey = el("input", inputClass);
        apiKey.type = "password";
        apiKey.name = "relay-api-key";
        apiKey.autocomplete = "new-password";
        apiKey.spellcheck = false;
        const models = el("textarea", `${inputClass} settings-rly0-relay__models`);
        models.name = "relay-models";
        models.rows = 4;
        models.spellcheck = false;
        models.value = relay?.models.join("\n") ?? "";
        const routeLocked = el("input");
        routeLocked.type = "checkbox";
        routeLocked.name = "relay-route-locked";
        routeLocked.checked = relay?.routeLocked === true;
        const routeLockedLabel = el("label", "settings-rly0-relay__toggle");
        routeLockedLabel.append(routeLocked, el("span", undefined, messages.formRouteLocked));
        const testLine = el("p", "settings-rly0-mcp__detail");
        const fillHost = el("div", "settings-rly0-relay__actions");
        // Id of a relay created by "save and test" inside this dialog, so a later save updates it.
        let savedId: string | null = relay?.id ?? null;

        const readForm = (): {
          name: string;
          baseUrl: string;
          models: string[];
        } | null => {
          const parsedName = rly0RelayNameSchema.safeParse(name.value);
          const parsedUrl = rly0RelayBaseUrlSchema.safeParse(baseUrl.value);
          const parsedModels = parseRelayModels(models.value);
          if (!parsedName.success || !parsedUrl.success || parsedModels === null) return null;
          return { name: parsedName.data, baseUrl: parsedUrl.data, models: parsedModels };
        };
        /** Hands the key to the core once and immediately forgets it. */
        const takeKey = (): string | undefined => {
          const value = apiKey.value.trim();
          apiKey.value = "";
          return value || undefined;
        };
        const save = async (error: HTMLElement): Promise<string | null> => {
          const form = readForm();
          if (!form) {
            error.textContent = messages.formInvalid;
            return null;
          }
          const key = takeKey();
          try {
            if (savedId) {
              if (!updateRelay) return null;
              const result = await updateRelay({
                id: savedId,
                name: form.name,
                baseUrl: form.baseUrl,
                models: form.models,
                routeLocked: routeLocked.checked,
                ...(key ? { apiKey: key } : {}),
              });
              if (!result.available) {
                error.textContent = messages.unavailable;
                return null;
              }
              return savedId;
            }
            if (!addRelay) return null;
            const result = await addRelay({
              name: form.name,
              baseUrl: form.baseUrl,
              models: form.models,
              ...(routeLocked.checked ? { routeLocked: true } : {}),
              ...(key ? { apiKey: key } : {}),
            });
            if (!result.available) {
              error.textContent = messages.unavailable;
              return null;
            }
            savedId = result.id;
            return savedId;
          } catch (failure) {
            error.textContent = failureText(failure, messages.actionFailed);
            return null;
          }
        };

        const modal = openDialog(
          relay ? messages.formEditTitle : messages.formAddTitle,
          (body) => {
            body.append(
              field(messages.formName, name),
              field(messages.formBaseUrl, baseUrl),
              field(
                messages.formApiKey,
                apiKey,
                relay?.hasKey
                  ? `${messages.formApiKeyKeep.replace("{mask}", relay.keyMask ?? "••••")} ${messages.formApiKeyHint}`
                  : messages.formApiKeyHint,
              ),
              field(messages.formModels, models, messages.formModelsHint),
              (() => {
                const wrap = el("div", "settings-credential-dialog__field");
                wrap.append(
                  routeLockedLabel,
                  el("small", "settings-rly0-mcp__detail", messages.formRouteLockedHint),
                );
                return wrap;
              })(),
              testLine,
              fillHost,
            );
          },
          messages.formSave,
          async (error) => {
            const id = await save(error);
            if (!id) return false;
            await load();
            return true;
          },
        );
        if (!modal || !testRelayCall) {
          name.focus?.();
          return;
        }
        const controls = modal.querySelector(".settings-credential-dialog__actions");
        const error = modal.querySelector<HTMLElement>(".settings-credential-dialog__error");
        const testButton = button(messages.formTest, "secondary", () => {
          if (!error) return;
          testButton.disabled = true;
          error.textContent = "";
          testLine.textContent = messages.testing;
          fillHost.replaceChildren();
          void (async () => {
            try {
              const id = await save(error);
              if (!id || signal.aborted) {
                testLine.textContent = "";
                return;
              }
              const result = await testRelayCall({ id });
              if (signal.aborted) return;
              if (!result.available) {
                testLine.textContent = messages.unavailable;
                return;
              }
              tests.set(id, { loading: false, result });
              testLine.textContent = result.ok
                ? messages.testOk
                    .replace("{ms}", String(Math.round(result.latencyMs)))
                    .replace("{count}", String(result.modelCount ?? result.models?.length ?? 0))
                : [messages.testFailed, result.error, result.status].filter(Boolean).join(" · ");
              const found = result.ok ? (result.models ?? []) : [];
              if (found.length > 0) {
                fillHost.append(
                  button(
                    messages.formTestFill.replace("{n}", String(found.length)),
                    "secondary",
                    () => {
                      models.value = found.join("\n");
                    },
                  ),
                );
              }
            } catch (failure) {
              if (!signal.aborted) testLine.textContent = failureText(failure, messages.testFailed);
            } finally {
              testButton.disabled = false;
              void load();
            }
          })();
        });
        controls?.insertBefore(testButton, controls.lastChild);
        name.focus?.();
      };

      const openRemoveDialog = (relay: Rly0Relay): void => {
        const remove = getClient()?.removeRly0Relay;
        if (!remove) return;
        openDialog(
          messages.removeTitle,
          (body) =>
            body.append(el("p", undefined, messages.removeBody.replace("{name}", relay.name))),
          messages.removeConfirm,
          async (error) => {
            try {
              const result = await remove({ id: relay.id });
              if (!result.available) {
                error.textContent = messages.unavailable;
                return false;
              }
              tests.delete(relay.id);
              await load();
              return true;
            } catch (failure) {
              error.textContent = failureText(failure, messages.actionFailed);
              return false;
            }
          },
          true,
        );
      };

      const openApplyDialog = (): void => {
        const apply = getClient()?.rly0RelayCodexConfigApply;
        const running = runningProxy();
        if (!apply || !running || !codex) return;
        const path = codex.configPath;
        const options = relayCodexModelOptions(relays);
        const setDefaultLabel = el("label", "settings-rly0-relay__toggle");
        const setDefault = el("input");
        setDefault.type = "checkbox";
        setDefault.name = "relay-set-default";
        setDefault.checked = false;
        setDefault.disabled = options.length === 0;
        setDefaultLabel.append(setDefault, el("span", undefined, messages.codexSetDefault));
        const model = el(
          "select",
          "h-8 shrink-0 rounded-md border border-settings-border bg-settings-surface px-2 text-[13px] leading-5 text-settings-text outline-none transition-colors focus-visible:border-settings-focus",
        );
        model.name = "relay-model";
        if (options.length === 0) {
          const option = el("option", undefined, messages.codexModelNone);
          option.value = "";
          model.append(option);
        }
        for (const name of options) {
          const option = el("option", undefined, name);
          option.value = name;
          model.append(option);
        }
        if (codex.model && options.includes(codex.model)) model.value = codex.model;
        model.disabled = true;
        const note = el("p");
        const updateNote = (): void => {
          model.disabled = !setDefault.checked || options.length === 0;
          note.textContent = messages.codexApplyBody
            .replace("{path}", path)
            .replace(
              "{default}",
              setDefault.checked && model.value
                ? messages.codexApplyDefault.replace("{model}", model.value)
                : "",
            );
        };
        setDefault.addEventListener("change", updateNote);
        model.addEventListener("change", updateNote);
        updateNote();
        openDialog(
          messages.codexApplyTitle,
          (body) => body.append(note, setDefaultLabel, field(messages.codexModel, model)),
          messages.codexConfirm,
          async (error) => {
            const withDefault = setDefault.checked && model.value !== "";
            try {
              const result = await apply({
                baseUrl: running.baseUrl,
                setDefault: withDefault,
                ...(withDefault ? { model: model.value } : {}),
              });
              codex = result.status;
              if (!result.ok) {
                error.textContent = messages.codexFailed;
                return false;
              }
              setNotice(
                result.backendReload === "reloaded"
                  ? messages.codexApplyReloaded
                  : result.backendReload === "deferred"
                    ? messages.codexApplyDeferred
                    : messages.codexApplyDone,
              );
              render();
              return true;
            } catch {
              error.textContent = messages.codexFailed;
              return false;
            }
          },
        );
      };

      const openRestoreDialog = (): void => {
        const restore = getClient()?.rly0RelayCodexConfigRestore;
        if (!restore) return;
        openDialog(
          messages.codexRestoreTitle,
          (body) => body.append(el("p", undefined, messages.codexRestoreBody)),
          messages.codexConfirm,
          async (error) => {
            try {
              const result = await restore();
              codex = result.status;
              if (!result.ok) {
                error.textContent = messages.codexFailed;
                return false;
              }
              setNotice(
                result.backendReload === "reloaded"
                  ? messages.codexRestoreReloaded
                  : result.backendReload === "deferred"
                    ? messages.codexRestoreDeferred
                    : messages.codexRestoreDone,
              );
              render();
              return true;
            } catch {
              error.textContent = messages.codexFailed;
              return false;
            }
          },
        );
      };

      signal.addEventListener("abort", () => dialog?.remove(), { once: true });
      render();
      void load();
      return undefined;
    },
  });
}
