const STATUS_ORDER = [
  "todo",
  "planning",
  "in_progress",
  "review",
  "human_review",
  "merging",
  "done",
  "cancelled",
];

const STATUS_TITLES = {
  todo: "To Do",
  planning: "Planning",
  in_progress: "In Progress",
  review: "Review",
  human_review: "Human Review",
  merging: "Merging",
  done: "Done",
  cancelled: "Cancelled",
};

const EVENT_TITLES = {
  create: "Created",
  start_planning: "Planner Claimed",
  plan_ready: "Plan Published",
  start_execution: "Executor Claimed",
  execution_ready: "Submitted For Review",
  start_review: "Reviewer Claimed",
  queue_merge: "Queued For Merge",
  start_merge: "Merger Claimed",
  review_decision: "Review Decision",
  enter_human_review: "Escalated To Human Review",
  merge_result: "Merge Result",
  return_to_todo: "Returned To To Do",
  report_limit: "Reported Limit",
  cancel: "Cancelled",
  dashboard_move: "Moved From Dashboard",
  dashboard_archive: "Archived",
  dashboard_restore: "Restored To Board",
};

const BOARD_EVENT_PREVIEW_COUNT = 4;
const POLL_INTERVAL_MS = 10_000;
const TERMINAL_THEME_STORAGE_KEY = "deltapilot-terminal-theme";
const TERMINAL_THEME_OPTIONS = {
  white: "White",
  matrix: "Green",
};

const PRIORITY_TITLES = {
  max: "Max",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const MANAGED_COMMAND_PRESETS = {
  codex: ["codex"],
  "claude-code": ["claude"],
  "claude-sdk": ["claude"],
  openclaw: ["openclaw gateway start"],
  ollama: ["ollama run qwen2.5-coder:7b"],
  opendevin: ["opendevin"],
  hermes: ["hermes"],
  mock: [],
  other: [],
};

const HUMAN_REVIEW_REASON_TITLES = {
  approval: "Awaiting PR Approval",
  bounce_escalation: "Escalated After Repeated Bounce",
  merge_conflict: "Merge Conflict",
};

const state = {
  snapshot: null,
  approvals: [],
  selectedTaskId: null,
  taskDetail: null,
  selectedSessionId: null,
  sessionDetail: null,
  terminalBuffers: {},
  focusedTerminalSessionId: null,
  activeTab: "board",
  boardView: "active",
  dragTaskId: null,
  moveInFlight: false,
  attachmentUploadInFlight: false,
  expandedTaskEvents: {},
  terminalTheme: loadStoredTerminalTheme(),
};

const statsStrip = document.querySelector("#statsStrip");
const board = document.querySelector("#board");
const taskDetail = document.querySelector("#taskDetail");
const boardKicker = document.querySelector("#boardKicker");
const boardTitle = document.querySelector("#boardTitle");
const boardViewTabs = document.querySelector("#boardViewTabs");
const boardActions = document.querySelector("#boardActions");
const handoffList = document.querySelector("#handoffList");
const refreshButton = document.querySelector("#refreshButton");
const createTaskForm = document.querySelector("#createTaskForm");
const registerAgentForm = document.querySelector("#registerAgentForm");
const agentsList = document.querySelector("#agentsList");
const runsList = document.querySelector("#runsList");
const sessionsList = document.querySelector("#sessionsList");
const sessionDetail = document.querySelector("#sessionDetail");
const approvalList = document.querySelector("#approvalList");
const toastContainer = document.querySelector("#toastContainer");
const tabBar = document.querySelector("#tabBar");
const registerAgentFields = {
  kind: registerAgentForm.querySelector('select[name="kind"]'),
  role: registerAgentForm.querySelector('select[name="role"]'),
  runtimeMode: registerAgentForm.querySelector('select[name="runtime_mode"]'),
  transport: registerAgentForm.querySelector('select[name="transport"]'),
  command: registerAgentForm.querySelector('input[name="command"]'),
  endpoint: registerAgentForm.querySelector('input[name="endpoint"]'),
  commandHint: document.querySelector("#commandHint"),
  endpointHint: document.querySelector("#endpointHint"),
  commandSuggestions: document.querySelector("#managedCommandSuggestions"),
};

refreshButton.addEventListener("click", () => void refreshAll());
createTaskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createTask().catch(reportError);
});
registerAgentForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void registerAgent().catch(reportError);
});
registerAgentFields.kind.addEventListener("change", () => syncRegisterAgentForm({ autofill: true }));
registerAgentFields.runtimeMode.addEventListener("change", () => syncRegisterAgentForm({ autofill: true }));

tabBar.querySelectorAll("[data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    state.activeTab = button.dataset.tab;
    void refreshAll({ quiet: true }).catch(reportError);
  });
});

setInterval(() => {
  void refreshAll({ quiet: true }).catch(reportError);
}, POLL_INTERVAL_MS);

applyTerminalTheme();
syncRegisterAgentForm({ autofill: true });
void refreshAll().catch(reportError);

async function refreshAll(options = {}) {
  const snapshot = await fetchJson("/api/dashboard");
  state.snapshot = snapshot;
  state.approvals = snapshot.approvals ?? [];

  syncSelectedTaskId(snapshot);

  if (state.taskDetail && state.taskDetail.task.id !== state.selectedTaskId) {
    state.taskDetail = null;
  }

  if (!state.selectedSessionId) {
    state.selectedSessionId = snapshot.sessions[0]?.id ?? null;
  } else if (!snapshot.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = snapshot.sessions[0]?.id ?? null;
  }

  if (state.activeTab === "board") {
    await refreshSelectedTaskDetail();
  }

  if (
    state.activeTab === "sessions" &&
    state.selectedSessionId
  ) {
    state.sessionDetail = await fetchJson(`/api/sessions/${state.selectedSessionId}`);
  } else if (!state.selectedSessionId) {
    state.sessionDetail = null;
  }

  render();
  if (!options.quiet) {
    flashRefresh();
  }
}

function getBoardTasks(view = state.boardView, snapshot = state.snapshot) {
  if (!snapshot) return [];
  return snapshot.tasks.filter((task) => (
    view === "archived" ? Boolean(task.archived_at) : !task.archived_at
  ));
}

function preferredTask(tasks) {
  return tasks.find((task) => !["done", "cancelled"].includes(task.status)) ?? tasks[0] ?? null;
}

function syncSelectedTaskId(snapshot = state.snapshot) {
  if (!snapshot) {
    state.selectedTaskId = null;
    return;
  }

  const visibleTasks = getBoardTasks(state.boardView, snapshot);
  if (!state.selectedTaskId) {
    state.selectedTaskId = preferredTask(visibleTasks)?.id ?? null;
    return;
  }

  if (!snapshot.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = preferredTask(visibleTasks)?.id ?? null;
    return;
  }

  if (!visibleTasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = preferredTask(visibleTasks)?.id ?? null;
  }
}

async function refreshSelectedTaskDetail() {
  if (!state.selectedTaskId) {
    state.taskDetail = null;
    return;
  }
  state.taskDetail = await fetchJson(`/api/tasks/${state.selectedTaskId}`);
}

async function selectTask(taskId) {
  state.selectedTaskId = taskId;
  await refreshSelectedTaskDetail();
  state.activeTab = "board";
  render();
}

async function setBoardView(view) {
  if (view !== "active" && view !== "archived") return;
  if (state.boardView === view) return;

  const previousTaskId = state.selectedTaskId;
  state.boardView = view;
  syncSelectedTaskId();

  if (state.selectedTaskId !== previousTaskId || !state.taskDetail) {
    await refreshSelectedTaskDetail();
  }

  render();
}

async function createTask() {
  const form = new FormData(createTaskForm);
  const attachments = Array.from(createTaskForm.querySelector('input[name="attachments"]').files ?? []);
  const budget = compactObject({
    soft_attempts: parseOptionalInteger(form.get("soft_attempt_limit")),
    hard_attempts: parseOptionalInteger(form.get("hard_attempt_limit")),
    soft_cost_usd: parseOptionalNumber(form.get("soft_cost_limit_usd")),
    hard_cost_usd: parseOptionalNumber(form.get("hard_cost_limit_usd")),
  });
  const payload = {
    title: String(form.get("title") ?? "").trim(),
    brief: String(form.get("brief") ?? "").trim(),
    priority: String(form.get("priority") ?? "medium").trim().toLowerCase(),
    acceptance: {
      deliverables: splitLines(form.get("deliverables")),
    },
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
  };

  const detail = await fetchJson("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (attachments.length > 0) {
    await uploadTaskFiles(detail.task.id, attachments);
  }

  createTaskForm.reset();
  createTaskForm.querySelector('select[name="priority"]').value = "medium";
  state.selectedTaskId = detail.task.id;
  state.activeTab = "board";
  state.boardView = "active";
  await refreshAll();
}

