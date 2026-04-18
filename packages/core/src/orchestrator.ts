import type { Database as BetterSqliteDatabase } from "better-sqlite3";
import { execa } from "execa";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  InvalidTransitionError,
  acceptanceCriteriaSchema,
  agentKindSchema,
  agentTransportSchema,
  nextStatus,
  taskStatusSchema,
} from "@deltapilot/shared";
import type {
  AcceptanceCriteria,
  Agent,
  AgentKind,
  AgentTransport,
  ArtifactKind,
  Handoff,
  Task,
  TaskEvent,
  TaskStatus,
} from "@deltapilot/shared";
import type { DrizzleDb } from "./db/client.js";
import { WorktreeManager } from "./worktree.js";

export interface OrchestratorOptions {
  raw: BetterSqliteDatabase;
  db: DrizzleDb;
  worktreeMgr: WorktreeManager;
  repoRoot: string;
  /** Overridable for deterministic tests. */
  now?: () => Date;
  /** Overridable for deterministic tests. */
  uuid?: () => string;
}

export interface RegisterAgentInput {
  name: string;
  kind: AgentKind;
  transport: AgentTransport;
  command?: string;
  endpoint?: string;
}

export interface CreateTaskInput {
  title: string;
  brief?: string;
  priority?: number;
  acceptance?: AcceptanceCriteria;
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
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  transport: string;
  command: string | null;
  endpoint: string | null;
  registered_at: string;
  last_seen_at: string | null;
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

  // ── Agents ──────────────────────────────────────────────────────────────

