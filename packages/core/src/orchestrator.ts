import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptanceCriteriaSchema,
  agentCostTierSchema,
  agentHealthStateSchema,
  agentKindSchema,
  agentProviderFamilySchema,
  agentRoleSchema,
  agentRuntimeModeSchema,
  agentSessionSchema,
  agentTransportSchema,
  approvalRequestKindSchema,
  approvalRequestSchema,
  artifactKindSchema,
  githubPullRequestReviewDecisionSchema,
  handoffReasonSchema,
  handoffSchema,
  humanReviewReasonSchema,
  mergeResultSchema,
  normalizeAcceptanceCriteria,
  normalizeTaskBudget,
  normalizeTaskPriorityRank,
  nextStatus,
  reviewDecisionSchema,
  sessionMessageDirectionSchema,
  sessionMessageSchema,
  sessionStatusSchema,
  taskAttemptOutcomeSchema,
  taskAttemptSchema,
  taskBudgetSchema,
  taskCheckpointSchema,
  taskPullRequestSchema,
  taskPriorityRankFromLabel,
  taskStatusSchema,
} from "@deltapilot/shared";
import type {
  AcceptanceCriteria,
  Agent,
  AgentCostTier,
  AgentHealthState,
  AgentKind,
  AgentProviderFamily,
  AgentRole,
  AgentRuntimeMode,
  AgentSession,
  AgentTransport,
  ApprovalRequest,
  ApprovalRequestKind,
  ArtifactKind,
  GithubPullRequestReviewDecision,
  Handoff,
  HandoffReason,
  HumanReviewReason,
  MergeResult,
  ReviewDecision,
  SessionMessage,
  SessionMessageDirection,
  SessionStatus,
  Task,
  TaskAttempt,
  TaskAttemptOutcome,
  TaskBudget,
  TaskCheckpoint,
  TaskEvent,
  TaskPullRequest,
  TaskPriorityLabel,
  TaskStatus,
} from "@deltapilot/shared";
import type { DrizzleDb } from "./db/client.js";
import { defaultAgentProfile } from "./routing.js";
import { WorktreeManager } from "./worktree.js";

const LIMIT_COOLDOWN_MS = 60_000;

export interface OrchestratorOptions {
  raw: BetterSqliteDatabase;
  db: DrizzleDb;
  worktreeMgr: WorktreeManager;
  repoRoot: string;
  now?: () => Date;
  uuid?: () => string;
}

export interface RegisterAgentInput {
  name: string;
  kind: AgentKind;
  role?: AgentRole;
  runtimeMode?: AgentRuntimeMode;
  transport: AgentTransport;
  enabled?: boolean;
  command?: string;
  endpoint?: string;
  providerFamily?: AgentProviderFamily;
  modelId?: string | null;
  contextWindow?: number | null;
  costTier?: AgentCostTier;
  supportsTools?: boolean;
  supportsPatch?: boolean;
  supportsReview?: boolean;
  maxConcurrency?: number;
  fallbackPriority?: number;
  healthState?: AgentHealthState;
}

export interface UpdateAgentInput {
  name?: string;
  role?: AgentRole;
  runtimeMode?: AgentRuntimeMode;
  enabled?: boolean;
  command?: string | null;
  endpoint?: string | null;
  cooldownUntil?: string | null;
  lastLimitReason?: HandoffReason | null;
  providerFamily?: AgentProviderFamily;
  modelId?: string | null;
  contextWindow?: number | null;
  costTier?: AgentCostTier;
  supportsTools?: boolean;
  supportsPatch?: boolean;
  supportsReview?: boolean;
  maxConcurrency?: number;
  fallbackPriority?: number;
  healthState?: AgentHealthState;
}

export interface CreateTaskInput {
  title: string;
  brief?: string;
  priority?: number | TaskPriorityLabel;
  acceptance?: AcceptanceCriteria;
  budget?: TaskBudget;
}

export interface SubmitReviewInput {
  decision: ReviewDecision;
  note?: string;
}

export interface TaskPullRequestUpdateInput {
  provider?: "github" | null;
  baseBranch?: string | null;
  headBranch?: string | null;
  headSha?: string | null;
  number?: number | null;
  url?: string | null;
  reviewDecision?: GithubPullRequestReviewDecision | null;
  mergedSha?: string | null;
  lastSyncedAt?: string | null;
  lastError?: string | null;
}

export interface EnterHumanReviewInput {
  note?: string;
  reason: HumanReviewReason;
  pullRequest?: TaskPullRequestUpdateInput;
  preserveWorktree?: boolean;
}

export interface MergeResultInput {
  result: MergeResult;
  note?: string;
  reason?: HumanReviewReason;
  pullRequest?: TaskPullRequestUpdateInput;
  mergedSha?: string;
  preserveWorktree?: boolean;
}

export interface CreateAgentSessionInput {
  agentId: string;
  logPath: string;
  status?: SessionStatus;
  taskId?: string | null;
  pid?: number | null;
}

export interface UpdateAgentSessionInput {
  taskId?: string | null;
  status?: SessionStatus;
  pid?: number | null;
  endedAt?: string | null;
  lastSeenAt?: string | null;
  lastError?: string | null;
}

export interface CreateApprovalRequestInput {
  sessionId: string;
  agentId: string;
  taskId?: string | null;
  kind: ApprovalRequestKind;
  title: string;
  body: string;
}

export interface CreateSessionMessageInput {
  sessionId: string;
  direction: SessionMessageDirection;
  kind: string;
  body: string;
  approvalRequestId?: string | null;
}

export interface UpdateTaskAttemptInput {
  provider?: AgentProviderFamily;
  model?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  estimatedCostUsd?: number | null;
  latencyMs?: number | null;
  checkpointArtifactId?: string | null;
  outcome?: TaskAttemptOutcome | null;
  handoffReason?: HandoffReason | null;
  endedAt?: string | null;
}

