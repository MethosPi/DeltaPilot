# DeltaPilot

**AI Agent Orchestrator — "Jira for AI Agents"**

DeltaPilot coordinates terminal-capable AI coding agents (Claude Code, Codex, OpenDevin, Hermes). It tracks tasks on a Kanban board (`todo -> planning -> in_progress -> review -> human_review -> merging -> done`) and — critically — hands off in-flight work when an agent hits a rate limit or crashes, so tasks never get stuck half-finished.

The current happy path is `todo -> planning -> in_progress -> review -> human_review -> merging -> done`.
Reviewer approval no longer finishes a task directly: it publishes or refreshes a GitHub PR to `main`, generates an English human-review packet with local test instructions, and waits for GitHub PR approval before a managed merger agent rebases and merges. `done` now means the task has been merged into `main`.

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

GitHub PR review/merge assumptions:

- The target repo must have `origin` pointing at GitHub.
- `gh` must be authenticated on the machine that runs the managed reviewer/merger flow.
- The default base branch is `main`.

## License

MIT
