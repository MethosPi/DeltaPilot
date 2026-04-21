import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Orchestrator, WorktreeManager, openDatabase, type OpenDatabaseResult } from "@deltapilot/core";
import type { AcceptanceCriteria, Agent, Task, TaskStatus } from "@deltapilot/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.resolve(__dirname, "../public");
const MAX_BODY_SIZE = 1024 * 1024;
type DashboardBoardStatus = "todo" | "in_progress" | "review" | "done" | "cancelled";

const TASK_STATUS_ORDER: TaskStatus[] = [
  "init",
  "todo",
  "handoff_pending",
  "in_progress",
  "review",
  "done",
  "cancelled",
];
const BOARD_STATUS_ORDER: DashboardBoardStatus[] = [
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
];

const STATUS_RANK = new Map(TASK_STATUS_ORDER.map((status, index) => [status, index]));
const MIME_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

interface TaskRow {
  id: string;
  title: string;
  brief: string;
  status: string;
  priority: number;
  assigned_agent_id: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  acceptance_json: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  kind: Agent["kind"];
  transport: Agent["transport"];
  command: string | null;
  endpoint: string | null;
  registered_at: string;
  last_seen_at: string | null;
}

interface TaskEventRow {
  id: string;
  task_id: string;
  kind: string;
  payload_json: string | null;
  actor_agent_id: string | null;
  actor_agent_name: string | null;
  from_status: string;
  to_status: string;
  created_at: string;
}

interface ArtifactRow {
  id: string;
  task_id: string;
  kind: string;
  path: string;
  author_agent_id: string | null;
  author_agent_name: string | null;
  created_at: string;
}

interface HandoffRow {
  id: string;
  task_id: string;
  task_title: string;
  from_agent_id: string;
  from_agent_name: string | null;
  to_agent_id: string | null;
  to_agent_name: string | null;
  reason: string;
  snapshot_commit: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface DashboardServerOptions {
  repoRoot: string;
  dbPath: string;
  host?: string;
  port?: number;
  auth?: {
    username: string;
    password: string;
  };
}

export interface StartedDashboardServer {
  host: string;
  port: number;
  origin: string;
  close: () => Promise<void>;
  server: HttpServer;
}

interface DashboardTaskSummary {
  id: string;
  title: string;
  brief: string;
  status: DashboardBoardStatus;
  raw_status: TaskStatus;
  status_note: string | null;
  priority: number;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  worktree_exists: boolean;
  acceptance: AcceptanceCriteria | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
}

interface DashboardAgentSummary extends Agent {
  assigned_task_count: number;
}

interface DashboardTaskEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  actor_agent_id: string | null;
  actor_agent_name: string | null;
  from_status: string;
  to_status: string;
  created_at: string;
}

interface DashboardArtifact {
  id: string;
  kind: string;
  path: string;
  author_agent_id: string | null;
  author_agent_name: string | null;
  created_at: string;
  content: string | null;
}

interface DashboardHandoff {
  id: string;
  task_id: string;
  task_title: string;
  from_agent_id: string;
  from_agent_name: string | null;
  to_agent_id: string | null;
  to_agent_name: string | null;
  reason: string;
  snapshot_commit: string | null;
  created_at: string;
  completed_at: string | null;
}

interface DashboardTaskDetail {
  task: DashboardTaskSummary;
  events: DashboardTaskEvent[];
  artifacts: DashboardArtifact[];
  handoffs: DashboardHandoff[];
}

interface DashboardSnapshot {
  meta: {
    repo_root: string;
    db_path: string;
    generated_at: string;
  };
  stats: Record<DashboardBoardStatus, number>;
  tasks: DashboardTaskSummary[];
  agents: DashboardAgentSummary[];
  recent_handoffs: DashboardHandoff[];
}

