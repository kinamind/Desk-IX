import type { ChannelName, DeliveryReceipt, Reminder } from "../core/types";
import { mapReminder, type ItemRow, type ReminderRow } from "./rows";
import { mapItem } from "./rows";

export interface ReminderDelivery {
  reminder: Reminder;
  item: ReturnType<typeof mapItem>;
}

interface ReminderDeliveryRow extends ItemRow {
  r_id: string;
  r_item_id: string;
  r_remind_at: string;
  r_status: Reminder["status"];
  r_kind: string;
  r_target_channel: ChannelName;
  r_target_user_id: string;
  r_workflow_id: string | null;
  r_created_at: string;
  r_triggered_at: string | null;
}

export async function createReminder(
  db: D1Database,
  input: {
    itemId: string;
    remindAt: string;
    kind: string;
    targetChannel: ChannelName;
    targetUserId: string;
  },
  now = new Date(),
): Promise<{ reminder: Reminder; created: boolean }> {
  const id = crypto.randomUUID();
  const createdAt = now.toISOString();
  const result = await db.prepare(`
    INSERT OR IGNORE INTO reminders (
      id, item_id, remind_at, status, kind, target_channel, target_user_id, created_at
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)
  `).bind(id, input.itemId, input.remindAt, input.kind, input.targetChannel, input.targetUserId, createdAt).run();

  let created = (result.meta.changes ?? 0) > 0;
  let row = created
    ? await db.prepare("SELECT * FROM reminders WHERE id = ?").bind(id).first<ReminderRow>()
    : await db.prepare(`
        SELECT * FROM reminders
        WHERE item_id = ? AND remind_at = ? AND kind = ? AND target_channel = ? AND target_user_id = ?
      `).bind(input.itemId, input.remindAt, input.kind, input.targetChannel, input.targetUserId).first<ReminderRow>();
  if (!row) throw new Error("Reminder insert did not return a row");

  // A transient Workflow API failure must not permanently poison this unique
  // reminder. Reclaim it on the next idempotent message-processing attempt.
  if (!created && row.status === "failed" && row.workflow_id === null) {
    await db.prepare(`
      UPDATE reminders
      SET status = 'pending', last_error = NULL, triggered_at = NULL
      WHERE id = ? AND status = 'failed' AND workflow_id IS NULL
    `).bind(row.id).run();
    row = { ...row, status: "pending", triggered_at: null };
    created = true;
  }
  return { reminder: mapReminder(row), created };
}

export async function setReminderWorkflowId(db: D1Database, id: string, workflowId: string): Promise<void> {
  await db.prepare("UPDATE reminders SET workflow_id = ? WHERE id = ?").bind(workflowId, id).run();
}

export async function loadReminderDelivery(db: D1Database, id: string): Promise<ReminderDelivery | null> {
  const row = await db.prepare(`
    SELECT
      r.id AS r_id, r.item_id AS r_item_id, r.remind_at AS r_remind_at,
      r.status AS r_status, r.kind AS r_kind, r.target_channel AS r_target_channel,
      r.target_user_id AS r_target_user_id, r.workflow_id AS r_workflow_id,
      r.created_at AS r_created_at, r.triggered_at AS r_triggered_at,
      i.*
    FROM reminders r JOIN items i ON i.id = r.item_id
    WHERE r.id = ?
  `).bind(id).first<ReminderDeliveryRow>();
  if (!row) return null;

  const reminderRow: ReminderRow = {
    id: row.r_id,
    item_id: row.r_item_id,
    remind_at: row.r_remind_at,
    status: row.r_status,
    kind: row.r_kind,
    target_channel: row.r_target_channel,
    target_user_id: row.r_target_user_id,
    workflow_id: row.r_workflow_id,
    created_at: row.r_created_at,
    triggered_at: row.r_triggered_at,
  };
  return { reminder: mapReminder(reminderRow), item: mapItem(row) };
}

export async function markReminderDelivering(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE reminders SET status = 'delivering' WHERE id = ? AND status = 'pending'
  `).bind(id).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function markReminderTriggered(
  db: D1Database,
  id: string,
  receipt: DeliveryReceipt,
  now = new Date(),
): Promise<void> {
  await db.prepare(`
    UPDATE reminders
    SET status = 'triggered', triggered_at = ?, delivery_receipt = ?, last_error = NULL
    WHERE id = ?
  `).bind(now.toISOString(), JSON.stringify(receipt), id).run();
}

export async function cancelOpenReminders(db: D1Database, itemId: string): Promise<void> {
  await db.prepare(`
    UPDATE reminders SET status = 'canceled'
    WHERE item_id = ? AND status IN ('pending', 'delivering')
  `).bind(itemId).run();
}

export async function markReminderFailed(db: D1Database, id: string, error: string): Promise<void> {
  await db.prepare(`
    UPDATE reminders SET status = 'failed', last_error = ? WHERE id = ?
  `).bind(error.slice(0, 1000), id).run();
}
