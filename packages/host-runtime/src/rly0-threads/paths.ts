import path from "node:path";

/** Codex writes each session as `rollout-<timestamp>-<id>.jsonl`. */
export const ROLLOUT_FILE_PATTERN = /^rollout-[^/\\\0]+\.jsonl$/u;

export function isRolloutFileName(name: string): boolean {
  return ROLLOUT_FILE_PATTERN.test(name) && path.extname(name) === ".jsonl";
}

/**
 * Resolves `relPath` against `root` and guarantees the result is a rollout file strictly *inside*
 * `root`. The prefix check is separator-aligned (`<root><sep>`), so a sibling such as
 * `sessions-evil/…` can never pass for `sessions/…`. Any violation throws `THREAD_INVALID_PATH`;
 * callers must not swallow it.
 */
export function resolveInsideRoot(root: string, relPath: string): string {
  if (
    typeof relPath !== "string" ||
    relPath.length === 0 ||
    relPath.length > 1024 ||
    relPath.includes("\0") ||
    path.isAbsolute(relPath) ||
    path.win32.isAbsolute(relPath) ||
    path.posix.isAbsolute(relPath)
  ) {
    throw new Error("THREAD_INVALID_PATH");
  }
  const base = path.resolve(root);
  const target = path.resolve(base, relPath);
  if (!isStrictlyInside(base, target)) throw new Error("THREAD_INVALID_PATH");
  if (!isRolloutFileName(path.basename(target))) throw new Error("THREAD_INVALID_PATH");
  return target;
}

/** `true` when `target` is below `base` (never equal to it), aligned on a path separator. */
export function isStrictlyInside(base: string, target: string): boolean {
  const resolvedBase = path.resolve(base);
  const resolvedTarget = path.resolve(target);
  const prefix = resolvedBase.endsWith(path.sep) ? resolvedBase : `${resolvedBase}${path.sep}`;
  if (process.platform === "win32") {
    return resolvedTarget.toLowerCase().startsWith(prefix.toLowerCase());
  }
  return resolvedTarget.startsWith(prefix);
}

/** Converts an absolute path under `root` to the `/`-separated relative form used on the wire. */
export function toRelPath(root: string, absolutePath: string): string {
  return path.relative(path.resolve(root), absolutePath).split(path.sep).join("/");
}