interface DashboardContext {
  conn: OpenDatabaseResult;
  orch: Orchestrator;
  worktreeMgr: WorktreeManager;
  options: Required<Pick<DashboardServerOptions, "repoRoot" | "dbPath">> & {
    auth?: DashboardServerOptions["auth"];
  };
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function startDashboardServer(
  options: DashboardServerOptions,
): Promise<StartedDashboardServer> {
  const repoRoot = options.repoRoot;
  const dbPath = options.dbPath;
  const conn = openDatabase(dbPath);
  const worktreeMgr = new WorktreeManager({
    repoRoot,
    workspacesDir: path.join(repoRoot, ".deltapilot", "workspaces"),
  });
  const orch = new Orchestrator({
    raw: conn.raw,
    db: conn.db,
    worktreeMgr,
    repoRoot,
  });

  const context: DashboardContext = {
    conn,
    orch,
    worktreeMgr,
    options: {
      repoRoot,
      dbPath,
      ...(options.auth ? { auth: options.auth } : {}),
    },
  };

  const server = createServer((req, res) => {
    void handleRequest(req, res, context).catch((error) => {
      if (error instanceof HttpError) {
        sendJson(res, error.statusCode, {
          error: "request_failed",
          message: error.message,
        });
        return;
      }

      console.error(error);
      sendJson(res, 500, {
        error: "internal_error",
        message: error instanceof Error ? error.message : String(error),
      });
    });
  });

  const host = options.host ?? "0.0.0.0";
  const requestedPort = options.port ?? 3000;

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("dashboard server did not bind a TCP address");
  }

  const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
  const origin = `http://${displayHost}:${address.port}`;

  return {
    host,
    port: address.port,
    origin,
    server,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      conn.close();
    },
  };
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  context: DashboardContext,
): Promise<void> {
  if (context.options.auth && !isAuthorized(req, context.options.auth)) {
    res.statusCode = 401;
    res.setHeader("WWW-Authenticate", 'Basic realm="DeltaPilot Dashboard"');
    res.end("Authentication required");
    return;
  }

  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/dashboard") {
    sendJson(res, 200, loadDashboardSnapshot(context));
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
  if (method === "GET" && taskMatch) {
    const taskId = taskMatch[1];
    if (!taskId) throw new HttpError(400, "task id is required");
    sendJson(res, 200, await loadTaskDetail(context, taskId));
    return;
  }

  if (method === "POST" && pathname === "/api/tasks") {
    const body = await readJsonBody(req);
    const task = await createTaskFromBody(context, body);
    sendJson(res, 201, await loadTaskDetail(context, task.id));
    return;
  }

  if (method === "POST" && pathname === "/api/agents") {
    const body = await readJsonBody(req);
    const agent = await registerAgentFromBody(context, body);
    sendJson(res, 201, agent);
    return;
  }

  const actionMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/actions$/i);
  if (method === "POST" && actionMatch) {
    const taskId = actionMatch[1];
    if (!taskId) throw new HttpError(400, "task id is required");
    const body = await readJsonBody(req);
    await applyDashboardAction(context, taskId, body);
    sendJson(res, 200, await loadTaskDetail(context, taskId));
    return;
  }

  if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
    await sendStaticFile(res, "index.html");
    return;
  }

  if (method === "GET" && (pathname === "/app.js" || pathname === "/styles.css")) {
    await sendStaticFile(res, pathname.slice(1));
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

async function sendStaticFile(res: ServerResponse, relativePath: string): Promise<void> {
  const filePath = path.join(publicDir, relativePath);
  const ext = path.extname(filePath);
  const content = await readFile(filePath);
  res.statusCode = 200;
  res.setHeader("Content-Type", MIME_TYPES.get(ext) ?? "application/octet-stream");
  res.end(content);
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += piece.length;
    if (size > MAX_BODY_SIZE) {
      throw new Error("request body too large");
    }
    chunks.push(piece);
  }

  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

function isAuthorized(
  req: IncomingMessage,
  auth: NonNullable<DashboardServerOptions["auth"]>,
): boolean {
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;

  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return username === auth.username && password === auth.password;
}

function loadDashboardSnapshot(context: DashboardContext): DashboardSnapshot {
  const tasks = selectTasks(context.conn.raw);
  const agents = selectAgents(context.conn.raw);
  const recentHandoffs = selectHandoffs(context.conn.raw);

  const stats = Object.fromEntries(
    BOARD_STATUS_ORDER.map((status) => [status, 0]),
  ) as Record<DashboardBoardStatus, number>;
  for (const task of tasks) {
    stats[task.status] = (stats[task.status] ?? 0) + 1;
  }

  return {
    meta: {
      repo_root: context.options.repoRoot,
      db_path: context.options.dbPath,
      generated_at: new Date().toISOString(),
    },
    stats,
    tasks,
    agents,
    recent_handoffs: recentHandoffs.slice(0, 12),
  };
}

async function loadTaskDetail(
  context: DashboardContext,
  taskId: string,
): Promise<DashboardTaskDetail> {
  const task = selectTaskById(context.conn.raw, taskId);
  if (!task) {
    throw new HttpError(404, `Task not found: ${taskId}`);
  }

  return {
    task,
    events: selectTaskEvents(context.conn.raw, taskId),
    handoffs: selectHandoffs(context.conn.raw, taskId),
    artifacts: await selectArtifacts(context.conn.raw, taskId),
  };
}

async function createTaskFromBody(
  context: DashboardContext,
  body: unknown,
): Promise<Task> {
  const parsed = body as {
    title?: unknown;
    brief?: unknown;
    priority?: unknown;
    ready?: unknown;
    acceptance?: unknown;
  };

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!title) {
    throw new HttpError(400, "title is required");
  }

  const brief = typeof parsed.brief === "string" ? parsed.brief.trim() : "";
  const priority = parsePriority(parsed.priority);
  const acceptance = parseAcceptance(parsed.acceptance);
  const ready = parsed.ready === undefined ? true : Boolean(parsed.ready);

  const created = await context.orch.createTask({
    title,
    brief,
    priority,
    ...(acceptance ? { acceptance } : {}),
  });

  if (ready) {
    return context.orch.applyEvent(created.id, { kind: "ready" });
  }

  return created;
}

