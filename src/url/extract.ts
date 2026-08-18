export interface PageMetadata {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  source: string;
  text: string;
  images: string[];
}

function decodeEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? match;
  });
}

function clean(value: string): string {
  return decodeEntities(value).replace(/\s+/g, " ").trim();
}

function metaContent(html: string, key: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${key}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern)?.[1];
    if (match) return clean(match);
  }
  return null;
}

function imageUrls(html: string, finalUrl: string): string[] {
  const candidates = [
    metaContent(html, "og:image"),
    metaContent(html, "twitter:image"),
    ...Array.from(html.matchAll(/<img\b[^>]+(?:src|data-src)=["']([^"']+)["'][^>]*>/gi), (match) => clean(match[1] ?? "")),
  ].filter((value): value is string => Boolean(value));
  const images: string[] = [];
  for (const candidate of candidates) {
    try {
      const url = new URL(candidate, finalUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (!images.includes(url.toString())) images.push(url.toString());
    } catch {
      // Ignore malformed markup candidates; the page text remains readable.
    }
  }
  return images;
}

export function extractPageMetadata(html: string, finalUrl: string): PageMetadata {
  const title = metaContent(html, "og:title") ?? (clean(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "") || null);
  const description = metaContent(html, "description") ?? metaContent(html, "og:description");
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1]
    ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1]
    ?? null;
  const stripped = html
    .replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ")
    .replace(/<[^>]+>/g, " ");
  return {
    title,
    description,
    canonicalUrl: canonical ? new URL(canonical, finalUrl).toString() : null,
    source: new URL(finalUrl).hostname,
    text: clean(stripped),
    images: imageUrls(html, finalUrl),
  };
}
