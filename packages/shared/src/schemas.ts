import { z } from "zod";

export const taskStatusSchema = z.enum([
  "todo",
  "planning",
  "in_progress",
  "review",
  "human_review",
  "merging",
  "done",
  "cancelled",
]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const TERMINAL_STATUSES: ReadonlyArray<TaskStatus> = ["done", "cancelled"];

export const taskPriorityLabelSchema = z.enum(["max", "high", "medium", "low"]);
export type TaskPriorityLabel = z.infer<typeof taskPriorityLabelSchema>;

export const TASK_PRIORITY_LABELS: ReadonlyArray<TaskPriorityLabel> = [
  "max",
  "high",
  "medium",
  "low",
];

export const TASK_PRIORITY_RANKS: Readonly<Record<TaskPriorityLabel, number>> = {
  max: 100,
  high: 75,
  medium: 50,
  low: 25,
};

export const DEFAULT_TASK_PRIORITY_LABEL: TaskPriorityLabel = "medium";
export const DEFAULT_TASK_PRIORITY_RANK = TASK_PRIORITY_RANKS[DEFAULT_TASK_PRIORITY_LABEL];

const TASK_PRIORITY_ENTRIES = Object.entries(TASK_PRIORITY_RANKS) as Array<[TaskPriorityLabel, number]>;

export function taskPriorityRankFromLabel(label: TaskPriorityLabel): number {
  return TASK_PRIORITY_RANKS[label];
}

export function taskPriorityLabelFromRank(rank: number): TaskPriorityLabel {
  let closest: [TaskPriorityLabel, number] = [
    DEFAULT_TASK_PRIORITY_LABEL,
    TASK_PRIORITY_RANKS[DEFAULT_TASK_PRIORITY_LABEL],
  ];

  for (const [candidateLabel, candidateRank] of TASK_PRIORITY_ENTRIES) {
    const [, bestRank] = closest;
    const distance = Math.abs(rank - candidateRank);
    const bestDistance = Math.abs(rank - bestRank);

    if (distance < bestDistance || (distance === bestDistance && candidateRank > bestRank)) {
      closest = [candidateLabel, candidateRank];
    }
  }

  return closest[0];
}

export function normalizeTaskPriorityRank(rank: number): number {
  return taskPriorityRankFromLabel(taskPriorityLabelFromRank(rank));
}

export const agentKindSchema = z.enum([
  "claude-code",
  "claude-sdk",
  "openclaw",
  "codex",
  "ollama",
  "opendevin",
  "hermes",
  "mock",
  "other",
]);
export type AgentKind = z.infer<typeof agentKindSchema>;

export const agentProviderFamilySchema = z.enum([
  "openai",
  "anthropic",
  "openclaw",
  "ollama",
  "generic",
]);
export type AgentProviderFamily = z.infer<typeof agentProviderFamilySchema>;

export const agentCostTierSchema = z.enum([
  "local",
  "low",
  "medium",
  "high",
  "premium",
]);
export type AgentCostTier = z.infer<typeof agentCostTierSchema>;

export const agentHealthStateSchema = z.enum([
  "healthy",
  "cooldown",
  "degraded",
  "offline",
]);
export type AgentHealthState = z.infer<typeof agentHealthStateSchema>;

export const agentRoleSchema = z.enum(["planner", "executor", "reviewer", "merger"]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const agentRuntimeModeSchema = z.enum(["managed", "external"]);
export type AgentRuntimeMode = z.infer<typeof agentRuntimeModeSchema>;

export const agentTransportSchema = z.enum(["mcp-stdio", "http"]);
export type AgentTransport = z.infer<typeof agentTransportSchema>;

export const handoffReasonSchema = z.enum([
  "rate_limit",
  "context_limit",
  "budget_exceeded",
  "crash",
  "heartbeat_timeout",
  "user",
]);
export type HandoffReason = z.infer<typeof handoffReasonSchema>;

export const reviewDecisionSchema = z.enum(["approve", "bounce"]);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

export const humanReviewReasonSchema = z.enum([
  "approval",
  "bounce_escalation",
  "merge_conflict",
]);
export type HumanReviewReason = z.infer<typeof humanReviewReasonSchema>;

export const githubPullRequestReviewDecisionSchema = z.enum([
  "APPROVED",
  "CHANGES_REQUESTED",
  "REVIEW_REQUIRED",
  "COMMENTED",
  "UNKNOWN",
]);
export type GithubPullRequestReviewDecision = z.infer<typeof githubPullRequestReviewDecisionSchema>;

export const pullRequestProviderSchema = z.enum(["github"]);
export type PullRequestProvider = z.infer<typeof pullRequestProviderSchema>;

export const taskPullRequestSchema = z.object({
  provider: pullRequestProviderSchema,
  base_branch: z.string().min(1),
  head_branch: z.string().min(1),
  head_sha: z.string().nullable(),
  number: z.number().int().positive().nullable(),
  url: z.string().url().nullable(),
  review_decision: githubPullRequestReviewDecisionSchema.nullable(),
  merged_sha: z.string().nullable(),
  last_synced_at: z.string().datetime().nullable(),
  last_error: z.string().nullable(),
});
export type TaskPullRequest = z.infer<typeof taskPullRequestSchema>;

export const mergeResultSchema = z.enum(["merged", "blocked", "reapproval_required"]);
export type MergeResult = z.infer<typeof mergeResultSchema>;

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
  provider_family: agentProviderFamilySchema,
  model_id: z.string().nullable(),
  context_window: z.number().int().positive().nullable(),
  cost_tier: agentCostTierSchema,
  supports_tools: z.boolean(),
  supports_patch: z.boolean(),
  supports_review: z.boolean(),
  max_concurrency: z.number().int().positive(),
  fallback_priority: z.number().int().nonnegative(),
  health_state: agentHealthStateSchema,
});
export type Agent = z.infer<typeof agentSchema>;

