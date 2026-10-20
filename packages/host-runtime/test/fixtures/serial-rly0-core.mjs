// SYNTHETIC: blocking stdio core with shared, disposable account metadata. No credentials/network.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
const state = path.join(process.env.RLY0_SYNTHETIC_DIR, "account.json");
const read = () => JSON.parse(fs.readFileSync(state, "utf8"));
const wait = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 700);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  let result = {};
  if (method === "claude/keyInfo") {
    process.stdout.write("SYNTHETIC_NETWORK_STARTED\n");
    wait();
    result = { kind: "subscription" };
  } else if (method === "claude/rename") {
    process.stdout.write("SYNTHETIC_MUTATION_STARTED\n");
    wait();
    fs.writeFileSync(state, JSON.stringify({ id: params.id, alias: params.alias }));
    process.stdout.write("SYNTHETIC_MUTATION_COMPLETED\n");
    result = { ok: true };
  } else if (method === "claude/list") result = { accounts: [read()] };
  else if (method === "relay/list") result = { relays: [] };
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
});
