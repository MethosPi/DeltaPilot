import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const agents = sqliteTable("agents", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  transport: text("transport").notNull(),
  command: text("command"),
  endpoint: text("endpoint"),
  registeredAt: text("registered_at").notNull(),
  lastSeenAt: text("last_seen_at"),
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
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    claimedAt: text("claimed_at"),
    lastHeartbeatAt: text("last_heartbeat_at"),
  },
  (t) => ({
    statusIdx: index("tasks_status_idx").on(t.status),
    statusPriorityIdx: index("tasks_status_priority_idx").on(t.status, t.priority),
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
