import { buildQueryFilters } from "./query";
import { parseNaturalTime } from "./time";
import type { ItemType, ParsedIntent, Priority } from "./types";

const URL_PATTERN = /https?:\/\/[^\s<>"']+/i;

function compactTitle(text: string, fallback: string): string {
  const firstLine = text
    .replace(URL_PATTERN, "")
    .replace(/^(请|帮我|记一下|记录一下|想到一个|有一个|这个|那个)\s*/i, "")
    .replace(/(?:提醒我|截止|deadline).*$/i, "")
    .trim();
  return (firstLine || fallback).slice(0, 60);
}

function detectPriority(text: string): Priority {
  if (/紧急|非常重要|urgent|立刻|马上/i.test(text)) return "urgent";
  if (/重要|优先|high priority/i.test(text)) return "high";
  if (/不急|有空|低优先/i.test(text)) return "low";
  return "normal";
}

function createIntent(type: ItemType, text: string, title: string, timezone: string, now: Date): ParsedIntent {
  const parsedTime = parseNaturalTime(text, now, timezone);
  return {
    intent: "create_item",
    type,
    title,
    content: text,
    tags: [],
    status: type === "idea" ? "raw" : "open",
    priority: detectPriority(text),
    dueAt: parsedTime?.at ?? null,
    reminderAt: /提醒|remind/i.test(text) ? parsedTime?.at ?? null : null,
    originalTimeExpression: parsedTime?.originalExpression ?? null,
    confidence: 0.88,
    source: "deterministic",
  };
}

export function routeDeterministically(
  text: string,
  now = new Date(),
  timezone = "Asia/Singapore",
): ParsedIntent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (/^\/?(?:help|帮助|使用说明)$/i.test(trimmed)) {
    return { intent: "help", confidence: 1, source: "deterministic" };
  }

  if (/展开一下|分析一下|帮我(?:展开|分析|设计)|深入分析/i.test(trimmed)) {
    return { intent: "analyze", content: trimmed, confidence: 0.98, source: "deterministic" };
  }

  const querySignal = /\?|？|哪些|有什么|找一下|找找|之前|是不是|有没有|列出|查询|show me|what do i/i.test(trimmed);
  const createSignal = /记一下|保存|添加|建立|提醒我|想到|idea|待办|要做|截止|deadline/i.test(trimmed);
  if (querySignal && !createSignal) {
    return {
      intent: "query",
      query: buildQueryFilters(trimmed, now, timezone),
      confidence: 0.92,
      source: "deterministic",
    };
  }

  const url = trimmed.match(URL_PATTERN)?.[0] ?? null;
  if (url) {
    const intent = createIntent("resource", trimmed, compactTitle(trimmed, "保存的链接"), timezone, now);
    intent.url = url.replace(/[),.;，。；]+$/, "");
    intent.dueAt = null;
    intent.reminderAt = null;
    return intent;
  }

  if (/截止|deadline|投稿日期|交稿/i.test(trimmed)) {
    const intent = createIntent("project", trimmed, compactTitle(trimmed, "项目"), timezone, now);
    intent.confidence = intent.dueAt ? 0.95 : 0.72;
    return intent;
  }

  if (/提醒我|remind me/i.test(trimmed)) {
    const intent = createIntent("task", trimmed, compactTitle(trimmed, "提醒"), timezone, now);
    intent.confidence = intent.reminderAt ? 0.98 : 0.62;
    return intent;
  }

  if (/\bidea\b|想法|点子|研究.*(?:影响|关系|方向)|想到/i.test(trimmed)) {
    return createIntent("idea", trimmed, compactTitle(trimmed, "Research Idea"), timezone, now);
  }

  if (/待办|任务|要做|需要做|记得|提交|回复|发送|发邮件|整理|完成/i.test(trimmed)) {
    return createIntent("task", trimmed, compactTitle(trimmed, "任务"), timezone, now);
  }

  return null;
}

export function extractUrl(text: string): string | null {
  return text.match(URL_PATTERN)?.[0]?.replace(/[),.;，。；]+$/, "") ?? null;
}
