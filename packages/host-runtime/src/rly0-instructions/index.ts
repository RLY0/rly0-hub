import { promises as fs } from "node:fs";
import path from "node:path";

import { resolveRly0DataDir } from "../rly0-maintenance/paths.js";
import { backupAndWriteAtomic, resolveCodexHome } from "../rly0-mcp/file-io.js";

/**
 * Global custom instructions for Codex: one block RLY/0 Hub owns inside `~/.codex/AGENTS.md`.
 * Everything outside the block (the person's own rules, other tools' blocks) is kept byte for
 * byte. Each change is previewed first, backed up, and recorded in a short history in RLY/0 Hub's
 * own data directory so it can be rolled back. Project-level AGENTS.md files are never touched.
 */
export const RLY0_INSTRUCTIONS_START = "<!-- RLY0_HUB_INSTRUCTIONS_START -->";
export const RLY0_INSTRUCTIONS_END = "<!-- RLY0_HUB_INSTRUCTIONS_END -->";
const HISTORY_LIMIT = 10;
const MAX_CONTENT = 64 * 1024;

export interface Rly0InstructionTemplate {
  readonly id: string;
  readonly name: string;
  readonly content: string;
}

export const RLY0_INSTRUCTION_TEMPLATES: readonly Rly0InstructionTemplate[] = [
  {
    id: "chinese",
    name: "用中文交流",
    content: "始终用简体中文回答和写说明；代码、命令、文件名和报错原文保持原样。",
  },
  {
    id: "concise",
    name: "简洁直接",
    content: "回答先给结论，再给必要的理由。不重复我说过的话，不写客套话；能用一句说清的不用一段。",
  },
  {
    id: "plan-first",
    name: "先计划再动手",
    content:
      "改动超过一个文件时，先列出要改的文件和步骤，等我确认后再执行。完成后说明改了什么、怎么验证。",
  },
  {
    id: "careful",
    name: "谨慎操作",
    content:
      "删除文件、改全局配置、安装软件、推送代码或做任何难以撤回的操作之前，先停下来问我。不读取或输出任何密钥和账号凭据。",
  },
  {
    id: "tests",
    name: "改代码要验证",
    content: "改完代码后运行相关的测试或检查；没能运行的要明确说出来和原因，不要声称已经通过。",
  },
];

export interface Rly0InstructionHistoryEntry {
  readonly id: string;
  /** Unix seconds. */
  readonly at: number;
  readonly action: "apply" | "clear" | "rollback";
  readonly template?: string;
  readonly preview: string;
}

export interface Rly0InstructionsState {
  readonly filePath: string;
  readonly fileExists: boolean;
  /** The block exists in the file. */
  readonly managed: boolean;
  /** Markers are damaged or repeated: the Hub refuses to write until it is fixed by hand. */
  readonly protected: boolean;
  readonly content: string;
  /** Another tool's block (e.g. AiMaMi) is also present; it is left alone. */
  readonly otherBlocks: readonly string[];
  readonly templates: readonly Rly0InstructionTemplate[];
  readonly history: readonly Rly0InstructionHistoryEntry[];
}

interface Parsed {
  readonly text: string;
  readonly exists: boolean;
  readonly start: number;
  readonly end: number;
  readonly content: string;
  readonly protected: boolean;
}

interface Snapshot extends Rly0InstructionHistoryEntry {
  readonly content: string;
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function normalize(content: string): string {
  return content.replace(/\r\n/gu, "\n").trim();
}

function parse(text: string, exists: boolean): Parsed {
  const starts = count(text, RLY0_INSTRUCTIONS_START);
  const ends = count(text, RLY0_INSTRUCTIONS_END);
  if (starts === 0 && ends === 0) {
    return { text, exists, start: -1, end: -1, content: "", protected: false };
  }
  const start = text.indexOf(RLY0_INSTRUCTIONS_START);
  const endMarker = text.indexOf(RLY0_INSTRUCTIONS_END);
  if (starts !== 1 || ends !== 1 || endMarker < start) {
    return { text, exists, start: -1, end: -1, content: "", protected: true };
  }
  const end = endMarker + RLY0_INSTRUCTIONS_END.length;
  const content = normalize(text.slice(start + RLY0_INSTRUCTIONS_START.length, endMarker));
  return { text, exists, start, end, content, protected: false };
}

function render(content: string): string {
  return `${RLY0_INSTRUCTIONS_START}\n${content}\n${RLY0_INSTRUCTIONS_END}`;
}

function codedError(code: string): Error {
  return Object.assign(new Error(code), { code: -32000 });
}

/** The file with the block set to `content`; an empty `content` removes the block. */
export function composeInstructions(text: string, content: string): string {
  const parsed = parse(text, true);
  if (parsed.protected) throw codedError("INSTRUCTIONS_MARKERS_DAMAGED");
  const next = normalize(content);
  if (parsed.start >= 0) {
    const before = text.slice(0, parsed.start);
    let after = text.slice(parsed.end);
    if (!next) {
      // Drop the block and the line break that followed it.
      after = after.replace(/^\r?\n/u, "");
      const joined = `${before}${after}`;
      return joined.replace(/\n{3,}$/u, "\n\n");
    }
    return `${before}${render(next)}${after}`;
  }
  if (!next) return text;
  const separator =
    text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return `${text}${separator}${render(next)}\n`;
}

const OTHER_BLOCKS: readonly [string, RegExp][] = [["AiMaMi", /AIMAMI_CUSTOM_INSTRUCTIONS_START/u]];

export class Rly0InstructionsManager {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #now: () => number;

