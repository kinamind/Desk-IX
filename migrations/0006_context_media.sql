PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  owner_channel TEXT NOT NULL CHECK (owner_channel IN ('telegram', 'qq')),
  owner_user_id TEXT NOT NULL,
  source_message_id TEXT NOT NULL,
  source_attachment_index INTEGER NOT NULL,
  attachment_context TEXT NOT NULL CHECK (attachment_context IN ('current', 'quoted')),
  kind TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'file', 'unknown')),
  source_url TEXT NOT NULL,
  media_type TEXT,
  filename TEXT,
  analysis_status TEXT NOT NULL DEFAULT 'raw'
    CHECK (analysis_status IN ('raw', 'analyzed', 'failed')),
  analysis_text TEXT,
  analysis_model TEXT,
  analysis_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_channel, owner_user_id, source_message_id, source_attachment_index)
);

CREATE INDEX IF NOT EXISTS idx_media_assets_owner_updated
  ON media_assets(owner_channel, owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_assets_source
  ON media_assets(owner_channel, owner_user_id, source_message_id);

CREATE TABLE IF NOT EXISTS context_entities (
  id TEXT PRIMARY KEY,
  owner_channel TEXT NOT NULL CHECK (owner_channel IN ('telegram', 'qq')),
  owner_user_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('self', 'person', 'organization', 'team', 'place', 'other')),
  canonical_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(owner_channel, owner_user_id, kind, normalized_name)
);

CREATE INDEX IF NOT EXISTS idx_context_entities_owner_updated
  ON context_entities(owner_channel, owner_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS context_entity_aliases (
  entity_id TEXT NOT NULL REFERENCES context_entities(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(entity_id, normalized_alias)
);

CREATE INDEX IF NOT EXISTS idx_context_aliases_normalized
  ON context_entity_aliases(normalized_alias, entity_id);

CREATE TABLE IF NOT EXISTS context_facts (
  id TEXT PRIMARY KEY,
  owner_channel TEXT NOT NULL CHECK (owner_channel IN ('telegram', 'qq')),
  owner_user_id TEXT NOT NULL,
  subject_entity_id TEXT NOT NULL REFERENCES context_entities(id) ON DELETE CASCADE,
  predicate TEXT NOT NULL,
  value TEXT NOT NULL,
  object_entity_id TEXT REFERENCES context_entities(id) ON DELETE SET NULL,
  context_item_id TEXT REFERENCES items(id) ON DELETE SET NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  sensitivity TEXT NOT NULL DEFAULT 'ordinary'
    CHECK (sensitivity IN ('ordinary', 'sensitive')),
  source_message_id TEXT NOT NULL,
  source_action_index INTEGER NOT NULL DEFAULT 0,
  source_fact_index INTEGER NOT NULL,
  valid_from TEXT,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'retracted', 'superseded')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(owner_channel, owner_user_id, source_message_id, source_action_index, source_fact_index)
);

CREATE INDEX IF NOT EXISTS idx_context_facts_subject_status
  ON context_facts(subject_entity_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_facts_owner_status
  ON context_facts(owner_channel, owner_user_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_facts_item
  ON context_facts(context_item_id, status);

CREATE TABLE IF NOT EXISTS item_context_entities (
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES context_entities(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(item_id, entity_id, role)
);

CREATE INDEX IF NOT EXISTS idx_item_context_entities_entity
  ON item_context_entities(entity_id, item_id);
