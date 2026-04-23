import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { openDatabase } from "./db/client.js";
import { WorktreeManager } from "./worktree.js";

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-core-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "core@test"], { cwd: dir });
  await execa("git", ["config", "user.name", "Core Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# core test\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("Orchestrator", () => {
  let repoRoot: string;
  let dbPath: string;
  let orch: Orchestrator;
  let close: () => void;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    dbPath = path.join(repoRoot, ".deltapilot-data.db");
    const conn = openDatabase(dbPath);
    close = conn.close;
    orch = new Orchestrator({
      raw: conn.raw,
      db: conn.db,
      worktreeMgr: new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      }),
      repoRoot,
    });
  });

  afterEach(async () => {
    close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("clears assignee/worktree between planner, executor, and reviewer phases while preserving the branch", async () => {
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

    const task = await orch.createTask({ title: "pipeline" });
    expect(task.status).toBe("todo");

    const planning = await orch.claimNextTask(planner.id);
    expect(planning?.status).toBe("planning");
    expect(planning?.assigned_agent_id).toBe(planner.id);
    expect(planning?.worktree_path).toBeTruthy();
    const branchName = planning!.branch_name;

    await orch.publishPlan(task.id, planner.id, "Plan");
    const afterPlan = orch.getTask(task.id);
    expect(afterPlan.status).toBe("in_progress");
    expect(afterPlan.assigned_agent_id).toBeNull();
    expect(afterPlan.worktree_path).toBeNull();
    expect(afterPlan.branch_name).toBe(branchName);
    expect(existsSync(path.join(repoRoot, ".deltapilot", "workspaces", task.id))).toBe(false);

    const execution = await orch.claimNextTask(executor.id);
    expect(execution?.status).toBe("in_progress");
    expect(execution?.assigned_agent_id).toBe(executor.id);
    expect(execution?.branch_name).toBe(branchName);
    await writeFile(path.join(execution!.worktree_path!, "x.txt"), "done\n", "utf8");
    await execa("git", ["add", "."], { cwd: execution!.worktree_path! });
    await execa("git", ["commit", "-m", "exec"], { cwd: execution!.worktree_path! });
    await orch.submitWork(task.id, executor.id);

    const afterExec = orch.getTask(task.id);
    expect(afterExec.status).toBe("review");
    expect(afterExec.assigned_agent_id).toBeNull();
    expect(afterExec.worktree_path).toBeNull();
    expect(afterExec.branch_name).toBe(branchName);

    const review = await orch.claimNextTask(reviewer.id);
    expect(review?.status).toBe("review");
    expect(review?.branch_name).toBe(branchName);
  });

  it("enters human_review after three review bounces and resets cleanly on returnToTodo", async () => {
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

    const task = await orch.createTask({ title: "bounce me" });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (orch.getTask(task.id).status === "todo") {
        const plan = await orch.claimNextTask(planner.id);
        expect(plan?.id).toBe(task.id);
        await orch.publishPlan(task.id, planner.id, `plan ${attempt + 1}`);
      }
      const exec = await orch.claimNextTask(executor.id);
      expect(exec?.status).toBe("in_progress");
      await orch.submitWork(task.id, executor.id);
      const review = await orch.claimNextTask(reviewer.id);
      expect(review?.status).toBe("review");
      await orch.submitReview(task.id, reviewer.id, {
        decision: "bounce",
        note: `missing piece ${attempt + 1}`,
      });
    }

    const escalated = orch.getTask(task.id);
    expect(escalated.status).toBe("human_review");
    expect(escalated.review_bounce_count).toBe(3);

    await orch.returnToTodo(task.id, "human reset");
    const reset = orch.getTask(task.id);
    expect(reset.status).toBe("todo");
    expect(reset.review_bounce_count).toBe(0);
    expect(reset.status_note).toBe("human reset");
  });

  it("deletes an inactive agent and keeps task history intact", async () => {
    const planner = await orch.registerAgent({
      name: "planner",
      kind: "mock",
      role: "planner",
      runtimeMode: "external",
      transport: "mcp-stdio",
    });

    const task = await orch.createTask({ title: "plan only" });
    const claimed = await orch.claimNextTask(planner.id);
    expect(claimed?.status).toBe("planning");
    await orch.publishPlan(task.id, planner.id, "Ship it");

    const deleted = orch.deleteAgent(planner.id);
    expect(deleted.id).toBe(planner.id);
    expect(orch.listAgents().map((agent) => agent.id)).not.toContain(planner.id);
    expect(orch.getTask(task.id).status).toBe("in_progress");
  });

  it("refuses to delete an agent with an assigned task", async () => {
    const planner = await orch.registerAgent({
      name: "planner",
      kind: "mock",
      role: "planner",
      runtimeMode: "external",
      transport: "mcp-stdio",
    });

    const task = await orch.createTask({ title: "claimed task" });
    const claimed = await orch.claimNextTask(planner.id);
    expect(claimed?.id).toBe(task.id);

    expect(() => orch.deleteAgent(planner.id)).toThrow(/currently assigned/i);
  });
});
