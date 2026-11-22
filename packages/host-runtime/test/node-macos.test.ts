import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { versionManagerBinaryDirectories } from "@codexhost/harness-discovery";

import type { CommandRunner } from "../src/rly0-agents/agent-installer.js";
import { withAgentInstallPaths } from "../src/rly0-agents/install-paths.js";
import {
  hubNodeRuntimeDirectory,
  installNodeForMac,
  macNodeArch,
  pickNodeLtsTarball,
} from "../src/rly0-agents/node-macos.js";

const VERSION = "v24.11.0";
const DIRECTORY = `node-${VERSION}-darwin-arm64`;
const FILE = `${DIRECTORY}.tar.gz`;
const ARCHIVE = Buffer.from("synthetic node archive");
const INDEX = JSON.stringify([
  { version: "v25.1.0", lts: false, files: ["osx-arm64-tar"] },
  { version: VERSION, lts: "Krypton", files: ["osx-arm64-tar", "osx-x64-tar"] },
]);
const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rly0-node-mac-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Serves `responses` by URL for curl and fakes tar by creating `<dir>/bin/node`. */
function fakeRunner(responses: Record<string, Buffer | string>, calls: string[] = []): CommandRunner {
  return {
    async run(command, args) {
      calls.push(`${path.basename(command)} ${args.at(-1)}`);
      if (command.endsWith("curl")) {
        const url = String(args.at(-1));
        const body = responses[url];
        if (body === undefined) return { code: 22, output: `404 ${url}`, timedOut: false };
        await fs.writeFile(String(args[args.indexOf("-o") + 1]), body);
        return { code: 0, output: "", timedOut: false };
      }
      if (command.endsWith("tar")) {
        const target = String(args[args.indexOf("-C") + 1]);
        await fs.mkdir(path.join(target, DIRECTORY, "bin"), { recursive: true });
        await fs.writeFile(path.join(target, DIRECTORY, "bin", "node"), "");
        return { code: 0, output: "", timedOut: false };
      }
      return { code: 127, output: "unexpected", timedOut: false };
    },
    async openTerminal() {
      return false;
    },
  } as CommandRunner;
}

const files = {
  makeTempDirectory: () => fs.mkdtemp(path.join(root, "tmp-")),
  read: (file: string) => fs.readFile(file),
  remove: (target: string) => fs.rm(target, { recursive: true, force: true }),
};

describe("Node.js for a Mac without it", () => {
  it("picks the newest LTS release that has a tarball for the Mac's architecture", () => {
    expect(pickNodeLtsTarball(JSON.parse(INDEX), "arm64")).toEqual({
      version: VERSION,
      file: FILE,
      directory: DIRECTORY,
    });
    expect(pickNodeLtsTarball([{ version: "v24.0.0", lts: "x", files: ["win-x64-msi"] }], "x64")).toBe(
      null,
    );
    expect(macNodeArch("x64")).toBe("x64");
    expect(macNodeArch("arm64")).toBe("arm64");
  });

  it("installs the checksum-verified release into the Hub's data directory and links it", async () => {
    const environment = { HOME: root, CODEXHOST_DATA_DIR: path.join(root, "data") };
    const source = "https://nodejs.example";
    const outcome = await installNodeForMac({
      runner: fakeRunner({
        [`${source}/index.json`]: INDEX,
        [`${source}/${VERSION}/SHASUMS256.txt`]: `${sha(ARCHIVE)}  ${FILE}\n`,
        [`${source}/${VERSION}/${FILE}`]: ARCHIVE,
      }),
      environment,
      arch: "arm64",
      files,
      log: () => undefined,
      sources: [source],
    });
    const runtime = hubNodeRuntimeDirectory(environment);
    expect(runtime).toBe(path.join(root, "data", "runtime"));
    expect(outcome).toEqual({ ok: true, bin: path.join(runtime, "node", "bin") });
    expect(await fs.readlink(path.join(runtime, "node"))).toBe(DIRECTORY);
    await fs.access(path.join(runtime, "node", "bin", "node"));
    // Temporary downloads are gone.
    expect((await fs.readdir(root)).filter((name) => name.startsWith("tmp-"))).toEqual([]);
  });

  it("discards a download whose checksum does not match and tries the next source", async () => {
    const environment = { HOME: root, CODEXHOST_DATA_DIR: path.join(root, "data") };
    const [bad, good] = ["https://bad.example", "https://good.example"];
    const logs: string[] = [];
    const outcome = await installNodeForMac({
      runner: fakeRunner({
        [`${bad}/index.json`]: INDEX,
        [`${bad}/${VERSION}/SHASUMS256.txt`]: `${sha(ARCHIVE)}  ${FILE}\n`,
        [`${bad}/${VERSION}/${FILE}`]: Buffer.from("tampered"),
        [`${good}/index.json`]: INDEX,
        [`${good}/${VERSION}/SHASUMS256.txt`]: `${sha(ARCHIVE)}  ${FILE}\n`,
        [`${good}/${VERSION}/${FILE}`]: ARCHIVE,
      }),
      environment,
      arch: "arm64",
      files,
      log: (text) => logs.push(text),
      sources: [bad, good],
    });
    expect(outcome.ok).toBe(true);
    expect(logs.join("\n")).toContain("校验失败");
  });

  it("reports a network failure when no source answers, without touching the data directory", async () => {
    const environment = { HOME: root, CODEXHOST_DATA_DIR: path.join(root, "data") };
    const outcome = await installNodeForMac({
      runner: fakeRunner({}),
      environment,
      arch: "arm64",
      files,
      log: () => undefined,
      sources: ["https://offline.example"],
    });
    expect(outcome).toEqual({ ok: false, reason: "NETWORK" });
    await expect(fs.access(path.join(root, "data"))).rejects.toThrow();
  });

  it("is where installers and harness discovery look for node, npm and npm-installed CLIs", () => {
    const environment = { HOME: root, PATH: "/usr/bin:/bin", CODEXHOST_DATA_DIR: path.join(root, "data") };
    const bin = path.join(root, "data", "runtime", "node", "bin");
    const searched = withAgentInstallPaths(environment, "darwin").PATH?.split(":") ?? [];
    expect(searched.at(-1)).toBe(bin);
    expect(searched[0]).toBe("/usr/bin");
    expect(
      versionManagerBinaryDirectories({
        platform: "darwin",
        environment,
        home: root,
        subdirectories: () => [],
      }),
    ).toContain(bin);
  });
});
