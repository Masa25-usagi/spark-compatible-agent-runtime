CREATE TABLE IF NOT EXISTS event_queue (
  event_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'failed', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_queue_status ON event_queue(status, updated_at);

ALTER TABLE trigger_events ADD COLUMN event_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_trigger_events_event_id ON trigger_events(event_id);

CREATE TABLE IF NOT EXISTS runtime_leases (
  lease_id TEXT PRIMARY KEY,
  owner_pid INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runtime_leases_expiry ON runtime_leases(expires_at);
