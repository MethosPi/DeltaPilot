#!/usr/bin/env node
// Register a DeltaPilot agent in the local SQLite DB.
// Usage:
//   pnpm agent:register -- --name <name> --kind <kind> [--role <role>] [--repo <path>] [--transport <t>] [--runtime-mode <mode>] [--db <path>]
//   node scripts/register-agent.mjs --name <name> --kind <kind> [--role <role>] [--repo <path>] [--transport <t>] [--runtime-mode <mode>] [--db <path>]
//
// kind: claude-code | claude-sdk | openclaw | codex | opendevin | hermes | mock | other
// role: planner | executor | reviewer
// runtime-mode (default external): managed | external
// transport (default mcp-stdio): mcp-stdio | http
//
// Prints the generated agent UUID to stdout, one "KEY=VALUE" line per field.

import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRootDefault = path.resolve(__dirname, "..");
const USAGE = [
  "usage:",
  "  pnpm agent:register -- --name <name> --kind <kind> [--role <role>] [--repo <path>] [--transport <t>] [--runtime-mode <mode>] [--db <path>]",
  "  node scripts/register-agent.mjs --name <name> --kind <kind> [--role <role>] [--repo <path>] [--transport <t>] [--runtime-mode <mode>] [--db <path>]",
].join("\n");
const VALID_KINDS = ["claude-code", "claude-sdk", "openclaw", "codex", "opendevin", "hermes", "mock", "other"];
const VALID_ROLES = ["planner", "executor", "reviewer"];
const VALID_RUNTIME_MODES = ["managed", "external"];
const VALID_TRANSPORTS = ["mcp-stdio", "http"];

function normalizeArgv(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: normalizeArgv(argv),
    options: {
      name: { type: "string" },
      kind: { type: "string" },
      role: { type: "string", default: "executor" },
      repo: { type: "string", default: repoRootDefault },
      "runtime-mode": { type: "string", default: "external" },
      transport: { type: "string", default: "mcp-stdio" },
      db: { type: "string" },
    },
    strict: true,
  });

  if (!values.name || !values.kind) {
    throw new Error("--name <name> and --kind <kind> are required");
  }

  if (!VALID_KINDS.includes(values.kind)) {
    throw new Error(`kind must be one of: ${VALID_KINDS.join(", ")}`);
  }
  if (!VALID_ROLES.includes(values.role)) {
    throw new Error(`role must be one of: ${VALID_ROLES.join(", ")}`);
  }
  if (!VALID_RUNTIME_MODES.includes(values["runtime-mode"])) {
    throw new Error(`runtime-mode must be one of: ${VALID_RUNTIME_MODES.join(", ")}`);
  }
  if (!VALID_TRANSPORTS.includes(values.transport)) {
    throw new Error(`transport must be one of: ${VALID_TRANSPORTS.join(", ")}`);
  }

  const repoRoot = path.resolve(values.repo);
  const dbPath = values.db ? path.resolve(values.db) : path.join(repoRoot, ".deltapilot-data.db");

  return {
    name: values.name,
    kind: values.kind,
    role: values.role,
    repoRoot,
    runtimeMode: values["runtime-mode"],
    transport: values.transport,
    dbPath,
  };
}

async function main() {
  let cli;
  try {
    cli = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`register-agent: ${error.message}\n${USAGE}\n`);
    process.exit(2);
    return;
  }

  if (!existsSync(cli.dbPath)) {
    console.error(`database not found at ${cli.dbPath}. Start the dashboard or MCP server against --repo ${cli.repoRoot} first so migrations run.`);
    process.exit(1);
  }

  // better-sqlite3 isn't hoisted to root node_modules under pnpm; locate it
  // through any workspace package that depends on it (dashboard works).
  const require = createRequire(path.join(repoRootDefault, "apps/dashboard/package.json"));
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch (error) {
    console.error("failed to load better-sqlite3. Run `pnpm install` at the repo root first.");
    console.error(error);
    process.exit(1);
  }

  const db = new Database(cli.dbPath);
  try {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO agents
       (id, name, kind, role, runtime_mode, transport, enabled, command, endpoint,
        registered_at, last_seen_at, cooldown_until, last_limit_reason)
       VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, NULL, NULL, NULL)`,
    ).run(id, cli.name, cli.kind, cli.role, cli.runtimeMode, cli.transport, now);
    console.log(`AGENT_ID=${id}`);
    console.log(`NAME=${cli.name}`);
    console.log(`KIND=${cli.kind}`);
    console.log(`ROLE=${cli.role}`);
    console.log(`RUNTIME_MODE=${cli.runtimeMode}`);
    console.log(`TRANSPORT=${cli.transport}`);
    console.log(`REGISTERED_AT=${now}`);
  } finally {
    db.close();
  }
}

void main();
