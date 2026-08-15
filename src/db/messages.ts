import type { IncomingMessage } from "../core/types";

interface MessageClaimRow {
  id: string;
  status: string;
  item_id: string | null;
  response_text: string | null;
  claimed_at: string;
}

export interface MessageClaim {
  claimed: boolean;
  id: string;
  status: string;
  itemId: string | null;
  responseText: string | null;
}

export async function claimMessage(db: D1Database, message: IncomingMessage, now = new Date()): Promise<MessageClaim> {
  const id = crypto.randomUUID();
  const claimedAt = now.toISOString();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO messages (
      id, channel, source_message_id, user_id, event_type, text, received_at, claimed_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'processing')
  `).bind(
    id,
    message.channel,
    message.eventId,
    message.userId,
    message.eventType,
    message.text,
    message.timestamp,
    claimedAt,
  ).run();

  if ((result.meta.changes ?? 0) > 0) {
    return { claimed: true, id, status: "processing", itemId: null, responseText: null };
  }

  const existing = await db.prepare(`
    SELECT id, status, item_id, response_text, claimed_at
    FROM messages WHERE channel = ? AND source_message_id = ?
  `).bind(message.channel, message.eventId).first<MessageClaimRow>();
  if (!existing) throw new Error("Duplicate message row disappeared");
  const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  if (existing.status === "failed" || (existing.status === "processing" && existing.claimed_at <= staleBefore)) {
    const reclaimed = await db.prepare(`
      UPDATE messages
      SET status = 'processing', error = NULL, processed_at = NULL, claimed_at = ?
      WHERE id = ? AND (
        status = 'failed' OR (status = 'processing' AND claimed_at <= ?)
      )
    `).bind(claimedAt, existing.id, staleBefore).run();
    if ((reclaimed.meta.changes ?? 0) > 0) {
      return { claimed: true, id: existing.id, status: "processing", itemId: existing.item_id, responseText: existing.response_text };
    }
  }
  return {
    claimed: false,
    id: existing.id,
    status: existing.status,
    itemId: existing.item_id,
    responseText: existing.response_text,
  };
}

export async function finishMessage(
  db: D1Database,
  id: string,
  responseText: string,
  itemId: string | null,
  now = new Date(),
): Promise<void> {
  await db.prepare(`
    UPDATE messages
    SET status = 'processed', processed_at = ?, response_text = ?, item_id = ?, error = NULL
    WHERE id = ?
  `).bind(now.toISOString(), responseText, itemId, id).run();
}

export async function failMessage(db: D1Database, id: string, error: string, now = new Date()): Promise<void> {
  await db.prepare(`
    UPDATE messages SET status = 'failed', processed_at = ?, error = ? WHERE id = ?
  `).bind(now.toISOString(), error.slice(0, 1000), id).run();
}
