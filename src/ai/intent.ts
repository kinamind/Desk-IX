import { z } from "zod";
import {
  ITEM_TYPES,
  PRIORITIES,
  REMINDER_MODES,
  type AgentAction,
  type ConversationTurn,
  type CreateItemAgentAction,
  type Item,
  type ItemSearchFilters,
  type ParsedIntent,
  type ReminderMode,
  type UpdateItemAgentAction,
} from "../core/types";
import { log } from "../observability/log";
import { parseAIJson } from "./openai-compatible";
import type { AIProvider } from "./provider";
import { INTENT_PROMPT, REMINDER_REPAIR_PROMPT, RESCHEDULE_PROMPT } from "./prompts";

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

const createActionSchema = z.object({
  action: z.literal("create_item"),
  type: z.enum(ITEM_TYPES),
  title: z.string().min(1).max(100),
  content: z.string().optional().nullable(),
  url: z.string().url().optional().nullable(),
  tags: z.array(z.string().max(40)).max(12).optional().nullable(),
  status: z.enum(["open", "raw", "active"]).optional().nullable(),
  priority: z.enum(PRIORITIES).optional().nullable(),
  estimated_duration: z.number().int().positive().max(100_800).optional().nullable(),
  due_at: isoDate.optional().nullable(),
  reminder_at: isoDate.optional().nullable(),
  reminder_mode: z.enum(REMINDER_MODES).optional().nullable(),
  start_after: isoDate.optional().nullable(),
  original_time_expression: z.string().max(200).optional().nullable(),
});

const targetActionSchema = z.object({
  action: z.enum(["complete_item", "archive_item", "restore_item"]),
  target_item_id: z.string().uuid(),
});

const updateActionSchema = z.object({
  action: z.literal("update_item"),
  target_item_id: z.string().uuid(),
  title: z.string().min(1).max(100).optional().nullable(),
  content: z.string().optional().nullable(),
  tags: z.array(z.string().max(40)).max(12).optional().nullable(),
  priority: z.enum(PRIORITIES).optional().nullable(),
  estimated_duration: z.number().int().positive().max(100_800).optional().nullable(),
  due_at: isoDate.optional().nullable(),
  reminder_at: isoDate.optional().nullable(),
  reminder_mode: z.enum(REMINDER_MODES).optional().nullable(),
  start_after: isoDate.optional().nullable(),
  original_time_expression: z.string().max(200).optional().nullable(),
});

const aiActionSchema = z.discriminatedUnion("action", [createActionSchema, targetActionSchema, updateActionSchema]);

const aiIntentSchema = z.object({
  intent: z.enum(["act", "query", "analyze", "respond", "help", "clarify"]),
  actions: z.array(aiActionSchema).max(5).optional().nullable(),
  query: aiQuerySchema,
  reply: z.string().max(800).optional().nullable(),
  clarification_question: z.string().max(300).optional().nullable(),
  confidence: z.number().min(0).max(1).optional().nullable().transform((value) => value ?? 0.7),
});

const scheduleSchema = z.object({
  due_at: isoDate.optional().nullable(),
  reminder_at: isoDate.optional().nullable(),
  reminder_mode: z.enum(REMINDER_MODES).optional().nullable(),
  original_time_expression: z.string().max(200).optional().nullable(),
  clarification_question: z.string().max(300).optional().nullable(),
});

export interface ScheduleResolution {
  dueAt: string | null;
  reminderAt: string | null;
  reminderMode: ReminderMode | null;
  originalTimeExpression: string | null;
  question: string | null;
}

const MAX_MODEL_INPUT_CHARS = 16_000;
const MIN_DEFERRED_DELAY_MS = 30 * 60_000;
const MIN_WORKFLOW_DELAY_MS = 2 * 60_000;

