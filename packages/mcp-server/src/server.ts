import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Orchestrator } from "@deltapilot/core";

/**
 * Tool schemas — mirror the zod shapes so we can validate MCP calls
 * before they reach the orchestrator. Kept separate from the orchestrator
 * API so transport-specific concerns stay out of the core model.
 */
const claimNextTaskShape = { agent_id: z.string().uuid() } as const;
const heartbeatShape = {
  task_id: z.string().uuid(),
  agent_id: z.string().uuid(),
} as const;
const reportLimitShape = {
  task_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  reason: z.enum(["rate_limit", "context_limit", "crash"]),
} as const;
const submitWorkShape = {
  task_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  commit_sha: z.string().optional(),
} as const;
const requestHandoffShape = reportLimitShape;

/**
 * Build an MCP server that exposes the orchestrator's 5 core tools. The returned
 * server can be wired to any transport (stdio, HTTP) by the caller.
 *
 * Stdio wire-up lives in apps/cli (Phase 3) so this package stays transport-agnostic.
 */
export function createMcpServer(orch: Orchestrator): McpServer {
  const server = new McpServer({
    name: "deltapilot",
    version: "0.0.0",
  });

  server.registerTool(
    "claim_task",
    {
      description:
        "Atomically claim the next available task (todo or handoff_pending) for the calling agent. Returns null if no task is available.",
      inputSchema: claimNextTaskShape,
    },
    async ({ agent_id }) => {
      const task = await orch.claimNextTask(agent_id);
      return {
        content: [{ type: "text", text: JSON.stringify(task) }],
      };
    },
  );

  server.registerTool(
    "heartbeat",
    {
      description:
        "Tell the orchestrator that the agent is still alive and making progress on a claimed task.",
      inputSchema: heartbeatShape,
    },
    async ({ task_id, agent_id }) => {
      orch.heartbeat(task_id, agent_id);
      return { content: [{ type: "text", text: "ok" }] };
    },
  );

  server.registerTool(
    "report_limit",
    {
      description:
        "Signal that the agent has hit a rate or context limit. The orchestrator snapshots the worktree, removes it, and marks the task handoff_pending so another agent can resume.",
      inputSchema: reportLimitShape,
    },
    async ({ task_id, agent_id, reason }) => {
      const handoff = await orch.reportLimit(task_id, agent_id, reason);
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
    async ({ task_id, agent_id, reason }) => {
      const handoff = await orch.reportLimit(task_id, agent_id, reason);
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
    async ({ task_id, agent_id, commit_sha }) => {
      const task = await orch.submitWork(task_id, agent_id, commit_sha);
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    },
  );

  return server;
}