  async registerAgent(input: RegisterAgentInput): Promise<Agent> {
    const id = this.uuid();
    const registeredAt = this.now().toISOString();

    agentKindSchema.parse(input.kind);
    agentTransportSchema.parse(input.transport);

    this.raw
      .prepare(
        `INSERT INTO agents (id, name, kind, transport, command, endpoint, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(id, input.name, input.kind, input.transport, input.command ?? null, input.endpoint ?? null, registeredAt);

    return {
      id,
      name: input.name,
      kind: input.kind,
      transport: input.transport,
      ...(input.command !== undefined ? { command: input.command } : {}),
      ...(input.endpoint !== undefined ? { endpoint: input.endpoint } : {}),
      registered_at: registeredAt,
      last_seen_at: null,
    };
  }

  getAgent(agentId: string): Agent {
    const row = this.raw.prepare("SELECT * FROM agents WHERE id = ?").get(agentId) as
      | AgentRow
      | undefined;
    if (!row) throw new AgentNotFoundError(agentId);
    return rowToAgent(row);
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  async createTask(input: CreateTaskInput): Promise<Task> {
    const id = this.uuid();
    const ts = this.now().toISOString();
    const acceptanceJson = input.acceptance
      ? JSON.stringify(acceptanceCriteriaSchema.parse(input.acceptance))
      : null;

    this.raw
      .prepare(
        `INSERT INTO tasks
         (id, title, brief, status, priority, assigned_agent_id, branch_name, worktree_path,
          acceptance_json, created_at, updated_at, claimed_at, last_heartbeat_at)
         VALUES (?, ?, ?, 'init', ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(id, input.title, input.brief ?? "", input.priority ?? 50, acceptanceJson, ts, ts);

    this.recordEvent({
      taskId: id,
      fromStatus: "init",
      toStatus: "init",
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

  // ── State transitions ───────────────────────────────────────────────────

  /**
   * Apply an event to a task and persist the transition. For transitions that require
   * side-effects beyond DB updates (claim, report_limit, submit_work) use the dedicated
   * methods — they wrap this plus the side-effects atomically.
   */
  applyEvent(taskId: string, event: TaskEvent, actorAgentId: string | null = null): Task {
    const ts = this.now().toISOString();

    const apply = this.raw.transaction(() => {
      const row = this.raw.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
        | TaskRow
        | undefined;
      if (!row) throw new TaskNotFoundError(taskId);
      const from = taskStatusSchema.parse(row.status);
      const to = nextStatus(from, event);

      // Bounce sends a reviewed task back to the queue for another attempt. The
      // assignee must be cleared or claimNextTask (which filters on
      // assigned_agent_id IS NULL) will never see it again; the worktree_path
      // is cleared in lockstep so the next claimant reattaches the branch
      // cleanly, mirroring the handoff flow.
      if (event.kind === "bounce") {
        this.raw
          .prepare(
            `UPDATE tasks
               SET status = ?, assigned_agent_id = NULL, worktree_path = NULL, updated_at = ?
             WHERE id = ?`,
          )
          .run(to, ts, taskId);
      } else {
        this.raw
          .prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?")
          .run(to, ts, taskId);
      }

      this.recordEvent({
        taskId,
        fromStatus: from,
        toStatus: to,
        kind: event.kind,
        payload: event as unknown as Record<string, unknown>,
        actorAgentId,
      });

      return to;
    });
    apply();

    return this.getTask(taskId);
  }

  /**
   * Atomically pick the next available task (todo OR handoff_pending, highest priority,
   * oldest first) and claim it for the given agent. Returns null if nothing is available.
   *
   * Handoff-pending tasks rank ahead of fresh todos so in-flight work resumes before
   * new work is picked up.
   */
  async claimNextTask(agentId: string): Promise<Task | null> {
    this.getAgent(agentId); // throws if unknown
    const ts = this.now().toISOString();

    // Single atomic statement: UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING
    const row = this.raw
      .prepare(
        `
        UPDATE tasks
           SET status = 'in_progress',
               assigned_agent_id = @agent,
               claimed_at = @ts,
               last_heartbeat_at = @ts,
               updated_at = @ts
         WHERE id = (
           SELECT id FROM tasks
            WHERE status IN ('todo', 'handoff_pending')
              AND assigned_agent_id IS NULL
            ORDER BY
              CASE status WHEN 'handoff_pending' THEN 0 ELSE 1 END,
              priority DESC,
              created_at ASC
            LIMIT 1
         )
         RETURNING *
        `,
      )
      .get({ agent: agentId, ts }) as TaskRow | undefined;

    if (!row) return null;

    // The UPDATE didn't touch branch_name, so the returned row still carries its prior
    // value — null for a task that was claimed for the first time, set for a task that
    // was previously in flight and is now being resumed after a handoff.
    const isResume = row.branch_name !== null;
    const fromStatus: TaskStatus = isResume ? "handoff_pending" : "todo";

    const { branchName, worktreePath } = isResume
      ? await this.worktreeMgr.attachWorktree(row.id)
      : await this.worktreeMgr.createWorktree(row.id);

    this.raw
      .prepare("UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?")
      .run(branchName, worktreePath, ts, row.id);

    this.recordEvent({
      taskId: row.id,
      fromStatus,
      toStatus: "in_progress",
      kind: "claim",
      payload: { agent_id: agentId },
      actorAgentId: agentId,
    });

    return this.getTask(row.id);
  }

  heartbeat(taskId: string, agentId: string): void {
    const ts = this.now().toISOString();
    const info = this.raw
      .prepare(
        `UPDATE tasks SET last_heartbeat_at = ?, updated_at = ?
         WHERE id = ? AND assigned_agent_id = ?`,
      )
      .run(ts, ts, taskId, agentId);
    if (info.changes === 0) throw new NotAssignedError(taskId, agentId);

    this.raw
      .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
      .run(ts, agentId);
  }

  /**
   * Agent signals it's about to die (rate/context limit). Orchestrator:
   *   1) creates a WIP commit on the task branch if the worktree is dirty;
   *   2) records a handoff row with the snapshot commit;
   *   3) removes the worktree (keeping the branch);
   *   4) moves task to handoff_pending and clears the assignee.
   *
   * When another agent calls claimNextTask, the branch is reattached to a fresh worktree.
   */
  async reportLimit(
    taskId: string,
    agentId: string,
    reason: "rate_limit" | "context_limit" | "crash",
  ): Promise<Handoff> {
    const ts = this.now().toISOString();
    const task = this.getTask(taskId);
    if (task.assigned_agent_id !== agentId) throw new NotAssignedError(taskId, agentId);
    if (task.status !== "in_progress") {
      throw new Error(
        `Cannot report_limit from status ${task.status}; task must be in_progress`,
      );
    }
    const worktreePath = task.worktree_path;
    if (!worktreePath) throw new Error(`Task ${taskId} has no worktree`);

    // 1) WIP commit if dirty.
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

    // 2) Read snapshot commit.
    const { stdout: sha } = await execa("git", ["rev-parse", "HEAD"], { cwd: worktreePath });
    const snapshotCommit = sha.trim();

    // 3) Remove worktree, keep branch.
    await this.worktreeMgr.removeWorktree(taskId, { keepBranch: true });

    // 4) DB updates: apply state transition + insert handoff row + clear assignee.
    const handoffId = this.uuid();
    const handoffRow: Handoff = {
      id: handoffId,
      task_id: taskId,
      from_agent_id: agentId,
      to_agent_id: null,
      reason,
      snapshot_commit: snapshotCommit,
      created_at: ts,
      completed_at: null,
    };

    const tx = this.raw.transaction(() => {
      // Apply state machine (in_progress → handoff_pending).
      const from = taskStatusSchema.parse(
        (this.raw.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as {
          status: string;
        }).status,
      );
      const to = nextStatus(from, { kind: "report_limit", reason });

      this.raw
        .prepare(
          `UPDATE tasks
             SET status = ?,
                 assigned_agent_id = NULL,
                 worktree_path = NULL,
                 updated_at = ?
           WHERE id = ?`,
        )
        .run(to, ts, taskId);

      this.raw
        .prepare(
          `INSERT INTO handoffs (id, task_id, from_agent_id, to_agent_id, reason, snapshot_commit, created_at, completed_at)
           VALUES (?, ?, ?, NULL, ?, ?, ?, NULL)`,
        )
        .run(handoffId, taskId, agentId, reason, snapshotCommit, ts);

      this.recordEvent({
        taskId,
        fromStatus: from,
        toStatus: to,
        kind: "report_limit",
        payload: { reason, snapshot_commit: snapshotCommit, handoff_id: handoffId },
        actorAgentId: agentId,
      });
    });
    tx();

    return handoffRow;
  }

  async submitWork(taskId: string, agentId: string, commitSha?: string): Promise<Task> {
    const task = this.getTask(taskId);
    if (task.assigned_agent_id !== agentId) throw new NotAssignedError(taskId, agentId);
    return this.applyEvent(taskId, { kind: "submit_for_review", ...(commitSha ? { commit_sha: commitSha } : {}) }, agentId);
  }

  // ── Artifacts ───────────────────────────────────────────────────────────

  artifactDir(taskId: string): string {
    return path.join(this.repoRoot, ".deltapilot", "artifacts", taskId);
  }

  async writeArtifact(
    taskId: string,
    kind: ArtifactKind,
    content: string,
    authorAgentId?: string,
  ): Promise<{ path: string }> {
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
    if (!row) return null;
    if (!existsSync(row.path)) return null;
    return readFile(row.path, "utf8");
  }

  // ── Internal ────────────────────────────────────────────────────────────

  private recordEvent(e: {
    taskId: string;
    fromStatus: TaskStatus | "init";
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

// ── Row mappers ────────────────────────────────────────────────────────────

function rowToTask(row: TaskRow): Task {
  const acceptance =
    row.acceptance_json !== null
      ? acceptanceCriteriaSchema.parse(JSON.parse(row.acceptance_json))
      : null;
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
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    last_heartbeat_at: row.last_heartbeat_at,
  };
}

function rowToAgent(row: AgentRow): Agent {
  const base: Agent = {
    id: row.id,
    name: row.name,
    kind: agentKindSchema.parse(row.kind),
    transport: agentTransportSchema.parse(row.transport),
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
  };
  if (row.command !== null) (base as Agent & { command?: string }).command = row.command;
  if (row.endpoint !== null) (base as Agent & { endpoint?: string }).endpoint = row.endpoint;
  return base;
}

// Ensure InvalidTransitionError shows up in the orchestrator module's types.
export { InvalidTransitionError };
