/**
 * Upstream settings pages that only exist on the Codex side: the standalone RLY/0 Hub does not
 * offer remote Host routes or local usage statistics. The lifecycle opens these page IDs in the
 * Codex settings shell even when the Hub is present (see `CODEX_DIRECT_SETTINGS_PAGES`).
 */
export type CodexSideSettingsPageId = "remote-connections" | "usage-statistics";

interface CodexSideSettingsShellHandle {
  readonly supported: boolean;
  readonly registry: {
    getPage(pageId: string): { readonly label: string } | undefined;
  };
  openSettings(opener?: HTMLElement, pageId?: string): boolean;
}

export interface CodexSideSettingsEntry {
  /** The page's label in the language the settings shell was last mounted with. */
  readonly label: string;
  open(opener?: HTMLElement): boolean;
}

function settingsShell(ownerWindow: Window | undefined): CodexSideSettingsShellHandle | undefined {
  return (
    ownerWindow as unknown as
      { __codexhostSettingsShellV1?: CodexSideSettingsShellHandle } | undefined
  )?.__codexhostSettingsShellV1;
}

/**
 * Resolves an entry for one Codex-side page, or `null` while the settings shell is not mounted or
 * does not register that page (so a missing capability is never shown as available). The shell is
 * read again on activation because the lifecycle remounts it on language and Hub changes.
 */
export function codexSideSettingsEntry(
  pageId: CodexSideSettingsPageId,
  ownerWindow: Window | undefined = typeof window !== "undefined" ? window : undefined,
): CodexSideSettingsEntry | null {
  const shell = settingsShell(ownerWindow);
  const page = shell?.supported ? shell.registry.getPage(pageId) : undefined;
  if (!page) return null;
  return {
    label: page.label,
    open(opener) {
      const current = settingsShell(ownerWindow);
      if (!current?.supported || !current.registry.getPage(pageId)) return false;
      return current.openSettings(opener, pageId);
    },
  };
}
