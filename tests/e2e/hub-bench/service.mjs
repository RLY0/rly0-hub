// One real Hub service for the bench (macOS): a fresh synthetic HOME, its own throwaway Keychain,
// inside the sandbox profile from sandbox.mjs. It is spawned and spoken to the way the macOS
// shell (apps/hub-desktop/macos/Rly0Hub.swift) does it: `runtime/node app/hub-service.mjs` with
// HOME, USER, PATH, LANG, TMPDIR, RLY0_HUB_INSTALL_ROOT and RLY0_SKIP_LEGACY_IMPORT, and
// newline-delimited JSON on stdin/stdout. Nothing here starts Codex or touches real user data.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import {
  buildSandboxProfile,
  CORE_PROXY_PORTS,
  listeningPorts,
  protectedDataPaths,
} from "./sandbox.mjs";

const SECURITY = "/usr/bin/security";

/** `RLY0 Hub.app/Contents/Resources` of a built app, checked for the pieces the bench needs. */
export function appResources(appPath) {
  const resources = path.join(path.resolve(appPath), "Contents", "Resources");
  for (const relative of ["runtime/node", "app/hub-service.mjs", "app/hub-ui/index.html"]) {
    if (!existsSync(path.join(resources, relative))) {
      throw new Error(`not a built RLY0 Hub.app (missing ${relative}): ${appPath}`);
    }
  }
  return resources;
}

function keychainSearchList() {
  return execFileSync(SECURITY, ["list-keychains", "-d", "user"], { encoding: "utf8" });
}

function createKeychain(file) {
  const before = keychainSearchList();
  // A disposable synthetic password for a throwaway Keychain; never a real one.
  execFileSync(SECURITY, ["create-keychain", "-p", "rly0-hub-bench-synthetic-only", file], {
    stdio: "ignore",
  });
  chmodSync(file, 0o600);
  // No auto-lock: a locked Keychain would put an unlock prompt on the user's screen.
  execFileSync(SECURITY, ["set-keychain-settings", file], { stdio: "ignore" });
  if (keychainSearchList() !== before) {
    throw new Error("creating the bench Keychain changed the user's Keychain search list");
  }
}

function deleteKeychain(file) {
  if (!existsSync(file)) return;
  const before = keychainSearchList();
  execFileSync(SECURITY, ["delete-keychain", file], { stdio: "ignore" });
  if (keychainSearchList() !== before) {
    throw new Error("deleting the bench Keychain changed the user's Keychain search list");
  }
}

/**
 * @param {{ resources: string, offline?: boolean, seed?: (home: string) => void,
 *   extraEnvironment?: Record<string, string>, allowPorts?: number[] }} options
 */
export async function startBenchService({
  resources,
  offline = true,
  seed,
  extraEnvironment = {},
  allowPorts = [],
}) {
  if (process.platform !== "darwin") throw new Error("the Hub bench runs on macOS only");
  const root = realpathSync(mkdtempSync(path.join(realpathSync(os.tmpdir()), "rly0-hub-bench-")));
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const bin = path.join(root, "bin");
  for (const directory of [home, tmp, bin]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (seed) seed(home);
  const keychain = path.join(root, "bench.keychain-db");
  createKeychain(keychain);

  const realHome = os.homedir();
  // Loopback: the bench Core's proxy (a Core port nothing listens on yet) and the test's own
  // synthetic servers; every live service on this Mac stays unreachable.
  const live = new Set(listeningPorts());
  const profile = buildSandboxProfile({
    allowPorts: [...CORE_PROXY_PORTS.filter((port) => !live.has(port)), ...allowPorts],
    offline,
    writableRoots: [root],
    protectedPaths: protectedDataPaths(realHome, (p) => realpathSync(p)),
    readOnlyRoots: [realHome, "/Volumes", "/Applications", "/Library", "/usr/local", "/opt"],
    // The app's codexhost Launcher would attach to (or restart) the user's running Codex.
    blockedLaunchers: [path.join(resources, "bin", "codexhost")],
  });
  const profilePath = path.join(root, "bench.sb");
  writeFileSync(profilePath, profile);

  const environment = {
    HOME: home,
    // Foundation / Security.framework read this instead of the account's home directory.
    CFFIXED_USER_HOME: home,
    USER: os.userInfo().username,
    LOGNAME: os.userInfo().username,
    PATH: `${path.join(resources, "runtime")}:${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    TMPDIR: `${tmp}/`,
    RLY0_HUB_INSTALL_ROOT: resources,
    RLY0_SKIP_LEGACY_IMPORT: "1",
    // Core encrypts into this throwaway Keychain, never the login Keychain.
    RLY0_CORE_KEYCHAIN_PATH: keychain,
    ...extraEnvironment,
  };
  const stderrLog = path.join(root, "service.stderr.log");
  const child = spawn(
    "/usr/bin/sandbox-exec",
    [
      "-f",
      profilePath,
      path.join(resources, "runtime", "node"),
      path.join(resources, "app", "hub-service.mjs"),
    ],
    { cwd: resources, env: environment, stdio: ["pipe", "pipe", "pipe"], detached: true },
  );
  const stderr = createWriteStream(stderrLog);
  child.stderr.pipe(stderr);

  const pending = new Map();
  const listeners = new Set();
  const transcript = [];
  let ready = false;
  let exited = null;
  let readyResolve;
  let readyReject;
  const readyPromise = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    readyReject(new Error(`hub-service exited before ready (${code ?? signal})`));
    for (const [, entry] of pending) entry.reject(new Error("SERVICE_UNAVAILABLE"));
    pending.clear();
  });
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      transcript.push({ at: Date.now(), kind: "garbage", line: line.slice(0, 500) });
      return;
    }
    if (message && message.event === "ready") {
      ready = true;
      readyResolve(message);
    }
    if (message && typeof message.id === "string" && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry.resolve(message);
    }
    for (const listener of [...listeners]) listener(message);
  });

  let sequence = 0;
  /** Sends one request (as the shell would) and resolves with the raw `{id, result|error}`. */
  function send(message, timeoutMs = 120_000) {
    if (exited) return Promise.reject(new Error("SERVICE_UNAVAILABLE"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(message.id);
        reject(new Error(`bench timeout after ${timeoutMs} ms: ${message.method}`));
      }, timeoutMs);
      pending.set(message.id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    });
  }

  /** Direct call for test setup/inspection (ids outside the page's `w<n>` range). */
  async function call(method, params = {}, timeoutMs) {
    const id = `b${++sequence}`;
    const reply = await send({ id, method, params }, timeoutMs);
    if (reply.error) throw new Error(String(reply.error.message || "HUB_ERROR"));
    return reply.result;
  }

  async function stop() {
    if (!exited) {
      child.stdin.end();
      const deadline = Date.now() + 5000;
      while (!exited && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      if (!exited) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // already gone
        }
        await new Promise((r) => setTimeout(r, 1500));
      }
      if (!exited) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
    // Children of the service (Core) live in its process group.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // group already empty
    }
    stderr.end();
    deleteKeychain(keychain);
  }

  function dispose({ keep = false } = {}) {
    if (!keep) rmSync(root, { recursive: true, force: true });
  }

  await Promise.race([
    readyPromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("hub-service not ready after 60 s")), 60_000),
    ),
  ]);
  return {
    root,
    home,
    pid: child.pid,
    stderrLog,
    get ready() {
      return ready;
    },
    get exited() {
      return exited;
    },
    send,
    call,
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    transcript,
    stop,
    dispose,
    fileSize: (file) => (existsSync(file) ? statSync(file).size : 0),
    randomId: () => randomBytes(6).toString("hex"),
  };
}
