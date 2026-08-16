import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { adaptChatCompletionTokenParameter } from "../ai/token-parameters";
import { getConfig } from "../config";

export function createComposaModel(env: Env, fetcher?: typeof fetch): LanguageModel {
  const config = getConfig(env);
  const provider = createOpenAICompatible({
    baseURL: config.aiBaseUrl,
    name: "composa-openai-compatible",
    apiKey: env.AI_API_KEY,
    includeUsage: true,
    ...(fetcher ? { fetch: fetcher } : {}),
    transformRequestBody: (request) => adaptChatCompletionTokenParameter(config.aiModel, request),
  });
  return provider.chatModel(config.aiModel);
}
