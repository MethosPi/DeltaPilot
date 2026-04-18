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

describe("handoff e2e — walking skeleton", () => {
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
    "Agent A hits rate limit mid-task → Agent B resumes → task reaches Done with commits from both on the same branch",
    async () => {
      const agentA = await orch.registerAgent({
        name: "A",
        kind: "mock",
        transport: "mcp-stdio",
      });
      const agentB = await orch.registerAgent({
        name: "B",
        kind: "mock",
        transport: "mcp-stdio",
      });

      // Create and graduate a task.
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
      expect(created.status).toBe("init");

      orch.applyEvent(created.id, { kind: "ready" });

      // Agent A claims.
      const claimedByA = await orch.claimNextTask(agentA.id);
      expect(claimedByA?.id).toBe(created.id);
      expect(claimedByA?.status).toBe("in_progress");
      expect(claimedByA?.assigned_agent_id).toBe(agentA.id);
      expect(claimedByA?.worktree_path).toBeTruthy();
      const agentAWorktree = claimedByA!.worktree_path!;
      expect(existsSync(agentAWorktree)).toBe(true);

      // Agent A makes partial progress then hits a rate limit.
      const mockA = new MockAgent(agentA.id, orch);
      await mockA.workOn(claimedByA!, [
        { kind: "commit", file: "greeting.txt", content: "hel", message: "wip: start greeting" },
        { kind: "commit", file: "greeting.txt", content: "hell", message: "wip: more letters" },
        { kind: "scratchpad", content: "halfway through greeting; needs 'o' at the end" },
        { kind: "next_steps", content: "append final 'o' and submit for review" },
        { kind: "heartbeat" },
        { kind: "limit", reason: "rate_limit" },
      ]);

      // Task now handoff_pending; worktree removed; handoff recorded.
      const afterLimit = orch.getTask(created.id);
      expect(afterLimit.status).toBe("handoff_pending");
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

      // Artifacts should be readable by the next agent.
      const scratchpad = await orch.readArtifact(created.id, "scratchpad");
      expect(scratchpad).toContain("halfway through greeting");
      const nextSteps = await orch.readArtifact(created.id, "next_steps");
      expect(nextSteps).toContain("append final 'o'");

      // Agent B claims — resumes the same branch.
      const claimedByB = await orch.claimNextTask(agentB.id);
      expect(claimedByB?.id).toBe(created.id);
      expect(claimedByB?.status).toBe("in_progress");
      expect(claimedByB?.assigned_agent_id).toBe(agentB.id);
      expect(claimedByB?.branch_name).toBe(claimedByA!.branch_name);
      expect(claimedByB?.worktree_path).toBeTruthy();
      expect(existsSync(claimedByB!.worktree_path!)).toBe(true);

      // Agent B finishes and submits.
      const mockB = new MockAgent(agentB.id, orch);
      await mockB.workOn(claimedByB!, [
        { kind: "commit", file: "greeting.txt", content: "hello", message: "finish greeting" },
        { kind: "submit" },
      ]);

      expect(orch.getTask(created.id).status).toBe("review");

      // Human approves via UI/CLI.
      orch.applyEvent(created.id, { kind: "approve" });
      expect(orch.getTask(created.id).status).toBe("done");

      // All commits from both agents must live on the same task branch, in order.
      const branch = claimedByA!.branch_name!;
      const { stdout: log } = await execa(
        "git",
        ["log", "--format=%s", branch],
        { cwd: repoRoot },
      );
      const messages = log.split("\n").reverse(); // oldest first
      expect(messages).toEqual([
        "seed",
        "wip: start greeting",
        "wip: more letters",
        "finish greeting",
      ]);

      // Final file content should be what Agent B committed.
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
      transport: "mcp-stdio",
    });
    const claim = await orch.claimNextTask(agent.id);
    expect(claim).toBeNull();
  });

  it(
    "review → bounce returns task to queue where any agent can reclaim",
    async () => {
      const agentA = await orch.registerAgent({
        name: "A",
        kind: "mock",
        transport: "mcp-stdio",
      });
      const agentB = await orch.registerAgent({
        name: "B",
        kind: "mock",
        transport: "mcp-stdio",
      });

      const task = await orch.createTask({ title: "To bounce" });
      orch.applyEvent(task.id, { kind: "ready" });

      const claimedByA = await orch.claimNextTask(agentA.id);
      expect(claimedByA?.id).toBe(task.id);
      const branchName = claimedByA!.branch_name!;

      const mockA = new MockAgent(agentA.id, orch);
      await mockA.workOn(claimedByA!, [
        { kind: "commit", file: "x.txt", content: "first attempt", message: "first attempt" },
        { kind: "submit" },
      ]);
      expect(orch.getTask(task.id).status).toBe("review");

      // Human bounces: send back to the queue for another attempt.
      orch.applyEvent(task.id, { kind: "bounce", note: "needs more work" });
      const bounced = orch.getTask(task.id);
      expect(bounced.status).toBe("todo");
      // Without clearing the assignee, the task would be invisible to claimNextTask
      // (which filters on assigned_agent_id IS NULL) and stuck forever.
      expect(bounced.assigned_agent_id).toBeNull();
      // Branch preserved so A's commits survive the retry.
      expect(bounced.branch_name).toBe(branchName);

      // A different agent picks it up and resumes the same branch.
      const claimedByB = await orch.claimNextTask(agentB.id);
      expect(claimedByB?.id).toBe(task.id);
      expect(claimedByB?.status).toBe("in_progress");
      expect(claimedByB?.assigned_agent_id).toBe(agentB.id);
      expect(claimedByB?.branch_name).toBe(branchName);
      expect(claimedByB?.worktree_path).toBeTruthy();
      expect(existsSync(claimedByB!.worktree_path!)).toBe(true);
    },
    15_000,
  );

  it("handoff_pending tasks rank ahead of fresh todos", async () => {
    const a = await orch.registerAgent({ name: "A", kind: "mock", transport: "mcp-stdio" });
    const b = await orch.registerAgent({ name: "B", kind: "mock", transport: "mcp-stdio" });

    const old = await orch.createTask({ title: "old", priority: 50 });
    orch.applyEvent(old.id, { kind: "ready" });

    // Agent A claims old, makes a commit, then hits a limit — old becomes handoff_pending.
    const oldClaim = await orch.claimNextTask(a.id);
    const mockA = new MockAgent(a.id, orch);
    await mockA.workOn(oldClaim!, [
      { kind: "commit", file: "a.txt", content: "x", message: "wip" },
      { kind: "limit", reason: "context_limit" },
    ]);
    expect(orch.getTask(old.id).status).toBe("handoff_pending");

    // A higher-priority fresh task arrives.
    const fresh = await orch.createTask({ title: "fresh", priority: 90 });
    orch.applyEvent(fresh.id, { kind: "ready" });

    // Agent B should pick up the handoff even though fresh has higher priority —
    // in-flight work wins over new work to keep the pipeline moving.
    const nextForB = await orch.claimNextTask(b.id);
    expect(nextForB?.id).toBe(old.id);
  });
});
