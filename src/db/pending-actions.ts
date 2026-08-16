import type { ChannelName } from "../core/types";

export interface PendingAction {
  channel: ChannelName;
  userId: string;
  action: string;
  itemId: string;
  createdAt: string;
  expiresAt: string;
}

interface PendingActionRow {
  channel: ChannelName;
  user_id: string;
  action: string;
  item_id: string;
  created_at: string;
  expires_at: string;
}

export async function setPendingAction(
  db: D1Database,
  input: { channel: ChannelName; userId: string; action: string; itemId: string },
  now = new Date(),
  ttlMinutes = 30,
): Promise<void> {
  const expiresAt = new Date(now.getTime() + ttlMinutes * 60_000).toISOString();
  await db.prepare(`
    INSERT INTO pending_actions (channel, user_id, action, item_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel, user_id) DO UPDATE SET
      action = excluded.action,
      item_id = excluded.item_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `).bind(input.channel, input.userId, input.action, input.itemId, now.toISOString(), expiresAt).run();
}

export async function takePendingAction(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  now = new Date(),
): Promise<PendingAction | null> {
  const row = await db.prepare(`
    SELECT * FROM pending_actions WHERE channel = ? AND user_id = ?
  `).bind(channel, userId).first<PendingActionRow>();
  if (!row) return null;
  await db.prepare("DELETE FROM pending_actions WHERE channel = ? AND user_id = ?").bind(channel, userId).run();
  if (row.expires_at <= now.toISOString()) return null;
  return {
    channel: row.channel,
    userId: row.user_id,
    action: row.action,
    itemId: row.item_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function getPendingAction(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  now = new Date(),
): Promise<PendingAction | null> {
  const row = await db.prepare(`
    SELECT * FROM pending_actions
    WHERE channel = ? AND user_id = ? AND expires_at > ?
    LIMIT 1
  `).bind(channel, userId, now.toISOString()).first<PendingActionRow>();
  if (!row) return null;
  return {
    channel: row.channel,
    userId: row.user_id,
    action: row.action,
    itemId: row.item_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export async function clearPendingAction(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  itemId?: string,
): Promise<void> {
  if (itemId) {
    await db.prepare(`
      DELETE FROM pending_actions WHERE channel = ? AND user_id = ? AND item_id = ?
    `).bind(channel, userId, itemId).run();
    return;
  }
  await db.prepare("DELETE FROM pending_actions WHERE channel = ? AND user_id = ?").bind(channel, userId).run();
}
