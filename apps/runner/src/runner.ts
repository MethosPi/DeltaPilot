import { spawn, type ChildProcess } from "node:child_process";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  GitHubCliHelper,
  type GitHubHelper,
  Orchestrator,
  WorktreeManager,
  openDatabase,
  rankAgentsForTask,
  roleForTask,
} from "@deltapilot/core";
import type { Agent, Task, TaskPullRequest } from "@deltapilot/shared";
import { commitWorktree } from "./git-commit.js";
import { getAdapter, hasAdapter } from "./adapters.js";

const MANAGED_START_COMMAND_DEFAULTS: Partial<Record<Agent["kind"], string>> = {
  codex: "codex",
  "claude-code": "claude",
  "claude-sdk": "claude",
  openclaw: "openclaw gateway start",
  ollama: "ollama run qwen2.5-coder:7b",
  opendevin: "opendevin",
  hermes: "hermes",
};

export interface RunnerOptions {
  repoRoot: string;
  dbPath: string;
  pollIntervalMs?: number;
  githubHelper?: GitHubHelper;
}

export class Runner {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly pollIntervalMs: number;
  readonly orch: Orchestrator;
  readonly worktreeMgr: WorktreeManager;
  readonly github: GitHubHelper;

  private readonly conn;
  private readonly sessionsDir: string;
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly bootstrapProcesses = new Map<string, ChildProcess>();

  constructor(options: RunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.dbPath = options.dbPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.github = options.githubHelper ?? new GitHubCliHelper();
    this.conn = openDatabase(this.dbPath);
    this.sessionsDir = path.join(this.repoRoot, ".deltapilot", "sessions");
    this.worktreeMgr = new WorktreeManager({
      repoRoot: this.repoRoot,
      workspacesDir: path.join(this.repoRoot, ".deltapilot", "workspaces"),
    });
    this.orch = new Orchestrator({
      raw: this.conn.raw,
      db: this.conn.db,
      worktreeMgr: this.worktreeMgr,
      repoRoot: this.repoRoot,
    });
  }

