CREATE TABLE IF NOT EXISTS trigger_events (
  source TEXT NOT NULL,
  event_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (source, event_key)
);

CREATE INDEX IF NOT EXISTS idx_trigger_events_received ON trigger_events(received_at);
