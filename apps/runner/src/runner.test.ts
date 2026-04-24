import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  Orchestrator,
  WorktreeManager,
  openDatabase,
  type GitHubHelper,
} from "@deltapilot/core";
import { MockAdapter } from "./adapters/mock.js";
import { registerAdapter, resetAdapters } from "./adapters.js";
import { Runner } from "./runner.js";

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-runner-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "runner@test"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "Runner Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# runner test\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

function makeOrchestrator(repoRoot: string, dbPath: string): { conn: ReturnType<typeof openDatabase>; orch: Orchestrator } {
  const conn = openDatabase(dbPath);
  const orch = new Orchestrator({
    raw: conn.raw,
    db: conn.db,
    worktreeMgr: new WorktreeManager({
      repoRoot,
      workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
    }),
    repoRoot,
  });
  return { conn, orch };
}

function createMockGitHubHelper(): GitHubHelper {
  return {
    ensurePullRequest: vi.fn(async ({ branchName, baseBranch }) => ({
      provider: "github",
      base_branch: baseBranch ?? "main",
      head_branch: branchName,
      head_sha: "pr-head-sha",
      number: 42,
      url: "https://github.com/example/repo/pull/42",
      review_decision: "APPROVED",
      merged_sha: null,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    })),
    readPullRequest: vi.fn(async ({ branchName, baseBranch }) => ({
      provider: "github",
      base_branch: baseBranch ?? "main",
      head_branch: branchName,
      head_sha: "pr-head-sha",
      number: 42,
      url: "https://github.com/example/repo/pull/42",
      review_decision: "APPROVED",
      merged_sha: null,
      last_synced_at: new Date().toISOString(),
      last_error: null,
    })),
    diffStat: vi.fn(async () => " greeting.txt | 1 +"),
    rebaseBranch: vi.fn(async () => ({ headSha: "rebased-head-sha" })),
    mergePullRequest: vi.fn(async () => ({ mergedSha: "merged-main-sha" })),
    buildHumanReviewPacket: vi.fn(() => "# Human Review Packet\n\nPR: https://github.com/example/repo/pull/42"),
  };
}

