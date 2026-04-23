import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AgentDeleteConflictError,
  AgentNotFoundError,
  Orchestrator,
  WorktreeManager,
  openDatabase,
  type OpenDatabaseResult,
} from "@deltapilot/core";
import type {
  AcceptanceCriteria,
  Agent,
  AgentRole,
  AgentRuntimeMode,
  AgentSession,
  ApprovalRequest,
  SessionMessage,
  Task,
  TaskStatus,
} from "@deltapilot/shared";
import { spawn as spawnPty, type IPty } from "node-pty";

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = existsSync(path.join(__dirname, "public"))
  ? path.join(__dirname, "public")
  : path.resolve(__dirname, "../public");
const MAX_BODY_SIZE = 1024 * 1024;

const TASK_STATUS_ORDER: TaskStatus[] = [
  "todo",
  "planning",
  "in_progress",
  "review",
  "human_review",
  "done",
  "cancelled",
];

const MIME_TYPES = new Map<string, string>([
  [".html", "text/html; charset=utf-8"],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
]);

const MANAGED_COMMAND_DEFAULTS: Partial<Record<Agent["kind"], string>> = {
  codex: "codex",
  "claude-code": "claude",
  "claude-sdk": "claude",
  openclaw: "openclaw gateway start",
  opendevin: "opendevin",
  hermes: "hermes",
};

const TERMINAL_RELAUNCH_COMMANDS = new Set(["claude", "codex", "openclaw gateway start"]);

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
  review_bounce_count: number;
  last_role: string | null;
  status_note: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
}

interface AgentRow {
  id: string;
  name: string;
  kind: Agent["kind"];
  role: Agent["role"];
  runtime_mode: Agent["runtime_mode"];
  transport: Agent["transport"];
  enabled: number;
  command: string | null;
  endpoint: string | null;
  registered_at: string;
  last_seen_at: string | null;
  cooldown_until: string | null;
  last_limit_reason: string | null;
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

interface SessionRow {
  id: string;
  agent_id: string;
  task_id: string | null;
  status: AgentSession["status"];
  pid: number | null;
  log_path: string;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  agent_name: string;
  agent_kind: Agent["kind"];
  agent_role: AgentRole;
  transport: Agent["transport"];
  runtime_mode: AgentRuntimeMode;
  command: string | null;
  endpoint: string | null;
  task_title: string | null;
  pending_approval_count: number;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  task_id: string | null;
  agent_id: string;
  kind: ApprovalRequest["kind"];
  status: ApprovalRequest["status"];
  title: string;
  body: string;
  response_note: string | null;
  created_at: string;
  resolved_at: string | null;
  agent_name: string;
  task_title: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  approval_request_id: string | null;
  direction: SessionMessage["direction"];
  kind: string;
  body: string;
  created_at: string;
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

export interface DashboardTaskSummary {
  id: string;
  title: string;
  brief: string;
  status: TaskStatus;
  priority: number;
  assigned_agent_id: string | null;
  assigned_agent_name: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  worktree_exists: boolean;
  acceptance: AcceptanceCriteria | null;
  review_bounce_count: number;
  last_role: AgentRole | null;
  status_note: string | null;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  last_heartbeat_at: string | null;
}

export interface DashboardAgentSummary extends Agent {
  assigned_task_count: number;
  pending_approval_count: number;
  active_session_id: string | null;
}

export interface DashboardTaskEvent {
  id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  actor_agent_id: string | null;
  actor_agent_name: string | null;
  from_status: string;
  to_status: string;
  created_at: string;
}

export interface DashboardArtifact {
  id: string;
  kind: string;
  path: string;
  author_agent_id: string | null;
  author_agent_name: string | null;
  created_at: string;
  content: string | null;
}

export interface DashboardHandoff {
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

export interface DashboardTaskDetail {
  task: DashboardTaskSummary;
  events: DashboardTaskEvent[];
  artifacts: DashboardArtifact[];
  handoffs: DashboardHandoff[];
}

export interface DashboardSessionSummary {
  id: string;
  agent_id: string;
  agent_name: string;
  agent_kind: Agent["kind"];
  agent_role: AgentRole;
  transport: Agent["transport"];
  runtime_mode: AgentRuntimeMode;
  command: string | null;
  endpoint: string | null;
  task_id: string | null;
  task_title: string | null;
  status: AgentSession["status"];
  pid: number | null;
  log_path: string;
  started_at: string;
  ended_at: string | null;
  last_seen_at: string | null;
  last_error: string | null;
  pending_approval_count: number;
}

export interface DashboardApprovalSummary {
  id: string;
  session_id: string;
  task_id: string | null;
  agent_id: string;
  agent_name: string;
  task_title: string | null;
  kind: ApprovalRequest["kind"];
  status: ApprovalRequest["status"];
  title: string;
  body: string;
  response_note: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface DashboardSessionDetail {
  session: DashboardSessionSummary;
  messages: SessionMessage[];
  approvals: DashboardApprovalSummary[];
  log_content: string;
}

export interface DashboardSnapshot {
  meta: {
    repo_root: string;
    db_path: string;
    generated_at: string;
  };
  stats: Record<TaskStatus, number>;
  tasks: DashboardTaskSummary[];
  agents: DashboardAgentSummary[];
  sessions: DashboardSessionSummary[];
  recent_handoffs: DashboardHandoff[];
}

type InteractiveHandle =
  | { kind: "pty"; pty: IPty }
  | { kind: "screen"; sessionName: string };

interface DashboardContext {
  conn: OpenDatabaseResult;
  orch: Orchestrator;
  worktreeMgr: WorktreeManager;
  interactiveProcesses: Map<string, InteractiveHandle>;
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
    interactiveProcesses: new Map(),
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
      for (const handle of context.interactiveProcesses.values()) {
        try {
          if (handle.kind === "pty") {
            handle.pty.kill("SIGINT");
          } else {
            await stopScreenSession(handle.sessionName);
          }
        } catch {
          // best-effort shutdown
        }
      }
      context.interactiveProcesses.clear();
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

