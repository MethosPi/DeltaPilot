# DeltaPilot

**AI Agent Orchestrator — "Jira for AI Agents"**

DeltaPilot coordinates terminal-capable AI coding agents (Claude Code, Codex, OpenDevin, Hermes). It tracks tasks on a Kanban board (Init → To Do → In Progress → Review → Done) and — critically — hands off in-flight work when an agent hits a rate limit or crashes, so tasks never get stuck half-finished.

> Status: pre-alpha. Walking-skeleton handoff is the first milestone.

## Quickstart

```bash
pnpm install
pnpm test
pnpm demo
```

To inspect a live repo with the dashboard:

```bash
pnpm dashboard -- --repo /abs/path/to/target/repo --host 0.0.0.0 --port 3000
```

Before registering agents against a target repo, start the dashboard or MCP
server once so DeltaPilot creates `<repo>/.deltapilot-data.db` and applies
migrations.

From the DeltaPilot repo root, the supported operator flow is:

```bash
pnpm agent:register -- --name codex-executor --kind codex --repo /abs/path/to/target/repo
```

`--role` defaults to `executor`. Use `planner` or `reviewer` when needed.

If you need to bypass the package-manager wrapper, the direct script form still
works:

```bash
node scripts/register-agent.mjs --name codex-executor --kind codex --repo /abs/path/to/target/repo
```

For Docker-based deployment:

```bash
pnpm docker:build
```

## Architecture

Core constraints:

- **Handoff is artifact-based**, not conversation-based. Agents share files (task brief, git diff, scratchpad, next-steps), not LLM memory.
- **Each task runs in its own git worktree** under `.deltapilot/workspaces/<task_id>/`.
- **Atomic task claim** via SQLite `UPDATE ... RETURNING` inside `BEGIN IMMEDIATE`.
- **Transport is not the data model** — `AgentAdapter` interface with MCP and HTTP implementations.

## Ops

- Dashboard guide: [`docs/dashboard.md`](docs/dashboard.md)
- Docker guide: [`docs/docker.md`](docs/docker.md)
- Agent integration / MCP wiring: [`docs/agent-integration.md`](docs/agent-integration.md)

## License

MIT
