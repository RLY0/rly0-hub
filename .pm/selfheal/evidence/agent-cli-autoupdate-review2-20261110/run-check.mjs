// Synthetic offline checks: never launch the Hub or install an agent CLI.
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [name, command, ...args] = process.argv.slice(2);
if (!name || !command) throw new Error("Usage: run-check.mjs <name> <command> [args...]");
const directory = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "synthetic-cli-review2-"));
const env = {
  ...process.env,
  HOME: root,
  USERPROFILE: root,
  CODEX_HOME: path.join(root, "codex"),
  CODEXHOST_DATA_DIR: path.join(root, "host"),
  RLY0_MEMORY_DIR: path.join(root, "memory"),
  RLY0_SKIP_LEGACY_IMPORT: "1",
  RLY0_CODEX_UPDATE_CONTROL: "0",
  CLAUDE_CONFIG_DIR: path.join(root, "claude"),
  APPDATA: path.join(root, "appdata"),
  LOCALAPPDATA: path.join(root, "localappdata"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "data"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  npm_config_prefix: path.join(root, "npm-prefix"),
  npm_config_cache: path.join(root, "npm-cache"),
  npm_config_userconfig: path.join(root, "npmrc"),
  npm_config_update_notifier: "false",
};
for (const key of ["HOME", "CODEX_HOME", "CODEXHOST_DATA_DIR", "RLY0_MEMORY_DIR"])
  await mkdir(env[key], { recursive: true });
let output = "";
const started = Date.now();
try {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  const record = {
    name,
    cwd: process.cwd(),
    command: [command, ...args],
    exitCode,
    elapsedMs: Date.now() - started,
    isolation:
      "temporary HOME/USERPROFILE/CODEX_HOME/CODEXHOST_DATA_DIR/RLY0_MEMORY_DIR; RLY0_SKIP_LEGACY_IMPORT=1; temporary npm prefix/cache/config",
    output: output.replaceAll(root, "<isolated-home>"),
  };
  await writeFile(path.join(directory, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
  process.stdout.write(record.output);
  process.stdout.write(`\n${name}: exit ${exitCode}; ${record.elapsedMs}ms\n`);
  process.exitCode = Number(exitCode);
} finally {
  await rm(root, { recursive: true, force: true });
}
