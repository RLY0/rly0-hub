import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { codexPreferences, CodexVersionPreference } from "./codex-check-preferences.js";

interface SkippedVersionRecord {
  schemaVersion: 1;
  original: string | null;
  originalType?: "integer";
  written: string;
  /** Absent in legacy/confirmed records. A pending intent alone does not establish ownership. */
  confirmed?: false;
  /** The native write returned successfully; a later matching read may finish confirmation. */
  writeSucceeded?: true;
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
    readonly preferences: Pick<ReturnType<typeof codexPreferences>, "readScalar" | "write">,
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
      ("confirmed" in value && value.confirmed !== false) ||
      ("writeSucceeded" in value &&
        (value.writeSucceeded !== true || !("confirmed" in value) || value.confirmed !== false)) ||
      ("originalType" in value &&
        (value.originalType !== "integer" ||
          typeof value.original !== "string" ||
          !/^\d+$/u.test(value.original))) ||
      ("previous" in value && !version(value.previous))
    )
      throw new Error("CODEX_PREFERENCES_FAILED");
    return {
      schemaVersion: 1,
      original: value.original,
      written: value.written,
      ...("originalType" in value ? { originalType: "integer" as const } : {}),
      ...("confirmed" in value ? { confirmed: false as const } : {}),
      ...("writeSucceeded" in value ? { writeSucceeded: true as const } : {}),
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
  #owns(record: SkippedVersionRecord, value: CodexVersionPreference | null): boolean {
    return (
      value?.type === "string" &&
      ((record.confirmed !== false && value.value === record.written) ||
        value.value === record.previous)
    );
  }
  #original(record: SkippedVersionRecord): CodexVersionPreference | null {
    return record.original === null
      ? null
      : { value: record.original, type: record.originalType ?? "string" };
  }
  async #current(): Promise<CodexVersionPreference | null> {
    const current = await this.preferences.readScalar("SUSkippedVersion");
    if (current !== null && !version(current.value)) throw new Error("CODEX_PREFERENCES_FAILED");
    return current;
  }
  async #confirm(record: SkippedVersionRecord | null, current: CodexVersionPreference | null) {
    if (
      record?.confirmed === false &&
      record.writeSucceeded === true &&
      current?.type === "string" &&
      current.value === record.written
    ) {
      delete record.confirmed;
      delete record.writeSucceeded;
      delete record.previous;
      await this.#save(record);
    }
  }
  /** Value release would leave behind, excluding only confirmed Hub ownership. */
  async userSkip(): Promise<string | null> {
    const record = await this.#read();
    const current = await this.#current();
    await this.#confirm(record, current);
    const user = record && this.#owns(record, current) ? this.#original(record) : current;
    return user?.value ?? null;
  }
  async unconfirmed(): Promise<boolean> {
    const record = await this.#read();
    if (record?.confirmed !== false || record.writeSucceeded === true) return false;
    const current = await this.#current();
    return current?.type === "string" && current.value === record.written;
  }
  async pending(): Promise<boolean> {
    return (await this.#read()) !== null;
  }
  async hold(build: string): Promise<void> {
    if (!version(build)) throw new Error("CODEX_APPCAST_FAILED");
    const record = await this.#read();
    const current = await this.#current();
    await this.#confirm(record, current);
    if (current?.value === build) return; // A pre-existing user skip is never claimed as Hub-owned.
    const owned = record !== null && this.#owns(record, current);
    // A higher user threshold already suppresses this build; never weaken or claim it.
    if (!owned && current !== null && compareSparkleBuilds(current.value, build) >= 0) return;
    const original = owned ? this.#original(record) : current;
    const next: SkippedVersionRecord = {
      schemaVersion: 1,
      original: original?.value ?? null,
      ...(original?.type === "integer" ? { originalType: "integer" } : {}),
      written: build,
      confirmed: false,
      ...(owned && current !== null ? { previous: current.value } : {}),
    };
    await this.#save(next);
    const before = await this.#current();
    if (before?.value !== current?.value || before?.type !== current?.type)
      throw new Error("CODEX_PREFERENCES_FAILED");
    let writeSucceeded = false;
    try {
      await this.preferences.write("SUSkippedVersion", build);
      writeSucceeded = true;
    } catch {
      // A lost command reply is not proof of failure. Only a successful readback can claim it.
    }
    if (writeSucceeded) {
      next.writeSucceeded = true;
      await this.#save(next);
    }
    const after = await this.#current();
    if (after?.type !== "string" || after.value !== build)
      throw new Error("CODEX_PREFERENCES_FAILED");
    delete next.confirmed;
    delete next.writeSucceeded;
    delete next.previous;
    await this.#save(next);
  }
  async restore(): Promise<void> {
    const record = await this.#read();
    if (!record) return;
    const current = await this.#current();
    await this.#confirm(record, current);
    if (this.#owns(record, current)) {
      await this.preferences.write("SUSkippedVersion", record.original, record.originalType);
      const after = await this.#current();
      const original = this.#original(record);
      if (after?.value !== original?.value || after?.type !== original?.type)
        throw new Error("CODEX_PREFERENCES_FAILED");
    }
    // If the user/Sparkle changed it, preserve that value. A failed write keeps the journal.
    await fs.rm(this.file, { force: true });
  }
}
