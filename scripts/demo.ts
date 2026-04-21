#!/usr/bin/env node

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { openDatabase } from "../packages/core/dist/db/client.js";
import { DeltaPilotClient } from "../packages/sdk/dist/index.js";

interface DemoOptions {
  repo?: string;
  reset: boolean;
  agentName: string;
  taskTitle: string;
  help: boolean;
}

interface SeededDemo {
  repoRoot: string;
  dbPath: string;
  agentId: string;
  taskId: string;
  briefPath: string;
}

interface SmokeResult {
  branchName: string;
  worktreePath: string;
  commitSha: string;
  finalStatus: string;
  taskEvents: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const execFileAsync = promisify(execFile);
const defaultRepoRoot = path.join(projectRoot, ".deltapilot", "demo-repo");
const cliPath = path.join(projectRoot, "packages", "mcp-server", "dist", "cli.js");
const migrationPath = path.join(
  projectRoot,
  "packages",
  "core",
  "dist",
  "db",
  "migrations",
  "0000_init.sql",
);
const demoFileName = "demo-output.txt";

function parseCli(argv: string[]): DemoOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      reset: { type: "boolean", default: false },
      "agent-name": { type: "string" },
      "task-title": { type: "string" },
      help: { type: "boolean", default: false, short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  return {
    repo: values.repo,
    reset: values.reset,
    agentName: values["agent-name"] ?? "demo-agent",
    taskTitle: values["task-title"] ?? "Smoke test: claim -> commit -> submit",
    help: values.help,
  };
}

function printHelp(): void {
  console.log(`DeltaPilot demo

Usage:
  pnpm demo
  pnpm demo -- --repo /absolute/path/to/demo-repo --reset

Options:
  --repo <path>          Target repository to seed for the smoke test.
  --reset                Delete an existing custom demo repo before seeding it.
  --agent-name <name>    Agent name stored in the demo database.
  --task-title <title>   Task title stored in the demo database.
  -h, --help             Show this help text.
`);
}

function getInvocationCwd(): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd());
}

function isWithinPath(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function assertBuiltArtifacts(): void {
  const required = [
    path.join(projectRoot, "packages", "core", "dist", "db", "client.js"),
    path.join(projectRoot, "packages", "sdk", "dist", "index.js"),
    cliPath,
    migrationPath,
  ];

  const missing = required.filter((filePath) => !existsSync(filePath));
  if (missing.length > 0) {
    throw new Error(
      `missing build output:\n${missing.map((filePath) => `- ${filePath}`).join("\n")}\nRun \`pnpm build\` or \`pnpm demo\`.`,
    );
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDemoRepoPath(repoRoot: string, reset: boolean, isDefaultPath: boolean): Promise<void> {
  const invocationCwd = getInvocationCwd();

  if (!(await fileExists(repoRoot))) return;

  const entries = await readdir(repoRoot);
  if (entries.length === 0) return;

  if (isWithinPath(invocationCwd, repoRoot)) {
    throw new Error(
      [
        `refusing to recreate ${repoRoot} while your shell is inside it (${invocationCwd})`,
        `cd ${projectRoot}`,
        "then re-run `pnpm demo`.",
      ].join("\n"),
    );
  }

  if (!isDefaultPath && !reset) {
    throw new Error(
      `refusing to overwrite existing directory: ${repoRoot}\nRe-run with --reset or choose another path with --repo.`,
    );
  }

  await rm(repoRoot, { recursive: true, force: true });
}

async function createDemoRepo(repoRoot: string): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "demo@deltapilot.local"]);
  await git(repoRoot, ["config", "user.name", "DeltaPilot Demo"]);

  await writeFile(
    path.join(repoRoot, "README.md"),
    [
      "# DeltaPilot demo repo",
      "",
      "This repository is seeded by scripts/demo.ts.",
      "The smoke test claims a task, creates demo-output.txt in a task worktree,",
      "commits it, then submits the task for review.",
      "",
    ].join("\n"),
    "utf8",
  );

  await git(repoRoot, ["add", "."]);
  await git(repoRoot, ["commit", "-m", "seed"]);
}

