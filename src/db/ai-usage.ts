export async function getAIRequests(db: D1Database, localDate: string, provider: string): Promise<number> {
  const row = await db.prepare(
    "SELECT requests FROM ai_usage WHERE local_date = ? AND provider = ?",
  ).bind(localDate, provider).first<{ requests: number }>();
  return row?.requests ?? 0;
}

export async function recordAIUsage(
  db: D1Database,
  localDate: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
  now = new Date(),
): Promise<void> {
  await db.prepare(`
    INSERT INTO ai_usage (local_date, provider, requests, input_tokens, output_tokens, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(local_date, provider) DO UPDATE SET
      requests = ai_usage.requests + 1,
      input_tokens = ai_usage.input_tokens + excluded.input_tokens,
      output_tokens = ai_usage.output_tokens + excluded.output_tokens,
      updated_at = excluded.updated_at
  `).bind(localDate, provider, inputTokens, outputTokens, now.toISOString()).run();
}
