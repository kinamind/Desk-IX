import { action } from "@cloudflare/think";
import { z } from "zod";
import { ITEM_TYPES, PRIORITIES } from "../../core/types";
import { scheduleReminder } from "../../core/reminder-service";
import {
  archiveItem,
  completeItem,
  createItem,
  getItemBySource,
  getOwnedItem,
  mergeItemEnrichment,
  restoreItem,
  updateItem,
} from "../../db/items";
import { cancelOpenReminders } from "../../db/reminders";
import { listScheduleWindows } from "../../db/schedule";
import { clearPendingAction } from "../../db/pending-actions";
import type { AgentPrincipal } from "../context";
import { stableFingerprint } from "../idempotency";

type PrincipalProvider = () => AgentPrincipal;

const itemTypeSchema = z.enum(ITEM_TYPES);
const prioritySchema = z.enum(PRIORITIES);

const createItemSchema = z.object({
  actionIndex: z.number().int().min(0).max(20).default(0),
  type: itemTypeSchema,
  title: z.string().trim().min(1).max(300),
  content: z.string().trim().min(1).max(20_000),
  url: z.string().url().nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  status: z.enum(["open", "raw", "active"]).default("open"),
  priority: prioritySchema.default("normal"),
  estimatedDuration: z.number().int().min(1).max(10_080).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  startAfter: z.string().datetime().nullable().optional(),
  originalTimeExpression: z.string().max(300).nullable().optional(),
  structuredData: z.record(z.string(), z.unknown()).optional(),
});

const updateItemSchema = z.object({
  itemId: z.string().uuid(),
  title: z.string().trim().min(1).max(300).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  priority: prioritySchema.optional(),
  estimatedDuration: z.number().int().min(1).max(10_080).nullable().optional(),
  dueAt: z.string().datetime().nullable().optional(),
  startAfter: z.string().datetime().nullable().optional(),
  originalTimeExpression: z.string().max(300).nullable().optional(),
  primaryUrl: z.string().url().optional(),
  structuredData: z.record(z.string(), z.unknown()).optional(),
  provenance: z.object({
    sourceUrls: z.array(z.string().url()).max(10).default([]),
    note: z.string().max(1_000).optional(),
  }).optional(),
}).refine((input) => Object.keys(input).some((key) => key !== "itemId"), "Provide at least one field to update");

const transitionSchema = z.object({
  itemId: z.string().uuid(),
  transition: z.enum(["complete", "abandon", "archive", "restore"]),
});

export const reminderInputSchema = z.object({
  operation: z.enum(["set", "reschedule", "cancel"]),
  itemId: z.string().uuid(),
  remindAt: z.string().datetime().optional(),
  kind: z.string().trim().min(1).max(80).default("reminder"),
  allowConflict: z.boolean().default(false),
  explicitImmediate: z.boolean().default(false),
}).superRefine((input, context) => {
  if (input.operation !== "cancel" && !input.remindAt) {
    context.addIssue({
      code: "custom",
      path: ["remindAt"],
      message: "remindAt is required when setting or rescheduling a reminder",
    });
  }
});

export async function createOwnedItem(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof createItemSchema>,
) {
  const existing = await getItemBySource(env.DB, principal.channel, principal.eventId, input.actionIndex);
  if (existing) {
    if (existing.sourceUserId !== principal.userId) throw new Error("Source event is already owned by another user");
    return { created: false, itemId: existing.id, title: existing.title, status: existing.status };
  }
  const item = await createItem(env.DB, {
    type: input.type,
    title: input.title,
    content: input.content,
    rawMessage: input.content,
    url: input.url ?? null,
    tags: input.tags,
    status: input.status,
    priority: input.priority,
    estimatedDuration: input.estimatedDuration ?? null,
    dueAt: input.dueAt ?? null,
    startAfter: input.startAfter ?? null,
    originalTimeExpression: input.originalTimeExpression ?? null,
    sourceChannel: principal.channel,
    sourceUserId: principal.userId,
    sourceMessageId: principal.eventId,
    sourceActionIndex: input.actionIndex,
    aiEnrichment: input.structuredData ?? {},
    metadata: { agentRuntime: "composa-v2" },
  });
  return { created: true, itemId: item.id, title: item.title, status: item.status };
}

export async function updateOwnedItem(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof updateItemSchema>,
) {
  const current = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!current) throw new Error("Item not found in the current user's memory");
  const changed = await updateItem(env.DB, current.id, {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.estimatedDuration !== undefined ? { estimatedDuration: input.estimatedDuration } : {}),
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    ...(input.startAfter !== undefined ? { startAfter: input.startAfter } : {}),
    ...(input.originalTimeExpression !== undefined ? { originalTimeExpression: input.originalTimeExpression } : {}),
  });
  if (input.structuredData || input.provenance || input.primaryUrl) {
    await mergeItemEnrichment(
      env.DB,
      current.id,
      { ...current.aiEnrichment, ...(input.structuredData ?? {}) },
      {
        ...current.metadata,
        ...(input.provenance ? { provenance: input.provenance } : {}),
        agentRuntime: "composa-v2",
      },
      { ...(input.primaryUrl ? { primaryUrl: input.primaryUrl } : {}) },
    );
  }
  return { updated: changed || Boolean(input.structuredData || input.provenance || input.primaryUrl), itemId: current.id };
}

