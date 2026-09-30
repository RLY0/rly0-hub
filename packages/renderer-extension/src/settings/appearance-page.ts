import {
  rly0ProxyUrlSchema,
  type Rly0AppearanceAutostartResult,
  type Rly0ProxyMode,
  type Rly0ProxySettings,
  type Rly0ProxySettingsGetResult,
  type Rly0ProxySettingsSetParams,
  type Rly0ProxySettingsSetResult,
} from "@codexhost/shared-contracts";
import {
  REASONING_SOFT_WRAP_CHANGE_EVENT,
  readReasoningTranscriptSoftWrap,
  setReasoningTranscriptSoftWrap,
} from "../renderer-transcript-dom.js";
import {
  RENDERER_ACCENT_COLORS,
  RENDERER_QUOTA_REFRESH_INTERVALS_MS,
  RENDERER_THEME_CHANGE_EVENT,
  RENDERER_ACCENT_CHANGE_EVENT,
  RENDERER_QUOTA_REFRESH_CHANGE_EVENT,
  RENDERER_QUOTA_ALERT_CHANGE_EVENT,
  type RendererTheme,
  type RendererAccentColor,
  type RendererQuotaRefreshFrequency,
  readRendererTheme,
  setRendererTheme,
  readRendererAccentColor,
  setRendererAccentColor,
  readRendererQuotaRefreshFrequency,
  setRendererQuotaRefreshFrequency,
  readRendererQuotaAlertEnabled,
  setRendererQuotaAlertEnabled,
  readRendererQuotaAlertThresholdPercent,
  setRendererQuotaAlertThresholdPercent,
  applyRendererTheme,
  applyRendererAccentColor,
} from "../renderer-appearance-preferences.js";
import type { RendererSettingsPageDefinition, RendererSettingsPageMountContext } from "./core.js";
import type { RendererSettingsMessages } from "./localization.js";
import { mountIdleReleaseControls } from "./idle-release-controls.js";
import type { LoadedSessionsClient } from "./loaded-sessions-table.js";
import {
  createPreferenceGroup,
  createPreferenceItem,
  createPreferenceSwitch,
  createNumberField,
  preferenceId,
} from "./preference-ui.js";

export interface RendererAppearanceClient {
  rly0AppearanceAutostartStatus?(): Promise<Rly0AppearanceAutostartResult>;
  rly0AppearanceAutostartSet?(input: { enabled: boolean }): Promise<Rly0AppearanceAutostartResult>;
  rly0ProxySettingsGet?(): Promise<Rly0ProxySettingsGetResult>;
  rly0ProxySettingsSet?(input: Rly0ProxySettingsSetParams): Promise<Rly0ProxySettingsSetResult>;
}

function createSelect(
  document: Document,
  id: string,
  describedBy: string,
  options: readonly { value: string; label: string }[],
): HTMLSelectElement {
  const select = document.createElement("select");
  select.id = id;
  select.setAttribute("aria-describedby", describedBy);
  select.className =
    "h-8 shrink-0 rounded-md border border-settings-border bg-settings-surface px-2 text-[13px] leading-5 text-settings-text outline-none transition-colors focus-visible:border-settings-focus";
  for (const option of options) {
    const element = document.createElement("option");
    element.value = option.value;
    element.textContent = option.label;
    select.append(element);
  }
  return select;
}