  async start(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await this.runOnce();
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce().catch((error) => {
        console.error("runner tick failed", error);
      });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const child of this.bootstrapProcesses.values()) {
      child.kill("SIGTERM");
    }
    this.bootstrapProcesses.clear();
    await Promise.allSettled(this.inFlight.values());
    this.conn.close();
  }

  async runOnce(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await this.queueApprovedMergeTasks();
    const agents = this.selectManagedAgents();
    const readyAgents: Array<{ agent: Agent; sessionId: string }> = [];

    for (const agent of agents) {
      const session = await this.ensureSession(agent);
      if (agent.role !== "merger" && !hasAdapter(agent.kind)) continue;
      if (this.inFlight.has(session.id)) continue;
      if (!["ready", "starting"].includes(session.status)) continue;

      const existing = this.orch.getAssignedTask(agent.id);
      if (existing) {
        this.queueTaskRun(agent, session.id, existing);
        continue;
      }

      readyAgents.push({ agent, sessionId: session.id });
    }

    const activeAssignments = Object.fromEntries(
      agents.map((agent) => [agent.id, this.orch.getAssignedTask(agent.id) ? 1 : 0]),
    );

    const queuedTasks = this.orch
      .listTasks()
      .filter((task) => task.assigned_agent_id === null)
      .filter((task) => roleForTask(task) !== null);

    for (const task of queuedTasks) {
      const role = roleForTask(task);
      if (!role) continue;
      const candidates = readyAgents.filter(({ agent }) => agent.role === role);
      if (candidates.length === 0) continue;

      const ranked = rankAgentsForTask({
        task,
        role,
        agents: candidates.map(({ agent }) => agent),
        attempts: this.orch.listTaskAttempts({ taskId: task.id }),
        activeAssignments,
      });
      const selected = ranked.find((candidate) => !candidate.blocked);
      if (!selected) continue;

      const target = candidates.find(({ agent }) => agent.id === selected.agent_id);
      if (!target) continue;
      const claimed = await this.orch.claimTaskForAgent(task.id, target.agent.id);
      if (!claimed) continue;

      activeAssignments[target.agent.id] = (activeAssignments[target.agent.id] ?? 0) + 1;
      this.queueTaskRun(target.agent, target.sessionId, claimed);
    }
  }

  private selectManagedAgents(): Agent[] {
    const now = Date.now();
    return this.orch
      .listAgents()
      .filter((agent) => agent.runtime_mode === "managed" && agent.enabled)
      .filter((agent) => !agent.cooldown_until || new Date(agent.cooldown_until).getTime() <= now)
      .sort((a, b) => {
        if (a.role !== b.role) return a.role.localeCompare(b.role);
        if (a.health_state !== b.health_state) {
          return healthStateRank(a.health_state) - healthStateRank(b.health_state);
        }
        if (a.fallback_priority !== b.fallback_priority) {
          return a.fallback_priority - b.fallback_priority;
        }
        return a.name.localeCompare(b.name);
      });
  }

  private queueTaskRun(agent: Agent, sessionId: string, task: Task): void {
    if (this.inFlight.has(sessionId)) return;
    const run = (agent.role === "merger"
      ? this.runMergeTask(agent, sessionId, task)
      : this.runTask(agent, sessionId, task)).finally(() => {
      this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, run);
  }

  private async ensureSession(agent: Agent) {
    let session = this.orch.getOpenSessionForAgent(agent.id);
    if (session && !["stopped", "errored"].includes(session.status)) return session;
    if (session && ["stopped", "errored"].includes(session.status)) {
      this.orch.updateAgentSession(session.id, {
        endedAt: new Date().toISOString(),
      });
      session = null;
    }

    const sessionId = crypto.randomUUID();
    const logPath = path.join(this.sessionsDir, `${sessionId}.log`);
    await writeFile(logPath, "", "utf8");
    session = this.orch.createAgentSession({
      agentId: agent.id,
      logPath,
      status: "ready",
    });
    await this.writeLog(session.id, `session opened role=${agent.role} kind=${agent.kind} mode=${agent.runtime_mode}`);
    if (agent.command?.trim()) {
      await this.writeLog(session.id, `managed command: ${agent.command.trim()}`);
    }
    if (agent.role !== "merger" && !hasAdapter(agent.kind)) {
      await this.writeLog(session.id, unsupportedAdapterMessage(agent));
      await this.startManagedBootstrap(agent, session.id);
      session = this.orch.getAgentSession(session.id);
    }
    return session;
  }

  private async runTask(agent: Agent, sessionId: string, task: Task): Promise<void> {
    const adapter = getAdapter(agent.kind);
    const controller = new AbortController();
    const startedAt = Date.now();
    this.orch.updateAgentSession(sessionId, {
      status: "busy",
      taskId: task.id,
      lastError: null,
    });
    await this.writeLog(sessionId, `[${agent.role}] start ${task.id} ${task.title}`);

    try {
      const hydratedTask = await this.ensureTaskWorktree(task);
      const worktreePath = hydratedTask.worktree_path;
      if (!worktreePath) {
        throw new Error(`task ${task.id} has no worktree`);
      }

      const result = await adapter.execute({
        task: hydratedTask,
        worktreePath,
        repoRoot: this.repoRoot,
        signal: controller.signal,
        log: (line) => {
          void this.writeLog(sessionId, line);
        },
        agent,
        agentRole: agent.role,
        sessionId,
        orchestrator: this.orch,
      });
      this.orch.reportTaskUsage(task.id, agent.id, {
        provider: agent.provider_family,
        model: agent.model_id,
        latencyMs: Date.now() - startedAt,
      });

      switch (result.kind) {
        case "ok": {
          await this.handleSuccess(agent, sessionId, hydratedTask, worktreePath, result);
          break;
        }
        case "rate_limit":
        case "context_limit":
        case "budget_exceeded": {
          await this.orch.reportLimit(task.id, agent.id, result.kind);
          await this.orch.updateAgentSession(sessionId, {
            status: "ready",
            taskId: null,
            lastError: result.message ?? result.kind,
          });
          await this.writeLog(sessionId, `requeued after ${result.kind}`);
          break;
        }
        case "approval":
        case "question": {
          const request = this.orch.createApprovalRequest({
            sessionId,
            agentId: agent.id,
            taskId: task.id,
            kind: result.approvalKind ?? (result.kind === "question" ? "question" : "approval"),
            title: result.approvalTitle ?? `${agent.role} requires input`,
            body: result.approvalBody ?? result.output ?? result.message ?? "The agent requested human input.",
          });
          this.orch.createSessionMessage({
            sessionId,
            approvalRequestId: request.id,
            direction: "agent",
            kind: result.kind,
            body: request.body,
          });
          this.orch.updateAgentSession(sessionId, {
            status: "waiting",
            taskId: task.id,
          });
          await this.writeLog(sessionId, `waiting for ${request.kind}: ${request.title}`);
          break;
        }
        case "error": {
          throw new Error(result.message ?? "adapter returned error");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeLog(sessionId, `crash: ${message}`);
      if (this.orch.getAssignedTask(agent.id)?.id === task.id) {
        await this.orch.reportLimit(task.id, agent.id, "crash").catch(() => undefined);
      }
      this.orch.setAgentCooldown(agent.id, this.cooldownAt(), "crash");
      this.orch.updateAgentSession(sessionId, {
        status: "ready",
        taskId: null,
        lastError: message,
      });
    }
  }

  private async runMergeTask(agent: Agent, sessionId: string, task: Task): Promise<void> {
    this.orch.updateAgentSession(sessionId, {
      status: "busy",
      taskId: task.id,
      lastError: null,
    });
    await this.writeLog(sessionId, `[${agent.role}] start ${task.id} ${task.title}`);

    try {
      const hydratedTask = await this.ensureTaskWorktree(task);
      const worktreePath = hydratedTask.worktree_path;
      const pullRequest = hydratedTask.pull_request;
      if (!worktreePath) {
        throw new Error(`task ${task.id} has no worktree`);
      }
      if (!pullRequest?.number || !pullRequest.head_branch) {
        await this.orch.submitMergeResult(task.id, agent.id, {
          result: "blocked",
          reason: "approval",
          note: "Pull request metadata is missing. Re-run review approval to publish the PR.",
          pullRequest: {
            lastError: "Pull request metadata is missing",
            lastSyncedAt: new Date().toISOString(),
          },
          preserveWorktree: true,
        });
        await this.writeLog(sessionId, "merge blocked: missing PR metadata");
        await this.finishAgentRun(agent, sessionId);
        return;
      }

      const refreshed = await this.github.readPullRequest({
        repoRoot: this.repoRoot,
        branchName: pullRequest.head_branch,
        baseBranch: pullRequest.base_branch,
      });
      if (!refreshed || refreshed.review_decision !== "APPROVED") {
        await this.orch.submitMergeResult(task.id, agent.id, {
          result: "reapproval_required",
          reason: "approval",
          note: "Pull request approval is no longer present. Approve the PR again to resume merging.",
          pullRequest: toPullRequestUpdate(refreshed ?? {
            ...pullRequest,
            review_decision: "UNKNOWN",
            last_error: "Pull request not found on GitHub",
            last_synced_at: new Date().toISOString(),
          }),
          preserveWorktree: true,
        });
        await this.writeLog(sessionId, "merge returned to human review: PR is not approved");
        await this.finishAgentRun(agent, sessionId);
        return;
      }

      this.orch.updateTaskPullRequest(task.id, toPullRequestUpdate(refreshed));

      try {
        await this.github.rebaseBranch({
          repoRoot: this.repoRoot,
          worktreePath,
          branchName: pullRequest.head_branch,
          baseBranch: pullRequest.base_branch,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.orch.submitMergeResult(task.id, agent.id, {
          result: "blocked",
          reason: "merge_conflict",
          note: message,
          pullRequest: {
            ...toPullRequestUpdate(refreshed),
            lastError: message,
            lastSyncedAt: new Date().toISOString(),
          },
          preserveWorktree: true,
        });
        await this.writeLog(sessionId, `merge blocked after rebase failure: ${message}`);
        await this.finishAgentRun(agent, sessionId);
        return;
      }

      const afterRebase = await this.github.readPullRequest({
        repoRoot: this.repoRoot,
        branchName: pullRequest.head_branch,
        baseBranch: pullRequest.base_branch,
      });
      const latestPullRequest = afterRebase ?? refreshed;
      this.orch.updateTaskPullRequest(task.id, toPullRequestUpdate(latestPullRequest));

      if (!afterRebase || afterRebase.review_decision !== "APPROVED") {
        await this.orch.submitMergeResult(task.id, agent.id, {
          result: "reapproval_required",
          reason: "approval",
          note: "Pull request approval must be granted again after the rebase.",
          pullRequest: {
            ...toPullRequestUpdate(latestPullRequest),
            lastError: null,
            lastSyncedAt: new Date().toISOString(),
          },
          preserveWorktree: true,
        });
        await this.writeLog(sessionId, "merge returned to human review: approval dismissed after rebase");
        await this.finishAgentRun(agent, sessionId);
        return;
      }

      try {
        const merged = await this.github.mergePullRequest({
          repoRoot: this.repoRoot,
          pullRequestNumber: afterRebase.number ?? pullRequest.number,
          baseBranch: afterRebase.base_branch,
        });
        await this.orch.submitMergeResult(task.id, agent.id, {
          result: "merged",
          mergedSha: merged.mergedSha,
          note: `Merged PR #${afterRebase.number ?? pullRequest.number} into ${afterRebase.base_branch}.`,
          pullRequest: {
            ...toPullRequestUpdate(afterRebase),
            mergedSha: merged.mergedSha,
            lastError: null,
            lastSyncedAt: new Date().toISOString(),
          },
        });
        await this.writeLog(sessionId, `merged PR #${afterRebase.number ?? pullRequest.number} @ ${merged.mergedSha}`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.orch.submitMergeResult(task.id, agent.id, {
          result: "blocked",
          reason: "approval",
          note: message,
          pullRequest: {
            ...toPullRequestUpdate(afterRebase),
            lastError: message,
            lastSyncedAt: new Date().toISOString(),
          },
          preserveWorktree: true,
        });
        await this.writeLog(sessionId, `merge blocked by GitHub policy: ${message}`);
      }

      await this.finishAgentRun(agent, sessionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.writeLog(sessionId, `crash: ${message}`);
      if (this.orch.getAssignedTask(agent.id)?.id === task.id) {
        await this.orch.reportLimit(task.id, agent.id, "crash").catch(() => undefined);
      }
      this.orch.setAgentCooldown(agent.id, this.cooldownAt(), "crash");
      this.orch.updateAgentSession(sessionId, {
        status: "ready",
        taskId: null,
        lastError: message,
      });
    }
  }

  private async handleSuccess(
    agent: Agent,
    sessionId: string,
    task: Task,
    worktreePath: string,
    result: {
      message?: string;
      output?: string;
      decision?: "approve" | "bounce";
    },
  ): Promise<void> {
    await this.writeCheckpoint(agent, task, result);

    switch (agent.role) {
      case "planner": {
        const plan = result.output ?? result.message ?? `Plan for ${task.title}`;
        await this.orch.publishPlan(task.id, agent.id, plan);
        await this.writeLog(sessionId, "published execution plan");
        break;
      }
      case "executor": {
        const sha = await commitWorktree({
          worktreePath,
          message: result.message?.trim() || `deltapilot: execute ${task.title}`,
        });
        await this.orch.submitWork(task.id, agent.id, sha ?? undefined);
        await this.writeLog(sessionId, `submitted work${sha ? ` @ ${sha}` : ""}`);
        break;
      }
      case "reviewer": {
        const decision = result.decision ?? "approve";
        const note = result.output ?? result.message ?? null;
        if (decision === "approve") {
          try {
            const pullRequest = await this.github.ensurePullRequest({
              repoRoot: this.repoRoot,
              worktreePath,
              branchName: task.branch_name ?? `deltapilot/task/${task.id}`,
              title: task.title,
              body: buildPullRequestBody(task, note),
            });
            const diffStat = await this.github.diffStat(worktreePath, pullRequest.base_branch);
            const packet = this.github.buildHumanReviewPacket({
              worktreePath,
              branchName: pullRequest.head_branch,
              acceptance: task.acceptance,
              reviewNote: note,
              diffStat,
              pullRequest,
            });
            await this.orch.writeArtifact(task.id, "human_review_packet", packet, agent.id);
            await this.orch.approveForHumanReview(task.id, {
              note: note ?? "Reviewer approved the implementation.",
              reason: "approval",
              pullRequest: toPullRequestUpdate(pullRequest),
              preserveWorktree: true,
            }, agent.id);
            await this.writeLog(sessionId, `submitted review decision=approve PR=#${pullRequest.number ?? "?"}`);
          } catch (error) {
            const message = `Failed to publish the PR for human review: ${error instanceof Error ? error.message : String(error)}`;
            await this.orch.failHumanReviewApproval(task.id, message, agent.id, {
              lastError: message,
              lastSyncedAt: new Date().toISOString(),
            });
            await this.writeLog(sessionId, `review approval blocked: ${message}`);
          }
        } else {
          await this.orch.submitReview(task.id, agent.id, {
            decision,
            ...(note ? { note } : {}),
          });
          await this.writeLog(sessionId, `submitted review decision=${decision}`);
        }
        break;
      }
      case "merger": {
        throw new Error("Merger tasks are handled separately");
        break;
      }
    }

    await this.finishAgentRun(agent, sessionId);
  }

  private async writeLog(sessionId: string, line: string): Promise<void> {
    const session = this.orch.getAgentSession(sessionId);
    const stamped = `[${new Date().toISOString()}] ${line}\n`;
    await appendFile(session.log_path, stamped, "utf8");
    this.orch.updateAgentSession(sessionId, {
      lastSeenAt: new Date().toISOString(),
    });
  }

  private cooldownAt(): string {
    return new Date(Date.now() + 60_000).toISOString();
  }

  private async finishAgentRun(agent: Agent, sessionId: string): Promise<void> {
    this.orch.setAgentCooldown(agent.id, null, null);
    this.orch.updateAgentSession(sessionId, {
      status: "ready",
      taskId: null,
      lastError: null,
    });
  }

  private async writeCheckpoint(
    agent: Agent,
    task: Task,
    result: {
      message?: string;
      output?: string;
      decision?: "approve" | "bounce";
    },
  ): Promise<void> {
    const summary = (result.output ?? result.message ?? `${agent.role} completed ${task.title}`).trim();
    await this.orch.publishCheckpoint(task.id, agent.id, {
      summary,
      files_touched: task.acceptance?.files_in_scope ?? [],
      tests_ran: task.acceptance?.success_test ? [task.acceptance.success_test] : [],
      commands_ran: [],
      next_steps: checkpointNextSteps(agent.role, result.decision),
      risks: [],
    });
  }

  private async queueApprovedMergeTasks(): Promise<void> {
    const candidates = this.orch
      .listTasks({ status: "human_review" })
      .filter((task) => task.human_review_reason === "approval")
      .filter((task) => task.assigned_agent_id === null)
      .filter((task) => Boolean(task.pull_request?.head_branch));

    for (const task of candidates) {
      const branchName = task.pull_request?.head_branch;
      if (!branchName) continue;
      try {
        const refreshed = await this.github.readPullRequest({
          repoRoot: this.repoRoot,
          branchName,
          baseBranch: task.pull_request?.base_branch ?? "main",
        });
        if (!refreshed) {
          this.orch.updateTaskPullRequest(task.id, {
            lastError: "Pull request not found on GitHub",
            lastSyncedAt: new Date().toISOString(),
            reviewDecision: "UNKNOWN",
          });
          continue;
        }
        this.orch.updateTaskPullRequest(task.id, toPullRequestUpdate(refreshed));
        if (refreshed.merged_sha) {
          await this.orch.recordExternalMerge(task.id, null, {
            mergedSha: refreshed.merged_sha,
            note: `Pull request #${refreshed.number ?? "?"} was already merged on GitHub.`,
            pullRequest: toPullRequestUpdate(refreshed),
          });
          continue;
        }
        if (refreshed.review_decision === "APPROVED") {
          this.orch.queueMerge(task.id);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.orch.updateTaskPullRequest(task.id, {
          lastError: message,
          lastSyncedAt: new Date().toISOString(),
        });
      }
    }
  }

  private async ensureTaskWorktree(task: Task): Promise<Task> {
    return this.orch.ensureTaskWorktree(task.id);
  }

  private async startManagedBootstrap(agent: Agent, sessionId: string): Promise<void> {
    const command = resolveManagedStartCommand(agent);
    if (!command || this.bootstrapProcesses.has(sessionId)) return;

    const shell = process.env.SHELL || "/bin/zsh";
    this.orch.updateAgentSession(sessionId, {
      status: "starting",
      lastError: unsupportedAdapterMessage(agent),
    });
    await this.writeLog(sessionId, `launching managed start command: ${command}`);

    const child = spawn(shell, ["-lc", command], {
      cwd: this.repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.bootstrapProcesses.set(sessionId, child);
    this.orch.updateAgentSession(sessionId, {
      status: "ready",
      pid: child.pid ?? null,
      lastSeenAt: new Date().toISOString(),
    });

    const logChunk = (sink: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        void this.writeLog(sessionId, `[managed/${sink}] ${line}`);
      }
    };

    child.stdout.on("data", logChunk("stdout"));
    child.stderr.on("data", logChunk("stderr"));

    child.on("error", (error) => {
      this.bootstrapProcesses.delete(sessionId);
      void this.writeLog(sessionId, `managed bootstrap error: ${error.message}`);
      this.orch.updateAgentSession(sessionId, {
        status: "errored",
        endedAt: new Date().toISOString(),
        pid: null,
        lastError: `${unsupportedAdapterMessage(agent)} · ${error.message}`,
      });
    });

    child.on("close", (code, signal) => {
      this.bootstrapProcesses.delete(sessionId);
      const nextStatus = code === 0 ? "stopped" : "errored";
      const reason = signal
        ? `signal ${signal}`
        : `exit ${code ?? "unknown"}`;
      void this.writeLog(sessionId, `managed process closed (${reason})`);
      this.orch.updateAgentSession(sessionId, {
        status: nextStatus,
        endedAt: new Date().toISOString(),
        pid: null,
        lastError:
          nextStatus === "errored"
            ? `${unsupportedAdapterMessage(agent)} · managed process closed (${reason})`
            : unsupportedAdapterMessage(agent),
      });
    });
  }
}

function unsupportedAdapterMessage(agent: Agent): string {
  const command = resolveManagedStartCommand(agent);
  return `no DeltaPipeline task adapter for kind "${agent.kind}"${command ? ` (configured command: ${command})` : ""}`;
}

function checkpointNextSteps(
  role: Agent["role"],
  decision?: "approve" | "bounce",
): string[] {
  switch (role) {
    case "planner":
      return ["Executor should implement the published plan."];
    case "executor":
      return ["Reviewer should validate the implementation against acceptance criteria."];
    case "reviewer":
      return [decision === "approve"
        ? "Human review and PR validation are next."
        : "Executor should address the review feedback."];
    case "merger":
      return ["Merge flow completed."];
  }
}

function healthStateRank(state: Agent["health_state"]): number {
  switch (state) {
    case "healthy":
      return 0;
    case "degraded":
      return 1;
    case "cooldown":
      return 2;
    case "offline":
      return 3;
  }
}

function resolveManagedStartCommand(agent: Agent): string | null {
  return agent.command?.trim()
    || MANAGED_START_COMMAND_DEFAULTS[agent.kind]
    || null;
}

function buildPullRequestBody(task: Task, reviewNote: string | null): string {
  const sections = [
    "## Task",
    "",
    task.brief || task.title,
    "",
  ];

  if (task.acceptance?.deliverables.length) {
    sections.push("## Deliverables", "");
    for (const item of task.acceptance.deliverables) {
      sections.push(`- ${item}`);
    }
    sections.push("");
  }

  if (task.acceptance?.success_test) {
    sections.push("## Success Test", "", task.acceptance.success_test, "");
  }

  sections.push("## Reviewer Note", "", reviewNote?.trim() || "Approved by the reviewer agent.", "");
  return sections.join("\n");
}

function toPullRequestUpdate(pullRequest: TaskPullRequest) {
  return {
    provider: pullRequest.provider,
    baseBranch: pullRequest.base_branch,
    headBranch: pullRequest.head_branch,
    headSha: pullRequest.head_sha,
    number: pullRequest.number,
    url: pullRequest.url,
    reviewDecision: pullRequest.review_decision,
    mergedSha: pullRequest.merged_sha,
    lastSyncedAt: pullRequest.last_synced_at,
    lastError: pullRequest.last_error,
  } as const;
}
