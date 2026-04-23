import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const migrationsDir = path.join(repoRoot, "packages/core/src/db/migrations");
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const require = createRequire(path.join(repoRoot, "apps/dashboard/package.json"));
const Database = require("better-sqlite3");
const MIGRATIONS = [
  "0000_init.sql",
  "0001_autonomous_pipeline.sql",
  "0002_task_attachments.sql",
  "0003_task_archiving.sql",
];

async function makeTargetRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "deltapilot-register-agent-"));
  await run("git", ["init", "-b", "main"], { cwd: dir });
  await run("git", ["config", "user.email", "register@test"], { cwd: dir });
  await run("git", ["config", "user.name", "Register Agent Test"], { cwd: dir });
  await writeFile(path.join(dir, "README.md"), "# register-agent test\n", "utf8");
  await run("git", ["add", "."], { cwd: dir });
  await run("git", ["commit", "-m", "seed"], { cwd: dir });

  const dbPath = path.join(dir, ".deltapilot-data.db");
  const db = new Database(dbPath);
  try {
    applyMigrations(db);
  } finally {
    db.close();
  }
  return { dir, dbPath };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _deltapilot_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const insertApplied = db.prepare(
    "INSERT INTO _deltapilot_migrations (version, applied_at) VALUES (?, ?)",
  );

  for (const [index, file] of MIGRATIONS.entries()) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf8");
    const txn = db.transaction(() => {
      db.exec(sql);
      insertApplied.run(index + 1, new Date().toISOString());
    });
    txn();
  }
}

function assertExit(result, expectedStatus) {
  assert.equal(
    result.status,
    expectedStatus,
    `expected exit ${expectedStatus}, got ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

test("documented pnpm passthrough form registers an agent from the repo root", async () => {
  const target = await makeTargetRepo();
  try {
    const result = run(
      pnpmBin,
      [
        "agent:register",
        "--",
        "--name",
        "root-flow-agent",
        "--kind",
        "mock",
        "--repo",
        target.dir,
      ],
      { cwd: repoRoot },
    );

    assertExit(result, 0);
    assert.match(result.stdout, /^AGENT_ID=.+$/m);
    assert.match(result.stdout, /^NAME=root-flow-agent$/m);
    assert.match(result.stdout, /^KIND=mock$/m);
    assert.match(result.stdout, /^ROLE=executor$/m);
    assert.doesNotMatch(result.stderr, /ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL/);

    const db = new Database(target.dbPath, { readonly: true });
    try {
      const row = db
        .prepare("SELECT name, kind, role, runtime_mode, transport FROM agents WHERE name = ?")
        .get("root-flow-agent");
      assert.deepEqual(row, {
        name: "root-flow-agent",
        kind: "mock",
        role: "executor",
        runtime_mode: "external",
        transport: "mcp-stdio",
      });
    } finally {
      db.close();
    }
  } finally {
    await rm(target.dir, { recursive: true, force: true });
  }
});

test("direct node invocation still works against the same target-repo flow", async () => {
  const target = await makeTargetRepo();
  try {
    const result = run(
      process.execPath,
      [
        path.join(repoRoot, "scripts/register-agent.mjs"),
        "--name",
        "manual-agent",
        "--kind",
        "mock",
        "--repo",
        target.dir,
      ],
      { cwd: repoRoot },
    );

    assertExit(result, 0);
    assert.match(result.stdout, /^NAME=manual-agent$/m);
    assert.equal(result.stderr, "");
  } finally {
    await rm(target.dir, { recursive: true, force: true });
  }
});

test("invalid flags still fail with a clear parse error and usage output", async () => {
  const result = run(
    pnpmBin,
    [
      "agent:register",
      "--",
      "--bogus",
    ],
    { cwd: repoRoot },
  );

  assertExit(result, 2);
  assert.match(result.stderr, /^register-agent:/m);
  assert.match(result.stderr, /^usage:/m);
});

test("invalid option values still fail with a clear validation error", async () => {
  const result = run(
    pnpmBin,
    [
      "agent:register",
      "--",
      "--name",
      "bad-agent",
      "--kind",
      "nope",
    ],
    { cwd: repoRoot },
  );

  assertExit(result, 2);
  assert.match(result.stderr, /kind must be one of:/);
  assert.match(result.stderr, /^usage:/m);
});
