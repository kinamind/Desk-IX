import type { ItemSearchFilters, ItemType } from "./types";
import { localDayBounds, localWeekBounds } from "./time";

const TYPE_PATTERNS: Array<[RegExp, ItemType]> = [
  [/idea|想法|点子|研究/i, "idea"],
  [/招聘|资源|链接|论文|文章/i, "resource"],
  [/项目|project/i, "project"],
  [/任务|待办|事情|todo/i, "task"],
  [/笔记|note/i, "note"],
];

const QUERY_STOPWORDS = [
  "我", "的", "之前", "是不是", "有没有", "记过", "保存过", "找一下", "找找", "哪些", "有什么",
  "最近", "相关", "有关", "还有", "这周", "本周", "下周", "今天", "明天", "事情", "任务", "想法",
  "idea", "deadline", "截止", "未处理", "没处理", "未完成", "吗", "呢", "？", "?",
];

function extractKeyword(text: string): string | undefined {
  let keyword = text;
  for (const word of QUERY_STOPWORDS) keyword = keyword.replaceAll(word, " ");
  keyword = keyword.replace(/[，。！、,:：;；"“”'‘’()（）]/g, " ").replace(/\s+/g, " ").trim();
  return keyword.length >= 2 ? keyword.slice(0, 80) : undefined;
}

export function buildQueryFilters(text: string, now = new Date(), timezone = "Asia/Singapore"): ItemSearchFilters {
  const filters: ItemSearchFilters = { limit: 10 };
  for (const [pattern, type] of TYPE_PATTERNS) {
    if (pattern.test(text)) {
      filters.type = type;
      break;
    }
  }

  if (/未处理|没处理|raw|还没处理/i.test(text)) filters.statuses = ["raw", "open"];
  else if (/已完成|完成了|completed/i.test(text)) filters.statuses = ["completed"];
  else filters.statuses = ["open", "raw", "active"];

  if (/下周|next week/i.test(text)) {
    const bounds = localWeekBounds(now, timezone, true);
    filters.dueFrom = bounds.start;
    filters.dueTo = bounds.end;
  } else if (/这周|本周|this week/i.test(text)) {
    const bounds = localWeekBounds(now, timezone);
    filters.dueFrom = bounds.start;
    filters.dueTo = bounds.end;
  } else if (/今天|today/i.test(text)) {
    const bounds = localDayBounds(now, timezone);
    filters.dueFrom = bounds.start;
    filters.dueTo = bounds.end;
  } else if (/明天|tomorrow/i.test(text)) {
    const bounds = localDayBounds(now, timezone, 1);
    filters.dueFrom = bounds.start;
    filters.dueTo = bounds.end;
  }

  const keyword = extractKeyword(text);
  if (keyword) filters.keyword = keyword;
  return filters;
}
