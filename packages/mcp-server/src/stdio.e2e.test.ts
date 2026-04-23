import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { OpenDatabaseResult } from "@deltapilot/core";
import { Orchestrator, WorktreeManager, openDatabase } from "@deltapilot/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../dist/cli.js");

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-mcp-e2e-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "orch@deltapilot.local"], { cwd: dir });
  await execa("git", ["config", "user.name", "DeltaPilot"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# project\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

async function registerAgent(
  repoRoot: string,
  dbPath: string,
  role: "planner" | "executor" | "reviewer",
): Promise<string> {
  const conn = openDatabase(dbPath);
  try {
    const orch = new Orchestrator({
      raw: conn.raw,
      db: conn.db,
      worktreeMgr: new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      }),
      repoRoot,
    });
    const agent = await orch.registerAgent({
      name: `${role}-agent`,
      kind: "mock",
      role,
      runtimeMode: "external",
      transport: "mcp-stdio",
    });
    return agent.id;
  } finally {
    conn.close();
  }
}

async function createPlannableTask(repoRoot: string, dbPath: string): Promise<string> {
  const conn = openDatabase(dbPath);
  try {
    const orch = new Orchestrator({
      raw: conn.raw,
      db: conn.db,
      worktreeMgr: new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      }),
      repoRoot,
    });
    const task = await orch.createTask({ title: "stdio round-trip" });
    return task.id;
  } finally {
    conn.close();
  }
}

async function promoteTaskToExecution(
  repoRoot: string,
  dbPath: string,
  plannerId: string,
  taskId: string,
): Promise<void> {
  const conn = openDatabase(dbPath);
  try {
    const orch = new Orchestrator({
      raw: conn.raw,
      db: conn.db,
      worktreeMgr: new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      }),
      repoRoot,
    });
    const claimed = await orch.claimNextTask(plannerId);
    expect(claimed?.id).toBe(taskId);
    await orch.publishPlan(taskId, plannerId, "Do the thing");
  } finally {
    conn.close();
  }
}

async function promoteTaskToReview(
  repoRoot: string,
  dbPath: string,
  plannerId: string,
  executorId: string,
  taskId: string,
): Promise<void> {
  await promoteTaskToExecution(repoRoot, dbPath, plannerId, taskId);
  const conn = openDatabase(dbPath);
  try {
    const orch = new Orchestrator({
      raw: conn.raw,
      db: conn.db,
      worktreeMgr: new WorktreeManager({
        repoRoot,
        workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
      }),
      repoRoot,
    });
    const claimed = await orch.claimNextTask(executorId);
    expect(claimed?.id).toBe(taskId);
    await orch.submitWork(taskId, executorId);
  } finally {
    conn.close();
  }
}

function parseJson<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (!first || first.type !== "text") {
    throw new Error("expected text content in tool result");
  }
  return JSON.parse(first.text) as T;
}

async function connectClient(repoRoot: string, agentId: string): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_PATH, "--repo", repoRoot, "--agent-id", agentId],
    stderr: "pipe",
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

