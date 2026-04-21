const STATUS_ORDER = [
  "todo",
  "in_progress",
  "review",
  "done",
  "cancelled",
];

const STATUS_TITLES = {
  todo: "To Do",
  in_progress: "In Progress",
  review: "Review",
  done: "Done",
  cancelled: "Cancelled",
};

const EVENT_TITLES = {
  create: "Created",
  ready: "Moved to To Do",
  claim: "Claimed",
  submit_for_review: "Submitted for review",
  report_limit: "Reported limit",
  timeout: "Timed out",
  approve: "Approved",
  bounce: "Bounced",
  cancel: "Cancelled",
  dashboard_move: "Moved from dashboard",
};

const state = {
  snapshot: null,
  selectedTaskId: null,
  selectedTaskDetail: null,
  dragTaskId: null,
  moveInFlight: false,
};

const statsStrip = document.querySelector("#statsStrip");
const board = document.querySelector("#board");
const taskDetail = document.querySelector("#taskDetail");
const agentsList = document.querySelector("#agentsList");
const handoffList = document.querySelector("#handoffList");
const repoMeta = document.querySelector("#repoMeta");
const dbMeta = document.querySelector("#dbMeta");
const refreshButton = document.querySelector("#refreshButton");
const createTaskForm = document.querySelector("#createTaskForm");
const registerAgentForm = document.querySelector("#registerAgentForm");
const toastContainer = document.querySelector("#toastContainer");

refreshButton.addEventListener("click", () => void refreshAll());
createTaskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void createTask().catch(reportError);
});
registerAgentForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  void registerAgent().catch(reportError);
});

setInterval(() => {
  void refreshAll({ quiet: true }).catch(reportError);
}, 5000);

void refreshAll().catch(reportError);

async function refreshAll(options = {}) {
  const snapshot = await fetchJson("/api/dashboard");
  state.snapshot = snapshot;

  if (!state.selectedTaskId) {
    const preferred = snapshot.tasks.find((task) => !["done", "cancelled"].includes(task.status));
    state.selectedTaskId = preferred?.id ?? snapshot.tasks[0]?.id ?? null;
  } else if (!snapshot.tasks.some((task) => task.id === state.selectedTaskId)) {
    state.selectedTaskId = snapshot.tasks[0]?.id ?? null;
  }

  if (state.selectedTaskId) {
    state.selectedTaskDetail = await fetchJson(`/api/tasks/${state.selectedTaskId}`);
  } else {
    state.selectedTaskDetail = null;
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
    ready: true,
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
  await refreshAll();
}

function render() {
  if (!state.snapshot) return;

  repoMeta.textContent = shortenPath(state.snapshot.meta.repo_root);
  dbMeta.textContent = shortenPath(state.snapshot.meta.db_path);

  renderStats();
  renderAgents();
  renderHandoffs();
  renderBoard();
  renderDetail();
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
            <span class="pill">${escapeHtml(agent.kind)}</span>
          </div>
          <p>${escapeHtml(agent.transport)}</p>
          <p class="muted">Last seen ${formatTimestamp(agent.last_seen_at ?? agent.registered_at)}</p>
          <p class="muted">${agent.assigned_task_count} assigned task${agent.assigned_task_count === 1 ? "" : "s"}</p>
        </article>
      `,
    )
    .join("");
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
                        <span class="pill">${task.assigned_agent_name ? escapeHtml(task.assigned_agent_name) : "unassigned"}</span>
                      </div>
                      <h3>${escapeHtml(task.title)}</h3>
                      ${task.status_note ? `<p class="task-card-subline">${escapeHtml(task.status_note)}</p>` : ""}
                      <footer>
                        <span>${task.branch_name ? escapeHtml(task.branch_name) : "no branch"}</span>
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

function renderDetail() {
  if (!state.selectedTaskDetail) {
    taskDetail.className = "task-detail empty-state";
    taskDetail.innerHTML = `
      <p class="panel-kicker">Task Detail</p>
      <h2>No task selected</h2>
      <p>Create or select a task to inspect its history.</p>
    `;
    return;
  }

  const { task, artifacts, events, handoffs } = state.selectedTaskDetail;
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
        <span><strong>Branch</strong> ${task.branch_name ? escapeHtml(task.branch_name) : "none"}</span>
        <span><strong>Worktree</strong> ${task.worktree_exists ? "present" : "missing"}</span>
      </div>
      <p class="muted path-line">${task.worktree_path ? escapeHtml(task.worktree_path) : "No active worktree path."}</p>
    </section>

    ${acceptance}

    ${renderActionBlock(task)}

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
      if (button.dataset.action === "move") {
        const target = document.querySelector("#moveTarget")?.value;
        const note = document.querySelector("#moveNote")?.value?.trim() ?? "";
        if (!target) return;
        void moveTask(state.selectedTaskId, target, note).catch(reportError);
      }
    });
  });
}

function renderActionBlock(task) {
  return `
    <section class="detail-section action-section">
      <p class="detail-label">Move Task</p>
      <p class="muted">Drag the card between columns or move it manually here.</p>
      <div class="move-grid">
        <label>
          <span>Target column</span>
          <select id="moveTarget">
            ${STATUS_ORDER.map(
              (status) => `<option value="${status}" ${status === task.status ? "selected" : ""}>${STATUS_TITLES[status]}</option>`,
            ).join("")}
          </select>
        </label>
        <button class="primary-button" data-action="move" type="button">Move</button>
      </div>
      <label>
        <span>Move note</span>
        <textarea id="moveNote" rows="3" placeholder="Optional context for the timeline"></textarea>
      </label>
    </section>
  `;
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

function clearDropTargets() {
  board.querySelectorAll(".drop-target").forEach((column) => {
    column.classList.remove("drop-target");
  });
}

async function registerAgent() {
  const form = new FormData(registerAgentForm);
  const payload = {
    name: String(form.get("name") ?? "").trim(),
    kind: String(form.get("kind") ?? "").trim(),
    transport: "mcp-stdio",
  };

  const agent = await fetchJson("/api/agents", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  registerAgentForm.reset();
  showToast(`Registered ${agent.name} (${agent.kind})\nid=${agent.id}`, { kind: "ok" });
  await refreshAll({ quiet: true });
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
  if (value === "init") return STATUS_TITLES.todo;
  if (value === "handoff_pending") return STATUS_TITLES.in_progress;
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
