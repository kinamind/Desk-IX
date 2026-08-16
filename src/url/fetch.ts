import { validatePublicHttpUrl } from "../security/ssrf";

export interface FetchedPage {
  url: string;
  contentType: string;
  body: string;
  truncated: boolean;
}

export interface UrlFetchOptions {
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
}

export async function fetchPage(
  rawUrl: string,
  options: UrlFetchOptions,
  fetcher: typeof fetch = fetch,
): Promise<FetchedPage> {
  let current = validatePublicHttpUrl(rawUrl);
  const maxRedirects = options.maxRedirects ?? 3;

  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("URL fetch timed out"), options.timeoutMs);
    try {
      const response = await fetcher(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: {
          "Accept": "text/html, text/plain;q=0.9",
          "User-Agent": "Desk-IX/0.1 (+personal agent)",
        },
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new UrlFetchError("Redirect response had no Location header");
        if (redirect === maxRedirects) throw new UrlFetchError("Too many redirects");
        current = validatePublicHttpUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new UrlFetchError(`Upstream returned HTTP ${response.status}`);

      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "text/html" && contentType !== "text/plain" && contentType !== "application/xhtml+xml") {
        throw new UrlFetchError(`Unsupported content type: ${contentType || "unknown"}`);
      }
      const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
      if (Number.isFinite(declared) && declared > options.maxBytes) throw new UrlFetchError("Page exceeds configured size limit");
      const { text, truncated } = await readLimitedText(response.body, options.maxBytes);
      return { url: current.toString(), contentType, body: text, truncated };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new UrlFetchError("URL fetch did not produce a response");
}

async function readLimitedText(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total + value.byteLength > maxBytes) {
        chunks.push(value.slice(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        await reader.cancel("Desk-IX size limit reached");
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(combined), truncated };
}

export class UrlFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UrlFetchError";
  }
}
