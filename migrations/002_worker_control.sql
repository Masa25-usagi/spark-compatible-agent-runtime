CREATE TABLE IF NOT EXISTS worker_tasks (
  task_id TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  pause_reason TEXT,
  enqueued_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL,
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_worker_tasks_status ON worker_tasks(status, paused);

CREATE TABLE IF NOT EXISTS schedule_controls (
  schedule_id TEXT PRIMARY KEY,
  paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
  enabled_before_pause INTEGER NOT NULL CHECK (enabled_before_pause IN (0, 1)),
  reason TEXT,
  updated_at TEXT NOT NULL
);
