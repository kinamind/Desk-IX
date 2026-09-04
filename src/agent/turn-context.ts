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
    provenance: "historical_candidate_only",
    identityResolved: false,
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
  return `\n与本轮文本相关的历史事项候选证据（仅用于召回，尚未解析为本轮对象）：${JSON.stringify(evidence)}。候选中独有的项目、组织、主题、日期和状态不能写入本轮的新记录或回复，除非本轮文字、真实引用锚点或已明确建立的连续对话提供支持；同名人物或相似关键词不足以建立关联。`;
}