const VALID_AGENT_KINDS: Agent["kind"][] = [
  "claude-code",
  "claude-sdk",
  "codex",
  "opendevin",
  "hermes",
  "mock",
  "other",
];
const VALID_AGENT_TRANSPORTS: Agent["transport"][] = ["mcp-stdio", "http"];

async function registerAgentFromBody(
  context: DashboardContext,
  body: unknown,
): Promise<Agent> {
  const parsed = body as {
    name?: unknown;
    kind?: unknown;
    transport?: unknown;
    command?: unknown;
    endpoint?: unknown;
  };

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) {
    throw new HttpError(400, "name is required");
  }

  if (typeof parsed.kind !== "string" || !VALID_AGENT_KINDS.includes(parsed.kind as Agent["kind"])) {
    throw new HttpError(400, `kind must be one of: ${VALID_AGENT_KINDS.join(", ")}`);
  }
  const kind = parsed.kind as Agent["kind"];

  const transportRaw = typeof parsed.transport === "string" ? parsed.transport : "mcp-stdio";
  if (!VALID_AGENT_TRANSPORTS.includes(transportRaw as Agent["transport"])) {
    throw new HttpError(400, `transport must be one of: ${VALID_AGENT_TRANSPORTS.join(", ")}`);
  }
  const transport = transportRaw as Agent["transport"];

  const command = typeof parsed.command === "string" && parsed.command.trim() ? parsed.command.trim() : undefined;
  const endpoint = typeof parsed.endpoint === "string" && parsed.endpoint.trim() ? parsed.endpoint.trim() : undefined;

  return context.orch.registerAgent({
    name,
    kind,
    transport,
    ...(command ? { command } : {}),
    ...(endpoint ? { endpoint } : {}),
  });
}

async function applyDashboardAction(
  context: DashboardContext,
  taskId: string,
  body: unknown,
): Promise<void> {
  const parsed = body as { kind?: unknown; note?: unknown; target_status?: unknown };
  if (typeof parsed.kind !== "string") {
    throw new HttpError(400, "action kind is required");
  }

  switch (parsed.kind) {
    case "move": {
      if (typeof parsed.target_status !== "string") {
        throw new HttpError(400, "move requires target_status");
      }
      await moveTaskFromDashboard(
        context,
        taskId,
        parseBoardStatus(parsed.target_status),
        typeof parsed.note === "string" ? parsed.note.trim() : "",
      );
      return;
    }
    case "ready":
      context.orch.applyEvent(taskId, { kind: "ready" });
      return;
    case "approve":
      context.orch.applyEvent(taskId, { kind: "approve" });
      return;
    case "cancel":
      context.orch.applyEvent(taskId, { kind: "cancel" });
      return;
    case "bounce": {
      const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      if (!note) {
        throw new HttpError(400, "bounce requires a note");
      }
      context.orch.applyEvent(taskId, { kind: "bounce", note });
      return;
    }
    default:
      throw new HttpError(400, `unsupported action kind: ${parsed.kind}`);
  }
}

