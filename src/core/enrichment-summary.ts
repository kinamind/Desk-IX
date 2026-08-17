const ALLOWED_FIELDS = [
  "category",
  "title",
  "summary",
  "organizations",
  "people",
  "topics",
  "key_points",
  "roles",
  "locations",
  "requirements",
  "actions",
  "deadline",
  "application_urls",
  "source_urls",
] as const;

export function summarizeItemEnrichment(enrichment: Record<string, unknown>): Record<string, unknown> | null {
  const summary: Record<string, unknown> = {};
  for (const field of ALLOWED_FIELDS) {
    const value = enrichment[field];
    if (typeof value === "string" && value.trim()) summary[field] = value;
    else if (Array.isArray(value)) {
      const entries = value.filter((entry): entry is string => typeof entry === "string");
      if (entries.length > 0) summary[field] = entries;
    }
  }
  return Object.keys(summary).length > 0 ? summary : null;
}
