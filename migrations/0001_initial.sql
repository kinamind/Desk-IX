PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('resource', 'idea', 'task', 'note', 'project')),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  raw_message TEXT NOT NULL,
  url TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  estimated_duration INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  due_at TEXT,
  start_after TEXT,
  original_time_expression TEXT,
  source_channel TEXT NOT NULL CHECK (source_channel IN ('telegram', 'qq')),
  source_user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  ai_enrichment TEXT NOT NULL DEFAULT '{}',
  metadata TEXT NOT NULL DEFAULT '{}',
  parent_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  embedding_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_type_status ON items(type, status);
CREATE INDEX IF NOT EXISTS idx_items_due_status ON items(due_at, status);
CREATE INDEX IF NOT EXISTS idx_items_start_after ON items(start_after);
CREATE INDEX IF NOT EXISTS idx_items_created_at ON items(created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_items_source_message
  ON items(source_channel, source_message_id)
  WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  remind_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivering', 'triggered', 'canceled', 'failed')),
  kind TEXT NOT NULL DEFAULT 'reminder',
  target_channel TEXT NOT NULL CHECK (target_channel IN ('telegram', 'qq')),
  target_user_id TEXT NOT NULL,
  workflow_id TEXT,
  created_at TEXT NOT NULL,
  triggered_at TEXT,
  delivery_receipt TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_reminders_item_status ON reminders(item_id, status);
CREATE INDEX IF NOT EXISTS idx_reminders_time_status ON reminders(remind_at, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_item_time_kind
  ON reminders(item_id, remind_at, kind, target_channel, target_user_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'qq')),
  source_message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  processed_at TEXT,
  status TEXT NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'processed', 'failed')),
  item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  response_text TEXT,
  error TEXT,
  UNIQUE(channel, source_message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

CREATE TABLE IF NOT EXISTS pending_actions (
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'qq')),
  user_id TEXT NOT NULL,
  action TEXT NOT NULL,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(channel, user_id)
);

CREATE TABLE IF NOT EXISTS daily_plan_runs (
  local_date TEXT NOT NULL,
  target_channel TEXT NOT NULL CHECK (target_channel IN ('telegram', 'qq')),
  target_user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed')),
  content TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL,
  last_error TEXT,
  PRIMARY KEY(local_date, target_channel, target_user_id)
);

CREATE TABLE IF NOT EXISTS ai_usage (
  local_date TEXT NOT NULL,
  provider TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(local_date, provider)
);
