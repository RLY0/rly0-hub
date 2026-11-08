import type { UpdateHttpGet } from "./hub-update-net.js";

/**
 * 首页广告栏的福利文案: the promotion banner rly0.com shows on top of its own pages
 * (`promotion_banner_text` in its public settings), so a price change on the site reaches the Hub
 * without a new release. Offline, or while the site has no banner, the page keeps its built-in
 * copy (`FALLBACK_PROMO` in hub-ui/pages/home.js).
 */

export const RLY0_PUBLIC_SETTINGS = "https://rly0.com/api/v1/settings/public";

const MAX_BODY = 512 * 1024;
const MAX_TEXT = 240;
const CACHE_MS = 30 * 60_000;

export interface Rly0Promo {
  /** The banner sentence, or null when the site shows none (or could not be read). */
  readonly text: string | null;
}

/** One line of plain text: no control characters, collapsed spaces, bounded length. */
function clean(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** Reads `promotion_banner_*` out of the site's public settings answer. */
export function parsePromo(body: string): Rly0Promo {
  let data: unknown;
  try {
    data = (JSON.parse(body) as { data?: unknown }).data;
  } catch {
    return { text: null };
  }
  if (!data || typeof data !== "object") return { text: null };
  const settings = data as Record<string, unknown>;
  if (settings.promotion_banner_enabled !== true) return { text: null };
  return { text: clean(settings.promotion_banner_text) };
}

async function readBody(get: UpdateHttpGet): Promise<string> {
  const response = await get(RLY0_PUBLIC_SETTINGS, { accept: "application/json" });
  if (response.status !== 200) {
    response.cancel();
    throw new Error(`HTTP ${response.status}`);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_BODY) {
      response.cancel();
      throw new Error("too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Cached for half an hour; a failed read is not cached, so the next page visit tries again. */
export class Rly0PromoSource {
  #cache: { at: number; promo: Rly0Promo } | null = null;
  #running: Promise<Rly0Promo> | null = null;

  constructor(
    private readonly get: () => Promise<UpdateHttpGet>,
    private readonly now: () => number = Date.now,
  ) {}

  read(): Promise<Rly0Promo> {
    if (this.#cache && this.now() - this.#cache.at < CACHE_MS)
      return Promise.resolve(this.#cache.promo);
    this.#running ??= (async () => {
      try {
        const promo = parsePromo(await readBody(await this.get()));
        this.#cache = { at: this.now(), promo };
        return promo;
      } catch {
        return { text: null };
      } finally {
        this.#running = null;
      }
    })();
    return this.#running;
  }
}