function parsePriority(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "number" && typeof raw !== "string") {
    throw new HttpError(400, "priority must be a number");
  }
  const parsed = typeof raw === "number" ? raw : Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new HttpError(400, "priority must be an integer between 0 and 100");
  }
  return parsed;
}

function parseBoardStatus(raw: string): DashboardBoardStatus {
  if (BOARD_STATUS_ORDER.includes(raw as DashboardBoardStatus)) {
    return raw as DashboardBoardStatus;
  }
  throw new HttpError(400, `unsupported target status: ${raw}`);
}

function parseAcceptance(raw: unknown): AcceptanceCriteria | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const candidate = raw as {
    goal?: unknown;
    deliverables?: unknown;
    files_in_scope?: unknown;
    success_test?: unknown;
  };

  const goal = typeof candidate.goal === "string" ? candidate.goal.trim() : "";
  const deliverables = Array.isArray(candidate.deliverables)
    ? candidate.deliverables.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];
  const filesInScope = Array.isArray(candidate.files_in_scope)
    ? candidate.files_in_scope.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];
  const successTest =
    typeof candidate.success_test === "string" ? candidate.success_test.trim() : "";

  if (!goal && deliverables.length === 0 && filesInScope.length === 0 && !successTest) {
    return undefined;
  }

  if (!goal || deliverables.length === 0 || !successTest) {
    throw new HttpError(
      400,
      "acceptance requires goal, deliverables, and success_test when provided",
    );
  }

  return {
    goal,
    deliverables,
    files_in_scope: filesInScope,
    success_test: successTest,
  };
}

