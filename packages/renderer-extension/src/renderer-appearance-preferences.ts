/**
 * Renderer-local appearance preferences (theme, accent color, quota refresh
 * frequency, low-quota alert). These are purely client-side settings backed
 * by localStorage, following the same pattern as the reasoning soft-wrap
 * preference in renderer-transcript-dom.ts. They do not talk to the Host.
 */

export const RENDERER_THEMES = ["light", "dark", "system"] as const;
export type RendererTheme = (typeof RENDERER_THEMES)[number];

export const RENDERER_ACCENT_COLORS = [
  "signal",
  "blue",
  "purple",
  "green",
  "orange",
  "rose",
] as const;
export type RendererAccentColor = (typeof RENDERER_ACCENT_COLORS)[number];

export const RENDERER_QUOTA_REFRESH_INTERVALS_MS = {
  "30s": 30_000,
  "1m": 60_000,
  "3m": 180_000,
  "5m": 300_000,
} as const;
export type RendererQuotaRefreshFrequency = keyof typeof RENDERER_QUOTA_REFRESH_INTERVALS_MS;

export const RENDERER_THEME_STORAGE_KEY = "codexhost.rly0-theme.v1";
export const RENDERER_THEME_CHANGE_EVENT = "codexhost:rly0-theme-changed";

export const RENDERER_ACCENT_STORAGE_KEY = "codexhost.rly0-accent.v1";
export const RENDERER_ACCENT_CHANGE_EVENT = "codexhost:rly0-accent-changed";

export const RENDERER_QUOTA_REFRESH_STORAGE_KEY = "codexhost.rly0-quota-refresh.v1";
export const RENDERER_QUOTA_REFRESH_CHANGE_EVENT = "codexhost:rly0-quota-refresh-changed";

export const RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY = "codexhost.rly0-quota-alert-enabled.v1";
export const RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY = "codexhost.rly0-quota-alert-threshold.v1";
export const RENDERER_QUOTA_ALERT_CHANGE_EVENT = "codexhost:rly0-quota-alert-changed";

const DEFAULT_QUOTA_ALERT_THRESHOLD_PERCENT = 10;
const MIN_QUOTA_ALERT_THRESHOLD_PERCENT = 1;
const MAX_QUOTA_ALERT_THRESHOLD_PERCENT = 90;

function isRendererTheme(value: string | null): value is RendererTheme {
  return value !== null && (RENDERER_THEMES as readonly string[]).includes(value);
}

function isRendererAccentColor(value: string | null): value is RendererAccentColor {
  return value !== null && (RENDERER_ACCENT_COLORS as readonly string[]).includes(value);
}

function isQuotaRefreshFrequency(value: string | null): value is RendererQuotaRefreshFrequency {
  return value !== null && value in RENDERER_QUOTA_REFRESH_INTERVALS_MS;
}

export function readRendererTheme(ownerWindow: Window): RendererTheme {
  const stored = ownerWindow.localStorage.getItem(RENDERER_THEME_STORAGE_KEY);
  return isRendererTheme(stored) ? stored : "system";
}

export function setRendererTheme(ownerWindow: Window, theme: RendererTheme): void {
  ownerWindow.localStorage.setItem(RENDERER_THEME_STORAGE_KEY, theme);
  ownerWindow.dispatchEvent(new Event(RENDERER_THEME_CHANGE_EVENT));
}

export function readRendererAccentColor(ownerWindow: Window): RendererAccentColor {
  const stored = ownerWindow.localStorage.getItem(RENDERER_ACCENT_STORAGE_KEY);
  return isRendererAccentColor(stored) ? stored : "signal";
}

export function setRendererAccentColor(ownerWindow: Window, accent: RendererAccentColor): void {
  ownerWindow.localStorage.setItem(RENDERER_ACCENT_STORAGE_KEY, accent);
  ownerWindow.dispatchEvent(new Event(RENDERER_ACCENT_CHANGE_EVENT));
}

export function readRendererQuotaRefreshFrequency(
  ownerWindow: Window,
): RendererQuotaRefreshFrequency {
  const stored = ownerWindow.localStorage.getItem(RENDERER_QUOTA_REFRESH_STORAGE_KEY);
  return isQuotaRefreshFrequency(stored) ? stored : "1m";
}

export function setRendererQuotaRefreshFrequency(
  ownerWindow: Window,
  frequency: RendererQuotaRefreshFrequency,
): void {
  ownerWindow.localStorage.setItem(RENDERER_QUOTA_REFRESH_STORAGE_KEY, frequency);
  ownerWindow.dispatchEvent(new Event(RENDERER_QUOTA_REFRESH_CHANGE_EVENT));
}

export function readRendererQuotaAlertEnabled(ownerWindow: Window): boolean {
  return ownerWindow.localStorage.getItem(RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY) === "true";
}

export function setRendererQuotaAlertEnabled(ownerWindow: Window, enabled: boolean): void {
  ownerWindow.localStorage.setItem(RENDERER_QUOTA_ALERT_ENABLED_STORAGE_KEY, String(enabled));
  ownerWindow.dispatchEvent(new Event(RENDERER_QUOTA_ALERT_CHANGE_EVENT));
}

export function readRendererQuotaAlertThresholdPercent(ownerWindow: Window): number {
  const stored = ownerWindow.localStorage.getItem(RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY);
  const parsed = stored === null ? Number.NaN : Number.parseInt(stored, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed < MIN_QUOTA_ALERT_THRESHOLD_PERCENT ||
    parsed > MAX_QUOTA_ALERT_THRESHOLD_PERCENT
  ) {
    return DEFAULT_QUOTA_ALERT_THRESHOLD_PERCENT;
  }
  return parsed;
}

export function setRendererQuotaAlertThresholdPercent(
  ownerWindow: Window,
  percent: number,
): boolean {
  if (
    !Number.isInteger(percent) ||
    percent < MIN_QUOTA_ALERT_THRESHOLD_PERCENT ||
    percent > MAX_QUOTA_ALERT_THRESHOLD_PERCENT
  ) {
    return false;
  }
  ownerWindow.localStorage.setItem(RENDERER_QUOTA_ALERT_THRESHOLD_STORAGE_KEY, String(percent));
  ownerWindow.dispatchEvent(new Event(RENDERER_QUOTA_ALERT_CHANGE_EVENT));
  return true;
}

/** Applies the resolved theme (light/dark) to the document root via `data-theme`. */
export function applyRendererTheme(ownerDocument: Document, theme: RendererTheme): () => void {
  const ownerWindow = ownerDocument.defaultView;
  const root = ownerDocument.documentElement;
  const media = ownerWindow?.matchMedia?.("(prefers-color-scheme: dark)") ?? null;

  const apply = (): void => {
    const resolved = theme === "system" ? ((media?.matches ?? false) ? "dark" : "light") : theme;
    root.setAttribute("data-rly0-theme", resolved);
  };

  apply();
  media?.addEventListener?.("change", apply);
  return () => {
    media?.removeEventListener?.("change", apply);
  };
}

const ACCENT_CSS_VARIABLES: Record<RendererAccentColor, string> = {
  signal: "#ff4b2e",
  blue: "#3b82f6",
  purple: "#8b5cf6",
  green: "#22c55e",
  orange: "#f97316",
  rose: "#f43f5e",
};

/** Applies the accent color as a CSS custom property on the document root. */
export function applyRendererAccentColor(
  ownerDocument: Document,
  accent: RendererAccentColor,
): void {
  ownerDocument.documentElement.style.setProperty(
    "--codexhost-rly0-accent",
    ACCENT_CSS_VARIABLES[accent],
  );
}
