import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HOST_UNAVAILABLE,
  createHostConsoleRoutes,
  createHubHostRequest,
} from "../src/rly0-hub-service/host-console-routes.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hub access to the local Host console channel", () => {
  it("reads through the newest live descriptor and never opens a browser page", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rly0-hub-host-"));
    roots.push(root);
    const hosts = path.join(root, "console", "hosts");
    await mkdir(hosts, { recursive: true });
    const descriptor = (pid: number, port: number, startedAt: number) =>
      JSON.stringify({ schemaVersion: 1, pid, port, token: "a".repeat(64), startedAt });
    await writeFile(path.join(hosts, "host-1.json"), descriptor(1, 1111, 1));
    await writeFile(path.join(hosts, "host-2.json"), descriptor(2, 2222, 2));
    await writeFile(path.join(hosts, "host-3.json"), descriptor(3, 3333, 3));
    const seen: { url: string; body: unknown; auth: string | null }[] = [];
    const request = createHubHostRequest({
      environment: { CODEXHOST_DATA_DIR: root },
      isAlive: (pid) => pid !== 3,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.push({
          url,
          body: JSON.parse(String(init.body)),
          auth: new Headers(init.headers).get("authorization"),
        });
        return new Response(JSON.stringify({ result: [{ hostId: "h1" }] }));
      }) as typeof fetch,
    });
    const routes = createHostConsoleRoutes(request);
    expect(await routes["remote.list"]({})).toEqual({
      available: true,
      connections: [{ hostId: "h1" }],
    });
    expect(seen).toEqual([
      {
        url: "http://127.0.0.1:2222/rpc",
        body: { method: "codexhost/console/remote-connections", params: { action: "list" } },
        auth: `Bearer ${"a".repeat(64)}`,
      },
    ]);
  });

  it("says Codex is not running for reads and refuses changes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "rly0-hub-host-"));
    roots.push(root);
    const routes = createHostConsoleRoutes(
      createHubHostRequest({ environment: { CODEXHOST_DATA_DIR: root } }),
    );
    expect(await routes["usage.statistics"]({ range: "7d" })).toEqual({ available: false });
    expect(await routes["sessions.sources"]({})).toEqual({ available: false });
    await expect(
      routes["sessions.import"]({ harnessId: "claude-code", nativeSessionId: "s1" }),
    ).rejects.toThrow(HOST_UNAVAILABLE);
  });

  it("only forwards the fixed operations with validated parameters", async () => {
    const calls: [string, unknown][] = [];
    const routes = createHostConsoleRoutes(async (method, params) => {
      calls.push([method, params]);
      return method.endsWith("/sources") ? { harnesses: [{ harnessId: "pi", name: "Pi" }] } : {};
    });
    await expect(routes["usage.statistics"]({ range: "forever" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
    await expect(routes["remote.connect"]({ hostId: "h", enabled: "yes" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
    expect(await routes["sessions.sources"]({})).toEqual({
      available: true,
      harnesses: [{ harnessId: "pi", name: "Pi" }],
    });
    await routes["remote.connect"]({ hostId: "h", enabled: true });
    expect(calls).toEqual([
      ["codexhost/harness/session-import/sources", {}],
      ["codexhost/console/remote-connections", { action: "connect", hostId: "h", enabled: true }],
    ]);
  });
});
