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
      "human_review",
      "in_progress",
      "planning",
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

  it("registers managed agents with role/runtime metadata and default commands", async () => {
    const registerRes = await fetch(`${server.origin}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "codex-planner",
        kind: "codex",
        role: "planner",
        runtime_mode: "managed",
        transport: "mcp-stdio",
      }),
    });
    expect(registerRes.status).toBe(201);
    const agent = (await registerRes.json()) as { id: string; role: string; runtime_mode: string; command?: string };
    expect(agent.role).toBe("planner");
    expect(agent.runtime_mode).toBe("managed");
    expect(agent.command).toBe("codex");

    const claudeRegisterRes = await fetch(`${server.origin}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "claude-planner",
        kind: "claude-code",
        role: "planner",
        runtime_mode: "managed",
        transport: "mcp-stdio",
      }),
    });
    expect(claudeRegisterRes.status).toBe(201);
    const claudeAgent = (await claudeRegisterRes.json()) as { command?: string };
    expect(claudeAgent.command).toBe("claude");

    const openclawRegisterRes = await fetch(`${server.origin}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "openclaw-gateway",
        kind: "openclaw",
        role: "planner",
        runtime_mode: "managed",
        transport: "mcp-stdio",
      }),
    });
    expect(openclawRegisterRes.status).toBe(201);
    const openclawAgent = (await openclawRegisterRes.json()) as { command?: string };
    expect(openclawAgent.command).toBe("openclaw gateway start");

    const patchRes = await fetch(`${server.origin}/api/agents/${agent.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as { enabled: boolean };
    expect(patched.enabled).toBe(false);
  });

  it("deletes an idle agent through the API", async () => {
    const registerRes = await fetch(`${server.origin}/api/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "codex-delete-me",
        kind: "codex",
        role: "planner",
        runtime_mode: "managed",
        transport: "mcp-stdio",
      }),
    });
    expect(registerRes.status).toBe(201);
    const agent = (await registerRes.json()) as { id: string; name: string };

    const deleteRes = await fetch(`${server.origin}/api/agents/${agent.id}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);
    const deleted = (await deleteRes.json()) as { id: string; name: string };
    expect(deleted.id).toBe(agent.id);
    expect(deleted.name).toBe("codex-delete-me");

    const listRes = await fetch(`${server.origin}/api/agents`);
    const list = (await listRes.json()) as Array<{ id: string }>;
    expect(list.map((entry) => entry.id)).not.toContain(agent.id);
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
      const planner = await orch.registerAgent({
        name: "planner-agent",
        kind: "mock",
        role: "planner",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const executor = await orch.registerAgent({
        name: "executor-agent",
        kind: "mock",
        role: "executor",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const task = await orch.createTask({ title: "review me" });
      taskId = task.id;
      const claimedPlanning = await orch.claimNextTask(planner.id);
      expect(claimedPlanning?.status).toBe("planning");
      await orch.publishPlan(task.id, planner.id, "Do the work");
      const claimedExec = await orch.claimNextTask(executor.id);
      expect(claimedExec?.status).toBe("in_progress");
      await orch.submitWork(task.id, executor.id);
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

  it("returns a human_review task back to todo and resets the bounce counter", async () => {
    const conn = openDatabase(dbPath);
    let taskId = "";
    try {
      const worktreeMgr = new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      });
      const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
      const planner = await orch.registerAgent({
        name: "planner-agent",
        kind: "mock",
        role: "planner",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const executor = await orch.registerAgent({
        name: "executor-agent",
        kind: "mock",
        role: "executor",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const reviewer = await orch.registerAgent({
        name: "reviewer-agent",
        kind: "mock",
        role: "reviewer",
        runtimeMode: "external",
        transport: "mcp-stdio",
      });
      const task = await orch.createTask({ title: "escalate me" });
      taskId = task.id;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (orch.getTask(task.id).status === "todo") {
          const planning = await orch.claimNextTask(planner.id);
          expect(planning?.id).toBe(task.id);
          await orch.publishPlan(task.id, planner.id, `Plan ${attempt + 1}`);
        }
        const exec = await orch.claimNextTask(executor.id);
        expect(exec?.status).toBe("in_progress");
        await orch.submitWork(task.id, executor.id);
        const review = await orch.claimNextTask(reviewer.id);
        expect(review?.status).toBe("review");
        await orch.submitReview(task.id, reviewer.id, {
          decision: "bounce",
          note: `Try again ${attempt + 1}`,
        });
      }

      expect(orch.getTask(task.id).status).toBe("human_review");
    } finally {
      conn.close();
    }

    const returnRes = await fetch(`${server.origin}/api/tasks/${taskId}/return-to-todo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "Human approved another pass" }),
    });
    expect(returnRes.status).toBe(200);
    const detail = (await returnRes.json()) as { task: { status: string; review_bounce_count: number } };
    expect(detail.task.status).toBe("todo");
    expect(detail.task.review_bounce_count).toBe(0);
  }, 30_000);

  it("lists sessions/approvals and lets a human reply + approve", async () => {
    const conn = openDatabase(dbPath);
    let sessionId = "";
    let approvalId = "";
    try {
      const worktreeMgr = new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      });
      const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
      const agent = await orch.registerAgent({
        name: "managed-reviewer",
        kind: "mock",
        role: "reviewer",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      const session = orch.createAgentSession({
        agentId: agent.id,
        logPath: path.join(repoRoot, ".deltapilot", "session.log"),
        status: "waiting",
      });
      sessionId = session.id;
      const approval = orch.createApprovalRequest({
        sessionId,
        agentId: agent.id,
        kind: "approval",
        title: "Need approval",
        body: "Please approve the proposed change.",
      });
      approvalId = approval.id;
    } finally {
      conn.close();
    }

    const sessionsRes = await fetch(`${server.origin}/api/sessions`);
    const sessions = (await sessionsRes.json()) as Array<{ id: string; pending_approval_count: number; agent_kind: string; command: string | null }>;
    expect(sessions.map((session) => session.id)).toContain(sessionId);
    expect(sessions.find((session) => session.id === sessionId)?.agent_kind).toBe("mock");

    const approvalsRes = await fetch(`${server.origin}/api/approvals`);
    const approvals = (await approvalsRes.json()) as Array<{ id: string; status: string }>;
    expect(approvals.find((approval) => approval.id === approvalId)?.status).toBe("pending");

    const messageRes = await fetch(`${server.origin}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "Proceed with the fallback path." }),
    });
    expect(messageRes.status).toBe(201);
    const sessionDetail = (await messageRes.json()) as { session: { status: string; agent_kind: string; command: string | null }; messages: Array<{ body: string }> };
    expect(sessionDetail.session.status).toBe("ready");
    expect(sessionDetail.session.agent_kind).toBe("mock");
    expect(sessionDetail.session.command).toBeNull();
    expect(sessionDetail.messages.some((message) => message.body.includes("fallback"))).toBe(true);

    const approveRes = await fetch(`${server.origin}/api/approvals/${approvalId}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as { status: string };
    expect(approved.status).toBe("approved");
  });

  it("launches and interrupts a managed terminal session from session controls", async () => {
    const conn = openDatabase(dbPath);
    let sessionId = "";
    try {
      const worktreeMgr = new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, "workspaces"),
      });
      const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
      const command = `${JSON.stringify(process.execPath)} -e ${
        JSON.stringify("console.log('terminal ready'); setInterval(() => console.log('tick'), 50);")
      }`;
      const agent = await orch.registerAgent({
        name: "interactive-managed",
        kind: "other",
        role: "planner",
        runtimeMode: "managed",
        transport: "mcp-stdio",
        command,
      });
      const session = orch.createAgentSession({
        agentId: agent.id,
        logPath: path.join(repoRoot, ".deltapilot", "interactive-session.log"),
        status: "stopped",
      });
      sessionId = session.id;

      const messageRes = await fetch(`${server.origin}/api/sessions/${sessionId}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: command }),
      });
      expect(messageRes.status).toBe(201);
    } finally {
      conn.close();
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    const startedDetail = (await fetch(`${server.origin}/api/sessions/${sessionId}`).then((res) => res.json())) as {
      session: { status: string; pid: number | null };
      log_content: string;
    };
    expect(["busy", "stopped"]).toContain(startedDetail.session.status);
    expect(startedDetail.log_content).toContain("terminal ready");

    const interruptRes = await fetch(`${server.origin}/api/sessions/${sessionId}/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(interruptRes.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 250));

    const stoppedDetail = (await fetch(`${server.origin}/api/sessions/${sessionId}`).then((res) => res.json())) as {
      session: { status: string; last_error: string | null };
      log_content: string;
    };
    expect(stoppedDetail.session.status).toBe("stopped");
    expect(stoppedDetail.session.last_error).toBe("Interrupted by user");
    expect(stoppedDetail.log_content).toContain("^C");
  }, 30_000);

  it("answers dashboard questions from task context when no live shell is open", async () => {
    const conn = openDatabase(dbPath);
    let sessionId = "";
    try {
      const worktreeMgr = new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      });
      const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
      const planner = await orch.registerAgent({
        name: "codex-planner",
        kind: "codex",
        role: "planner",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      const task = await orch.createTask({ title: "Plan me", brief: "Need a visible execution plan." });
      const claimed = await orch.claimNextTask(planner.id);
      expect(claimed?.status).toBe("planning");
      await orch.publishPlan(task.id, planner.id, "1. Add the upload entrypoint.\n2. Wire the backend.\n3. Validate the flow.");

      const session = orch.createAgentSession({
        agentId: planner.id,
        taskId: task.id,
        logPath: path.join(repoRoot, ".deltapilot", "planner-chat.log"),
        status: "ready",
      });
      sessionId = session.id;
    } finally {
      conn.close();
    }

    const messageRes = await fetch(`${server.origin}/api/sessions/${sessionId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "what was your plan?" }),
    });
    expect(messageRes.status).toBe(201);
    const detail = (await messageRes.json()) as {
      messages: Array<{ direction: string; kind: string; body: string }>;
      log_content: string;
    };
    expect(detail.messages.some((message) =>
      message.direction === "agent" &&
      message.kind === "reply" &&
      message.body.includes("My latest plan") &&
      message.body.includes("Add the upload entrypoint")
    )).toBe(true);
    expect(detail.log_content).toContain("[agent/reply]");
  });

  it("deletes a single removable session and clears stopped session history", async () => {
    const conn = openDatabase(dbPath);
    let readySessionId = "";
    let stoppedSessionId = "";
    try {
      const worktreeMgr = new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      });
      const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
      const agent = await orch.registerAgent({
        name: "managed-planner",
        kind: "mock",
        role: "planner",
        runtimeMode: "managed",
        transport: "mcp-stdio",
      });
      readySessionId = orch.createAgentSession({
        agentId: agent.id,
        logPath: path.join(repoRoot, ".deltapilot", "ready.log"),
        status: "ready",
      }).id;
      stoppedSessionId = orch.createAgentSession({
        agentId: agent.id,
        logPath: path.join(repoRoot, ".deltapilot", "stopped.log"),
        status: "stopped",
      }).id;
      orch.updateAgentSession(stoppedSessionId, {
        endedAt: new Date().toISOString(),
        lastError: "old failure",
      });
    } finally {
      conn.close();
    }

    const clearRes = await fetch(`${server.origin}/api/sessions/clear-history`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(clearRes.status).toBe(200);
    const cleared = (await clearRes.json()) as { deleted_count: number };
    expect(cleared.deleted_count).toBe(1);

    const remainingAfterClear = (await fetch(`${server.origin}/api/sessions`).then((res) => res.json())) as Array<{ id: string }>;
    expect(remainingAfterClear.map((session) => session.id)).toContain(readySessionId);
    expect(remainingAfterClear.map((session) => session.id)).not.toContain(stoppedSessionId);

    const deleteRes = await fetch(`${server.origin}/api/sessions/${readySessionId}`, {
      method: "DELETE",
    });
    expect(deleteRes.status).toBe(200);

    const remainingAfterDelete = (await fetch(`${server.origin}/api/sessions`).then((res) => res.json())) as Array<{ id: string }>;
    expect(remainingAfterDelete.map((session) => session.id)).not.toContain(readySessionId);
  });
});