async function seedDemo(repoRoot: string, agentName: string, taskTitle: string): Promise<SeededDemo> {
  const dbPath = path.join(repoRoot, ".deltapilot-data.db");
  const agentId = crypto.randomUUID();
  const taskId = crypto.randomUUID();
  const now = new Date().toISOString();
  const acceptance = {
    goal: "Exercise DeltaPilot's MCP claim/submit flow from a seeded task.",
    deliverables: [demoFileName],
    files_in_scope: [demoFileName],
    success_test: `${demoFileName} exists in the task branch and the task lands in review.`,
  };

  const artifactDir = path.join(repoRoot, ".deltapilot", "artifacts", taskId);
  const briefPath = path.join(artifactDir, "task_brief.md");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(
    briefPath,
    [
      `# ${taskTitle}`,
      "",
      "Create the deliverable file in the claimed worktree, commit it, and submit the task.",
      "",
      "## Acceptance",
      `- Deliverable: ${demoFileName}`,
      "- Expected final state: task status becomes review",
      "",
    ].join("\n"),
    "utf8",
  );

  const conn = openDatabase(dbPath);
  try {
    conn.raw
      .prepare(
        `INSERT INTO agents (id, name, kind, transport, command, endpoint, registered_at, last_seen_at)
         VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL)`,
      )
      .run(agentId, agentName, "codex", "mcp-stdio", now);

    conn.raw
      .prepare(
        `INSERT INTO tasks
         (id, title, brief, status, priority, assigned_agent_id, branch_name, worktree_path,
          acceptance_json, created_at, updated_at, claimed_at, last_heartbeat_at)
         VALUES (?, ?, ?, 'todo', 75, NULL, NULL, NULL, ?, ?, ?, NULL, NULL)`,
      )
      .run(
        taskId,
        taskTitle,
        `Seeded by scripts/demo.ts. Create ${demoFileName}, commit it, then submit for review.`,
        JSON.stringify(acceptance),
        now,
        now,
      );

    conn.raw
      .prepare(
        `INSERT INTO task_events
         (id, task_id, kind, payload_json, actor_agent_id, from_status, to_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        taskId,
        "create",
        JSON.stringify({ title: taskTitle }),
        null,
        "init",
        "init",
        now,
      );

    conn.raw
      .prepare(
        `INSERT INTO task_events
         (id, task_id, kind, payload_json, actor_agent_id, from_status, to_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        taskId,
        "ready",
        JSON.stringify({ kind: "ready" }),
        null,
        "init",
        "todo",
        now,
      );

    conn.raw
      .prepare(
        `INSERT INTO artifacts
         (id, task_id, kind, path, author_agent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(crypto.randomUUID(), taskId, "task_brief", briefPath, null, now);
  } finally {
    conn.close();
  }

  return { repoRoot, dbPath, agentId, taskId, briefPath };
}

async function runSmoke(repoRoot: string, dbPath: string, agentId: string, taskId: string): Promise<SmokeResult> {
  const client = await DeltaPilotClient.connect({
    command: process.execPath,
    args: [cliPath, "--repo", repoRoot, "--agent-id", agentId, "--db", dbPath],
    clientName: "deltapilot-demo",
    clientVersion: "0.0.0",
  });

  try {
    const claimed = await client.claimTask();
    if (!claimed) throw new Error("expected a seeded task, but claimTask returned null");
    if (claimed.id !== taskId) {
      throw new Error(`claimed unexpected task ${claimed.id}; expected ${taskId}`);
    }
    if (!claimed.worktree_path || !claimed.branch_name) {
      throw new Error("claimed task is missing worktree_path or branch_name");
    }

    const demoFilePath = path.join(claimed.worktree_path, demoFileName);
    await writeFile(
      demoFilePath,
      [
        "DeltaPilot smoke test completed successfully.",
        `task_id=${taskId}`,
        `agent_id=${agentId}`,
        `branch=${claimed.branch_name}`,
        "",
      ].join("\n"),
      "utf8",
    );

    await git(claimed.worktree_path, ["add", demoFileName]);
    await git(claimed.worktree_path, ["commit", "-m", "demo: complete smoke test"]);
    const commitSha = await git(claimed.worktree_path, ["rev-parse", "HEAD"]);

    const submitted = await client.submitWork(taskId, commitSha);

    const conn = openDatabase(dbPath);
    try {
      const events = conn.raw
        .prepare(
          `SELECT kind, from_status, to_status
           FROM task_events
           WHERE task_id = ?
           ORDER BY created_at ASC`,
        )
        .all(taskId) as Array<{ kind: string; from_status: string; to_status: string }>;

      return {
        branchName: claimed.branch_name,
        worktreePath: claimed.worktree_path,
        commitSha,
        finalStatus: submitted.status,
        taskEvents: events.map((event) => `${event.kind}: ${event.from_status} -> ${event.to_status}`),
      };
    } finally {
      conn.close();
    }
  } finally {
    await client.close();
  }
}

function printSummary(seeded: SeededDemo, smoke: SmokeResult): void {
  const inspectCommands = [
    `cd ${projectRoot}`,
    `pnpm dashboard -- --repo ${seeded.repoRoot}`,
    `cd ${seeded.repoRoot}`,
    `git log --oneline ${smoke.branchName}`,
    `git show ${smoke.branchName}:${demoFileName}`,
    `sqlite3 ${seeded.dbPath} "select id, title, status, branch_name from tasks;"`,
    `sqlite3 ${seeded.dbPath} "select kind, from_status, to_status from task_events where task_id = '${seeded.taskId}' order by created_at;"`,
  ];

  console.log(`DeltaPilot demo complete.

Repo:        ${seeded.repoRoot}
Database:    ${seeded.dbPath}
Task brief:  ${seeded.briefPath}
Agent ID:    ${seeded.agentId}
Task ID:     ${seeded.taskId}
Branch:      ${smoke.branchName}
Worktree:    ${smoke.worktreePath}
Commit:      ${smoke.commitSha}
Status:      ${smoke.finalStatus}

Task events:
${smoke.taskEvents.map((event) => `  - ${event}`).join("\n")}

Inspect it with:
${inspectCommands.map((command) => `  ${command}`).join("\n")}
`);
}

async function main(): Promise<void> {
  const options = parseCli(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  assertBuiltArtifacts();

  const repoRoot = options.repo ? path.resolve(options.repo) : defaultRepoRoot;
  await ensureDemoRepoPath(repoRoot, options.reset, !options.repo);
  await createDemoRepo(repoRoot);

  const seeded = await seedDemo(repoRoot, options.agentName, options.taskTitle);
  const smoke = await runSmoke(repoRoot, seeded.dbPath, seeded.agentId, seeded.taskId);
  printSummary(seeded, smoke);
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
