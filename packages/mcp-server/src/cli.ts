import { parseArgs } from "node:util";
import path from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Orchestrator, WorktreeManager, openDatabase } from "@deltapilot/core";
import { createMcpServer } from "./server.js";

interface CliArgs {
  repoRoot: string;
  agentId: string;
  dbPath: string;
}

function parseCliArgs(argv: string[]): CliArgs {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      "agent-id": { type: "string" },
      db: { type: "string" },
    },
    strict: true,
  });

  const repoRoot = values.repo ?? process.env.DP_REPO;
  const agentId = values["agent-id"] ?? process.env.DP_AGENT_ID;
  if (!repoRoot) {
    throw new Error("--repo <path> (or DP_REPO env) is required");
  }
  if (!agentId) {
    throw new Error("--agent-id <uuid> (or DP_AGENT_ID env) is required");
  }

  const dbPath = values.db ?? path.join(repoRoot, ".deltapilot-data.db");
  return { repoRoot, agentId, dbPath };
}

async function main(): Promise<void> {
  let cli: CliArgs;
  try {
    cli = parseCliArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`deltapilot-mcp: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const conn = openDatabase(cli.dbPath);
  const worktreeMgr = new WorktreeManager({
    repoRoot: cli.repoRoot,
    workspacesDir: path.join(cli.repoRoot, ".deltapilot", "workspaces"),
  });
  const orch = new Orchestrator({
    raw: conn.raw,
    db: conn.db,
    worktreeMgr,
    repoRoot: cli.repoRoot,
  });

  const server = createMcpServer(orch, { agentId: cli.agentId });
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    try {
      await transport.close();
    } finally {
      conn.close();
    }
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

  await server.connect(transport);
}

void main();
