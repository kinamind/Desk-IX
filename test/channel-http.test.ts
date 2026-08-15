import { describe, expect, it } from "vitest";
import { fetchWithRetry } from "../src/channels/http";

describe("channel HTTP retry", () => {
  it("does not retry permanent 4xx errors", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response("bad", { status: 400 });
    };
    await expect(fetchWithRetry(fetcher, "https://example.com/send", { method: "POST" })).rejects.toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });

  it("retries 429 and 5xx with a fixed bound", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return calls < 3 ? new Response("retry", { status: calls === 1 ? 429 : 503 }) : new Response("ok");
    };
    await expect(fetchWithRetry(fetcher, "https://example.com/send", { method: "POST" })).resolves.toHaveProperty("status", 200);
    expect(calls).toBe(3);
  });
});
