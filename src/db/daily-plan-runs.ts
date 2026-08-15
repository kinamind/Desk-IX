import type { ChannelName } from "../core/types";

export async function claimDailyPlanRun(
  db: D1Database,
  localDate: string,
  channel: ChannelName,
  userId: string,
  now = new Date(),
): Promise<boolean> {
  const timestamp = now.toISOString();
  const result = await db.prepare(`
    INSERT INTO daily_plan_runs (local_date, target_channel, target_user_id, status, updated_at)
    VALUES (?, ?, ?, 'sending', ?)
    ON CONFLICT(local_date, target_channel, target_user_id) DO UPDATE SET
      status = 'sending', attempts = daily_plan_runs.attempts + 1, updated_at = excluded.updated_at
    WHERE daily_plan_runs.status = 'failed' AND daily_plan_runs.attempts < 4
  `).bind(localDate, channel, userId, timestamp).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function finishDailyPlanRun(
  db: D1Database,
  localDate: string,
  channel: ChannelName,
  userId: string,
  content: string,
  now = new Date(),
): Promise<void> {
  await db.prepare(`
    UPDATE daily_plan_runs SET status = 'sent', content = ?, updated_at = ?, last_error = NULL
    WHERE local_date = ? AND target_channel = ? AND target_user_id = ?
  `).bind(content, now.toISOString(), localDate, channel, userId).run();
}

export async function failDailyPlanRun(
  db: D1Database,
  localDate: string,
  channel: ChannelName,
  userId: string,
  error: string,
  now = new Date(),
): Promise<void> {
  await db.prepare(`
    UPDATE daily_plan_runs SET status = 'failed', last_error = ?, updated_at = ?
    WHERE local_date = ? AND target_channel = ? AND target_user_id = ?
  `).bind(error.slice(0, 1000), now.toISOString(), localDate, channel, userId).run();
}