function unavailableIntent(): ParsedIntent {
  return {
    intent: "unavailable",
    question: "模型这次没有成功理解，我没有擅自操作。请稍后重试。",
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

function normalizeReminder(
  reminderAt: string | null | undefined,
  dueAt: string | null | undefined,
  now: Date,
  mode: ReminderMode | null | undefined,
): { value: string | null; rejected: boolean } {
  if (!reminderAt || mode === "none") return { value: null, rejected: false };
  if (mode === "explicit_now") return { value: null, rejected: false };
  const reminder = new Date(reminderAt);
  const minimumDelay = mode === "pre_event" || mode === "at_deadline" ? MIN_WORKFLOW_DELAY_MS : MIN_DEFERRED_DELAY_MS;
  const dueTime = dueAt ? new Date(dueAt).getTime() : null;
  if (reminder.getTime() < now.getTime() + minimumDelay || (dueTime !== null && reminder.getTime() > dueTime)) {
    return { value: null, rejected: true };
  }
  return { value: reminder.toISOString(), rejected: false };
}

function normalizeCreateAction(
  action: z.infer<typeof createActionSchema>,
  now: Date,
): { action: CreateItemAgentAction; reminderRejected: boolean; reminderMissing: boolean } {
  const dueAt = action.due_at ? new Date(action.due_at).toISOString() : null;
  const reminder = normalizeReminder(action.reminder_at, dueAt, now, action.reminder_mode);
  const modeNeedsReminder = action.reminder_mode !== "none" && action.reminder_mode !== "explicit_now";
  const actionable = action.type === "task" || action.type === "project";
  return {
    action: {
      action: "create_item",
      type: action.type,
      title: action.title,
      ...(action.content !== null && action.content !== undefined ? { content: action.content } : {}),
      url: action.url ?? null,
      tags: action.tags ?? [],
      status: action.status ?? (action.type === "idea" || action.type === "note" ? "raw" : "open"),
      priority: action.priority ?? "normal",
      estimatedDuration: action.estimated_duration ?? null,
      dueAt,
      reminderAt: reminder.value,
      reminderMode: action.reminder_mode ?? null,
      startAfter: action.start_after ? new Date(action.start_after).toISOString() : null,
      originalTimeExpression: action.original_time_expression ?? null,
    },
    reminderRejected: reminder.rejected,
    reminderMissing: modeNeedsReminder && actionable && reminder.value === null,
  };
}

function normalizeUpdateAction(
  action: z.infer<typeof updateActionSchema>,
  now: Date,
  contextItems: Item[],
): { action: UpdateItemAgentAction; reminderRejected: boolean } {
  const hasDueAt = Object.hasOwn(action, "due_at");
  const dueAt = action.due_at ? new Date(action.due_at).toISOString() : null;
  const existingDueAt = contextItems.find((item) => item.id === action.target_item_id)?.dueAt ?? null;
  const reminder = normalizeReminder(action.reminder_at, hasDueAt ? dueAt : existingDueAt, now, action.reminder_mode);
  return {
    action: {
      action: "update_item",
      targetItemId: action.target_item_id,
      ...(action.title ? { title: action.title } : {}),
      ...(action.content !== null && action.content !== undefined ? { content: action.content } : {}),
      ...(action.tags ? { tags: action.tags } : {}),
      ...(action.priority ? { priority: action.priority } : {}),
      ...(Object.hasOwn(action, "estimated_duration") ? { estimatedDuration: action.estimated_duration ?? null } : {}),
      ...(hasDueAt ? { dueAt } : {}),
      ...(Object.hasOwn(action, "reminder_at") ? { reminderAt: reminder.value } : {}),
      ...(Object.hasOwn(action, "reminder_mode") ? { reminderMode: action.reminder_mode ?? null } : {}),
      ...(Object.hasOwn(action, "start_after") ? { startAfter: action.start_after ? new Date(action.start_after).toISOString() : null } : {}),
      ...(Object.hasOwn(action, "original_time_expression") ? { originalTimeExpression: action.original_time_expression ?? null } : {}),
    },
    reminderRejected: reminder.rejected,
  };
}

function normalizeActions(
  actions: z.infer<typeof aiIntentSchema>["actions"],
  now: Date,
  contextItems: Item[],
): { actions: AgentAction[]; needsRepair: boolean } {
  const normalized: AgentAction[] = [];
  let needsRepair = false;
  for (const action of actions ?? []) {
    if (action.action === "create_item") {
      const result = normalizeCreateAction(action, now);
      normalized.push(result.action);
      needsRepair ||= result.reminderRejected || result.reminderMissing;
    } else if (action.action === "update_item") {
      const result = normalizeUpdateAction(action, now, contextItems);
      normalized.push(result.action);
      needsRepair ||= result.reminderRejected;
    } else {
      normalized.push({ action: action.action, targetItemId: action.target_item_id });
    }
  }
  return { actions: normalized, needsRepair };
}

function summarizeContext(items: Item[]): Array<Record<string, unknown>> {
  return items.slice(0, 20).map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    content: item.content.slice(0, 500),
    status: item.status,
    priority: item.priority,
    due_at: item.dueAt,
    updated_at: item.updatedAt,
    tags: item.tags.slice(0, 8),
  }));
}

