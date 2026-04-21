# Agent Integration Guide

How an AI agent joins DeltaPilot: two supported paths, plus what each path
actually exercises.

There is one transport (MCP over stdio) and two ways to consume it:

| Path                              | Who spawns whom                             | Auto-handoff on rate-limit?                |
| --------------------------------- | ------------------------------------------- | ------------------------------------------ |
| **A. Native MCP client**          | The agent launches `deltapilot-mcp` as an MCP server | **No** — the agent must call `report_limit` by hand |
| **B. `@deltapilot/sdk` wrapper**  | The agent (TS process) uses `DeltaPilotClient` which launches `deltapilot-mcp` | **Yes** — `withAutoHandoff` catches, reports, rethrows |

Both paths end up at the same SQLite database and drive the same task state
machine. The only difference is whether the client owns error classification
(path A) or outsources it to the SDK helper (path B).

---

## 1. Shared setup

```bash
pnpm install
pnpm -r build
```

For a one-command local smoke test that seeds a disposable demo repo and runs
`claim_task -> commit -> submit_work`, run:

```bash
pnpm demo
```

This produces `packages/mcp-server/dist/cli.js`, which is the actual MCP
server. It is invoked as `node packages/mcp-server/dist/cli.js ...` or, after
publishing, as the `deltapilot-mcp` bin.

If you also want the board UI against the same repo and DB, run:

```bash
pnpm dashboard -- --repo /abs/path/to/your/target/repo --host 0.0.0.0 --port 3000
```

Every agent is **spawn-bound to one `agent_id`** via CLI flag or env:

```bash
# Two equivalent forms:
deltapilot-mcp --repo /path/to/repo --agent-id <uuid>
DP_REPO=/path/to/repo DP_AGENT_ID=<uuid> deltapilot-mcp
```

Register an agent first (from an orchestrator script) to get a UUID:

```ts
import { Orchestrator, WorktreeManager, openDatabase } from "@deltapilot/core";

const conn = openDatabase(path.join(repoRoot, ".deltapilot-data.db"));
const orch = new Orchestrator({
  raw: conn.raw,
  db: conn.db,
  worktreeMgr: new WorktreeManager({ repoRoot, workspacesDir }),
  repoRoot,
});
const agent = await orch.registerAgent({
  name: "claude-code-1",
  kind: "claude-code",
  transport: "mcp-stdio",
});
console.log(agent.id); // pass as --agent-id
```

The server exposes exactly 5 tools. None of them take `agent_id`; the id is
the spawn binding.

| Tool              | Input                                           | Output                              |
| ----------------- | ----------------------------------------------- | ----------------------------------- |
| `claim_task`      | —                                               | `Task` row, or `null` if queue empty |
| `heartbeat`       | `{ task_id }`                                   | `"ok"`                              |
| `submit_work`     | `{ task_id, commit_sha? }`                      | updated `Task` row                  |
| `report_limit`    | `{ task_id, reason: "rate_limit" \| "context_limit" \| "crash" }` | `Handoff` row |
| `request_handoff` | `{ task_id, reason }`                           | `Handoff` row (same behavior as `report_limit`) |

---

## 2. Path A — Native MCP client (e.g. Claude Code)

Claude Code, Cursor, and any MCP-compatible editor can talk to `deltapilot-mcp`
as an MCP server. Add it to the client's MCP config, pointing at the built
CLI:

```jsonc
// ~/.config/claude-code/mcp.json (or equivalent)
{
  "mcpServers": {
    "deltapilot": {
      "command": "node",
      "args": [
        "/abs/path/packages/mcp-server/dist/cli.js",
        "--repo", "/abs/path/to/your/target/repo",
        "--agent-id", "<uuid from registerAgent>"
      ]
    }
  }
}
```

**Manual smoke:**

1. Seed a ready task (via orchestrator API or UI once Phase 4 ships).
2. In Claude Code, invoke the `claim_task` tool. Task should land at status
   `in_progress` and the worktree should appear at
   `<repo>/.deltapilot/workspaces/<task_id>/`.
3. Do trivial edits, commit to the task branch, invoke `submit_work`.
   Task should land at status `review`.

**⚠️ No auto-handoff on path A.** Claude Code has no knowledge of DeltaPilot's
`withAutoHandoff` helper. If Claude Code hits a rate limit during a task, it
fails and stops — the task stays `in_progress` with no `handoff_pending`
transition until the heartbeat-timeout safety net fires (Phase 2 leaves the
timeout itself out of scope; it is enumerated in §5 of the plan for later).

If you want explicit bailout, invoke `request_handoff` by hand before closing
out the Claude Code session — the orchestrator will snapshot and requeue.

## 3. Path B — SDK wrapper (reference TS integration)

`@deltapilot/sdk` is the reference runtime for an agent that wants automatic
handoff. It is what the adapter/e2e suite exercises.

```ts
import { DeltaPilotClient, withAutoHandoff, type HandoffReason } from "@deltapilot/sdk";

const client = await DeltaPilotClient.connect({
  command: process.execPath,
  args: [
    "packages/mcp-server/dist/cli.js",
    "--repo", repoRoot,
    "--agent-id", agentId,
  ],
});

const task = await client.claimTask();
if (!task) return; // empty queue

// Classify provider-specific errors yourself — the SDK is deliberately
// provider-agnostic.
const isLimit = (err: unknown): HandoffReason | null => {
  const e = err as { status?: number; code?: string };
  if (e.status === 429) return "rate_limit";
  if (e.code === "context_length_exceeded") return "context_limit";
  return null;
};

try {
  await withAutoHandoff(
    async () => {
      // ... agent's LLM call + tool loop ...
    },
    { client, taskId: task.id, isLimit },
  );
  await client.submitWork(task.id);
} finally {
  await client.close();
}
```

When the wrapped function throws and `isLimit` returns a reason,
`withAutoHandoff` calls `client.reportLimit` *before* rethrowing, so the
orchestrator has already moved the task to `handoff_pending` and snapshotted
artifacts by the time your caller sees the error.

This path has a subprocess integration test
(`packages/sdk/src/client.e2e.test.ts`) that drives a synthetic 429 through
the real wire and asserts the DB lands in `handoff_pending`.

## 4. Scope note for Phase 2

The plan's Phase 2 exit — "a synthetic rate limit triggers a real handoff to a
second Claude Code instance" — is covered by path B's subprocess integration
test (one SDK-backed agent). The cross-agent continuation (a second process
claims from `handoff_pending` and finishes the task) is already proven at the
core/adapter layer in `packages/adapters/src/handoff.e2e.test.ts` using the
in-process `MockAgent`.

A fully end-to-end "two Claude Code instances, one cooperative handoff" smoke
requires Claude Code itself to embed `@deltapilot/sdk` in its tool-call path —
that is not something this repo controls. The native path (§2) and the SDK
path (§3) are the two pieces; Claude-Code-specific wiring lives downstream.
