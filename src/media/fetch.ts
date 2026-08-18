import { validatePublicHttpUrl } from "../security/ssrf";

export interface FetchedImage {
  finalUrl: string;
  mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" | "image/avif";
  bytes: Uint8Array;
}

export interface ImageFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
  abortSignal?: AbortSignal;
}

export async function fetchPublicImage(
  rawUrl: string,
  options: ImageFetchOptions,
  fetcher: typeof fetch = fetch,
): Promise<FetchedImage> {
  let current = validatePublicHttpUrl(rawUrl);
  const maxRedirects = options.maxRedirects ?? 5;
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Media fetch timed out"), options.timeoutMs);
    try {
      const response = await fetcher(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "Accept": "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8",
          "User-Agent": "Desk-IX/0.1 (+personal agent media reader)",
        },
        signal: options.abortSignal
          ? AbortSignal.any([controller.signal, options.abortSignal])
          : controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new MediaFetchError("Redirect response had no Location header");
        if (redirect === maxRedirects) throw new MediaFetchError("Too many media redirects");
        current = validatePublicHttpUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new MediaFetchError(`Image source returned HTTP ${response.status}`);
      const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        throw new MediaFetchError("Image exceeds the configured provider-safe size");
      }
      const bytes = await readLimitedBytes(response.body, options.maxBytes);
      const mediaType = sniffImageMediaType(bytes);
      if (!mediaType) {
        const declaredType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "unknown";
        throw new MediaFetchError(`Unsupported or invalid image data (${declaredType})`);
      }
      return { finalUrl: current.toString(), mediaType, bytes };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new MediaFetchError("Image fetch did not produce a response");
}

export function sniffImageMediaType(bytes: Uint8Array): FetchedImage["mediaType"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 6) {
    const header = String.fromCharCode(...bytes.slice(0, 6));
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  if (bytes.length >= 12
    && String.fromCharCode(...bytes.slice(4, 8)) === "ftyp"
    && ["avif", "avis"].includes(String.fromCharCode(...bytes.slice(8, 12)))) return "image/avif";
  return null;
}

async function readLimitedBytes(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array> {
  if (!body) throw new MediaFetchError("Image source returned an empty body");
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel("Desk-IX media size limit reached").catch(() => undefined);
        throw new MediaFetchError("Image exceeds the configured provider-safe size");
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new MediaFetchError("Image source returned an empty body");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export class MediaFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "MediaFetchError";
  }
}