  if (method === "GET" && pathname === "/api/agents") {
    sendJson(res, 200, selectAgents(context.conn.raw));
    return;
  }

  if (method === "GET" && pathname === "/api/sessions") {
    sendJson(res, 200, selectSessions(context.conn.raw, { managedOnly: true }));
    return;
  }

  if (method === "POST" && pathname === "/api/sessions/clear-history") {
    const deletedCount = await clearSessionHistory(context);
    sendJson(res, 200, { deleted_count: deletedCount });
    return;
  }

  if (method === "GET" && pathname === "/api/approvals") {
    sendJson(res, 200, selectApprovals(context.conn.raw));
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)$/i);
  if (method === "GET" && taskMatch) {
    const taskId = taskMatch[1];
    if (!taskId) throw new HttpError(400, "task id is required");
    sendJson(res, 200, await loadTaskDetail(context, taskId));
    return;
  }

  const sessionMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)$/i);
  if (method === "GET" && sessionMatch) {
    const sessionId = sessionMatch[1];
    if (!sessionId) throw new HttpError(400, "session id is required");
    sendJson(res, 200, await loadSessionDetail(context, sessionId));
    return;
  }

  if (method === "DELETE" && sessionMatch) {
    const sessionId = sessionMatch[1];
    if (!sessionId) throw new HttpError(400, "session id is required");
    const deleted = await deleteSessionById(context, sessionId);
    sendJson(res, 200, deleted);
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

  const agentPatchMatch = pathname.match(/^\/api\/agents\/([0-9a-f-]+)$/i);
  if (method === "PATCH" && agentPatchMatch) {
    const agentId = agentPatchMatch[1];
    if (!agentId) throw new HttpError(400, "agent id is required");
    const body = await readJsonBody(req);
    const agent = updateAgentFromBody(context, agentId, body);
    sendJson(res, 200, agent);
    return;
  }

  const agentDeleteMatch = pathname.match(/^\/api\/agents\/([0-9a-f-]+)$/i);
  if (method === "DELETE" && agentDeleteMatch) {
    const agentId = agentDeleteMatch[1];
    if (!agentId) throw new HttpError(400, "agent id is required");
    const agent = deleteAgentById(context, agentId);
    sendJson(res, 200, agent);
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

  const returnMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]+)\/return-to-todo$/i);
  if (method === "POST" && returnMatch) {
    const taskId = returnMatch[1];
    if (!taskId) throw new HttpError(400, "task id is required");
    const body = await readJsonBody(req);
    const note = typeof (body as { note?: unknown }).note === "string"
      ? ((body as { note?: string }).note ?? "").trim()
      : "";
    await context.orch.returnToTodo(taskId, note || undefined);
    sendJson(res, 200, await loadTaskDetail(context, taskId));
    return;
  }

