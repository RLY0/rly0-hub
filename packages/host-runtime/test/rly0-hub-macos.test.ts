import { describe, expect, it } from "vitest";

import { findMacHub, openMacHub, type MacHubSystem } from "../src/rly0-appearance/hub-macos.js";

function system(options: {
  processes?: string[];
  registered?: string[];
  files?: string[];
  fail?: boolean;
}) {
  const calls: Array<[string, readonly string[]]> = [];
  const fake: MacHubSystem = {
    processes: () => options.processes ?? [],
    registered: () => options.registered ?? [],
    exists: (file) => (options.files ?? []).includes(file),
    home: () => "/Users/me",
    wait: async () => undefined,
    run: async (file, args) => {
      calls.push([file, args]);
      if (options.fail) throw new Error("open failed");
    },
  };
  return { fake, calls };
}

const RUNNING = "/Volumes/X/Apps/RLY0 Hub.app";

describe("RLY/0 Hub on macOS", () => {
  it("prefers the running Hub, then the usual folders, then other known copies", () => {
    expect(
      findMacHub(system({ processes: [`${RUNNING}/Contents/MacOS/rly0-hub`], files: [] }).fake),
    ).toEqual({ bundle: RUNNING, running: true });
    expect(
      findMacHub(
        system({
          registered: ["/Elsewhere/RLY0 Hub.app"],
          files: ["/Users/me/Applications/RLY0 Hub.app", "/Elsewhere/RLY0 Hub.app"],
        }).fake,
      ),
    ).toEqual({ bundle: "/Users/me/Applications/RLY0 Hub.app", running: false });
    expect(
      findMacHub(
        system({
          registered: ["/Users/me/.Trash/RLY0 Hub.app"],
          files: ["/Users/me/.Trash/RLY0 Hub.app"],
        }).fake,
      ),
    ).toBeNull();
  });

  it("starts a stopped Hub on the page, and tells a running one the page", async () => {
    const stopped = system({ files: ["/Applications/RLY0 Hub.app"] });
    expect(await openMacHub("usage", stopped.fake)).toEqual({ available: true, ok: true });
    expect(stopped.calls).toEqual([
      ["/usr/bin/open", ["-a", "/Applications/RLY0 Hub.app", "--args", "--page", "usage"]],
    ]);

    const running = system({ processes: [`${RUNNING}/Contents/MacOS/rly0-hub`] });
    expect(await openMacHub("relays", running.fake)).toEqual({ available: true, ok: true });
    expect(running.calls.map(([file]) => file)).toEqual(["/usr/bin/open", "/usr/bin/osascript"]);
    expect((running.calls[1]?.[1] ?? []).join(" ")).toContain("'com.rly0.hub.navigate', 'relays'");
  });

  it("reports a missing Hub and a failed open", async () => {
    expect(await openMacHub(undefined, system({}).fake)).toEqual({ available: false, ok: false });
    expect(
      await openMacHub(
        undefined,
        system({ files: ["/Applications/RLY0 Hub.app"], fail: true }).fake,
      ),
    ).toEqual({ available: true, ok: false });
  });
});