async function registerAgent() {
  const form = new FormData(registerAgentForm);
  const payload = {
    name: String(form.get("name") ?? "").trim(),
    kind: String(form.get("kind") ?? "").trim(),
    role: String(form.get("role") ?? "").trim(),
    runtime_mode: String(form.get("runtime_mode") ?? "").trim(),
    transport: String(form.get("transport") ?? "").trim(),
    command: String(form.get("command") ?? "").trim(),
    endpoint: String(form.get("endpoint") ?? "").trim(),
    provider_family: String(form.get("provider_family") ?? "").trim(),
    model_id: String(form.get("model_id") ?? "").trim(),
    context_window: parseOptionalInteger(form.get("context_window")),
    cost_tier: String(form.get("cost_tier") ?? "").trim(),
    supports_tools: form.get("supports_tools") === "on",
    supports_patch: form.get("supports_patch") === "on",
    supports_review: form.get("supports_review") === "on",
    max_concurrency: parseOptionalInteger(form.get("max_concurrency")),
    fallback_priority: parseOptionalInteger(form.get("fallback_priority")),
    health_state: String(form.get("health_state") ?? "").trim(),
  };

  const agent = await fetchJson("/api/agents", {
    method: "POST",
    body: JSON.stringify(compactObject(payload)),
  });

  registerAgentForm.reset();
  registerAgentForm.querySelector('select[name="kind"]').value = "codex";
  registerAgentForm.querySelector('select[name="role"]').value = "planner";
  registerAgentForm.querySelector('select[name="runtime_mode"]').value = "managed";
  registerAgentForm.querySelector('select[name="transport"]').value = "mcp-stdio";
  syncRegisterAgentForm({ autofill: true, force: true });
  showToast(`Registered ${agent.name} (${agent.role})`, { kind: "ok" });
  state.activeTab = "agents";
  await refreshAll({ quiet: true });
}

function render() {
  if (!state.snapshot) return;
  renderTabs();
  renderStats();
  renderBoardControls();
  renderBoard();
  renderTaskDetail();
  renderHandoffs();
  renderAgents();
  renderRuns();
  renderApprovals();
  renderSessions();
  renderSessionDetail();
}

function renderTabs() {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === state.activeTab);
  });
  document.querySelectorAll("[data-panel]").forEach((panel) => {
    const active = panel.dataset.panel === state.activeTab;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  });
}

function renderStats() {
  const activeTasks = getBoardTasks("active");
  const counts = Object.fromEntries(STATUS_ORDER.map((status) => [status, 0]));
  for (const task of activeTasks) {
    counts[task.status] = (counts[task.status] ?? 0) + 1;
  }
  const archivedCount = getBoardTasks("archived").length;

  const items = STATUS_ORDER.map((status) => {
    const count = counts[status] ?? 0;
    return `
      <span class="stat-item">
        <span class="status-dot status-${status}"></span>
        ${STATUS_TITLES[status]}
        <strong>${count}</strong>
      </span>
    `;
  }).join("");

  statsStrip.innerHTML = `
    ${items}
    <span class="stat-item">
      Archived
      <strong>${archivedCount}</strong>
    </span>
    <span class="stat-item">
      Active Runs
      <strong>${state.snapshot.runs.filter((run) => run.ended_at === null).length}</strong>
    </span>
    <span class="stat-item">
      Pending Approvals
      <strong>${state.approvals.filter((approval) => approval.status === "pending").length}</strong>
    </span>
  `;
}

function renderBoardControls() {
  const activeCount = getBoardTasks("active").length;
  const archivedCount = getBoardTasks("archived").length;
  boardKicker.textContent = state.boardView === "archived" ? "Archived" : "Board";
  boardTitle.textContent = state.boardView === "archived" ? "Archived tasks" : "Active board";

  boardViewTabs.innerHTML = `
    <button class="tab-button board-toggle ${state.boardView === "active" ? "active" : ""}" data-board-view="active" type="button">
      Board
      <span class="pill">${activeCount}</span>
    </button>
    <button class="tab-button board-toggle ${state.boardView === "archived" ? "active" : ""}" data-board-view="archived" type="button">
      Archived
      <span class="pill">${archivedCount}</span>
    </button>
  `;

  boardActions.innerHTML = state.boardView === "active"
    ? `<button id="clearBoardButton" class="ghost-button board-clear-button" type="button" ${activeCount === 0 ? "disabled" : ""}>Clear</button>`
    : "";

  boardViewTabs.querySelectorAll("[data-board-view]").forEach((button) => {
    button.addEventListener("click", () => {
      void setBoardView(button.dataset.boardView).catch(reportError);
    });
  });

  boardActions.querySelector("#clearBoardButton")?.addEventListener("click", () => {
    if (activeCount === 0) return;
    if (!window.confirm(`Archive ${activeCount} task${activeCount === 1 ? "" : "s"} from the board?`)) return;
    void archiveBoard().catch(reportError);
  });
}

function renderBoard() {
  const visibleTasks = getBoardTasks();
  const tasksByStatus = new Map(STATUS_ORDER.map((status) => [status, []]));
  for (const task of visibleTasks) {
    tasksByStatus.get(task.status).push(task);
  }

  board.innerHTML = STATUS_ORDER.map((status) => {
    const tasks = tasksByStatus.get(status) ?? [];
    return `
      <section class="status-column" data-column-status="${status}">
        <header>
          <span class="column-title">
            <span class="status-dot status-${status}"></span>
            ${STATUS_TITLES[status]}
          </span>
          <span class="column-count">${tasks.length}</span>
        </header>
        <div class="card-stack">
          ${tasks.length > 0
            ? tasks
                .map(
                  (task) => `
                    <button
                      class="task-card ${state.selectedTaskId === task.id ? "selected" : ""}"
                      data-task-id="${task.id}"
                      type="button"
                      draggable="${state.boardView === "active" ? "true" : "false"}"
                    >
                      <div class="task-card-top">
                        <span class="priority">${escapeHtml(priorityTitle(task.priority_label))}</span>
                        <span class="pill">${task.last_role ? escapeHtml(task.last_role) : (task.assigned_agent_name ? escapeHtml(task.assigned_agent_name) : "queue")}</span>
                      </div>
                      <h3>${escapeHtml(task.title)}</h3>
                      ${state.boardView === "archived" && task.archived_at ? `<p class="task-card-subline">Archived ${escapeHtml(formatTimestamp(task.archived_at))}</p>` : ""}
                      ${task.status_note ? `<p class="task-card-subline">${escapeHtml(task.status_note)}</p>` : ""}
                      <footer>
                        <span>${task.assigned_agent_name ? escapeHtml(task.assigned_agent_name) : "unassigned"}</span>
                        <span>${formatTimestamp(state.boardView === "archived" && task.archived_at ? task.archived_at : task.updated_at)}</span>
                      </footer>
                    </button>
                  `,
                )
                .join("")
            : `<div class="column-empty">${state.boardView === "archived" ? "No archived tasks" : "No tasks"}</div>`}
        </div>
      </section>
    `;
  }).join("");

  board.querySelectorAll("[data-task-id]").forEach((card) => {
    card.addEventListener("click", () => {
      void selectTask(card.dataset.taskId).catch(reportError);
    });

    if (state.boardView !== "active") return;

    card.addEventListener("dragstart", (event) => {
      state.dragTaskId = card.dataset.taskId;
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", state.dragTaskId ?? "");
    });

    card.addEventListener("dragend", () => {
      state.dragTaskId = null;
      card.classList.remove("dragging");
      clearDropTargets();
    });
  });

  if (state.boardView !== "active") {
    return;
  }

  board.querySelectorAll("[data-column-status]").forEach((column) => {
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      column.classList.add("drop-target");
    });

    column.addEventListener("dragleave", (event) => {
      if (!column.contains(event.relatedTarget)) {
        column.classList.remove("drop-target");
      }
    });

    column.addEventListener("drop", (event) => {
      event.preventDefault();
      const taskId = state.dragTaskId || event.dataTransfer.getData("text/plain");
      const targetStatus = column.dataset.columnStatus;
      column.classList.remove("drop-target");
      if (!taskId || !targetStatus) return;
      state.selectedTaskId = taskId;
      void moveTask(taskId, targetStatus).catch(reportError);
    });
  });
}