export class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`Task not found: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export class AgentNotFoundError extends Error {
  constructor(agentId: string) {
    super(`Agent not found: ${agentId}`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentDeleteConflictError extends Error {
  constructor(agentId: string, message: string) {
    super(`Cannot delete agent ${agentId}: ${message}`);
    this.name = "AgentDeleteConflictError";
  }
}

export class NotAssignedError extends Error {
  constructor(taskId: string, agentId: string) {
    super(`Agent ${agentId} is not the assignee of task ${taskId}`);
    this.name = "NotAssignedError";
  }
}

interface TaskRow {
  id: string;
  title: string;
  brief: string;
  status: string;
  priority: number;
  assigned_agent_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  acceptance_json: string | null;
  budget_json: string | null;
  review_bounce_count: number;
  human_review_reason: string | null;
  pr_provider: string | null;
  pr_base_branch: string | null;
  pr_head_branch: string | null;
  pr_head_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_review_decision: string | null;
  pr_merged_sha: string | null;
  pr_last_synced_at: string | null;
  pr_last_error: string | null;
  last_role: string | null;
  status_note: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  role: string;
  runtime_mode: string;
  transport: string;
  enabled: number;
  command: string | null;
  endpoint: string | null;
  registered_at: string;
  last_seen_at: string | null;
  cooldown_until: string | null;
  last_limit_reason: string | null;
  provider_family: string;
  model_id: string | null;
  context_window: number | null;
  cost_tier: string;
  supports_tools: number;
  supports_patch: number;
  supports_review: number;
  max_concurrency: number;
  fallback_priority: number;
  health_state: string;
}

interface TaskAttemptRow {
  id: string;
  task_id: string;
  agent_id: string;
  role: string;
  provider: string;
  model: string | null;
  attempt_number: number;
  started_at: string;
  ended_at: string | null;
  outcome: string | null;
  handoff_reason: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  estimated_cost_usd: string | null;
  latency_ms: number | null;
  checkpoint_artifact_id: string | null;
}

interface AgentSessionRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  status: string;
  pid: number | null;
  log_path: string;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string | null;
  last_error: string | null;
}

interface ApprovalRequestRow {
  id: string;
  session_id: string;
  task_id: string | null;
  agent_id: string;
  kind: string;
  status: string;
  title: string;
  body: string;
  response_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

interface SessionMessageRow {
  id: string;
  session_id: string;
  approval_request_id: string | null;
  direction: string;
  kind: string;
  body: string;
  created_at: string;
}

export class Orchestrator {
  private readonly raw: BetterSqliteDatabase;
  readonly db: DrizzleDb;
  readonly worktreeMgr: WorktreeManager;
  readonly repoRoot: string;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(opts: OrchestratorOptions) {
    this.raw = opts.raw;
    this.db = opts.db;
    this.worktreeMgr = opts.worktreeMgr;
    this.repoRoot = opts.repoRoot;
    this.now = opts.now ?? (() => new Date());
    this.uuid = opts.uuid ?? (() => crypto.randomUUID());
  }

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    const id = this.uuid();
    const registeredAt = this.now().toISOString();

    agentKindSchema.parse(input.kind);
    const role = agentRoleSchema.parse(input.role ?? "executor");
    const runtimeMode = agentRuntimeModeSchema.parse(input.runtimeMode ?? "external");
    agentTransportSchema.parse(input.transport);
    const defaults = defaultAgentProfile(input.kind, role);
    const providerFamily = agentProviderFamilySchema.parse(input.providerFamily ?? defaults.providerFamily);
    const modelId = input.modelId === undefined ? defaults.modelId : input.modelId;
    const contextWindow = input.contextWindow === undefined ? defaults.contextWindow : input.contextWindow;
    const costTier = agentCostTierSchema.parse(input.costTier ?? defaults.costTier);
    const supportsTools = input.supportsTools ?? defaults.supportsTools;
    const supportsPatch = input.supportsPatch ?? defaults.supportsPatch;
    const supportsReview = input.supportsReview ?? defaults.supportsReview;
    const maxConcurrency = input.maxConcurrency ?? defaults.maxConcurrency;
    const fallbackPriority = input.fallbackPriority ?? defaults.fallbackPriority;
    const healthState = agentHealthStateSchema.parse(input.healthState ?? defaults.healthState);

    this.raw
      .prepare(
        `INSERT INTO agents
         (id, name, kind, role, runtime_mode, transport, enabled, command, endpoint,
          registered_at, last_seen_at, cooldown_until, last_limit_reason,
          provider_family, model_id, context_window, cost_tier, supports_tools, supports_patch,
          supports_review, max_concurrency, fallback_priority, health_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.kind,
        role,
        runtimeMode,
        input.transport,
        input.enabled ?? true ? 1 : 0,
        input.command ?? null,
        input.endpoint ?? null,
        registeredAt,
        providerFamily,
        modelId,
        contextWindow,
        costTier,
        supportsTools ? 1 : 0,
        supportsPatch ? 1 : 0,
        supportsReview ? 1 : 0,
        maxConcurrency,
        fallbackPriority,
        healthState,
      );

    return this.getAgent(id);
  }

  updateAgent(agentId: string, input: UpdateAgentInput): Agent {
    const current = this.getAgent(agentId);
    const next = {
      name: input.name ?? current.name,
      role: input.role ?? current.role,
      runtimeMode: input.runtimeMode ?? current.runtime_mode,
      enabled: input.enabled ?? current.enabled,
      command:
        input.command === undefined
          ? current.command ?? null
          : input.command,
      endpoint:
        input.endpoint === undefined
          ? current.endpoint ?? null
          : input.endpoint,
      cooldownUntil:
        input.cooldownUntil === undefined
          ? current.cooldown_until
          : input.cooldownUntil,
      lastLimitReason:
        input.lastLimitReason === undefined
          ? current.last_limit_reason
          : input.lastLimitReason,
      providerFamily:
        input.providerFamily === undefined
          ? current.provider_family
          : input.providerFamily,
      modelId:
        input.modelId === undefined
          ? current.model_id
          : input.modelId,
      contextWindow:
        input.contextWindow === undefined
          ? current.context_window
          : input.contextWindow,
      costTier:
        input.costTier === undefined
          ? current.cost_tier
          : input.costTier,
      supportsTools:
        input.supportsTools === undefined
          ? current.supports_tools
          : input.supportsTools,
      supportsPatch:
        input.supportsPatch === undefined
          ? current.supports_patch
          : input.supportsPatch,
      supportsReview:
        input.supportsReview === undefined
          ? current.supports_review
          : input.supportsReview,
      maxConcurrency:
        input.maxConcurrency === undefined
          ? current.max_concurrency
          : input.maxConcurrency,
      fallbackPriority:
        input.fallbackPriority === undefined
          ? current.fallback_priority
          : input.fallbackPriority,
      healthState:
        input.healthState === undefined
          ? current.health_state
          : input.healthState,
    };

    agentRoleSchema.parse(next.role);
    agentRuntimeModeSchema.parse(next.runtimeMode);
    agentProviderFamilySchema.parse(next.providerFamily);
    agentCostTierSchema.parse(next.costTier);
    agentHealthStateSchema.parse(next.healthState);

    this.raw
      .prepare(
        `UPDATE agents
           SET name = ?,
               role = ?,
               runtime_mode = ?,
               enabled = ?,
               command = ?,
               endpoint = ?,
               cooldown_until = ?,
               last_limit_reason = ?,
               provider_family = ?,
               model_id = ?,
               context_window = ?,
               cost_tier = ?,
               supports_tools = ?,
               supports_patch = ?,
               supports_review = ?,
               max_concurrency = ?,
               fallback_priority = ?,
               health_state = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.role,
        next.runtimeMode,
        next.enabled ? 1 : 0,
        next.command ?? null,
        next.endpoint ?? null,
        next.cooldownUntil ?? null,
        next.lastLimitReason ?? null,
        next.providerFamily,
        next.modelId ?? null,
        next.contextWindow ?? null,
        next.costTier,
        next.supportsTools ? 1 : 0,
        next.supportsPatch ? 1 : 0,
        next.supportsReview ? 1 : 0,
        next.maxConcurrency,
        next.fallbackPriority,
        next.healthState,
        agentId,
      );

    return this.getAgent(agentId);
  }

  getAgent(agentId: string): Agent {
    const row = this.raw.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as
      | AgentRow
      | undefined;
    if (!row) throw new AgentNotFoundError(agentId);
    return rowToAgent(row);
  }

  listAgents(): Agent[] {
    const rows = this.raw
      .prepare("SELECT * FROM agents ORDER BY registered_at ASC")
      .all() as AgentRow[];
    return rows.map(rowToAgent);
  }

  deleteAgent(agentId: string): Agent {
    const agent = this.getAgent(agentId);
    const assignedTask = this.getAssignedTask(agentId);
    if (assignedTask) {
      throw new AgentDeleteConflictError(
        agentId,
        `agent is currently assigned to task ${assignedTask.title}`,
      );
    }

    const openSession = this.getOpenSessionForAgent(agentId);
    if (openSession && (openSession.task_id !== null || openSession.pid !== null)) {
      throw new AgentDeleteConflictError(
        agentId,
        "agent still has an active managed session",
      );
    }

    const outgoingHandoffCount = this.raw
      .prepare("SELECT COUNT(*) AS count FROM handoffs WHERE from_agent_id = ?")
      .get(agentId) as { count: number };
    if ((outgoingHandoffCount?.count ?? 0) > 0) {
      throw new AgentDeleteConflictError(
        agentId,
        "agent has recorded handoff history and cannot be removed safely",
      );
    }

    this.raw.transaction(() => {
      this.raw.prepare("UPDATE task_events SET actor_agent_id = NULL WHERE actor_agent_id = ?").run(agentId);
      this.raw.prepare("UPDATE artifacts SET author_agent_id = NULL WHERE author_agent_id = ?").run(agentId);
      this.raw.prepare("UPDATE handoffs SET to_agent_id = NULL WHERE to_agent_id = ?").run(agentId);
      this.raw.prepare("DELETE FROM agent_sessions WHERE agent_id = ?").run(agentId);
      this.raw.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
    })();

    return agent;
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = this.uuid();
    const ts = this.now().toISOString();
    const priority =
      typeof input.priority === "string"
        ? taskPriorityRankFromLabel(input.priority)
        : normalizeTaskPriorityRank(input.priority ?? 50);
    const acceptanceJson = input.acceptance
      ? JSON.stringify(acceptanceCriteriaSchema.parse(input.acceptance))
      : null;
    const budgetJson = input.budget
      ? JSON.stringify(taskBudgetSchema.parse(input.budget))
      : null;

    this.raw
      .prepare(
        `INSERT INTO tasks
         (id, title, brief, status, priority, assigned_agent_id, branch_name, worktree_path,
          acceptance_json, budget_json, review_bounce_count, human_review_reason,
          pr_provider, pr_base_branch, pr_head_branch, pr_head_sha, pr_number, pr_url,
          pr_review_decision, pr_merged_sha, pr_last_synced_at, pr_last_error,
          last_role, status_note, created_at, updated_at,
          claimed_at, last_heartbeat_at)
         VALUES (?, ?, ?, 'todo', ?, NULL, NULL, NULL, ?, ?, 0, NULL,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
          NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(id, input.title, input.brief ?? "", priority, acceptanceJson, budgetJson, ts, ts);

    this.recordEvent({
      taskId: id,
      fromStatus: "todo",
      toStatus: "todo",
      kind: "create",
      payload: { title: input.title },
      actorAgentId: null,
    });

    return this.getTask(id);
  }

  getTask(taskId: string): Task {
    const row = this.raw.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | TaskRow
      | undefined;
    if (!row) throw new TaskNotFoundError(taskId);
    return rowToTask(row);
  }

  listTasks(filter?: { status?: TaskStatus }): Task[] {
    const rows = filter?.status
      ? (this.raw
          .prepare("SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at ASC")
          .all(filter.status) as TaskRow[])
      : (this.raw
          .prepare("SELECT * FROM tasks ORDER BY priority DESC, created_at ASC")
          .all() as TaskRow[]);
    return rows.map(rowToTask);
  }

  getAssignedTask(agentId: string): Task | null {
    const row = this.raw
      .prepare("SELECT * FROM tasks WHERE assigned_agent_id = ? ORDER BY updated_at DESC LIMIT 1")
      .get(agentId) as TaskRow | undefined;
    return row ? rowToTask(row) : null;
  }

  applyEvent(taskId: string, event: TaskEvent, actorAgentId: string | null = null): Task {
    const task = this.getTask(taskId);
    const ts = this.now().toISOString();

    switch (event.kind) {
      case "approve": {
        const to = nextStatus(task.status, event);
        this.raw
          .prepare(
            `UPDATE tasks
               SET status = ?, assigned_agent_id = NULL, worktree_path = NULL,
                   claimed_at = NULL, last_heartbeat_at = NULL, updated_at = ?, status_note = NULL
             WHERE id = ?`,
          )
          .run(to, ts, taskId);
        this.recordEvent({
          taskId,
          fromStatus: task.status,
          toStatus: to,
          kind: "approve",
          payload: {},
          actorAgentId,
        });
        return this.getTask(taskId);
      }
      case "bounce": {
        const nextCount = task.review_bounce_count + 1;
        const to = nextCount >= 3 ? "human_review" : nextStatus(task.status, event);
        const eventKind = nextCount >= 3 ? "enter_human_review" : "bounce";
        this.raw
          .prepare(
            `UPDATE tasks
               SET status = ?, assigned_agent_id = NULL, worktree_path = NULL,
                   claimed_at = NULL, last_heartbeat_at = NULL, updated_at = ?,
                   review_bounce_count = ?, status_note = ?
             WHERE id = ?`,
          )
          .run(to, ts, nextCount, event.note, taskId);
        this.recordEvent({
          taskId,
          fromStatus: task.status,
          toStatus: to,
          kind: eventKind,
          payload: nextCount >= 3 ? { note: event.note } : { note: event.note },
          actorAgentId,
        });
        return this.getTask(taskId);
      }
      case "cancel": {
        const to = nextStatus(task.status, event);
        this.raw
          .prepare(
            `UPDATE tasks
               SET status = ?, assigned_agent_id = NULL, worktree_path = NULL,
                   claimed_at = NULL, last_heartbeat_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(to, ts, taskId);
        this.recordEvent({
          taskId,
          fromStatus: task.status,
          toStatus: to,
          kind: event.kind,
          payload: {},
          actorAgentId,
        });
        return this.getTask(taskId);
      }
      case "return_to_todo": {
        const to = nextStatus(task.status, event);
        this.raw
          .prepare(
            `UPDATE tasks
               SET status = ?, assigned_agent_id = NULL, worktree_path = NULL,
                   claimed_at = NULL, last_heartbeat_at = NULL, updated_at = ?,
                   review_bounce_count = 0, status_note = ?
             WHERE id = ?`,
          )
          .run(to, ts, event.note ?? null, taskId);
        this.recordEvent({
          taskId,
          fromStatus: task.status,
          toStatus: to,
          kind: event.kind,
          payload: { note: event.note ?? null },
          actorAgentId,
        });
        return this.getTask(taskId);
      }
      case "submit_for_review": {
        const to = nextStatus(task.status, event);
        this.raw
          .prepare(
            `UPDATE tasks
               SET status = ?, assigned_agent_id = NULL, worktree_path = NULL,
                   claimed_at = NULL, last_heartbeat_at = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(to, ts, taskId);
        this.recordEvent({
          taskId,
          fromStatus: task.status,
          toStatus: to,
          kind: event.kind,
          payload: event.commit_sha ? { commit_sha: event.commit_sha } : {},
          actorAgentId,
        });
        return this.getTask(taskId);
      }
      case "claim":
      case "create":
      case "start_planning":
      case "plan_ready":
      case "start_execution":
      case "execution_ready":
      case "start_review":
      case "review_decision":
      case "enter_human_review":
      case "report_limit":
        return this.getTask(taskId);
      default:
        return this.getTask(taskId);
    }
  }

  async claimNextTask(agentId: string): Promise<Task | null> {
    return this.claimTaskInternal(agentId);
  }

  async claimTaskForAgent(taskId: string, agentId: string): Promise<Task | null> {
    return this.claimTaskInternal(agentId, taskId);
  }

  private async claimTaskInternal(agentId: string, preferredTaskId?: string): Promise<Task | null> {
    const agent = this.getAgent(agentId);
    const ts = this.now().toISOString();
    const statuses = claimableStatusesFor(agent.role);
    const orderBy = claimOrderByFor(agent.role);
    const statusSql = statuses.map((status) => `'${status}'`).join(", ");
    const targetStatus = claimTargetStatusFor(agent.role);
    const eventKind = claimEventKindFor(agent.role);

    const row = this.raw.transaction(() => {
      const candidate = this.raw
        .prepare(
          `
          SELECT id, status, branch_name
          FROM tasks
          WHERE status IN (${statusSql})
            AND assigned_agent_id IS NULL
            ${preferredTaskId ? "AND id = ?" : ""}
          ORDER BY ${orderBy}
          LIMIT 1
          `,
        )
        .get(...(preferredTaskId ? [preferredTaskId] : [])) as
          | { id: string; status: string; branch_name: string | null }
          | undefined;

      if (!candidate) return null;

      const info = this.raw
        .prepare(
          `
          UPDATE tasks
             SET status = ?,
                 assigned_agent_id = ?,
                 claimed_at = ?,
                 last_heartbeat_at = ?,
                 updated_at = ?,
                 last_role = ?,
                 status_note = NULL
           WHERE id = ?
             AND status = ?
             AND assigned_agent_id IS NULL
          `,
        )
        .run(targetStatus, agentId, ts, ts, ts, agent.role, candidate.id, candidate.status);

      if (info.changes === 0) {
        return null;
      }

      this.raw
        .prepare(
          `UPDATE agents
             SET last_seen_at = ?
           WHERE id = ?`,
        )
        .run(ts, agentId);

      return {
        id: candidate.id,
        previous_status: taskStatusSchema.parse(candidate.status),
        previous_branch_name: candidate.branch_name,
      };
    })();

    if (!row) return null;

    let branchName: string;
    let worktreePath: string;
    try {
      const result = row.previous_branch_name
        ? await this.worktreeMgr.attachWorktree(row.id)
        : await this.worktreeMgr.createWorktree(row.id);
      branchName = result.branchName;
      worktreePath = result.worktreePath;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.raw
        .prepare(
          `UPDATE tasks
             SET status = ?,
                 assigned_agent_id = NULL,
                 claimed_at = NULL,
                 last_heartbeat_at = NULL,
                 updated_at = ?,
                 status_note = ?
           WHERE id = ?`,
        )
        .run(row.previous_status, ts, `Worktree setup failed: ${message}`, row.id);
      throw error;
    }

    this.raw
      .prepare("UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?")
      .run(branchName, worktreePath, ts, row.id);

    this.recordEvent({
      taskId: row.id,
      fromStatus: row.previous_status,
      toStatus: targetStatus,
      kind: eventKind,
      payload: { agent_id: agentId, role: agent.role },
      actorAgentId: agentId,
    });

    await this.startTaskAttempt(row.id, agentId);
    return this.getTask(row.id);
  }

  heartbeat(taskId: string, agentId: string): void {
    const ts = this.now().toISOString();
    const info = this.raw
      .prepare(
        `UPDATE tasks
           SET last_heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND assigned_agent_id = ?`,
      )
      .run(ts, ts, taskId, agentId);
    if (info.changes === 0) throw new NotAssignedError(taskId, agentId);

    this.raw
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(ts, agentId);
  }

  async reportLimit(taskId: string, agentId: string, reason: HandoffReason): Promise<Handoff> {
    handoffReasonSchema.parse(reason);
    const task = this.getTask(taskId);
    const agent = this.getAgent(agentId);
    if (task.assigned_agent_id !== agentId) throw new NotAssignedError(taskId, agentId);
    if (!["planning", "in_progress", "review", "merging"].includes(task.status)) {
      throw new Error(`Cannot report_limit from status ${task.status}`);
    }

    const snapshotCommit = await this.snapshotAndRemoveWorktree(taskId, reason);
    const ts = this.now().toISOString();
    const cooldownUntil = ["rate_limit", "context_limit", "crash"].includes(reason)
      ? new Date(this.now().getTime() + LIMIT_COOLDOWN_MS).toISOString()
      : null;
    const healthState: AgentHealthState = reason === "crash"
      ? "degraded"
      : cooldownUntil
        ? "cooldown"
        : "healthy";
    const handoffId = this.uuid();

    const handoffRow: Handoff = handoffSchema.parse({
      id: handoffId,
      task_id: taskId,
      from_agent_id: agentId,
      to_agent_id: null,
      reason,
      snapshot_commit: snapshotCommit,
      created_at: ts,
      completed_at: null,
    });

    const tx = this.raw.transaction(() => {
      this.raw
        .prepare(
          `UPDATE tasks
             SET assigned_agent_id = NULL,
                 worktree_path = NULL,
                 claimed_at = NULL,
                 last_heartbeat_at = NULL,
                 updated_at = ?,
                 last_role = ?,
                 status_note = ?
           WHERE id = ?`,
        )
        .run(ts, agent.role, `Requeued after ${reason}`, taskId);

      this.raw
        .prepare(
          `UPDATE agents
             SET last_seen_at = ?,
                 cooldown_until = ?,
                 last_limit_reason = ?,
                 health_state = ?
           WHERE id = ?`,
        )
        .run(ts, cooldownUntil, reason, healthState, agentId);

      this.raw
        .prepare(
          `INSERT INTO handoffs
           (id, task_id, from_agent_id, to_agent_id, reason, snapshot_commit, created_at, completed_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
        )
        .run(handoffId, taskId, agentId, reason, snapshotCommit, ts);

      this.recordEvent({
        taskId,
        fromStatus: task.status,
        toStatus: task.status,
        kind: "report_limit",
        payload: { reason, snapshot_commit: snapshotCommit, handoff_id: handoffId },
        actorAgentId: agentId,
      });
    });
    tx();
    this.finishTaskAttempt(taskId, agentId, {
      outcome: reason === "budget_exceeded" ? "budget_exceeded" : "handoff",
      handoffReason: reason,
      endedAt: ts,
    });

    return handoffRow;
  }

  async publishPlan(taskId: string, agentId: string, plan: string): Promise<Task> {
    const task = this.getTask(taskId);
    const agent = this.getAgent(agentId);
    ensureTaskOwnedBy(task, agentId);
    if (agent.role !== "planner") throw new Error(`Agent ${agentId} is not a planner`);
    if (task.status !== "planning") throw new Error(`Task ${taskId} is not planning`);

    await this.writeArtifact(taskId, "execution_plan", plan, agentId);
    this.finishTaskAttempt(taskId, agentId, {
      outcome: "completed",
    });
    return this.releaseTask(task, {
      actorAgentId: agentId,
      nextStatus: "in_progress",
      eventKind: "plan_ready",
      payload: { published: true },
      statusNote: null,
      reviewBounceCount: task.review_bounce_count,
      humanReviewReason: null,
      pullRequest: task.pull_request,
    });
  }

  async submitWork(taskId: string, agentId: string, commitSha?: string): Promise<Task> {
    const task = this.getTask(taskId);
    const agent = this.getAgent(agentId);
    ensureTaskOwnedBy(task, agentId);
    if (agent.role !== "executor") throw new Error(`Agent ${agentId} is not an executor`);
    if (task.status !== "in_progress") throw new Error(`Task ${taskId} is not in progress`);

    this.finishTaskAttempt(taskId, agentId, {
      outcome: "completed",
    });
    return this.releaseTask(task, {
      actorAgentId: agentId,
      nextStatus: "review",
      eventKind: "execution_ready",
      payload: commitSha ? { commit_sha: commitSha } : {},
      statusNote: null,
      reviewBounceCount: task.review_bounce_count,
      humanReviewReason: null,
      pullRequest: task.pull_request,
    });
  }

  async submitReview(taskId: string, agentId: string, input: SubmitReviewInput): Promise<Task> {
    const task = this.getTask(taskId);
    const agent = this.getAgent(agentId);
    ensureTaskOwnedBy(task, agentId);
    if (agent.role !== "reviewer") throw new Error(`Agent ${agentId} is not a reviewer`);
    return this.reviewDecision(task, input, agentId);
  }

  async reviewDecision(
    task: Task | string,
    input: SubmitReviewInput,
    actorAgentId: string | null = null,
  ): Promise<Task> {
    const current = typeof task === "string" ? this.getTask(task) : task;
    if (current.status !== "review") throw new Error(`Task ${current.id} is not in review`);
    reviewDecisionSchema.parse(input.decision);

    if (input.note?.trim()) {
      await this.writeArtifact(current.id, "review_report", input.note, actorAgentId ?? undefined);
    }

    const nextCount = input.decision === "bounce"
      ? current.review_bounce_count + 1
      : current.review_bounce_count;

    if (input.decision === "approve") {
      throw new Error("Approving review requires PR publication before entering human_review");
    }

    if (nextCount >= 3) {
      this.finishTaskAttempt(current.id, actorAgentId, {
        outcome: "completed",
      });
      return this.enterHumanReview(current, {
        note: input.note ?? "Task requires human review",
        reason: "bounce_escalation",
        preserveWorktree: false,
      }, actorAgentId, nextCount);
    }

    this.finishTaskAttempt(current.id, actorAgentId, {
      outcome: "completed",
    });
    return this.releaseTask(current, {
      actorAgentId,
      nextStatus: "todo",
      eventKind: "review_decision",
      payload: { decision: "bounce", note: input.note ?? null, review_bounce_count: nextCount },
      statusNote: input.note ?? null,
      reviewBounceCount: nextCount,
      humanReviewReason: null,
      pullRequest: undefined,
    });
  }

  async approveForHumanReview(
    taskId: string,
    input: EnterHumanReviewInput,
    actorAgentId: string | null = null,
  ): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status !== "review") throw new Error(`Task ${taskId} is not in review`);
    if (input.reason !== "approval") {
      throw new Error(`approveForHumanReview only supports approval reason, got ${input.reason}`);
    }
    if (input.note?.trim()) {
      await this.writeArtifact(task.id, "review_report", input.note, actorAgentId ?? undefined);
    }
    this.finishTaskAttempt(task.id, actorAgentId, {
      outcome: "completed",
    });
    return this.enterHumanReview(task, input, actorAgentId, task.review_bounce_count);
  }

  updateTaskPullRequest(taskId: string, input: TaskPullRequestUpdateInput): Task {
    const task = this.getTask(taskId);
    const normalized = normalizeTaskPullRequest(task.pull_request, input);
    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `UPDATE tasks
           SET pr_provider = ?,
               pr_base_branch = ?,
               pr_head_branch = ?,
               pr_head_sha = ?,
               pr_number = ?,
               pr_url = ?,
               pr_review_decision = ?,
               pr_merged_sha = ?,
               pr_last_synced_at = ?,
               pr_last_error = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        normalized?.provider ?? null,
        normalized?.base_branch ?? null,
        normalized?.head_branch ?? null,
        normalized?.head_sha ?? null,
        normalized?.number ?? null,
        normalized?.url ?? null,
        normalized?.review_decision ?? null,
        normalized?.merged_sha ?? null,
        normalized?.last_synced_at ?? null,
        normalized?.last_error ?? null,
        ts,
        taskId,
      );
    return this.getTask(taskId);
  }

  queueMerge(taskId: string, actorAgentId: string | null = null): Task {
    const task = this.getTask(taskId);
    if (task.status !== "human_review") throw new Error(`Task ${taskId} is not in human_review`);
    if (task.human_review_reason !== "approval") {
      throw new Error(`Task ${taskId} is not awaiting merge approval`);
    }
    if (task.pull_request?.review_decision !== "APPROVED") {
      throw new Error(`Task ${taskId} pull request is not approved`);
    }

    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `UPDATE tasks
           SET status = 'merging',
               assigned_agent_id = NULL,
               claimed_at = NULL,
               last_heartbeat_at = NULL,
               updated_at = ?,
               human_review_reason = NULL,
               status_note = NULL
         WHERE id = ?`,
      )
      .run(ts, taskId);

    this.recordEvent({
      taskId,
      fromStatus: "human_review",
      toStatus: "merging",
      kind: "queue_merge",
      payload: { pr_number: task.pull_request?.number ?? null, pr_url: task.pull_request?.url ?? null },
      actorAgentId,
    });

    return this.getTask(taskId);
  }

  async submitMergeResult(
    taskId: string,
    agentId: string | null,
    input: MergeResultInput,
  ): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status !== "merging") throw new Error(`Task ${taskId} is not in merging`);
    mergeResultSchema.parse(input.result);

    const pullRequest = normalizeTaskPullRequest(task.pull_request, {
      ...input.pullRequest,
      ...(input.mergedSha ? { mergedSha: input.mergedSha } : {}),
    });

    if (input.result === "merged") {
      this.finishTaskAttempt(task.id, agentId, {
        outcome: "completed",
      });
      return this.releaseTask(task, {
        actorAgentId: agentId,
        nextStatus: "done",
        eventKind: "merge_result",
        payload: {
          result: "merged",
          note: input.note ?? null,
          merged_sha: input.mergedSha ?? pullRequest?.merged_sha ?? null,
        },
        statusNote: null,
        reviewBounceCount: task.review_bounce_count,
        humanReviewReason: null,
        pullRequest,
        preserveWorktree: false,
      });
    }

    const reason = humanReviewReasonSchema.parse(input.reason ?? (input.result === "blocked" ? "merge_conflict" : "approval"));
    if (input.note?.trim()) {
      await this.writeArtifact(task.id, "merge_report", input.note, agentId ?? undefined);
    }

    this.finishTaskAttempt(task.id, agentId, {
      outcome: input.result === "reapproval_required" ? "approval_requested" : "failed",
    });
    return this.releaseTask(task, {
      actorAgentId: agentId,
      nextStatus: "human_review",
      eventKind: "merge_result",
      payload: {
        result: input.result,
        note: input.note ?? null,
        merged_sha: input.mergedSha ?? pullRequest?.merged_sha ?? null,
        reason,
      },
      statusNote: input.note ?? null,
      reviewBounceCount: task.review_bounce_count,
      humanReviewReason: reason,
      pullRequest,
      preserveWorktree: input.preserveWorktree ?? true,
    });
  }

  async recordExternalMerge(
    taskId: string,
    actorAgentId: string | null,
    input: {
      mergedSha: string;
      note?: string;
      pullRequest?: TaskPullRequestUpdateInput;
      preserveWorktree?: boolean;
    },
  ): Promise<Task> {
    const task = this.getTask(taskId);
    if (!["human_review", "merging"].includes(task.status)) {
      throw new Error(`Task ${taskId} is not in human_review or merging`);
    }
    if (!input.mergedSha.trim()) {
      throw new Error("mergedSha is required");
    }

    const pullRequest = normalizeTaskPullRequest(task.pull_request, {
      ...input.pullRequest,
      mergedSha: input.mergedSha,
    });

    this.finishTaskAttempt(task.id, actorAgentId, {
      outcome: "completed",
    });
    return this.releaseTask(task, {
      actorAgentId,
      nextStatus: "done",
      eventKind: "merge_result",
      payload: {
        result: "merged",
        note: input.note ?? null,
        merged_sha: input.mergedSha,
        source: "external",
      },
      statusNote: null,
      reviewBounceCount: task.review_bounce_count,
      humanReviewReason: null,
      pullRequest,
      preserveWorktree: input.preserveWorktree ?? false,
    });
  }

  async returnToTodo(taskId: string, note?: string, actorAgentId: string | null = null): Promise<Task> {
    const task = this.getTask(taskId);
    if (!["human_review", "merging"].includes(task.status)) {
      throw new Error(`Task ${taskId} is not in human_review or merging`);
    }

    if (task.worktree_path) {
      await this.worktreeMgr.removeWorktree(taskId, { keepBranch: true });
    }

    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `UPDATE tasks
           SET status = 'todo',
               assigned_agent_id = NULL,
               worktree_path = NULL,
               claimed_at = NULL,
               last_heartbeat_at = NULL,
               updated_at = ?,
               review_bounce_count = 0,
               human_review_reason = NULL,
               status_note = ?,
               last_role = NULL
         WHERE id = ?`,
      )
      .run(ts, note ?? null, taskId);

    this.recordEvent({
      taskId,
      fromStatus: task.status,
      toStatus: "todo",
      kind: "return_to_todo",
      payload: { note: note ?? null },
      actorAgentId,
    });

    return this.getTask(taskId);
  }

  async cancelTask(taskId: string, actorAgentId: string | null = null): Promise<Task> {
    const task = this.getTask(taskId);
    this.finishTaskAttempt(taskId, task.assigned_agent_id, {
      outcome: "cancelled",
    });
    if (task.worktree_path) {
      await this.worktreeMgr.removeWorktree(taskId, { keepBranch: true });
    }
    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `UPDATE tasks
           SET status = 'cancelled',
               assigned_agent_id = NULL,
               worktree_path = NULL,
               claimed_at = NULL,
               last_heartbeat_at = NULL,
               updated_at = ?,
               human_review_reason = NULL
         WHERE id = ?`,
      )
      .run(ts, taskId);
    this.recordEvent({
      taskId,
      fromStatus: task.status,
      toStatus: "cancelled",
      kind: "cancel",
      payload: {},
      actorAgentId,
    });
    return this.getTask(taskId);
  }

  async ensureTaskWorktree(taskId: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.worktree_path && existsSync(task.worktree_path)) return task;

    const ts = this.now().toISOString();
    const result = task.branch_name
      ? await this.worktreeMgr.attachWorktree(taskId)
      : await this.worktreeMgr.createWorktree(taskId);

    this.raw
      .prepare("UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?")
      .run(result.branchName, result.worktreePath, ts, taskId);

    return this.getTask(taskId);
  }

  async failHumanReviewApproval(
    taskId: string,
    note: string,
    actorAgentId: string | null = null,
    pullRequest?: TaskPullRequestUpdateInput,
  ): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status !== "review") throw new Error(`Task ${taskId} is not in review`);
    const message = note.trim();
    if (!message) throw new Error("Approval failure note is required");
    await this.writeArtifact(task.id, "review_report", message, actorAgentId ?? undefined);
    this.finishTaskAttempt(task.id, actorAgentId, {
      outcome: "failed",
    });
    return this.releaseTask(task, {
      actorAgentId,
      nextStatus: "review",
      eventKind: "review_decision",
      payload: { decision: "approve", blocked: true, note: message },
      statusNote: message,
      reviewBounceCount: task.review_bounce_count,
      humanReviewReason: null,
      pullRequest: normalizeTaskPullRequest(task.pull_request, pullRequest),
      preserveWorktree: false,
    });
  }

  artifactDir(taskId: string): string {
    return path.join(this.repoRoot, ".deltapilot", "artifacts", taskId);
  }

  async writeArtifact(
    taskId: string,
    kind: ArtifactKind,
    content: string,
    authorAgentId?: string,
  ): Promise<{ id: string; path: string }> {
    artifactKindSchema.parse(kind);
    const dir = this.artifactDir(taskId);
    await mkdir(dir, { recursive: true });
    const extension = kind === "checkpoint" ? "json" : "md";
    const filePath = path.join(dir, `${kind}.${extension}`);
    await writeFile(filePath, content, "utf8");

    const existing = this.raw
      .prepare("SELECT id FROM artifacts WHERE task_id = ? AND kind = ?")
      .get(taskId, kind) as { id: string } | undefined;

    const ts = this.now().toISOString();
    const artifactId = existing?.id ?? this.uuid();
    if (existing) {
      this.raw
        .prepare("UPDATE artifacts SET path = ?, author_agent_id = ?, created_at = ? WHERE id = ?")
        .run(filePath, authorAgentId ?? null, ts, existing.id);
    } else {
      this.raw
        .prepare(
          `INSERT INTO artifacts (id, task_id, kind, path, author_agent_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(artifactId, taskId, kind, filePath, authorAgentId ?? null, ts);
    }

    return { id: artifactId, path: filePath };
  }

  async readArtifact(taskId: string, kind: ArtifactKind): Promise<string | null> {
    const row = this.raw
      .prepare("SELECT path FROM artifacts WHERE task_id = ? AND kind = ?")
      .get(taskId, kind) as { path: string } | undefined;
    if (!row || !existsSync(row.path)) return null;
    return readFile(row.path, "utf8");
  }

  listTaskAttempts(filter?: {
    taskId?: string;
    agentId?: string;
    activeOnly?: boolean;
  }): TaskAttempt[] {
    let sql = "SELECT * FROM task_attempts";
    const args: Array<string> = [];
    const where: string[] = [];
    if (filter?.taskId) {
      where.push("task_id = ?");
      args.push(filter.taskId);
    }
    if (filter?.agentId) {
      where.push("agent_id = ?");
      args.push(filter.agentId);
    }
    if (filter?.activeOnly) {
      where.push("ended_at IS NULL");
    }
    if (where.length > 0) {
      sql += ` WHERE ${where.join(" AND ")}`;
    }
    sql += " ORDER BY started_at DESC";
    const rows = this.raw.prepare(sql).all(...args) as TaskAttemptRow[];
    return rows.map(rowToTaskAttempt);
  }

  getActiveTaskAttempt(taskId: string): TaskAttempt | null {
    const row = this.raw
      .prepare(
        `SELECT *
         FROM task_attempts
         WHERE task_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(taskId) as TaskAttemptRow | undefined;
    return row ? rowToTaskAttempt(row) : null;
  }

  async startTaskAttempt(taskId: string, agentId: string): Promise<TaskAttempt> {
    const task = this.getTask(taskId);
    const agent = this.getAgent(agentId);
    const ts = this.now().toISOString();
    const active = this.getActiveTaskAttempt(taskId);
    if (active && active.agent_id === agentId) {
      return active;
    }
    if (active) {
      this.updateTaskAttempt(active.id, {
        outcome: active.outcome ?? "failed",
        endedAt: ts,
      });
    }

    const nextAttemptNumber = this.raw
      .prepare(
        "SELECT COALESCE(MAX(attempt_number), 0) + 1 AS attempt_number FROM task_attempts WHERE task_id = ?",
      )
      .get(taskId) as { attempt_number: number };
    const id = this.uuid();

    this.raw
      .prepare(
        `INSERT INTO task_attempts
         (id, task_id, agent_id, role, provider, model, attempt_number, started_at, ended_at,
          outcome, handoff_reason, prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms,
          checkpoint_artifact_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)`,
      )
      .run(
        id,
        task.id,
        agent.id,
        agent.role,
        agent.provider_family,
        agent.model_id,
        nextAttemptNumber.attempt_number,
        ts,
      );

    return rowToTaskAttempt(this.raw.prepare("SELECT * FROM task_attempts WHERE id = ?").get(id) as TaskAttemptRow);
  }

  updateTaskAttempt(attemptId: string, input: UpdateTaskAttemptInput): TaskAttempt {
    const current = this.raw
      .prepare("SELECT * FROM task_attempts WHERE id = ?")
      .get(attemptId) as TaskAttemptRow | undefined;
    if (!current) throw new Error(`Task attempt not found: ${attemptId}`);

    const next = {
      provider: input.provider === undefined ? current.provider : input.provider,
      model: input.model === undefined ? current.model : input.model,
      promptTokens: input.promptTokens === undefined ? current.prompt_tokens : input.promptTokens,
      completionTokens:
        input.completionTokens === undefined ? current.completion_tokens : input.completionTokens,
      estimatedCostUsd:
        input.estimatedCostUsd === undefined
          ? current.estimated_cost_usd === null
            ? null
            : Number.parseFloat(current.estimated_cost_usd)
          : input.estimatedCostUsd,
      latencyMs: input.latencyMs === undefined ? current.latency_ms : input.latencyMs,
      checkpointArtifactId:
        input.checkpointArtifactId === undefined
          ? current.checkpoint_artifact_id
          : input.checkpointArtifactId,
      outcome: input.outcome === undefined ? current.outcome : input.outcome,
      handoffReason:
        input.handoffReason === undefined ? current.handoff_reason : input.handoffReason,
      endedAt: input.endedAt === undefined ? current.ended_at : input.endedAt,
    };

    this.raw
      .prepare(
        `UPDATE task_attempts
           SET provider = ?,
               model = ?,
               prompt_tokens = ?,
               completion_tokens = ?,
               estimated_cost_usd = ?,
               latency_ms = ?,
               checkpoint_artifact_id = ?,
               outcome = ?,
               handoff_reason = ?,
               ended_at = ?
         WHERE id = ?`,
      )
      .run(
        next.provider,
        next.model ?? null,
        next.promptTokens ?? null,
        next.completionTokens ?? null,
        next.estimatedCostUsd === null || next.estimatedCostUsd === undefined
          ? null
          : String(next.estimatedCostUsd),
        next.latencyMs ?? null,
        next.checkpointArtifactId ?? null,
        next.outcome ?? null,
        next.handoffReason ?? null,
        next.endedAt ?? null,
        attemptId,
      );

    return rowToTaskAttempt(this.raw.prepare("SELECT * FROM task_attempts WHERE id = ?").get(attemptId) as TaskAttemptRow);
  }

  reportTaskUsage(
    taskId: string,
    agentId: string,
    input: {
      provider?: AgentProviderFamily;
      model?: string | null;
      promptTokens?: number | null;
      completionTokens?: number | null;
      estimatedCostUsd?: number | null;
      latencyMs?: number | null;
    },
  ): TaskAttempt {
    const active = this.getActiveTaskAttempt(taskId);
    if (!active || active.agent_id !== agentId) {
      throw new NotAssignedError(taskId, agentId);
    }

    return this.updateTaskAttempt(active.id, {
      provider: input.provider,
      model: input.model,
      promptTokens: input.promptTokens,
      completionTokens: input.completionTokens,
      estimatedCostUsd: input.estimatedCostUsd,
      latencyMs: input.latencyMs,
    });
  }

  async publishCheckpoint(
    taskId: string,
    agentId: string,
    checkpoint: TaskCheckpoint,
  ): Promise<TaskAttempt> {
    const active = this.getActiveTaskAttempt(taskId);
    if (!active || active.agent_id !== agentId) {
      throw new NotAssignedError(taskId, agentId);
    }

    const artifact = await this.writeArtifact(
      taskId,
      "checkpoint",
      `${JSON.stringify(taskCheckpointSchema.parse(checkpoint), null, 2)}\n`,
      agentId,
    );

    return this.updateTaskAttempt(active.id, {
      checkpointArtifactId: artifact.id,
    });
  }

  finishTaskAttempt(
    taskId: string,
    agentId: string | null,
    input: {
      outcome: TaskAttemptOutcome;
      handoffReason?: HandoffReason | null;
      endedAt?: string;
    },
  ): TaskAttempt | null {
    const active = this.getActiveTaskAttempt(taskId);
    if (!active) return null;
    if (agentId !== null && active.agent_id !== agentId) return null;
    return this.updateTaskAttempt(active.id, {
      outcome: taskAttemptOutcomeSchema.parse(input.outcome),
      handoffReason: input.handoffReason ?? null,
      endedAt: input.endedAt ?? this.now().toISOString(),
    });
  }

  createAgentSession(input: CreateAgentSessionInput): AgentSession {
    this.getAgent(input.agentId);
    const sessionId = this.uuid();
    const ts = this.now().toISOString();
    const status = sessionStatusSchema.parse(input.status ?? "starting");
    this.raw
      .prepare(
        `INSERT INTO agent_sessions
         (id, agent_id, task_id, status, pid, log_path, started_at, ended_at, last_seen_at, last_error)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`,
      )
      .run(
        sessionId,
        input.agentId,
        input.taskId ?? null,
        status,
        input.pid ?? null,
        input.logPath,
        ts,
        ts,
      );
    return this.getAgentSession(sessionId);
  }

  updateAgentSession(sessionId: string, input: UpdateAgentSessionInput): AgentSession {
    const current = this.getAgentSession(sessionId);
    const nextStatusValue = input.status ?? current.status;
    sessionStatusSchema.parse(nextStatusValue);
    this.raw
      .prepare(
        `UPDATE agent_sessions
           SET task_id = ?,
               status = ?,
               pid = ?,
               ended_at = ?,
               last_seen_at = ?,
               last_error = ?
         WHERE id = ?`,
      )
      .run(
        input.taskId === undefined ? current.task_id : input.taskId,
        nextStatusValue,
        input.pid === undefined ? current.pid : input.pid,
        input.endedAt === undefined ? current.ended_at : input.endedAt,
        input.lastSeenAt === undefined ? (input.status ? this.now().toISOString() : current.last_seen_at) : input.lastSeenAt,
        input.lastError === undefined ? current.last_error : input.lastError,
        sessionId,
      );
    return this.getAgentSession(sessionId);
  }

  getAgentSession(sessionId: string): AgentSession {
    const row = this.raw
      .prepare("SELECT * FROM agent_sessions WHERE id = ?")
      .get(sessionId) as AgentSessionRow | undefined;
    if (!row) throw new Error(`Agent session not found: ${sessionId}`);
    return rowToAgentSession(row);
  }

  getOpenSessionForAgent(agentId: string): AgentSession | null {
    const row = this.raw
      .prepare(
        `SELECT *
         FROM agent_sessions
         WHERE agent_id = ? AND ended_at IS NULL
         ORDER BY started_at DESC
         LIMIT 1`,
      )
      .get(agentId) as AgentSessionRow | undefined;
    return row ? rowToAgentSession(row) : null;
  }

  listAgentSessions(filter?: { agentId?: string; managedOnly?: boolean }): AgentSession[] {
    const rows = filter?.agentId
      ? (this.raw
          .prepare("SELECT * FROM agent_sessions WHERE agent_id = ? ORDER BY started_at DESC")
          .all(filter.agentId) as AgentSessionRow[])
      : (this.raw
          .prepare("SELECT * FROM agent_sessions ORDER BY started_at DESC")
          .all() as AgentSessionRow[]);

    if (!filter?.managedOnly) return rows.map(rowToAgentSession);

    const managedAgentIds = new Set(
      this.raw
        .prepare("SELECT id FROM agents WHERE runtime_mode = 'managed'")
        .all()
        .map((row) => (row as { id: string }).id),
    );
    return rows.filter((row) => managedAgentIds.has(row.agent_id)).map(rowToAgentSession);
  }

  async requestAgentApproval(
    input: Omit<CreateApprovalRequestInput, "sessionId">,
  ): Promise<ApprovalRequest> {
    const session = await this.ensureSessionForAgent(input.agentId);
    const approval = this.createApprovalRequest({
      ...input,
      sessionId: session.id,
    });
    this.createSessionMessage({
      sessionId: session.id,
      approvalRequestId: approval.id,
      direction: "agent",
      kind: input.kind,
      body: input.body,
    });
    if (session.status !== "waiting") {
      this.updateAgentSession(session.id, { status: "waiting" });
    }
    return approval;
  }

  createApprovalRequest(input: CreateApprovalRequestInput): ApprovalRequest {
    approvalRequestKindSchema.parse(input.kind);
    const id = this.uuid();
    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `INSERT INTO approval_requests
         (id, session_id, task_id, agent_id, kind, status, title, body, response_note, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, NULL, ?, NULL)`,
      )
      .run(id, input.sessionId, input.taskId ?? null, input.agentId, input.kind, input.title, input.body, ts);
    return this.getApprovalRequest(id);
  }

  resolveApprovalRequest(
    approvalRequestId: string,
    decision: "approved" | "rejected",
    note?: string,
  ): ApprovalRequest {
    const current = this.getApprovalRequest(approvalRequestId);
    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `UPDATE approval_requests
           SET status = ?, response_note = ?, resolved_at = ?
         WHERE id = ?`,
      )
      .run(decision, note ?? null, ts, approvalRequestId);
    return this.getApprovalRequest(approvalRequestId);
  }

  getApprovalRequest(approvalRequestId: string): ApprovalRequest {
    const row = this.raw
      .prepare("SELECT * FROM approval_requests WHERE id = ?")
      .get(approvalRequestId) as ApprovalRequestRow | undefined;
    if (!row) throw new Error(`Approval request not found: ${approvalRequestId}`);
    return rowToApprovalRequest(row);
  }

  listApprovalRequests(filter?: { status?: "pending" | "approved" | "rejected"; sessionId?: string }): ApprovalRequest[] {
    let sql = "SELECT * FROM approval_requests";
    const args: Array<string> = [];
    const where: string[] = [];
    if (filter?.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (filter?.sessionId) {
      where.push("session_id = ?");
      args.push(filter.sessionId);
    }
    if (where.length > 0) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY created_at DESC";
    const rows = this.raw.prepare(sql).all(...args) as ApprovalRequestRow[];
    return rows.map(rowToApprovalRequest);
  }

  createSessionMessage(input: CreateSessionMessageInput): SessionMessage {
    sessionMessageDirectionSchema.parse(input.direction);
    const id = this.uuid();
    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `INSERT INTO session_messages
         (id, session_id, approval_request_id, direction, kind, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sessionId,
        input.approvalRequestId ?? null,
        input.direction,
        input.kind,
        input.body,
        ts,
      );
    return this.getSessionMessage(id);
  }

  getSessionMessage(messageId: string): SessionMessage {
    const row = this.raw
      .prepare("SELECT * FROM session_messages WHERE id = ?")
      .get(messageId) as SessionMessageRow | undefined;
    if (!row) throw new Error(`Session message not found: ${messageId}`);
    return rowToSessionMessage(row);
  }

  listSessionMessages(sessionId: string): SessionMessage[] {
    const rows = this.raw
      .prepare(
        `SELECT * FROM session_messages
         WHERE session_id = ?
         ORDER BY created_at ASC`,
      )
      .all(sessionId) as SessionMessageRow[];
    return rows.map(rowToSessionMessage);
  }

  setAgentCooldown(agentId: string, cooldownUntil: string | null, reason?: HandoffReason | null): Agent {
    this.getAgent(agentId);
    this.raw
      .prepare(
        `UPDATE agents
           SET cooldown_until = ?,
               last_limit_reason = ?,
               health_state = ?
         WHERE id = ?`,
      )
      .run(
        cooldownUntil,
        reason ?? null,
        cooldownUntil
          ? "cooldown"
          : reason === "crash"
            ? "degraded"
            : "healthy",
        agentId,
      );
    return this.getAgent(agentId);
  }

  private async ensureSessionForAgent(agentId: string): Promise<AgentSession> {
    this.getAgent(agentId);
    const existing = this.getOpenSessionForAgent(agentId);
    if (existing) return existing;

    const sessionsDir = path.join(this.repoRoot, ".deltapilot", "sessions");
    await mkdir(sessionsDir, { recursive: true });
    const sessionId = this.uuid();
    const logPath = path.join(sessionsDir, `${sessionId}.log`);
    await writeFile(logPath, "", "utf8");

    return this.createAgentSession({
      agentId,
      logPath,
      status: "waiting",
    });
  }

  private async releaseTask(
    task: Task,
    input: {
      actorAgentId: string | null;
      nextStatus: TaskStatus;
      eventKind: string;
      payload: Record<string, unknown>;
      statusNote: string | null;
      reviewBounceCount: number;
      humanReviewReason: HumanReviewReason | null;
      pullRequest?: TaskPullRequest | null;
      preserveWorktree?: boolean;
    },
  ): Promise<Task> {
    const preserveWorktree = input.preserveWorktree ?? false;
    if (!preserveWorktree && task.worktree_path) {
      await this.worktreeMgr.removeWorktree(task.id, { keepBranch: true });
    }

    const pullRequest = input.pullRequest === undefined
      ? task.pull_request
      : input.pullRequest;
    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `UPDATE tasks
           SET status = ?,
               assigned_agent_id = NULL,
               worktree_path = ?,
               claimed_at = NULL,
               last_heartbeat_at = NULL,
               updated_at = ?,
               review_bounce_count = ?,
               human_review_reason = ?,
               pr_provider = ?,
               pr_base_branch = ?,
               pr_head_branch = ?,
               pr_head_sha = ?,
               pr_number = ?,
               pr_url = ?,
               pr_review_decision = ?,
               pr_merged_sha = ?,
               pr_last_synced_at = ?,
               pr_last_error = ?,
               status_note = ?,
               last_role = ?
         WHERE id = ?`,
      )
      .run(
        input.nextStatus,
        preserveWorktree ? task.worktree_path : null,
        ts,
        input.reviewBounceCount,
        input.humanReviewReason,
        pullRequest?.provider ?? null,
        pullRequest?.base_branch ?? null,
        pullRequest?.head_branch ?? null,
        pullRequest?.head_sha ?? null,
        pullRequest?.number ?? null,
        pullRequest?.url ?? null,
        pullRequest?.review_decision ?? null,
        pullRequest?.merged_sha ?? null,
        pullRequest?.last_synced_at ?? null,
        pullRequest?.last_error ?? null,
        input.statusNote,
        task.last_role,
        task.id,
      );

    this.recordEvent({
      taskId: task.id,
      fromStatus: task.status,
      toStatus: input.nextStatus,
      kind: input.eventKind,
      payload: input.payload,
      actorAgentId: input.actorAgentId,
    });

    return this.getTask(task.id);
  }

  private async enterHumanReview(
    task: Task,
    input: EnterHumanReviewInput,
    actorAgentId: string | null,
    reviewBounceCount: number,
  ): Promise<Task> {
    const reason = humanReviewReasonSchema.parse(input.reason);
    const pullRequest = normalizeTaskPullRequest(task.pull_request, input.pullRequest);
    return this.releaseTask(task, {
      actorAgentId,
      nextStatus: "human_review",
      eventKind: reason === "approval" ? "review_decision" : "enter_human_review",
      payload: reason === "approval"
        ? {
            decision: "approve",
            note: input.note ?? null,
            human_review_reason: reason,
            pr_number: pullRequest?.number ?? null,
            pr_url: pullRequest?.url ?? null,
          }
        : {
            note: input.note ?? "Task requires human review",
            reason,
            review_bounce_count: reviewBounceCount,
          },
      statusNote: input.note ?? null,
      reviewBounceCount,
      humanReviewReason: reason,
      pullRequest,
      preserveWorktree: input.preserveWorktree ?? reason === "approval",
    });
  }

  private async snapshotAndRemoveWorktree(taskId: string, reason: HandoffReason): Promise<string | null> {
    const task = this.getTask(taskId);
    const worktreePath = task.worktree_path;
    if (!worktreePath) return task.branch_name ? await this.headForBranch(task.branch_name) : null;

    const { stdout: statusOut } = await execa("git", ["status", "--porcelain"], {
      cwd: worktreePath,
    });
    if (statusOut.trim().length > 0) {
      await execa("git", ["add", "-A"], { cwd: worktreePath });
      await execa(
        "git",
        ["commit", "-m", `deltapilot: wip snapshot before handoff (${reason})`],
        { cwd: worktreePath },
      );
    }

    const { stdout: sha } = await execa("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    await this.worktreeMgr.removeWorktree(taskId, { keepBranch: true });
    return sha.trim();
  }

  private async headForBranch(branchName: string): Promise<string | null> {
    const { stdout } = await execa("git", ["rev-parse", branchName], {
      cwd: this.repoRoot,
      reject: false,
    });
    return stdout.trim() || null;
  }

  private recordEvent(e: {
    taskId: string;
    fromStatus: TaskStatus;
    toStatus: TaskStatus;
    kind: string;
    payload: Record<string, unknown>;
    actorAgentId: string | null;
  }): void {
    this.raw
      .prepare(
        `INSERT INTO task_events
         (id, task_id, kind, payload_json, actor_agent_id, from_status, to_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.uuid(),
        e.taskId,
        e.kind,
        JSON.stringify(e.payload),
        e.actorAgentId,
        e.fromStatus,
        e.toStatus,
        this.now().toISOString(),
      );
  }
}

