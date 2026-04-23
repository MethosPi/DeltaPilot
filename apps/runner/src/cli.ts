#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { Runner } from "./runner.js";

interface CliOptions {
  repoRoot: string;
  dbPath: string;
  pollIntervalMs: number;
}

function parseCli(argv: string[]): CliOptions {
  const { values } = parseArgs({
    args: argv[0] === "--" ? argv.slice(1) : argv,
    options: {
      repo: { type: "string" },
      db: { type: "string" },
      "poll-ms": { type: "string" },
    },
    strict: true,
  });

  const repoRoot = values.repo ?? process.env.DP_REPO;
  if (!repoRoot) {
    throw new Error("--repo <path> (or DP_REPO env) is required");
  }

  const pollIntervalMs = values["poll-ms"] ? Number.parseInt(values["poll-ms"], 10) : 1000;
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 100) {
    throw new Error("--poll-ms must be an integer >= 100");
  }

  return {
    repoRoot,
    dbPath: values.db ?? process.env.DP_DB ?? path.join(repoRoot, ".deltapilot-data.db"),
    pollIntervalMs,
  };
}

async function main(): Promise<void> {
  let cli: CliOptions;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`deltapilot-runner: ${(error as Error).message}\n`);
    process.exit(2);
    return;
  }

  const runner = new Runner(cli);
  await runner.start();
  process.stdout.write(
    `DeltaPilot runner started for repo ${cli.repoRoot} (poll ${cli.pollIntervalMs}ms)\n`,
  );

  const shutdown = async (): Promise<void> => {
    await runner.stop();
  };

  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
}

void main();
