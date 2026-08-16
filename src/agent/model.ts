import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { getConfig } from "../config";

export function createComposaModel(env: Env): LanguageModel {
  const config = getConfig(env);
  const provider = createOpenAICompatible({
    baseURL: config.aiBaseUrl,
    name: "composa-openai-compatible",
    apiKey: env.AI_API_KEY,
    includeUsage: true,
  });
  return provider.chatModel(config.aiModel);
}
