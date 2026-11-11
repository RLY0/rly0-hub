import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { codexPreferences } from "./codex-check-preferences.js";

interface SkippedVersionRecord {
  schemaVersion: 1;
  original: string | null;
  written: string;
  /** Previous owned value during a durable, interrupted replacement. */
  previous?: string;
}
const version = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 100 && /^\d+(?:\.\d+)*$/u.test(value);

/** Sparkle build identifiers can be a single integer; Desktop short-version comparison cannot. */
export function compareSparkleBuilds(a: string, b: string): number {
  if (!version(a) || !version(b)) throw new Error("CODEX_APPCAST_FAILED");
  const left = a.split(".").map(BigInt);
  const right = b.split(".").map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? 0n;
    const y = right[i] ?? 0n;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** A scalar Sparkle build threshold, never the user's major skips or Codex's seen-update array. */
export class CodexSkippedVersion {
  readonly file: string;
  constructor(
    directory: string,
    readonly preferences: Pick<ReturnType<typeof codexPreferences>, "readString" | "write">,
  ) {
    this.file = path.join(directory, "codex-update-skipped-version.json");
  }
  async #read(): Promise<SkippedVersionRecord | null> {
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (bytes.length > 4096) throw new Error("CODEX_PREFERENCES_FAILED");
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("schemaVersion" in value) ||
      value.schemaVersion !== 1 ||
      !("original" in value) ||
      !(value.original === null || version(value.original)) ||
      !("written" in value) ||
      !version(value.written) ||
      ("previous" in value && !version(value.previous))
    )
      throw new Error("CODEX_PREFERENCES_FAILED");
    return {
      schemaVersion: 1,
      original: value.original,
      written: value.written,
      ...("previous" in value ? { previous: value.previous as string } : {}),
    };
  }
  async #save(record: SkippedVersionRecord) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
      await fs.rename(temporary, this.file);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
  #owns(record: SkippedVersionRecord, value: string | null): boolean {
    return value !== null && (value === record.written || value === record.previous);
  }
  async pending(): Promise<boolean> {
    return (await this.#read()) !== null;
  }
  async hold(build: string): Promise<void> {
    if (!version(build)) throw new Error("CODEX_APPCAST_FAILED");
    const record = await this.#read();
    const current = await this.preferences.readString("SUSkippedVersion");
    if (current !== null && !version(current)) throw new Error("CODEX_PREFERENCES_FAILED");
    if (current === build) return; // A pre-existing user skip is never claimed as Hub-owned.
    const owned = record !== null && this.#owns(record, current);
    // A higher user threshold already suppresses this build; never weaken or claim it.
    if (!owned && current !== null && compareSparkleBuilds(current, build) >= 0) return;
    const next: SkippedVersionRecord = {
      schemaVersion: 1,
      original: owned ? record.original : current,
      written: build,
      ...(owned && current !== null ? { previous: current } : {}),
    };
    await this.#save(next); // Original + both possible owned values precede the native write.
    if ((await this.preferences.readString("SUSkippedVersion")) !== current)
      throw new Error("CODEX_PREFERENCES_FAILED");
    await this.preferences.write("SUSkippedVersion", build);
    if ((await this.preferences.readString("SUSkippedVersion")) !== build)
      throw new Error("CODEX_PREFERENCES_FAILED");
    await this.#save({ schemaVersion: 1, original: next.original, written: build });
  }
  async restore(): Promise<void> {
    const record = await this.#read();
    if (!record) return;
    const current = await this.preferences.readString("SUSkippedVersion");
    if (this.#owns(record, current)) {
      await this.preferences.write("SUSkippedVersion", record.original);
      if ((await this.preferences.readString("SUSkippedVersion")) !== record.original)
        throw new Error("CODEX_PREFERENCES_FAILED");
    }
    // If the user/Sparkle changed it, preserve that value. A failed write keeps the journal.
    await fs.rm(this.file, { force: true });
  }
}
