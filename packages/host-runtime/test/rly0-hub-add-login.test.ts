import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { OfficialAppServerConnection } from "../src/official-app-server-connection.js";
import type { Rly0CoreBridge } from "../src/rly0-core/index.js";
import { Rly0HubAddLogin } from "../src/rly0-hub-service/add-login.js";
import {
  locateOfficialCodex,
  type CodexLocateFileSystem,
} from "../src/rly0-hub-service/codex-locate.js";
import { Rly0HubService } from "../src/rly0-hub-service/service.js";

const LOCAL = "C:\\Users\\me\\AppData\\Local";
const CACHE = `${LOCAL}\\OpenAI\\Codex\\bin`;
const ALIASES = `${LOCAL}\\Microsoft\\WindowsApps`;
const PACKAGE = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.1007.9446.0_x64__2p2nqsd0c76g0";

/** An in-memory Windows file system: files with modification times, directories, aliases. */
function fakeFileSystem(layout: {
  files?: Record<string, number>;
  directories?: Record<string, string[]>;
  links?: Record<string, string>;
  realpaths?: Record<string, string>;
}): CodexLocateFileSystem {
  const key = (file: string) => file.toLowerCase();
  const files = new Map(Object.entries(layout.files ?? {}).map(([f, t]) => [key(f), t]));
  const directories = new Map(
    Object.entries(layout.directories ?? {}).map(([d, names]) => [key(d), names]),
  );
  const missing = (file: string) => Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  return {
    async readdir(directory) {
      const names = directories.get(key(directory));
      if (!names) throw missing(directory);
      return names.map((name) => ({
        name,
        isDirectory: () => directories.has(key(path.win32.join(directory, name))),
      }));
    },
    async stat(file) {
      const modified = files.get(key(file));
      if (modified === undefined) throw missing(file);
      return { isFile: () => true, mtimeMs: modified };
    },
    async realpath(file) {
      const mapped = layout.realpaths?.[file];
      if (mapped) return mapped;
      if (files.has(key(file)) || directories.has(key(file))) return file;
      throw missing(file);
    },
    async readlink(file) {
      const target = layout.links?.[file];
      if (!target) throw missing(file);
      return target;
    },
  };
}

describe("locating the official Codex executable", () => {
  const environment = { LOCALAPPDATA: LOCAL };

  it("prefers the newest Desktop-managed CLI, like the Launcher", async () => {
    const fileSystem = fakeFileSystem({
      directories: { [CACHE]: ["old", "new", "rg"], [`${CACHE}\\old`]: [], [`${CACHE}\\new`]: [] },
      files: { [`${CACHE}\\old\\codex.exe`]: 1, [`${CACHE}\\new\\codex.exe`]: 2 },
    });
    expect(await locateOfficialCodex({ environment, platform: "win32", fileSystem })).toEqual({
      path: `${CACHE}\\new\\codex.exe`,
      source: "desktopCache",
    });
  });

  it("ignores cache entries that resolve outside the cache", async () => {
    const fileSystem = fakeFileSystem({
      directories: { [CACHE]: ["evil"], [`${CACHE}\\evil`]: [] },
      files: { [`${CACHE}\\evil\\codex.exe`]: 5 },
      realpaths: { [`${CACHE}\\evil\\codex.exe`]: "D:\\elsewhere\\codex.exe" },
    });
    expect(await locateOfficialCodex({ environment, platform: "win32", fileSystem })).toBeNull();
  });

  it("finds the Store package through its app execution aliases", async () => {
    const aliasDirectory = `${ALIASES}\\OpenAI.Codex_2p2nqsd0c76g0`;
    const fileSystem = fakeFileSystem({
      directories: {
        [CACHE]: ["node"],
        [`${CACHE}\\node`]: [],
        [ALIASES]: ["winget.exe", "OpenAI.Codex_2p2nqsd0c76g0", "Other.App_123"],
        [aliasDirectory]: ["codex-core-command-runner.exe"],
        [`${ALIASES}\\Other.App_123`]: [],
      },
      links: {
        [`${aliasDirectory}\\codex-core-command-runner.exe`]: `${PACKAGE}\\app\\resources\\codex-command-runner.exe`,
      },
      files: { [`${PACKAGE}\\app\\resources\\codex.exe`]: 1 },
    });
    expect(await locateOfficialCodex({ environment, platform: "win32", fileSystem })).toEqual({
      path: `${PACKAGE}\\app\\resources\\codex.exe`,
      source: "storePackage",
    });
  });

  it("honours a portable install root and reports nothing elsewhere", async () => {
    const fileSystem = fakeFileSystem({ files: { "D:\\Codex\\app\\resources\\codex.exe": 1 } });
    expect(
      await locateOfficialCodex({
        environment: { ...environment, CODEXHOST_INSTALL_ROOT: "D:\\Codex" },
        platform: "win32",
        fileSystem,
      }),
    ).toEqual({ path: "D:\\Codex\\app\\resources\\codex.exe", source: "portable" });
    expect(await locateOfficialCodex({ environment, platform: "win32", fileSystem })).toBeNull();
    expect(await locateOfficialCodex({ environment, platform: "darwin", fileSystem })).toBeNull();
    expect(
      await locateOfficialCodex({ environment: {}, platform: "win32", fileSystem }),
    ).toBeNull();
  });
});

