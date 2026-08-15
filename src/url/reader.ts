import type { RuntimeConfig } from "../config";
import { extractPageMetadata, type PageMetadata } from "./extract";
import { fetchPage } from "./fetch";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/gi;

export interface WebPageReading {
  requestedUrl: string;
  finalUrl: string;
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  source: string;
  text: string;
  truncated: boolean;
}

export function discoverUrls(text: string, limit = 5): string[] {
  const urls: string[] = [];
  for (const match of text.matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[),.;，。；\]}]+$/, "");
    if (!urls.includes(url)) urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

export async function readWebPage(
  rawUrl: string,
  config: Pick<RuntimeConfig, "urlFetchTimeoutMs" | "urlMaxBytes">,
  fetcher: typeof fetch = fetch,
): Promise<WebPageReading> {
  const page = await fetchPage(rawUrl, { timeoutMs: config.urlFetchTimeoutMs, maxBytes: config.urlMaxBytes }, fetcher);
  const metadata: PageMetadata = extractPageMetadata(page.body, page.url);
  return {
    requestedUrl: rawUrl,
    finalUrl: page.url,
    title: metadata.title,
    description: metadata.description,
    canonicalUrl: metadata.canonicalUrl,
    source: metadata.source,
    text: metadata.text,
    truncated: page.truncated,
  };
}
