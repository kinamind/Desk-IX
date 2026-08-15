import { z } from "zod";
import { ITEM_TYPES, PRIORITIES, type ItemSearchFilters, type ParsedIntent } from "../core/types";
import { log } from "../observability/log";
import { parseAIJson } from "./openai-compatible";
import type { AIProvider } from "./provider";
import { INTENT_PROMPT, RESCHEDULE_PROMPT } from "./prompts";

const isoDate = z.string().datetime({ offset: true });

const aiQuerySchema = z.object({
  type: z.enum(ITEM_TYPES).optional().nullable(),
  statuses: z.array(z.string().min(1).max(40)).max(10).optional().nullable(),
  due_from: isoDate.optional().nullable(),
  due_to: isoDate.optional().nullable(),
  created_from: isoDate.optional().nullable(),
  keyword: z.string().max(120).optional().nullable(),
  limit: z.number().int().min(1).max(50).optional().nullable(),
}).optional().nullable();

const aiIntentSchema = z.object({
  intent: z.enum(["create_item", "query", "analyze", "help", "clarify"]),
  type: z.enum(ITEM_TYPES).optional().nullable(),
  title: z.string().max(100).optional().nullable(),
  content: z.string().optional().nullable(),
  url: z.string().url().optional().nullable(),
  tags: z.array(z.string().max(40)).max(12).nullish().transform((value) => value ?? []),
  status: z.string().max(40).optional().nullable(),
  priority: z.enum(PRIORITIES).nullish().transform((value) => value ?? "normal"),
  estimated_duration: z.number().int().positive().max(100_800).optional().nullable(),
  due_at: isoDate.optional().nullable(),
  reminder_at: isoDate.optional().nullable(),
  start_after: isoDate.optional().nullable(),
  original_time_expression: z.string().max(200).optional().nullable(),
  query: aiQuerySchema,
  clarification_question: z.string().max(300).optional().nullable(),
  confidence: z.number().min(0).max(1).nullish().transform((value) => value ?? 0.7),
});

const scheduleSchema = z.object({
  due_at: isoDate.optional().nullable(),
  reminder_at: isoDate.optional().nullable(),
  original_time_expression: z.string().max(200).optional().nullable(),
  clarification_question: z.string().max(300).optional().nullable(),
});

export interface ScheduleResolution {
  dueAt: string | null;
  reminderAt: string | null;
  originalTimeExpression: string | null;
  question: string | null;
}

const MAX_MODEL_INPUT_CHARS = 16_000;

function unavailableIntent(): ParsedIntent {
  return {
    intent: "unavailable",
    question: "模型这次没有成功理解，我没有擅自保存。请稍后重试。",
    confidence: 0,
    source: "system",
  };
}

function normalizeQuery(query: z.infer<typeof aiQuerySchema>): ItemSearchFilters {
  if (!query) return { limit: 10 };
  return {
    ...(query.type ? { type: query.type } : {}),
    ...(query.statuses?.length ? { statuses: query.statuses } : {}),
    ...(query.due_from ? { dueFrom: new Date(query.due_from).toISOString() } : {}),
    ...(query.due_to ? { dueTo: new Date(query.due_to).toISOString() } : {}),
    ...(query.created_from ? { createdFrom: new Date(query.created_from).toISOString() } : {}),
    ...(query.keyword ? { keyword: query.keyword } : {}),
    limit: query.limit ?? 10,
  };
}

function normalizeReminder(reminderAt: string | null | undefined, dueAt: string | null | undefined, now: Date): string | null {
  if (!reminderAt) return null;
  const reminder = new Date(reminderAt);
  if (reminder.getTime() > now.getTime()) return reminder.toISOString();
  if (dueAt && new Date(dueAt).getTime() > now.getTime()) {
    return new Date(now.getTime() + 5_000).toISOString();
  }
  return null;
}

