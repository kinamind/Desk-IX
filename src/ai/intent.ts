import { z } from "zod";
import { ITEM_TYPES, PRIORITIES, type ParsedIntent } from "../core/types";
import { routeDeterministically } from "../core/intent-router";
import { INTENT_PROMPT } from "./prompts";
import type { AIProvider } from "./provider";
import { parseAIJson } from "./openai-compatible";
import { log } from "../observability/log";

const aiIntentSchema = z.object({
  intent: z.enum(["create_item", "query", "analyze", "help"]),
  type: z.enum(ITEM_TYPES).optional().nullable(),
  title: z.string().optional().nullable(),
  content: z.string().optional().nullable(),
  url: z.string().url().optional().nullable(),
  tags: z.array(z.string()).optional().default([]),
  status: z.string().optional().nullable(),
  priority: z.enum(PRIORITIES).optional().default("normal"),
  estimated_duration: z.number().int().positive().optional().nullable(),
  due_at: z.string().datetime({ offset: true }).optional().nullable(),
  reminder_at: z.string().datetime({ offset: true }).optional().nullable(),
  start_after: z.string().datetime({ offset: true }).optional().nullable(),
  original_time_expression: z.string().optional().nullable(),
  confidence: z.number().min(0).max(1).optional().default(0.7),
});

export async function routeMessage(
  text: string,
  provider: AIProvider | null,
  now = new Date(),
  timezone = "Asia/Singapore",
): Promise<ParsedIntent> {
  const deterministic = routeDeterministically(text, now, timezone);
  if (deterministic && deterministic.confidence >= 0.8) return deterministic;
  if (!provider) {
    return deterministic ?? {
      intent: "create_item",
      type: "note",
      title: text.trim().slice(0, 60) || "笔记",
      content: text,
      confidence: 0.5,
      source: "deterministic",
    };
  }

  try {
    const response = await provider.generate({
      purpose: "intent",
      expectJson: true,
      messages: [
        { role: "system", content: `${INTENT_PROMPT}\n当前时间：${now.toISOString()}\n时区：${timezone}` },
        { role: "user", content: text },
      ],
    });
    const parsed = aiIntentSchema.parse(parseAIJson(response.text));
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
      dueAt: parsed.due_at ? new Date(parsed.due_at).toISOString() : null,
      reminderAt: parsed.reminder_at ? new Date(parsed.reminder_at).toISOString() : null,
      startAfter: parsed.start_after ? new Date(parsed.start_after).toISOString() : null,
      originalTimeExpression: parsed.original_time_expression ?? null,
      confidence: parsed.confidence,
      source: "ai",
      aiEnrichment: { provider: "openai-compatible", model: response.model, generated_fields: ["title", "tags", "dates"] },
    };
  } catch (error) {
    log("warn", "ai_intent_fallback", { error: error instanceof Error ? error.message : String(error) });
    return deterministic ?? {
      intent: "create_item",
      type: "note",
      title: text.trim().slice(0, 60) || "笔记",
      content: text,
      confidence: 0.4,
      source: "deterministic",
    };
  }
}