export async function transitionOwnedItem(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof transitionSchema>,
) {
  const current = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!current) throw new Error("Item not found in the current user's memory");
  let changed: boolean;
  if (input.transition === "complete") changed = await completeItem(env.DB, current.id);
  else if (input.transition === "restore") changed = await restoreItem(env.DB, current.id);
  else changed = await archiveItem(env.DB, current.id);
  if (input.transition !== "restore") await cancelOpenReminders(env.DB, current.id);
  return {
    changed,
    itemId: current.id,
    status: input.transition === "complete" ? "completed" : input.transition === "restore" ? "open" : "archived",
  };
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

export async function manageOwnedReminder(
  env: Env,
  principal: AgentPrincipal,
  input: z.infer<typeof reminderInputSchema>,
) {
  const item = await getOwnedItem(env.DB, input.itemId, principal.channel, principal.userId);
  if (!item) throw new Error("Item not found in the current user's memory");
  if (input.operation === "cancel") {
    await cancelOpenReminders(env.DB, item.id);
    await clearPendingAction(env.DB, principal.channel, principal.userId, item.id);
    return { canceled: true, itemId: item.id };
  }

  if (!input.remindAt) throw new Error("Reminder time is required");
  const remindAt = new Date(input.remindAt);
  if (Number.isNaN(remindAt.getTime())) throw new Error("Invalid reminder time");
  if (!input.explicitImmediate && remindAt.getTime() < Date.now() + 15 * 60_000) {
    return {
      scheduled: false,
      reason: "The proposed reminder is too immediate for a deferred action. Choose a useful later time or set explicitImmediate only when the user explicitly asked for now.",
    };
  }
  if (remindAt.getTime() <= Date.now()) throw new Error("Reminder time must be in the future");

  const windows = await listScheduleWindows(env.DB, principal.channel, principal.userId, new Date(), 30);
  const proposedEnd = remindAt.getTime() + 15 * 60_000;
  const conflicts = windows.filter((window) => overlaps(
    remindAt.getTime(),
    proposedEnd,
    new Date(window.startAt).getTime(),
    new Date(window.endAt).getTime(),
  ));
  if (conflicts.length > 0 && !input.allowConflict) {
    return {
      scheduled: false,
      reason: "The proposed reminder overlaps an existing schedule window. Choose another time unless the user explicitly requested this exact time.",
      conflicts: conflicts.slice(0, 5),
    };
  }

  const reminder = await scheduleReminder(env, {
    itemId: item.id,
    remindAt: remindAt.toISOString(),
    kind: input.kind,
    target: { channel: principal.channel, userId: principal.userId },
  });
  await cancelOpenReminders(env.DB, item.id, reminder.id);
  await clearPendingAction(env.DB, principal.channel, principal.userId, item.id);
  return {
    scheduled: true,
    itemId: item.id,
    reminderId: reminder.id,
    remindAt: reminder.remindAt,
    conflictsAccepted: conflicts.length,
  };
}

export function createWriteActions(env: Env, principal: PrincipalProvider) {
  return {
    item_create: action({
      description: "Create a new saved item only when the user is introducing a genuinely new task, note, resource, idea, or project. Do not use this for a reference to an existing item; search and update instead. Use distinct actionIndex values only when one message explicitly creates several items.",
      inputSchema: createItemSchema,
      permissions: ["items:write"],
      idempotencyKey: ({ input }) => `create:${principal().eventId}:${input.actionIndex}`,
      execute: (input) => createOwnedItem(env, principal(), input),
    }),
    item_update: action({
      description: "Update one existing owned item. Use after memory_search/item_get and, when links matter, web_read. Put extracted facts in structuredData and source URLs in provenance so the same record becomes useful instead of storing a bare link.",
      inputSchema: updateItemSchema,
      permissions: ["items:write"],
      idempotencyKey: ({ input }) => `update:${principal().eventId}:${input.itemId}:${stableFingerprint(input)}`,
      execute: (input) => updateOwnedItem(env, principal(), input),
    }),
    item_transition: action({
      description: "Change an existing item's lifecycle: complete it, abandon/archive it, or restore it. Search first when the user refers to it conversationally.",
      inputSchema: transitionSchema,
      permissions: ["items:write"],
      idempotencyKey: ({ input }) => `transition:${principal().eventId}:${input.itemId}:${input.transition}`,
      execute: (input) => transitionOwnedItem(env, principal(), input),
    }),
    reminder_manage: action({
      description: "Set, reschedule, or cancel a reminder for an existing item. For a time you choose, call schedule_list first and avoid conflicts. Use a useful future time for deferred work; explicitImmediate is only for an explicit user request to remind now.",
      inputSchema: reminderInputSchema,
      permissions: ["reminders:write"],
      idempotencyKey: ({ input }) => `reminder:${principal().eventId}:${input.itemId}:${stableFingerprint(input)}`,
      execute: (input) => manageOwnedReminder(env, principal(), input),
    }),
  };
}