export async function routeMessage(
  text: string,
  provider: AIProvider | null,
  now = new Date(),
  timezone = "Asia/Singapore",
): Promise<ParsedIntent> {
  const trimmed = text.trim();
  if (/^\/?(?:help|帮助|使用说明)$/i.test(trimmed)) {
    return { intent: "help", confidence: 1, source: "system" };
  }
  if (!provider) return unavailableIntent();

  try {
    const response = await provider.generate({
      purpose: "intent",
      expectJson: true,
      messages: [
        { role: "system", content: `${INTENT_PROMPT}\n当前时间：${now.toISOString()}\n用户时区：${timezone}` },
        { role: "user", content: trimmed.slice(0, MAX_MODEL_INPUT_CHARS) },
      ],
    });
    const parsed = aiIntentSchema.parse(parseAIJson(response.text));
    if (parsed.intent === "clarify") {
      return {
        intent: "clarify",
        question: parsed.clarification_question ?? "我还不能确定具体时间，能再说具体一点吗？",
        confidence: parsed.confidence,
        source: "ai",
      };
    }

    const dueAt = parsed.due_at ? new Date(parsed.due_at).toISOString() : null;
    const reminderAt = normalizeReminder(parsed.reminder_at, dueAt, now);
    return {
      intent: parsed.intent,
      ...(parsed.type ? { type: parsed.type } : {}),
      ...(parsed.title ? { title: parsed.title } : {}),
      content: parsed.content ?? text,
      url: parsed.url ?? null,
      tags: parsed.tags,
      ...(parsed.status ? { status: parsed.status } : {}),
      priority: parsed.priority,
      estimatedDuration: parsed.estimated_duration ?? null,
      dueAt,
      reminderAt,
      startAfter: parsed.start_after ? new Date(parsed.start_after).toISOString() : null,
      originalTimeExpression: parsed.original_time_expression ?? null,
      ...(parsed.intent === "query" ? { query: normalizeQuery(parsed.query) } : {}),
      confidence: parsed.confidence,
      source: "ai",
      aiEnrichment: {
        provider: "openai-compatible",
        model: response.model,
        generated_fields: ["intent", "title", "tags", "dates", "query"],
      },
    };
  } catch (error) {
    log("warn", "ai_intent_failed", { error: error instanceof Error ? error.message : String(error) });
    return unavailableIntent();
  }
}

export async function resolveScheduleChange(
  text: string,
  itemContext: { title: string; dueAt: string | null },
  provider: AIProvider | null,
  now = new Date(),
  timezone = "Asia/Singapore",
): Promise<ScheduleResolution> {
  if (!provider) {
    return { dueAt: null, reminderAt: null, originalTimeExpression: null, question: "模型暂时不可用，原时间没有修改。" };
  }
  try {
    const response = await provider.generate({
      purpose: "reschedule",
      expectJson: true,
      messages: [
        { role: "system", content: `${RESCHEDULE_PROMPT}\n当前时间：${now.toISOString()}\n用户时区：${timezone}` },
        { role: "user", content: JSON.stringify({ message: text.slice(0, 2_000), item: itemContext }) },
      ],
    });
    const parsed = scheduleSchema.parse(parseAIJson(response.text));
    const dueAt = parsed.due_at ? new Date(parsed.due_at).toISOString() : null;
    const reminderAt = normalizeReminder(parsed.reminder_at ?? parsed.due_at, dueAt, now);
    const question = parsed.clarification_question ?? (!dueAt && !reminderAt ? "我还不能确定新时间，能再说具体一点吗？" : null);
    return {
      dueAt,
      reminderAt,
      originalTimeExpression: parsed.original_time_expression ?? text.slice(0, 200),
      question,
    };
  } catch (error) {
    log("warn", "ai_reschedule_failed", { error: error instanceof Error ? error.message : String(error) });
    return { dueAt: null, reminderAt: null, originalTimeExpression: null, question: "模型这次没有成功理解，原时间没有修改。" };
  }
}