function renderTaskDetail() {
  if (!state.taskDetail) {
    taskDetail.className = "task-detail empty-state";
    taskDetail.innerHTML = `
      <p class="panel-kicker">Task Detail</p>
      <h2>${state.boardView === "archived" ? "No archived task selected" : "No task selected"}</h2>
      <p>${state.boardView === "archived" ? "Open an archived task to inspect it or restore it to the board." : "Create or select a task to inspect its history."}</p>
    `;
    return;
  }

  const {
    task,
    events,
    artifacts,
    attachments,
    handoffs,
    attempts,
    candidate_pool: candidatePool,
    budget_summary: budgetSummary,
  } = state.taskDetail;
  const isArchived = Boolean(task.archived_at);
  const eventsExpanded = Boolean(state.expandedTaskEvents[task.id]);
  const shouldCollapseEvents = events.length > BOARD_EVENT_PREVIEW_COUNT;
  const visibleEvents = shouldCollapseEvents && !eventsExpanded
    ? events.slice(-BOARD_EVENT_PREVIEW_COUNT)
    : events;
  const acceptance = task.acceptance
    ? `
      <section class="detail-section">
        <p class="detail-label">Acceptance</p>
        ${task.acceptance.goal ? `<p>${escapeHtml(task.acceptance.goal)}</p>` : ""}
        ${task.acceptance.deliverables.length > 0
          ? `<ul class="detail-list">
              ${task.acceptance.deliverables.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
            </ul>`
          : ""}
        ${task.acceptance.files_in_scope.length > 0
          ? `<p class="muted">Files: ${task.acceptance.files_in_scope.map(escapeHtml).join(", ")}</p>`
          : ""}
        ${task.acceptance.success_test ? `<p class="muted">Success test: ${escapeHtml(task.acceptance.success_test)}</p>` : ""}
      </section>
    `
    : "";
  const humanReviewPacket = artifacts.find((artifact) => artifact.kind === "human_review_packet") ?? null;
  const mergeReport = artifacts.find((artifact) => artifact.kind === "merge_report") ?? null;
  const reviewPanel = renderReviewPanel(task, humanReviewPacket, mergeReport);

  taskDetail.className = "task-detail";
  taskDetail.innerHTML = `
    <div class="detail-header">
      <div>
        <p class="panel-kicker">Task Detail</p>
        <h2>${escapeHtml(task.title)}</h2>
        ${task.status_note ? `<p class="status-note">${escapeHtml(task.status_note)}</p>` : ""}
      </div>
      <div class="inline-actions">
        <span class="detail-status status-chip"><span class="status-dot status-${task.status}"></span>${STATUS_TITLES[task.status]}</span>
        ${isArchived ? `<span class="detail-status status-chip">Archived</span>` : ""}
      </div>
    </div>

    <section class="detail-section">
      <p class="detail-label">Summary</p>
      <p>${escapeHtml(task.brief || "No brief provided.")}</p>
      <div class="meta-grid">
        <span><strong>Priority</strong> ${escapeHtml(priorityTitle(task.priority_label))}</span>
        <span><strong>Board</strong> ${isArchived && task.archived_at ? `Archived ${escapeHtml(formatTimestamp(task.archived_at))}` : "Active"}</span>
        <span><strong>Assigned</strong> ${task.assigned_agent_name ? escapeHtml(task.assigned_agent_name) : "unassigned"}</span>
        <span><strong>Last Role</strong> ${task.last_role ? escapeHtml(task.last_role) : "none"}</span>
        <span><strong>Review Bounces</strong> ${task.review_bounce_count}</span>
        <span><strong>Human Review Reason</strong> ${task.human_review_reason ? escapeHtml(humanReviewReasonTitle(task.human_review_reason)) : "none"}</span>
        <span><strong>Branch</strong> ${task.branch_name ? escapeHtml(task.branch_name) : "none"}</span>
        <span><strong>Worktree</strong> ${task.worktree_exists ? "present" : "missing"}</span>
      </div>
      <p class="muted path-line">${task.worktree_path ? escapeHtml(task.worktree_path) : "No active worktree path."}</p>
    </section>

    ${renderBudgetSection(task, budgetSummary)}
    ${renderCandidatePoolSection(candidatePool)}
    ${renderAttemptsSection(attempts)}
    ${acceptance}
    ${reviewPanel}

    ${renderAttachmentsSection(task, attachments)}

    ${renderTaskActions(task)}

    <section class="detail-section">
      <div class="detail-label-row">
        <p class="detail-label">Task Events</p>
        ${shouldCollapseEvents
          ? `<button class="detail-inline-toggle" data-toggle-events type="button">${eventsExpanded ? "Collapse" : "Expand"}</button>`
          : ""}
      </div>
      ${shouldCollapseEvents && !eventsExpanded
        ? `<p class="timeline-summary">Showing the latest ${visibleEvents.length} of ${events.length} events.</p>`
        : ""}
      <div class="timeline">
        ${visibleEvents.length > 0
          ? visibleEvents
              .map(
                (event) => `
                  <article class="timeline-item">
                    <div class="timeline-line"></div>
                    <div>
                      <strong>${escapeHtml(EVENT_TITLES[event.kind] ?? event.kind)}</strong>
                      <p>${escapeHtml(statusTitle(event.from_status))} -> ${escapeHtml(statusTitle(event.to_status))}</p>
                      <p class="muted">${formatTimestamp(event.created_at)}${event.actor_agent_name ? ` · ${escapeHtml(event.actor_agent_name)}` : ""}</p>
                      ${event.payload ? `<pre>${escapeHtml(JSON.stringify(event.payload, null, 2))}</pre>` : ""}
                    </div>
                  </article>
                `,
              )
              .join("")
          : `<p class="small-empty">No events yet.</p>`}
      </div>
    </section>

    <section class="detail-section">
      <p class="detail-label">Artifacts</p>
      ${artifacts.length > 0
        ? artifacts
            .map(
              (artifact) => `
                <article class="artifact-card">
                  <div class="agent-topline">
                    <strong>${escapeHtml(artifact.kind)}</strong>
                    <span class="pill">${artifact.author_agent_name ? escapeHtml(artifact.author_agent_name) : "system"}</span>
                  </div>
                  <p class="muted path-line">${escapeHtml(artifact.path)}</p>
                  ${artifact.content ? `<pre>${escapeHtml(artifact.content)}</pre>` : `<p class="muted">Artifact file missing on disk.</p>`}
                </article>
              `,
            )
            .join("")
        : `<p class="small-empty">No artifacts stored for this task.</p>`}
    </section>

    <section class="detail-section">
      <p class="detail-label">Handoffs</p>
      ${handoffs.length > 0
        ? handoffs
            .map(
              (handoff) => `
                <article class="handoff-card detail-handoff">
                  <div class="agent-topline">
                    <strong>${escapeHtml(handoff.reason)}</strong>
                    <span class="pill">${escapeHtml(handoff.from_agent_name ?? handoff.from_agent_id)}</span>
                  </div>
                  <p class="muted">${formatTimestamp(handoff.created_at)}</p>
                  <p class="muted">Snapshot: ${handoff.snapshot_commit ? escapeHtml(handoff.snapshot_commit) : "none"}</p>
                </article>
              `,
            )
            .join("")
        : `<p class="small-empty">No handoffs for this task.</p>`}
    </section>
  `;

  taskDetail.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const action = button.dataset.action;
      const note = taskDetail.querySelector("#taskActionNote")?.value?.trim() ?? "";
      if (action === "move") {
        const target = taskDetail.querySelector("#moveTarget")?.value;
        if (!target) return;
        void moveTask(task.id, target, note).catch(reportError);
      } else if (action === "approve") {
        void taskAction(task.id, "approve", note).catch(reportError);
      } else if (action === "bounce") {
        void taskAction(task.id, "bounce", note).catch(reportError);
      } else if (action === "archive") {
        void taskAction(task.id, "archive", note).catch(reportError);
      } else if (action === "restore") {
        void taskAction(task.id, "restore", note).catch(reportError);
      } else if (action === "cancel") {
        void taskAction(task.id, "cancel", note).catch(reportError);
      } else if (action === "return_to_todo") {
        void returnTaskToTodo(task.id, note).catch(reportError);
      }
    });
  });

  taskDetail.querySelector("[data-toggle-events]")?.addEventListener("click", () => {
    state.expandedTaskEvents[task.id] = !eventsExpanded;
    renderTaskDetail();
  });

  const attachmentForm = taskDetail.querySelector("#attachmentUploadForm");
  attachmentForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const files = Array.from(attachmentForm.querySelector('input[name="attachments"]').files ?? []);
    void uploadAttachmentsForSelectedTask(files).catch(reportError);
  });

  bindOpenTaskButtons(taskDetail);
}

function renderAttachmentsSection(task, attachments) {
  const agentMountPath = task.worktree_path ? `${task.worktree_path}/.deltapilot/attachments` : null;

  return `
    <section class="detail-section">
      <div class="detail-section-header">
        <div>
          <p class="detail-label">Attachments</p>
          <p class="muted">
            ${agentMountPath
              ? `Mounted for agents at ${escapeHtml(agentMountPath)}`
              : "Attachments mount into the task worktree once the task is claimed."}
          </p>
        </div>
        <span class="pill">${attachments.length} file${attachments.length === 1 ? "" : "s"}</span>
      </div>

      <form id="attachmentUploadForm" class="attachment-upload-form">
        <label>
          <span>Add files</span>
          <input
            name="attachments"
            type="file"
            multiple
            accept="image/*,.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.doc,.docx,.rtf,.odt,.pdf,video/*,audio/*"
          />
        </label>
        <button class="secondary-button" type="submit">Upload</button>
      </form>

      ${attachments.length > 0
        ? `<div class="attachment-list">${attachments.map((attachment) => renderAttachmentCard(task.id, attachment)).join("")}</div>`
        : `<p class="small-empty">No attachments uploaded for this task.</p>`}
    </section>
  `;
}

