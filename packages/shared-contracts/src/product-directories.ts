/**
 * RLY/0 Hub keeps its own per-user state so it never shares data with an upstream
 * CodexHost installation on the same machine. `CODEXHOST_DATA_DIR` still overrides
 * the home-directory default.
 */
/** Dot-directory under the user's home directory, e.g. `~/.rly0-hub`. */
export const RLY0_HOME_DATA_DIRECTORY_NAME = ".rly0-hub";
/** Directory under platform app-data roots (LOCALAPPDATA, Application Support). */
export const RLY0_APP_DATA_DIRECTORY_NAME = "rly0-hub";