export function createAppearanceSettingsPage(
  messages: RendererSettingsMessages,
  getLoadedSessionsClient: () => LoadedSessionsClient | null = () => null,
  getAppearanceClient: () => RendererAppearanceClient | null = () => null,
): RendererSettingsPageDefinition {
  return Object.freeze({
    id: "appearance",
    label: messages.pageLabels.appearance,
    icon: "settings",
    mount(context: RendererSettingsPageMountContext) {
      const document = context.content.ownerDocument;
      const ownerWindow = document.defaultView;
      if (!ownerWindow) return;
      const extra = messages.appearanceExtra;
      const heading = document.createElement("div");
      heading.className = "settings-section-label";
      heading.textContent = messages.pageLabels.appearance;

      const description = document.createElement("p");
      description.className = "settings-page-description";
      description.textContent = messages.appearanceDescription;

      const disposers: Array<() => void> = [];

      const { group, card } = createPreferenceGroup(document, messages.appearanceGroup);

      // Theme (light/dark/follow-system).
      const themeId = preferenceId("theme");
      const themeRow = createPreferenceItem(document, {
        title: extra.themeTitle,
        description: extra.themeDescription,
        controlId: themeId,
      });
      const themeSelect = createSelect(document, themeId, themeRow.description.id, [
        { value: "light", label: extra.themeLight },
        { value: "dark", label: extra.themeDark },
        { value: "system", label: extra.themeSystem },
      ]);
      themeSelect.value = readRendererTheme(ownerWindow);
      let disposeThemeEffect = applyRendererTheme(document, themeSelect.value as RendererTheme);
      themeSelect.addEventListener("change", () => {
        setRendererTheme(ownerWindow, themeSelect.value as RendererTheme);
      });
      const syncTheme = (): void => {
        const theme = readRendererTheme(ownerWindow);
        themeSelect.value = theme;
        disposeThemeEffect();
        disposeThemeEffect = applyRendererTheme(document, theme);
      };
      ownerWindow.addEventListener(RENDERER_THEME_CHANGE_EVENT, syncTheme);
      disposers.push(() => {
        ownerWindow.removeEventListener(RENDERER_THEME_CHANGE_EVENT, syncTheme);
        disposeThemeEffect();
      });
      themeRow.item.append(themeSelect);
      card.append(themeRow.item);

      // Accent color.
      const accentId = preferenceId("accent");
      const accentRow = createPreferenceItem(document, {
        title: extra.accentTitle,
        description: extra.accentDescription,
        controlId: accentId,
      });
      const accentLabels: Record<RendererAccentColor, string> = {
        blue: extra.accentBlue,
        purple: extra.accentPurple,
        green: extra.accentGreen,
        orange: extra.accentOrange,
        rose: extra.accentRose,
      };
      const accentSelect = createSelect(
        document,
        accentId,
        accentRow.description.id,
        RENDERER_ACCENT_COLORS.map((value) => ({ value, label: accentLabels[value] })),
      );
      accentSelect.value = readRendererAccentColor(ownerWindow);
      applyRendererAccentColor(document, accentSelect.value as RendererAccentColor);
      accentSelect.addEventListener("change", () => {
        setRendererAccentColor(ownerWindow, accentSelect.value as RendererAccentColor);
      });
      const syncAccent = (): void => {
        const accent = readRendererAccentColor(ownerWindow);
        accentSelect.value = accent;
        applyRendererAccentColor(document, accent);
      };
      ownerWindow.addEventListener(RENDERER_ACCENT_CHANGE_EVENT, syncAccent);
      disposers.push(() =>
        ownerWindow.removeEventListener(RENDERER_ACCENT_CHANGE_EVENT, syncAccent),
      );
      accentRow.item.append(accentSelect);
      card.append(accentRow.item);

      context.content.append(heading, description, group);

      // Autostart on boot.
      const { group: autostartGroup, card: autostartCard } = createPreferenceGroup(
        document,
        extra.autostartTitle,
      );
      const autostartId = preferenceId("autostart");
      const autostartRow = createPreferenceItem(document, {
        title: extra.autostartTitle,
        description: extra.autostartDescription,
        controlId: autostartId,
      });
      const autostartToggle = createPreferenceSwitch(
        document,
        autostartId,
        autostartRow.description.id,
      );
      autostartToggle.disabled = true;
      autostartRow.item.append(autostartToggle);
      autostartCard.append(autostartRow.item);
      context.content.append(autostartGroup);

      const refreshAutostart = (): void => {
        void context.runLatest(
          async (signal) => {
            const client = getAppearanceClient();
            if (!client?.rly0AppearanceAutostartStatus) {
              return { supported: false, enabled: false } satisfies Rly0AppearanceAutostartResult;
            }
            const result = await client.rly0AppearanceAutostartStatus();
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            return result;
          },
          {
            success: (result) => {
              autostartToggle.disabled = !result.supported;
              autostartToggle.checked = result.enabled;
              autostartRow.description.textContent = result.supported
                ? extra.autostartDescription
                : extra.autostartUnsupported;
            },
            failure: () => {
              autostartRow.description.textContent = extra.autostartFailed;
            },
          },
        );
      };
      autostartToggle.addEventListener("change", () => {
        const nextEnabled = autostartToggle.checked;
        autostartToggle.disabled = true;
        void context.runLatest(
          async (signal) => {
            const client = getAppearanceClient();
            if (!client?.rly0AppearanceAutostartSet) {
              throw new Error("Autostart is unavailable");
            }
            const result = await client.rly0AppearanceAutostartSet({ enabled: nextEnabled });
            if (signal.aborted) throw new DOMException("Aborted", "AbortError");
            return result;
          },
          {
            success: (result) => {
              autostartToggle.disabled = !result.supported;
              autostartToggle.checked = result.enabled;
            },
            failure: () => {
              autostartRow.description.textContent = extra.autostartFailed;
              refreshAutostart();
            },
          },
        );
      });
      refreshAutostart();

      // Data refresh frequency + low-quota alert.
      const { group: quotaGroup, card: quotaCard } = createPreferenceGroup(
        document,
        extra.refreshFrequencyTitle,
      );
      const refreshId = preferenceId("quota-refresh");
      const refreshRow = createPreferenceItem(document, {
        title: extra.refreshFrequencyTitle,
        description: extra.refreshFrequencyDescription,
        controlId: refreshId,
      });
      const refreshLabels: Record<RendererQuotaRefreshFrequency, string> = {
        "30s": extra.refreshFrequency30s,
        "1m": extra.refreshFrequency1m,
        "3m": extra.refreshFrequency3m,
        "5m": extra.refreshFrequency5m,
      };
      const refreshSelect = createSelect(
        document,
        refreshId,
        refreshRow.description.id,
        Object.keys(RENDERER_QUOTA_REFRESH_INTERVALS_MS).map((value) => ({
          value,
          label: refreshLabels[value as RendererQuotaRefreshFrequency],
        })),
      );
      refreshSelect.value = readRendererQuotaRefreshFrequency(ownerWindow);
      refreshSelect.addEventListener("change", () => {
        setRendererQuotaRefreshFrequency(
          ownerWindow,
          refreshSelect.value as RendererQuotaRefreshFrequency,
        );
      });
      const syncRefresh = (): void => {
        refreshSelect.value = readRendererQuotaRefreshFrequency(ownerWindow);
      };
      ownerWindow.addEventListener(RENDERER_QUOTA_REFRESH_CHANGE_EVENT, syncRefresh);
      disposers.push(() =>
        ownerWindow.removeEventListener(RENDERER_QUOTA_REFRESH_CHANGE_EVENT, syncRefresh),
      );
      refreshRow.item.append(refreshSelect);
      quotaCard.append(refreshRow.item);

      const alertId = preferenceId("quota-alert");
      const alertRow = createPreferenceItem(document, {
        title: extra.quotaAlertTitle,
        description: extra.quotaAlertDescription,
        controlId: alertId,
      });
      const alertToggle = createPreferenceSwitch(document, alertId, alertRow.description.id);
      alertToggle.checked = readRendererQuotaAlertEnabled(ownerWindow);
      alertToggle.addEventListener("change", () => {
        setRendererQuotaAlertEnabled(ownerWindow, alertToggle.checked);
      });
      alertRow.item.append(alertToggle);
      quotaCard.append(alertRow.item);

      const thresholdId = preferenceId("quota-alert-threshold");
      const thresholdRow = createPreferenceItem(document, {
        title: extra.quotaAlertThreshold,
        description: extra.quotaAlertThresholdDescription,
        controlId: thresholdId,
      });
      const { field: thresholdField, control: thresholdControl } = createNumberField(document, {
        id: thresholdId,
        describedBy: thresholdRow.description.id,
        unit: "%",
        min: 1,
        max: 90,
      });
      thresholdControl.value = String(readRendererQuotaAlertThresholdPercent(ownerWindow));
      thresholdControl.addEventListener("change", () => {
        const parsed = Number.parseInt(thresholdControl.value, 10);
        const ok = setRendererQuotaAlertThresholdPercent(ownerWindow, parsed);
        thresholdRow.description.dataset.invalid = ok ? "false" : "true";
        thresholdRow.description.textContent = ok
          ? extra.quotaAlertThresholdDescription
          : extra.quotaAlertThresholdInvalid;
        if (ok) thresholdControl.value = String(parsed);
      });
      thresholdRow.item.append(thresholdField);
      quotaCard.append(thresholdRow.item);

      const syncAlert = (): void => {
        alertToggle.checked = readRendererQuotaAlertEnabled(ownerWindow);
        thresholdControl.value = String(readRendererQuotaAlertThresholdPercent(ownerWindow));
      };
      ownerWindow.addEventListener(RENDERER_QUOTA_ALERT_CHANGE_EVENT, syncAlert);
      disposers.push(() =>
        ownerWindow.removeEventListener(RENDERER_QUOTA_ALERT_CHANGE_EVENT, syncAlert),
      );

      context.content.append(quotaGroup);

      // Outbound proxy for rly0-core (quota lookups). Stored by the host, not the renderer, so
      // it applies whenever the host spawns the core. Uses plain promises instead of
      // `runLatest` so it never cancels the autostart request above.
      const { group: proxyGroup, card: proxyCard } = createPreferenceGroup(
        document,
        extra.proxyTitle,
      );
      const proxyModeId = preferenceId("rly0-proxy-mode");
      const proxyModeRow = createPreferenceItem(document, {
        title: extra.proxyTitle,
        description: extra.proxyDescription,
        controlId: proxyModeId,
      });
      const proxyModeSelect = createSelect(document, proxyModeId, proxyModeRow.description.id, [
        { value: "direct", label: extra.proxyModeDirect },
        { value: "system", label: extra.proxyModeSystem },
        { value: "custom", label: extra.proxyModeCustom },
      ]);
      proxyModeSelect.value = "system";
      proxyModeSelect.disabled = true;
      proxyModeRow.item.append(proxyModeSelect);
      const proxyUrlId = preferenceId("rly0-proxy-url");
      const proxyUrlRow = createPreferenceItem(document, {
        title: extra.proxyUrlTitle,
        description: extra.proxyUrlDescription,
        controlId: proxyUrlId,
      });
      const proxyUrlInput = document.createElement("input");
      proxyUrlInput.type = "text";
      proxyUrlInput.id = proxyUrlId;
      proxyUrlInput.autocomplete = "off";
      proxyUrlInput.spellcheck = false;
      proxyUrlInput.maxLength = 512;
      proxyUrlInput.placeholder = "http://127.0.0.1:7890";
      proxyUrlInput.setAttribute("aria-describedby", proxyUrlRow.description.id);
      proxyUrlInput.className =
        "h-8 shrink-0 rounded-md border border-settings-border bg-settings-surface px-2 text-[13px] leading-5 text-settings-text outline-none transition-colors focus-visible:border-settings-focus";
      const proxySave = document.createElement("button");
      proxySave.type = "button";
      proxySave.className = "settings-command-button settings-command-button--secondary";
      proxySave.textContent = extra.proxySave;
      proxySave.disabled = true;
      const proxyUrlControls = document.createElement("div");
      proxyUrlControls.className = "flex shrink-0 items-center gap-2";
      proxyUrlControls.append(proxyUrlInput, proxySave);
      proxyUrlRow.item.append(proxyUrlControls);
      proxyCard.append(proxyModeRow.item, proxyUrlRow.item);
      context.content.append(proxyGroup);

      const proxyClient = (): RendererAppearanceClient | null => getAppearanceClient();
      const syncProxyVisibility = (): void => {
        proxyUrlRow.item.hidden = proxyModeSelect.value !== "custom";
      };
      const setProxyStatus = (text: string, invalid = false): void => {
        const target = proxyModeSelect.value === "custom" ? proxyUrlRow : proxyModeRow;
        target.description.textContent = text;
        target.description.dataset.invalid = invalid ? "true" : "false";
      };
      const resetProxyDescriptions = (): void => {
        proxyModeRow.description.textContent = extra.proxyDescription;
        proxyModeRow.description.dataset.invalid = "false";
        proxyUrlRow.description.textContent = extra.proxyUrlDescription;
        proxyUrlRow.description.dataset.invalid = "false";
      };
      const saveProxy = (): void => {
        const setter = proxyClient()?.rly0ProxySettingsSet;
        if (!setter) return;
        resetProxyDescriptions();
        const mode = proxyModeSelect.value as Rly0ProxyMode;
        const url = proxyUrlInput.value.trim();
        if (mode === "custom" && !rly0ProxyUrlSchema.safeParse(url).success) {
          setProxyStatus(extra.proxyInvalidUrl, true);
          proxyUrlInput.focus();
          return;
        }
        const settings: Rly0ProxySettings = mode === "custom" ? { mode, url } : { mode };
        proxyModeSelect.disabled = true;
        proxySave.disabled = true;
        void setter({ settings })
          .then((result) => {
            if (context.signal.aborted) return;
            setProxyStatus(result.coreRestarted ? extra.proxySavedRestarted : extra.proxySaved);
          })
          .catch(() => {
            if (!context.signal.aborted) setProxyStatus(extra.proxyFailed, true);
          })
          .finally(() => {
            if (context.signal.aborted) return;
            proxyModeSelect.disabled = false;
            proxySave.disabled = false;
          });
      };
      proxyModeSelect.addEventListener("change", () => {
        syncProxyVisibility();
        // Direct/system apply immediately; custom waits for an address and an explicit save.
        if (proxyModeSelect.value === "custom") {
          resetProxyDescriptions();
          proxyUrlInput.focus();
        } else saveProxy();
      });
      proxySave.addEventListener("click", saveProxy);
      syncProxyVisibility();
      const getProxy = proxyClient()?.rly0ProxySettingsGet;
      if (getProxy) {
        void getProxy()
          .then((result) => {
            if (context.signal.aborted) return;
            proxyModeSelect.value = result.settings.mode;
            proxyUrlInput.value = result.settings.url ?? "";
            proxyModeSelect.disabled = false;
            proxySave.disabled = false;
            syncProxyVisibility();
          })
          .catch(() => {
            if (!context.signal.aborted) setProxyStatus(extra.proxyFailed, true);
          });
      } else {
        proxyGroup.hidden = true;
      }

      // Reasoning soft wrap (existing).
      const { group: softWrapGroup, card: softWrapCard } = createPreferenceGroup(
        document,
        messages.appearanceGroup,
      );
      const softWrapId = preferenceId("reasoning-soft-wrap");
      const row = createPreferenceItem(document, {
        title: messages.reasoningSoftWrapTitle,
        description: messages.reasoningSoftWrapDescription,
        controlId: softWrapId,
      });
      const toggle = createPreferenceSwitch(document, softWrapId, row.description.id);
      toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      toggle.addEventListener("change", () => {
        setReasoningTranscriptSoftWrap(ownerWindow, toggle.checked);
      });
      const sync = (): void => {
        toggle.checked = readReasoningTranscriptSoftWrap(ownerWindow);
      };
      ownerWindow.addEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
      row.item.append(toggle);
      softWrapCard.append(row.item);
      context.content.append(softWrapGroup);

      const disposeIdleRelease = mountIdleReleaseControls(
        context,
        messages,
        getLoadedSessionsClient,
      );
      return () => {
        ownerWindow.removeEventListener(REASONING_SOFT_WRAP_CHANGE_EVENT, sync);
        for (const dispose of disposers) dispose();
        disposeIdleRelease();
      };
    },
  });
}