function renderReviewPanel(task, humanReviewPacket, mergeReport) {
  const pullRequest = task.pull_request;
  const shouldShowPr = Boolean(pullRequest);
  const shouldShowReport = Boolean(humanReviewPacket?.content || mergeReport?.content);

  if (!shouldShowPr && !shouldShowReport && !task.human_review_reason) {
    return "";
  }

  return `
    <section class="detail-section">
      <p class="detail-label">Review And Merge</p>
      ${task.human_review_reason
        ? `<p class="muted">Human review reason: ${escapeHtml(humanReviewReasonTitle(task.human_review_reason))}</p>`
        : ""}
      ${shouldShowPr
        ? `
          <div class="meta-grid">
            <span><strong>PR</strong> ${pullRequest.url ? `<a class="secondary-link" href="${escapeHtml(pullRequest.url)}" target="_blank" rel="noreferrer">#${escapeHtml(String(pullRequest.number ?? "?"))}</a>` : escapeHtml(String(pullRequest.number ?? "none"))}</span>
            <span><strong>Approval</strong> ${escapeHtml(pullRequest.review_decision ?? "UNKNOWN")}</span>
            <span><strong>Base</strong> ${escapeHtml(pullRequest.base_branch)}</span>
            <span><strong>Head</strong> ${escapeHtml(pullRequest.head_branch)}</span>
            <span><strong>Head SHA</strong> ${escapeHtml(pullRequest.head_sha ?? "none")}</span>
            <span><strong>Merged SHA</strong> ${escapeHtml(pullRequest.merged_sha ?? "none")}</span>
          </div>
          ${pullRequest.last_error ? `<p class="status-note">${escapeHtml(pullRequest.last_error)}</p>` : ""}
          ${pullRequest.last_synced_at ? `<p class="muted">Last synced ${escapeHtml(formatTimestamp(pullRequest.last_synced_at))}</p>` : ""}
        `
        : ""}
      ${humanReviewPacket?.content
        ? `
          <p class="muted">Local verification and diff summary</p>
          <pre>${escapeHtml(humanReviewPacket.content)}</pre>
        `
        : ""}
      ${mergeReport?.content
        ? `
          <p class="muted">Merge report</p>
          <pre>${escapeHtml(mergeReport.content)}</pre>
        `
        : ""}
    </section>
  `;
}

function renderBudgetSection(task, summary) {
  const limitSummary = task.budget
    ? `
      <div class="meta-grid">
        <span><strong>Soft Attempts</strong>${task.budget.soft_attempts ?? "none"}</span>
        <span><strong>Hard Attempts</strong>${task.budget.hard_attempts ?? "none"}</span>
        <span><strong>Soft Cost</strong>${formatUsd(task.budget.soft_cost_usd)}</span>
        <span><strong>Hard Cost</strong>${formatUsd(task.budget.hard_cost_usd)}</span>
      </div>
    `
    : `<p class="small-empty">No explicit task budget. Routing currently follows role, health, and fallback policy.</p>`;

  return `
    <section class="detail-section">
      <div class="detail-section-header">
        <div>
          <p class="detail-label">Budget & Routing</p>
          <p class="muted">Attempt ledger and completion-first guardrails for this task.</p>
        </div>
        <div class="badge-row">
          ${summary.soft_exceeded ? `<span class="pill warning-pill">Soft exceeded</span>` : `<span class="pill">Soft OK</span>`}
          ${summary.hard_exceeded ? `<span class="pill danger-pill">Hard exceeded</span>` : `<span class="pill ok-pill">Hard OK</span>`}
        </div>
      </div>
      ${limitSummary}
      <div class="meta-grid">
        <span><strong>Total Attempts</strong>${summary.total_attempts}</span>
        <span><strong>Total Cost</strong>${formatUsd(summary.total_cost_usd)}</span>
        <span><strong>Soft Remaining</strong>${formatRemaining(summary.soft_attempts_remaining, summary.soft_cost_remaining_usd)}</span>
        <span><strong>Hard Remaining</strong>${formatRemaining(summary.hard_attempts_remaining, summary.hard_cost_remaining_usd)}</span>
      </div>
    </section>
  `;
}

function renderCandidatePoolSection(candidatePool) {
  return `
    <section class="detail-section">
      <div class="detail-section-header">
        <div>
          <p class="detail-label">Candidate Pool</p>
          <p class="muted">Managed agents ranked for the next claim or fallback.</p>
        </div>
        <span class="pill">${candidatePool.length} candidate${candidatePool.length === 1 ? "" : "s"}</span>
      </div>
      ${candidatePool.length > 0
        ? `<div class="candidate-list">${candidatePool.map(renderCandidateCard).join("")}</div>`
        : `<p class="small-empty">No managed candidates are currently eligible for this task status.</p>`}
    </section>
  `;
}

function renderCandidateCard(candidate) {
  return `
    <article class="candidate-card ${candidate.blocked ? "is-blocked" : ""}">
      <div class="agent-topline">
        <strong>${escapeHtml(candidate.agent_name ?? candidate.agent_id)}</strong>
        <div class="badge-row">
          <span class="pill">${escapeHtml(candidate.role)}</span>
          <span class="pill">${escapeHtml(candidate.kind)}</span>
          ${candidate.blocked ? `<span class="pill danger-pill">blocked</span>` : `<span class="pill ok-pill">ready</span>`}
        </div>
      </div>
      <p class="muted">Router score ${formatScore(candidate.score)}</p>
      <p>${candidate.reasons.length > 0 ? candidate.reasons.map(escapeHtml).join(" · ") : "No routing notes."}</p>
    </article>
  `;
}

function renderAttemptsSection(attempts) {
  return `
    <section class="detail-section">
      <div class="detail-section-header">
        <div>
          <p class="detail-label">Attempt Timeline</p>
          <p class="muted">Token, latency, cost, and fallback chain for this task.</p>
        </div>
        <span class="pill">${attempts.length} run${attempts.length === 1 ? "" : "s"}</span>
      </div>
      ${attempts.length > 0
        ? `<div class="run-list compact-run-list">${attempts.map((attempt) => renderRunCard(attempt, { compact: true })).join("")}</div>`
        : `<p class="small-empty">No attempts recorded yet.</p>`}
    </section>
  `;
}

function renderAttachmentCard(taskId, attachment) {
  return `
    <article class="attachment-card">
      <div class="attachment-header">
        <div>
          <strong>${escapeHtml(attachment.original_name)}</strong>
          <p class="muted">${escapeHtml(attachment.category)} · ${escapeHtml(formatBytes(attachment.size_bytes))}</p>
        </div>
        <div class="attachment-actions">
          <a class="secondary-link" href="${attachmentOpenUrl(taskId, attachment.id)}" target="_blank" rel="noreferrer">Open</a>
          <a class="secondary-link" href="${attachmentDownloadUrl(taskId, attachment.id)}">Download</a>
        </div>
      </div>
      <p class="muted path-line">${escapeHtml(attachment.stored_path)}</p>
      ${renderAttachmentPreview(taskId, attachment)}
    </article>
  `;
}

function renderAttachmentPreview(taskId, attachment) {
  const previewUrl = attachmentOpenUrl(taskId, attachment.id);

  if (attachment.category === "image") {
    return `<img class="attachment-preview attachment-image" src="${previewUrl}" alt="${escapeHtml(attachment.original_name)}" loading="lazy" />`;
  }

  if (attachment.category === "audio") {
    return `<audio class="attachment-preview" controls preload="metadata" src="${previewUrl}"></audio>`;
  }

  if (attachment.category === "video") {
    return `<video class="attachment-preview attachment-video" controls preload="metadata" src="${previewUrl}"></video>`;
  }

  if (attachment.category === "pdf") {
    return `
      <object class="attachment-preview attachment-pdf" data="${previewUrl}" type="application/pdf">
        <a class="secondary-link" href="${previewUrl}" target="_blank" rel="noreferrer">Open PDF</a>
      </object>
    `;
  }

  if (attachment.category === "text" && attachment.preview_text !== null) {
    return `
      <pre class="attachment-text-preview">${escapeHtml(attachment.preview_text)}${attachment.preview_truncated ? "\n…" : ""}</pre>
    `;
  }

  return `<p class="muted">Inline preview is not available for this file type.</p>`;
}

function attachmentOpenUrl(taskId, attachmentId) {
  return `/api/tasks/${taskId}/attachments/${attachmentId}`;
}

function attachmentDownloadUrl(taskId, attachmentId) {
  return `/api/tasks/${taskId}/attachments/${attachmentId}?download=1`;
}

