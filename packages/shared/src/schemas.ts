import { z } from "zod";

export const taskStatusSchema = z.enum([
  "init",
  "todo",
  "in_progress",
  "review",
  "handoff_pending",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_STATUSES: ReadonlyArray<TaskStatus> = ["done", "cancelled"];

export const agentKindSchema = z.enum([
  "claude-code",
  "codex",
  "opendevin",
  "hermes",
  "mock",
  "other",
]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const agentTransportSchema = z.enum(["mcp-stdio", "http"]);
export type AgentTransport = z.infer<typeof agentTransportSchema>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  kind: agentKindSchema,
  transport: agentTransportSchema,
  command: z.string().optional(),
  endpoint: z.string().url().optional(),
  registered_at: z.string().datetime(),
  last_seen_at: z.string().datetime().nullable(),
});
export type Agent = z.infer<typeof agentSchema>;

export const acceptanceCriteriaSchema = z.object({
  goal: z.string().min(1),
  deliverables: z.array(z.string().min(1)).min(1),
  files_in_scope: z.array(z.string()),
  success_test: z.string().min(1),
});
export type AcceptanceCriteria = z.infer<typeof acceptanceCriteriaSchema>;

export const taskSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  brief: z.string(),
  status: taskStatusSchema,
  priority: z.number().int().min(0).max(100),
  assigned_agent_id: z.string().uuid().nullable(),
  branch_name: z.string().nullable(),
  worktree_path: z.string().nullable(),
  acceptance: acceptanceCriteriaSchema.nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  claimed_at: z.string().datetime().nullable(),
  last_heartbeat_at: z.string().datetime().nullable(),
});
export type Task = z.infer<typeof taskSchema>;

export const artifactKindSchema = z.enum([
  "task_brief",
  "scratchpad",
  "next_steps",
  "test_output",
  "review_note",
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  kind: artifactKindSchema,
  path: z.string(),
  author_agent_id: z.string().uuid().nullable(),
  created_at: z.string().datetime(),
});
export type Artifact = z.infer<typeof artifactSchema>;

export const handoffSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  from_agent_id: z.string().uuid(),
  to_agent_id: z.string().uuid().nullable(),
  reason: z.enum(["rate_limit", "context_limit", "crash", "heartbeat_timeout", "user"]),
  snapshot_commit: z.string().nullable(),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
});
export type Handoff = z.infer<typeof handoffSchema>;

export const taskEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("claim"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("submit_for_review"), commit_sha: z.string().optional() }),
  z.object({
    kind: z.literal("report_limit"),
    reason: z.enum(["rate_limit", "context_limit", "crash"]),
  }),
  z.object({ kind: z.literal("timeout") }),
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("bounce"), note: z.string() }),
  z.object({ kind: z.literal("cancel") }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;
