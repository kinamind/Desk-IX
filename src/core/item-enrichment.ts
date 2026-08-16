import { z } from "zod";
import type { RuntimeConfig } from "../config";
import { parseAIJson } from "../ai/openai-compatible";
import { RESOURCE_ENRICHMENT_PROMPT } from "../ai/prompts";
import type { AIProvider } from "../ai/provider";
import { log } from "../observability/log";
import { readWebPagesFromText, type WebPageBatch, type WebPageReading } from "../url/reader";
import type { Item } from "./types";

const MAX_SOURCE_URLS = 3;
const MAX_PAGE_TEXT_CHARS = 6_000;

const shortString = z.string().trim().min(1).max(160);
const stringList = z.array(shortString).max(12).optional().nullable();
const modelDossierSchema = z.object({
  category: z.enum(["recruitment", "application", "event", "article", "paper", "documentation", "tool", "product", "resource", "other"]).optional().nullable(),
  title: z.string().trim().min(1).max(100).optional().nullable(),
  summary: z.string().trim().min(1).max(500).optional().nullable(),
  organizations: stringList,
  people: stringList,
  topics: stringList,
  key_points: stringList,
  roles: stringList,
  locations: stringList,
  requirements: stringList,
  actions: stringList,
  deadline: z.string().datetime({ offset: true }).optional().nullable(),
  application_urls: z.array(z.string().url()).max(8).optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional().nullable(),
});

export interface ItemEnrichmentDossier {
  category: "recruitment" | "application" | "event" | "article" | "paper" | "documentation" | "tool" | "product" | "resource" | "other" | null;
  title: string | null;
  summary: string | null;
  organizations: string[];
  people: string[];
  topics: string[];
  key_points: string[];
  roles: string[];
  locations: string[];
  requirements: string[];
  actions: string[];
  deadline: string | null;
  application_urls: string[];
  tags: string[];
  source_urls: string[];
  provider?: "openai-compatible";
  model?: string;
}

export interface WebSourceMetadata {
  requested_url: string;
  final_url?: string;
  canonical_url?: string | null;
  title?: string | null;
  source?: string;
  truncated?: boolean;
  fetch_status: "ok" | "failed";
  error?: string;
}

export interface ItemEnrichmentResult {
  dossier: ItemEnrichmentDossier;
  sources: WebSourceMetadata[];
  primaryUrl: string;
  readableSourceCount: number;
  failedSourceCount: number;
}

const CONTEXT_ARRAY_LIMITS: Record<string, number> = {
  organizations: 6,
  people: 8,
  topics: 8,
  key_points: 8,
  roles: 8,
  locations: 6,
  requirements: 8,
  actions: 8,
  application_urls: 5,
  tags: 8,
  source_urls: 3,
};

export function summarizeItemEnrichment(enrichment: Record<string, unknown>): Record<string, unknown> | null {
  const summary: Record<string, unknown> = {};
  for (const key of ["category", "title", "summary", "deadline"] as const) {
    const value = enrichment[key];
    if (typeof value === "string" && value.trim()) summary[key] = value.trim().slice(0, key === "summary" ? 500 : 160);
  }
  for (const [key, limit] of Object.entries(CONTEXT_ARRAY_LIMITS)) {
    const value = enrichment[key];
    if (!Array.isArray(value)) continue;
    const strings = value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim().slice(0, 240))
      .filter(Boolean)
      .slice(0, limit);
    if (strings.length > 0) summary[key] = strings;
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function collectSourceTextParts(item: Item, message: string): string[] {
  return [
    message,
    item.content,
    item.rawMessage,
    item.url ?? "",
  ];
}

function pageForModel(reading: WebPageReading): Record<string, unknown> {
  return {
    url: reading.finalUrl,
    title: reading.title,
    description: reading.description,
    source: reading.source,
    text: reading.text.slice(0, MAX_PAGE_TEXT_CHARS),
  };
}

function supportedApplicationUrls(values: string[] | null | undefined, pages: WebPageReading[], sourceUrls: string[]): string[] {
  const evidence = `${sourceUrls.join("\n")}\n${pages.map((page) => page.text).join("\n")}`;
  return unique(values ?? []).filter((url) => evidence.includes(url));
}

function normalizeDossier(
  parsed: z.infer<typeof modelDossierSchema> | null,
  pages: WebPageReading[],
  sourceUrls: string[],
  model?: string,
): ItemEnrichmentDossier {
  return {
    category: parsed?.category ?? null,
    title: parsed?.title ?? pages[0]?.title ?? null,
    summary: parsed?.summary ?? pages[0]?.description ?? null,
    organizations: unique(parsed?.organizations ?? []),
    people: unique(parsed?.people ?? []),
    topics: unique(parsed?.topics ?? []),
    key_points: unique(parsed?.key_points ?? []),
    roles: unique(parsed?.roles ?? []),
    locations: unique(parsed?.locations ?? []),
    requirements: unique(parsed?.requirements ?? []),
    actions: unique(parsed?.actions ?? []),
    deadline: parsed?.deadline ? new Date(parsed.deadline).toISOString() : null,
    application_urls: supportedApplicationUrls(parsed?.application_urls, pages, sourceUrls),
    tags: unique(parsed?.tags ?? []),
    source_urls: sourceUrls,
    ...(model ? { provider: "openai-compatible", model } : {}),
  };
}

export async function enrichItemFromUrls(
  item: Item,
  message: string,
  provider: AIProvider | null,
  config: Pick<RuntimeConfig, "urlFetchTimeoutMs" | "urlMaxBytes">,
  fetcher: typeof fetch = fetch,
  observedPages?: WebPageBatch,
): Promise<ItemEnrichmentResult | null> {
  const sourceText = collectSourceTextParts(item, message).join("\n");
  const batch = observedPages ?? await readWebPagesFromText(sourceText, config, fetcher, MAX_SOURCE_URLS);
  const sourceUrls = batch.requestedUrls;
  if (sourceUrls.length === 0) return null;
  const pages = batch.pages;
  const sources: WebSourceMetadata[] = sourceUrls.map((requestedUrl) => {
    const page = pages.find((candidate) => candidate.requestedUrl === requestedUrl);
    if (page) return {
      requested_url: requestedUrl,
      final_url: page.finalUrl,
      canonical_url: page.canonicalUrl,
      title: page.title,
      source: page.source,
      truncated: page.truncated,
      fetch_status: "ok",
    };
    const failure = batch.failures.find((candidate) => candidate.requestedUrl === requestedUrl);
    return { requested_url: requestedUrl, fetch_status: "failed", error: failure?.error ?? "Page could not be read" };
  });

  let parsed: z.infer<typeof modelDossierSchema> | null = null;
  let model: string | undefined;
  if (provider && pages.length > 0) {
    try {
      const response = await provider.generate({
        purpose: "url_enrichment",
        expectJson: true,
        maxTokens: 700,
        messages: [
          { role: "system", content: RESOURCE_ENRICHMENT_PROMPT },
          { role: "user", content: JSON.stringify({ message: message.slice(0, 4_000), pages: pages.map(pageForModel) }) },
        ],
      });
      parsed = modelDossierSchema.parse(parseAIJson(response.text));
      model = response.model;
    } catch (error) {
      log("warn", "item_url_enrichment_failed", {
        itemId: item.id,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }

  return {
    dossier: normalizeDossier(parsed, pages, sourceUrls, model),
    sources,
    primaryUrl: sourceUrls[0] ?? "",
    readableSourceCount: pages.length,
    failedSourceCount: sourceUrls.length - pages.length,
  };
}