function renderTaskActions(task) {
  const reviewButtons = task.status === "review"
    ? `
      <div class="inline-actions">
        <button class="primary-button" data-action="approve" type="button">Approve For Human Review</button>
        <button class="secondary-button" data-action="bounce" type="button">Bounce</button>
      </div>
    `
    : "";
  const humanButton = task.status === "human_review"
    ? `<button class="primary-button" data-action="return_to_todo" type="button">Return To To Do</button>`
    : "";
  const mergingNote = task.status === "merging"
    ? `<p class="muted">Merge is in progress. Actions are intentionally limited while the merger agent is working.</p>`
    : "";
  const archiveButton = task.archived_at
    ? `<button class="primary-button" data-action="restore" type="button">Restore To Board</button>`
    : `<button class="secondary-button" data-action="archive" type="button">Archive Task</button>`;
  const canMove = task.status !== "merging";

  return `
    <section class="detail-section action-section">
      <p class="detail-label">Task Actions</p>
      ${canMove
        ? `
          <div class="move-grid">
            <label>
              <span>Target status</span>
              <select id="moveTarget">
                ${STATUS_ORDER.map(
                  (status) => `<option value="${status}" ${status === task.status ? "selected" : ""}>${STATUS_TITLES[status]}</option>`,
                ).join("")}
              </select>
            </label>
            <button class="secondary-button" data-action="move" type="button">Move</button>
          </div>
          <label>
            <span>Action note</span>
            <textarea id="taskActionNote" rows="3" placeholder="Optional context for bounce, return to queue, or manual move"></textarea>
          </label>
        `
        : mergingNote}
      ${reviewButtons}
      ${humanButton}
      <div class="inline-actions">
        ${archiveButton}
        <button class="secondary-button" data-action="cancel" type="button">Cancel Task</button>
      </div>
    </section>
  `;
}

function renderHandoffs() {
  if (state.snapshot.recent_handoffs.length === 0) {
    handoffList.innerHTML = `<p class="small-empty">No handoffs recorded yet.</p>`;
    return;
  }

  handoffList.innerHTML = state.snapshot.recent_handoffs
    .map(
      (handoff) => `
        <article class="handoff-card">
          <div class="agent-topline">
            <strong>${escapeHtml(handoff.task_title)}</strong>
            <span class="pill handoff-pill">${escapeHtml(handoff.reason)}</span>
          </div>
          <p>${escapeHtml(handoff.from_agent_name ?? handoff.from_agent_id)}</p>
          <p class="muted">${formatTimestamp(handoff.created_at)}</p>
        </article>
      `,
    )
    .join("");
}

function renderAgents() {
  if (state.snapshot.agents.length === 0) {
    agentsList.innerHTML = `<p class="small-empty">No registered agents yet.</p>`;
    return;
  }

  const roleOrder = ["planner", "executor", "reviewer", "merger"];
  agentsList.innerHTML = roleOrder
    .map((role) => {
      const agents = state.snapshot.agents.filter((agent) => agent.role === role);
      return `
        <section class="pool-group">
          <div class="pool-group-header">
            <div>
              <p class="detail-label">${escapeHtml(role)}</p>
              <p class="muted">${agents.length} registered candidate${agents.length === 1 ? "" : "s"}.</p>
            </div>
          </div>
          ${agents.length > 0
            ? `<div class="agent-grid">${agents.map(renderAgentCard).join("")}</div>`
            : `<p class="small-empty">No ${escapeHtml(role)} agents registered.</p>`}
        </section>
      `;
    })
    .join("");

  agentsList.querySelectorAll("[data-agent-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const agentId = button.dataset.agentToggle;
      if (!agentId) return;
      const enabled = button.dataset.enabled !== "true";
      void updateAgent(agentId, { enabled }).catch(reportError);
    });
  });

  agentsList.querySelectorAll("[data-agent-remove]").forEach((button) => {
    button.addEventListener("click", () => {
      const agentId = button.dataset.agentRemove;
      if (!agentId) return;
      const agentName = button.dataset.agentName ?? "this agent";
      if (!window.confirm(`Remove ${agentName}?`)) return;
      void deleteAgent(agentId).catch(reportError);
    });
  });

  agentsList.querySelectorAll("[data-agent-session]").forEach((button) => {
    button.addEventListener("click", () => {
      const sessionId = button.dataset.agentSession;
      if (!sessionId) return;
      state.activeTab = "sessions";
      state.selectedSessionId = sessionId;
      void refreshAll({ quiet: true }).catch(reportError);
    });
  });
}

function renderAgentCard(agent) {
  const capabilityPills = [
    agent.supports_tools ? "tools" : null,
    agent.supports_patch ? "patch" : null,
    agent.supports_review ? "review" : null,
  ].filter(Boolean);

  return `
    <article class="agent-card">
      <div class="agent-topline">
        <strong>${escapeHtml(agent.name)}</strong>
        <div class="badge-row">
          <span class="pill">${escapeHtml(agent.kind)}</span>
          <span class="pill health-pill health-${escapeHtml(agent.health_state)}">${escapeHtml(agent.health_state)}</span>
        </div>
      </div>
      <p>${escapeHtml(agent.provider_family)}${agent.model_id ? ` · ${escapeHtml(agent.model_id)}` : ""}</p>
      <div class="meta-grid compact-meta-grid">
        <span><strong>Runtime</strong>${escapeHtml(agent.runtime_mode)}</span>
        <span><strong>Transport</strong>${escapeHtml(agent.transport)}</span>
        <span><strong>Context</strong>${formatContextWindow(agent.context_window)}</span>
        <span><strong>Cost Tier</strong>${escapeHtml(agent.cost_tier)}</span>
        <span><strong>Concurrency</strong>${agent.max_concurrency}</span>
        <span><strong>Fallback Priority</strong>${agent.fallback_priority}</span>
      </div>
      <div class="badge-row">
        ${capabilityPills.length > 0
          ? capabilityPills.map((value) => `<span class="pill">${escapeHtml(value)}</span>`).join("")
          : `<span class="pill">no declared capabilities</span>`}
      </div>
      <p class="muted">Assigned ${agent.assigned_task_count} · approvals ${agent.pending_approval_count} · attempts ${agent.attempt_count}</p>
      <p class="muted">Avg latency ${formatLatency(agent.avg_latency_ms)} · avg cost ${formatUsd(agent.avg_cost_usd)} · limit hit ${formatRate(agent.limit_hit_rate)}</p>
      <p class="muted">Last seen ${formatTimestamp(agent.last_seen_at ?? agent.registered_at)}</p>
      ${agent.cooldown_until ? `<p class="muted">Cooldown until ${formatTimestamp(agent.cooldown_until)}</p>` : ""}
      ${agent.command ? `<p class="muted path-line">${escapeHtml(agent.command)}</p>` : ""}
      ${agent.endpoint ? `<p class="muted path-line">${escapeHtml(agent.endpoint)}</p>` : ""}
      <div class="inline-actions">
        <button class="${agent.enabled ? "secondary-button" : "primary-button"}" data-agent-toggle="${agent.id}" data-enabled="${agent.enabled ? "true" : "false"}" type="button">
          ${agent.enabled ? "Disable" : "Enable"}
        </button>
        ${agent.active_session_id ? `<button class="secondary-button" data-agent-session="${agent.active_session_id}" type="button">Open Session</button>` : ""}
        <button class="ghost-button" data-agent-remove="${agent.id}" data-agent-name="${escapeHtml(agent.name)}" type="button">
          Remove
        </button>
      </div>
    </article>
  `;
}

function renderRuns() {
  if (!runsList) return;
  const runs = state.snapshot.runs ?? [];
  if (runs.length === 0) {
    runsList.innerHTML = `<p class="small-empty">No attempts recorded yet.</p>`;
    return;
  }

  runsList.innerHTML = `
    <div class="run-summary-bar">
      <span class="pill">${runs.length} total runs</span>
      <span class="pill">${runs.filter((run) => run.ended_at === null).length} active</span>
      <span class="pill">${runs.filter((run) => run.outcome === "success").length} successful</span>
      <span class="pill">${formatUsd(runs.reduce((sum, run) => sum + Number(run.estimated_cost_usd ?? 0), 0))} tracked cost</span>
    </div>
    <div class="run-list">
      ${runs.map((run) => renderRunCard(run)).join("")}
    </div>
  `;

  bindOpenTaskButtons(runsList);
}

function renderApprovals() {
  if (state.approvals.length === 0) {
    approvalList.innerHTML = `<p class="small-empty">No approval requests right now.</p>`;
    return;
  }

  approvalList.innerHTML = state.approvals
    .map(
      (approval) => `
        <article class="approval-card">
          <div class="agent-topline">
            <strong>${escapeHtml(approval.title)}</strong>
            <span class="pill">${escapeHtml(approval.kind)}</span>
          </div>
          <p>${escapeHtml(approval.agent_name)}${approval.task_title ? ` · ${escapeHtml(approval.task_title)}` : ""}</p>
          <p class="muted">${formatTimestamp(approval.created_at)} · ${escapeHtml(approval.status)}</p>
          <pre>${escapeHtml(approval.body)}</pre>
          ${approval.status === "pending"
            ? `
              <div class="inline-actions">
                <button class="primary-button" data-approval-action="approve" data-approval-id="${approval.id}" data-session-id="${approval.session_id}" type="button">Approve</button>
                <button class="secondary-button" data-approval-action="reject" data-approval-id="${approval.id}" data-session-id="${approval.session_id}" type="button">Reject</button>
              </div>
            `
            : approval.response_note
              ? `<p class="muted">${escapeHtml(approval.response_note)}</p>`
              : ""}
        </article>
      `,
    )
    .join("");

  approvalList.querySelectorAll("[data-approval-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const approvalId = button.dataset.approvalId;
      const sessionId = button.dataset.sessionId;
      if (!approvalId) return;
      state.selectedSessionId = sessionId ?? state.selectedSessionId;
      void resolveApproval(approvalId, button.dataset.approvalAction).catch(reportError);
    });
  });
}

