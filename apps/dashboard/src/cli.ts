import path from "node:path";
import { parseArgs } from "node:util";
import { startDashboardServer } from "./server.js";

interface CliOptions {
  repoRoot: string;
  dbPath: string;
  host: string;
  port: number;
  auth?: {
    username: string;
    password: string;
  };
}

function normalizeArgv(argv: string[]): string[] {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function parsePort(raw: string | undefined): number {
  if (!raw) return 3000;
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid --port value: ${raw}`);
  }
  return port;
}

function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: normalizeArgv(argv),
    options: {
      repo: { type: "string" },
      db: { type: "string" },
      host: { type: "string" },
      port: { type: "string" },
      username: { type: "string" },
      password: { type: "string" },
    },
    strict: true,
  });

  const repoRoot = values.repo ?? process.env.DP_REPO;
  if (!repoRoot) {
    throw new Error("--repo <path> (or DP_REPO env) is required");
  }

  const username = values.username ?? process.env.DP_DASHBOARD_USERNAME;
  const password = values.password ?? process.env.DP_DASHBOARD_PASSWORD;
  if ((username && !password) || (!username && password)) {
    throw new Error("dashboard auth requires both --username and --password (or matching env vars)");
  }

  return {
    repoRoot,
    dbPath: values.db ?? process.env.DP_DB ?? path.join(repoRoot, ".deltapilot-data.db"),
    host: values.host ?? process.env.DP_DASHBOARD_HOST ?? "0.0.0.0",
    port: parsePort(values.port ?? process.env.DP_DASHBOARD_PORT),
    ...(username && password ? { auth: { username, password } } : {}),
  };
}

async function main(): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`deltapilot-dashboard: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }

  const started = await startDashboardServer(cli);
  process.stdout.write(
    `DeltaPilot dashboard listening on ${started.origin} for repo ${cli.repoRoot}\n`,
  );
  if (cli.auth) {
    process.stdout.write("Dashboard basic auth is enabled.\n");
  }

  const shutdown = async (): Promise<void> => {
    await started.close();
  };

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

void main();
