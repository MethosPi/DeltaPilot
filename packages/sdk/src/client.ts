import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { AcceptanceCriteria, Handoff, ReviewDecision, Task } from "@deltapilot/shared";
import type { HandoffClient, HandoffReason } from "./interceptor.js";

export interface ConnectOptions {
  /**
   * Executable that speaks the deltapilot MCP stdio protocol. Typically
   * `process.execPath` with `args: [path.to("deltapilot-mcp/dist/cli.js"), ...]`,
   * or the `deltapilot-mcp` bin once installed.
   */
  command: string;
  args: string[];
  /** Optional env overrides forwarded to the subprocess. */
  env?: Record<string, string>;
  /** Client identity reported to the server during initialize. */
  clientName?: string;
  clientVersion?: string;
}

/**
 * Reference runtime an agent embeds to talk to DeltaPilot. Thin wrapper over
 * MCP stdio that (a) narrows the tool surface to the three calls an agent
 * actually makes (claim, submit, report) and (b) parses the JSON payloads
 * back into typed domain objects. Heartbeat / request_handoff will be added
 * when something in the agent loop calls them.
 */
export class DeltaPilotClient implements HandoffClient {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async connect(options: ConnectOptions): Promise<DeltaPilotClient> {
    const transport = new StdioClientTransport({
      command: options.command,
      args: options.args,
      env: options.env,
      stderr: "pipe",
    });
    const client = new Client({
      name: options.clientName ?? "deltapilot-sdk",
      version: options.clientVersion ?? "0.0.0",
    });
    await client.connect(transport);
    return new DeltaPilotClient(client, transport);
  }

  async claimTask(): Promise<Task | null> {
    const res = await this.client.callTool({ name: "claim_task", arguments: {} });
    return parseJson<Task | null>(res);
  }

  async createTask(input: {
    title: string;
    brief?: string;
    priority?: number;
    acceptance?: AcceptanceCriteria;
  }): Promise<Task> {
    const res = await this.client.callTool({ name: "create_task", arguments: input });
    return parseJson<Task>(res);
  }

  async publishPlan(taskId: string, plan: string): Promise<Task> {
    const res = await this.client.callTool({
      name: "publish_plan",
      arguments: { task_id: taskId, plan },
    });
    return parseJson<Task>(res);
  }

  async submitWork(taskId: string, commitSha?: string): Promise<Task> {
    const args: Record<string, string> = { task_id: taskId };
    if (commitSha !== undefined) args.commit_sha = commitSha;
    const res = await this.client.callTool({ name: "submit_work", arguments: args });
    return parseJson<Task>(res);
  }

  async submitReview(taskId: string, decision: ReviewDecision, note?: string): Promise<Task> {
    const res = await this.client.callTool({
      name: "submit_review",
      arguments: {
        task_id: taskId,
        decision,
        ...(note !== undefined ? { note } : {}),
      },
    });
    return parseJson<Task>(res);
  }

  async reportLimit(taskId: string, reason: HandoffReason): Promise<Handoff> {
    const res = await this.client.callTool({
      name: "report_limit",
      arguments: { task_id: taskId, reason },
    });
    return parseJson<Handoff>(res);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

function parseJson<T>(result: unknown): T {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  const first = content[0];
  if (!first || first.type !== "text") {
    throw new Error("expected text content in deltapilot tool result");
  }
  return JSON.parse(first.text) as T;
}
