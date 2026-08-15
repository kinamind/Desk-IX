import { z } from "zod";
import type { RuntimeConfig } from "../config";
import { getAIRequests, recordAIUsage } from "../db/ai-usage";
import { localDate } from "../core/time";
import { AIUnavailableError, type AIProvider, type AIRequest, type AIResponse } from "./provider";

const responseSchema = z.object({
  model: z.string().optional(),
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
  usage: z.object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
  }).optional(),
});

export class OpenAICompatibleProvider implements AIProvider {
  public constructor(
    private readonly db: D1Database,
    private readonly config: RuntimeConfig,
    private readonly apiKey: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async generate(request: AIRequest): Promise<AIResponse> {
    if (!this.apiKey.trim()) throw new AIUnavailableError();
    const today = localDate(this.now(), this.config.timezone);
    const used = await getAIRequests(this.db, today, "openai-compatible");
    if (used >= this.config.aiDailyRequestLimit) throw new AIUnavailableError("Daily AI request budget exhausted");

    const body: Record<string, unknown> = {
      model: this.config.aiModel,
      messages: request.messages,
      temperature: request.temperature ?? 0.1,
      max_tokens: Math.min(request.maxTokens ?? this.config.aiMaxTokens, this.config.aiMaxTokens),
    };
    if (request.expectJson) body.response_format = { type: "json_object" };

    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort("AI request timed out"), this.config.aiTimeoutMs);
      try {
        const response = await this.fetcher(`${this.config.aiBaseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          throw new ProviderHttpError(response.status, retryable);
        }
        const payload: unknown = await response.json();
        const parsed = responseSchema.parse(payload);
        const text = parsed.choices[0]?.message.content?.trim();
        if (!text) throw new Error("AI response was empty");
        const result: AIResponse = {
          text,
          model: parsed.model ?? this.config.aiModel,
          inputTokens: parsed.usage?.prompt_tokens ?? 0,
          outputTokens: parsed.usage?.completion_tokens ?? 0,
        };
        await recordAIUsage(this.db, today, "openai-compatible", result.inputTokens, result.outputTokens, this.now());
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        const retryable = error instanceof ProviderHttpError ? error.retryable : error instanceof DOMException && error.name === "AbortError";
        if (!retryable || attempt === 2) throw lastError;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error("AI request failed");
  }
}

class ProviderHttpError extends Error {
  public constructor(public readonly status: number, public readonly retryable: boolean) {
    super(`AI provider returned HTTP ${status}`);
    this.name = "ProviderHttpError";
  }
}

export function parseAIJson(text: string): unknown {
  const stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  return JSON.parse(stripped) as unknown;
}
