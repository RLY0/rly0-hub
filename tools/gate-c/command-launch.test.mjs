import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PiRpcClient } from "./rpc-client.mjs";

const fakePi = path.resolve(import.meta.dirname, "fixtures/fake-pi.mjs");
const temporaryDirectories = [];
const FAKE_PI_NODE = "CODEXHOST_GATE_C_FAKE_PI_NODE";
const FAKE_PI_SCRIPT = "CODEXHOST_GATE_C_FAKE_PI_SCRIPT";
const fakePiEnv = () => ({
  ...process.env,
  [FAKE_PI_NODE]: process.execPath,
  [FAKE_PI_SCRIPT]: fakePi,
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function createPiScript(directory, baseName = "pi") {
  if (process.platform === "win32") {
    // cmd.exe decodes batch text in the OEM code page, so a UTF-8 checkout path such as
    // E:\codex\codex助手插件 would be garbled; environment variables keep the paths Unicode.
    const script = path.join(directory, `${baseName}.cmd`);
    fs.writeFileSync(
      script,
      `@echo off\r\n"%${FAKE_PI_NODE}%" "%${FAKE_PI_SCRIPT}%" %*\r\n`,
      "utf8",
    );
    return script;
  }
  const script = path.join(directory, baseName);
  fs.writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" "${fakePi}" "$@"\n`, "utf8");
  fs.chmodSync(script, 0o755);
  return script;
}

async function expectEcho(options) {
  const rpc = new PiRpcClient({
    commandTimeoutMs: 5_000,
    closeGraceMs: 500,
    forceGraceMs: 2_000,
    ...options,
  });
  await rpc.start();
  const response = await rpc.send({ type: "echo", value: "ok" });
  expect(response.data.echoed).toBe("ok");
  await rpc.close();
  return rpc.commandSource;
}

describe("Gate C process launch forms", () => {
  it("launches an injected direct executable with prefix argv", async () => {
    await expect(expectEcho({ configuredCommand: [process.execPath, fakePi] })).resolves.toBe(
      "configured",
    );
  });

  it("launches PI_COMMAND as a single script path containing spaces", async () => {
    const directory = temporaryDirectory("codexhost gate-c space ");
    const script = createPiScript(directory, "fake pi");
    await expect(expectEcho({ env: { ...fakePiEnv(), PI_COMMAND: script } })).resolves.toBe(
      "environment",
    );
  });

  it("discovers the default pi command through PATH", async () => {
    const directory = temporaryDirectory("codexhost-gate-c-path-");
    createPiScript(directory);
    const env = { ...fakePiEnv(), PI_COMMAND: undefined };
    const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    env[pathKey] = `${directory}${path.delimiter}${env[pathKey] ?? ""}`;
    delete env.PI_COMMAND;
    await expect(expectEcho({ env })).resolves.toBe("path");
  });
});
