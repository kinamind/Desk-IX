import { findCalendarConflicts } from "../core/calendar";
import type { CalendarEntry, CalendarSnapshot, ChannelName, Priority, TemporalRole } from "../core/types";

const DEFAULT_EVENT_DURATION_MINUTES = 60;

interface CalendarItemRow {
  id: string;
  title: string;
  status: string;
  priority: Priority;
  due_at: string;
  estimated_duration: number | null;
  temporal_role: Extract<TemporalRole, "deadline" | "event" | "legacy">;
}

interface CalendarWorkSessionRow {
  id: string;
  item_id: string;
  item_title: string;
  item_priority: Priority;
  start_at: string;
  end_at: string;
  label: string | null;
  rationale: string;
  status: string;
}

interface CalendarReminderRow {
  id: string;
  item_id: string;
  item_title: string;
  item_priority: Priority;
  remind_at: string;
  kind: string;
  status: string;
}

export async function loadCalendarSnapshot(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  from: string,
  to: string,
): Promise<CalendarSnapshot> {
  const fromMs = parseRangeTime(from, "calendar start");
  const toMs = parseRangeTime(to, "calendar end");
  if (toMs <= fromMs) throw new Error("Calendar end must be after its start");
  const normalizedFrom = new Date(fromMs).toISOString();
  const normalizedTo = new Date(toMs).toISOString();
  const [items, workSessions, reminders] = await Promise.all([
    db.prepare(`
      SELECT id, title, status, priority, due_at, estimated_duration, temporal_role
      FROM items
      WHERE source_channel = ? AND source_user_id = ?
        AND status IN ('open', 'active', 'raw')
        AND due_at IS NOT NULL
        AND temporal_role IN ('deadline', 'event', 'legacy')
        AND (
          (temporal_role = 'deadline' AND due_at >= ? AND due_at < ?)
          OR (
            temporal_role IN ('event', 'legacy')
            AND due_at < ?
            AND julianday(due_at) + COALESCE(estimated_duration, 60) / 1440.0 > julianday(?)
          )
        )
      ORDER BY due_at ASC
    `).bind(channel, userId, normalizedFrom, normalizedTo, normalizedTo, normalizedFrom).all<CalendarItemRow>(),
    db.prepare(`
      SELECT w.id, w.item_id, i.title AS item_title, i.priority AS item_priority,
             w.start_at, w.end_at, w.label, w.rationale, w.status
      FROM work_sessions w JOIN items i ON i.id = w.item_id
      WHERE i.source_channel = ? AND i.source_user_id = ?
        AND i.status IN ('open', 'active', 'raw') AND w.status = 'planned'
        AND w.start_at < ? AND w.end_at > ?
      ORDER BY w.start_at ASC
    `).bind(channel, userId, normalizedTo, normalizedFrom).all<CalendarWorkSessionRow>(),
    db.prepare(`
      SELECT r.id, r.item_id, i.title AS item_title, i.priority AS item_priority,
             r.remind_at, r.kind, r.status
      FROM reminders r JOIN items i ON i.id = r.item_id
      WHERE r.target_channel = ? AND r.target_user_id = ?
        AND i.source_channel = ? AND i.source_user_id = ?
        AND i.status IN ('open', 'active', 'raw') AND r.status = 'pending'
        AND r.remind_at >= ? AND r.remind_at < ?
      ORDER BY r.remind_at ASC
    `).bind(channel, userId, channel, userId, normalizedFrom, normalizedTo).all<CalendarReminderRow>(),
  ]);
  const entries: CalendarEntry[] = [
    ...items.results.map(itemEntry),
    ...workSessions.results.map(workSessionEntry),
    ...reminders.results.map(reminderEntry),
  ].sort((left, right) => new Date(left.startAt).getTime() - new Date(right.startAt).getTime());
  return {
    from: normalizedFrom,
    to: normalizedTo,
    entries,
    conflicts: findCalendarConflicts(entries),
  };
}

function itemEntry(row: CalendarItemRow): CalendarEntry {
  const isDeadline = row.temporal_role === "deadline";
  return {
    id: row.id,
    itemId: row.id,
    kind: isDeadline ? "deadline" : "event",
    title: row.title,
    startAt: new Date(row.due_at).toISOString(),
    endAt: isDeadline
      ? null
      : new Date(new Date(row.due_at).getTime() + (row.estimated_duration ?? DEFAULT_EVENT_DURATION_MINUTES) * 60_000).toISOString(),
    blocksTime: !isDeadline,
    temporalRole: row.temporal_role,
    priority: row.priority,
    status: row.status,
    estimatedDuration: row.estimated_duration,
  };
}

function workSessionEntry(row: CalendarWorkSessionRow): CalendarEntry {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: "work_session",
    title: row.label ?? row.item_title,
    startAt: new Date(row.start_at).toISOString(),
    endAt: new Date(row.end_at).toISOString(),
    blocksTime: true,
    temporalRole: null,
    priority: row.item_priority,
    status: row.status,
    estimatedDuration: (new Date(row.end_at).getTime() - new Date(row.start_at).getTime()) / 60_000,
    label: row.label,
    rationale: row.rationale,
  };
}

function reminderEntry(row: CalendarReminderRow): CalendarEntry {
  return {
    id: row.id,
    itemId: row.item_id,
    kind: "reminder",
    title: `${row.item_title}（提醒）`,
    startAt: new Date(row.remind_at).toISOString(),
    endAt: null,
    blocksTime: false,
    temporalRole: null,
    priority: row.item_priority,
    status: row.status,
    reminderKind: row.kind,
  };
}

function parseRangeTime(value: string, label: string): number {
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) throw new Error(`Invalid ${label}`);
  return time;
}
