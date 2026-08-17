ALTER TABLE items ADD COLUMN temporal_role TEXT NOT NULL DEFAULT 'legacy'
  CHECK (temporal_role IN ('none', 'deadline', 'event', 'legacy'));

CREATE TABLE IF NOT EXISTS work_sessions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  label TEXT,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'planned'
    CHECK (status IN ('planned', 'completed', 'canceled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (start_at < end_at)
);

CREATE INDEX IF NOT EXISTS idx_work_sessions_item_status
  ON work_sessions(item_id, status);
CREATE INDEX IF NOT EXISTS idx_work_sessions_time_status
  ON work_sessions(start_at, end_at, status);
