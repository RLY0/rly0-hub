import { describe, expect, it } from "vitest";

import { resolveRly0LauncherCommand } from "../../src/rly0-appearance/windows-autostart.js";

describe("resolveRly0LauncherCommand", () => {
  it("joins the executable and args without quoting when there is no whitespace", () => {
    expect(resolveRly0LauncherCommand("C:\\rly0-hub.exe", [])).toBe("C:\\rly0-hub.exe");
    expect(resolveRly0LauncherCommand("node", ["cli.js", "--headless"])).toBe(
      "node cli.js --headless",
    );
  });

  it("quotes any executable or argument containing whitespace", () => {
    expect(
      resolveRly0LauncherCommand("C:\\Program Files\\rly0-hub\\rly0-hub.exe", ["--flag"]),
    ).toBe('"C:\\Program Files\\rly0-hub\\rly0-hub.exe" --flag');
  });
});