const acceptanceStringSchema = z.string().trim().min(1);
const acceptanceStringListSchema = z.array(acceptanceStringSchema);

export const taskBudgetSchema = z.object({
  soft_cost_usd: z.number().nonnegative().optional(),
  hard_cost_usd: z.number().nonnegative().optional(),
  soft_attempts: z.number().int().positive().optional(),
  hard_attempts: z.number().int().positive().optional(),
}).strict().refine(
  (value) =>
    value.soft_cost_usd !== undefined
    || value.hard_cost_usd !== undefined
    || value.soft_attempts !== undefined
    || value.hard_attempts !== undefined,
  {
    message: "budget must define at least one soft/hard cost or attempt threshold",
  },
);
export type TaskBudget = z.infer<typeof taskBudgetSchema>;

export const createTaskAcceptanceSchema = z.object({
  deliverables: acceptanceStringListSchema.min(1),
}).strict();
export type CreateTaskAcceptance = z.infer<typeof createTaskAcceptanceSchema>;

export const acceptanceCriteriaSchema = z
  .object({
    goal: acceptanceStringSchema.optional(),
    deliverables: acceptanceStringListSchema.default([]),
    files_in_scope: acceptanceStringListSchema.default([]),
    success_test: acceptanceStringSchema.optional(),
  })
  .refine(
    (value) =>
      Boolean(value.goal)
      || value.deliverables.length > 0
      || value.files_in_scope.length > 0
      || Boolean(value.success_test),
    {
      message: "acceptance must include goal, deliverables, files_in_scope, or success_test",
    },
  );
export type AcceptanceCriteria = z.infer<typeof acceptanceCriteriaSchema>;

export function normalizeAcceptanceCriteria(raw: unknown): AcceptanceCriteria | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const candidate = raw as Record<string, unknown>;
  const goal = firstAcceptanceString(
    candidate.goal,
    candidate.acceptancegoal,
    candidate.acceptance_goal,
    candidate.acceptanceGoal,
  );
  const deliverables = normalizeAcceptanceStringList(candidate.deliverables);
  const filesInScope = normalizeAcceptanceStringList(candidate.files_in_scope);
  const successTest = firstAcceptanceString(candidate.success_test);

  if (!goal && deliverables.length === 0 && filesInScope.length === 0 && !successTest) {
    return null;
  }

  const result = acceptanceCriteriaSchema.safeParse({
    ...(goal ? { goal } : {}),
    deliverables,
    files_in_scope: filesInScope,
    ...(successTest ? { success_test: successTest } : {}),
  });

  return result.success ? result.data : null;
}

