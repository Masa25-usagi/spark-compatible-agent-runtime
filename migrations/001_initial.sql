CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  profile TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  harness TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  current_step TEXT NOT NULL,
  planned_steps_json TEXT NOT NULL,
  completed_steps_json TEXT NOT NULL,
  pending_steps_json TEXT NOT NULL,
  used_skills_json TEXT NOT NULL,
  used_connectors_json TEXT NOT NULL,
  files_read_json TEXT NOT NULL,
  files_created_json TEXT NOT NULL,
  files_changed_json TEXT NOT NULL,
  pending_approval_ids_json TEXT NOT NULL,
  errors_json TEXT NOT NULL,
  retries INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT,
  take_control_reason TEXT
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL,
  next_run_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  action_json TEXT NOT NULL,
  status TEXT NOT NULL,
  confirmation_required INTEGER NOT NULL,
  disclosure_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_reason TEXT,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_approvals_task_status ON approvals(task_id, status);
CREATE INDEX IF NOT EXISTS idx_events_task_time ON runtime_events(task_id, occurred_at);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  timestamp TEXT NOT NULL,
  task_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  model TEXT NOT NULL,
  harness TEXT NOT NULL,
  tool TEXT NOT NULL,
  args_json TEXT NOT NULL,
  approval_json TEXT,
  decision TEXT,
  result_json TEXT,
  changed_targets_json TEXT NOT NULL,
  undo_guidance TEXT,
  previous_hash TEXT,
  event_hash TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_task_sequence ON audit_events(task_id, sequence);
