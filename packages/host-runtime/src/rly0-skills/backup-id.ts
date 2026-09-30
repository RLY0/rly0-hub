/** `<name>-<compactTimestamp>` backup directory naming, split unambiguously from the right. */

const TIMESTAMP_PATTERN = /^\d{8}T\d{9}Z$/u;

export function backupTimestamp(date: Date = new Date()): string {
  // "2026-09-30T15:30:00.123Z" -> "20260930T153000123Z" (8 digits, T, 9 digits, Z: fixed length,
  // so it can never be mistaken for the end of a name that happens to end in digits).
  return date.toISOString().replace(/[-:]/gu, "").replace(".", "");
}

export function buildBackupDirName(name: string, date: Date = new Date()): string {
  return `${name}-${backupTimestamp(date)}`;
}

export function parseBackupDirName(dirName: string): { name: string; backedUpAt: string } | null {
  const separator = dirName.lastIndexOf("-");
  if (separator === -1) return null;
  const name = dirName.slice(0, separator);
  const timestamp = dirName.slice(separator + 1);
  if (name.length === 0 || !TIMESTAMP_PATTERN.test(timestamp)) return null;
  const iso = `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(9, 11)}:${timestamp.slice(11, 13)}:${timestamp.slice(13, 15)}.${timestamp.slice(15, 18)}Z`;
  return { name, backedUpAt: iso };
}