function ensureTaskOwnedBy(task: Task, agentId: string): void {
  if (task.assigned_agent_id !== agentId) throw new NotAssignedError(task.id, agentId);
}

function claimableStatusesFor(role: AgentRole): TaskStatus[] {
  switch (role) {
    case "planner":
      return ["planning", "todo"];
    case "executor":
      return ["in_progress"];
    case "reviewer":
      return ["review"];
    case "merger":
      return ["merging"];
  }
}

function claimOrderByFor(role: AgentRole): string {
  switch (role) {
    case "planner":
      return "CASE status WHEN 'planning' THEN 0 ELSE 1 END, priority DESC, created_at ASC";
    case "executor":
    case "reviewer":
    case "merger":
      return "priority DESC, created_at ASC";
  }
}

function claimTargetStatusFor(role: AgentRole): TaskStatus {
  switch (role) {
    case "planner":
      return "planning";
    case "executor":
      return "in_progress";
    case "reviewer":
      return "review";
    case "merger":
      return "merging";
  }
}

function claimEventKindFor(role: AgentRole): TaskEvent["kind"] {
  switch (role) {
    case "planner":
      return "start_planning";
    case "executor":
      return "start_execution";
    case "reviewer":
      return "start_review";
    case "merger":
      return "start_merge";
  }
}

