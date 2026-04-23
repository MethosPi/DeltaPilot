import { z } from "zod";

export const taskStatusSchema = z.enum([
  "todo",
  "planning",
  "in_progress",
  "review",
  "human_review",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_STATUSES: ReadonlyArray<TaskStatus> = ["done", "cancelled"];

export const agentKindSchema = z.enum([
  "claude-code",
  "claude-sdk",
  "openclaw",
  "codex",
  "opendevin",
  "hermes",
  "mock",
  "other",
]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const agentRoleSchema = z.enum(["planner", "executor", "reviewer"]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const agentRuntimeModeSchema = z.enum(["managed", "external"]);
export type AgentRuntimeMode = z.infer<typeof agentRuntimeModeSchema>;

export const agentTransportSchema = z.enum(["mcp-stdio", "http"]);
export type AgentTransport = z.infer<typeof agentTransportSchema>;

export const handoffReasonSchema = z.enum([
  "rate_limit",
  "context_limit",
  "crash",
  "heartbeat_timeout",
  "user",
]);
export type HandoffReason = z.infer<typeof handoffReasonSchema>;

export const reviewDecisionSchema = z.enum(["approve", "bounce"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const agentSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  kind: agentKindSchema,
  role: agentRoleSchema,
  runtime_mode: agentRuntimeModeSchema,
  transport: agentTransportSchema,
  enabled: z.boolean(),
  command: z.string().optional(),
  endpoint: z.string().url().optional(),
  registered_at: z.string().datetime(),
  last_seen_at: z.string().datetime().nullable(),
  cooldown_until: z.string().datetime().nullable(),
  last_limit_reason: handoffReasonSchema.nullable(),
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
  review_bounce_count: z.number().int().min(0),
  last_role: agentRoleSchema.nullable(),
  status_note: z.string().nullable(),
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
  "execution_plan",
  "review_report",
  "approval_note",
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
  reason: handoffReasonSchema,
  snapshot_commit: z.string().nullable(),
  created_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
});
export type Handoff = z.infer<typeof handoffSchema>;

export const sessionStatusSchema = z.enum([
  "starting",
  "ready",
  "busy",
  "waiting",
  "stopped",
  "errored",
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const agentSessionSchema = z.object({
  id: z.string().uuid(),
  agent_id: z.string().uuid(),
  task_id: z.string().uuid().nullable(),
  status: sessionStatusSchema,
  pid: z.number().int().nullable(),
  log_path: z.string(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  last_seen_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
});
export type AgentSession = z.infer<typeof agentSessionSchema>;

export const approvalRequestKindSchema = z.enum(["approval", "question"]);
export type ApprovalRequestKind = z.infer<typeof approvalRequestKindSchema>;

export const approvalRequestStatusSchema = z.enum(["pending", "approved", "rejected"]);
export type ApprovalRequestStatus = z.infer<typeof approvalRequestStatusSchema>;

export const approvalRequestSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  task_id: z.string().uuid().nullable(),
  agent_id: z.string().uuid(),
  kind: approvalRequestKindSchema,
  status: approvalRequestStatusSchema,
  title: z.string().min(1),
  body: z.string().min(1),
  response_note: z.string().nullable(),
  created_at: z.string().datetime(),
  resolved_at: z.string().datetime().nullable(),
});
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;

export const sessionMessageDirectionSchema = z.enum(["agent", "human", "system"]);
export type SessionMessageDirection = z.infer<typeof sessionMessageDirectionSchema>;

export const sessionMessageSchema = z.object({
  id: z.string().uuid(),
  session_id: z.string().uuid(),
  approval_request_id: z.string().uuid().nullable(),
  direction: sessionMessageDirectionSchema,
  kind: z.string().min(1),
  body: z.string().min(1),
  created_at: z.string().datetime(),
});
export type SessionMessage = z.infer<typeof sessionMessageSchema>;

export const taskEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }),
  z.object({ kind: z.literal("start_planning"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("plan_ready") }),
  z.object({ kind: z.literal("start_execution"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("execution_ready"), commit_sha: z.string().optional() }),
  z.object({ kind: z.literal("start_review"), agent_id: z.string().uuid() }),
  z.object({
    kind: z.literal("review_decision"),
    decision: reviewDecisionSchema,
    note: z.string().optional(),
  }),
  z.object({ kind: z.literal("enter_human_review"), note: z.string() }),
  z.object({ kind: z.literal("return_to_todo"), note: z.string().optional() }),
  z.object({
    kind: z.literal("report_limit"),
    reason: z.enum(["rate_limit", "context_limit", "crash"]),
  }),
  z.object({ kind: z.literal("cancel") }),
  z.object({ kind: z.literal("claim"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("submit_for_review"), commit_sha: z.string().optional() }),
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("bounce"), note: z.string() }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;
