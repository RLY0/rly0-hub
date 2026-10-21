import { createReadStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createZstdDecompress } from "node:zlib";
import {
  chatHealthPaths,
  configuredProviders,
  readCodexThreads,
  type ChatHealthPaths,
} from "./chat-health.js";
import { writePrivateLocalText } from "./private-quota-cache.js";

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const ROLLOUT = /([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/u;
export const RECOVERY_FOLDER = /^recovery-[A-Za-z0-9]{6}$/u;
const MAX_LINE = 4 * 1024 * 1024;
const MAX_DECODED = 256 * 1024 * 1024;
const MAX_VISIBLE = 8 * 1024 * 1024;
const MAX_JOB_VISIBLE = 64 * 1024 * 1024;
const MAX_JOB_DECODED = 2 * 1024 * 1024 * 1024;
const escape = (text: string) =>
  text.replace(
    /[&<>"']/gu,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );
const page = (title: string, body: string) =>
  `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width"><title>${escape(title)}</title><style>body{font:16px/1.65 system-ui,sans-serif;max-width:1000px;margin:32px auto;padding:0 20px}pre{white-space:pre-wrap;overflow-wrap:anywhere}article{border-top:1px solid #aaa;padding:16px 0}small{color:#555}a{overflow-wrap:anywhere}</style>${body}</html>`;

interface Candidate {
  id: string;
  title: string;
  provider: string;
  archived: boolean;
  file: string;
}
interface DocumentResult {
  html: string;
  messages: number;
  visibleBytes: number;
  partial: boolean;
  metadataMismatch: boolean;
  decodedBytes: number;
  limited: boolean;
}
export interface ChatRecoveryStatus {
  phase: "idle" | "running" | "completed" | "failed";
  total: number;
  processed: number;
  recovered: number;
  partial: number;
  unavailable: number;
  failed: number;
  limited: number;
  scanIncomplete: boolean;
  folder?: string;
  error?: string;
}

/** Bounded name-only discovery; never follows links or scans outside these explicit roots. */
async function filesUnder(
  root: string,
  state: { visited: number; limited: boolean },
  depth = 0,
  into: string[] = [],
): Promise<string[]> {
  if (depth > 8 || into.length >= 10_000 || state.visited >= 20_000) {
    state.limited = true;
    return into;
  }
  const metadata = await fs.lstat(root).catch(() => null);
  if (metadata?.isSymbolicLink()) {
    state.limited = true;
    return into;
  }
  const directory = await fs.opendir(root).catch(() => null);
  if (!directory) return into;
  for await (const entry of directory) {
    if (into.length >= 10_000 || state.visited >= 20_000) {
      state.limited = true;
      break;
    }
    ++state.visited;
    const file = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) await filesUnder(file, state, depth + 1, into);
    else if (entry.isFile() && /\.jsonl(?:\.zst)?$/u.test(entry.name)) into.push(file);
  }
  return into;
}

async function candidates(paths: ChatHealthPaths): Promise<{
  targets: Candidate[];
  unavailable: number;
  limited: number;
  scanIncomplete: boolean;
}> {
  if (!paths.codexStateDir) throw new Error("HISTORY_DATABASE_UNREADABLE");
  const rows = await readCodexThreads(paths.codexStateDir);
  const providers = configuredProviders(paths.codexHome);
  if (!rows || !providers) throw new Error("HISTORY_DATABASE_UNREADABLE");
  const discovery = { visited: 0, limited: false };
  const files = [
    ...(await filesUnder(path.join(paths.codexHome, "sessions"), discovery)),
    ...(await filesUnder(path.join(paths.codexHome, "archived_sessions"), discovery)),
  ];
  const byId = new Map<string, string[]>();
  for (const file of files) {
    const id = ROLLOUT.exec(path.basename(file))?.[1];
    if (!id) continue;
    byId.set(id, [...(byId.get(id) ?? []), file]);
  }
  const known = new Set(rows.map((row) => row.id));
  const result: Candidate[] = [];
  let unavailable = 0;
  let notSearched = 0;
  for (const row of rows) {
    if (!UUID.test(row.id)) continue;
    const choices = byId.get(row.id) ?? [];
    const plain = row.rollout_path.replace(/^\\\\\?\\/u, "");
    const normalize = (file: string) =>
      process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
    const samePath = (file: string) => normalize(file) === normalize(plain);
    const sameReference = (file: string) =>
      samePath(file) ||
      samePath(file.replace(/\.zst$/u, "")) ||
      (plain.endsWith(".zst") && normalize(file) === normalize(plain.slice(0, -4)));
    const file = choices.find(sameReference) ?? (choices.length === 1 ? choices[0] : undefined);
    if (!file) {
      if (discovery.limited) ++notSearched;
      else ++unavailable;
      continue;
    }
    if (!providers.has(row.model_provider) || !sameReference(file))
      result.push({
        id: row.id,
        title: row.title || row.id,
        provider: row.model_provider,
        archived: Boolean(row.archived),
        file,
      });
  }
  for (const [id, choices] of byId) {
    const file = choices[0];
    if (!known.has(id) && choices.length === 1 && file)
      result.push({
        id,
        title: id,
        provider: "未核实",
        archived: file.includes(`${path.sep}archived_sessions${path.sep}`),
        file,
      });
  }
  return {
    targets: result.slice(0, 500),
    unavailable,
    limited: notSearched + Math.max(0, result.length - 500),
    scanIncomplete: discovery.limited,
  };
}

/** Only user/assistant text; no reasoning, tools, credential-store reads or network lookup. */
async function document(
  candidate: Candidate,
  budget: number,
  decodedBudget: number,
  deadline: number,
): Promise<DocumentResult> {
  const input = createReadStream(candidate.file);
  const stream = candidate.file.endsWith(".zst") ? input.pipe(createZstdDecompress()) : input;
  if (stream !== input) input.on("error", (error) => stream.destroy(error));
  const decoder = new StringDecoder("utf8");
  const sections: string[] = [];
  let pending = "",
    discard = false,
    decodedBytes = 0,
    visibleBytes = 0,
    messages = 0;
  let partial = false,
    metadataMismatch = false;
  let limited = false;
  const accept = (line: string) => {
    if (!line.trim()) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      partial = true;
      return;
    }
    if (!raw || typeof raw !== "object") return;
    const value = raw as Record<string, unknown>;
    const payload =
      value.payload && typeof value.payload === "object"
        ? (value.payload as Record<string, unknown>)
        : null;
    if (
      value.type === "session_meta" &&
      typeof payload?.id === "string" &&
      payload.id !== candidate.id
    )
      metadataMismatch = true;
    if (
      value.type !== "response_item" ||
      payload?.type !== "message" ||
      !["user", "assistant"].includes(String(payload.role))
    )
      return;
    if (payload.role === "assistant" && !["commentary", "final"].includes(String(payload.phase))) {
      if (payload.phase !== "analysis") partial = true;
      return;
    }
    const content = payload.content;
    const blocks = Array.isArray(content)
      ? content.flatMap((block: unknown) => {
          if (!block || typeof block !== "object") return [];
          const part = block as Record<string, unknown>;
          if (
            part.type === (payload.role === "user" ? "input_text" : "output_text") &&
            typeof part.text === "string"
          )
            return [part.text];
          partial = true;
          return [];
        })
      : [];
    if (!Array.isArray(content)) partial = true;
    const text = blocks.join("\n");
    if (!text) return;
    const bytes = Buffer.byteLength(text);
    if (visibleBytes + bytes > Math.min(MAX_VISIBLE, budget)) {
      partial = true;
      limited = true;
      return;
    }
    visibleBytes += bytes;
    ++messages;
    sections.push(
      `<article><h2>${payload.role === "user" ? "用户" : "助手"}</h2><pre>${escape(text)}</pre></article>`,
    );
  };
  try {
    for await (const chunk of stream) {
      decodedBytes += chunk.length;
      if (
        decodedBytes > Math.min(MAX_DECODED, decodedBudget) ||
        Date.now() >= deadline ||
        visibleBytes >= Math.min(MAX_VISIBLE, budget)
      ) {
        partial = true;
        limited = true;
        break;
      }
      pending += decoder.write(chunk as Buffer);
      let newline;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!discard && line.length <= MAX_LINE) accept(line);
        else {
          partial = true;
          limited = true;
        }
        discard = false;
      }
      if (pending.length > MAX_LINE) {
        pending = "";
        discard = true;
        partial = true;
        limited = true;
      }
    }
    if (!discard && pending) accept(pending + decoder.end());
  } finally {
    stream.destroy();
    input.destroy();
  }
  const note =
    "这是从本地记录恢复的只读可见文本副本。没有修改原聊天、原归档状态或服务商；尚未恢复原生列表或续聊。隐藏推理和工具内容不导出，附件需回原记录核对。";
  const warnings = `${partial ? "<p>⚠ 内容不完整：遇到格式、附件或大小限制，请保留原文件核对。</p>" : ""}${metadataMismatch ? "<p>⚠ 文件名与内部会话标识不同，可能含继承历史；此副本不证明原会话身份或可续聊。</p>" : ""}`;
  return {
    html: page(
      candidate.title,
      `<p><a href="index.html">返回恢复目录</a></p><h1>${escape(candidate.title)}</h1><p>${escape(note)}</p><small>来源：${escape(candidate.file)}<br>服务商：${escape(candidate.provider)}；${candidate.archived ? "原记录已归档" : "原记录未归档"}</small>${warnings}${sections.join("\n")}`,
    ),
    messages,
    visibleBytes,
    partial,
    metadataMismatch,
    decodedBytes,
    limited,
  };
}

