ALTER TABLE messages ADD COLUMN claimed_at TEXT NOT NULL DEFAULT '';

UPDATE messages
SET claimed_at = COALESCE(processed_at, received_at)
WHERE claimed_at = '';
