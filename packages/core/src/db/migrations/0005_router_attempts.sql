ALTER TABLE agents ADD COLUMN provider_family TEXT NOT NULL DEFAULT 'generic';
ALTER TABLE agents ADD COLUMN model_id TEXT;
ALTER TABLE agents ADD COLUMN context_window INTEGER;
ALTER TABLE agents ADD COLUMN cost_tier TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE agents ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN supports_patch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN supports_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE agents ADD COLUMN max_concurrency INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN fallback_priority INTEGER NOT NULL DEFAULT 100;
ALTER TABLE agents ADD COLUMN health_state TEXT NOT NULL DEFAULT 'healthy';

ALTER TABLE tasks ADD COLUMN budget_json TEXT;

CREATE TABLE IF NOT EXISTS task_attempts (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  agent_id              TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  role                  TEXT NOT NULL,
  provider              TEXT NOT NULL,
  model                 TEXT,
  attempt_number        INTEGER NOT NULL,
  started_at            TEXT NOT NULL,
  ended_at              TEXT,
  outcome               TEXT,
  handoff_reason        TEXT,
  prompt_tokens         INTEGER,
  completion_tokens     INTEGER,
  estimated_cost_usd    TEXT,
  latency_ms            INTEGER,
  checkpoint_artifact_id TEXT REFERENCES artifacts(id)
);
CREATE INDEX IF NOT EXISTS task_attempts_task_idx ON task_attempts(task_id, started_at);
CREATE INDEX IF NOT EXISTS task_attempts_agent_idx ON task_attempts(agent_id, started_at);
CREATE INDEX IF NOT EXISTS task_attempts_active_idx ON task_attempts(task_id, ended_at);
