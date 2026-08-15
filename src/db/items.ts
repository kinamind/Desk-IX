import type { CreateItemInput, Item, ItemSearchFilters } from "../core/types";
import { mapItem, type ItemRow } from "./rows";

export async function createItem(db: D1Database, input: CreateItemInput, now = new Date()): Promise<Item> {
  const id = crypto.randomUUID();
  const timestamp = now.toISOString();
  await db.prepare(`
    INSERT INTO items (
      id, type, title, content, raw_message, url, tags, status, priority,
      estimated_duration, created_at, updated_at, due_at, start_after,
      original_time_expression, source_channel, source_user_id, source_message_id,
      ai_enrichment, metadata, parent_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

export async function getItemBySource(db: D1Database, channel: string, sourceMessageId: string): Promise<Item | null> {
  const row = await db.prepare(
    "SELECT * FROM items WHERE source_channel = ? AND source_message_id = ? AND parent_id IS NULL LIMIT 1",
  ).bind(channel, sourceMessageId).first<ItemRow>();
  return row ? mapItem(row) : null;
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
  const clauses: string[] = [];
  const values: Array<string | number> = [];

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
    clauses.push("(title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR raw_message LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
    const escaped = filters.keyword.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
    const pattern = `%${escaped}%`;
    values.push(pattern, pattern, pattern, pattern);
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