function rowToTask(row: TaskRow): Task {
  let acceptance: AcceptanceCriteria | null = null;
  if (row.acceptance_json !== null) {
    try {
      acceptance = normalizeAcceptanceCriteria(JSON.parse(row.acceptance_json));
    } catch {
      acceptance = null;
    }
  }
  let budget: TaskBudget | null = null;
  if (row.budget_json !== null) {
    try {
      budget = normalizeTaskBudget(JSON.parse(row.budget_json));
    } catch {
      budget = null;
    }
  }

  const pullRequest = buildTaskPullRequestFromRow(row);
  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    status: taskStatusSchema.parse(row.status),
    priority: row.priority,
    assigned_agent_id: row.assigned_agent_id,
    branch_name: row.branch_name,
    worktree_path: row.worktree_path,
    acceptance,
    budget,
    review_bounce_count: row.review_bounce_count,
    human_review_reason: row.human_review_reason
      ? humanReviewReasonSchema.parse(row.human_review_reason)
      : null,
    pull_request: pullRequest,
    last_role: row.last_role ? agentRoleSchema.parse(row.last_role) : null,
    status_note: row.status_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    last_heartbeat_at: row.last_heartbeat_at,
  };
}

function rowToAgent(row: AgentRow): Agent {
  const agent = {
    id: row.id,
    name: row.name,
    kind: agentKindSchema.parse(row.kind),
    role: agentRoleSchema.parse(row.role),
    runtime_mode: agentRuntimeModeSchema.parse(row.runtime_mode),
    transport: agentTransportSchema.parse(row.transport),
    enabled: Boolean(row.enabled),
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
    cooldown_until: row.cooldown_until,
    last_limit_reason: row.last_limit_reason ? handoffReasonSchema.parse(row.last_limit_reason) : null,
    provider_family: agentProviderFamilySchema.parse(row.provider_family),
    model_id: row.model_id,
    context_window: row.context_window,
    cost_tier: agentCostTierSchema.parse(row.cost_tier),
    supports_tools: Boolean(row.supports_tools),
    supports_patch: Boolean(row.supports_patch),
    supports_review: Boolean(row.supports_review),
    max_concurrency: row.max_concurrency,
    fallback_priority: row.fallback_priority,
    health_state: agentHealthStateSchema.parse(row.health_state),
  } satisfies Agent;

  return applyOptionalAgentFields(agent, row);
}