function buildModelInput(message: string, items: Item[], conversation: ConversationTurn[]): string {
  const recentItems = summarizeContext(items);
  const recentConversation = conversation.slice(-6).map((turn) => ({
    user: turn.user.slice(0, 1_000),
    assistant: turn.assistant.slice(0, 1_000),
    received_at: turn.receivedAt,
  }));
  const boundedMessage = message.slice(0, 6_000);
  while (recentItems.length > 0 || recentConversation.length > 0) {
    const candidate = JSON.stringify({ message: boundedMessage, recent_items: recentItems, recent_conversation: recentConversation });
    if (candidate.length <= MAX_MODEL_INPUT_CHARS) return candidate;
    if (recentConversation.length > 2) recentConversation.shift();
    else recentItems.pop();
  }
  return JSON.stringify({ message: boundedMessage, recent_items: [], recent_conversation: [] });
}

export async function routeMessage(
  text: string,
  provider: AIProvider | null,
  now = new Date(),
  timezone = "Asia/Singapore",
  contextItems: Item[] = [],
  conversation: ConversationTurn[] = [],
): Promise<ParsedIntent> {
  const trimmed = text.trim();
  if (/^\/?(?:help|帮助|使用说明)$/i.test(trimmed)) {
    return { intent: "help", confidence: 1, source: "system" };
  }
  if (!provider) return unavailableIntent();

  const input = buildModelInput(trimmed, contextItems, conversation);

  try {
    let response = await provider.generate({
      purpose: "intent",
      expectJson: true,
      messages: [
        { role: "system", content: `${INTENT_PROMPT}\n当前时间：${now.toISOString()}\n用户时区：${timezone}` },
        { role: "user", content: input },
      ],
    });
    let parsed = aiIntentSchema.parse(parseAIJson(response.text));
    let normalized = normalizeActions(parsed.actions, now, contextItems);

    if (parsed.intent === "act" && normalized.needsRepair) {
      response = await provider.generate({
        purpose: "intent",
        expectJson: true,
        messages: [
          { role: "system", content: `${INTENT_PROMPT}\n${REMINDER_REPAIR_PROMPT}\n当前时间：${now.toISOString()}\n用户时区：${timezone}` },
          { role: "user", content: JSON.stringify({ original_input_json: input, previous_result: parsed }) },
        ],
      });
      parsed = aiIntentSchema.parse(parseAIJson(response.text));
      normalized = normalizeActions(parsed.actions, now, contextItems);
    }

    if (parsed.intent === "act" && (normalized.needsRepair || normalized.actions.length === 0)) {
      throw new Error("Model returned an unusable action plan");
    }
    if (parsed.intent === "clarify") {
      return {
        intent: "clarify",
        question: parsed.clarification_question ?? "我还不能确定你指的是哪一项，能再说具体一点吗？",
        confidence: parsed.confidence,
        source: "ai",
      };
    }

    return {
      intent: parsed.intent,
      ...(parsed.intent === "act" ? { actions: normalized.actions } : {}),
      ...(parsed.intent === "query" ? { query: normalizeQuery(parsed.query) } : {}),
      ...(parsed.reply ? { reply: parsed.reply } : {}),
      confidence: parsed.confidence,
      source: "ai",
      aiEnrichment: {
        provider: "openai-compatible",
        model: response.model,
        generated_fields: ["intent", "actions", "query", "reply"],
        context_item_count: contextItems.length,
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
    return { dueAt: null, reminderAt: null, reminderMode: null, originalTimeExpression: null, question: "模型暂时不可用，原时间没有修改。" };
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
    const normalizedReminder = normalizeReminder(parsed.reminder_at ?? parsed.due_at, dueAt, now, parsed.reminder_mode);
    const reminderAt = normalizedReminder.value;
    const question = parsed.clarification_question ?? (!dueAt && !reminderAt ? "我还不能确定新时间，能再说具体一点吗？" : null);
    return {
      dueAt,
      reminderAt,
      reminderMode: parsed.reminder_mode ?? null,
      originalTimeExpression: parsed.original_time_expression ?? text.slice(0, 200),
      question,
    };
  } catch (error) {
    log("warn", "ai_reschedule_failed", { error: error instanceof Error ? error.message : String(error) });
    return { dueAt: null, reminderAt: null, reminderMode: null, originalTimeExpression: null, question: "模型这次没有成功理解，原时间没有修改。" };
  }
}
