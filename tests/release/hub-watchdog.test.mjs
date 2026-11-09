import { fork } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runHubDevBuild } from "../../scripts/release/macos/hub-dev-kit.mjs";
import { expect, it } from "vitest";
import {
  auditHubServiceBundle,
  buildHubServiceBundle,
} from "../../packages/host-runtime/scripts/build-hub-service.mjs";

/** Fork the actual bundled runner; no native command driver can be reached. */
export async function smokePackagedWatchdog(directory, root, node = process.execPath) {
  const file = path.join(root, "synthetic-lease.json");
  const harness = path.join(root, "watchdog-harness.mjs");
  await writeFile(
    file,
    JSON.stringify({
      id: "packaged",
      pid: process.pid,
      at: Date.now(),
      checkPreferences: { automaticChecks: false, lastCheckTime: "2026-11-01 00:00:00 +0000" },
    }),
  );
  const moduleUrl = pathToFileURL(path.join(directory, "codex-update-watchdog.js")).href;
  await writeFile(
    harness,
    `
import { runCodexUpdateWatchdog } from ${JSON.stringify(moduleUrl)};
let alive = true, attempts = 0;
process.on('message', () => { alive = false; });
await runCodexUpdateWatchdog(process.argv[2], 'packaged', {
  alive: () => alive,
  disarm: async lease => {
    if (++attempts === 1) throw new Error('synthetic temporary preference failure');
    process.send({ disarmed: true, attempts, checkPreferences: lease.checkPreferences });
  },
  wait: () => new Promise(resolve => setTimeout(resolve, 10)),
  ready: () => process.send({ ready: true }),
});
process.disconnect();
`,
  );
  const messages = [];
  const child = fork(harness, [file], {
    execPath: node,
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      CODEX_HOME: path.join(root, "codex"),
      CODEXHOST_DATA_DIR: root,
      RLY0_SKIP_LEGACY_IMPORT: "1",
      RLY0_CODEX_UPDATE_CONTROL: "0",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("packaged watchdog timed out"));
    }, 10_000);
    child.on("message", (message) => {
      messages.push(message);
      if (message.ready) child.send({ syntheticParentExit: true });
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`packaged watchdog exited ${code}: ${stderr}`));
      else resolve();
    });
  });
  expect(messages).toEqual([
    { ready: true },
    {
      disarmed: true,
      attempts: 2,
      checkPreferences: { automaticChecks: false, lastCheckTime: "2026-11-01 00:00:00 +0000" },
    },
  ]);
  return messages;
}

it("builds audited service payload with a working independent watchdog (synthetic OS driver)", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-hub-watchdog-package-"));
  try {
    const native = process.env.RLY0_WATCHDOG_NATIVE_KIT === "1";
    const kit = path.join(root, "kit");
    const directory = path.join(native ? kit : root, "RLY0 Hub.app/Contents/Resources/app");
    if (native) {
      await runHubDevBuild({
        outputDirectory: kit,
        prepareOnly: false,
        nodePath: process.execPath,
        arch: process.arch,
      });
      expect(
        JSON.parse(await readFile(path.join(kit, "native-build-result.json"), "utf8")),
      ).toMatchObject({
        nativeBuild: "pass",
        adHocSignature: "pass",
        launch: "not_run",
        realAccount: "not_run",
      });
    } else {
      await buildHubServiceBundle({
        repositoryRoot: path.resolve(import.meta.dirname, "../.."),
        outputPath: path.join(directory, "hub-service.mjs"),
        platform: "darwin",
      });
    }
    await auditHubServiceBundle(directory);
    const service = await readFile(path.join(directory, "hub-service.mjs"), "utf8");
    expect(service).toContain("./codex-update-watchdog.js");
    await smokePackagedWatchdog(
      directory,
      root,
      native ? path.join(kit, "RLY0 Hub.app/Contents/Resources/runtime/node") : process.execPath,
    );
    await rm(path.join(directory, "codex-update-watchdog.js"));
    await expect(auditHubServiceBundle(directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
