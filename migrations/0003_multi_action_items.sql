ALTER TABLE items ADD COLUMN source_action_index INTEGER NOT NULL DEFAULT 0;

DROP INDEX IF EXISTS idx_items_source_message;

CREATE UNIQUE INDEX idx_items_source_message_action
  ON items(source_channel, source_message_id, source_action_index)
  WHERE parent_id IS NULL;
