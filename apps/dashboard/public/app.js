const STATUS_ORDER = [
  "todo",
  "planning",
  "in_progress",
  "review",
  "human_review",
  "done",
  "cancelled",
];

const STATUS_TITLES = {
  todo: "To Do",
  planning: "Planning",
  in_progress: "In Progress",
  review: "Review",
  human_review: "Human Review",
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
  review_decision: "Review Decision",
  enter_human_review: "Escalated To Human Review",
  return_to_todo: "Returned To To Do",
  report_limit: "Reported Limit",
  cancel: "Cancelled",
  dashboard_move: "Moved From Dashboard",
};

const MANAGED_COMMAND_PRESETS = {
  codex: ["codex"],
  "claude-code": ["claude"],
  "claude-sdk": ["claude"],
  openclaw: ["openclaw gateway start"],
  opendevin: ["opendevin"],
  hermes: ["hermes"],
  mock: [],
  other: [],
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
  dragTaskId: null,
  moveInFlight: false,
};

const statsStrip = document.querySelector("#statsStrip");
const board = document.querySelector("#board");
const taskDetail = document.querySelector("#taskDetail");
const handoffList = document.querySelector("#handoffList");
const repoMeta = document.querySelector("#repoMeta");
const dbMeta = document.querySelector("#dbMeta");
const refreshButton = document.querySelector("#refreshButton");
const createTaskForm = document.querySelector("#createTaskForm");
const registerAgentForm = document.querySelector("#registerAgentForm");
const agentsList = document.querySelector("#agentsList");
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
    renderTabs();
  });
});

setInterval(() => {
  void refreshAll({ quiet: true }).catch(reportError);
}, 5000);

syncRegisterAgentForm({ autofill: true });
void refreshAll().catch(reportError);

async function refreshAll(options = {}) {
  const [snapshot, approvals] = await Promise.all([
    fetchJson("/api/dashboard"),
    fetchJson("/api/approvals"),
  ]);
  state.snapshot = snapshot;
  state.approvals = approvals;

  if (!state.selectedTaskId) {
    const preferred = snapshot.tasks.find((task) => !["done", "cancelled"].includes(task.status));
    state.selectedTaskId = preferred?.id ?? snapshot.tasks[0]?.id ?? null;
  } else if (!snapshot.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = snapshot.tasks[0]?.id ?? null;
  }

  if (!state.selectedSessionId) {
    state.selectedSessionId = snapshot.sessions[0]?.id ?? null;
  } else if (!snapshot.sessions.some((session) => session.id === state.selectedSessionId)) {
    state.selectedSessionId = snapshot.sessions[0]?.id ?? null;
  }

  if (state.selectedTaskId) {
    state.taskDetail = await fetchJson(`/api/tasks/${state.selectedTaskId}`);
  } else {
    state.taskDetail = null;
  }

  if (state.selectedSessionId) {
    state.sessionDetail = await fetchJson(`/api/sessions/${state.selectedSessionId}`);
  } else {
    state.sessionDetail = null;
  }

  render();
  if (!options.quiet) {
    flashRefresh();
  }
}

