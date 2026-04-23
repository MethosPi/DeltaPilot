#!/usr/bin/env node
// Register a DeltaPilot agent in the local SQLite DB.
// Usage:
//   node scripts/register-agent.mjs --name <name> --kind <kind> --role <role> [--repo <path>] [--transport <t>] [--runtime-mode <mode>]
//
// kind: claude-code | claude-sdk | openclaw | codex | opendevin | hermes | mock | other
// role: planner | executor | reviewer | merger
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

const { values } = parseArgs({
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
  console.error("usage: register-agent.mjs --name <name> --kind <kind> --role <role> [--repo <path>] [--transport <t>] [--runtime-mode <mode>] [--db <path>]");
  process.exit(2);
}

const VALID_KINDS = ["claude-code", "claude-sdk", "openclaw", "codex", "opendevin", "hermes", "mock", "other"];
const VALID_ROLES = ["planner", "executor", "reviewer", "merger"];
const VALID_RUNTIME_MODES = ["managed", "external"];
const VALID_TRANSPORTS = ["mcp-stdio", "http"];

if (!VALID_KINDS.includes(values.kind)) {
  console.error(`kind must be one of: ${VALID_KINDS.join(", ")}`);
  process.exit(2);
}
if (!VALID_ROLES.includes(values.role)) {
  console.error(`role must be one of: ${VALID_ROLES.join(", ")}`);
  process.exit(2);
}
if (!VALID_RUNTIME_MODES.includes(values["runtime-mode"])) {
  console.error(`runtime-mode must be one of: ${VALID_RUNTIME_MODES.join(", ")}`);
  process.exit(2);
}
if (!VALID_TRANSPORTS.includes(values.transport)) {
  console.error(`transport must be one of: ${VALID_TRANSPORTS.join(", ")}`);
  process.exit(2);
}

const repoRoot = path.resolve(values.repo);
const dbPath = values.db ? path.resolve(values.db) : path.join(repoRoot, ".deltapilot-data.db");

if (!existsSync(dbPath)) {
  console.error(`database not found at ${dbPath}. Start the dashboard or MCP server against --repo ${repoRoot} first so migrations run.`);
  process.exit(1);
}

// better-sqlite3 isn't hoisted to root node_modules under pnpm; locate it
// through any workspace package that depends on it (dashboard works).
const require = createRequire(path.join(repoRoot, "apps/dashboard/package.json"));
let Database;
try {
  Database = require("better-sqlite3");
} catch (error) {
  console.error("failed to load better-sqlite3. Run `pnpm install` at the repo root first.");
  console.error(error);
  process.exit(1);
}

const db = new Database(dbPath);
try {
  const id = randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agents
     (id, name, kind, role, runtime_mode, transport, enabled, command, endpoint,
      registered_at, last_seen_at, cooldown_until, last_limit_reason)
     VALUES (?, ?, ?, ?, ?, ?, 1, NULL, NULL, ?, NULL, NULL, NULL)`,
  ).run(id, values.name, values.kind, values.role, values["runtime-mode"], values.transport, now);
  console.log(`AGENT_ID=${id}`);
  console.log(`NAME=${values.name}`);
  console.log(`KIND=${values.kind}`);
  console.log(`ROLE=${values.role}`);
  console.log(`RUNTIME_MODE=${values["runtime-mode"]}`);
  console.log(`TRANSPORT=${values.transport}`);
  console.log(`REGISTERED_AT=${now}`);
} finally {
  db.close();
}
