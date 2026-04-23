CREATE TABLE IF NOT EXISTS task_attachments (
  id             TEXT PRIMARY KEY,
  task_id        TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  original_name  TEXT NOT NULL,
  stored_path    TEXT NOT NULL,
  mime_type      TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  category       TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_attachments_task_idx ON task_attachments(task_id);