  const sessionMessageMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/messages$/i);
  if (method === "POST" && sessionMessageMatch) {
    const sessionId = sessionMessageMatch[1];
    if (!sessionId) throw new HttpError(400, "session id is required");
    const body = await readJsonBody(req);
    const parsed = body as { body?: unknown; kind?: unknown };
    const kind = typeof parsed.kind === "string" && parsed.kind.trim() ? parsed.kind.trim() : "message";
    const rawMessage = typeof parsed.body === "string" ? parsed.body : "";
    const message = rawMessage.trim();
    const sendEnter = kind === "enter";
    if (!sendEnter && !message) throw new HttpError(400, "message body is required");

    const session = context.orch.getAgentSession(sessionId);
    const agent = context.orch.getAgent(session.agent_id);
    const interactive = context.interactiveProcesses.get(sessionId);
    const launchCommand = resolveLaunchCommand(agent, message);

    context.orch.createSessionMessage({
      sessionId,
      direction: "human",
      kind: sendEnter ? "terminal_key" : (launchCommand ? "terminal_command" : kind),
      body: sendEnter ? "[enter]" : message,
    });

    if (interactive) {
      if (interactive.kind === "pty") {
        interactive.pty.write(sendEnter ? "\r" : `${rawMessage}\r`);
      } else {
        if (!(await screenSessionExists(interactive.sessionName))) {
          context.interactiveProcesses.delete(sessionId);
          throw new HttpError(409, "interactive terminal is no longer running; relaunch it first");
        }
        await sendScreenInput(interactive.sessionName, sendEnter ? "\r" : `${rawMessage}\r`);
        await syncScreenTranscript(context, sessionId, interactive.sessionName);
      }
      await writeSessionLog(context, sessionId, sendEnter ? "[human/stdin] [enter]" : `[human/stdin] ${message}`);
    } else if (launchCommand) {
      await startInteractiveTerminal(context, sessionId, launchCommand);
    } else if (sendEnter) {
      throw new HttpError(409, "no interactive terminal is running for this session");
    } else if (agent.runtime_mode === "managed") {
      await respondToManagedAgentMessage(context, session, agent, message);
      if (session.status === "waiting") {
        context.orch.updateAgentSession(sessionId, {
          status: "ready",
          lastSeenAt: new Date().toISOString(),
        });
      }
    } else if (session.status === "waiting") {
      context.orch.updateAgentSession(sessionId, { status: "ready" });
    }

    sendJson(res, 201, await loadSessionDetail(context, sessionId));
    return;
  }

  const interruptMatch = pathname.match(/^\/api\/sessions\/([0-9a-f-]+)\/interrupt$/i);
  if (method === "POST" && interruptMatch) {
    const sessionId = interruptMatch[1];
    if (!sessionId) throw new HttpError(400, "session id is required");
    await interruptSession(context, sessionId);
    sendJson(res, 200, await loadSessionDetail(context, sessionId));
    return;
  }

  const approveMatch = pathname.match(/^\/api\/approvals\/([0-9a-f-]+)\/approve$/i);
  if (method === "POST" && approveMatch) {
    const approvalId = approveMatch[1];
    if (!approvalId) throw new HttpError(400, "approval id is required");
    const body = await readJsonBody(req);
    const note = typeof (body as { note?: unknown }).note === "string"
      ? ((body as { note?: string }).note ?? "").trim()
      : "";
    const approval = context.orch.resolveApprovalRequest(approvalId, "approved", note || undefined);
    context.orch.createSessionMessage({
      sessionId: approval.session_id,
      approvalRequestId: approvalId,
      direction: "human",
      kind: "approval",
      body: note || "Approved",
    });
    if (context.orch.listApprovalRequests({ status: "pending", sessionId: approval.session_id }).length === 0) {
      const session = context.orch.getAgentSession(approval.session_id);
      if (session.status === "waiting") {
        context.orch.updateAgentSession(approval.session_id, { status: "ready" });
      }
    }
    sendJson(res, 200, approval);
    return;
  }

  const rejectMatch = pathname.match(/^\/api\/approvals\/([0-9a-f-]+)\/reject$/i);
  if (method === "POST" && rejectMatch) {
    const approvalId = rejectMatch[1];
    if (!approvalId) throw new HttpError(400, "approval id is required");
    const body = await readJsonBody(req);
    const note = typeof (body as { note?: unknown }).note === "string"
      ? ((body as { note?: string }).note ?? "").trim()
      : "";
    const approval = context.orch.resolveApprovalRequest(approvalId, "rejected", note || undefined);
    context.orch.createSessionMessage({
      sessionId: approval.session_id,
      approvalRequestId: approvalId,
      direction: "human",
      kind: "rejection",
      body: note || "Rejected",
    });
    if (context.orch.listApprovalRequests({ status: "pending", sessionId: approval.session_id }).length === 0) {
      const session = context.orch.getAgentSession(approval.session_id);
      if (session.status === "waiting") {
        context.orch.updateAgentSession(approval.session_id, { status: "ready" });
      }
    }
    sendJson(res, 200, approval);
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
  const sessions = selectSessions(context.conn.raw, { managedOnly: true });
  const recentHandoffs = selectHandoffs(context.conn.raw).slice(0, 12);

  const stats = Object.fromEntries(
    TASK_STATUS_ORDER.map((status) => [status, 0]),
  ) as Record<TaskStatus, number>;
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
    sessions,
    recent_handoffs: recentHandoffs,
  };
}

async function loadTaskDetail(
  context: DashboardContext,
  taskId: string,
): Promise<DashboardTaskDetail> {
  const task = selectTaskById(context.conn.raw, taskId);
  if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
  return {
    task,
    events: selectTaskEvents(context.conn.raw, taskId),
    handoffs: selectHandoffs(context.conn.raw, taskId),
    artifacts: await selectArtifacts(context.conn.raw, taskId),
  };
}

async function loadSessionDetail(
  context: DashboardContext,
  sessionId: string,
): Promise<DashboardSessionDetail> {
  const session = selectSessionById(context.conn.raw, sessionId);
  if (!session) throw new HttpError(404, `Session not found: ${sessionId}`);
  const interactive = context.interactiveProcesses.get(sessionId);
  let screenSnapshot = "";
  if (interactive?.kind === "screen") {
    if (await screenSessionExists(interactive.sessionName)) {
      screenSnapshot = await syncScreenTranscript(context, sessionId, interactive.sessionName);
    } else {
      context.interactiveProcesses.delete(sessionId);
      context.orch.updateAgentSession(sessionId, {
        status: "stopped",
        pid: null,
      });
    }
  }
  const messages = context.orch.listSessionMessages(sessionId);
  const approvals = selectApprovals(context.conn.raw, { sessionId });
  let logContent = "";
  if (existsSync(session.log_path)) {
    const raw = await readFile(session.log_path, "utf8");
    logContent = raw.slice(-24_000);
  }
  if (screenSnapshot) {
    logContent = [logContent, "\n# terminal\n", screenSnapshot].filter(Boolean).join("");
  }
  return {
    session,
    messages,
    approvals,
    log_content: logContent,
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
    acceptance?: unknown;
  };

  const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
  if (!title) throw new HttpError(400, "title is required");

  const brief = typeof parsed.brief === "string" ? parsed.brief.trim() : "";
  const priority = parsePriority(parsed.priority);
  const acceptance = parseAcceptance(parsed.acceptance);

  return context.orch.createTask({
    title,
    brief,
    ...(priority !== undefined ? { priority } : {}),
    ...(acceptance ? { acceptance } : {}),
  });
}

