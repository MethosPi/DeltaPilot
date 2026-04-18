-- DeltaPilot initial schema
-- Keep in sync with packages/core/src/db/schema.ts

CREATE TABLE IF NOT EXISTS agents (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  transport       TEXT NOT NULL,
  command         TEXT,
  endpoint        TEXT,
  registered_at   TEXT NOT NULL,
  last_seen_at    TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  brief              TEXT NOT NULL DEFAULT '',
  status             TEXT NOT NULL,
  priority           INTEGER NOT NULL DEFAULT 50,
  assigned_agent_id  TEXT REFERENCES agents(id),
  branch_name        TEXT,
  worktree_path      TEXT,
  acceptance_json    TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  claimed_at         TEXT,
  last_heartbeat_at  TEXT
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_status_priority_idx ON tasks(status, priority);

CREATE TABLE IF NOT EXISTS task_events (
  id              TEXT PRIMARY KEY,
  task_id         TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  payload_json    TEXT,
  actor_agent_id  TEXT REFERENCES agents(id),
  from_status     TEXT NOT NULL,
  to_status       TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events(task_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  path             TEXT NOT NULL,
  author_agent_id  TEXT REFERENCES agents(id),
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS handoffs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent_id    TEXT NOT NULL REFERENCES agents(id),
  to_agent_id      TEXT REFERENCES agents(id),
  reason           TEXT NOT NULL,
  snapshot_commit  TEXT,
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);
CREATE INDEX IF NOT EXISTS handoffs_task_idx ON handoffs(task_id);

CREATE TABLE IF NOT EXISTS _deltapilot_migrations (
  version     INTEGER PRIMARY KEY,
  applied_at  TEXT NOT NULL
);
