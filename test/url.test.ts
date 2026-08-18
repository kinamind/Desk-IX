import { describe, expect, it } from "vitest";
import { validatePublicHttpUrl } from "../src/security/ssrf";
import { extractPageMetadata } from "../src/url/extract";
import { fetchPage } from "../src/url/fetch";
import { discoverUrls, readWebPage } from "../src/url/reader";

describe("URL safety and extraction", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://10.0.0.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://service.internal/",
    "file:///etc/passwd",
    "https://user:pass@example.com/",
  ])("blocks %s", (url) => {
    expect(() => validatePublicHttpUrl(url)).toThrow();
  });

  it("accepts public HTTP URLs", () => {
    expect(validatePublicHttpUrl("https://example.com/a").hostname).toBe("example.com");
  });

  it("extracts metadata and strips executable content", () => {
    const metadata = extractPageMetadata(`
      <html><head><title>Fallback</title><meta property="og:title" content="A &amp; B">
      <meta name="description" content="Useful page"><meta property="og:image" content="/cover.jpg">
      <link rel="canonical" href="/canonical"></head>
      <body>Hello <img src="https://cdn.example/detail.png"><script>steal()</script> world</body></html>
    `, "https://example.com/path");
    expect(metadata).toMatchObject({
      title: "A & B",
      description: "Useful page",
      canonicalUrl: "https://example.com/canonical",
      source: "example.com",
      images: ["https://example.com/cover.jpg", "https://cdn.example/detail.png"],
    });
    expect(metadata.text).toContain("Hello world");
    expect(metadata.text).not.toContain("steal");
  });

  it("validates redirects and truncates oversized streams", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      if (url === "https://example.com/start") {
        return new Response(null, { status: 302, headers: { location: "/final" } });
      }
      return new Response("abcdefghij", { headers: { "content-type": "text/html" } });
    };
    await expect(fetchPage("https://example.com/start", { timeoutMs: 1_000, maxBytes: 5 }, fetcher)).resolves.toEqual({
      url: "https://example.com/final",
      contentType: "text/html",
      body: "abcde",
      truncated: true,
    });
    expect(calls).toEqual(["https://example.com/start", "https://example.com/final"]);
  });

  it("blocks redirects to private destinations", async () => {
    const fetcher: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } });
    await expect(fetchPage("https://example.com", { timeoutMs: 1_000, maxBytes: 1_000 }, fetcher)).rejects.toThrow("Private");
  });

  it("discovers card links and returns a bounded readable webpage", async () => {
    expect(discoverUrls("分享卡片 https://example.com/post?id=1 ，备用 https://example.org/")).toEqual([
      "https://example.com/post?id=1",
      "https://example.org/",
    ]);
    const fetcher: typeof fetch = async () => new Response(
      "<html><head><title>招聘信息</title></head><body><main>招募研究助理，周五截止。</main></body></html>",
      { headers: { "content-type": "text/html" } },
    );
    const reading = await readWebPage("https://example.com/post", { urlFetchTimeoutMs: 1_000, urlMaxBytes: 20_000 }, fetcher);
    expect(reading).toMatchObject({
      title: "招聘信息",
      source: "example.com",
      truncated: false,
    });
    expect(reading.text).toContain("招募研究助理");
  });
});
