/**
 * Bounded credential scrubbing for text the Host itself places in a model-visible prompt
 * (shared reference memory, handoff transcripts). It removes well-known token shapes and
 * credential assignment lines; it is a safeguard, not proof that arbitrary text holds no secret.
 */
export function redactCredentialTokens(text: string): string {
  return text
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{12,}|(?:gh[pousr]_|github_pat_|glpat-|xox[baprs]-|AIza|AKIA)[A-Za-z0-9_-]{8,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/gu,
      "[credential removed]",
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/giu, "[credential removed]");
}

const CREDENTIAL_ASSIGNMENT =
  /["']?\b(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*\S/iu;

/** Drops credential-looking assignment lines, then scrubs token shapes. */
export function redactCredentialText(text: string): string {
  return redactCredentialTokens(
    text
      .split(/\r?\n/u)
      .map((line) =>
        CREDENTIAL_ASSIGNMENT.test(line) ? "[credential-bearing line omitted]" : line,
      )
      .join("\n"),
  );
}
