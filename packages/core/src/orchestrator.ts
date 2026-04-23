import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  acceptanceCriteriaSchema,
  agentKindSchema,
  agentRoleSchema,
  agentRuntimeModeSchema,
  agentSessionSchema,
  agentTransportSchema,
  approvalRequestKindSchema,
  approvalRequestSchema,
  artifactKindSchema,
  handoffReasonSchema,
  handoffSchema,
  normalizeAcceptanceCriteria,
  normalizeTaskPriorityRank,
  nextStatus,
  reviewDecisionSchema,
  sessionMessageDirectionSchema,
  sessionMessageSchema,
  sessionStatusSchema,
  taskPriorityRankFromLabel,
  taskStatusSchema,
} from "@deltapilot/shared";
import type {
  AcceptanceCriteria,
  Agent,
  AgentKind,
  AgentRole,
  AgentRuntimeMode,
  AgentSession,
  AgentTransport,
  ApprovalRequest,
  ApprovalRequestKind,
  ArtifactKind,
  Handoff,
  HandoffReason,
  ReviewDecision,
  SessionMessage,
  SessionMessageDirection,
  SessionStatus,
  Task,
  TaskEvent,
  TaskPriorityLabel,
  TaskStatus,
} from "@deltapilot/shared";
import type { DrizzleDb } from "./db/client.js";
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
}

export interface CreateTaskInput {
  title: string;
  brief?: string;
  priority?: number | TaskPriorityLabel;
  acceptance?: AcceptanceCriteria;
}

export interface SubmitReviewInput {
  decision: ReviewDecision;
  note?: string;
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
  review_bounce_count: number;
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

    this.raw
      .prepare(
        `INSERT INTO agents
         (id, name, kind, role, runtime_mode, transport, enabled, command, endpoint,
          registered_at, last_seen_at, cooldown_until, last_limit_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
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
    };

    agentRoleSchema.parse(next.role);
    agentRuntimeModeSchema.parse(next.runtimeMode);

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
               last_limit_reason = ?
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

    this.raw
      .prepare(
        `INSERT INTO tasks
         (id, title, brief, status, priority, assigned_agent_id, branch_name, worktree_path,
          acceptance_json, review_bounce_count, last_role, status_note, created_at, updated_at,
          claimed_at, last_heartbeat_at)
         VALUES (?, ?, ?, 'todo', ?, NULL, NULL, NULL, ?, 0, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(id, input.title, input.brief ?? "", priority, acceptanceJson, ts, ts);

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
          ORDER BY ${orderBy}
          LIMIT 1
          `,
        )
        .get() as { id: string; status: string; branch_name: string | null } | undefined;

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
    if (!["planning", "in_progress", "review"].includes(task.status)) {
      throw new Error(`Cannot report_limit from status ${task.status}`);
    }

    const snapshotCommit = await this.snapshotAndRemoveWorktree(taskId, reason);
    const ts = this.now().toISOString();
    const cooldownUntil = new Date(this.now().getTime() + LIMIT_COOLDOWN_MS).toISOString();
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
                 last_limit_reason = ?
           WHERE id = ?`,
        )
        .run(ts, cooldownUntil, reason, agentId);

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

    return handoffRow;
  }

  async publishPlan(taskId: string, agentId: string, plan: string): Promise<Task> {
    const task = this.getTask(taskId);
    const agent = this.getAgent(agentId);
    ensureTaskOwnedBy(task, agentId);
    if (agent.role !== "planner") throw new Error(`Agent ${agentId} is not a planner`);
    if (task.status !== "planning") throw new Error(`Task ${taskId} is not planning`);

    await this.writeArtifact(taskId, "execution_plan", plan, agentId);
    return this.releaseTask(task, {
      actorAgentId: agentId,
      nextStatus: "in_progress",
      eventKind: "plan_ready",
      payload: { published: true },
      statusNote: null,
      reviewBounceCount: task.review_bounce_count,
    });
  }

