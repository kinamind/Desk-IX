import type { ChannelName, WorkSession } from "../core/types";

interface WorkSessionRow {
  id: string;
  item_id: string;
  start_at: string;
  end_at: string;
  label: string | null;
  rationale: string;
  status: WorkSession["status"];
  created_at: string;
  updated_at: string;
}

export interface WorkSessionInput {
  startAt: string;
  endAt: string;
  label?: string;
}

export interface WorkSessionPlanInput {
  itemId: string;
  sessions: WorkSessionInput[];
}

function mapWorkSession(row: WorkSessionRow): WorkSession {
  return {
    id: row.id,
    itemId: row.item_id,
    startAt: row.start_at,
    endAt: row.end_at,
    label: row.label,
    rationale: row.rationale,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function replaceWorkSessions(
  db: D1Database,
  itemId: string,
  sessions: WorkSessionInput[],
  rationale: string,
  now = new Date(),
): Promise<WorkSession[]> {
  return replaceWorkSessionPlans(db, [{ itemId, sessions }], rationale, now);
}

export async function replaceWorkSessionPlans(
  db: D1Database,
  plans: WorkSessionPlanInput[],
  rationale: string,
  now = new Date(),
): Promise<WorkSession[]> {
  if (plans.length === 0) return [];
  const timestamp = now.toISOString();
  const insertions = plans.flatMap((plan) => plan.sessions.map((session) => ({
    id: crypto.randomUUID(),
    itemId: plan.itemId,
    session,
  })));
  const statements = plans.map((plan) => db.prepare(`
      UPDATE work_sessions
      SET status = 'canceled', updated_at = ?
      WHERE item_id = ? AND status = 'planned'
    `).bind(timestamp, plan.itemId));
  statements.push(...insertions.map(({ id, itemId, session }) => db.prepare(`
      INSERT INTO work_sessions (
        id, item_id, start_at, end_at, label, rationale, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'planned', ?, ?)
    `).bind(
      id,
      itemId,
      session.startAt,
      session.endAt,
      session.label ?? null,
      rationale,
      timestamp,
      timestamp,
    )));
  await db.batch(statements);
  return listWorkSessionsByIds(db, insertions.map((insertion) => insertion.id));
}

export async function listOwnedWorkSessions(
  db: D1Database,
  itemId: string,
  channel: ChannelName,
  userId: string,
): Promise<WorkSession[]> {
  const result = await db.prepare(`
    SELECT w.*
    FROM work_sessions w JOIN items i ON i.id = w.item_id
    WHERE w.item_id = ? AND i.source_channel = ? AND i.source_user_id = ?
    ORDER BY w.start_at ASC, w.created_at ASC
  `).bind(itemId, channel, userId).all<WorkSessionRow>();
  return result.results.map(mapWorkSession);
}

export async function cancelOpenWorkSessions(
  db: D1Database,
  itemId: string,
  now = new Date(),
): Promise<number> {
  const result = await db.prepare(`
    UPDATE work_sessions
    SET status = 'canceled', updated_at = ?
    WHERE item_id = ? AND status = 'planned'
  `).bind(now.toISOString(), itemId).run();
  return result.meta.changes ?? 0;
}

async function listWorkSessionsByIds(db: D1Database, ids: string[]): Promise<WorkSession[]> {
  if (ids.length === 0) return [];
  const result = await db.prepare(`
    SELECT * FROM work_sessions
    WHERE id IN (${ids.map(() => "?").join(", ")})
    ORDER BY start_at ASC
  `).bind(...ids).all<WorkSessionRow>();
  return result.results.map(mapWorkSession);
}
