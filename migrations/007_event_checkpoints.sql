CREATE TABLE IF NOT EXISTS event_workflows (
  event_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  next_index INTEGER NOT NULL CHECK (next_index >= 0),
  expected_approval_action_id TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('running', 'waiting_for_approval', 'completed', 'failed', 'take_control', 'denied')
  ),
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_workflows_task_status
  ON event_workflows(task_id, status, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_workflows_expected_approval_action
  ON event_workflows(expected_approval_action_id)
  WHERE expected_approval_action_id IS NOT NULL;
