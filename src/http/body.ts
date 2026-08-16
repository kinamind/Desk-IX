export async function readBoundedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(request.headers.get("content-length") ?? "0", 10);
  if (Number.isFinite(declared) && declared > maxBytes) throw new BodyTooLargeError(maxBytes);
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("Desk-IX request size limit reached");
        throw new BodyTooLargeError(maxBytes);
      }
      chunks.push(value);
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
  return new TextDecoder().decode(combined);
}

export class BodyTooLargeError extends Error {
  public constructor(public readonly maxBytes: number) {
    super(`Request body exceeds ${maxBytes} bytes`);
    this.name = "BodyTooLargeError";
  }
}
