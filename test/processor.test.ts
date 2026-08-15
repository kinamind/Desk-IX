import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { processIncoming } from "../src/core/processor";
import type { IncomingMessage } from "../src/core/types";
import { getItemBySource } from "../src/db/items";

describe("intent to business operation", () => {
  it("faithfully stores an idea and deduplicates the webhook", async () => {
    const now = new Date("2026-08-15T02:00:00.000Z");
    const incoming: IncomingMessage = {
      channel: "telegram",
      eventId: "update:processor-idea",
      messageId: "101",
      userId: "42",
      text: "想到一个 idea：研究 Agent communication structure 对团队 mind flow 的影响",
      timestamp: now.toISOString(),
      eventType: "message",
      replyToMessageId: "101",
    };
    let sends = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (!url.includes("api.telegram.org")) throw new Error(`Unexpected request: ${url}`);
      sends += 1;
      return Response.json({ ok: true, result: { message_id: 202 } });
    };

    await processIncoming(env, incoming, fetcher, now);
    await processIncoming(env, incoming, fetcher, now);

    const item = await getItemBySource(env.DB, "telegram", incoming.eventId);
    expect(item).toMatchObject({
      type: "idea",
      status: "raw",
      rawMessage: incoming.text,
      content: incoming.text,
      aiEnrichment: {},
    });
    expect(sends).toBe(1);
  });
});
