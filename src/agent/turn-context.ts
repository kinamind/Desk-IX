import { searchOwnedItemsNatural } from "../db/items";
import type { AgentPrincipal } from "./context";

const CONTEXT_CANDIDATE_LIMIT = 5;
const CONTEXT_SNIPPET_CHARACTERS = 600;

export async function loadTurnItemContext(
  env: Env,
  principal: AgentPrincipal,
  text: string,
): Promise<string> {
  const query = text.trim();
  if (!query) return "";
  const result = await searchOwnedItemsNatural(
    env.DB,
    principal.channel,
    principal.userId,
    query,
    CONTEXT_CANDIDATE_LIMIT,
  );
  if (result.matchMode === "recent_fallback") return "";

  const evidence = {
    matchMode: result.matchMode,
    candidates: result.items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      status: item.status,
      priority: item.priority,
      dueAt: item.dueAt,
      updatedAt: item.updatedAt,
      snippet: Array.from(item.content).slice(0, CONTEXT_SNIPPET_CHARACTERS).join(""),
    })),
  };
  return `\n与本轮文本相关的事项候选证据（仅用于召回，不代表它们就是用户所指对象；必须由模型结合真实会话确认后再更新或新建）：${JSON.stringify(evidence)}`;
}
