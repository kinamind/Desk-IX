export type AIMessageRole = "system" | "user" | "assistant";

export interface AIMessage {
  role: AIMessageRole;
  content: string;
}

export interface AIRequest {
  purpose: "intent" | "reschedule" | "url_enrichment" | "daily_plan" | "analysis" | "query_response";
  messages: AIMessage[];
  maxTokens?: number;
  temperature?: number;
  expectJson?: boolean;
}

export interface AIResponse {
  text: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

export interface AIProvider {
  generate(request: AIRequest): Promise<AIResponse>;
}

export class AIUnavailableError extends Error {
  public constructor(message = "AI provider is not configured or budget is exhausted") {
    super(message);
    this.name = "AIUnavailableError";
  }
}
