const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._-]+/gu;
const SK_KEY_PATTERN = /sk-[A-Za-z0-9]{10,}/gu;
/** `"token": "..."`, `token=...`, `api_key: ...`, etc. — redacts the value, keeps the key name. */
const LABELED_SECRET_PATTERN =
  /((?:token|api[_-]?key|secret|password)["']?\s*[:=]\s*["']?)([A-Za-z0-9._-]{6,})/giu;

/**
 * Redacts emails, bearer tokens, `sk-`-prefixed keys, labeled secrets, and every occurrence of the
 * caller's home directory from a single string. Used to sanitize the local diagnostics export
 * before it is written to disk; the export is never uploaded anywhere.
 */
export function sanitizeDiagnosticsText(text: string, homeDir: string | undefined): string {
  let out = text;
  if (homeDir && homeDir.length > 0) {
    const escaped = homeDir.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    out = out.replace(new RegExp(escaped, "gu"), "<home>");
  }
  out = out.replace(EMAIL_PATTERN, "<email>");
  out = out.replace(BEARER_PATTERN, "Bearer <redacted>");
  out = out.replace(SK_KEY_PATTERN, "sk-<redacted>");
  out = out.replace(LABELED_SECRET_PATTERN, (_match, prefix: string) => `${prefix}<redacted>`);
  return out;
}

/** Recursively sanitizes every string leaf of a JSON-shaped value. */
export function sanitizeDiagnosticsValue(value: unknown, homeDir: string | undefined): unknown {
  if (typeof value === "string") return sanitizeDiagnosticsText(value, homeDir);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticsValue(item, homeDir));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = sanitizeDiagnosticsValue(entry, homeDir);
    }
    return out;
  }
  return value;
}
