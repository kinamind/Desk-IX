export async function fetchWithRetry(
  fetcher: typeof fetch,
  input: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetcher(input, init);
      if (response.ok) return response;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === attempts - 1) {
        throw new ChannelHttpError(response.status, input);
      }
      lastError = new ChannelHttpError(response.status, input);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (lastError instanceof ChannelHttpError && lastError.status !== 429 && lastError.status < 500) {
        throw lastError;
      }
      if (attempt === attempts - 1) throw lastError;
    }
  }
  throw lastError ?? new Error("Channel request failed");
}

export class ChannelHttpError extends Error {
  public constructor(public readonly status: number, url: string) {
    super(`Channel API returned HTTP ${status} for ${new URL(url).pathname}`);
    this.name = "ChannelHttpError";
  }
}
