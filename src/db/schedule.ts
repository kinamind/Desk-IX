import type { ChannelName, ScheduleWindow } from "../core/types";

const DEFAULT_EVENT_DURATION_MINUTES = 60;
const REMINDER_SLOT_MINUTES = 1;
const DEFAULT_HORIZON_DAYS = 14;

interface ScheduledItemRow {
  id: string;
  title: string;
  due_at: string;
  estimated_duration: number | null;
}

interface ScheduledReminderRow {
  item_id: string;
  title: string;
  remind_at: string;
}

interface WorkSessionRow {
  item_id: string;
  item_title: string;
  label: string | null;
  start_at: string;
  end_at: string;
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

export async function listScheduleWindows(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  now = new Date(),
  horizonDays = DEFAULT_HORIZON_DAYS,
): Promise<ScheduleWindow[]> {
  const startAt = now.toISOString();
  const endAt = new Date(now.getTime() + Math.max(1, horizonDays) * 86_400_000).toISOString();
  const [items, reminders, workSessions] = await Promise.all([
    db.prepare(`
      SELECT id, title, due_at, estimated_duration
      FROM items
      WHERE source_channel = ? AND source_user_id = ?
        AND status IN ('open', 'active', 'raw')
        AND temporal_role IN ('event', 'legacy')
        AND due_at IS NOT NULL
        AND julianday(due_at) + COALESCE(estimated_duration, 60) / 1440.0 >= julianday(?)
        AND due_at <= ?
      ORDER BY due_at ASC
    `).bind(channel, userId, startAt, endAt).all<ScheduledItemRow>(),
    db.prepare(`
      SELECT r.item_id, i.title, r.remind_at
      FROM reminders r JOIN items i ON i.id = r.item_id
      WHERE r.target_channel = ? AND r.target_user_id = ?
        AND r.status = 'pending' AND i.status IN ('open', 'active', 'raw')
        AND r.remind_at >= ? AND r.remind_at <= ?
      ORDER BY r.remind_at ASC
    `).bind(channel, userId, startAt, endAt).all<ScheduledReminderRow>(),
    db.prepare(`
      SELECT w.item_id, i.title AS item_title, w.label, w.start_at, w.end_at
      FROM work_sessions w JOIN items i ON i.id = w.item_id
      WHERE i.source_channel = ? AND i.source_user_id = ?
        AND i.status IN ('open', 'active', 'raw') AND w.status = 'planned'
        AND w.end_at >= ? AND w.start_at <= ?
      ORDER BY w.start_at ASC
    `).bind(channel, userId, startAt, endAt).all<WorkSessionRow>(),
  ]);

  return [
    ...items.results.map((item): ScheduleWindow => ({
      itemId: item.id,
      title: item.title,
      startAt: item.due_at,
      endAt: addMinutes(item.due_at, item.estimated_duration ?? DEFAULT_EVENT_DURATION_MINUTES),
      source: "item",
    })),
    ...reminders.results.map((reminder): ScheduleWindow => ({
      itemId: reminder.item_id,
      title: `${reminder.title}（提醒）`,
      startAt: reminder.remind_at,
      endAt: addMinutes(reminder.remind_at, REMINDER_SLOT_MINUTES),
      source: "reminder",
    })),
    ...workSessions.results.map((session): ScheduleWindow => ({
      itemId: session.item_id,
      title: session.label ?? session.item_title,
      startAt: session.start_at,
      endAt: session.end_at,
      source: "work_session",
    })),
  ].sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime());
}