/** A fake official app-server that answers initialize / login start / cancel. */
function fakeOfficial(authUrl = "https://auth.openai.com/oauth/authorize?x=1") {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<{ code: number; signal: null }>();
  const methods: string[] = [];
  let buffered = "";
  let isClosed = false;
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      // An exited process: writes fail like a broken pipe.
      if (isClosed) {
        callback(new Error("EPIPE"));
        return;
      }
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(buffered.slice(0, newline)) as { id?: number; method: string };
        buffered = buffered.slice(newline + 1);
        methods.push(message.method);
        if (message.id !== undefined) {
          const result =
            message.method === "account/login/start"
              ? { type: "chatgpt", loginId: "native-1", authUrl }
              : {};
          stdout.write(`${JSON.stringify({ id: message.id, result })}\n`);
        }
        newline = buffered.indexOf("\n");
      }
      callback();
    },
  });
  const connection: OfficialAppServerConnection = {
    stdin,
    stdout,
    stderr,
    closed: closed.promise,
    close() {
      if (isClosed) return;
      isClosed = true;
      stdout.end();
      closed.resolve({ code: 0, signal: null });
    },
  };
  return {
    connection,
    methods,
    complete(success: boolean) {
      stdout.write(
        `${JSON.stringify({ method: "account/login/completed", params: { loginId: "native-1", success } })}\n`,
      );
    },
  };
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function fakeCore(
  proxy: { mode: "system" } | { mode: "custom"; url: string } = { mode: "system" },
) {
  const imports: { codexHome: string; alias?: string }[] = [];
  const core = {
    status: async () => ({ available: true }),
    importFrom: async (params: { codexHome: string; alias?: string }) => {
      imports.push(params);
      return { available: true as const, id: "0123456789ab" };
    },
    getProxySettings: () => proxy,
  } as unknown as Pick<Rly0CoreBridge, "status" | "importFrom" | "getProxySettings">;
  return { core, imports };
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("adding a GPT account from the Hub", () => {
  it("signs in through the located official app-server in a throw-away CODEX_HOME", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "rly0-hub-add-"));
    roots.push(tempRoot);
    const official = fakeOfficial();
    const { core, imports } = fakeCore({ mode: "custom", url: "http://127.0.0.1:7890" });
    const openUrl = vi.fn();
    const inputs: { stockCodexPath: string; arguments: string[]; env: NodeJS.ProcessEnv }[] = [];
    const login = new Rly0HubAddLogin({
      environment: {
        CODEX_HOME: "C:\\Users\\me\\.codex",
        OPENAI_API_KEY: "sk-live",
        CODEXHOST_DATA_DIR: "x",
        PATH: "C:\\Windows",
      },
      core,
      openUrl,
      tempRoot,
      locate: async () => ({ path: "C:\\codex\\codex.exe", source: "desktopCache" }),
      connectOfficial: (input) => {
        inputs.push({ ...input, env: input.environment });
        return official.connection;
      },
    });

    const started = await login.start({});
    expect(started).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{16}$/u),
      url: "https://auth.openai.com/oauth/authorize?x=1",
    });
    expect(openUrl).toHaveBeenCalledWith("https://auth.openai.com/oauth/authorize?x=1");
    expect(inputs[0]?.stockCodexPath).toBe("C:\\codex\\codex.exe");
    expect(inputs[0]?.arguments).toEqual(["app-server"]);
    const home = inputs[0]?.env.CODEX_HOME ?? "";
    expect(path.dirname(home)).toBe(tempRoot);
    expect(inputs[0]?.env.OPENAI_API_KEY).toBeUndefined();
    expect(inputs[0]?.env.CODEXHOST_DATA_DIR).toBeUndefined();
    expect(inputs[0]?.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(login.status(started.id)).toEqual({ available: true, state: "pending" });

    official.complete(true);
    await until(() => login.status(started.id).state !== "pending");
    expect(login.status(started.id)).toEqual({
      available: true,
      state: "completed",
      id: "0123456789ab",
    });
    expect(imports).toEqual([{ codexHome: home }]);
    // The temporary sign-in directory is deleted once rly0-core has the account.
    await vi.waitFor(async () => expect(await readdir(tempRoot)).toEqual([]));
  });

  it("does not open sign-in pages outside OpenAI, and can be cancelled", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "rly0-hub-add-"));
    roots.push(tempRoot);
    const official = fakeOfficial("https://example.com/phish");
    const openUrl = vi.fn();
    const login = new Rly0HubAddLogin({
      environment: {},
      core: fakeCore().core,
      openUrl,
      tempRoot,
      locate: async () => ({ path: "C:\\codex\\codex.exe", source: "storePackage" }),
      connectOfficial: () => official.connection,
    });
    const started = await login.start({});
    expect(openUrl).not.toHaveBeenCalled();
    expect(await login.cancel(started.id)).toEqual({ available: true, cancelled: true });
    expect(login.status(started.id)).toEqual({ available: true, state: "cancelled" });
    expect(official.methods).toContain("account/login/cancel");
  });

  it("reports CODEX_NOT_FOUND and CODEX_START_FAILED with codes only", async () => {
    const missing = new Rly0HubAddLogin({
      environment: {},
      core: fakeCore().core,
      openUrl: vi.fn(),
      locate: async () => null,
      connectOfficial: () => {
        throw new Error("must not start");
      },
    });
    await expect(missing.start({})).rejects.toThrow("CODEX_NOT_FOUND");

    const tempRoot = await mkdtemp(path.join(tmpdir(), "rly0-hub-add-"));
    roots.push(tempRoot);
    const dead = fakeOfficial();
    dead.connection.close();
    const broken = new Rly0HubAddLogin({
      environment: {},
      core: fakeCore().core,
      openUrl: vi.fn(),
      tempRoot,
      locate: async () => ({ path: "C:\\codex\\codex.exe", source: "storePackage" }),
      connectOfficial: () => dead.connection,
    });
    await expect(broken.start({})).rejects.toThrow("CODEX_START_FAILED");
    expect(await readdir(tempRoot)).toEqual([]);
  });

  it("is reachable through the Hub service routes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rly0-hub-add-"));
    roots.push(root);
    const service = new Rly0HubService({
      environment: { CODEXHOST_DATA_DIR: root },
      installRoot: root,
      core: { dispose: async () => undefined } as unknown as Rly0CoreBridge,
      addLogin: new Rly0HubAddLogin({
        environment: {},
        core: fakeCore().core,
        openUrl: vi.fn(),
        locate: async () => null,
      }),
    });
    expect(service.methods).toEqual(
      expect.arrayContaining([
        "accounts.addLoginStart",
        "accounts.addLoginStatus",
        "accounts.addLoginCancel",
      ]),
    );
    await expect(service.handle("accounts.addLoginStart", {})).rejects.toThrow("CODEX_NOT_FOUND");
    await expect(
      service.handle("accounts.addLoginStatus", { id: "0123456789abcdef" }),
    ).resolves.toEqual({ available: true, state: "failed", error: "LOGIN_UNKNOWN" });
    await expect(
      service.handle("accounts.addLoginCancel", { id: "0123456789abcdef" }),
    ).resolves.toEqual({ available: true, cancelled: false });
    await expect(service.handle("accounts.addLoginStatus", { id: "nope" })).rejects.toThrow(
      "INVALID_PARAMS",
    );
    await service.dispose();
  });
});
