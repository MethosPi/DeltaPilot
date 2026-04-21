import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { Orchestrator, WorktreeManager, openDatabase } from "@deltapilot/core";
import { startDashboardServer, type StartedDashboardServer } from "./server.js";

const execFileAsync = promisify(execFile);

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-dashboard-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: dir });
  await execFileAsync("git", ["config", "user.email", "dashboard@deltapilot.local"], { cwd: dir });
  await execFileAsync("git", ["config", "user.name", "DeltaPilot Dashboard"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# dashboard test\n");
  await execFileAsync("git", ["add", "."], { cwd: dir });
  await execFileAsync("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

describe("dashboard server — e2e", () => {
  let repoRoot: string;
  let dbPath: string;
  let server: StartedDashboardServer;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    dbPath = path.join(repoRoot, ".deltapilot-data.db");
    server = await startDashboardServer({
      repoRoot,
      dbPath,
      host: "127.0.0.1",
      port: 0,
    });
  });

  afterEach(async () => {
    await server.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("creates a task via the API and exposes it in the dashboard snapshot", async () => {
    const createRes = await fetch(`${server.origin}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "dashboard task",
        brief: "created through HTTP",
        priority: 82,
        ready: true,
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { task: { id: string; status: string } };
    expect(created.task.status).toBe("todo");

    const snapshotRes = await fetch(`${server.origin}/api/dashboard`);
    expect(snapshotRes.status).toBe(200);
    const snapshot = (await snapshotRes.json()) as {
      stats: Record<string, number>;
      tasks: Array<{ id: string; status: string; title: string }>;
    };
    expect(Object.keys(snapshot.stats).sort()).toEqual([
      "cancelled",
      "done",
      "in_progress",
      "review",
      "todo",
    ]);
    expect(snapshot.tasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: created.task.id,
          title: "dashboard task",
          status: "todo",
        }),
      ]),
    );
  });

  it("approves a review task through the dashboard action endpoint", async () => {
    const conn = openDatabase(dbPath);
    let taskId = "";
    try {
      const worktreeMgr = new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      });
      const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
      const agent = await orch.registerAgent({
        name: "reviewer-agent",
        kind: "mock",
        transport: "mcp-stdio",
      });
      const task = await orch.createTask({ title: "review me" });
      taskId = task.id;
      orch.applyEvent(task.id, { kind: "ready" });
      const claimed = await orch.claimNextTask(agent.id);
      expect(claimed?.status).toBe("in_progress");
      await orch.submitWork(task.id, agent.id);
      expect(orch.getTask(task.id).status).toBe("review");
    } finally {
      conn.close();
    }

    const approveRes = await fetch(`${server.origin}/api/tasks/${taskId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "approve" }),
    });
    expect(approveRes.status).toBe(200);
    const detail = (await approveRes.json()) as { task: { status: string } };
    expect(detail.task.status).toBe("done");
  });

  it("moves a task between dashboard columns through the override action", async () => {
    const conn = openDatabase(dbPath);
    let taskId = "";
    let agentId = "";
    try {
      const worktreeMgr = new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      });
      const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
      const agent = await orch.registerAgent({
        name: "board-agent",
        kind: "mock",
        transport: "mcp-stdio",
      });
      agentId = agent.id;
      const task = await orch.createTask({ title: "drag me" });
      taskId = task.id;
      orch.applyEvent(task.id, { kind: "ready" });
      expect(orch.getTask(task.id).status).toBe("todo");
    } finally {
      conn.close();
    }

    const inProgressRes = await fetch(`${server.origin}/api/tasks/${taskId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "move", target_status: "in_progress" }),
    });
    expect(inProgressRes.status).toBe(200);
    const inProgressDetail = (await inProgressRes.json()) as {
      task: {
        status: string;
        raw_status: string;
        assigned_agent_id: string | null;
        worktree_exists: boolean;
      };
    };
    expect(inProgressDetail.task.status).toBe("in_progress");
    expect(inProgressDetail.task.raw_status).toBe("in_progress");
    expect(inProgressDetail.task.assigned_agent_id).toBe(agentId);
    expect(inProgressDetail.task.worktree_exists).toBe(true);

    const todoRes = await fetch(`${server.origin}/api/tasks/${taskId}/actions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "move",
        target_status: "todo",
        note: "Back to queue",
      }),
    });
    expect(todoRes.status).toBe(200);
    const todoDetail = (await todoRes.json()) as {
      task: {
        status: string;
        raw_status: string;
        assigned_agent_id: string | null;
        worktree_exists: boolean;
      };
    };
    expect(todoDetail.task.status).toBe("todo");
    expect(todoDetail.task.raw_status).toBe("todo");
    expect(todoDetail.task.assigned_agent_id).toBeNull();
    expect(todoDetail.task.worktree_exists).toBe(false);
  });

  it("registers an agent via POST /api/agents and surfaces it in the snapshot", async () => {
    const registerRes = await fetch(`${server.origin}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "claude-code-dashboard",
        kind: "claude-code",
        transport: "mcp-stdio",
      }),
    });
    expect(registerRes.status).toBe(201);
    const agent = (await registerRes.json()) as { id: string; name: string; kind: string };
    expect(agent.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(agent.name).toBe("claude-code-dashboard");
    expect(agent.kind).toBe("claude-code");

    const snapshotRes = await fetch(`${server.origin}/api/dashboard`);
    const snapshot = (await snapshotRes.json()) as {
      agents: Array<{ id: string; kind: string }>;
    };
    expect(snapshot.agents.map((a) => a.id)).toContain(agent.id);
  });

  it("rejects agent registration with invalid kind", async () => {
    const res = await fetch(`${server.origin}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "bad", kind: "gpt-4" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { message: string };
    expect(body.message).toMatch(/kind must be one of/);
  });
});
