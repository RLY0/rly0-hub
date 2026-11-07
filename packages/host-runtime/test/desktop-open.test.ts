import { describe, expect, it } from "vitest";

import { openInBrowser, revealFolder } from "../src/rly0-hub-service/desktop-open.js";

function recorder(failFirst = false) {
  const calls: Array<[string, string[]]> = [];
  let failed = false;
  const spawn = (command: string, args: string[]) => {
    calls.push([command, args]);
    const listeners: Array<() => void> = [];
    const child = {
      on: (_event: "error", listener: () => void) => {
        listeners.push(listener);
        return child;
      },
      unref: () => {
        if (failFirst && !failed) {
          failed = true;
          listeners.forEach((listener) => listener());
        }
      },
    };
    return child;
  };
  return { calls, spawn };
}

describe("desktop open (synthetic spawn)", () => {
  it("opens web pages with `open` on macOS (Hub links were silently dead before)", () => {
    const r = recorder();
    openInBrowser("https://example.com/recharge?a=1,2", { platform: "darwin", spawn: r.spawn });
    expect(r.calls).toEqual([["/usr/bin/open", ["https://example.com/recharge?a=1,2"]]]);
  });

  it("never hands a non-web URL to `open` on macOS or Linux", () => {
    const r = recorder();
    for (const url of [
      "file:///etc/passwd",
      "vscode://x",
      "/Applications/Calculator.app",
      "javascript:alert(1)",
    ]) {
      openInBrowser(url, { platform: "darwin", spawn: r.spawn });
      openInBrowser(url, { platform: "linux", spawn: r.spawn });
    }
    expect(r.calls).toEqual([]);
  });

  it("keeps Windows on url.dll with the explorer fallback", () => {
    const r = recorder(true);
    openInBrowser("https://example.com/", {
      platform: "win32",
      environment: { SystemRoot: "C:\\Windows" },
      spawn: r.spawn,
    });
    expect(r.calls).toEqual([
      [
        "C:\\Windows\\System32\\rundll32.exe",
        ["url.dll,FileProtocolHandler", "https://example.com/"],
      ],
      ["explorer.exe", ["https://example.com/"]],
    ]);
  });

  it("reveals folders in Finder on macOS and Explorer on Windows", () => {
    const r = recorder();
    revealFolder("/Users/synthetic/.rly0-hub/memory", { platform: "darwin", spawn: r.spawn });
    revealFolder("relative/path", { platform: "darwin", spawn: r.spawn });
    revealFolder("C:\\Users\\synthetic\\memory", { platform: "win32", spawn: r.spawn });
    revealFolder("/home/synthetic/skills", { platform: "linux", spawn: r.spawn });
    expect(r.calls).toEqual([
      ["/usr/bin/open", ["/Users/synthetic/.rly0-hub/memory"]],
      ["explorer.exe", ["C:\\Users\\synthetic\\memory"]],
      ["xdg-open", ["/home/synthetic/skills"]],
    ]);
  });
});
