import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Orchestrator } from "@deltapilot/core";

export interface CreateMcpServerOptions {
  agentId: string;
}

const heartbeatShape = { task_id: z.string().uuid() } as const;
const reportLimitShape = {
  task_id: z.string().uuid(),
  reason: z.enum(["rate_limit", "context_limit", "crash"]),
} as const;
const requestHandoffShape = {
  task_id: z.string().uuid(),
  reason: z.enum(["rate_limit", "context_limit", "crash", "user"]),
} as const;
const submitWorkShape = {
  task_id: z.string().uuid(),
  commit_sha: z.string().optional(),
} as const;
const publishPlanShape = {
  task_id: z.string().uuid(),
  plan: z.string().min(1),
} as const;
const submitReviewShape = {
  task_id: z.string().uuid(),
  decision: z.enum(["approve", "bounce"]),
  note: z.string().optional(),
} as const;
const createTaskShape = {
  title: z.string().min(1),
  brief: z.string().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  acceptance: z
    .object({
      goal: z.string().min(1),
      deliverables: z.array(z.string().min(1)).min(1),
      files_in_scope: z.array(z.string()),
      success_test: z.string().min(1),
    })
    .optional(),
} as const;

export function createMcpServer(
  orch: Orchestrator,
  { agentId }: CreateMcpServerOptions,
): McpServer {
  const server = new McpServer({
    name: "deltapilot",
    version: "0.0.0",
  });

  server.registerTool(
    "create_task",
    {
      description: "Create a new task directly in the planner queue (To Do).",
      inputSchema: createTaskShape,
    },
    async ({ title, brief, priority, acceptance }) => {
      const task = await orch.createTask({
        title,
        ...(brief !== undefined ? { brief } : {}),
        ...(priority !== undefined ? { priority } : {}),
        ...(acceptance !== undefined ? { acceptance } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    },
  );

  server.registerTool(
    "claim_task",
    {
      description:
        "Claim the next task compatible with this agent's registered role. Planner claims todo/planning, executor claims in_progress, reviewer claims review.",
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
    "publish_plan",
    {
      description:
        "Planner-only tool. Publishes an execution plan artifact and releases the task into In Progress for an executor.",
      inputSchema: publishPlanShape,
    },
    async ({ task_id, plan }) => {
      const task = await orch.publishPlan(task_id, agentId, plan);
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    },
  );

  server.registerTool(
    "submit_work",
    {
      description:
        "Executor-only tool. Marks execution complete and releases the task into Review. Kept for backward compatibility.",
      inputSchema: submitWorkShape,
    },
    async ({ task_id, commit_sha }) => {
      const task = await orch.submitWork(task_id, agentId, commit_sha);
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    },
  );

  server.registerTool(
    "submit_review",
    {
      description:
        "Reviewer-only tool. Approve sends the task to Done; bounce returns it to To Do or escalates to Human Review after repeated failures.",
      inputSchema: submitReviewShape,
    },
    async ({ task_id, decision, note }) => {
      const task = await orch.submitReview(task_id, agentId, { decision, ...(note !== undefined ? { note } : {}) });
      return { content: [{ type: "text", text: JSON.stringify(task) }] };
    },
  );

  server.registerTool(
    "report_limit",
    {
      description:
        "Signal that this agent has hit a rate or context limit. The orchestrator snapshots the worktree, removes it, and requeues the task in the same logical phase.",
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
        "Explicit, non-rate-limit handoff request (for example the agent decides a human or another worker should continue).",
      inputSchema: requestHandoffShape,
    },
    async ({ task_id, reason }) => {
      const handoff = await orch.reportLimit(task_id, agentId, reason);
      return { content: [{ type: "text", text: JSON.stringify(handoff) }] };
    },
  );

  return server;
}
