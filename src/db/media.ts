import type { AttachmentKind, ChannelName, IncomingMessage } from "../core/types";

export interface MediaAsset {
  id: string;
  kind: AttachmentKind;
  context: "current" | "quoted";
  mediaType: string | null;
  filename: string | null;
  analysisStatus: "raw" | "analyzed" | "failed";
  analysisText: string | null;
  analysisModel: string | null;
  analysisError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MediaAssetRow {
  id: string;
  kind: AttachmentKind;
  attachment_context: "current" | "quoted";
  media_type: string | null;
  filename: string | null;
  analysis_status: MediaAsset["analysisStatus"];
  analysis_text: string | null;
  analysis_model: string | null;
  analysis_error: string | null;
  created_at: string;
  updated_at: string;
}

interface OwnedMediaAssetRow extends MediaAssetRow {
  source_url: string;
}

export interface OwnedMediaAsset extends MediaAsset {
  sourceUrl: string;
}

export async function saveIncomingMediaAssets(
  db: D1Database,
  message: IncomingMessage,
  now = new Date(),
): Promise<MediaAsset[]> {
  const attachments = message.attachments ?? [];
  const timestamp = now.toISOString();
  for (const [index, attachment] of attachments.entries()) {
    await db.prepare(`
      INSERT INTO media_assets (
        id, owner_channel, owner_user_id, source_message_id, source_attachment_index,
        attachment_context, kind, source_url, media_type, filename, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(owner_channel, owner_user_id, source_message_id, source_attachment_index)
      DO UPDATE SET
        attachment_context = excluded.attachment_context,
        kind = excluded.kind,
        source_url = excluded.source_url,
        media_type = COALESCE(excluded.media_type, media_type),
        filename = COALESCE(excluded.filename, filename),
        updated_at = excluded.updated_at
    `).bind(
      crypto.randomUUID(),
      message.channel,
      message.userId,
      message.eventId,
      index,
      attachment.context,
      attachment.kind,
      attachment.url,
      attachment.mediaType,
      attachment.filename,
      timestamp,
      timestamp,
    ).run();
  }
  const rows = await db.prepare(`
    SELECT id, kind, attachment_context, media_type, filename, analysis_status,
           analysis_text, analysis_model, analysis_error, created_at, updated_at
    FROM media_assets
    WHERE owner_channel = ? AND owner_user_id = ? AND source_message_id = ?
    ORDER BY source_attachment_index ASC
  `).bind(message.channel, message.userId, message.eventId).all<MediaAssetRow>();
  return rows.results.map(mapMediaAsset);
}

export async function getOwnedMediaAssets(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  ids: string[],
): Promise<OwnedMediaAsset[]> {
  const uniqueIds = Array.from(new Set(ids));
  if (uniqueIds.length === 0) return [];
  const rows = await db.prepare(`
    SELECT id, kind, attachment_context, source_url, media_type, filename,
           analysis_status, analysis_text, analysis_model, analysis_error,
           created_at, updated_at
    FROM media_assets
    WHERE id IN (${uniqueIds.map(() => "?").join(", ")})
      AND owner_channel = ? AND owner_user_id = ?
  `).bind(...uniqueIds, channel, userId).all<OwnedMediaAssetRow>();
  return rows.results.map((row) => ({ ...mapMediaAsset(row), sourceUrl: row.source_url }));
}

export async function markOwnedMediaAnalyzed(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  ids: string[],
  analysis: { text: string; model: string },
  now = new Date(),
): Promise<number> {
  let changed = 0;
  for (const id of Array.from(new Set(ids))) {
    const result = await db.prepare(`
      UPDATE media_assets
      SET analysis_status = 'analyzed', analysis_text = ?, analysis_model = ?,
          analysis_error = NULL, updated_at = ?
      WHERE id = ? AND owner_channel = ? AND owner_user_id = ?
    `).bind(analysis.text, analysis.model, now.toISOString(), id, channel, userId).run();
    changed += result.meta.changes ?? 0;
  }
  return changed;
}

export async function markOwnedMediaFailed(
  db: D1Database,
  channel: ChannelName,
  userId: string,
  id: string,
  error: string,
  now = new Date(),
): Promise<boolean> {
  const result = await db.prepare(`
    UPDATE media_assets
    SET analysis_status = 'failed', analysis_error = ?, updated_at = ?
    WHERE id = ? AND owner_channel = ? AND owner_user_id = ?
  `).bind(error.slice(0, 500), now.toISOString(), id, channel, userId).run();
  return (result.meta.changes ?? 0) > 0;
}

function mapMediaAsset(row: MediaAssetRow): MediaAsset {
  return {
    id: row.id,
    kind: row.kind,
    context: row.attachment_context,
    mediaType: row.media_type,
    filename: row.filename,
    analysisStatus: row.analysis_status,
    analysisText: row.analysis_text,
    analysisModel: row.analysis_model,
    analysisError: row.analysis_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
