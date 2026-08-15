import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { routeMessage } from "../src/ai/intent";
import { OpenAICompatibleProvider } from "../src/ai/openai-compatible";
import type { AIProvider } from "../src/ai/provider";
import { getAIRequests } from "../src/db/ai-usage";
import { testConfig } from "./helpers";

const now = new Date("2026-08-15T02:00:00.000Z");
const request = {
  purpose: "intent" as const,
  messages: [{ role: "user" as const, content: "一条消息" }],
  expectJson: true,
};

describe("OpenAI-compatible provider", () => {
  it("retries transient responses and records bounded usage", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      if (calls === 1) return new Response("temporary", { status: 503 });
      return Response.json({
        model: "test-model",
        choices: [{ message: { content: "{\"intent\":\"help\"}" } }],
        usage: { prompt_tokens: 11, completion_tokens: 3 },
      });
    };
    const provider = new OpenAICompatibleProvider(env.DB, testConfig(), "key", fetcher, () => now);
    await expect(provider.generate(request)).resolves.toMatchObject({ inputTokens: 11, outputTokens: 3 });
    expect(calls).toBe(2);
    await expect(getAIRequests(env.DB, "2026-08-15", "openai-compatible")).resolves.toBe(1);
  });

  it("fails closed when no API key is configured", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response();
    };
    const provider = new OpenAICompatibleProvider(env.DB, testConfig(), "", fetcher, () => now);
    await expect(provider.generate(request)).rejects.toThrow("not configured");
    expect(calls).toBe(0);
  });

  it("falls back to a faithful note if AI routing is unavailable", async () => {
    const unavailable: AIProvider = {
      generate: () => Promise.reject(new Error("provider offline")),
    };
    await expect(routeMessage("一段无法确定类别的随手记录", unavailable, now)).resolves.toMatchObject({
      intent: "create_item",
      type: "note",
      content: "一段无法确定类别的随手记录",
      source: "deterministic",
    });
  });
});
