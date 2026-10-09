ALTER TABLE tasks ADD COLUMN dispatch_mode TEXT;
ALTER TABLE tasks ADD COLUMN dispatch_status TEXT NOT NULL DEFAULT 'not_started';
ALTER TABLE tasks ADD COLUMN dispatch_summary TEXT;
ALTER TABLE tasks ADD COLUMN dispatch_started_at TEXT;
ALTER TABLE tasks ADD COLUMN dispatch_finished_at TEXT;
