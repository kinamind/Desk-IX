function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return true;
  const [a = 0, b = 0] = octets;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127)
    || a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!normalized.includes(":")) return false;
  return normalized === "::"
    || normalized === "::1"
    || normalized.startsWith("fe8")
    || normalized.startsWith("fe9")
    || normalized.startsWith("fea")
    || normalized.startsWith("feb")
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("::ffff:127.")
    || normalized.startsWith("::ffff:10.")
    || normalized.startsWith("::ffff:192.168.");
}

export function validatePublicHttpUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("Only HTTP(S) URLs are supported");
  if (url.username || url.password) throw new UnsafeUrlError("URLs with credentials are not supported");
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!hostname
    || hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname.endsWith(".local")
    || hostname.endsWith(".internal")
    || isPrivateIpv4(hostname)
    || isPrivateIpv6(hostname)) {
    throw new UnsafeUrlError("Private or local destinations are blocked");
  }
  return url;
}

export class UnsafeUrlError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}
