/**
 * Secret scrubbing for shared memory, applied when a record is written and again when it is read
 * (older records predate newer patterns). Token shapes, private key blocks and URL credentials
 * follow rohitg00/agentmemory `src/functions/privacy.ts` (Apache-2.0, see NOTICE.md); credential
 * assignments keep their key and lose the value; connection strings lose their password.
 * A bounded safeguard: it does not prove a text holds no secret.
 */
const REDACTED = "[已脱敏]";

const TOKEN_SHAPES: readonly RegExp[] = [
  /Bearer\s+[A-Za-z0-9._\-+/=]{12,}/giu,
  /Basic\s+[A-Za-z0-9+/=]{12,}/gu,
  /sk-proj-[A-Za-z0-9\-_]{20,}/gu,
  /sk-ant-[A-Za-z0-9\-_]{20,}/gu,
  /\b(?:sk|pk|rk|ak)-[A-Za-z0-9][A-Za-z0-9\-_]{15,}/gu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bAIza[A-Za-z0-9\-_]{30,}/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
  /\bglpat-[A-Za-z0-9\-_]{20,}/gu,
  /\bdop_v1_[A-Za-z0-9]{64}\b/gu,
  /\bxai-[A-Za-z0-9]{20,}/gu,
];
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/gu;
const PRIVATE_TAG = /<private>[\s\S]*?<\/private>/giu;
/** scheme://user:password@host — keeps the user, drops the password. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"'<>]*):[^\s/?#@"'<>]+@/giu;
/** ADO / ODBC style `Password=...;` inside connection strings. */
const CONNECTION_PASSWORD = /\b((?:password|pwd|accountkey|sharedaccesskey)\s*=\s*)[^;"'\s]+/giu;
/** key = value / key: value / "key": "value" for credential-named keys. */
const ASSIGNMENT =
  /(["']?\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?key|secret[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|password|passwd|credential|authorization|client[_-]?secret)["']?\s*[:=]\s*)(["']?)[^\s"',;]{4,}\2/giu;

export interface RedactionResult {
  readonly text: string;
  readonly redacted: boolean;
}

export function redactMemoryText(input: string): RedactionResult {
  // Token shapes first: "Authorization: Bearer <token>" must lose the token, not the word.
  let text = input.replace(PRIVATE_TAG, REDACTED).replace(PRIVATE_KEY_BLOCK, REDACTED);
  for (const pattern of TOKEN_SHAPES) text = text.replace(pattern, REDACTED);
  text = text
    .replace(URL_CREDENTIALS, `$1:${REDACTED}@`)
    .replace(CONNECTION_PASSWORD, `$1${REDACTED}`)
    .replace(ASSIGNMENT, (match: string, key: string) =>
      match.slice(key.length).includes(REDACTED) ? match : `${key}${REDACTED}`,
    );
  return { text, redacted: text !== input };
}