async function settleRunner(runner: Runner, ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await runner.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("Runner", () => {
  let repoRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    resetAdapters();
    repoRoot = await makeRepo();
    dbPath = path.join(repoRoot, ".deltapilot-data.db");
  });

  afterEach(async () => {
    resetAdapters();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("runs planner -> executor -> reviewer automatically for managed agents", async () => {
    const { conn, orch } = makeOrchestrator(repoRoot, dbPath);
    let plannerId = "";
    let executorId = "";
    let reviewerId = "";
    let mergerId = "";
    let taskId = "";
    try {
      plannerId = (
        await orch.registerAgent({
          name: "planner-1",
          kind: "mock",
          role: "planner",
          runtimeMode: "managed",
          transport: "mcp-stdio",
        })
      ).id;
      executorId = (
        await orch.registerAgent({
          name: "executor-1",
          kind: "mock",
          role: "executor",
          runtimeMode: "managed",
          transport: "mcp-stdio",
        })
      ).id;
      reviewerId = (
        await orch.registerAgent({
          name: "reviewer-1",
          kind: "mock",
          role: "reviewer",
          runtimeMode: "managed",
          transport: "mcp-stdio",
        })
      ).id;
      mergerId = (
        await orch.registerAgent({
          name: "merger-1",
          kind: "mock",
          role: "merger",
          runtimeMode: "managed",
          transport: "mcp-stdio",
        })
      ).id;

      taskId = (await orch.createTask({
        title: "Ship greeting",
        acceptance: {
          goal: "Produce the greeting file",
          deliverables: ["greeting.txt"],
          files_in_scope: ["greeting.txt"],
          success_test: "greeting.txt exists and is committed",
        },
      })).id;
    } finally {
      conn.close();
    }

    registerAdapter(
      "mock",
      () =>
        new MockAdapter({
          result: async (ctx) => {
            switch (ctx.agentRole) {
              case "planner":
                return { kind: "ok", output: "1. create greeting.txt\n2. commit\n3. review" };
              case "executor":
                await writeFile(path.join(ctx.worktreePath, "greeting.txt"), "hello\n", "utf8");
                return { kind: "ok", message: "runner: execute greeting" };
              case "reviewer":
                return { kind: "ok", decision: "approve", output: "All checks passed" };
              default:
                return { kind: "error", message: "unexpected role" };
            }
          },
        }),
    );

    const githubHelper = createMockGitHubHelper();
    const runner = new Runner({ repoRoot, dbPath, pollIntervalMs: 250, githubHelper });
    try {
      await settleRunner(runner, 20);
      const finalTask = runner.orch.getTask(taskId);
      expect(finalTask.status).toBe("done");
      expect(finalTask.pull_request?.number).toBe(42);
      expect(finalTask.pull_request?.merged_sha).toBe("merged-main-sha");

      const plan = await runner.orch.readArtifact(taskId, "execution_plan");
      expect(plan).toContain("create greeting.txt");
      const packet = await runner.orch.readArtifact(taskId, "human_review_packet");
      expect(packet).toContain("Human Review Packet");

      const sessions = runner.orch.listAgentSessions({ managedOnly: true });
      expect(sessions).toHaveLength(4);
      for (const session of sessions) {
        expect(existsSync(session.log_path)).toBe(true);
        const content = await readFile(session.log_path, "utf8");
        expect(content).toContain("start");
      }

      expect(runner.orch.getAgent(plannerId).last_seen_at).toBeTruthy();
      expect(runner.orch.getAgent(executorId).last_seen_at).toBeTruthy();
      expect(runner.orch.getAgent(reviewerId).last_seen_at).toBeTruthy();
      expect(runner.orch.getAgent(mergerId).last_seen_at).toBeTruthy();
    } finally {
      await runner.stop();
    }
  }, 30_000);

  it("marks human-review tasks done when their pull request was merged externally", async () => {
    const { conn, orch } = makeOrchestrator(repoRoot, dbPath);
    let taskId = "";
    try {
      const planner = await orch.registerAgent({
        name: "planner",
        kind: "mock",
        role: "planner",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const executor = await orch.registerAgent({
        name: "executor",
        kind: "mock",
        role: "executor",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const reviewer = await orch.registerAgent({
        name: "reviewer",
        kind: "mock",
        role: "reviewer",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });

      const task = await orch.createTask({ title: "Externally merged PR" });
      taskId = task.id;
      await orch.claimNextTask(planner.id);
      await orch.publishPlan(task.id, planner.id, "Plan");
      const execution = await orch.claimNextTask(executor.id);
      await writeFile(path.join(execution!.worktree_path!, "merged.txt"), "done\n", "utf8");
      await execFileAsync("git", ["add", "."], { cwd: execution!.worktree_path! });
      await execFileAsync("git", ["commit", "-m", "exec"], { cwd: execution!.worktree_path! });
      await orch.submitWork(task.id, executor.id);
      const review = await orch.claimNextTask(reviewer.id);
      await orch.approveForHumanReview(task.id, {
        note: "Ready",
        reason: "approval",
        preserveWorktree: true,
        pullRequest: {
          provider: "github",
          baseBranch: "main",
          headBranch: review!.branch_name!,
          headSha: "head-sha",
          number: 77,
          url: "https://github.com/example/repo/pull/77",
          reviewDecision: "UNKNOWN",
          mergedSha: null,
          lastSyncedAt: new Date().toISOString(),
          lastError: null,
        },
      }, reviewer.id);
    } finally {
      conn.close();
    }

    const githubHelper = createMockGitHubHelper();
    vi.mocked(githubHelper.readPullRequest).mockResolvedValue({
      provider: "github",
      base_branch: "main",
      head_branch: `deltapilot/task/${taskId}`,
      head_sha: "head-sha",
      number: 77,
      url: "https://github.com/example/repo/pull/77",
      review_decision: "UNKNOWN",
      merged_sha: "external-merge-sha",
      last_synced_at: new Date().toISOString(),
      last_error: null,
    });

    const runner = new Runner({ repoRoot, dbPath, pollIntervalMs: 250, githubHelper });
    try {
      await runner.runOnce();
      const finalTask = runner.orch.getTask(taskId);
      expect(finalTask.status).toBe("done");
      expect(finalTask.pull_request?.merged_sha).toBe("external-merge-sha");
      expect(finalTask.worktree_path).toBeNull();
      expect(existsSync(path.join(repoRoot, ".deltapilot", "workspaces", taskId))).toBe(false);
    } finally {
      await runner.stop();
    }
  });

  it("falls back to another managed agent after a rate limit", async () => {
    const { conn, orch } = makeOrchestrator(repoRoot, dbPath);
    let taskId = "";
    let executorAId = "";
    let executorBId = "";
    try {
      await orch.registerAgent({
        name: "planner-1",
        kind: "mock",
        role: "planner",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      executorBId = (
        await orch.registerAgent({
        name: "executor-b",
        kind: "mock",
        role: "executor",
        runtimeMode: "managed",
        transport: "mcp-stdio",
        enabled: true,
      })
      ).id;
      executorAId = (
        await orch.registerAgent({
        name: "executor-a",
        kind: "mock",
        role: "executor",
        runtimeMode: "managed",
        transport: "mcp-stdio",
        enabled: true,
      })
      ).id;
      await orch.registerAgent({
        name: "reviewer-1",
        kind: "mock",
        role: "reviewer",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      await orch.registerAgent({
        name: "merger-1",
        kind: "mock",
        role: "merger",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      taskId = (await orch.createTask({ title: "Fallback task" })).id;
      orch.setAgentCooldown(executorBId, new Date(Date.now() + 60_000).toISOString(), null);
    } finally {
      conn.close();
    }

    const attempts = new Map<string, number>();
    registerAdapter(
      "mock",
      () =>
        new MockAdapter({
          result: async (ctx) => {
            const name = ctx.agent?.name ?? "unknown";
            attempts.set(name, (attempts.get(name) ?? 0) + 1);
            switch (ctx.agentRole) {
              case "planner":
                return { kind: "ok", output: "Plan it" };
              case "executor":
                if (name === "executor-a") {
                  return { kind: "rate_limit", message: "rate limited" };
                }
                await writeFile(path.join(ctx.worktreePath, "fallback.txt"), "done\n", "utf8");
                return { kind: "ok", message: "runner: fallback success" };
              case "reviewer":
                return { kind: "ok", decision: "approve" };
              default:
                return { kind: "error", message: "unexpected role" };
            }
          },
        }),
    );

    const githubHelper = createMockGitHubHelper();
    const runner = new Runner({ repoRoot, dbPath, pollIntervalMs: 250, githubHelper });
    try {
      await settleRunner(runner, 8);
      runner.orch.setAgentCooldown(executorBId, null, null);
      await settleRunner(runner, 20);
      const finalTask = runner.orch.getTask(taskId);
      expect(finalTask.status).toBe("done");
      expect(finalTask.pull_request?.number).toBe(42);
      expect(attempts.get("executor-a")).toBe(1);
      expect(attempts.get("executor-b")).toBeGreaterThanOrEqual(1);

      const countConn = openDatabase(dbPath);
      try {
        const handoffs = countConn.raw.prepare("SELECT COUNT(*) AS c FROM handoffs").get() as { c: number };
        expect(handoffs.c).toBe(1);
      } finally {
        countConn.close();
      }
      const limited = runner.orch.getAgent(executorAId);
      expect(limited?.last_limit_reason).toBe("rate_limit");
      expect(limited?.cooldown_until).toBeTruthy();
    } finally {
      await runner.stop();
    }
  }, 30_000);

  it("prefers the least-loaded healthy executor when a peer is already busy", async () => {
    const { conn, orch } = makeOrchestrator(repoRoot, dbPath);
    let busyExecutorId = "";
    let freeExecutorId = "";
    let secondTaskId = "";
    try {
      const planner = await orch.registerAgent({
        name: "planner-1",
        kind: "mock",
        role: "planner",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      const busyExecutor = await orch.registerAgent({
        name: "executor-busy",
        kind: "mock",
        role: "executor",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      const freeExecutor = await orch.registerAgent({
        name: "executor-free",
        kind: "mock",
        role: "executor",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });

      busyExecutorId = busyExecutor.id;
      freeExecutorId = freeExecutor.id;

      const first = await orch.createTask({ title: "Task A" });
      const firstPlanned = await orch.claimNextTask(planner.id);
      expect(firstPlanned?.id).toBe(first.id);
      await orch.publishPlan(first.id, planner.id, "Plan A");
      const claimedBusy = await orch.claimNextTask(busyExecutor.id);
      expect(claimedBusy?.id).toBe(first.id);
      const busySession = orch.createAgentSession({
        agentId: busyExecutor.id,
        logPath: path.join(repoRoot, ".deltapilot", "sessions", "busy.log"),
        status: "waiting",
        taskId: first.id,
      });
      orch.updateAgentSession(busySession.id, { status: "waiting", taskId: first.id });

      const second = await orch.createTask({ title: "Task B" });
      secondTaskId = second.id;
      const secondPlanned = await orch.claimNextTask(planner.id);
      expect(secondPlanned?.id).toBe(second.id);
      await orch.publishPlan(second.id, planner.id, "Plan B");
    } finally {
      conn.close();
    }

    registerAdapter(
      "mock",
      () =>
        new MockAdapter({
          result: async (ctx) => {
            if (ctx.agentRole === "executor") {
              return { kind: "question", approvalBody: `Holding ${ctx.task.id}` };
            }
            return { kind: "ok", output: "noop" };
          },
        }),
    );

    const runner = new Runner({ repoRoot, dbPath, pollIntervalMs: 250 });
    try {
      await settleRunner(runner, 4);
      const secondTask = runner.orch.getTask(secondTaskId);
      expect(secondTask.assigned_agent_id).toBe(freeExecutorId);
      expect(secondTask.assigned_agent_id).not.toBe(busyExecutorId);
    } finally {
      await runner.stop();
    }
  }, 30_000);

  it("recovers a claimed planner task that is missing branch/worktree metadata", async () => {
    const { conn, orch } = makeOrchestrator(repoRoot, dbPath);
    let plannerId = "";
    let taskId = "";
    try {
      plannerId = (
        await orch.registerAgent({
          name: "planner-1",
          kind: "mock",
          role: "planner",
          runtimeMode: "managed",
          transport: "mcp-stdio",
        })
      ).id;
      taskId = (await orch.createTask({ title: "Recover planning task" })).id;
      conn.raw
        .prepare(
          `UPDATE tasks
             SET status = 'planning',
                 assigned_agent_id = ?,
                 claimed_at = ?,
                 last_heartbeat_at = ?,
                 branch_name = NULL,
                 worktree_path = NULL
           WHERE id = ?`,
        )
        .run(plannerId, new Date().toISOString(), new Date().toISOString(), taskId);
    } finally {
      conn.close();
    }

    registerAdapter(
      "mock",
      () =>
        new MockAdapter({
          result: async (ctx) => {
            if (ctx.agentRole !== "planner") {
              return { kind: "error", message: "unexpected role" };
            }
            return { kind: "ok", output: "Recovered and planned" };
          },
        }),
    );

    const runner = new Runner({ repoRoot, dbPath, pollIntervalMs: 250 });
    try {
      await settleRunner(runner, 6);
      const task = runner.orch.getTask(taskId);
      expect(task.status).toBe("in_progress");
      expect(task.assigned_agent_id).toBeNull();
      expect(task.branch_name).toBe(`deltapilot/task/${taskId}`);
    } finally {
      await runner.stop();
    }
  }, 30_000);

  it("starts the managed terminal command for kinds without a task adapter", async () => {
    const { conn, orch } = makeOrchestrator(repoRoot, dbPath);
    try {
      const bootstrapCode = "console.log('gateway ready'); setTimeout(() => process.exit(0), 50);";
      await orch.registerAgent({
        name: "claude-gateway",
        kind: "other",
        role: "planner",
        runtimeMode: "managed",
        transport: "mcp-stdio",
        command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(bootstrapCode)}`,
      });
    } finally {
      conn.close();
    }

    const runner = new Runner({ repoRoot, dbPath, pollIntervalMs: 250 });
    try {
      await settleRunner(runner, 4);
      const [session] = runner.orch.listAgentSessions({ managedOnly: true });
      expect(session).toBeTruthy();
      const content = await readFile(session.log_path, "utf8");
      expect(content).toContain("launching managed start command");
      expect(content).toContain("gateway ready");
    } finally {
      await runner.stop();
    }
  }, 30_000);
});
