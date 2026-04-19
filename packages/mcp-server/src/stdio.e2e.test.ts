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

async function seedAgentAndReadyTask(
  repoRoot: string,
  dbPath: string,
): Promise<{ agentId: string; taskId: string }> {
  const conn = openDatabase(dbPath);
  try {
    const worktreeMgr = new WorktreeManager({
      repoRoot,
      workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
    });
    const orch = new Orchestrator({
      raw: conn.raw,
      db: conn.db,
      worktreeMgr,
      repoRoot,
    });
    const agent = await orch.registerAgent({
      name: "test-agent",
      kind: "mock",
      transport: "mcp-stdio",
    });
    const task = await orch.createTask({ title: "stdio round-trip" });
    orch.applyEvent(task.id, { kind: "ready" });
    return { agentId: agent.id, taskId: task.id };
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

describe("deltapilot-mcp stdio CLI — e2e", () => {
  let repoRoot: string;
  let dbPath: string;
  let agentId: string;
  let taskId: string;
  let client: Client;
  let transport: StdioClientTransport;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    dbPath = path.join(repoRoot, ".deltapilot-data.db");
    ({ agentId, taskId } = await seedAgentAndReadyTask(repoRoot, dbPath));

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [CLI_PATH, "--repo", repoRoot, "--agent-id", agentId],
      stderr: "pipe",
    });
    client = new Client({ name: "test-client", version: "0.0.0" });
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close();
    await rm(repoRoot, { recursive: true, force: true });
  });

  it("advertises all 5 orchestrator tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "claim_task",
      "heartbeat",
      "report_limit",
      "request_handoff",
      "submit_work",
    ]);
  });

  it(
    "claim_task → heartbeat → submit_work drives the task to review without agent_id in any call",
    async () => {
      const claimResult = await client.callTool({ name: "claim_task", arguments: {} });
      const claimed = parseJson<{
        id: string;
        status: string;
        assigned_agent_id: string;
      } | null>(claimResult);
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(taskId);
      expect(claimed!.status).toBe("in_progress");
      expect(claimed!.assigned_agent_id).toBe(agentId);

      await client.callTool({
        name: "heartbeat",
        arguments: { task_id: taskId },
      });

      const submitResult = await client.callTool({
        name: "submit_work",
        arguments: { task_id: taskId },
      });
      const submitted = parseJson<{ id: string; status: string }>(submitResult);
      expect(submitted.status).toBe("review");

      // Verify state persisted to the shared DB.
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
    },
    20_000,
  );

  it(
    "report_limit moves the claimed task to handoff_pending and removes the worktree",
    async () => {
      await client.callTool({ name: "claim_task", arguments: {} });
      await client.callTool({
        name: "report_limit",
        arguments: { task_id: taskId, reason: "rate_limit" },
      });

      await client.close();
      const conn = openDatabase(dbPath);
      try {
        const row = conn.raw
          .prepare(
            "SELECT status, assigned_agent_id, worktree_path FROM tasks WHERE id = ?",
          )
          .get(taskId) as {
          status: string;
          assigned_agent_id: string | null;
          worktree_path: string | null;
        };
        expect(row.status).toBe("handoff_pending");
        expect(row.assigned_agent_id).toBeNull();
        expect(row.worktree_path).toBeNull();
      } finally {
        conn.close();
      }
    },
    20_000,
  );

  it("claim_task returns null when the queue is empty", async () => {
    // Drain the seeded task first.
    await client.callTool({ name: "claim_task", arguments: {} });
    const again = await client.callTool({ name: "claim_task", arguments: {} });
    const parsed = parseJson<null>(again);
    expect(parsed).toBeNull();
  });
});
