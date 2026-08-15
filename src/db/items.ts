import type { ChannelName, CreateItemInput, Item, ItemSearchFilters, UpdateItemInput } from "../core/types";
import { mapItem, type ItemRow } from "./rows";

export async function createItem(db: D1Database, input: CreateItemInput, now = new Date()): Promise<Item> {
  const id = crypto.randomUUID();
  const timestamp = now.toISOString();
  await db.prepare(`
    INSERT INTO items (
      id, type, title, content, raw_message, url, tags, status, priority,
      estimated_duration, created_at, updated_at, due_at, start_after,
      original_time_expression, source_channel, source_user_id, source_message_id,
      source_action_index, ai_enrichment, metadata, parent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    input.type,
    input.title,
    input.content,
    input.rawMessage,
    input.url ?? null,
    JSON.stringify(input.tags ?? []),
    input.status ?? (input.type === "idea" ? "raw" : "open"),
    input.priority ?? "normal",
    input.estimatedDuration ?? null,
    timestamp,
    timestamp,
    input.dueAt ?? null,
    input.startAfter ?? null,
    input.originalTimeExpression ?? null,
    input.sourceChannel,
    input.sourceUserId,
    input.sourceMessageId,
    input.sourceActionIndex ?? 0,
    JSON.stringify(input.aiEnrichment ?? {}),
    JSON.stringify(input.metadata ?? {}),
    input.parentId ?? null,
  ).run();

  const created = await getItem(db, id);
  if (!created) throw new Error("Item insert did not return a row");
  return created;
}

export async function getItem(db: D1Database, id: string): Promise<Item | null> {
  const row = await db.prepare("SELECT * FROM items WHERE id = ?").bind(id).first<ItemRow>();
  return row ? mapItem(row) : null;
}

export async function getItemBySource(db: D1Database, channel: string, sourceMessageId: string, sourceActionIndex = 0): Promise<Item | null> {
  const row = await db.prepare(
    "SELECT * FROM items WHERE source_channel = ? AND source_message_id = ? AND source_action_index = ? AND parent_id IS NULL LIMIT 1",
  ).bind(channel, sourceMessageId, sourceActionIndex).first<ItemRow>();
  return row ? mapItem(row) : null;
}

export async function getOwnedItem(db: D1Database, id: string, channel: ChannelName, userId: string): Promise<Item | null> {
  const row = await db.prepare(
    "SELECT * FROM items WHERE id = ? AND source_channel = ? AND source_user_id = ? LIMIT 1",
  ).bind(id, channel, userId).first<ItemRow>();
  return row ? mapItem(row) : null;
}

export async function listAgentContextItems(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  limit = 20,
): Promise<Item[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 30);
  const result = await db.prepare(`
    SELECT * FROM items
    WHERE source_channel = ? AND source_user_id = ?
    ORDER BY
      updated_at DESC,
      CASE status WHEN 'open' THEN 0 WHEN 'active' THEN 1 WHEN 'raw' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END
    LIMIT ?
  `).bind(channel, userId, boundedLimit).all<ItemRow>();
  return result.results.map(mapItem);
}

export async function completeItem(db: D1Database, id: string, now = new Date()): Promise<boolean> {
  const timestamp = now.toISOString();
  const result = await db.prepare(`
    UPDATE items
    SET status = 'completed', completed_at = ?, updated_at = ?
    WHERE id = ? AND status != 'completed'
  `).bind(timestamp, timestamp, id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function archiveItem(db: D1Database, id: string, now = new Date()): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE items
    SET status = 'archived', completed_at = NULL, updated_at = ?
    WHERE id = ? AND status != 'archived'
  `).bind(now.toISOString(), id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function restoreItem(db: D1Database, id: string, now = new Date()): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE items
    SET status = 'open', completed_at = NULL, updated_at = ?
    WHERE id = ? AND status IN ('completed', 'archived')
  `).bind(now.toISOString(), id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateItem(db: D1Database, id: string, input: UpdateItemInput, now = new Date()): Promise<boolean> {
  const assignments: string[] = [];
  const values: Array<string | number | null> = [];
  const add = (column: string, value: string | number | null): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (input.title !== undefined) add("title", input.title);
  if (input.content !== undefined) add("content", input.content);
  if (input.tags !== undefined) add("tags", JSON.stringify(input.tags));
  if (input.priority !== undefined) add("priority", input.priority);
  if (input.estimatedDuration !== undefined) add("estimated_duration", input.estimatedDuration);
  if (input.dueAt !== undefined) add("due_at", input.dueAt);
  if (input.startAfter !== undefined) add("start_after", input.startAfter);
  if (input.originalTimeExpression !== undefined) add("original_time_expression", input.originalTimeExpression);
  if (assignments.length === 0) return false;
  add("updated_at", now.toISOString());
  values.push(id);
  const result = await db.prepare(`UPDATE items SET ${assignments.join(", ")} WHERE id = ?`).bind(...values).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateItemSchedule(
  db: D1Database,
  id: string,
  dueAt: string,
  originalExpression: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE items SET due_at = ?, original_time_expression = ?, updated_at = ? WHERE id = ?
  `).bind(dueAt, originalExpression, now.toISOString(), id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function mergeItemEnrichment(
  db: D1Database,
  id: string,
  enrichment: Record<string, unknown>,
  metadata: Record<string, unknown>,
  title?: string,
  now = new Date(),
): Promise<void> {
  await db.prepare(`
    UPDATE items
    SET ai_enrichment = ?, metadata = ?, title = COALESCE(?, title), updated_at = ?
    WHERE id = ?
  `).bind(JSON.stringify(enrichment), JSON.stringify(metadata), title ?? null, now.toISOString(), id).run();
}

export async function searchItems(db: D1Database, filters: ItemSearchFilters = {}): Promise<Item[]> {
  return searchItemsWithScope(db, filters);
}

export async function searchOwnedItems(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  filters: ItemSearchFilters = {},
): Promise<Item[]> {
  return searchItemsWithScope(db, filters, { channel, userId });
}

async function searchItemsWithScope(
  db: D1Database,
  filters: ItemSearchFilters,
  scope?: { channel: ChannelName; userId: string },
): Promise<Item[]> {
  const clauses: string[] = [];
  const values: Array<string | number> = [];

  if (scope) {
    clauses.push("source_channel = ?", "source_user_id = ?");
    values.push(scope.channel, scope.userId);
  }

  if (filters.type) {
    clauses.push("type = ?");
    values.push(filters.type);
  }
  if (filters.statuses && filters.statuses.length > 0) {
    clauses.push(`status IN (${filters.statuses.map(() => "?").join(", ")})`);
    values.push(...filters.statuses);
  }
  if (filters.dueFrom) {
    clauses.push("due_at >= ?");
    values.push(filters.dueFrom);
  }
  if (filters.dueTo) {
    clauses.push("due_at < ?");
    values.push(filters.dueTo);
  }
  if (filters.createdFrom) {
    clauses.push("created_at >= ?");
    values.push(filters.createdFrom);
  }
  if (filters.keyword) {
    clauses.push("(instr(lower(title), lower(?)) > 0 OR instr(lower(content), lower(?)) > 0 OR instr(lower(raw_message), lower(?)) > 0 OR instr(lower(tags), lower(?)) > 0)");
    const boundedKeyword = filters.keyword.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    values.push(boundedKeyword, boundedKeyword, boundedKeyword, boundedKeyword);
  }

  const limit = Math.min(Math.max(filters.limit ?? 10, 1), 50);
  values.push(limit);
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const result = await db.prepare(`
    SELECT * FROM items ${where}
    ORDER BY
      CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
      CASE WHEN due_at IS NULL THEN 1 ELSE 0 END,
      due_at ASC,
      created_at DESC
    LIMIT ?
  `).bind(...values).all<ItemRow>();
  return result.results.map(mapItem);
}
