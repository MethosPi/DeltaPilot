import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  role: text("role").notNull(),
  runtimeMode: text("runtime_mode").notNull(),
  transport: text("transport").notNull(),
  enabled: integer("enabled").notNull().default(1),
  command: text("command"),
  endpoint: text("endpoint"),
  registeredAt: text("registered_at").notNull(),
  lastSeenAt: text("last_seen_at"),
  cooldownUntil: text("cooldown_until"),
  lastLimitReason: text("last_limit_reason"),
  providerFamily: text("provider_family").notNull().default("generic"),
  modelId: text("model_id"),
  contextWindow: integer("context_window"),
  costTier: text("cost_tier").notNull().default("medium"),
  supportsTools: integer("supports_tools").notNull().default(0),
  supportsPatch: integer("supports_patch").notNull().default(0),
  supportsReview: integer("supports_review").notNull().default(0),
  maxConcurrency: integer("max_concurrency").notNull().default(1),
  fallbackPriority: integer("fallback_priority").notNull().default(100),
  healthState: text("health_state").notNull().default("healthy"),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    brief: text("brief").notNull().default(""),
    status: text("status").notNull(),
    priority: integer("priority").notNull().default(50),
    assignedAgentId: text("assigned_agent_id").references(() => agents.id),
    branchName: text("branch_name"),
    worktreePath: text("worktree_path"),
    acceptanceJson: text("acceptance_json"),
    budgetJson: text("budget_json"),
    reviewBounceCount: integer("review_bounce_count").notNull().default(0),
    humanReviewReason: text("human_review_reason"),
    prProvider: text("pr_provider"),
    prBaseBranch: text("pr_base_branch"),
    prHeadBranch: text("pr_head_branch"),
    prHeadSha: text("pr_head_sha"),
    prNumber: integer("pr_number"),
    prUrl: text("pr_url"),
    prReviewDecision: text("pr_review_decision"),
    prMergedSha: text("pr_merged_sha"),
    prLastSyncedAt: text("pr_last_synced_at"),
    prLastError: text("pr_last_error"),
    lastRole: text("last_role"),
    statusNote: text("status_note"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    claimedAt: text("claimed_at"),
    lastHeartbeatAt: text("last_heartbeat_at"),
    archivedAt: text("archived_at"),
  },
  (t) => ({
    statusIdx: index("tasks_status_idx").on(t.status),
    statusPriorityIdx: index("tasks_status_priority_idx").on(t.status, t.priority),
    archivedStatusPriorityIdx: index("tasks_archived_status_priority_idx").on(
      t.archivedAt,
      t.status,
      t.priority,
    ),
  }),
);

export const taskAttempts = sqliteTable(
  "task_attempts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    attemptNumber: integer("attempt_number").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    outcome: text("outcome"),
    handoffReason: text("handoff_reason"),
    promptTokens: integer("prompt_tokens"),
    completionTokens: integer("completion_tokens"),
    estimatedCostUsd: text("estimated_cost_usd"),
    latencyMs: integer("latency_ms"),
    checkpointArtifactId: text("checkpoint_artifact_id").references(() => artifacts.id),
  },
  (t) => ({
    taskIdx: index("task_attempts_task_idx").on(t.taskId, t.startedAt),
    agentIdx: index("task_attempts_agent_idx").on(t.agentId, t.startedAt),
    activeIdx: index("task_attempts_active_idx").on(t.taskId, t.endedAt),
  }),
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    payloadJson: text("payload_json"),
    actorAgentId: text("actor_agent_id").references(() => agents.id),
    fromStatus: text("from_status").notNull(),
    toStatus: text("to_status").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    taskIdx: index("task_events_task_idx").on(t.taskId),
  }),
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    path: text("path").notNull(),
    authorAgentId: text("author_agent_id").references(() => agents.id),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    taskIdx: index("artifacts_task_idx").on(t.taskId),
  }),
);

export const taskAttachments = sqliteTable(
  "task_attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    originalName: text("original_name").notNull(),
    storedPath: text("stored_path").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    category: text("category").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    taskIdx: index("task_attachments_task_idx").on(t.taskId),
  }),
);

export const handoffs = sqliteTable(
  "handoffs",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    fromAgentId: text("from_agent_id")
      .notNull()
      .references(() => agents.id),
    toAgentId: text("to_agent_id").references(() => agents.id),
    reason: text("reason").notNull(),
    snapshotCommit: text("snapshot_commit"),
    createdAt: text("created_at").notNull(),
    completedAt: text("completed_at"),
  },
  (t) => ({
    taskIdx: index("handoffs_task_idx").on(t.taskId),
  }),
);

export const agentSessions = sqliteTable(
  "agent_sessions",
  {
    id: text("id").primaryKey(),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id),
    status: text("status").notNull(),
    pid: integer("pid"),
    logPath: text("log_path").notNull(),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    lastSeenAt: text("last_seen_at"),
    lastError: text("last_error"),
  },
  (t) => ({
    agentIdx: index("agent_sessions_agent_idx").on(t.agentId),
    taskIdx: index("agent_sessions_task_idx").on(t.taskId),
  }),
);

export const approvalRequests = sqliteTable(
  "approval_requests",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    taskId: text("task_id").references(() => tasks.id),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    responseNote: text("response_note"),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
  },
  (t) => ({
    sessionIdx: index("approval_requests_session_idx").on(t.sessionId),
    taskIdx: index("approval_requests_task_idx").on(t.taskId),
  }),
);

export const sessionMessages = sqliteTable(
  "session_messages",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => agentSessions.id, { onDelete: "cascade" }),
    approvalRequestId: text("approval_request_id").references(() => approvalRequests.id),
    direction: text("direction").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    sessionIdx: index("session_messages_session_idx").on(t.sessionId),
    approvalIdx: index("session_messages_approval_idx").on(t.approvalRequestId),
  }),
);
