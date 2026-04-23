import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Orchestrator, WorktreeManager, openDatabase } from "@deltapilot/core";
import type { OpenDatabaseResult } from "@deltapilot/core";
import { MockAgent } from "../src/mock.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-e2e-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "orchestrator@deltapilot.local"], { cwd: dir });
  await execa("git", ["config", "user.name", "DeltaPilot"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# project\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("handoff e2e — autonomous pipeline", () => {
  let repoRoot: string;
  let conn: OpenDatabaseResult;
  let orch: Orchestrator;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    const dbPath = path.join(repoRoot, ".deltapilot-data.db");
    conn = openDatabase(dbPath);
    const worktreeMgr = new WorktreeManager({
      repoRoot,
      workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
    });
    orch = new Orchestrator({
      raw: conn.raw,
      db: conn.db,
      worktreeMgr,
      repoRoot,
    });
  });

  afterEach(async () => {
    conn.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it(
    "executor A hits a rate limit mid-task -> executor B resumes -> reviewer approves -> task reaches Done on the same branch",
    async () => {
      const planner = await orch.registerAgent({
        name: "planner",
        kind: "mock",
        role: "planner",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const agentA = await orch.registerAgent({
        name: "executor-a",
        kind: "mock",
        role: "executor",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const agentB = await orch.registerAgent({
        name: "executor-b",
        kind: "mock",
        role: "executor",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });

      const created = await orch.createTask({
        title: "Add greeting",
        brief: "Ship a greeting function",
        acceptance: {
          goal: "Produce a greeting",
          deliverables: ["greeting.txt"],
          files_in_scope: ["greeting.txt"],
          success_test: "file exists and contains 'hello'",
        },
      });
      expect(created.status).toBe("todo");

      const planned = await orch.claimNextTask(planner.id);
      expect(planned?.status).toBe("planning");
      await orch.publishPlan(created.id, planner.id, "Implement greeting.txt and verify it");

      const claimedByA = await orch.claimNextTask(agentA.id);
      expect(claimedByA?.id).toBe(created.id);
      expect(claimedByA?.status).toBe("in_progress");
      expect(claimedByA?.assigned_agent_id).toBe(agentA.id);
      expect(claimedByA?.worktree_path).toBeTruthy();
      const agentAWorktree = claimedByA!.worktree_path!;
      expect(existsSync(agentAWorktree)).toBe(true);

      const mockA = new MockAgent(agentA.id, orch);
      await mockA.workOn(claimedByA!, [
        { kind: "commit", file: "greeting.txt", content: "hel", message: "wip: start greeting" },
        { kind: "commit", file: "greeting.txt", content: "hell", message: "wip: more letters" },
        { kind: "scratchpad", content: "halfway through greeting; needs 'o' at the end" },
        { kind: "next_steps", content: "append final 'o' and submit for review" },
        { kind: "heartbeat" },
        { kind: "limit", reason: "rate_limit" },
      ]);

      const afterLimit = orch.getTask(created.id);
      expect(afterLimit.status).toBe("in_progress");
      expect(afterLimit.assigned_agent_id).toBeNull();
      expect(afterLimit.worktree_path).toBeNull();
      expect(existsSync(agentAWorktree)).toBe(false);

      const handoffRow = conn.raw
        .prepare("SELECT * FROM handoffs WHERE task_id = ?")
        .get(created.id) as
        | { reason: string; snapshot_commit: string | null; from_agent_id: string }
        | undefined;
      expect(handoffRow).toBeDefined();
      expect(handoffRow!.reason).toBe("rate_limit");
      expect(handoffRow!.from_agent_id).toBe(agentA.id);
      expect(handoffRow!.snapshot_commit).toBeTruthy();

      const scratchpad = await orch.readArtifact(created.id, "scratchpad");
      expect(scratchpad).toContain("halfway through greeting");
      const nextSteps = await orch.readArtifact(created.id, "next_steps");
      expect(nextSteps).toContain("append final 'o'");

      const claimedByB = await orch.claimNextTask(agentB.id);
      expect(claimedByB?.id).toBe(created.id);
      expect(claimedByB?.status).toBe("in_progress");
      expect(claimedByB?.assigned_agent_id).toBe(agentB.id);
      expect(claimedByB?.branch_name).toBe(claimedByA!.branch_name);
      expect(claimedByB?.worktree_path).toBeTruthy();
      expect(existsSync(claimedByB!.worktree_path!)).toBe(true);

      const mockB = new MockAgent(agentB.id, orch);
      await mockB.workOn(claimedByB!, [
        { kind: "commit", file: "greeting.txt", content: "hello", message: "finish greeting" },
        { kind: "submit" },
      ]);

      expect(orch.getTask(created.id).status).toBe("review");

      await orch.reviewDecision(created.id, { decision: "approve", note: "Looks good" });
      expect(orch.getTask(created.id).status).toBe("done");

      const branch = claimedByA!.branch_name!;
      const { stdout: log } = await execa("git", ["log", "--format=%s", branch], { cwd: repoRoot });
      const messages = log.split("\n").reverse();
      expect(messages).toEqual([
        "seed",
        "wip: start greeting",
        "wip: more letters",
        "finish greeting",
      ]);

      const { stdout: blob } = await execa("git", ["show", `${branch}:greeting.txt`], {
        cwd: repoRoot,
      });
      expect(blob).toBe("hello");
    },
    30_000,
  );

  it("claimNextTask returns null when queue is empty", async () => {
    const agent = await orch.registerAgent({
      name: "solo",
      kind: "mock",
      role: "planner",
      runtimeMode: "external",
      transport: "mcp-stdio",
    });
    const claim = await orch.claimNextTask(agent.id);
    expect(claim).toBeNull();
  });

  it(
    "review -> bounce returns the task to the planner queue where another planner can reclaim it",
    async () => {
      const plannerA = await orch.registerAgent({
        name: "planner-a",
        kind: "mock",
        role: "planner",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const plannerB = await orch.registerAgent({
        name: "planner-b",
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

      const task = await orch.createTask({ title: "To bounce" });

      const claimedPlanning = await orch.claimNextTask(plannerA.id);
      expect(claimedPlanning?.id).toBe(task.id);
      await orch.publishPlan(task.id, plannerA.id, "Initial plan");

      const claimedExec = await orch.claimNextTask(executor.id);
      expect(claimedExec?.id).toBe(task.id);
      const branchName = claimedExec!.branch_name!;

      const mockExecutor = new MockAgent(executor.id, orch);
      await mockExecutor.workOn(claimedExec!, [
        { kind: "commit", file: "x.txt", content: "first attempt", message: "first attempt" },
        { kind: "submit" },
      ]);
      expect(orch.getTask(task.id).status).toBe("review");

      await orch.reviewDecision(task.id, { decision: "bounce", note: "needs more work" });
      const bounced = orch.getTask(task.id);
      expect(bounced.status).toBe("todo");
      expect(bounced.assigned_agent_id).toBeNull();
      expect(bounced.branch_name).toBe(branchName);

      const reclaimed = await orch.claimNextTask(plannerB.id);
      expect(reclaimed?.id).toBe(task.id);
      expect(reclaimed?.status).toBe("planning");
      expect(reclaimed?.assigned_agent_id).toBe(plannerB.id);
      expect(reclaimed?.branch_name).toBe(branchName);
      expect(reclaimed?.worktree_path).toBeTruthy();
      expect(existsSync(reclaimed!.worktree_path!)).toBe(true);
    },
    15_000,
  );

  it("planning tasks rank ahead of fresh todos for planners", async () => {
    const plannerA = await orch.registerAgent({
      name: "planner-a",
      kind: "mock",
      role: "planner",
      runtimeMode: "external",
      transport: "mcp-stdio",
    });
    const plannerB = await orch.registerAgent({
      name: "planner-b",
      kind: "mock",
      role: "planner",
      runtimeMode: "external",
      transport: "mcp-stdio",
    });

    const old = await orch.createTask({ title: "old", priority: 50 });
    const oldClaim = await orch.claimNextTask(plannerA.id);
    expect(oldClaim?.id).toBe(old.id);
    const mockA = new MockAgent(plannerA.id, orch);
    await mockA.workOn(oldClaim!, [
      { kind: "scratchpad", content: "Need to finish the plan" },
      { kind: "limit", reason: "context_limit" },
    ]);
    expect(orch.getTask(old.id).status).toBe("planning");

    const fresh = await orch.createTask({ title: "fresh", priority: 90 });
    expect(fresh.status).toBe("todo");

    const nextForB = await orch.claimNextTask(plannerB.id);
    expect(nextForB?.id).toBe(old.id);
    expect(nextForB?.status).toBe("planning");
  });
});
