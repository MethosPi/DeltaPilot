import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Orchestrator } from "@deltapilot/core";

export interface CreateMcpServerOptions {
  agentId: string;
}

const heartbeatShape = { task_id: z.string().uuid() } as const;
const reportLimitShape = {
  task_id: z.string().uuid(),
  reason: z.enum(["rate_limit", "context_limit", "budget_exceeded", "crash"]),
} as const;
const requestHandoffShape = {
  task_id: z.string().uuid(),
  reason: z.enum(["rate_limit", "context_limit", "budget_exceeded", "crash", "user"]),
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
const publishCheckpointShape = {
  task_id: z.string().uuid(),
  summary: z.string().min(1),
  files_touched: z.array(z.string().min(1)).optional(),
  tests_ran: z.array(z.string().min(1)).optional(),
  commands_ran: z.array(z.string().min(1)).optional(),
  next_steps: z.array(z.string().min(1)).optional(),
  risks: z.array(z.string().min(1)).optional(),
} as const;
const reportUsageShape = {
  task_id: z.string().uuid(),
  provider: z.enum(["openai", "anthropic", "openclaw", "ollama", "generic"]).optional(),
  model: z.string().optional(),
  prompt_tokens: z.number().int().min(0).optional(),
  completion_tokens: z.number().int().min(0).optional(),
  estimated_cost_usd: z.number().min(0).optional(),
  latency_ms: z.number().int().min(0).optional(),
} as const;
const requestApprovalShape = {
  task_id: z.string().uuid().optional(),
  kind: z.enum(["approval", "question"]).optional(),
  title: z.string().min(1),
  body: z.string().min(1),
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
    "publish_checkpoint",
    {
      description:
        "Attach a structured checkpoint to the current task attempt so a fallback worker can resume from a compact summary instead of a full transcript.",
      inputSchema: publishCheckpointShape,
    },
    async ({ task_id, summary, files_touched, tests_ran, commands_ran, next_steps, risks }) => {
      const attempt = await orch.publishCheckpoint(task_id, agentId, {
        summary,
        files_touched: files_touched ?? [],
        tests_ran: tests_ran ?? [],
        commands_ran: commands_ran ?? [],
        next_steps: next_steps ?? [],
        risks: risks ?? [],
      });
      return { content: [{ type: "text", text: JSON.stringify(attempt) }] };
    },
  );

  server.registerTool(
    "report_usage",
    {
      description:
        "Report token, latency, cost, provider, or model metadata for the currently active task attempt.",
      inputSchema: reportUsageShape,
    },
    async ({ task_id, provider, model, prompt_tokens, completion_tokens, estimated_cost_usd, latency_ms }) => {
      const attempt = orch.reportTaskUsage(task_id, agentId, {
        ...(provider !== undefined ? { provider } : {}),
        ...(model !== undefined ? { model } : {}),
        ...(prompt_tokens !== undefined ? { promptTokens: prompt_tokens } : {}),
        ...(completion_tokens !== undefined ? { completionTokens: completion_tokens } : {}),
        ...(estimated_cost_usd !== undefined ? { estimatedCostUsd: estimated_cost_usd } : {}),
        ...(latency_ms !== undefined ? { latencyMs: latency_ms } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(attempt) }] };
    },
  );

  server.registerTool(
    "request_approval",
    {
      description:
        "Ask for human approval or a human answer from the dashboard inbox, even for external MCP-driven agents.",
      inputSchema: requestApprovalShape,
    },
    async ({ task_id, kind, title, body }) => {
      const approval = await orch.requestAgentApproval({
        agentId,
        ...(task_id !== undefined ? { taskId: task_id } : {}),
        kind: kind ?? "approval",
        title,
        body,
      });
      return { content: [{ type: "text", text: JSON.stringify(approval) }] };
    },
  );

  server.registerTool(
    "claim_task",
    {
      description:
        "Claim the next task compatible with this agent's registered role. Planner claims todo/planning, executor claims in_progress, reviewer claims review, merger claims merging.",
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
        "Reviewer-only tool. Bounce returns the task to To Do or escalates to Human Review after repeated failures. Approve is reserved for the managed runner flow because it must publish a PR before entering Human Review.",
      inputSchema: submitReviewShape,
    },
    async ({ task_id, decision, note }) => {
      if (decision === "approve") {
        throw new Error("submit_review approve is not supported over MCP in v1; use the managed reviewer flow.");
      }
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
