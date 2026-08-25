import { OpenAICompatibleProvider } from "../ai/openai-compatible";
import { getConfig } from "../config";
import type { AgentPrincipal } from "./context";

interface TurnFinalizationInput {
  principal: AgentPrincipal;
  originalText: string | null;
  responseParts: unknown[];
}

const FINALIZER_SYSTEM_PROMPT = `你是 Desk-IX（拾序）的后台回合恢复器。上一个 Agent 回合已经执行了工具，但没有留下事实交接稿。
你只能根据给出的原始请求和真实工具结果，恢复一份自然、准确的中文交接：本轮实际完成了什么、关键时间或风险、哪些地方仍需决定，以及哪些内容已经由 Desk-IX 继续承载。
不要再次规划或调用工具，不要虚构未发生的操作，也不要机械重述无关的历史事项。该交接还会经过独立前台注意力层，不需要为了显得完整而堆砌信息。`;

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
