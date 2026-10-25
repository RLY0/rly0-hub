/**
 * Entries for the remote Host and usage pages from Codex UI (the agent picker). With the RLY/0 Hub
 * installed the handle routes them to the Hub's 设置 → 远程连接 / 用量统计; without it they open in
 * the in-Codex settings (renderer-settings-lifecycle.ts).
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
