import type { RuntimeConfig } from "../config";
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
  images: string[];
  truncated: boolean;
}

export interface WebPageFailure {
  requestedUrl: string;
  error: string;
}

export interface WebPageBatch {
  requestedUrls: string[];
  pages: WebPageReading[];
  failures: WebPageFailure[];
}

export function discoverUrls(text: string, limit = Number.POSITIVE_INFINITY): string[] {
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
  config: Pick<RuntimeConfig, "urlFetchTimeoutMs" | "urlMaxTextBytes">,
  fetcher: typeof fetch = fetch,
): Promise<WebPageReading> {
  const page = await fetchPage(rawUrl, {
    timeoutMs: config.urlFetchTimeoutMs,
    maxTextBytes: config.urlMaxTextBytes,
  }, fetcher);
  return {
    requestedUrl: rawUrl,
    finalUrl: page.url,
    title: page.title,
    description: page.description,
    canonicalUrl: page.canonicalUrl,
    source: page.source,
    text: page.text,
    images: page.images,
    truncated: page.truncated,
  };
}

export async function readWebPagesFromText(
  text: string,
  config: Pick<RuntimeConfig, "urlFetchTimeoutMs" | "urlMaxTextBytes">,
  fetcher: typeof fetch = fetch,
  limit = Number.POSITIVE_INFINITY,
): Promise<WebPageBatch> {
  const requestedUrls = discoverUrls(text, Math.max(limit, 1));
  const settled = await Promise.allSettled(requestedUrls.map((url) => readWebPage(url, config, fetcher)));
  const pages: WebPageReading[] = [];
  const failures: WebPageFailure[] = [];
  for (const [index, result] of settled.entries()) {
    const requestedUrl = requestedUrls[index] ?? "";
    if (result.status === "fulfilled") pages.push(result.value);
    else failures.push({
      requestedUrl,
      error: (result.reason instanceof Error ? result.reason.message : String(result.reason)).slice(0, 300),
    });
  }
  return { requestedUrls, pages, failures };
}
