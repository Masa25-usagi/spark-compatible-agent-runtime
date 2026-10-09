CREATE TABLE IF NOT EXISTS skills (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  instructions TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skills_enabled_name ON skills(enabled, name);