async function registerAgentFromBody(
  context: DashboardContext,
  body: unknown,
): Promise<Agent> {
  const parsed = body as {
    name?: unknown;
    kind?: unknown;
    role?: unknown;
    runtime_mode?: unknown;
    transport?: unknown;
    enabled?: unknown;
    command?: unknown;
    endpoint?: unknown;
  };

  const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
  if (!name) throw new HttpError(400, "name is required");
  if (typeof parsed.kind !== "string") throw new HttpError(400, "kind is required");
  if (typeof parsed.role !== "string") throw new HttpError(400, "role is required");

  const runtimeMode =
    typeof parsed.runtime_mode === "string" ? parsed.runtime_mode : "managed";
  const transport =
    typeof parsed.transport === "string" ? parsed.transport : "mcp-stdio";
  const enabled = parsed.enabled === undefined ? true : Boolean(parsed.enabled);
  const command = typeof parsed.command === "string" && parsed.command.trim()
    ? parsed.command.trim()
    : resolveManagedCommandDefault(
        typeof parsed.kind === "string" ? parsed.kind as Agent["kind"] : "other",
        runtimeMode as AgentRuntimeMode,
      );
  const endpoint = typeof parsed.endpoint === "string" && parsed.endpoint.trim()
    ? parsed.endpoint.trim()
    : undefined;

  try {
    return await context.orch.registerAgent({
      name,
      kind: parsed.kind as Agent["kind"],
      role: parsed.role as Agent["role"],
      runtimeMode: runtimeMode as AgentRuntimeMode,
      transport: transport as Agent["transport"],
      enabled,
      ...(command ? { command } : {}),
      ...(endpoint ? { endpoint } : {}),
    });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}

function updateAgentFromBody(
  context: DashboardContext,
  agentId: string,
  body: unknown,
): Agent {
  const parsed = body as {
    name?: unknown;
    role?: unknown;
    runtime_mode?: unknown;
    enabled?: unknown;
    command?: unknown;
    endpoint?: unknown;
    cooldown_until?: unknown;
  };

  try {
    return context.orch.updateAgent(agentId, {
      ...(typeof parsed.name === "string" ? { name: parsed.name.trim() } : {}),
      ...(typeof parsed.role === "string" ? { role: parsed.role as Agent["role"] } : {}),
      ...(typeof parsed.runtime_mode === "string"
        ? { runtimeMode: parsed.runtime_mode as AgentRuntimeMode }
        : {}),
      ...(parsed.enabled !== undefined ? { enabled: Boolean(parsed.enabled) } : {}),
      ...(parsed.command !== undefined
        ? { command: typeof parsed.command === "string" ? parsed.command.trim() || null : null }
        : {}),
      ...(parsed.endpoint !== undefined
        ? { endpoint: typeof parsed.endpoint === "string" ? parsed.endpoint.trim() || null : null }
        : {}),
      ...(parsed.cooldown_until !== undefined
        ? {
            cooldownUntil:
              typeof parsed.cooldown_until === "string" && parsed.cooldown_until.trim()
                ? parsed.cooldown_until.trim()
                : null,
          }
        : {}),
    });
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
}

function deleteAgentById(
  context: DashboardContext,
  agentId: string,
): Agent {
  try {
    return context.orch.deleteAgent(agentId);
  } catch (error) {
    if (error instanceof AgentNotFoundError) {
      throw new HttpError(404, error.message);
    }
    if (error instanceof AgentDeleteConflictError) {
      throw new HttpError(409, error.message);
    }
    throw new HttpError(400, error instanceof Error ? error.message : String(error));
  }
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
      moveTaskFromDashboard(
        context,
        taskId,
        parseTaskStatus(parsed.target_status),
        typeof parsed.note === "string" ? parsed.note.trim() : "",
      );
      return;
    }
    case "approve":
      await context.orch.reviewDecision(taskId, { decision: "approve" });
      return;
    case "bounce": {
      const note = typeof parsed.note === "string" ? parsed.note.trim() : "";
      if (!note) throw new HttpError(400, "bounce requires a note");
      await context.orch.reviewDecision(taskId, { decision: "bounce", note });
      return;
    }
    case "cancel":
      await context.orch.cancelTask(taskId);
      return;
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

function parseTaskStatus(raw: string): TaskStatus {
  if (TASK_STATUS_ORDER.includes(raw as TaskStatus)) return raw as TaskStatus;
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
    ? candidate.deliverables
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const filesInScope = Array.isArray(candidate.files_in_scope)
    ? candidate.files_in_scope
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
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

function moveTaskFromDashboard(
  context: DashboardContext,
  taskId: string,
  targetStatus: TaskStatus,
  note: string,
): void {
  const task = selectTaskRowById(context.conn.raw, taskId);
  if (!task) throw new HttpError(404, `Task not found: ${taskId}`);
  const ts = new Date().toISOString();
  context.conn.raw
    .prepare(
      `UPDATE tasks
         SET status = ?,
             assigned_agent_id = NULL,
             worktree_path = NULL,
             claimed_at = NULL,
             last_heartbeat_at = NULL,
             updated_at = ?,
             status_note = ?
       WHERE id = ?`,
    )
    .run(targetStatus, ts, note || null, taskId);

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
        mode: "dashboard_override",
      }),
      null,
      task.status,
      targetStatus,
      ts,
    );
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
          WHEN 'todo' THEN 0
          WHEN 'planning' THEN 1
          WHEN 'in_progress' THEN 2
          WHEN 'review' THEN 3
          WHEN 'human_review' THEN 4
          WHEN 'done' THEN 5
          ELSE 6
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
      SELECT
        agents.*,
        COUNT(tasks.id) AS assigned_task_count,
        (
          SELECT COUNT(*)
          FROM approval_requests
          JOIN agent_sessions ON agent_sessions.id = approval_requests.session_id
          WHERE approval_requests.status = 'pending'
            AND agent_sessions.agent_id = agents.id
        ) AS pending_approval_count,
        (
          SELECT id
          FROM agent_sessions
          WHERE agent_sessions.agent_id = agents.id
            AND agent_sessions.ended_at IS NULL
          ORDER BY agent_sessions.started_at DESC
          LIMIT 1
        ) AS active_session_id
      FROM agents
      LEFT JOIN tasks ON tasks.assigned_agent_id = agents.id
      GROUP BY agents.id
      ORDER BY agents.role ASC, agents.name ASC
      `,
    )
    .all() as Array<AgentRow & {
      assigned_task_count: number;
      pending_approval_count: number;
      active_session_id: string | null;
    }>;

  return rows.map((row) => ({
    ...mapAgent(row),
    assigned_task_count: row.assigned_task_count,
    pending_approval_count: row.pending_approval_count,
    active_session_id: row.active_session_id,
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

function selectSessions(
  raw: OpenDatabaseResult["raw"],
  options: { managedOnly?: boolean } = {},
): DashboardSessionSummary[] {
  const rows = raw
    .prepare(
      `
      SELECT
        agent_sessions.*,
        agents.name AS agent_name,
        agents.kind AS agent_kind,
        agents.role AS agent_role,
        agents.transport AS transport,
        agents.runtime_mode AS runtime_mode,
        agents.command AS command,
        agents.endpoint AS endpoint,
        tasks.title AS task_title,
        (
          SELECT COUNT(*)
          FROM approval_requests
          WHERE approval_requests.session_id = agent_sessions.id
            AND approval_requests.status = 'pending'
        ) AS pending_approval_count
      FROM agent_sessions
      JOIN agents ON agents.id = agent_sessions.agent_id
      LEFT JOIN tasks ON tasks.id = agent_sessions.task_id
      ${options.managedOnly ? "WHERE agents.runtime_mode = 'managed'" : ""}
      ORDER BY agent_sessions.started_at DESC
      `,
    )
    .all() as SessionRow[];

  return rows.map(mapSession);
}

function selectSessionById(
  raw: OpenDatabaseResult["raw"],
  sessionId: string,
): DashboardSessionSummary | null {
  const row = raw
    .prepare(
      `
      SELECT
        agent_sessions.*,
        agents.name AS agent_name,
        agents.kind AS agent_kind,
        agents.role AS agent_role,
        agents.transport AS transport,
        agents.runtime_mode AS runtime_mode,
        agents.command AS command,
        agents.endpoint AS endpoint,
        tasks.title AS task_title,
        (
          SELECT COUNT(*)
          FROM approval_requests
          WHERE approval_requests.session_id = agent_sessions.id
            AND approval_requests.status = 'pending'
        ) AS pending_approval_count
      FROM agent_sessions
      JOIN agents ON agents.id = agent_sessions.agent_id
      LEFT JOIN tasks ON tasks.id = agent_sessions.task_id
      WHERE agent_sessions.id = ?
      `,
    )
    .get(sessionId) as SessionRow | undefined;

  return row ? mapSession(row) : null;
}

function selectApprovals(
  raw: OpenDatabaseResult["raw"],
  filter?: { sessionId?: string },
): DashboardApprovalSummary[] {
  const sql = `
    SELECT
      approval_requests.*,
      agents.name AS agent_name,
      tasks.title AS task_title
    FROM approval_requests
    JOIN agents ON agents.id = approval_requests.agent_id
    LEFT JOIN tasks ON tasks.id = approval_requests.task_id
    ${filter?.sessionId ? "WHERE approval_requests.session_id = ?" : ""}
    ORDER BY approval_requests.created_at DESC
  `;
  const rows = (filter?.sessionId
    ? raw.prepare(sql).all(filter.sessionId)
    : raw.prepare(sql).all()) as ApprovalRow[];
  return rows.map((row) => ({
    id: row.id,
    session_id: row.session_id,
    task_id: row.task_id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    task_title: row.task_title,
    kind: row.kind,
    status: row.status,
    title: row.title,
    body: row.body,
    response_note: row.response_note,
    created_at: row.created_at,
    resolved_at: row.resolved_at,
  }));
}

function mapTask(row: TaskRow, assignedAgentName: string | null): DashboardTaskSummary {
  const acceptance =
    row.acceptance_json !== null
      ? (JSON.parse(row.acceptance_json) as AcceptanceCriteria)
      : null;

  return {
    id: row.id,
    title: row.title,
    brief: row.brief,
    status: row.status as TaskStatus,
    priority: row.priority,
    assigned_agent_id: row.assigned_agent_id,
    assigned_agent_name: assignedAgentName,
    branch_name: row.branch_name,
    worktree_path: row.worktree_path,
    worktree_exists: row.worktree_path ? existsSync(row.worktree_path) : false,
    acceptance,
    review_bounce_count: row.review_bounce_count,
    last_role: row.last_role as AgentRole | null,
    status_note: row.status_note,
    created_at: row.created_at,
    updated_at: row.updated_at,
    claimed_at: row.claimed_at,
    last_heartbeat_at: row.last_heartbeat_at,
  };
}

function mapAgent(row: AgentRow): Agent {
  const agent: Agent = {
    id: row.id,
    name: row.name,
    kind: row.kind,
    role: row.role,
    runtime_mode: row.runtime_mode,
    transport: row.transport,
    enabled: Boolean(row.enabled),
    registered_at: row.registered_at,
    last_seen_at: row.last_seen_at,
    cooldown_until: row.cooldown_until,
    last_limit_reason: row.last_limit_reason as Agent["last_limit_reason"],
  };
  const effectiveCommand = row.command ?? resolveManagedCommandDefault(row.kind, row.runtime_mode);
  if (effectiveCommand !== undefined) agent.command = effectiveCommand;
  if (row.endpoint !== null) agent.endpoint = row.endpoint;
  return agent;
}

function mapSession(row: SessionRow): DashboardSessionSummary {
  return {
    id: row.id,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    agent_kind: row.agent_kind,
    agent_role: row.agent_role,
    transport: row.transport,
    runtime_mode: row.runtime_mode,
    command: row.command ?? resolveManagedCommandDefault(row.agent_kind, row.runtime_mode) ?? null,
    endpoint: row.endpoint,
    task_id: row.task_id,
    task_title: row.task_title,
    status: row.status,
    pid: row.pid,
    log_path: row.log_path,
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_seen_at: row.last_seen_at,
    last_error: row.last_error,
    pending_approval_count: row.pending_approval_count,
  };
}

function safeParseJson(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

function resolveManagedCommandDefault(
  kind: Agent["kind"],
  runtimeMode: AgentRuntimeMode,
): string | undefined {
  if (runtimeMode !== "managed") return undefined;
  return MANAGED_COMMAND_DEFAULTS[kind];
}

function resolveLaunchCommand(agent: Agent, body: string): string | null {
  const command = body.trim();
  if (!command) return null;
  if (agent.command?.trim() === command) return command;
  if (TERMINAL_RELAUNCH_COMMANDS.has(command)) return command;
  return null;
}

async function interruptSession(
  context: DashboardContext,
  sessionId: string,
): Promise<void> {
  const session = context.orch.getAgentSession(sessionId);
  context.orch.createSessionMessage({
    sessionId,
    direction: "human",
    kind: "signal",
    body: "^C",
  });
  await writeSessionLog(context, sessionId, "^C");

  const child = context.interactiveProcesses.get(sessionId);
  if (child) {
    if (child.kind === "pty") {
      child.pty.write("\u0003");
      try {
        child.pty.kill("SIGINT");
      } catch {
        // best-effort shutdown
      }
    } else {
      if (!(await screenSessionExists(child.sessionName))) {
        context.interactiveProcesses.delete(sessionId);
        context.orch.updateAgentSession(sessionId, {
          status: "stopped",
          endedAt: new Date().toISOString(),
          lastError: "Interrupted by user",
        });
        return;
      }
      await sendScreenInput(child.sessionName, "\u0003");
      await stopScreenSession(child.sessionName);
      context.interactiveProcesses.delete(sessionId);
      context.orch.updateAgentSession(sessionId, {
        status: "stopped",
        endedAt: new Date().toISOString(),
        pid: null,
        lastError: "Interrupted by user",
      });
      return;
    }
    return;
  }

  if (session.pid !== null) {
    try {
      process.kill(session.pid, "SIGINT");
      context.orch.updateAgentSession(sessionId, {
        lastError: "Interrupted by user",
      });
      return;
    } catch {
      context.orch.updateAgentSession(sessionId, {
        status: "stopped",
        endedAt: new Date().toISOString(),
        pid: null,
        lastError: "Interrupted by user",
      });
      return;
    }
  }

  context.orch.updateAgentSession(sessionId, {
    status: "stopped",
    endedAt: new Date().toISOString(),
    lastError: "Interrupted by user",
  });
}

async function startInteractiveTerminal(
  context: DashboardContext,
  sessionId: string,
  command: string,
): Promise<void> {
  const session = context.orch.getAgentSession(sessionId);
  const existing = context.interactiveProcesses.get(sessionId);
  if (existing) {
    if (existing.kind === "pty" || (await screenSessionExists(existing.sessionName))) {
      throw new HttpError(409, "session already has a running interactive terminal");
    }
    context.interactiveProcesses.delete(sessionId);
  }

  if (session.pid !== null && isProcessAlive(session.pid)) {
    throw new HttpError(409, "session already has a running process; interrupt it first");
  }

  const cwd = resolveSessionCwd(context, session);
  await writeSessionLog(context, sessionId, `$ ${command}`);
  const shell = resolveTerminalShell();
  const env = buildTerminalEnv();

  let child: IPty;
  try {
    child = spawnPty(shell, ["-lc", command], {
      name: "xterm-256color",
      cols: 120,
      rows: 32,
      cwd,
      env,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await writeSessionLog(context, sessionId, `interactive pty unavailable, falling back to screen: ${message}`);
    await startScreenTerminal(context, sessionId, command, cwd, env);
    return;
  }
  context.interactiveProcesses.set(sessionId, { kind: "pty", pty: child });

  context.orch.updateAgentSession(sessionId, {
    status: "busy",
    pid: child.pid ?? null,
    lastSeenAt: new Date().toISOString(),
    lastError: null,
  });

  child.onData((data) => {
    for (const line of data.split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      void writeSessionLog(context, sessionId, `[interactive] ${trimmed}`);
    }
    context.orch.updateAgentSession(sessionId, {
      lastSeenAt: new Date().toISOString(),
    });
  });

  child.onExit(({ exitCode, signal }) => {
    context.interactiveProcesses.delete(sessionId);
    const reason = signal ? `signal ${signal}` : `exit ${exitCode}`;
    void writeSessionLog(context, sessionId, `interactive process closed (${reason})`);
    context.orch.updateAgentSession(sessionId, {
      status: "stopped",
      endedAt: new Date().toISOString(),
      pid: null,
      lastError:
        signal === 2
          ? "Interrupted by user"
          : exitCode && exitCode !== 0
            ? `Process exited with code ${exitCode}`
            : null,
    });
  });
}

function resolveSessionCwd(context: DashboardContext, session: AgentSession): string {
  if (session.task_id) {
    try {
      const task = context.orch.getTask(session.task_id);
      if (task.worktree_path && existsSync(task.worktree_path)) return task.worktree_path;
    } catch {
      // ignore stale task references
    }
  }
  return context.options.repoRoot;
}

async function writeSessionLog(
  context: DashboardContext,
  sessionId: string,
  line: string,
): Promise<void> {
  const session = context.orch.getAgentSession(sessionId);
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  await mkdir(path.dirname(session.log_path), { recursive: true });
  await appendFile(session.log_path, stamped, "utf8");
  context.orch.updateAgentSession(sessionId, {
    lastSeenAt: new Date().toISOString(),
  });
}

async function deleteSessionById(
  context: DashboardContext,
  sessionId: string,
): Promise<DashboardSessionSummary> {
  const session = selectSessionById(context.conn.raw, sessionId);
  if (!session) throw new HttpError(404, `Session not found: ${sessionId}`);

  if (["busy", "waiting", "starting"].includes(session.status)) {
    throw new HttpError(409, "interrupt or stop the session before removing it");
  }

  const interactive = context.interactiveProcesses.get(sessionId);
  if (interactive) {
    if (interactive.kind === "pty") {
      try {
        interactive.pty.kill("SIGINT");
      } catch {
        // best effort
      }
    } else {
      try {
        await stopScreenSession(interactive.sessionName);
      } catch {
        // best effort
      }
    }
    context.interactiveProcesses.delete(sessionId);
  }

  await removeSessionArtifacts(session.log_path);
  context.conn.raw.prepare("DELETE FROM agent_sessions WHERE id = ?").run(sessionId);
  return session;
}

async function clearSessionHistory(context: DashboardContext): Promise<number> {
  const sessions = selectSessions(context.conn.raw, { managedOnly: true }).filter((session) =>
    ["stopped", "errored"].includes(session.status)
  );

  for (const session of sessions) {
    await removeSessionArtifacts(session.log_path);
  }

  const info = context.conn.raw
    .prepare("DELETE FROM agent_sessions WHERE status IN ('stopped', 'errored')")
    .run();
  return info.changes;
}

async function removeSessionArtifacts(logPath: string): Promise<void> {
  await Promise.allSettled([
    rm(logPath, { force: true }),
    rm(`${logPath}.screen`, { force: true }),
  ]);
}

async function respondToManagedAgentMessage(
  context: DashboardContext,
  session: AgentSession,
  agent: Agent,
  message: string,
): Promise<void> {
  const task = await resolveSessionContextTask(context, session);
  const plan = task ? await context.orch.readArtifact(task.id, "execution_plan") : null;
  const reviewReport = task ? await context.orch.readArtifact(task.id, "review_report") : null;

  let reply = buildContextualFallbackReply(message, task, plan, reviewReport);

  if (!reply && agent.kind === "codex") {
    reply = await tryCodexAgentReply({
      context,
      agent,
      session,
      task,
      plan,
      reviewReport,
      question: message,
    });
  }

  if (!reply) {
    reply = task
      ? `I have context for task "${task.title}" (${task.status}), but I don't have a direct answer for that question yet.`
      : "I don't have task context attached to this session, so I can't answer that question reliably.";
  }

  context.orch.createSessionMessage({
    sessionId: session.id,
    direction: "agent",
    kind: "reply",
    body: reply,
  });
  await writeSessionLog(context, session.id, `[agent/reply] ${reply}`);
}

