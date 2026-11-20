import { describe, expect, it } from "vitest";
import { selectMacSharedHost, stopMacSharedHost } from "../src/rly0-hub-service/codex-processes.js";

import {
  launchStockCodex,
  officialEnvironment,
} from "../src/rly0-hub-service/codex-stock-launch.js";

describe("opening the official Codex (恢复官方原样)", () => {
  const hubEnvironment = {
    HOME: "/Users/a",
    PATH: "/usr/bin",
    CODEX_CLI_PATH: "/hub/bin/codexhost-shim",
    CODEXHOST_RENDERER_POLICY: "{}",
    CODEXHOST_DATA_DIR: "/hub/data",
    RLY0_SKIP_LEGACY_IMPORT: "1",
    ELECTRON_RUN_AS_NODE: "1",
  };

  it("keeps nothing of the Hub or the Launcher in the environment", () => {
    expect(officialEnvironment(hubEnvironment)).toEqual({ HOME: "/Users/a", PATH: "/usr/bin" });
  });

  it("macOS: LaunchServices by bundle id", async () => {
    const runs: unknown[] = [];
    const ok = await launchStockCodex({
      environment: hubEnvironment,
      platform: "darwin",
      runChecked: async (executable, args, environment) => {
        runs.push({ executable, args, environment });
        return 0;
      },
    });
    expect(ok).toBe(true);
    expect(runs).toEqual([
      {
        executable: "/usr/bin/open",
        args: ["-b", "com.openai.codex"],
        environment: { HOME: "/Users/a", PATH: "/usr/bin" },
      },
    ]);
  });

  it("macOS without Codex installed: open fails, so does the launch", async () => {
    const ok = await launchStockCodex({
      environment: hubEnvironment,
      platform: "darwin",
      runChecked: async () => 1,
    });
    expect(ok).toBe(false);
  });

  it("Windows: the AUMID the Start menu lists wins", async () => {
    const runs: Array<{ executable: string; args: string[] }> = [];
    const ok = await launchStockCodex({
      environment: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", SystemRoot: "C:\\Windows" },
      platform: "win32",
      startAppsId: async () => "OpenAI.Codex_2p2nqsd0c76g0!Codex",
      readDirectory: async () => {
        throw new Error("must not be needed");
      },
      run: (executable, args) => runs.push({ executable, args }),
    });
    expect(ok).toBe(true);
    expect(runs[0]?.args).toEqual(["shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!Codex"]);
  });

  it("Windows: the Store app through its AppUserModelID", async () => {
    const runs: Array<{ executable: string; args: string[] }> = [];
    const ok = await launchStockCodex({
      environment: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", SystemRoot: "C:\\Windows" },
      platform: "win32",
      startAppsId: async () => null,
      readDirectory: async (directory) => {
        expect(directory).toBe("C:\\Users\\a\\AppData\\Local\\Microsoft\\WindowsApps");
        return [
          "python.exe",
          "OpenAI.Codex_2p2nqsd0c76g0",
          "Microsoft.WindowsTerminal_8wekyb3d8bbwe",
        ];
      },
      run: (executable, args) => runs.push({ executable, args }),
    });
    expect(ok).toBe(true);
    expect(runs).toEqual([
      {
        executable: "C:\\Windows\\explorer.exe",
        args: ["shell:AppsFolder\\OpenAI.Codex_2p2nqsd0c76g0!App"],
      },
    ]);
  });

  it("Windows without the Store app: reports it cannot open", async () => {
    const ok = await launchStockCodex({
      environment: { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" },
      platform: "win32",
      startAppsId: async () => null,
      readDirectory: async () => ["python.exe"],
      run: () => {
        throw new Error("must not run");
      },
    });
    expect(ok).toBe(false);
  });
});

describe("the macOS shared Host (修复聊天记录 stops it to free Codex's database)", () => {
  const hub = "/Apps/RLY0 Hub.app/Contents/Resources";
  const serve = (data: string) =>
    `${hub}/bin/codexhost host serve --node /x/cua node/node --host-runtime ${hub}/app/host-runtime.mjs --data ${data} --codex-home /Users/a/.codex`;
  const entries = [
    { pid: 10, args: serve("/Users/a/.rly0-hub") },
    {
      pid: 11,
      args: `/x/node ${hub}/app/host-runtime.mjs --codexhost-shared-host --data /Users/a/.rly0-hub`,
    },
    { pid: 12, args: serve("/tmp/isolated test/hub") },
    { pid: 13, args: `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT` },
  ];

  it("picks the supervisor of this data directory only, paths with spaces intact", () => {
    expect(selectMacSharedHost(entries, "/Users/a/.rly0-hub")).toEqual([
      {
        pid: 10,
        launcher: `${hub}/bin/codexhost`,
        node: "/x/cua node/node",
        runtime: `${hub}/app/host-runtime.mjs`,
        data: "/Users/a/.rly0-hub",
      },
    ]);
  });

  it("stops it through its own launcher", async () => {
    const runs: unknown[] = [];
    const stopped = await stopMacSharedHost(
      "/Users/a/.rly0-hub",
      async () => entries,
      async (file, args) => {
        runs.push([file, ...args]);
        return "";
      },
    );
    expect(stopped).toBe(1);
    expect(runs).toEqual([
      [
        `${hub}/bin/codexhost`,
        "host",
        "stop",
        "--node",
        "/x/cua node/node",
        "--host-runtime",
        `${hub}/app/host-runtime.mjs`,
        "--data",
        "/Users/a/.rly0-hub",
      ],
    ]);
  });
});