/** Creates local readable copies. It never edits Codex/Claude data or restarts an application. */
export class ChatReadableRecovery {
  readonly #paths: ChatHealthPaths;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #home: string;
  #loaded: Promise<void> | null = null;
  #status: ChatRecoveryStatus = {
    phase: "idle",
    total: 0,
    processed: 0,
    recovered: 0,
    partial: 0,
    unavailable: 0,
    failed: 0,
    limited: 0,
    scanIncomplete: false,
  };
  #pending: Promise<void> | null = null;
  constructor(environment: NodeJS.ProcessEnv, home = os.homedir()) {
    this.#environment = environment;
    this.#home = home;
    this.#paths = chatHealthPaths(environment, home);
  }
  async status(): Promise<ChatRecoveryStatus> {
    await this.#loadLast();
    return { ...this.#status };
  }
  async start(): Promise<ChatRecoveryStatus> {
    await this.#loadLast();
    if (this.#pending) return this.status();
    this.#status = {
      phase: "running",
      total: 0,
      processed: 0,
      recovered: 0,
      partial: 0,
      unavailable: 0,
      failed: 0,
      limited: 0,
      scanIncomplete: false,
    };
    this.#pending = this.#run()
      .catch(() => {
        this.#status = { ...this.#status, phase: "failed", error: "HISTORY_RECOVERY_FAILED" };
      })
      .finally(() => {
        this.#pending = null;
      });
    return this.status();
  }
  async wait(): Promise<ChatRecoveryStatus> {
    await this.#loadLast();
    await this.#pending;
    return this.status();
  }
  async completedIndex(): Promise<string> {
    await this.#loadLast();
    const folder = this.#status.folder;
    if (this.#status.phase !== "completed" || !folder || !RECOVERY_FOLDER.test(folder))
      throw new Error("HISTORY_RECOVERY_NOT_READY");
    const file = path.join(this.#paths.dataDir, "chat-recovery", folder, "index.html");
    const directory = await fs.lstat(path.dirname(file));
    const stat = await fs.lstat(file);
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      !stat.isFile() ||
      stat.isSymbolicLink()
    )
      throw new Error("HISTORY_RECOVERY_NOT_READY");
    return file;
  }
  #loadLast(): Promise<void> {
    this.#loaded ??= (async () => {
      try {
        const text = await fs.readFile(
          path.join(this.#paths.dataDir, "chat-recovery", "latest.json"),
          "utf8",
        );
        if (text.length > 16_384) return;
        const raw = JSON.parse(text) as Record<string, unknown>;
        if (
          !raw ||
          raw.phase !== "completed" ||
          typeof raw.folder !== "string" ||
          !RECOVERY_FOLDER.test(raw.folder)
        )
          return;
        const counts = [
          "total",
          "processed",
          "recovered",
          "partial",
          "unavailable",
          "failed",
        ] as const;
        if (
          counts.some(
            (key) =>
              !Number.isSafeInteger(raw[key]) || Number(raw[key]) < 0 || Number(raw[key]) > 100_000,
          )
        )
          return;
        const directory = path.join(this.#paths.dataDir, "chat-recovery", raw.folder);
        const parent = await fs.lstat(directory),
          index = await fs.lstat(path.join(directory, "index.html"));
        if (
          !parent.isDirectory() ||
          parent.isSymbolicLink() ||
          !index.isFile() ||
          index.isSymbolicLink()
        )
          return;
        this.#status = {
          phase: "completed",
          folder: raw.folder,
          total: Number(raw.total),
          processed: Number(raw.processed),
          recovered: Number(raw.recovered),
          partial: Number(raw.partial),
          unavailable: Number(raw.unavailable),
          failed: Number(raw.failed),
          limited:
            Number.isSafeInteger(raw.limited) && Number(raw.limited) >= 0 ? Number(raw.limited) : 0,
          scanIncomplete: raw.scanIncomplete === true,
        };
      } catch {
        /* Missing or invalid local pointer never grants a file-open path. */
      }
    })();
    return this.#loaded;
  }
  async #run(): Promise<void> {
    const deadline = Date.now() + 120_000;
    const paths = chatHealthPaths(this.#environment, this.#home);
    const plan = await candidates(paths);
    const targets = plan.targets;
    this.#status.total = targets.length;
    this.#status.limited = plan.limited;
    this.#status.scanIncomplete = plan.scanIncomplete;
    this.#status.unavailable = plan.unavailable;
    const base = path.join(paths.dataDir, "chat-recovery");
    await fs.mkdir(base, { recursive: true });
    const directory = await fs.mkdtemp(path.join(base, "recovery-"));
    const folder = path.basename(directory);
    await writePrivateLocalText(
      path.join(directory, "说明.txt"),
      "只读可见文本副本；不是原生列表或续聊修复。保留原文件；不共享此私人目录。\n",
    );
    const entries: {
      id: string;
      title: string;
      file: string;
      messages: number;
      partial: boolean;
      metadataMismatch: boolean;
    }[] = [];
    const failures: { id: string; reason: string }[] = [];
    let remaining = MAX_JOB_VISIBLE;
    let remainingDecoded = MAX_JOB_DECODED;
    for (const target of targets) {
      try {
        if (remaining <= 0 || remainingDecoded <= 0 || Date.now() >= deadline)
          throw new Error("LIMIT_REACHED");
        const decodedBudget = Math.max(
          1,
          Math.floor(remainingDecoded / Math.max(1, targets.length - this.#status.processed)),
        );
        const recovered = await document(target, remaining, decodedBudget, deadline);
        remainingDecoded -= recovered.decodedBytes;
        if (!recovered.messages)
          throw new Error(recovered.limited ? "LIMIT_REACHED" : "NO_VERIFIED_VISIBLE_MESSAGES");
        const name = `${target.id}.html`;
        await writePrivateLocalText(path.join(directory, name), recovered.html);
        remaining -= recovered.visibleBytes;
        entries.push({
          id: target.id,
          title: target.title,
          file: name,
          messages: recovered.messages,
          partial: recovered.partial,
          metadataMismatch: recovered.metadataMismatch,
        });
        ++this.#status.recovered;
        if (recovered.partial) ++this.#status.partial;
      } catch (error) {
        const limited = error instanceof Error && error.message === "LIMIT_REACHED";
        if (limited) ++this.#status.limited;
        else ++this.#status.failed;
        failures.push({
          id: target.id,
          reason: limited ? "LIMIT_REACHED" : "SOURCE_UNREADABLE_OR_UNVERIFIED_FORMAT",
        });
      }
      ++this.#status.processed;
    }
    const manifest = {
      version: 1,
      kind: "readable-copy",
      createdAt: new Date().toISOString(),
      originalDataModified: false,
      nativeResumptionRepaired: false,
      entries,
      failures,
      unavailable: this.#status.unavailable,
      limited: this.#status.limited,
      scanIncomplete: this.#status.scanIncomplete,
    };
    await writePrivateLocalText(
      path.join(directory, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );
    const links = entries
      .map(
        (e) =>
          `<li><a href="${e.file}">${escape(e.title)}</a> · ${e.messages} 条可见消息${e.partial ? " · 部分内容" : ""}${e.metadataMismatch ? " · 会话标识待核对" : ""}</li>`,
      )
      .join("\n");
    await writePrivateLocalText(
      path.join(directory, "index.html"),
      page(
        "找回的可查看历史",
        `<h1>找回的可查看历史</h1><p>已生成 ${entries.length} 份只读副本，${this.#status.partial} 份为部分内容；${this.#status.failed} 份因文件或格式未生成，${this.#status.limited} 份因本次处理限制暂未生成；${this.#status.unavailable} 条未定位到原记录。</p>${this.#status.scanIncomplete ? "<p>本次扫描达到范围上限，未检查全部目录，不能据此判定未扫描的记录缺失。</p>" : ""}<p>未改写原聊天、归档、配置或索引，未恢复原生列表或续聊；之后续聊需要单独选择线路。仅导出明确可见的用户文本和final/commentary助手文本；不明旧格式、隐藏推理和工具内容不导出，附件可能不完整。此目录含私人聊天，请勿公开或上传。</p><ol>${links}</ol>`,
      ),
    );
    const completed: ChatRecoveryStatus = { ...this.#status, phase: "completed", folder };
    await writePrivateLocalText(path.join(base, "latest.json"), JSON.stringify(completed));
    this.#status = completed;
  }
}