async function resolveSessionContextTask(
  context: DashboardContext,
  session: AgentSession,
): Promise<DashboardTaskSummary | null> {
  if (session.task_id) {
    const task = selectTaskById(context.conn.raw, session.task_id);
    if (task) return task;
  }

  const latest = context.conn.raw
    .prepare(
      `
      SELECT task_id
      FROM task_events
      WHERE actor_agent_id = ?
      ORDER BY created_at DESC
      LIMIT 1
      `,
    )
    .get(session.agent_id) as { task_id: string } | undefined;
  if (!latest?.task_id) return null;
  return selectTaskById(context.conn.raw, latest.task_id);
}

function buildContextualFallbackReply(
  question: string,
  task: DashboardTaskSummary | null,
  plan: string | null,
  reviewReport: string | null,
): string | null {
  const normalized = question.trim().toLowerCase();
  if (!normalized) return null;

  if ((/\bplan\b/.test(normalized) || /\bpiano\b/.test(normalized)) && plan?.trim()) {
    return `My latest plan for "${task?.title ?? "this task"}" was:\n\n${plan.trim()}`;
  }

  if ((/\breview\b/.test(normalized) || /\bbounce\b/.test(normalized) || /perch[ée]/.test(normalized)) && reviewReport?.trim()) {
    return `My latest review note was:\n\n${reviewReport.trim()}`;
  }

  if (/\bwhat are you doing\b/.test(normalized) || /\bcosa stai facendo\b/.test(normalized) || /\bstatus\b/.test(normalized)) {
    if (!task) return "I don't have an active task bound to this session right now.";
    return `I'm working with task "${task.title}" in status "${task.status}".${plan?.trim() ? ` I also have an execution plan ready.` : ""}`;
  }

  return null;
}