  async submitWork(taskId: string, agentId: string, commitSha?: string): Promise<Task> {
    const task = this.getTask(taskId);
    const agent = this.getAgent(agentId);
    ensureTaskOwnedBy(task, agentId);
    if (agent.role !== "executor") throw new Error(`Agent ${agentId} is not an executor`);
    if (task.status !== "in_progress") throw new Error(`Task ${taskId} is not in progress`);

    return this.releaseTask(task, {
      actorAgentId: agentId,
      nextStatus: "review",
      eventKind: "execution_ready",
      payload: commitSha ? { commit_sha: commitSha } : {},
      statusNote: null,
      reviewBounceCount: task.review_bounce_count,
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
      return this.releaseTask(current, {
        actorAgentId,
        nextStatus: "done",
        eventKind: "review_decision",
        payload: { decision: "approve", note: input.note ?? null },
        statusNote: null,
        reviewBounceCount: nextCount,
      });
    }

    if (nextCount >= 3) {
      return this.releaseTask(current, {
        actorAgentId,
        nextStatus: "human_review",
        eventKind: "enter_human_review",
        payload: { note: input.note ?? "Task requires human review", review_bounce_count: nextCount },
        statusNote: input.note ?? "Task requires human review",
        reviewBounceCount: nextCount,
      });
    }

    return this.releaseTask(current, {
      actorAgentId,
      nextStatus: "todo",
      eventKind: "review_decision",
      payload: { decision: "bounce", note: input.note ?? null, review_bounce_count: nextCount },
      statusNote: input.note ?? null,
      reviewBounceCount: nextCount,
    });
  }

  async returnToTodo(taskId: string, note?: string, actorAgentId: string | null = null): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.status !== "human_review") throw new Error(`Task ${taskId} is not in human_review`);

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
               status_note = ?,
               last_role = NULL
         WHERE id = ?`,
      )
      .run(ts, note ?? null, taskId);

    this.recordEvent({
      taskId,
      fromStatus: "human_review",
      toStatus: "todo",
      kind: "return_to_todo",
      payload: { note: note ?? null },
      actorAgentId,
    });

    return this.getTask(taskId);
  }

  async cancelTask(taskId: string, actorAgentId: string | null = null): Promise<Task> {
    const task = this.getTask(taskId);
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
               updated_at = ?
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

  artifactDir(taskId: string): string {
    return path.join(this.repoRoot, ".deltapilot", "artifacts", taskId);
  }

  async writeArtifact(
    taskId: string,
    kind: ArtifactKind,
    content: string,
    authorAgentId?: string,
  ): Promise<{ path: string }> {
    artifactKindSchema.parse(kind);
    const dir = this.artifactDir(taskId);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${kind}.md`);
    await writeFile(filePath, content, "utf8");

    const existing = this.raw
      .prepare("SELECT id FROM artifacts WHERE task_id = ? AND kind = ?")
      .get(taskId, kind) as { id: string } | undefined;

    const ts = this.now().toISOString();
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
        .run(this.uuid(), taskId, kind, filePath, authorAgentId ?? null, ts);
    }

    return { path: filePath };
  }

  async readArtifact(taskId: string, kind: ArtifactKind): Promise<string | null> {
    const row = this.raw
      .prepare("SELECT path FROM artifacts WHERE task_id = ? AND kind = ?")
      .get(taskId, kind) as { path: string } | undefined;
    if (!row || !existsSync(row.path)) return null;
    return readFile(row.path, "utf8");
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
               last_limit_reason = ?
         WHERE id = ?`,
      )
      .run(cooldownUntil, reason ?? null, agentId);
    return this.getAgent(agentId);
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
    },
  ): Promise<Task> {
    if (task.worktree_path) {
      await this.worktreeMgr.removeWorktree(task.id, { keepBranch: true });
    }

    const ts = this.now().toISOString();
    this.raw
      .prepare(
        `UPDATE tasks
           SET status = ?,
               assigned_agent_id = NULL,
               worktree_path = NULL,
               claimed_at = NULL,
               last_heartbeat_at = NULL,
               updated_at = ?,
               review_bounce_count = ?,
               status_note = ?,
               last_role = ?
         WHERE id = ?`,
      )
      .run(
        input.nextStatus,
        ts,
        input.reviewBounceCount,
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
  }
}

function claimOrderByFor(role: AgentRole): string {
  switch (role) {
    case "planner":
      return "CASE status WHEN 'planning' THEN 0 ELSE 1 END, priority DESC, created_at ASC";
    case "executor":
    case "reviewer":
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
    review_bounce_count: row.review_bounce_count,
    last_role: row.last_role ? agentRoleSchema.parse(row.last_role) : null,
    status_note: row.status_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    last_heartbeat_at: row.last_heartbeat_at,
  };
}

function rowToAgent(row: AgentRow): Agent {
  const base = {
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
  } satisfies Omit<Agent, "command" | "endpoint">;

  const agent: Agent = { ...base };
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
