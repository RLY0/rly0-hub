import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import type { JsonObject } from "@codexhost/protocol-core";

/**
 * What an External Harness receives for a `turn/start` without any input, which Desktop sends
 * from its continue button after a stopped Turn. Native Codex resumes on its own; a Harness
 * Session only takes a prompt, so it is asked to carry on in the same Session.
 */
export const EXTERNAL_CONTINUE_TEXT = "Continue.";

export interface ExternalTurnInput {
  /** Text the Harness receives. */
  text: string;
  /** False for the continue prompt the person did not type: no user message is projected. */
  visible: boolean;
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Saves an inline `data:` image where a Harness can read it; `null` for anything else. */
async function saveInlineImage(url: string): Promise<string | null> {
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(url);
  const extension = match ? IMAGE_EXTENSIONS[match[1] ?? ""] : undefined;
  if (!match || !extension || !match[2]) return null;
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) return null;
  const directory = join(tmpdir(), "codexhost-attachments");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${randomUUID()}.${extension}`);
  await writeFile(path, bytes);
  return path;
}

interface Attachment {
  path: string;
  image: boolean;
}

/**
 * Harness input is text. Desktop usually serializes attachments into the text already; images,
 * files and mentions that arrive only as separate items are added in that same serialized form,
 * so an image-only message still reaches the Harness.
 */
export async function externalTurnInput(params: JsonObject): Promise<ExternalTurnInput> {
  if (!Array.isArray(params.input)) throw new Error("turn/start input must be an array");
  const items = params.input.filter(isRecord);
  const text = items
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");
  const attachments: Attachment[] = [];
  for (const item of items) {
    if (item.type === "localImage" || item.type === "image") {
      const path =
        typeof item.path === "string" && item.path
          ? item.path
          : typeof item.url === "string"
            ? await saveInlineImage(item.url)
            : null;
      if (path) attachments.push({ path, image: true });
    } else if (item.type === "mention" && typeof item.path === "string" && item.path) {
      attachments.push({ path: item.path, image: false });
    }
  }
  const missing = attachments.filter(
    (attachment, index) =>
      !text.includes(attachment.path) &&
      attachments.findIndex((other) => other.path === attachment.path) === index,
  );
  if (missing.length > 0) {
    const references = missing
      .map(
        ({ path, image }) =>
          `\n## ${basename(path)}: ${path}\n${image ? "Image attachment: true\n" : ""}`,
      )
      .join("");
    return {
      text: `# Files mentioned by the user:\n${references}\n${text.includes("## My request:") ? "" : "## My request:\n"}${text}`,
      visible: true,
    };
  }
  if (!text.trim()) return { text: EXTERNAL_CONTINUE_TEXT, visible: false };
  return { text, visible: true };
}
