// macOS sandbox profile for the Hub bench service (sandbox-exec, Seatbelt SBPL).
//
// The bench runs the real Hub service next to the user's live Hub, Codex and Core, so the
// profile is a fence around everything the service could reach on this Mac:
// - network: loopback only to the bench's own ports (its Core proxy, synthetic servers), so no
//   live Core proxy, Codex CDP, console-server, ... is reachable; optionally no internet at all;
// - processes: no signals to processes outside the bench, no AppleScript, `open`, `kill`,
//   `launchctl`, `security` or `defaults`;
// - files: no writes to the real home, the external dev volume, /Applications or /Library,
//   and the real Codex / Claude / Hub data and Keychains are not even readable.
// Anything blocked fails loudly (EPERM) inside the service instead of touching real data.
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

/** Ports the Core's local proxy tries in turn (25917 first; shared-contracts rly0-relay). */
export const CORE_PROXY_PORTS = Array.from({ length: 10 }, (_, index) => 25917 + index);

/** TCP ports with a listener on this machine right now (any process of this user or others). */
export function listeningPorts() {
  let output;
  try {
    output = execFileSync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    // lsof exits 1 when nothing listens; anything else must stop the bench.
    if (error && typeof error === "object" && "status" in error && error.status === 1) return [];
    throw error;
  }
  const ports = new Set();
  for (const line of output.split("\n")) {
    const match = /^n.*:(\d+)$/u.exec(line.trim());
    if (match) ports.add(Number(match[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

const quote = (value) => `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** Real-data locations of the user running the bench, resolved through their symlinks. */
export function protectedDataPaths(home = os.homedir(), realpath = (p) => p) {
  const names = [
    ".codex",
    ".claude",
    ".claude.json",
    ".rly0-hub",
    ".codexhost",
    ".ssh",
    ".gitconfig",
    ".config",
    ".gemini",
    ".grok",
    "Library/Keychains",
    "Library/Application Support/RLY0 Hub",
    "Library/Application Support/rly0-hub",
    "Library/Application Support/Codex",
    "Library/Application Support/ChatGPT",
    "Library/Application Support/com.openai.codex",
  ];
  const paths = new Set();
  for (const name of names) {
    const entry = path.join(home, name);
    paths.add(entry);
    try {
      paths.add(realpath(entry));
    } catch {
      // Missing entries need no rule of their own beyond the literal path.
    }
  }
  return [...paths].sort();
}

export const BLOCKED_EXECUTABLES = [
  "/usr/bin/osascript",
  "/usr/bin/open",
  "/usr/bin/pkill",
  "/usr/bin/killall",
  "/bin/kill",
  "/bin/launchctl",
  "/usr/bin/security",
  "/usr/bin/defaults",
  "/sbin/shutdown",
  "/sbin/reboot",
  "/usr/bin/sudo",
];

/**
 * Loopback is an allow-list (`allowPorts`): Seatbelt does not combine "allow localhost:*" with a
 * later "deny localhost:<port>" (the whole of loopback ends up refused), while "deny" followed by
 * "allow localhost:<port>" behaves.
 * @param {{ allowPorts: number[], offline: boolean, writableRoots: string[],
 *   protectedPaths: string[], readOnlyRoots: string[], blockedLaunchers?: string[] }} options
 */
export function buildSandboxProfile({
  allowPorts,
  offline,
  writableRoots,
  protectedPaths,
  readOnlyRoots,
  blockedLaunchers = [],
}) {
  const lines = ["(version 1)", "(allow default)"];
  lines.push(
    offline
      ? '(deny network-outbound (remote ip "*:*"))'
      : '(deny network-outbound (remote ip "localhost:*"))',
  );
  for (const port of allowPorts)
    lines.push(`(allow network-outbound (remote ip "localhost:${port}"))`);
  lines.push("(deny signal (target others))");
  lines.push("(deny appleevent-send)");
  lines.push(
    `(deny process-exec ${BLOCKED_EXECUTABLES.map((p) => `(literal ${quote(p)})`).join(" ")})`,
  );
  // Never start Codex or a codexhost host from the bench (the shell's bin/codexhost may try).
  lines.push(
    `(deny process-exec (subpath "/Applications")${blockedLaunchers.map((p) => ` (literal ${quote(p)})`).join("")})`,
  );
  if (readOnlyRoots.length > 0) {
    lines.push(`(deny file-write* ${readOnlyRoots.map((p) => `(subpath ${quote(p)})`).join(" ")})`);
  }
  if (protectedPaths.length > 0) {
    lines.push(
      `(deny file-read* file-write* ${protectedPaths.map((p) => `(subpath ${quote(p)})`).join(" ")})`,
    );
  }
  if (writableRoots.length > 0) {
    lines.push(
      `(allow file-read* file-write* ${writableRoots.map((p) => `(subpath ${quote(p)})`).join(" ")})`,
    );
  }
  return `${lines.join("\n")}\n`;
}
