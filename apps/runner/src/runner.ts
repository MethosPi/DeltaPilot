import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { WorktreeManager, openDatabase, Orchestrator } from "@deltapilot/core";
import type { Agent, Task } from "@deltapilot/shared";
import { commitWorktree } from "./git-commit.js";
import { getAdapter, hasAdapter } from "./adapters.js";

const MANAGED_START_COMMAND_DEFAULTS: Partial<Record<Agent["kind"], string>> = {
  codex: "codex",
  "claude-code": "claude",
  "claude-sdk": "claude",
  openclaw: "openclaw gateway start",
  opendevin: "opendevin",
  hermes: "hermes",
};

export interface RunnerOptions {
  repoRoot: string;
  dbPath: string;
  pollIntervalMs?: number;
}

export class Runner {
  readonly repoRoot: string;
  readonly dbPath: string;
  readonly pollIntervalMs: number;
  readonly orch: Orchestrator;
  readonly worktreeMgr: WorktreeManager;

  private readonly conn;
  private readonly sessionsDir: string;
  private timer: NodeJS.Timeout | null = null;
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly bootstrapProcesses = new Map<string, ChildProcess>();

  constructor(options: RunnerOptions) {
    this.repoRoot = options.repoRoot;
    this.dbPath = options.dbPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
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
    const agents = this.selectManagedAgents();
    for (const agent of agents) {
      const session = await this.ensureSession(agent);
      if (!hasAdapter(agent.kind)) continue;
      if (this.inFlight.has(session.id)) continue;
      if (!["ready", "starting"].includes(session.status)) continue;

      const existing = this.orch.getAssignedTask(agent.id);
      const task = existing ?? await this.orch.claimNextTask(agent.id);
      if (!task) continue;

      const run = this.runTask(agent, session.id, task).finally(() => {
        this.inFlight.delete(session.id);
      });
      this.inFlight.set(session.id, run);
    }
  }

  private selectManagedAgents(): Agent[] {
    const now = Date.now();
    return this.orch
      .listAgents()
      .filter((agent) => agent.runtime_mode === "managed" && agent.enabled)
      .filter((agent) => !agent.cooldown_until || new Date(agent.cooldown_until).getTime() <= now)
      .sort((a, b) => {
        const aSession = this.orch.getOpenSessionForAgent(a.id);
        const bSession = this.orch.getOpenSessionForAgent(b.id);
        const aHealthy = aSession && ["ready", "starting"].includes(aSession.status) ? 0 : 1;
        const bHealthy = bSession && ["ready", "starting"].includes(bSession.status) ? 0 : 1;
        if (aHealthy !== bHealthy) return aHealthy - bHealthy;

        const aAssigned = this.orch.getAssignedTask(a.id) ? 1 : 0;
        const bAssigned = this.orch.getAssignedTask(b.id) ? 1 : 0;
        if (aAssigned !== bAssigned) return aAssigned - bAssigned;

        const aSeen = Date.parse(a.last_seen_at ?? a.registered_at);
        const bSeen = Date.parse(b.last_seen_at ?? b.registered_at);
        return bSeen - aSeen;
      });
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
    if (!hasAdapter(agent.kind)) {
      await this.writeLog(session.id, unsupportedAdapterMessage(agent));
      await this.startManagedBootstrap(agent, session.id);
      session = this.orch.getAgentSession(session.id);
    }
    return session;
  }

  private async runTask(agent: Agent, sessionId: string, task: Task): Promise<void> {
    const adapter = getAdapter(agent.kind);
    const controller = new AbortController();
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

      switch (result.kind) {
        case "ok": {
          await this.handleSuccess(agent, sessionId, task, worktreePath, result);
          break;
        }
        case "rate_limit":
        case "context_limit": {
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
        await this.orch.submitReview(task.id, agent.id, {
          decision,
          ...(result.output || result.message
            ? { note: result.output ?? result.message }
            : {}),
        });
        await this.writeLog(sessionId, `submitted review decision=${decision}`);
        break;
      }
    }

    this.orch.setAgentCooldown(agent.id, null, null);
    this.orch.updateAgentSession(sessionId, {
      status: "ready",
      taskId: null,
      lastError: null,
    });
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

  private async ensureTaskWorktree(task: Task): Promise<Task> {
    if (task.worktree_path && existsSync(task.worktree_path)) return task;

    const expectedPath = this.worktreeMgr.pathFor(task.id);
    const expectedBranch = task.branch_name ?? this.worktreeMgr.branchFor(task.id);
    let branchName = expectedBranch;
    let worktreePath = expectedPath;

    if (!existsSync(expectedPath)) {
      const result = task.branch_name
        ? await this.worktreeMgr.attachWorktree(task.id)
        : await this.worktreeMgr.createWorktree(task.id);
      branchName = result.branchName;
      worktreePath = result.worktreePath;
    }

    this.conn.raw
      .prepare("UPDATE tasks SET branch_name = ?, worktree_path = ?, updated_at = ? WHERE id = ?")
      .run(branchName, worktreePath, new Date().toISOString(), task.id);
    return this.orch.getTask(task.id);
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

function resolveManagedStartCommand(agent: Agent): string | null {
  return agent.command?.trim()
    || MANAGED_START_COMMAND_DEFAULTS[agent.kind]
    || null;
}
