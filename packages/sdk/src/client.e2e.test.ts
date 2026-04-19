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
    const agent = await orch.registerAgent({
      name: "sdk-agent",
      kind: "mock",
      transport: "mcp-stdio",
    });
    const task = await orch.createTask({ title: "sdk e2e" });
    orch.applyEvent(task.id, { kind: "ready" });
    return { agentId: agent.id, taskId: task.id };
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
    "claimTask → submitWork drives the task to review",
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
    "withAutoHandoff wires a synthetic 429 into a real handoff_pending on the orchestrator",
    async () => {
      await client.claimTask();

      // Note: the throw happens before any commit, so worktree snapshot/artifact
      // capture on handoff is NOT exercised here — orchestrator-layer tests
      // cover that. This test only proves the SDK → MCP → reportLimit wire.
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
        expect(row.status).toBe("handoff_pending");
        expect(row.assigned_agent_id).toBeNull();
        expect(row.worktree_path).toBeNull();
      } finally {
        conn.close();
      }
    },
    20_000,
  );

  it(
    "second SDK-driven agent claims the handoff_pending task and drives it to review",
    async () => {
      // Agent A hits the limit and hands off via the SDK.
      await client.claimTask();
      const fake429 = Object.assign(new Error("429"), { status: 429 });
      await expect(
        withAutoHandoff(async () => { throw fake429; }, {
          client,
          taskId,
          isLimit: (e) => ((e as { status?: number }).status === 429 ? "rate_limit" : null),
        }),
      ).rejects.toBe(fake429);
      await client.close();

      // Register agent B directly on the shared DB.
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
          transport: "mcp-stdio",
        });
        agentBId = agentB.id;
      } finally {
        conn.close();
      }

      // Agent B connects via the SDK, claims the handoff_pending task, submits.
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