function renderSessions() {
  if (state.snapshot.sessions.length === 0) {
    sessionsList.innerHTML = `<p class="small-empty">No managed sessions yet.</p>`;
    return;
  }

  const historyCount = state.snapshot.sessions.filter((session) => ["stopped", "errored"].includes(session.status)).length;
  sessionsList.innerHTML = state.snapshot.sessions
    .map((session, index) => {
      if (index === 0 && historyCount > 0) {
        return `
          <div class="inline-actions session-list-actions">
            <button class="ghost-button" data-clear-session-history type="button">Clear History (${historyCount})</button>
          </div>
          ${renderSessionCard(session)}
        `;
      }
      return renderSessionCard(session);
    })
    .join("");

  sessionsList.querySelector("[data-clear-session-history]")?.addEventListener("click", () => {
    if (!window.confirm(`Delete ${historyCount} stopped/errored sessions?`)) return;
    void clearSessionHistory().catch(reportError);
  });

  sessionsList.querySelectorAll("[data-session-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedSessionId = button.dataset.sessionId;
      void refreshAll({ quiet: true }).catch(reportError);
    });
  });
}

function renderSessionCard(session) {
  const activeAttempt = session.active_attempt;
  return `
        <button class="session-card ${state.selectedSessionId === session.id ? "selected" : ""}" data-session-id="${session.id}" type="button">
          <div class="agent-topline">
            <strong>${escapeHtml(session.agent_name)}</strong>
            <div class="badge-row">
              <span class="pill">${escapeHtml(session.agent_role)}</span>
              ${activeAttempt ? `<span class="pill">${escapeHtml(activeAttempt.provider)}${activeAttempt.model ? ` · ${escapeHtml(activeAttempt.model)}` : ""}</span>` : ""}
            </div>
          </div>
          <p>${escapeHtml(session.agent_kind)} · ${escapeHtml(session.status)}${session.task_title ? ` · ${escapeHtml(session.task_title)}` : ""}</p>
          ${session.command ? `<p class="muted path-line">${escapeHtml(session.command)}</p>` : ""}
          ${activeAttempt ? `<p class="muted">Attempt #${activeAttempt.attempt_number} · ${formatOutcome(activeAttempt.outcome)} · ${formatLatency(activeAttempt.latency_ms)}</p>` : ""}
          ${session.budget_summary ? `<p class="muted">${formatBudgetHeadline(session.budget_summary)}</p>` : ""}
          <p class="muted">${session.pending_approval_count} pending approvals · last seen ${formatTimestamp(session.last_seen_at ?? session.started_at)}</p>
          ${session.last_error ? `<p class="muted">${escapeHtml(session.last_error)}</p>` : ""}
        </button>
      `;
}

function renderSessionDetail() {
  if (!state.sessionDetail) {
    sessionDetail.className = "task-detail empty-state";
    sessionDetail.innerHTML = `
      <p class="panel-kicker">Managed Terminal</p>
      <h2>No session selected</h2>
      <p>Select a session to inspect the live terminal and interact with the worker.</p>
    `;
    return;
  }

  const { session, approvals, messages, log_content } = state.sessionDetail;
  const terminalTranscript = buildTerminalTranscript(session, messages, approvals, log_content);
  const canDeleteSession = !["busy", "waiting", "starting"].includes(session.status);
  const canFallback = Boolean(session.task_id);
  const terminalBuffer = state.terminalBuffers[session.id] ?? "";
  sessionDetail.className = "task-detail";
  sessionDetail.innerHTML = `
    <div class="detail-header">
      <div>
        <p class="panel-kicker">Managed Terminal</p>
        <h2>${escapeHtml(session.agent_name)}</h2>
        <p class="muted">${escapeHtml(session.agent_kind)} · ${escapeHtml(session.agent_role)} · ${escapeHtml(session.status)}${session.task_title ? ` · ${escapeHtml(session.task_title)}` : ""}</p>
      </div>
      <span class="detail-status status-chip">${escapeHtml(session.runtime_mode)}</span>
    </div>

    <section class="detail-section">
      <div class="terminal-meta-grid">
        <span><strong>Status</strong>${escapeHtml(session.status)}</span>
        <span><strong>PID</strong>${session.pid ?? "none"}</span>
        <span><strong>Task</strong>${session.task_title ? escapeHtml(session.task_title) : "idle"}</span>
        <span><strong>Transport</strong>${escapeHtml(session.transport)}</span>
        <span><strong>Started</strong>${formatTimestamp(session.started_at)}</span>
        <span><strong>Last Seen</strong>${formatTimestamp(session.last_seen_at ?? session.started_at)}</span>
      </div>
      ${session.active_attempt
        ? `
          <div class="session-info-card">
            <div class="agent-topline">
              <strong>Active Attempt #${session.active_attempt.attempt_number}</strong>
              <div class="badge-row">
                <span class="pill">${escapeHtml(session.active_attempt.role)}</span>
                <span class="pill">${escapeHtml(session.active_attempt.provider)}${session.active_attempt.model ? ` · ${escapeHtml(session.active_attempt.model)}` : ""}</span>
              </div>
            </div>
            <p class="muted">Started ${formatTimestamp(session.active_attempt.started_at)} · ${formatLatency(session.active_attempt.latency_ms)} · ${formatTokens(session.active_attempt.prompt_tokens, session.active_attempt.completion_tokens)}</p>
          </div>
        `
        : `<p class="small-empty">No active attempt ledger is attached to this session.</p>`}
      ${session.budget_summary
        ? `
          <div class="session-info-card">
            <div class="agent-topline">
              <strong>Budget Summary</strong>
              <div class="badge-row">
                ${session.budget_summary.soft_exceeded ? `<span class="pill warning-pill">soft exceeded</span>` : `<span class="pill">soft ok</span>`}
                ${session.budget_summary.hard_exceeded ? `<span class="pill danger-pill">hard exceeded</span>` : `<span class="pill ok-pill">hard ok</span>`}
              </div>
            </div>
            <p class="muted">${formatBudgetHeadline(session.budget_summary)}</p>
          </div>
        `
        : ""}
      ${session.command ? `<p class="path-line terminal-command-line">$ ${escapeHtml(session.command)}</p>` : `<p class="small-empty">No managed start command configured for this session.</p>`}
      ${session.last_error ? `<p class="terminal-warning">${escapeHtml(session.last_error)}</p>` : ""}
      <div class="inline-actions">
        ${session.task_id ? `<button class="secondary-button" data-open-task="${session.task_id}" type="button">Open Task</button>` : ""}
        <button class="secondary-button" data-session-fallback="${session.id}" type="button" ${canFallback ? "" : "disabled"}>
          Fallback Now
        </button>
        <button class="ghost-button" data-delete-session="${session.id}" type="button" ${canDeleteSession ? "" : "disabled"}>
          Remove Session
        </button>
      </div>
    </section>

    <section class="detail-section">
      <div class="terminal-shell">
        <div class="terminal-toolbar">
          <div class="terminal-lights">
            <span class="terminal-light red"></span>
            <span class="terminal-light amber"></span>
            <span class="terminal-light green"></span>
          </div>
          <div class="terminal-toolbar-title">${escapeHtml(session.agent_name)}${session.pid ? ` · pid ${session.pid}` : ""}</div>
          <div class="terminal-toolbar-actions">
            <label class="terminal-theme-control">
              <span>Theme</span>
              <select id="terminalThemeSelect">
                ${Object.entries(TERMINAL_THEME_OPTIONS).map(([value, label]) => (
                  `<option value="${value}" ${state.terminalTheme === value ? "selected" : ""}>${escapeHtml(label)}</option>`
                )).join("")}
              </select>
            </label>
            <div class="terminal-toolbar-meta">${escapeHtml(session.runtime_mode)}</div>
          </div>
        </div>
        <div
          class="terminal-screen ${state.focusedTerminalSessionId === session.id ? "focused" : ""}"
          id="sessionTerminal"
          tabindex="0"
          role="textbox"
          aria-label="Interactive managed terminal"
          aria-multiline="true"
        >${escapeHtml(terminalTranscript)}</div>
        <div class="terminal-input-line">
          <span class="terminal-caret ${state.focusedTerminalSessionId === session.id ? "visible" : ""}"></span>
          <span class="terminal-prompt">${escapeHtml(resolveTerminalPrompt(session))}</span>
          <span class="terminal-buffer">${escapeHtml(terminalBuffer) || "&nbsp;"}</span>
        </div>
      </div>
      <p class="small-empty">Click the terminal, type directly, press Enter to send. Ctrl-C interrupts. Shift+Enter inserts a newline. If no live shell is open, your message is treated as a question for the current agent/task context.</p>
    </section>

    <section class="detail-section">
      <p class="detail-label">Human Interaction</p>
      ${approvals.length > 0
        ? `<div class="approval-list">${approvals.map((approval) => `
            <article class="approval-card">
              <div class="agent-topline">
                <strong>${escapeHtml(approval.title)}</strong>
                <span class="pill">${escapeHtml(approval.status)}</span>
              </div>
              <p class="muted">${formatTimestamp(approval.created_at)} · ${escapeHtml(approval.kind)}</p>
              <pre>${escapeHtml(approval.body)}</pre>
            </article>
          `).join("")}</div>`
        : `<p class="small-empty">No approvals pending for this session.</p>`}
      <p class="small-empty">Launch commands can be typed directly there. Natural-language questions are answered in the same transcript.</p>
    </section>
  `;

  const terminal = sessionDetail.querySelector("#sessionTerminal");
  if (terminal) {
    terminal.scrollTop = terminal.scrollHeight;
    if (state.focusedTerminalSessionId === session.id) {
      terminal.focus();
    }
  }

  terminal?.addEventListener("click", () => {
    state.focusedTerminalSessionId = session.id;
    terminal.focus();
  });

  terminal?.addEventListener("paste", (event) => {
    event.preventDefault();
    const pasted = event.clipboardData?.getData("text") ?? "";
    if (!pasted) return;
    state.terminalBuffers[session.id] = `${state.terminalBuffers[session.id] ?? ""}${pasted}`;
    renderSessionDetail();
  });

  terminal?.addEventListener("keydown", (event) => {
    const currentBuffer = state.terminalBuffers[session.id] ?? "";

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c") {
      event.preventDefault();
      state.terminalBuffers[session.id] = "";
      void interruptSession(session.id).catch(reportError);
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const body = currentBuffer.trim();
      state.terminalBuffers[session.id] = "";
      if (body) {
        void sendSessionMessage(session.id, currentBuffer).catch(reportError);
      } else {
        void sendSessionMessage(session.id, "", { kind: "enter" }).catch(reportError);
      }
      return;
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      state.terminalBuffers[session.id] = `${currentBuffer}\n`;
      renderSessionDetail();
      return;
    }

    if (event.key === "Backspace") {
      event.preventDefault();
      state.terminalBuffers[session.id] = currentBuffer.slice(0, -1);
      renderSessionDetail();
      return;
    }

    if (event.key === "Tab") {
      event.preventDefault();
      state.terminalBuffers[session.id] = `${currentBuffer}\t`;
      renderSessionDetail();
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      state.terminalBuffers[session.id] = "";
      renderSessionDetail();
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      state.terminalBuffers[session.id] = `${currentBuffer}${event.key}`;
      renderSessionDetail();
    }
  });

  const deleteButton = sessionDetail.querySelector("[data-delete-session]");
  deleteButton?.addEventListener("click", () => {
    if (!canDeleteSession) return;
    if (!window.confirm(`Remove session for ${session.agent_name}?`)) return;
    void deleteSession(session.id).catch(reportError);
  });

  sessionDetail.querySelector("[data-session-fallback]")?.addEventListener("click", () => {
    if (!canFallback) return;
    void fallbackSession(session.id).catch(reportError);
  });

  sessionDetail.querySelector("#terminalThemeSelect")?.addEventListener("change", (event) => {
    setTerminalTheme(event.target.value);
  });

  bindOpenTaskButtons(sessionDetail);
}

async function moveTask(taskId, targetStatus, note = "") {
  if (!taskId || state.moveInFlight) return;
  state.moveInFlight = true;
  try {
    await fetchJson(`/api/tasks/${taskId}/actions`, {
      method: "POST",
      body: JSON.stringify({
        kind: "move",
        target_status: targetStatus,
        note,
      }),
    });
    state.selectedTaskId = taskId;
    await refreshAll();
  } finally {
    state.moveInFlight = false;
  }
}

async function archiveBoard() {
  const result = await fetchJson("/api/tasks/archive-all", {
    method: "POST",
    body: JSON.stringify({}),
  });
  showToast(`Archived ${result.archived_count} task${result.archived_count === 1 ? "" : "s"}`, { kind: "ok" });
  await refreshAll({ quiet: true });
}

async function uploadAttachmentsForSelectedTask(files) {
  if (!state.selectedTaskId || files.length === 0 || state.attachmentUploadInFlight) return;

  state.attachmentUploadInFlight = true;
  try {
    await uploadTaskFiles(state.selectedTaskId, files);
    await refreshAll({ quiet: true });
    showToast(`Uploaded ${files.length} attachment${files.length === 1 ? "" : "s"}.`, {
      kind: "ok",
    });
  } finally {
    state.attachmentUploadInFlight = false;
  }
}

async function uploadTaskFiles(taskId, files) {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file, file.name);
  }

  return fetchJson(`/api/tasks/${taskId}/attachments`, {
    method: "POST",
    body: form,
  });
}

async function taskAction(taskId, kind, note = "") {
  await fetchJson(`/api/tasks/${taskId}/actions`, {
    method: "POST",
    body: JSON.stringify({ kind, note }),
  });
  if (kind === "archive") {
    showToast("Task archived", { kind: "ok" });
  } else if (kind === "restore") {
    showToast("Task restored to board", { kind: "ok" });
  }
  state.selectedTaskId = taskId;
  await refreshAll();
}

async function returnTaskToTodo(taskId, note = "") {
  await fetchJson(`/api/tasks/${taskId}/return-to-todo`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
  state.selectedTaskId = taskId;
  await refreshAll();
}

async function updateAgent(agentId, payload) {
  await fetchJson(`/api/agents/${agentId}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
  await refreshAll({ quiet: true });
}