export function normalizeTaskBudget(raw: unknown): TaskBudget | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const result = taskBudgetSchema.safeParse(raw);
  return result.success ? result.data : null;
}

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
  budget: taskBudgetSchema.nullable(),
  review_bounce_count: z.number().int().min(0),
  human_review_reason: humanReviewReasonSchema.nullable(),
  pull_request: taskPullRequestSchema.nullable(),
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
  "checkpoint",
  "review_note",
  "execution_plan",
  "review_report",
  "human_review_packet",
  "merge_report",
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

export const taskCheckpointSchema = z.object({
  summary: z.string().trim().min(1),
  files_touched: z.array(z.string().trim().min(1)).default([]),
  tests_ran: z.array(z.string().trim().min(1)).default([]),
  commands_ran: z.array(z.string().trim().min(1)).default([]),
  next_steps: z.array(z.string().trim().min(1)).default([]),
  risks: z.array(z.string().trim().min(1)).default([]),
});
export type TaskCheckpoint = z.infer<typeof taskCheckpointSchema>;

export const taskAttachmentCategorySchema = z.enum([
  "image",
  "text",
  "document",
  "pdf",
  "video",
  "audio",
]);
export type TaskAttachmentCategory = z.infer<typeof taskAttachmentCategorySchema>;

export const taskAttachmentSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  original_name: z.string().min(1),
  stored_path: z.string(),
  mime_type: z.string().min(1),
  size_bytes: z.number().int().nonnegative(),
  category: taskAttachmentCategorySchema,
  created_at: z.string().datetime(),
});
export type TaskAttachment = z.infer<typeof taskAttachmentSchema>;

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

export const taskAttemptOutcomeSchema = z.enum([
  "completed",
  "handoff",
  "failed",
  "approval_requested",
  "budget_exceeded",
  "cancelled",
]);
export type TaskAttemptOutcome = z.infer<typeof taskAttemptOutcomeSchema>;

export const taskAttemptSchema = z.object({
  id: z.string().uuid(),
  task_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  role: agentRoleSchema,
  provider: agentProviderFamilySchema,
  model: z.string().nullable(),
  attempt_number: z.number().int().positive(),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable(),
  outcome: taskAttemptOutcomeSchema.nullable(),
  handoff_reason: handoffReasonSchema.nullable(),
  prompt_tokens: z.number().int().nonnegative().nullable(),
  completion_tokens: z.number().int().nonnegative().nullable(),
  estimated_cost_usd: z.number().nonnegative().nullable(),
  latency_ms: z.number().int().nonnegative().nullable(),
  checkpoint_artifact_id: z.string().uuid().nullable(),
});
export type TaskAttempt = z.infer<typeof taskAttemptSchema>;

export const routingPolicySchema = z.object({
  role: agentRoleSchema,
  preferred_kinds: z.array(agentKindSchema).min(1),
  max_cost_tier: agentCostTierSchema.optional(),
  large_context_only: z.boolean().default(false),
});
export type RoutingPolicy = z.infer<typeof routingPolicySchema>;

export const taskEventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create") }),
  z.object({ kind: z.literal("start_planning"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("plan_ready") }),
  z.object({ kind: z.literal("start_execution"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("execution_ready"), commit_sha: z.string().optional() }),
  z.object({ kind: z.literal("start_review"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("queue_merge") }),
  z.object({ kind: z.literal("start_merge"), agent_id: z.string().uuid() }),
  z.object({
    kind: z.literal("review_decision"),
    decision: reviewDecisionSchema,
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("enter_human_review"),
    note: z.string(),
    reason: humanReviewReasonSchema,
  }),
  z.object({ kind: z.literal("return_to_todo"), note: z.string().optional() }),
  z.object({
    kind: z.literal("merge_result"),
    result: mergeResultSchema,
    note: z.string().optional(),
    merged_sha: z.string().optional(),
  }),
  z.object({
    kind: z.literal("report_limit"),
    reason: handoffReasonSchema,
  }),
  z.object({ kind: z.literal("cancel") }),
  z.object({ kind: z.literal("claim"), agent_id: z.string().uuid() }),
  z.object({ kind: z.literal("submit_for_review"), commit_sha: z.string().optional() }),
  z.object({ kind: z.literal("approve") }),
  z.object({ kind: z.literal("bounce"), note: z.string() }),
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;

function normalizeAcceptanceStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function firstAcceptanceString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }

    const normalized = value.trim();
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}
