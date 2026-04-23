import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execa } from "execa";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, WorktreeManager, openDatabase } from "@deltapilot/core";
import { DeltaPilotClient, withAutoHandoff } from "./index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(__dirname, "../../mcp-server/dist/cli.js");

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-sdk-e2e-"));
  await execa("git", ["init", "-b", "main"], { cwd: dir });
  await execa("git", ["config", "user.email", "orch@deltapilot.local"], { cwd: dir });
  await execa("git", ["config", "user.name", "DeltaPilot"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# project\n");
  await execa("git", ["add", "."], { cwd: dir });
  await execa("git", ["commit", "-m", "seed"], { cwd: dir });
  return dir;
}

async function seed(
  repoRoot: string,
  dbPath: string,
): Promise<{ agentId: string; taskId: string }> {
  const conn = openDatabase(dbPath);
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
      name: "sdk-agent",
      kind: "mock",
      role: "executor",
      runtimeMode: "external",
      transport: "mcp-stdio",
    });
    const task = await orch.createTask({ title: "sdk e2e" });
    const planned = await orch.claimNextTask(planner.id);
    expect(planned?.status).toBe("planning");
    await orch.publishPlan(task.id, planner.id, "Ship the change");
    return { agentId: executor.id, taskId: task.id };
  } finally {
    conn.close();
  }
}

describe("DeltaPilotClient — subprocess e2e", () => {
  let repoRoot: string;
  let dbPath: string;
  let agentId: string;
  let taskId: string;
  let client: DeltaPilotClient;

  beforeEach(async () => {
    repoRoot = await makeRepo();
    dbPath = path.join(repoRoot, ".deltapilot-data.db");
    ({ agentId, taskId } = await seed(repoRoot, dbPath));
    client = await DeltaPilotClient.connect({
      command: process.execPath,
      args: [CLI_PATH, "--repo", repoRoot, "--agent-id", agentId],
    });
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await rm(repoRoot, { recursive: true, force: true });
  });

  it(
    "claimTask -> submitWork drives the executor phase to review",
    async () => {
      const claimed = await client.claimTask();
      expect(claimed?.id).toBe(taskId);
      expect(claimed?.status).toBe("in_progress");

      const submitted = await client.submitWork(taskId);
      expect(submitted.status).toBe("review");
    },
    20_000,
  );

  it(
    "publishCheckpoint, reportUsage, and requestApproval work against the MCP server",
    async () => {
      const claimed = await client.claimTask();
      expect(claimed?.id).toBe(taskId);

      const checkpoint = await client.publishCheckpoint(taskId, {
        summary: "Checkpoint from SDK",
        files_touched: ["README.md"],
        tests_ran: [],
        commands_ran: [],
        next_steps: ["Continue implementation"],
        risks: [],
      });
      expect(checkpoint.checkpoint_artifact_id).toBeTruthy();

      const usage = await client.reportUsage(taskId, {
        provider: "openai",
        model: "gpt-5.4",
        promptTokens: 250,
        completionTokens: 125,
        estimatedCostUsd: 0.11,
        latencyMs: 1200,
      });
      expect(usage.prompt_tokens).toBe(250);

      const approval = await client.requestApproval({
        taskId,
        title: "Need approval",
        body: "Confirm the next fallback step.",
      });
      expect(approval.task_id).toBe(taskId);
      expect(approval.status).toBe("pending");
    },
    20_000,
  );

  it(
    "withAutoHandoff wires a synthetic 429 into a real requeue on the orchestrator",
    async () => {
      await client.claimTask();

      const fake429 = Object.assign(new Error("rate_limit_exceeded"), { status: 429 });
      await expect(
        withAutoHandoff(
          async () => {
            throw fake429;
          },
          {
            client,
            taskId,
            isLimit: (e) => ((e as { status?: number }).status === 429 ? "rate_limit" : null),
          },
        ),
      ).rejects.toBe(fake429);

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
        expect(row.status).toBe("in_progress");
        expect(row.assigned_agent_id).toBeNull();
        expect(row.worktree_path).toBeNull();
      } finally {
        conn.close();
      }
    },
    20_000,
  );

  it(
    "second SDK-driven executor claims the requeued task and drives it to review",
    async () => {
      await client.claimTask();
      const fake429 = Object.assign(new Error("429"), { status: 429 });
      await expect(
        withAutoHandoff(async () => {
          throw fake429;
        }, {
          client,
          taskId,
          isLimit: (e) => ((e as { status?: number }).status === 429 ? "rate_limit" : null),
        }),
      ).rejects.toBe(fake429);
      await client.close();

      const conn = openDatabase(dbPath);
      let agentBId: string;
      try {
        const worktreeMgr = new WorktreeManager({
          repoRoot,
          workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
        });
        const orch = new Orchestrator({ raw: conn.raw, db: conn.db, worktreeMgr, repoRoot });
        const agentB = await orch.registerAgent({
          name: "sdk-agent-b",
          kind: "mock",
          role: "executor",
          runtimeMode: "external",
          transport: "mcp-stdio",
        });
        agentBId = agentB.id;
      } finally {
        conn.close();
      }

      const clientB = await DeltaPilotClient.connect({
        command: process.execPath,
        args: [CLI_PATH, "--repo", repoRoot, "--agent-id", agentBId],
      });
      try {
        const claimed = await clientB.claimTask();
        expect(claimed?.id).toBe(taskId);
        expect(claimed?.status).toBe("in_progress");
        expect(claimed?.assigned_agent_id).toBe(agentBId);

        const submitted = await clientB.submitWork(taskId);
        expect(submitted.status).toBe("review");
      } finally {
        await clientB.close();
      }
    },
    30_000,
  );
});
