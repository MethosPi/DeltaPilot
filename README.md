# DeltaPilot

**AI Agent Orchestrator — "Jira for AI Agents"**

DeltaPilot coordinates terminal-capable AI coding agents (Claude Code, Codex, OpenDevin, Hermes). It tracks tasks on a Kanban board (Init → To Do → In Progress → Review → Done) and — critically — hands off in-flight work when an agent hits a rate limit or crashes, so tasks never get stuck half-finished.

> Status: pre-alpha. Walking-skeleton handoff is the first milestone.

## Quickstart

```bash
pnpm install
pnpm test
```

## Architecture

See [`docs/architecture.md`](docs/architecture.md) once it lands. Core constraints:

- **Handoff is artifact-based**, not conversation-based. Agents share files (task brief, git diff, scratchpad, next-steps), not LLM memory.
- **Each task runs in its own git worktree** under `.deltapilot/workspaces/<task_id>/`.
- **Atomic task claim** via SQLite `UPDATE ... RETURNING` inside `BEGIN IMMEDIATE`.
- **Transport is not the data model** — `AgentAdapter` interface with MCP and HTTP implementations.

## License

MIT
