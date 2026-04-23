ALTER TABLE tasks ADD COLUMN archived_at TEXT;

CREATE INDEX IF NOT EXISTS tasks_archived_status_priority_idx
ON tasks(archived_at, status, priority);
