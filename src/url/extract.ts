export interface PageMetadata {
  title: string | null;
  description: string | null;
  canonicalUrl: string | null;
  source: string;
  text: string;
  images: string[];
}

export interface StreamedPageMetadata extends PageMetadata {
  truncated: boolean;
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
  return normalizeWhitespace(decodeEntities(value));
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

class VisibleTextCollector {
  private readonly encoder = new TextEncoder();
  private readonly parts: string[] = [];
  private usedBytes = 0;
  public truncated = false;

  public constructor(private readonly maxBytes: number) {}

  public append(value: string): void {
    if (!value || this.truncated) return;
    const encoded = this.encoder.encode(value);
    const remaining = this.maxBytes - this.usedBytes;
    if (encoded.byteLength <= remaining) {
      this.parts.push(value);
      this.usedBytes += encoded.byteLength;
      return;
    }
    if (remaining > 0) {
      const prefix = new TextDecoder().decode(encoded.slice(0, remaining)).replace(/\uFFFD$/, "");
      if (prefix) {
        this.parts.push(prefix);
        this.usedBytes += this.encoder.encode(prefix).byteLength;
      }
    }
    this.truncated = true;
  }

  public text(): string {
    return clean(this.parts.join(""));
  }
}

export async function extractPageMetadataFromResponse(
  response: Response,
  finalUrl: string,
  maxTextBytes: number,
): Promise<StreamedPageMetadata> {
  const visibleText = new VisibleTextCollector(maxTextBytes);
  const titleParts: string[] = [];
  let openGraphTitle: string | null = null;
  let description: string | null = null;
  let openGraphDescription: string | null = null;
  let canonical: string | null = null;
  let openGraphImage: string | null = null;
  let twitterImage: string | null = null;
  const images: string[] = [];

  const withoutNoise = new HTMLRewriter()
    .on("script, style, noscript, svg, iframe, template", {
      element(element) {
        element.remove();
      },
    })
    .transform(response);

  const analyzed = new HTMLRewriter()
    .on("title", {
      text(chunk) {
        titleParts.push(chunk.text);
      },
    })
    .on('meta[property="og:title"]', {
      element(element) {
        openGraphTitle = firstNonBlank(openGraphTitle, element.getAttribute("content"));
      },
    })
    .on('meta[name="description"]', {
      element(element) {
        description = firstNonBlank(description, element.getAttribute("content"));
      },
    })
    .on('meta[property="og:description"]', {
      element(element) {
        openGraphDescription = firstNonBlank(openGraphDescription, element.getAttribute("content"));
      },
    })
    .on('link[rel~="canonical"]', {
      element(element) {
        canonical = firstNonBlank(canonical, element.getAttribute("href"));
      },
    })
    .on('meta[property="og:image"]', {
      element(element) {
        openGraphImage = firstNonBlank(openGraphImage, element.getAttribute("content"));
      },
    })
    .on('meta[property="twitter:image"], meta[name="twitter:image"]', {
      element(element) {
        twitterImage = firstNonBlank(twitterImage, element.getAttribute("content"));
      },
    })
    .on("img", {
      element(element) {
        addImage(images, element.getAttribute("data-src") ?? element.getAttribute("src"), finalUrl);
      },
    })
    .on("body", {
      text(chunk) {
        visibleText.append(chunk.text);
      },
    })
    .on("body address, body article, body aside, body blockquote, body div, body footer, body h1, body h2, body h3, body h4, body h5, body h6, body header, body li, body main, body nav, body ol, body p, body pre, body section, body table, body tr, body ul", {
      element(element) {
        visibleText.append(" ");
        element.onEndTag(() => visibleText.append(" "));
      },
    })
    .on("body br, body hr", {
      element() {
        visibleText.append(" ");
      },
    })
    .transform(withoutNoise);

  await drainStream(analyzed.body, () => visibleText.truncated);
  addImage(images, twitterImage, finalUrl, true);
  addImage(images, openGraphImage, finalUrl, true);

  return {
    title: clean(openGraphTitle ?? titleParts.join("")) || null,
    description: clean(description ?? openGraphDescription ?? "") || null,
    canonicalUrl: resolvePublicPageUrl(canonical, finalUrl),
    source: new URL(finalUrl).hostname,
    text: visibleText.text(),
    images,
    truncated: visibleText.truncated,
  };
}

function firstNonBlank(current: string | null, candidate: string | null): string | null {
  if (current) return current;
  return candidate?.trim() ? candidate : null;
}

async function drainStream(
  stream: ReadableStream<Uint8Array> | null,
  shouldStop: () => boolean,
): Promise<void> {
  if (!stream) return;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
      if (shouldStop()) {
        await reader.cancel("Visible text safety boundary reached");
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function resolvePublicPageUrl(candidate: string | null, finalUrl: string): string | null {
  if (!candidate) return null;
  try {
    const resolved = new URL(candidate, finalUrl);
    return resolved.protocol === "http:" || resolved.protocol === "https:" ? resolved.toString() : null;
  } catch {
    return null;
  }
}

function addImage(images: string[], candidate: string | null, finalUrl: string, prepend = false): void {
  const resolved = resolvePublicPageUrl(candidate, finalUrl);
  if (!resolved || images.includes(resolved)) return;
  if (prepend) images.unshift(resolved);
  else images.push(resolved);
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
