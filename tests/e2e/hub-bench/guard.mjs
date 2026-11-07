// Global setup / teardown of the Hub bench: records the user's live Codex, codexhost, Hub and
// Core processes before the run and fails the run if any of them changed afterwards. This is the
// bench's own proof that it never quit, restarted or replaced anything the user was running.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const WATCHED = [
  /\/ChatGPT\.app\/Contents\/MacOS\/ChatGPT( |$)/u,
  /\/bin\/codexhost launch( |$)/u,
  /\/app\/host-runtime\.mjs( |$)/u,
  /\/app\/desktop-controller\.mjs( |$)/u,
  /\/app\/console-server\.mjs serve( |$)/u,
  /\/RLY0 Hub\.app\/Contents\/MacOS\/rly0-hub( |$)/u,
  /\/rly0-core$/u,
];

export function liveProcesses(ignoreRoots = []) {
  const output = execFileSync("/bin/ps", ["-axo", "pid=,lstart=,args="], { encoding: "utf8" });
  const rows = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/u.exec(line);
    if (!match) continue;
    const [, pid, started, args] = match;
    if (ignoreRoots.some((root) => args.includes(root))) continue;
    if (WATCHED.some((pattern) => pattern.test(args)))
      rows.push({ pid: Number(pid), started, args });
  }
  return rows.sort((a, b) => a.pid - b.pid);
}

function stateFile() {
  const run = process.env.HUB_BENCH_RUN;
  if (!run) throw new Error("HUB_BENCH_RUN is not set");
  mkdirSync(run, { recursive: true });
  return path.join(run, "live-processes.json");
}

export function benchIgnoreRoots() {
  // Processes the bench itself starts run from the app under test and from temp bench roots.
  return [process.env.HUB_BENCH_APP || "\u0000", "/rly0-hub-bench-"];
}

export default function globalSetup() {
  const before = liveProcesses(benchIgnoreRoots());
  writeFileSync(stateFile(), `${JSON.stringify({ before }, null, 2)}\n`);
  return async () => {
    const after = liveProcesses(benchIgnoreRoots());
    const key = (row) => `${row.pid}|${row.started}|${row.args}`;
    const missing = before.filter((row) => !after.some((other) => key(other) === key(row)));
    writeFileSync(stateFile(), `${JSON.stringify({ before, after, missing }, null, 2)}\n`);
    if (missing.length > 0) {
      throw new Error(
        `the bench run ended while these live processes had changed: ${missing
          .map((row) => `${row.pid} ${row.args.slice(0, 120)}`)
          .join("; ")}`,
      );
    }
  };
}

export function readGuardState() {
  return JSON.parse(readFileSync(stateFile(), "utf8"));
}
