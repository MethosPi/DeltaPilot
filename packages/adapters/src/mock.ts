import { execa } from "execa";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentAdapter, Orchestrator } from "@deltapilot/core";
import type { Task } from "@deltapilot/shared";

export type MockStep =
  | { kind: "commit"; file: string; content: string; message: string }
  | { kind: "scratchpad"; content: string }
  | { kind: "next_steps"; content: string }
  | { kind: "heartbeat" }
  | { kind: "limit"; reason: "rate_limit" | "context_limit" | "crash" }
  | { kind: "submit" };

/**
 * Scripted in-process agent for driving handoff scenarios in tests. Not meant
 * for production — real agents are spawned subprocesses (Phase 2).
 */
export class MockAgent implements AgentAdapter {
  constructor(
    readonly agentId: string,
    private readonly orch: Orchestrator,
  ) {}

  async start(): Promise<void> {
    /* no-op */
  }

  async stop(): Promise<void> {
    /* no-op */
  }

  /**
   * Drives one task through a scripted sequence. Each step corresponds to one
   * cooperative call a real agent would make (commit, note, heartbeat, report_limit,
   * submit). Returns the final task state after the script finishes (or short-circuits
   * on limit/submit).
   */
  async workOn(task: Task, steps: ReadonlyArray<MockStep>): Promise<Task> {
    const worktreePath = task.worktree_path;
    if (!worktreePath) {
      throw new Error(`MockAgent ${this.agentId}: task ${task.id} has no worktree`);
    }

    let current = task;
    for (const step of steps) {
      switch (step.kind) {
        case "commit": {
          await writeFile(path.join(worktreePath, step.file), step.content, "utf8");
          await execa("git", ["add", "--", step.file], { cwd: worktreePath });
          await execa(
            "git",
            [
              "-c",
              `user.name=${this.agentId}`,
              "-c",
              `user.email=${this.agentId}@deltapilot.local`,
              "commit",
              "-m",
              step.message,
            ],
            { cwd: worktreePath },
          );
          break;
        }
        case "scratchpad": {
          await this.orch.writeArtifact(task.id, "scratchpad", step.content, this.agentId);
          break;
        }
        case "next_steps": {
          await this.orch.writeArtifact(task.id, "next_steps", step.content, this.agentId);
          break;
        }
        case "heartbeat": {
          this.orch.heartbeat(task.id, this.agentId);
          break;
        }
        case "limit": {
          await this.orch.reportLimit(task.id, this.agentId, step.reason);
          return this.orch.getTask(task.id);
        }
        case "submit": {
          current = await this.orch.submitWork(task.id, this.agentId);
          return current;
        }
      }
    }

    return this.orch.getTask(task.id);
  }
}
