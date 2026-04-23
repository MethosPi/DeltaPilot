ALTER TABLE agents ADD COLUMN role TEXT NOT NULL DEFAULT 'executor';
ALTER TABLE agents ADD COLUMN runtime_mode TEXT NOT NULL DEFAULT 'external';
ALTER TABLE agents ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN cooldown_until TEXT;
ALTER TABLE agents ADD COLUMN last_limit_reason TEXT;

ALTER TABLE tasks ADD COLUMN review_bounce_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN last_role TEXT;
ALTER TABLE tasks ADD COLUMN status_note TEXT;

CREATE TABLE IF NOT EXISTS agent_sessions (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id       TEXT REFERENCES tasks(id),
  status        TEXT NOT NULL,
  pid           INTEGER,
  log_path      TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  last_seen_at  TEXT,
  last_error    TEXT
);
CREATE INDEX IF NOT EXISTS agent_sessions_agent_idx ON agent_sessions(agent_id);
CREATE INDEX IF NOT EXISTS agent_sessions_task_idx ON agent_sessions(task_id);

CREATE TABLE IF NOT EXISTS approval_requests (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  task_id        TEXT REFERENCES tasks(id),
  agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL,
  status         TEXT NOT NULL,
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  response_note  TEXT,
  created_at     TEXT NOT NULL,
  resolved_at    TEXT
);
CREATE INDEX IF NOT EXISTS approval_requests_session_idx ON approval_requests(session_id);
CREATE INDEX IF NOT EXISTS approval_requests_task_idx ON approval_requests(task_id);

CREATE TABLE IF NOT EXISTS session_messages (
  id                   TEXT PRIMARY KEY,
  session_id           TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  approval_request_id  TEXT REFERENCES approval_requests(id),
  direction            TEXT NOT NULL,
  kind                 TEXT NOT NULL,
  body                 TEXT NOT NULL,
  created_at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS session_messages_session_idx ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS session_messages_approval_idx ON session_messages(approval_request_id);

UPDATE tasks
SET status = 'todo'
WHERE status = 'init';

UPDATE tasks
SET status = 'in_progress',
    assigned_agent_id = NULL,
    worktree_path = NULL
WHERE status = 'handoff_pending';

UPDATE task_events
SET from_status = 'todo'
WHERE from_status = 'init';

UPDATE task_events
SET to_status = 'todo'
WHERE to_status = 'init';

UPDATE task_events
SET from_status = 'in_progress'
WHERE from_status = 'handoff_pending';

UPDATE task_events
SET to_status = 'in_progress'
WHERE to_status = 'handoff_pending';
