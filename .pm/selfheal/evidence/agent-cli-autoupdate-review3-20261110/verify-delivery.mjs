// Read-only delivery integrity checks. No CLI installation or Hub listener is involved.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const base = "bc3fd9a1a2ee46484b6fed843adef14a2e9bf28f";
const directory = import.meta.dirname;
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
git("diff", "--check");
git("diff", "--cached", "--check");
git("diff", "--exit-code", base, "--", "apps/hub-desktop/www");
const manifest = JSON.parse(readFileSync(path.join(directory, "source-sha256.json"), "utf8"));
for (const [file, expected] of Object.entries(manifest.files))
  assert.equal(sha256(readFileSync(file)), expected, `Changed after verification: ${file}`);
const input = JSON.parse(readFileSync(path.join(directory, "input.json"), "utf8"));
assert.equal(sha256(readFileSync(path.join(directory, "REVIEW-3.md"))), input.reportSha256);
const resultFile = path.join(directory, "RESULTS.md");
let links = 0;
for (const match of readFileSync(resultFile, "utf8").matchAll(/\]\(([^)]+)\)/g)) {
  if (/^https?:/.test(match[1])) continue;
  assert.ok(existsSync(path.resolve(directory, match[1])), `Missing evidence: ${match[1]}`);
  links++;
}
const lint = JSON.parse(readFileSync(path.join(directory, "preexisting-lint.json"), "utf8"));
assert.equal(lint.baseSha256, lint.currentSha256);
assert.equal(sha256(readFileSync(lint.file)), lint.baseSha256);
const contract = readFileSync(".pm/selfheal/AGENT-CLI-AUTOUPDATE-CONTRACT.md", "utf8");
assert.match(contract, /除 `ROLLBACK_FAILED`、`COMMAND_TREE_STOP_FAILED`、`STATE_WRITE_FAILED` 外/);
assert.match(contract, /## v4/);
const board = JSON.parse(readFileSync(".pm/BOARD.json", "utf8"));
const ticket = board.tickets.find((t) => t.id === "HUB-AGENT-CLI-AUTOUPDATE");
assert.equal(ticket.status, "self_verified");
assert.equal(ticket.accepted, false);
assert.equal(ticket.review_base, base);
console.log(
  JSON.stringify(
    {
      base,
      branch: git("branch", "--show-current"),
      currentHead: git("rev-parse", "HEAD"),
      sourceFilesVerified: Object.keys(manifest.files).length,
      workingTreeSha256: manifest.workingTreeSha256,
      evidenceLinksVerified: links,
      uiDiff: "unchanged from bc3fd9a1",
      inputReport: "SHA-256 matches",
      preexistingLint: "same file SHA-256 as input",
      contractV3AndV4: "verified",
      status: "self_verified; independent review and real-machine acceptance pending",
    },
    null,
    2,
  ),
);