function rowToTaskAttempt(row: TaskAttemptRow): TaskAttempt {
  return taskAttemptSchema.parse({
    id: row.id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    role: agentRoleSchema.parse(row.role),
    provider: agentProviderFamilySchema.parse(row.provider),
    model: row.model,
    attempt_number: row.attempt_number,
    started_at: row.started_at,
    ended_at: row.ended_at,
    outcome: row.outcome ? taskAttemptOutcomeSchema.parse(row.outcome) : null,
    handoff_reason: row.handoff_reason ? handoffReasonSchema.parse(row.handoff_reason) : null,
    prompt_tokens: row.prompt_tokens,
    completion_tokens: row.completion_tokens,
    estimated_cost_usd: row.estimated_cost_usd === null ? null : Number.parseFloat(row.estimated_cost_usd),
    latency_ms: row.latency_ms,
    checkpoint_artifact_id: row.checkpoint_artifact_id,
  });
}

function applyOptionalAgentFields(agent: Agent, row: AgentRow): Agent {
  if (row.command !== null) agent.command = row.command;
  if (row.endpoint !== null) agent.endpoint = row.endpoint;
  return agent;
}

function rowToAgentSession(row: AgentSessionRow): AgentSession {
  return agentSessionSchema.parse({
    id: row.id,
    agent_id: row.agent_id,
    task_id: row.task_id,
    status: sessionStatusSchema.parse(row.status),
    pid: row.pid,
    log_path: row.log_path,
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_seen_at: row.last_seen_at,
    last_error: row.last_error,
  });
}

