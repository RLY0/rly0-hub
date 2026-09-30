import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import type { OfficialAppServerConnection } from "../src/official-app-server-connection.js";
import { Rly0AddAccountLogins } from "../src/rly0-core/add-account-login.js";

/** A fake official app-server that answers initialize / login start / cancel. */
function fakeOfficial(options: { failStart?: boolean } = {}) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = Promise.withResolvers<{ code: number; signal: null }>();
  const methods: string[] = [];
  let buffered = "";
  const stdin = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffered += chunk.toString("utf8");
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const message = JSON.parse(buffered.slice(0, newline)) as {
          id?: number;
          method: string;
        };
        buffered = buffered.slice(newline + 1);
        methods.push(message.method);
        if (message.id !== undefined) {
          const reply =
            message.method === "account/login/start"
              ? options.failStart
                ? { id: message.id, error: { code: -1, message: "nope" } }
                : {
                    id: message.id,
                    result: {
                      type: "chatgpt",
                      loginId: "native-1",
                      authUrl: "https://auth.example/authorize?x=1",
                    },
                  }
              : { id: message.id, result: {} };
          stdout.write(`${JSON.stringify(reply)}\n`);
        }
        newline = buffered.indexOf("\n");
      }
      callback();
    },
  });
  let closedFlag = false;
  const connection: OfficialAppServerConnection = {
    stdin,
    stdout,
    stderr,
    closed: closed.promise,
    close() {
      if (closedFlag) return;
      closedFlag = true;
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

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "rly0-add-test-"));
  roots.push(root);
  return root;
}

async function until(check: () => boolean): Promise<void> {
  for (let index = 0; index < 100 && !check(); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("RLY/0 add-account login", () => {
  it("logs in inside a throw-away CODEX_HOME, imports it and deletes the directory", async () => {
    const root = await tempRoot();
    const official = fakeOfficial();
    const homes: string[] = [];
    const imports: { codexHome: string; alias?: string }[] = [];
    const logins = new Rly0AddAccountLogins({
      tempRoot: root,
      coreAvailable: async () => true,
      spawnOfficial: (home) => {
        homes.push(home);
        return official.connection;
      },
      importFrom: async (params) => {
        imports.push(params);
        return { available: true, id: "0123456789ab" };
      },
    });
    const started = await logins.start({ alias: "Work" });
    expect(started).toMatchObject({
      available: true,
      authUrl: "https://auth.example/authorize?x=1",
    });
    if (!started.available) throw new Error("unreachable");
    expect(path.basename(homes[0] ?? "")).toMatch(/^rly0-login-/u);
    expect(official.methods).toEqual(["initialize", "initialized", "account/login/start"]);
    expect(logins.status({ loginId: started.loginId })).toEqual({
      available: true,
      state: "pending",
    });

    official.complete(true);
    await until(() => logins.status({ loginId: started.loginId }).state !== "pending");
    expect(logins.status({ loginId: started.loginId })).toEqual({
      available: true,
      state: "completed",
      id: "0123456789ab",
    });
    expect(imports).toEqual([{ codexHome: homes[0], alias: "Work" }]);
    for (let index = 0; index < 100 && (await readdir(root)).length > 0; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(await readdir(root)).toEqual([]);
  });

  it("cancels the native login and cleans up when the user gives up", async () => {
    const root = await tempRoot();
    const official = fakeOfficial();
    const logins = new Rly0AddAccountLogins({
      tempRoot: root,
      coreAvailable: async () => true,
      spawnOfficial: () => official.connection,
      importFrom: async () => ({ available: true, id: "0123456789ab" }),
    });
    const started = await logins.start({});
    if (!started.available) throw new Error("unreachable");
    expect(await logins.cancel({ loginId: started.loginId })).toEqual({
      available: true,
      cancelled: true,
    });
    expect(official.methods).toContain("account/login/cancel");
    expect(logins.status({ loginId: started.loginId }).state).toBe("cancelled");
    expect(await readdir(root)).toEqual([]);
  });

  it("reports a failed sign-in and never imports", async () => {
    const root = await tempRoot();
    const official = fakeOfficial();
    let imported = false;
    const logins = new Rly0AddAccountLogins({
      tempRoot: root,
      coreAvailable: async () => true,
      spawnOfficial: () => official.connection,
      importFrom: async () => {
        imported = true;
        return { available: true, id: "0123456789ab" };
      },
    });
    const started = await logins.start({});
    if (!started.available) throw new Error("unreachable");
    official.complete(false);
    await until(() => logins.status({ loginId: started.loginId }).state !== "pending");
    expect(logins.status({ loginId: started.loginId })).toEqual({
      available: true,
      state: "failed",
      error: "LOGIN_FAILED",
    });
    expect(imported).toBe(false);
  });

  it("removes the temporary directory when the official login cannot start", async () => {
    const root = await tempRoot();
    const official = fakeOfficial({ failStart: true });
    const logins = new Rly0AddAccountLogins({
      tempRoot: root,
      coreAvailable: async () => true,
      spawnOfficial: () => official.connection,
      importFrom: async () => ({ available: true, id: "0123456789ab" }),
    });
    await expect(logins.start({})).rejects.toThrow("OFFICIAL_REQUEST_FAILED");
    expect(await readdir(root)).toEqual([]);
  });

  it("is unavailable without rly0-core and spawns nothing", async () => {
    let spawned = false;
    const logins = new Rly0AddAccountLogins({
      coreAvailable: async () => false,
      spawnOfficial: () => {
        spawned = true;
        return fakeOfficial().connection;
      },
      importFrom: async () => ({ available: false }),
    });
    expect(await logins.start({})).toEqual({ available: false });
    expect(spawned).toBe(false);
  });
});