  constructor(options: { environment: NodeJS.ProcessEnv; now?: () => number }) {
    this.#environment = options.environment;
    this.#now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  filePath(): string {
    return path.join(resolveCodexHome(this.#environment), "AGENTS.md");
  }

  #historyDir(): string {
    return path.join(resolveRly0DataDir(this.#environment), "instructions-history");
  }

  async #read(): Promise<Parsed> {
    try {
      return parse(await fs.readFile(this.filePath(), "utf8"), true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return parse("", false);
      throw error;
    }
  }

  async #history(): Promise<Snapshot[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.#historyDir());
    } catch {
      return [];
    }
    const snapshots: Snapshot[] = [];
    for (const name of names.filter((n) => /^\d+-[a-z0-9]+\.json$/u.test(n))) {
      try {
        const value = JSON.parse(
          await fs.readFile(path.join(this.#historyDir(), name), "utf8"),
        ) as Snapshot;
        if (typeof value.content === "string" && typeof value.at === "number") {
          snapshots.push({ ...value, id: name.replace(/\.json$/u, "") });
        }
      } catch {
        // A damaged history entry is skipped, never fatal.
      }
    }
    return snapshots.sort((a, b) => b.id.localeCompare(a.id));
  }

  async #record(action: Snapshot["action"], content: string, template?: string): Promise<void> {
    const directory = this.#historyDir();
    await fs.mkdir(directory, { recursive: true });
    const at = this.#now();
    const id = `${String(at).padStart(12, "0")}-${Math.random().toString(36).slice(2, 8)}`;
    const snapshot = {
      at,
      action,
      ...(template ? { template } : {}),
      preview: content.slice(0, 80),
      content,
    };
    await fs.writeFile(path.join(directory, `${id}.json`), `${JSON.stringify(snapshot)}\n`, "utf8");
    const all = await this.#history();
    for (const old of all.slice(HISTORY_LIMIT)) {
      await fs.rm(path.join(directory, `${old.id}.json`), { force: true });
    }
  }

  async state(): Promise<Rly0InstructionsState> {
    const parsed = await this.#read();
    const history = await this.#history();
    return {
      filePath: this.filePath(),
      fileExists: parsed.exists,
      managed: parsed.start >= 0,
      protected: parsed.protected,
      content: parsed.content,
      otherBlocks: OTHER_BLOCKS.filter(([, marker]) => marker.test(parsed.text)).map(
        ([name]) => name,
      ),
      templates: RLY0_INSTRUCTION_TEMPLATES,
      history: history.slice(0, HISTORY_LIMIT).map(({ id, at, action, template, preview }) => ({
        id,
        at,
        action,
        ...(template ? { template } : {}),
        preview,
      })),
    };
  }

  /** What the block holds now and what it would hold; nothing is written. */
  async preview(content: string): Promise<{ current: string; next: string }> {
    if (content.length > MAX_CONTENT) throw codedError("INSTRUCTIONS_TOO_LONG");
    const parsed = await this.#read();
    if (parsed.protected) throw codedError("INSTRUCTIONS_MARKERS_DAMAGED");
    return { current: parsed.content, next: normalize(content) };
  }

  async apply(content: string, template?: string): Promise<Rly0InstructionsState> {
    if (content.length > MAX_CONTENT) throw codedError("INSTRUCTIONS_TOO_LONG");
    if (content.includes(RLY0_INSTRUCTIONS_START) || content.includes(RLY0_INSTRUCTIONS_END)) {
      throw codedError("INSTRUCTIONS_CONTENT_REJECTED");
    }
    await this.#write(content);
    await this.#record(normalize(content) ? "apply" : "clear", normalize(content), template);
    return this.state();
  }

  async clear(): Promise<Rly0InstructionsState> {
    await this.#write("");
    await this.#record("clear", "");
    return this.state();
  }

  async rollback(id: string): Promise<Rly0InstructionsState> {
    const snapshot = (await this.#history()).find((entry) => entry.id === id);
    if (!snapshot) throw codedError("INSTRUCTIONS_HISTORY_NOT_FOUND");
    await this.#write(snapshot.content);
    await this.#record("rollback", snapshot.content, snapshot.template);
    return this.state();
  }

  async #write(content: string): Promise<void> {
    const parsed = await this.#read();
    if (parsed.protected) throw codedError("INSTRUCTIONS_MARKERS_DAMAGED");
    const next = composeInstructions(parsed.text, content);
    if (parse(next, true).content !== normalize(content))
      throw codedError("INSTRUCTIONS_VERIFY_FAILED");
    if (next !== parsed.text) await backupAndWriteAtomic(this.filePath(), next);
  }
}

export function rly0InstructionsRpcError(error: unknown): { code: number; message: string } {
  const message = error instanceof Error ? error.message : "";
  return /^INSTRUCTIONS_[A-Z_]+$/u.test(message)
    ? { code: -32000, message }
    : { code: -32000, message: "INSTRUCTIONS_WRITE_FAILED" };
}
