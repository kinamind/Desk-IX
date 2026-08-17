import { OpenAICompatibleProvider } from "../ai/openai-compatible";
import { getConfig } from "../config";
import type { AgentPrincipal } from "./context";

interface TurnFinalizationInput {
  principal: AgentPrincipal;
  originalText: string | null;
  responseParts: unknown[];
}

const FINALIZER_SYSTEM_PROMPT = `你是 Desk-IX（拾序）的回复收尾器。上一个 Agent 回合已经执行了工具，但没有留下用户可见文本。
你只能根据给出的原始请求和真实工具结果，生成一条自然、简洁、准确的中文回复：说明实际完成了什么、关键时间安排和可以修改的地方。
不要再次规划或调用工具，不要虚构未发生的操作，也不要说“没有擅自操作”。`;

export async function synthesizeTurnReply(
  env: Env,
  input: TurnFinalizationInput,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  const config = getConfig(env);
  const provider = new OpenAICompatibleProvider(env.DB, config, env.AI_API_KEY, fetcher);
  const response = await provider.generate({
    purpose: "analysis",
    messages: [
      { role: "system", content: FINALIZER_SYSTEM_PROMPT },
      {
        role: "user",
        content: JSON.stringify({
          channel: input.principal.channel,
          originalRequest: input.originalText,
          completedTurnParts: input.responseParts,
        }),
      },
    ],
  });
  return response.text;
}
