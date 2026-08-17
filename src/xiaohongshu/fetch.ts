import { validatePublicHttpUrl } from "../security/ssrf";
import type { FetchedXiaohongshuPage } from "./types";

export interface XiaohongshuFetchOptions {
  cookie: string;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects?: number;
}

export async function fetchXiaohongshuPage(
  rawUrl: string,
  options: XiaohongshuFetchOptions,
  fetcher: typeof fetch = fetch,
): Promise<FetchedXiaohongshuPage> {
  let current = validateXiaohongshuUrl(rawUrl);
  const maxRedirects = options.maxRedirects ?? 5;
  const cookie = normalizeCookie(options.cookie);
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("Xiaohongshu fetch timed out"), options.timeoutMs);
    try {
      const headers = new Headers({
        "Accept": "text/html,application/xhtml+xml;q=0.9",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.xiaohongshu.com/",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/139.0.0.0 Safari/537.36",
      });
      if (cookie && isAccountCookieHost(current.hostname)) headers.set("Cookie", cookie);
      const response = await fetcher(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers,
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) throw new XiaohongshuFetchError("Redirect response had no Location header");
        if (redirect === maxRedirects) throw new XiaohongshuFetchError("Too many Xiaohongshu redirects");
        current = validateXiaohongshuUrl(new URL(location, current).toString());
        continue;
      }
      if (!response.ok) throw new XiaohongshuFetchError(`Xiaohongshu returned HTTP ${response.status}`);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (contentType !== "text/html" && contentType !== "application/xhtml+xml") {
        throw new XiaohongshuFetchError(`Unsupported Xiaohongshu content type: ${contentType || "unknown"}`);
      }
      const declared = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        throw new XiaohongshuFetchError("Xiaohongshu page exceeds configured size limit");
      }
      const { text, truncated } = await readLimitedText(response.body, options.maxBytes);
      return { url: current.toString(), body: text, truncated };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new XiaohongshuFetchError("Xiaohongshu fetch did not produce a response");
}

export function isXiaohongshuUrl(rawUrl: string): boolean {
  try {
    validateXiaohongshuUrl(rawUrl);
    return true;
  } catch {
    return false;
  }
}

function validateXiaohongshuUrl(rawUrl: string): URL {
  const url = validatePublicHttpUrl(rawUrl);
  if (url.protocol !== "https:") throw new XiaohongshuFetchError("Xiaohongshu URLs must use HTTPS");
  const hostname = normalizedHostname(url.hostname);
  if (!isAccountCookieHost(hostname) && hostname !== "xhslink.com" && !hostname.endsWith(".xhslink.com")) {
    throw new XiaohongshuFetchError("Only Xiaohongshu share URLs are supported");
  }
  return url;
}

function isAccountCookieHost(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);
  return normalized === "xiaohongshu.com" || normalized.endsWith(".xiaohongshu.com");
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

function normalizeCookie(cookie: string): string {
  const normalized = cookie.trim();
  if (/\r|\n/.test(normalized)) throw new XiaohongshuFetchError("Invalid Xiaohongshu session cookie");
  return normalized;
}

async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) chunks.push(value.slice(0, remaining));
        total += Math.max(remaining, 0);
        truncated = true;
        await reader.cancel("Desk-IX Xiaohongshu size limit reached");
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

export class XiaohongshuFetchError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "XiaohongshuFetchError";
  }
}
