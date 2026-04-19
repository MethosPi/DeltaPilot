import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Orchestrator } from "@deltapilot/core";

export interface CreateMcpServerOptions {
  /**
   * The calling agent's id. Bound once at spawn time (via CLI flag / env) so
   * tool schemas don't have to carry it on every request. One server process
   * serves exactly one agent — matches how MCP clients actually spawn servers.
   */
  agentId: string;
}

const heartbeatShape = { task_id: z.string().uuid() } as const;
const reportLimitShape = {
  task_id: z.string().uuid(),
  reason: z.enum(["rate_limit", "context_limit", "crash"]),
} as const;
const submitWorkShape = {
  task_id: z.string().uuid(),
  commit_sha: z.string().optional(),
} as const;
const requestHandoffShape = reportLimitShape;

export function createMcpServer(
  orch: Orchestrator,
  { agentId }: CreateMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: "deltapilot",
    version: "0.0.0",
  });

  server.registerTool(
    "claim_task",
    {
      description:
        "Atomically claim the next available task (todo or handoff_pending) for this agent. Returns null if the queue is empty.",
    },
    async () => {
      const task = await orch.claimNextTask(agentId);
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    },
  );

  server.registerTool(
    "heartbeat",
    {
      description:
        "Tell the orchestrator that this agent is still alive and making progress on a claimed task.",
      inputSchema: heartbeatShape,
    },
    async ({ task_id }) => {
      orch.heartbeat(task_id, agentId);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "report_limit",
    {
      description:
        "Signal that this agent has hit a rate or context limit. The orchestrator snapshots the worktree, removes it, and marks the task handoff_pending so another agent can resume.",
      inputSchema: reportLimitShape,
    },
    async ({ task_id, reason }) => {
      const handoff = await orch.reportLimit(task_id, agentId, reason);
      return { content: [{ type: "text", text: JSON.stringify(handoff) }] };
    },
  );

  server.registerTool(
    "request_handoff",
    {
      description:
        "Explicit, non-rate-limit handoff request (e.g. the agent decides the task is out of scope). Same effect as report_limit.",
      inputSchema: requestHandoffShape,
    },
    async ({ task_id, reason }) => {
      const handoff = await orch.reportLimit(task_id, agentId, reason);
      return { content: [{ type: "text", text: JSON.stringify(handoff) }] };
    },
  );

  server.registerTool(
    "submit_work",
    {
      description:
        "Mark the task as ready for review. The orchestrator moves it to the Review column.",
      inputSchema: submitWorkShape,
    },
    async ({ task_id, commit_sha }) => {
      const task = await orch.submitWork(task_id, agentId, commit_sha);
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    },
  );

  return server;
}
