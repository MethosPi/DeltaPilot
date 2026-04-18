import type { Task } from "@deltapilot/shared";

/**
 * Contract implemented by every agent integration (MockAgent, Claude Code, Codex, HTTP shim).
 *
 * The orchestrator does NOT push work to adapters. Adapters pull via `claimNextTask`,
 * then drive their own work loop while calling back through the other orchestrator
 * methods (heartbeat, reportLimit, submitWork). This mirrors how a real terminal
 * agent cooperates with an external orchestrator over MCP.
 */
export interface AgentAdapter {
  readonly agentId: string;

  /**
   * Start the adapter. For an in-process adapter this might begin a poll loop; for
   * a subprocess adapter this spawns the agent CLI.
   */
  start(): Promise<void>;

  /**
   * Stop the adapter cleanly. Orchestrator shutdown calls this.
   */
  stop(): Promise<void>;
}

export interface AgentRunContext {
  task: Task;
  worktreePath: string;
}