function buildTaskPullRequestFromRow(row: TaskRow): TaskPullRequest | null {
  if (!row.pr_provider) return null;
  return taskPullRequestSchema.parse({
    provider: row.pr_provider,
    base_branch: row.pr_base_branch,
    head_branch: row.pr_head_branch,
    head_sha: row.pr_head_sha,
    number: row.pr_number,
    url: row.pr_url,
    review_decision: row.pr_review_decision
      ? githubPullRequestReviewDecisionSchema.parse(row.pr_review_decision)
      : null,
    merged_sha: row.pr_merged_sha,
    last_synced_at: row.pr_last_synced_at,
    last_error: row.pr_last_error,
  });
}

function normalizeTaskPullRequest(
  current: TaskPullRequest | null,
  input?: TaskPullRequestUpdateInput,
): TaskPullRequest | null {
  if (input === undefined) return current;
  if (input === null) return null;

  const next = {
    provider: input.provider === undefined ? current?.provider ?? null : input.provider,
    base_branch: input.baseBranch === undefined ? current?.base_branch ?? null : input.baseBranch,
    head_branch: input.headBranch === undefined ? current?.head_branch ?? null : input.headBranch,
    head_sha: input.headSha === undefined ? current?.head_sha ?? null : input.headSha,
    number: input.number === undefined ? current?.number ?? null : input.number,
    url: input.url === undefined ? current?.url ?? null : input.url,
    review_decision: input.reviewDecision === undefined ? current?.review_decision ?? null : input.reviewDecision,
    merged_sha: input.mergedSha === undefined ? current?.merged_sha ?? null : input.mergedSha,
    last_synced_at: input.lastSyncedAt === undefined ? current?.last_synced_at ?? null : input.lastSyncedAt,
    last_error: input.lastError === undefined ? current?.last_error ?? null : input.lastError,
  };

  if (!next.provider || !next.base_branch || !next.head_branch) {
    return null;
  }

  return taskPullRequestSchema.parse(next);
}

function rowToApprovalRequest(row: ApprovalRequestRow): ApprovalRequest {
  return approvalRequestSchema.parse({
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    kind: approvalRequestKindSchema.parse(row.kind),
    status: row.status,
    title: row.title,
    body: row.body,
    response_note: row.response_note,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  });
}

function rowToSessionMessage(row: SessionMessageRow): SessionMessage {
  return sessionMessageSchema.parse({
    id: row.id,
    session_id: row.session_id,
    approval_request_id: row.approval_request_id,
    direction: sessionMessageDirectionSchema.parse(row.direction),
    kind: row.kind,
    body: row.body,
    created_at: row.created_at,
  });
}
