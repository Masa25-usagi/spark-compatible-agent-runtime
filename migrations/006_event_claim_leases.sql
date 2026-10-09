ALTER TABLE event_queue ADD COLUMN claim_token TEXT;
ALTER TABLE event_queue ADD COLUMN claim_owner_pid INTEGER;
ALTER TABLE event_queue ADD COLUMN claim_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_event_queue_claim_expiry
  ON event_queue(status, claim_expires_at, updated_at);