async function deleteAgent(agentId) {
  const deleted = await fetchJson(`/api/agents/${agentId}`, {
    method: "DELETE",
  });
  showToast(`Removed ${deleted.name}`, { kind: "ok" });
  await refreshAll({ quiet: true });
}

async function sendSessionMessage(sessionId, body, options = {}) {
  await fetchJson(`/api/sessions/${sessionId}/messages`, {
    method: "POST",
    body: JSON.stringify({ body, kind: options.kind }),
  });
  state.selectedSessionId = sessionId;
  state.terminalBuffers[sessionId] = "";
  await refreshAll({ quiet: true });
}

async function interruptSession(sessionId) {
  await fetchJson(`/api/sessions/${sessionId}/interrupt`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  state.selectedSessionId = sessionId;
  state.terminalBuffers[sessionId] = "";
  await refreshAll({ quiet: true });
}

async function fallbackSession(sessionId) {
  await fetchJson(`/api/sessions/${sessionId}/fallback`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  state.selectedSessionId = sessionId;
  showToast("Fallback requested for the active session", { kind: "ok" });
  await refreshAll({ quiet: true });
}

async function deleteSession(sessionId) {
  await fetchJson(`/api/sessions/${sessionId}`, {
    method: "DELETE",
  });
  if (state.selectedSessionId === sessionId) {
    state.selectedSessionId = null;
  }
  showToast("Session removed", { kind: "ok" });
  await refreshAll({ quiet: true });
}

async function clearSessionHistory() {
  const result = await fetchJson("/api/sessions/clear-history", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (state.sessionDetail && ["stopped", "errored"].includes(state.sessionDetail.session.status)) {
    state.selectedSessionId = null;
  }
  showToast(`Cleared ${result.deleted_count} sessions`, { kind: "ok" });
  await refreshAll({ quiet: true });
}

async function resolveApproval(approvalId, action) {
  const endpoint = action === "approve" ? "approve" : "reject";
  await fetchJson(`/api/approvals/${approvalId}/${endpoint}`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  await refreshAll({ quiet: true });
}

function clearDropTargets() {
  board.querySelectorAll(".drop-target").forEach((column) => {
    column.classList.remove("drop-target");
  });
}

function syncRegisterAgentForm(options = {}) {
  const kind = registerAgentFields.kind.value;
  const runtimeMode = registerAgentFields.runtimeMode.value;
  const suggestions = getManagedCommandSuggestions(kind, runtimeMode);
  const primarySuggestion = suggestions[0] ?? "";
  const previousSuggestion = registerAgentFields.command.dataset.suggestedCommand ?? "";
  const currentValue = registerAgentFields.command.value.trim();
  const shouldAutofill =
    options.force ||
    (
      options.autofill &&
      (currentValue === "" || currentValue === previousSuggestion)
    );

  registerAgentFields.commandSuggestions.innerHTML = suggestions
    .map((command) => `<option value="${escapeHtml(command)}"></option>`)
    .join("");

  if (runtimeMode === "managed") {
    registerAgentFields.command.disabled = false;
    registerAgentFields.endpoint.disabled = true;
    registerAgentFields.command.placeholder = primarySuggestion || "Enter the managed start command";
    registerAgentFields.command.dataset.suggestedCommand = primarySuggestion;
    registerAgentFields.commandHint.textContent = primarySuggestion
      ? `Suggested managed start command: ${primarySuggestion}`
      : "Set the managed start command for this worker.";
    registerAgentFields.endpoint.value = "";
    registerAgentFields.endpointHint.textContent = "Managed agents use the terminal command instead of an endpoint.";
    if (shouldAutofill && primarySuggestion) {
      registerAgentFields.command.value = primarySuggestion;
    }
  } else {
    registerAgentFields.endpoint.disabled = false;
    registerAgentFields.command.disabled = true;
    registerAgentFields.command.dataset.suggestedCommand = "";
    registerAgentFields.commandHint.textContent = "Command is only used for managed agents.";
    registerAgentFields.command.placeholder = "Disabled for external agents";
    registerAgentFields.endpointHint.textContent = "External agents should expose a reachable MCP or HTTP endpoint.";
    if (shouldAutofill || currentValue === previousSuggestion) {
      registerAgentFields.command.value = "";
    }
  }
}

function getManagedCommandSuggestions(kind, runtimeMode) {
  if (runtimeMode !== "managed") return [];
  return MANAGED_COMMAND_PRESETS[kind] ?? [];
}

function resolveTerminalPrompt(session) {
  if (session.status === "busy") return "›";
  return "$";
}

function setTerminalTheme(theme) {
  if (!(theme in TERMINAL_THEME_OPTIONS)) return;
  state.terminalTheme = theme;
  applyTerminalTheme();
  try {
    window.localStorage.setItem(TERMINAL_THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage failures
  }
  renderSessionDetail();
}

function applyTerminalTheme() {
  document.documentElement.dataset.terminalTheme = state.terminalTheme;
}

function loadStoredTerminalTheme() {
  try {
    const stored = window.localStorage.getItem(TERMINAL_THEME_STORAGE_KEY);
    if (stored && stored in TERMINAL_THEME_OPTIONS) {
      return stored;
    }
  } catch {
    // ignore storage failures
  }
  return "white";
}

function priorityTitle(priorityLabel) {
  return PRIORITY_TITLES[priorityLabel] ?? String(priorityLabel ?? "Unknown");
}

function renderRunCard(run, options = {}) {
  const compact = Boolean(options.compact);
  const statusClass = run.outcome ? `outcome-${run.outcome}` : "outcome-active";
  return `
    <article class="run-card ${compact ? "compact" : ""}">
      <div class="agent-topline">
        <div>
          <strong>${run.task_title ? escapeHtml(run.task_title) : `Task ${escapeHtml(run.task_id)}`}</strong>
          <p class="muted">Attempt #${run.attempt_number} · ${escapeHtml(run.role)} · ${escapeHtml(run.agent_name ?? run.agent_id)}</p>
        </div>
        <div class="badge-row">
          <span class="pill">${escapeHtml(run.provider)}${run.model ? ` · ${escapeHtml(run.model)}` : ""}</span>
          <span class="pill ${statusClass}">${escapeHtml(formatOutcome(run.outcome))}</span>
        </div>
      </div>
      <div class="meta-grid compact-meta-grid">
        <span><strong>Started</strong>${formatTimestamp(run.started_at)}</span>
        <span><strong>Ended</strong>${run.ended_at ? formatTimestamp(run.ended_at) : "active"}</span>
        <span><strong>Latency</strong>${formatLatency(run.latency_ms)}</span>
        <span><strong>Tokens</strong>${formatTokens(run.prompt_tokens, run.completion_tokens)}</span>
        <span><strong>Cost</strong>${formatUsd(run.estimated_cost_usd)}</span>
        <span><strong>Handoff</strong>${run.handoff_reason ? escapeHtml(run.handoff_reason) : "none"}</span>
      </div>
      ${compact
        ? ""
        : `
          <div class="inline-actions">
            <button class="secondary-button" data-open-task="${run.task_id}" type="button">Open Task</button>
          </div>
        `}
    </article>
  `;
}

function bindOpenTaskButtons(root) {
  root.querySelectorAll("[data-open-task]").forEach((button) => {
    button.addEventListener("click", () => {
      const taskId = button.dataset.openTask;
      if (!taskId) return;
      void openTask(taskId).catch(reportError);
    });
  });
}

async function openTask(taskId) {
  state.activeTab = "board";
  state.selectedTaskId = taskId;
  await refreshSelectedTaskDetail();
  render();
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  if (!normalized) return undefined;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalInteger(value) {
  const parsed = parseOptionalNumber(value);
  if (parsed === undefined) return undefined;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) =>
      value !== undefined &&
      value !== null &&
      value !== ""
    ),
  );
}

function formatUsd(value) {
  if (value === undefined || value === null || !Number.isFinite(Number(value))) return "none";
  const numeric = Number(value);
  if (numeric === 0) return "$0.00";
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: numeric < 1 ? 3 : 2,
  }).format(numeric);
}

function formatLatency(value) {
  if (!Number.isFinite(value) || value === null) return "n/a";
  if (value < 1000) return `${Math.round(value)} ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function formatTokens(promptTokens, completionTokens) {
  const parts = [];
  if (Number.isFinite(promptTokens)) parts.push(`p ${Number(promptTokens).toLocaleString()}`);
  if (Number.isFinite(completionTokens)) parts.push(`c ${Number(completionTokens).toLocaleString()}`);
  return parts.length > 0 ? parts.join(" · ") : "n/a";
}

function formatRate(value) {
  if (!Number.isFinite(value)) return "n/a";
  return `${Math.round(Number(value) * 100)}%`;
}

function formatScore(value) {
  if (!Number.isFinite(value)) return "0";
  return Number(value).toFixed(Math.abs(value) >= 10 ? 1 : 2);
}

function formatOutcome(value) {
  if (!value) return "active";
  return value.replaceAll("_", " ");
}

function formatContextWindow(value) {
  if (!Number.isFinite(value) || value === null) return "auto";
  if (value >= 1000) {
    return `${Math.round(Number(value) / 1000)}k`;
  }
  return String(value);
}

function formatRemaining(attemptsRemaining, costRemaining) {
  const parts = [];
  if (attemptsRemaining !== null && attemptsRemaining !== undefined) {
    parts.push(`${attemptsRemaining} attempts`);
  }
  if (costRemaining !== null && costRemaining !== undefined) {
    parts.push(formatUsd(costRemaining));
  }
  return parts.length > 0 ? parts.join(" · ") : "unbounded";
}

function formatBudgetHeadline(summary) {
  return `${summary.total_attempts} attempts · ${formatUsd(summary.total_cost_usd)} total · soft ${summary.soft_exceeded ? "exceeded" : "ok"} · hard ${summary.hard_exceeded ? "exceeded" : "ok"}`;
}

function buildTerminalTranscript(session, messages, approvals, logContent) {
  const lines = [
    "DeltaPilot managed session",
    `agent=${session.agent_name} kind=${session.agent_kind} role=${session.agent_role} status=${session.status}`,
    `transport=${session.transport} started_at=${session.started_at}`,
  ];

  if (session.task_title) {
    lines.push(`task=${session.task_title}`);
  }
  if (session.command) {
    lines.push(`$ ${session.command}`);
  }
  if (session.last_error) {
    lines.push(`! ${session.last_error}`);
  }
  if (logContent?.trim()) {
    lines.push("", logContent.trimEnd());
  } else {
    lines.push("", "[no terminal output yet]");
  }
  if (messages.length > 0) {
    lines.push("", "# inbox");
    for (const message of messages) {
      lines.push(`[${message.direction}/${message.kind}] ${message.body}`);
    }
  }
  if (approvals.some((approval) => approval.status === "pending")) {
    lines.push("", "# pending approvals");
    for (const approval of approvals.filter((item) => item.status === "pending")) {
      lines.push(`? ${approval.kind}: ${approval.title}`);
    }
  }

  return lines.join("\n");
}

function showToast(message, options = {}) {
  const kind = options.kind ?? "ok";
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.innerHTML = `
    <div style="flex:1;white-space:pre-wrap;word-break:break-word;">${escapeHtml(message)}</div>
    <button class="toast-close" type="button" aria-label="dismiss">&times;</button>
  `;
  const dismiss = () => {
    el.classList.add("dismissing");
    window.setTimeout(() => el.remove(), 180);
  };
  el.querySelector(".toast-close").addEventListener("click", dismiss);
  toastContainer.appendChild(el);
  window.setTimeout(dismiss, kind === "error" ? 6000 : 4000);
}

function reportError(error) {
  console.error(error);
  const message = error instanceof Error ? error.message : String(error);
  showToast(message, { kind: "error" });
}

async function fetchJson(url, options = {}) {
  const isFormDataBody = typeof FormData !== "undefined" && options.body instanceof FormData;
  const defaultHeaders = isFormDataBody ? {} : { "content-type": "application/json" };
  const response = await fetch(url, {
    headers: {
      ...defaultHeaders,
      ...(options.headers ?? {}),
    },
    ...options,
  });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.message) message = body.message;
    } catch {
      // ignore parse errors
    }
    throw new Error(message);
  }

  return response.json();
}

function splitLines(value) {
  return String(value ?? "")
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function statusTitle(value) {
  return STATUS_TITLES[value] ?? value;
}

function humanReviewReasonTitle(value) {
  return HUMAN_REVIEW_REASON_TITLES[value] ?? value;
}

function formatTimestamp(value) {
  if (!value) return "never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(sizeBytes) {
  if (!Number.isFinite(sizeBytes)) return "0 B";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${(sizeBytes / 1024).toFixed(sizeBytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(sizeBytes / (1024 * 1024)).toFixed(sizeBytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function flashRefresh() {
  refreshButton.classList.add("pulse");
  window.setTimeout(() => refreshButton.classList.remove("pulse"), 500);
}