async function tryCodexAgentReply(input: {
  context: DashboardContext;
  agent: Agent;
  session: AgentSession;
  task: DashboardTaskSummary | null;
  plan: string | null;
  reviewReport: string | null;
  question: string;
}): Promise<string | null> {
  const { context, agent, session, task, plan, reviewReport, question } = input;
  const runtimeDir = path.join(context.options.repoRoot, ".deltapilot", "dashboard-tmp");
  await mkdir(runtimeDir, { recursive: true });
  const outputPath = path.join(runtimeDir, `${session.id}-reply.txt`);
  const prompt = [
    "You are the DeltaPipeline managed agent answering a human from the dashboard.",
    "Reply directly, concisely, and in plain text.",
    "Do not modify files. Do not create commits. Do not ask follow-up questions unless there is no context.",
    task
      ? [
          `Task ID: ${task.id}`,
          `Title: ${task.title}`,
          `Brief: ${task.brief || "(empty)"}`,
          `Current status: ${task.status}`,
          plan?.trim() ? `Execution plan:\n${plan.trim()}` : "",
          reviewReport?.trim() ? `Review report:\n${reviewReport.trim()}` : "",
        ].filter(Boolean).join("\n\n")
      : "No task context is currently attached to this session.",
    `Human question: ${question}`,
  ].join("\n\n");

  const cwd = task?.worktree_path && existsSync(task.worktree_path)
    ? task.worktree_path
    : context.options.repoRoot;
  const base = (agent.command?.trim() || "codex").trim();
  const command = `${base} exec --cd ${sh(cwd)} --color never --sandbox read-only --ephemeral --output-last-message ${sh(outputPath)} -`;
  const shell = process.env.SHELL || "/bin/zsh";

  const result = await new Promise<{ code: number | null; combined: string }>((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(shell, ["-lc", command], {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      resolve({ code: 1, combined: `${stderr}\n${stdout}\n${error.message}`.trim() });
    });
    child.on("close", (code) => {
      resolve({ code, combined: `${stderr}\n${stdout}`.trim() });
    });
    child.stdin.end(prompt);
  });

  const lastMessage = await readFile(outputPath, "utf8").catch(() => "");
  await rm(outputPath, { force: true }).catch(() => undefined);
  if (result.code !== 0) {
    await writeSessionLog(
      context,
      session.id,
      `[agent/reply-error] ${result.combined || `codex reply exited with status ${result.code ?? "unknown"}`}`,
    );
    return null;
  }

  const reply = lastMessage.trim();
  return reply || null;
}