async function moveTaskFromDashboard(
  context: DashboardContext,
  taskId: string,
  targetStatus: DashboardBoardStatus,
  note: string,
): Promise<void> {
  const task = selectTaskRowById(context.conn.raw, taskId);
  if (!task) {
    throw new HttpError(404, `Task not found: ${taskId}`);
  }

  const fromStatus = task.status as TaskStatus;
  const ts = new Date().toISOString();

  let assignedAgentId = task.assigned_agent_id;
  let branchName = task.branch_name;
  let worktreePath = task.worktree_path;
  let claimedAt = task.claimed_at;
  let lastHeartbeatAt = task.last_heartbeat_at;

  if (targetStatus === "in_progress") {
    assignedAgentId ??= selectPreferredAgentId(context.conn.raw);
    if (!assignedAgentId) {
      throw new HttpError(400, "move to in_progress requires at least one registered agent");
    }
    context.orch.getAgent(assignedAgentId);

    const ensured = await ensureTaskWorktree(context, task);
    branchName = ensured.branchName;
    worktreePath = ensured.worktreePath;
    claimedAt = ts;
    lastHeartbeatAt = ts;
  } else if (targetStatus === "todo" || targetStatus === "cancelled") {
    assignedAgentId = null;
    worktreePath = null;
    claimedAt = null;
    lastHeartbeatAt = null;
  }

  if (
    fromStatus === targetStatus
    && task.assigned_agent_id === assignedAgentId
    && task.branch_name === branchName
    && task.worktree_path === worktreePath
  ) {
    return;
  }

  const update = context.conn.raw.transaction(() => {
    context.conn.raw
      .prepare(
        `UPDATE tasks
           SET status = ?,
               assigned_agent_id = ?,
               branch_name = ?,
               worktree_path = ?,
               claimed_at = ?,
               last_heartbeat_at = ?,
               updated_at = ?
         WHERE id = ?`,
      )
      .run(
        targetStatus,
        assignedAgentId,
        branchName,
        worktreePath,
        claimedAt,
        lastHeartbeatAt,
        ts,
        taskId,
      );

    if (targetStatus === "in_progress" && assignedAgentId) {
      context.conn.raw
        .prepare("UPDATE agents SET last_seen_at = ? WHERE id = ?")
        .run(ts, assignedAgentId);
    }

    context.conn.raw
      .prepare(
        `INSERT INTO task_events
         (id, task_id, kind, payload_json, actor_agent_id, from_status, to_status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        taskId,
        "dashboard_move",
        JSON.stringify({
          note: note || null,
          target_status: targetStatus,
          assigned_agent_id: assignedAgentId,
          mode: "dashboard_override",
        }),
        null,
        fromStatus,
        targetStatus,
        ts,
      );
  });

  update();
}

function selectTasks(raw: OpenDatabaseResult["raw"]): DashboardTaskSummary[] {
  const rows = raw
    .prepare(
      `
      SELECT tasks.*, agents.name AS assigned_agent_name
      FROM tasks
      LEFT JOIN agents ON agents.id = tasks.assigned_agent_id
      ORDER BY
        CASE tasks.status
          WHEN 'init' THEN 0
          WHEN 'todo' THEN 0
          WHEN 'handoff_pending' THEN 1
          WHEN 'in_progress' THEN 1
          WHEN 'review' THEN 2
          WHEN 'done' THEN 3
          ELSE 4
        END,
        CASE tasks.status
          WHEN 'todo' THEN 0
          WHEN 'in_progress' THEN 0
          ELSE 1
        END,
        tasks.priority DESC,
        tasks.created_at ASC
      `,
    )
    .all() as Array<TaskRow & { assigned_agent_name: string | null }>;

  return rows.map((row) => mapTask(row, row.assigned_agent_name));
}

function selectTaskRowById(
  raw: OpenDatabaseResult["raw"],
  taskId: string,
): TaskRow | null {
  const row = raw
    .prepare("SELECT * FROM tasks WHERE id = ?")
    .get(taskId) as TaskRow | undefined;

  return row ?? null;
}

function selectTaskById(
  raw: OpenDatabaseResult["raw"],
  taskId: string,
): DashboardTaskSummary | null {
  const row = raw
    .prepare(
      `
      SELECT tasks.*, agents.name AS assigned_agent_name
      FROM tasks
      LEFT JOIN agents ON agents.id = tasks.assigned_agent_id
      WHERE tasks.id = ?
      `,
    )
    .get(taskId) as (TaskRow & { assigned_agent_name: string | null }) | undefined;

  return row ? mapTask(row, row.assigned_agent_name) : null;
}

function selectAgents(raw: OpenDatabaseResult["raw"]): DashboardAgentSummary[] {
  const rows = raw
    .prepare(
      `
      SELECT agents.*, COUNT(tasks.id) AS assigned_task_count
      FROM agents
      LEFT JOIN tasks ON tasks.assigned_agent_id = agents.id
      GROUP BY agents.id
      ORDER BY COALESCE(agents.last_seen_at, agents.registered_at) DESC, agents.name ASC
      `,
    )
    .all() as Array<AgentRow & { assigned_task_count: number }>;

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    kind: row.kind,
    transport: row.transport,
    ...(row.command !== null ? { command: row.command } : {}),
    ...(row.endpoint !== null ? { endpoint: row.endpoint } : {}),
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
    assigned_task_count: row.assigned_task_count,
  }));
}

function selectTaskEvents(raw: OpenDatabaseResult["raw"], taskId: string): DashboardTaskEvent[] {
  const rows = raw
    .prepare(
      `
      SELECT task_events.*, agents.name AS actor_agent_name
      FROM task_events
      LEFT JOIN agents ON agents.id = task_events.actor_agent_id
      WHERE task_events.task_id = ?
      ORDER BY task_events.created_at ASC
      `,
    )
    .all(taskId) as TaskEventRow[];

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: safeParseJson(row.payload_json),
    actor_agent_id: row.actor_agent_id,
    actor_agent_name: row.actor_agent_name,
    from_status: row.from_status,
    to_status: row.to_status,
    created_at: row.created_at,
  }));
}

async function selectArtifacts(
  raw: OpenDatabaseResult["raw"],
  taskId: string,
): Promise<DashboardArtifact[]> {
  const rows = raw
    .prepare(
      `
      SELECT artifacts.*, agents.name AS author_agent_name
      FROM artifacts
      LEFT JOIN agents ON agents.id = artifacts.author_agent_id
      WHERE artifacts.task_id = ?
      ORDER BY artifacts.created_at DESC
      `,
    )
    .all(taskId) as ArtifactRow[];

  return Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      kind: row.kind,
      path: row.path,
      author_agent_id: row.author_agent_id,
      author_agent_name: row.author_agent_name,
      created_at: row.created_at,
      content: existsSync(row.path) ? await readFile(row.path, "utf8") : null,
    })),
  );
}

function selectHandoffs(
  raw: OpenDatabaseResult["raw"],
  taskId?: string,
): DashboardHandoff[] {
  const sql = `
    SELECT handoffs.*, tasks.title AS task_title, from_agent.name AS from_agent_name, to_agent.name AS to_agent_name
    FROM handoffs
    JOIN tasks ON tasks.id = handoffs.task_id
    JOIN agents AS from_agent ON from_agent.id = handoffs.from_agent_id
    LEFT JOIN agents AS to_agent ON to_agent.id = handoffs.to_agent_id
    ${taskId ? "WHERE handoffs.task_id = ?" : ""}
    ORDER BY handoffs.created_at DESC
  `;

  const rows = (taskId
    ? raw.prepare(sql).all(taskId)
    : raw.prepare(sql).all()) as HandoffRow[];

  return rows.map((row) => ({
    id: row.id,
    task_id: row.task_id,
    task_title: row.task_title,
    from_agent_id: row.from_agent_id,
    from_agent_name: row.from_agent_name,
    to_agent_id: row.to_agent_id,
    to_agent_name: row.to_agent_name,
    reason: row.reason,
    snapshot_commit: row.snapshot_commit,
    created_at: row.created_at,
    completed_at: row.completed_at,
  }));
}

function mapTask(row: TaskRow, assignedAgentName: string | null): DashboardTaskSummary {
  const acceptance =
    row.acceptance_json !== null
      ? (JSON.parse(row.acceptance_json) as AcceptanceCriteria)
      : null;

  const rawStatus = row.status as TaskStatus;
  if (!STATUS_RANK.has(rawStatus)) {
    throw new HttpError(500, `unknown task status: ${row.status}`);
  }

  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    status: toBoardStatus(rawStatus),
    raw_status: rawStatus,
    status_note: statusNoteFor(rawStatus),
    priority: row.priority,
    assigned_agent_id: row.assigned_agent_id,
    assigned_agent_name: assignedAgentName,
    branch_name: row.branch_name,
    worktree_path: row.worktree_path,
    worktree_exists: row.worktree_path ? existsSync(row.worktree_path) : false,
    acceptance,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    last_heartbeat_at: row.last_heartbeat_at,
  };
}

function toBoardStatus(status: TaskStatus): DashboardBoardStatus {
  switch (status) {
    case "init":
    case "todo":
      return "todo";
    case "handoff_pending":
    case "in_progress":
      return "in_progress";
    case "review":
    case "done":
    case "cancelled":
      return status;
  }
}

function statusNoteFor(status: TaskStatus): string | null {
  switch (status) {
    case "init":
      return "Task created but not yet queued.";
    case "handoff_pending":
      return "Task is waiting to be reclaimed after a handoff.";
    default:
      return null;
  }
}

function selectPreferredAgentId(raw: OpenDatabaseResult["raw"]): string | null {
  const row = raw
    .prepare(
      `
      SELECT id
      FROM agents
      ORDER BY COALESCE(last_seen_at, registered_at) DESC, registered_at DESC
      LIMIT 1
      `,
    )
    .get() as { id: string } | undefined;

  return row?.id ?? null;
}

async function ensureTaskWorktree(
  context: DashboardContext,
  task: TaskRow,
): Promise<{ branchName: string; worktreePath: string }> {
  if (task.worktree_path && existsSync(task.worktree_path)) {
    return {
      branchName: task.branch_name ?? context.worktreeMgr.branchFor(task.id),
      worktreePath: task.worktree_path,
    };
  }

  if (task.branch_name) {
    return context.worktreeMgr.attachWorktree(task.id);
  }

  return context.worktreeMgr.createWorktree(task.id);
}

function safeParseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}
