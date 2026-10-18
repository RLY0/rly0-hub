import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import type { ClaudeTurnEvent } from "./transport.js";
import type { SpawnOptions } from "@anthropic-ai/claude-agent-sdk";
import type { SandboxSettings } from "@codexhost/shared-contracts";
import {
  guestProjectPath,
  resolveSandboxBinding,
  sandboxEnvironment,
  SANDBOX_GUEST_GUARD,
  verifySandboxBinding,
  runSandboxCommand,
  type SandboxBinding,
} from "@codexhost/sandbox-runtime";

export class ClaudeSandboxExecution {
  readonly binding: SandboxBinding | null;
  constructor(
    readonly environment: NodeJS.ProcessEnv,
    cwd: string,
    settings?: SandboxSettings | null,
  ) {
    // Freeze the route for this SDK process. Changing the UI cannot reroute a live Session.
    this.binding = resolveSandboxBinding(environment, cwd, settings);
  }
  async verify(): Promise<void> {
    if (this.binding) await verifySandboxBinding(this.binding, this.environment);
  }
  get executable(): string | undefined {
    return this.binding?.command;
  }
  projectEvent(event: ClaudeTurnEvent): ClaudeTurnEvent {
    if (!this.binding || event.type !== "tool.completed" || !event.fileChange) return event;
    return {
      ...event,
      fileChange: {
        ...event.fileChange,
        path: sandboxFilePath(event.fileChange.path, this.binding.project.project),
      },
    };
  }
  spawn(options: SpawnOptions): ChildProcessWithoutNullStreams {
    const binding = this.binding;
    if (!binding) throw new Error("ISOLATION_NOT_SELECTED");
    return spawn(
      binding.command,
      [
        "exec",
        "-i",
        "-u",
        "root",
        "-w",
        guestProjectPath(binding.project.project),
        binding.project.name,
        "python3",
        "-c",
        SANDBOX_GUEST_GUARD,
        "/home/agent/.local/bin/claude",
        ...options.args,
      ],
      {
        env: sandboxEnvironment(this.environment, binding.settings),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        signal: options.signal,
      },
    );
  }
}

export function sandboxFilePath(nativePath: string, project: string): string {
  const root = guestProjectPath(project);
  const normalized = path.posix.normalize(nativePath);
  return normalized.startsWith(`${root}/`)
    ? path.win32.join(project, normalized.slice(root.length + 1))
    : nativePath;
}

/** Read only the selected microVM's transcript; never search the Windows Claude directory. */
export async function readSandboxTranscript(
  environment: NodeJS.ProcessEnv,
  settings: SandboxSettings,
  cwd: string,
  sessionId: string,
  subagentId?: string,
): Promise<string | null> {
  if (
    !/^[a-zA-Z0-9-]{1,100}$/u.test(sessionId) ||
    (subagentId && !/^[a-zA-Z0-9_-]{1,100}$/u.test(subagentId))
  )
    throw new Error("ISOLATION_SESSION_INVALID");
  const binding = resolveSandboxBinding(environment, cwd, settings);
  if (!binding) throw new Error("ISOLATION_NOT_SELECTED");
  await verifySandboxBinding(binding, environment);
  const directory = guestProjectPath(binding.project.project).replace(/[^A-Za-z0-9]/gu, "-");
  const code = String.raw`import json, sys
from pathlib import Path
base = Path('/home/agent/.claude/projects') / sys.argv[1]
file = base / (sys.argv[2] + '.jsonl') if len(sys.argv) == 3 else base / sys.argv[2] / 'subagents' / ('agent-' + sys.argv[3] + '.jsonl')
print(json.dumps(file.read_text() if file.is_file() else None))`;
  const output = await runSandboxCommand(environment, settings, [
    "exec",
    "-u",
    "agent",
    binding.project.name,
    "python3",
    "-c",
    code,
    directory,
    sessionId,
    ...(subagentId ? [subagentId] : []),
  ]);
  const parsed: unknown = JSON.parse(output);
  if (parsed !== null && typeof parsed !== "string")
    throw new Error("ISOLATION_TRANSCRIPT_INVALID");
  return parsed;
}
