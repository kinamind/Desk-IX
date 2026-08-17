import { env } from "cloudflare:workers";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../src/ai/openai-compatible";
import { createComposaModel } from "../src/agent/model";
import { getAIRequests } from "../src/db/ai-usage";
import { testConfig } from "./helpers";

const now = new Date("2026-08-15T02:00:00.000Z");
const request = {
  purpose: "analysis" as const,
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
        choices: [{ message: { content: "ok" } }],
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

  it("treats a zero daily request limit as unlimited", async () => {
    const fetcher: typeof fetch = async () => Response.json({
      model: "test-model",
      choices: [{ message: { content: "ok" } }],
    });
    const provider = new OpenAICompatibleProvider(
      env.DB,
      { ...testConfig(), aiDailyRequestLimit: 0 },
      "key",
      fetcher,
      () => now,
    );

    await expect(provider.generate(request)).resolves.toMatchObject({ text: "ok" });
  });

  it("uses GPT-5-compatible token parameters without forcing temperature", async () => {
    let body: Record<string, unknown> | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return Response.json({
        model: "gpt-5.6-luna",
        choices: [{ message: { content: "ok" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    };
    const config = { ...testConfig(), aiModel: "gpt-5.6-luna" };
    const provider = new OpenAICompatibleProvider(env.DB, config, "key", fetcher, () => now);
    await provider.generate({ ...request, maxTokens: 600 });
    expect(body).toMatchObject({ model: "gpt-5.6-luna", max_completion_tokens: 600 });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("temperature");
  });

  it("falls back when an OpenAI-compatible gateway rejects the modern token field", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      if (bodies.length === 1) return Response.json({ error: { message: "Unsupported parameter: max_completion_tokens" } }, { status: 400 });
      return Response.json({
        model: "gpt-5.6-luna",
        choices: [{ message: { content: "ok" } }],
      });
    };
    const config = { ...testConfig(), aiModel: "gpt-5.6-luna" };
    const provider = new OpenAICompatibleProvider(env.DB, config, "key", fetcher, () => now);
    await expect(provider.generate({ ...request, maxTokens: 600 })).resolves.toMatchObject({ model: "gpt-5.6-luna" });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toHaveProperty("max_tokens", 600);
    expect(bodies[1]).not.toHaveProperty("max_completion_tokens");
  });

  it("calls the Workers fetch function without rebinding its this reference", async () => {
    const fetcher: typeof fetch = function (this: unknown) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Promise.resolve(Response.json({
        model: "test-model",
        choices: [{ message: { content: "ok" } }],
      }));
    };
    const provider = new OpenAICompatibleProvider(env.DB, testConfig(), "key", fetcher, () => now);
    await expect(provider.generate(request)).resolves.toMatchObject({ model: "test-model" });
  });

  it("does not cap daily-plan output and gives it the longer background timeout", async () => {
    let body: Record<string, unknown> | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
      return Response.json({
        model: "gpt-5.6-luna",
        choices: [{ message: { content: "ok" } }],
      });
    };
    const config = {
      ...testConfig(),
      aiModel: "gpt-5.6-luna",
      aiTimeoutMs: 10,
      aiDailyPlanTimeoutMs: 100,
    };
    const provider = new OpenAICompatibleProvider(env.DB, config, "key", fetcher, () => now);

    await expect(provider.generate({ ...request, purpose: "daily_plan" })).resolves.toMatchObject({ text: "ok" });
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });
});

describe("Agent model provider contract", () => {
  it("does not impose a completion-token cap on agent turns", async () => {
    let body: Record<string, unknown> | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return agentModelResponse();
    };

    await generateText({
      model: createComposaModel(agentModelEnv(), fetcher),
      prompt: "hello",
    });

    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("sends max_completion_tokens for GPT-5 through the native agent model", async () => {
    let body: Record<string, unknown> | null = null;
    const fetcher: typeof fetch = async (_input, init) => {
      if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
      body = JSON.parse(init.body) as Record<string, unknown>;
      return agentModelResponse();
    };

    await generateText({
      model: createComposaModel(agentModelEnv(), fetcher),
      prompt: "hello",
      maxOutputTokens: 600,
    });

    expect(body).toMatchObject({ model: "gpt-5.6-luna", max_completion_tokens: 600 });
    expect(body).not.toHaveProperty("max_tokens");
  });
});

function agentModelEnv(): Env {
  return {
    APP_NAME: "Desk-IX",
    APP_LOCALE: "zh-CN",
    TIMEZONE: "Asia/Singapore",
    DAILY_PLAN_TIME: "08:00",
    AI_BASE_URL: "https://gateway.test/v1",
    AI_MODEL: "gpt-5.6-luna",
    AI_EMBEDDING_MODEL: "",
    AI_MAX_TOKENS: "600",
    AI_TIMEOUT_MS: "60000",
    AI_DAILY_PLAN_TIMEOUT_MS: "90000",
    AI_DAILY_REQUEST_LIMIT: "100",
    AI_API_KEY: "test-key",
    URL_FETCH_TIMEOUT_MS: "6000",
    URL_MAX_BYTES: "524288",
    QQ_API_BASE_URL: "https://api.bot.qq.com",
  } as unknown as Env;
}

function agentModelResponse(): Response {
  return Response.json({
    id: "chatcmpl-test",
    created: 1,
    model: "gpt-5.6-luna",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "ok" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
  });
}