async function createTask() {
  const form = new FormData(createTaskForm);
  const payload = {
    title: String(form.get("title") ?? "").trim(),
    brief: String(form.get("brief") ?? "").trim(),
    priority: Number.parseInt(String(form.get("priority") ?? "50"), 10),
    acceptance: {
      goal: String(form.get("goal") ?? "").trim(),
      deliverables: splitLines(form.get("deliverables")),
      files_in_scope: splitLines(form.get("files_in_scope")),
      success_test: String(form.get("success_test") ?? "").trim(),
    },
  };

  const detail = await fetchJson("/api/tasks", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  createTaskForm.reset();
  createTaskForm.querySelector('input[name="priority"]').value = "50";
  state.selectedTaskId = detail.task.id;
  state.activeTab = "board";
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
  };

  const agent = await fetchJson("/api/agents", {
    method: "POST",
    body: JSON.stringify(payload),
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
  repoMeta.textContent = shortenPath(state.snapshot.meta.repo_root);
  dbMeta.textContent = shortenPath(state.snapshot.meta.db_path);
  renderTabs();
  renderStats();
  renderBoard();
  renderTaskDetail();
  renderHandoffs();
  renderAgents();
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
  const items = STATUS_ORDER.map((status) => {
    const count = state.snapshot.stats[status] ?? 0;
    return `
      <span class="stat-item">
        <span class="status-dot status-${status}"></span>
        ${STATUS_TITLES[status]}
        <strong>${count}</strong>
      </span>
    `;
  }).join("");

  statsStrip.innerHTML = items;
}

function renderBoard() {
  const tasksByStatus = new Map(STATUS_ORDER.map((status) => [status, []]));
  for (const task of state.snapshot.tasks) {
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
                      draggable="true"
                    >
                      <div class="task-card-top">
                        <span class="priority">P${task.priority}</span>
                        <span class="pill">${task.last_role ? escapeHtml(task.last_role) : (task.assigned_agent_name ? escapeHtml(task.assigned_agent_name) : "queue")}</span>
                      </div>
                      <h3>${escapeHtml(task.title)}</h3>
                      ${task.status_note ? `<p class="task-card-subline">${escapeHtml(task.status_note)}</p>` : ""}
                      <footer>
                        <span>${task.assigned_agent_name ? escapeHtml(task.assigned_agent_name) : "unassigned"}</span>
                        <span>${formatTimestamp(task.updated_at)}</span>
                      </footer>
                    </button>
                  `,
                )
                .join("")
            : `<div class="column-empty">No tasks</div>`}
        </div>
      </section>
    `;
  }).join("");

  board.querySelectorAll("[data-task-id]").forEach((card) => {
    card.addEventListener("click", () => {
      state.selectedTaskId = card.dataset.taskId;
      void refreshAll({ quiet: true }).catch(reportError);
    });

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
      <h2>No task selected</h2>
      <p>Create or select a task to inspect its history.</p>
    `;
    return;
  }

  const { task, events, artifacts, handoffs } = state.taskDetail;
  const acceptance = task.acceptance
    ? `
      <section class="detail-section">
        <p class="detail-label">Acceptance</p>
        <p>${escapeHtml(task.acceptance.goal)}</p>
        <ul class="detail-list">
          ${task.acceptance.deliverables.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
        ${task.acceptance.files_in_scope.length > 0
          ? `<p class="muted">Files: ${task.acceptance.files_in_scope.map(escapeHtml).join(", ")}</p>`
          : ""}
        <p class="muted">Success test: ${escapeHtml(task.acceptance.success_test)}</p>
      </section>
    `
    : "";

  taskDetail.className = "task-detail";
  taskDetail.innerHTML = `
    <div class="detail-header">
      <div>
        <p class="panel-kicker">Task Detail</p>
        <h2>${escapeHtml(task.title)}</h2>
        ${task.status_note ? `<p class="status-note">${escapeHtml(task.status_note)}</p>` : ""}
      </div>
      <span class="detail-status status-chip"><span class="status-dot status-${task.status}"></span>${STATUS_TITLES[task.status]}</span>
    </div>

    <section class="detail-section">
      <p class="detail-label">Summary</p>
      <p>${escapeHtml(task.brief || "No brief provided.")}</p>
      <div class="meta-grid">
        <span><strong>Priority</strong> P${task.priority}</span>
        <span><strong>Assigned</strong> ${task.assigned_agent_name ? escapeHtml(task.assigned_agent_name) : "unassigned"}</span>
        <span><strong>Last Role</strong> ${task.last_role ? escapeHtml(task.last_role) : "none"}</span>
        <span><strong>Review Bounces</strong> ${task.review_bounce_count}</span>
        <span><strong>Branch</strong> ${task.branch_name ? escapeHtml(task.branch_name) : "none"}</span>
        <span><strong>Worktree</strong> ${task.worktree_exists ? "present" : "missing"}</span>
      </div>
      <p class="muted path-line">${task.worktree_path ? escapeHtml(task.worktree_path) : "No active worktree path."}</p>
    </section>

    ${acceptance}

    ${renderTaskActions(task)}

    <section class="detail-section">
      <p class="detail-label">Task Events</p>
      <div class="timeline">
        ${events.length > 0
          ? events
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
      } else if (action === "cancel") {
        void taskAction(task.id, "cancel", note).catch(reportError);
      } else if (action === "return_to_todo") {
        void returnTaskToTodo(task.id, note).catch(reportError);
      }
    });
  });
}