describe("deltapilot-mcp stdio CLI — e2e", () => {
  let repoRoot: string;
  let dbPath: string;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    dbPath = path.join(repoRoot, ".deltapilot-data.db");
  });

  afterEach(async () => {
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("advertises the autonomous pipeline tools", async () => {
    const plannerId = await registerAgent(repoRoot, dbPath, "planner");
    const { client } = await connectClient(repoRoot, plannerId);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toEqual([
        "claim_task",
        "create_task",
        "heartbeat",
        "publish_plan",
        "report_limit",
        "request_handoff",
        "submit_review",
        "submit_work",
      ]);
    } finally {
      await client.close();
    }
  });

  it("planner create_task -> claim_task -> publish_plan drives the task into executor queue", async () => {
    const plannerId = await registerAgent(repoRoot, dbPath, "planner");
    const { client } = await connectClient(repoRoot, plannerId);
    try {
      const createdResult = await client.callTool({
        name: "create_task",
        arguments: { title: "new task", brief: "created over MCP", priority: 75 },
      });
      const created = parseJson<{ id: string; status: string }>(createdResult);
      expect(created.status).toBe("todo");

      const claimResult = await client.callTool({ name: "claim_task", arguments: {} });
      const claimed = parseJson<{ id: string; status: string; assigned_agent_id: string } | null>(
        claimResult,
      );
      expect(claimed?.id).toBe(created.id);
      expect(claimed?.status).toBe("planning");
      expect(claimed?.assigned_agent_id).toBe(plannerId);

      const planResult = await client.callTool({
        name: "publish_plan",
        arguments: { task_id: created.id, plan: "1. inspect\n2. implement\n3. verify" },
      });
      const planned = parseJson<{ status: string; assigned_agent_id: string | null }>(planResult);
      expect(planned.status).toBe("in_progress");
      expect(planned.assigned_agent_id).toBeNull();
    } finally {
      await client.close();
    }
  });

  it("executor claim_task -> heartbeat -> submit_work drives the task to review", async () => {
    const plannerId = await registerAgent(repoRoot, dbPath, "planner");
    const executorId = await registerAgent(repoRoot, dbPath, "executor");
    const taskId = await createPlannableTask(repoRoot, dbPath);
    await promoteTaskToExecution(repoRoot, dbPath, plannerId, taskId);

    const { client } = await connectClient(repoRoot, executorId);
    try {
      const claimResult = await client.callTool({ name: "claim_task", arguments: {} });
      const claimed = parseJson<{
        id: string;
        status: string;
        assigned_agent_id: string;
      } | null>(claimResult);
      expect(claimed?.id).toBe(taskId);
      expect(claimed?.status).toBe("in_progress");
      expect(claimed?.assigned_agent_id).toBe(executorId);

      await client.callTool({
        name: "heartbeat",
        arguments: { task_id: taskId },
      });

      const submitResult = await client.callTool({
        name: "submit_work",
        arguments: { task_id: taskId },
      });
      const submitted = parseJson<{ id: string; status: string; assigned_agent_id: string | null }>(
        submitResult,
      );
      expect(submitted.status).toBe("review");
      expect(submitted.assigned_agent_id).toBeNull();

      await client.close();
      const conn: OpenDatabaseResult = openDatabase(dbPath);
      try {
        const row = conn.raw
          .prepare("SELECT status FROM tasks WHERE id = ?")
          .get(taskId) as { status: string };
        expect(row.status).toBe("review");
      } finally {
        conn.close();
      }
    } finally {
      await client.close().catch(() => {});
    }
  }, 20_000);

  it("reviewer claim_task -> submit_review approve drives the task to done", async () => {
    const plannerId = await registerAgent(repoRoot, dbPath, "planner");
    const executorId = await registerAgent(repoRoot, dbPath, "executor");
    const reviewerId = await registerAgent(repoRoot, dbPath, "reviewer");
    const taskId = await createPlannableTask(repoRoot, dbPath);
    await promoteTaskToReview(repoRoot, dbPath, plannerId, executorId, taskId);

    const { client } = await connectClient(repoRoot, reviewerId);
    try {
      const claimResult = await client.callTool({ name: "claim_task", arguments: {} });
      const claimed = parseJson<{ id: string; status: string; assigned_agent_id: string } | null>(
        claimResult,
      );
      expect(claimed?.status).toBe("review");
      expect(claimed?.assigned_agent_id).toBe(reviewerId);

      const reviewResult = await client.callTool({
        name: "submit_review",
        arguments: { task_id: taskId, decision: "approve", note: "Looks good" },
      });
      const reviewed = parseJson<{ status: string }>(reviewResult);
      expect(reviewed.status).toBe("done");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("report_limit keeps the task in the same phase and clears the assignee/worktree", async () => {
    const plannerId = await registerAgent(repoRoot, dbPath, "planner");
    const executorId = await registerAgent(repoRoot, dbPath, "executor");
    const taskId = await createPlannableTask(repoRoot, dbPath);
    await promoteTaskToExecution(repoRoot, dbPath, plannerId, taskId);

    const { client } = await connectClient(repoRoot, executorId);
    try {
      await client.callTool({ name: "claim_task", arguments: {} });
      await client.callTool({
        name: "report_limit",
        arguments: { task_id: taskId, reason: "rate_limit" },
      });
    } finally {
      await client.close();
    }

    const conn = openDatabase(dbPath);
    try {
      const row = conn.raw
        .prepare("SELECT status, assigned_agent_id, worktree_path FROM tasks WHERE id = ?")
        .get(taskId) as {
        status: string;
        assigned_agent_id: string | null;
        worktree_path: string | null;
      };
      expect(row.status).toBe("in_progress");
      expect(row.assigned_agent_id).toBeNull();
      expect(row.worktree_path).toBeNull();
    } finally {
      conn.close();
    }
  }, 20_000);

  it("claim_task returns null when there is no compatible work for the role", async () => {
    const executorId = await registerAgent(repoRoot, dbPath, "executor");
    await createPlannableTask(repoRoot, dbPath);
    const { client } = await connectClient(repoRoot, executorId);
    try {
      const again = await client.callTool({ name: "claim_task", arguments: {} });
      const parsed = parseJson<null>(again);
      expect(parsed).toBeNull();
    } finally {
      await client.close();
    }
  });
});
