import type { ChannelName, Item, ItemType, Priority, Reminder } from "../core/types";

export interface ItemRow {
  id: string;
  type: ItemType;
  title: string;
  content: string;
  raw_message: string;
  url: string | null;
  tags: string;
  status: string;
  priority: Priority;
  estimated_duration: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  due_at: string | null;
  start_after: string | null;
  original_time_expression: string | null;
  source_channel: ChannelName;
  source_user_id: string;
  source_message_id: string;
  ai_enrichment: string;
  metadata: string;
  parent_id: string | null;
  embedding_id: string | null;
}

export interface ReminderRow {
  id: string;
  item_id: string;
  remind_at: string;
  status: Reminder["status"];
  kind: string;
  target_channel: ChannelName;
  target_user_id: string;
  workflow_id: string | null;
  created_at: string;
  triggered_at: string | null;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStrings(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function mapItem(row: ItemRow): Item {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    rawMessage: row.raw_message,
    url: row.url,
    tags: parseStrings(row.tags),
    status: row.status,
    priority: row.priority,
    estimatedDuration: row.estimated_duration,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    dueAt: row.due_at,
    startAfter: row.start_after,
    originalTimeExpression: row.original_time_expression,
    sourceChannel: row.source_channel,
    sourceUserId: row.source_user_id,
    sourceMessageId: row.source_message_id,
    aiEnrichment: parseObject(row.ai_enrichment),
    metadata: parseObject(row.metadata),
    parentId: row.parent_id,
    embeddingId: row.embedding_id,
  };
}

export function mapReminder(row: ReminderRow): Reminder {
  return {
    id: row.id,
    itemId: row.item_id,
    remindAt: row.remind_at,
    status: row.status,
    kind: row.kind,
    targetChannel: row.target_channel,
    targetUserId: row.target_user_id,
    workflowId: row.workflow_id,
    createdAt: row.created_at,
    triggeredAt: row.triggered_at,
  };
}