function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolveTerminalShell(): string {
  const candidates = [process.env.SHELL, "/bin/zsh", "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return "/bin/sh";
}

function buildTerminalEnv(): Record<string, string> {
  const envEntries = Object.entries(process.env).filter((entry): entry is [string, string] =>
    typeof entry[1] === "string"
  );
  return {
    ...Object.fromEntries(envEntries),
    TERM: "xterm-256color",
    COLORTERM: process.env.COLORTERM || "truecolor",
  };
}

async function startScreenTerminal(
  context: DashboardContext,
  sessionId: string,
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<void> {
  const sessionName = screenSessionNameFor(sessionId);
  await execFileAsync("/usr/bin/screen", ["-dmS", sessionName, resolveTerminalShell()], {
    cwd,
    env,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  await sendScreenInput(sessionName, `${command}\r`);
  context.interactiveProcesses.set(sessionId, { kind: "screen", sessionName });
  context.orch.updateAgentSession(sessionId, {
    status: "busy",
    pid: null,
    lastSeenAt: new Date().toISOString(),
    lastError: null,
  });
  await syncScreenTranscript(context, sessionId, sessionName);
}

function screenSessionNameFor(sessionId: string): string {
  return `deltapilot-${sessionId}`;
}

async function screenSessionExists(sessionName: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/screen", ["-ls"]);
    return stdout.includes(`.${sessionName}\t`) || stdout.includes(`.${sessionName} `);
  } catch (error) {
    const stdout = typeof error === "object" && error !== null && "stdout" in error
      ? String((error as { stdout?: unknown }).stdout ?? "")
      : "";
    return stdout.includes(`.${sessionName}\t`) || stdout.includes(`.${sessionName} `);
  }
}

async function sendScreenInput(sessionName: string, input: string): Promise<void> {
  await execFileAsync("/usr/bin/screen", ["-S", sessionName, "-p", "0", "-X", "stuff", input]);
}

async function stopScreenSession(sessionName: string): Promise<void> {
  await execFileAsync("/usr/bin/screen", ["-S", sessionName, "-X", "quit"]);
}

async function syncScreenTranscript(
  context: DashboardContext,
  sessionId: string,
  sessionName: string,
): Promise<string> {
  const session = context.orch.getAgentSession(sessionId);
  const hardcopyPath = `${session.log_path}.screen`;
  await mkdir(path.dirname(hardcopyPath), { recursive: true });
  await execFileAsync("/usr/bin/screen", ["-S", sessionName, "-p", "0", "-X", "hardcopy", "-h", hardcopyPath]);
  if (!existsSync(hardcopyPath)) return "";
  const raw = await readFile(hardcopyPath, "utf8");
  return raw.slice(-24_000);
}
