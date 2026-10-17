/**
 * A relay site's own logo for the Hub's relay cards. Sub2API sites publish theirs at
 * `/api/v1/settings/public` (`site_logo`, a data URI or a URL); otherwise `/favicon.ico` is tried.
 * Only images come back, as a small data URI; nothing else from the site reaches the window.
 */
const TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 256 * 1024;
const MAX_JSON_BYTES = 512 * 1024;
const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon)$/iu;

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

async function limited(response: Response, max: number): Promise<Uint8Array | null> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > max) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  return bytes.byteLength > max ? null : bytes;
}

async function get(fetchImpl: FetchLike, url: string): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    return response.ok ? response : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function imageDataUri(fetchImpl: FetchLike, url: string): Promise<string | null> {
  const response = await get(fetchImpl, url);
  if (!response) return null;
  const type = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
  if (!IMAGE_TYPES.test(type)) return null;
  const bytes = await limited(response, MAX_IMAGE_BYTES);
  if (!bytes || bytes.byteLength === 0) return null;
  return `data:${type.toLowerCase()};base64,${Buffer.from(bytes).toString("base64")}`;
}

function siteOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export async function fetchRelayLogo(
  baseUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ logo: string | null; siteName: string | null }> {
  const origin = siteOrigin(baseUrl);
  if (!origin) return { logo: null, siteName: null };
  // Relays often serve the API on a subdomain (api.example.com); the site lives on the apex.
  const host = new URL(origin).hostname;
  const apex = host.split(".").length > 2 ? `https://${host.split(".").slice(1).join(".")}` : null;
  for (const candidate of apex ? [origin, apex] : [origin]) {
    const response = await get(fetchImpl, `${candidate}/api/v1/settings/public`);
    if (response) {
      const bytes = await limited(response, MAX_JSON_BYTES);
      let body: Record<string, unknown> | null = null;
      try {
        body = bytes
          ? (JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>)
          : null;
      } catch {
        body = null;
      }
      const data = (body?.data ?? body) as Record<string, unknown> | null;
      const logo = typeof data?.site_logo === "string" ? data.site_logo.trim() : "";
      const name = typeof data?.site_name === "string" ? data.site_name.trim().slice(0, 40) : null;
      if (
        /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/u.test(logo) &&
        logo.length < MAX_IMAGE_BYTES * 1.4
      ) {
        return { logo, siteName: name };
      }
      if (logo) {
        try {
          const absolute = new URL(logo, candidate);
          if (absolute.protocol === "https:") {
            const image = await imageDataUri(fetchImpl, absolute.href);
            if (image) return { logo: image, siteName: name };
          }
        } catch {
          // fall through to the favicon
        }
      }
    }
    const favicon = await imageDataUri(fetchImpl, `${candidate}/favicon.ico`);
    if (favicon) return { logo: favicon, siteName: null };
  }
  return { logo: null, siteName: null };
}
