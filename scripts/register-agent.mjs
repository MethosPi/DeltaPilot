#!/usr/bin/env node
// Register a DeltaPilot agent in the local SQLite DB.
// Usage:
//   node scripts/register-agent.mjs --name <name> --kind <kind> [--repo <path>] [--transport <t>]
//
// kind: claude-code | codex | opendevin | hermes | mock | other
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
    repo: { type: "string", default: repoRootDefault },
    transport: { type: "string", default: "mcp-stdio" },
    db: { type: "string" },
  },
  strict: true,
});

if (!values.name || !values.kind) {
  console.error("usage: register-agent.mjs --name <name> --kind <kind> [--repo <path>] [--transport <t>] [--db <path>]");
  process.exit(2);
}

const VALID_KINDS = ["claude-code", "codex", "opendevin", "hermes", "mock", "other"];
const VALID_TRANSPORTS = ["mcp-stdio", "http"];

if (!VALID_KINDS.includes(values.kind)) {
  console.error(`kind must be one of: ${VALID_KINDS.join(", ")}`);
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
    "INSERT INTO agents (id, name, kind, transport, command, endpoint, registered_at, last_seen_at) VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)",
  ).run(id, values.name, values.kind, values.transport, now);
  console.log(`AGENT_ID=${id}`);
  console.log(`NAME=${values.name}`);
  console.log(`KIND=${values.kind}`);
  console.log(`TRANSPORT=${values.transport}`);
  console.log(`REGISTERED_AT=${now}`);
} finally {
  db.close();
}