function renderTaskActions(task) {
  const reviewButtons = task.status === "review"
    ? `
      <div class="inline-actions">
        <button class="primary-button" data-action="approve" type="button">Approve</button>
        <button class="secondary-button" data-action="bounce" type="button">Bounce</button>
      </div>
    `
    : "";
  const humanButton = task.status === "human_review"
    ? `<button class="primary-button" data-action="return_to_todo" type="button">Return To To Do</button>`
    : "";

  return `
    <section class="detail-section action-section">
      <p class="detail-label">Task Actions</p>
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
      ${reviewButtons}
      ${humanButton}
      <div class="inline-actions">
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

  agentsList.innerHTML = state.snapshot.agents
    .map(
      (agent) => `
        <article class="agent-card">
          <div class="agent-topline">
            <strong>${escapeHtml(agent.name)}</strong>
            <span class="pill">${escapeHtml(agent.role)}</span>
          </div>
          <p>${escapeHtml(agent.kind)} · ${escapeHtml(agent.runtime_mode)} · ${escapeHtml(agent.transport)}</p>
          <p class="muted">Last seen ${formatTimestamp(agent.last_seen_at ?? agent.registered_at)}</p>
          <p class="muted">${agent.assigned_task_count} assigned · ${agent.pending_approval_count} pending approvals</p>
          ${agent.cooldown_until ? `<p class="muted">Cooldown until ${formatTimestamp(agent.cooldown_until)}</p>` : ""}
          ${agent.command ? `<p class="muted path-line">${escapeHtml(agent.command)}</p>` : ""}
          ${agent.endpoint ? `<p class="muted path-line">${escapeHtml(agent.endpoint)}</p>` : ""}
          <div class="inline-actions">
            <button class="${agent.enabled ? "secondary-button" : "primary-button"}" data-agent-toggle="${agent.id}" data-enabled="${agent.enabled ? "true" : "false"}" type="button">
              ${agent.enabled ? "Disable" : "Enable"}
            </button>
            <button class="ghost-button" data-agent-remove="${agent.id}" data-agent-name="${escapeHtml(agent.name)}" type="button">
              Remove
            </button>
          </div>
        </article>
      `,
    )
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
  return `
        <button class="session-card ${state.selectedSessionId === session.id ? "selected" : ""}" data-session-id="${session.id}" type="button">
          <div class="agent-topline">
            <strong>${escapeHtml(session.agent_name)}</strong>
            <span class="pill">${escapeHtml(session.agent_role)}</span>
          </div>
          <p>${escapeHtml(session.agent_kind)} · ${escapeHtml(session.status)}${session.task_title ? ` · ${escapeHtml(session.task_title)}` : ""}</p>
          ${session.command ? `<p class="muted path-line">${escapeHtml(session.command)}</p>` : ""}
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
      ${session.command ? `<p class="path-line terminal-command-line">$ ${escapeHtml(session.command)}</p>` : `<p class="small-empty">No managed start command configured for this session.</p>`}
      ${session.last_error ? `<p class="terminal-warning">${escapeHtml(session.last_error)}</p>` : ""}
      <div class="inline-actions">
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
          <div class="terminal-toolbar-meta">${escapeHtml(session.runtime_mode)}</div>
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

async function taskAction(taskId, kind, note = "") {
  await fetchJson(`/api/tasks/${taskId}/actions`, {
    method: "POST",
    body: JSON.stringify({ kind, note }),
  });
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

function buildTerminalTranscript(session, messages, approvals, logContent) {
  const lines = [
    "DeltaPipeline managed session",
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
  const response = await fetch(url, {
    headers: {
      "content-type": "application/json",
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

function shortenPath(value) {
  if (!value) return "";
  const parts = value.split("/");
  if (parts.length <= 4) return value;
  return `…/${parts.slice(-4).join("/")}`;
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

function flashRefresh() {
  refreshButton.classList.add("pulse");
  window.setTimeout(() => refreshButton.classList.remove("pulse"), 500);
}
