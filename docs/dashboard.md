# Dashboard

DeltaPilot's dashboard is a lightweight HTTP server that reads the same SQLite
database as the MCP server and exposes:

- a Kanban-style board by task status
- task detail with events, artifacts, and handoffs
- agent activity and recent handoffs
- manual task creation and review actions (`ready`, `Approve For Human Review`, `bounce`, `cancel`)

The active delivery path is:

```text
todo -> planning -> in_progress -> review -> human_review -> merging -> done
```

`done` means the task branch has been merged into `main`.

## Start it

Build and run from the monorepo root:

```bash
pnpm dashboard -- --repo /abs/path/to/target/repo --host 0.0.0.0 --port 3000
```

Or build once and run the bundled binary directly:

```bash
pnpm --filter @deltapilot/dashboard build
node apps/dashboard/dist/cli.js --repo /abs/path/to/target/repo --host 0.0.0.0 --port 3000
```

The dashboard uses the same default DB path as the MCP server:

```text
<repo>/.deltapilot-data.db
```

Override it with:

```bash
node apps/dashboard/dist/cli.js --repo /abs/path/to/repo --db /abs/path/to/custom.db
```

## GitHub PR Human Review

Reviewer approval in the dashboard does not mark a task as done anymore.
Instead DeltaPilot:

- preserves the task worktree so a human can test the exact branch locally
- pushes the task branch to `origin`
- creates or refreshes a GitHub PR targeting `main`
- writes an English `human_review_packet` artifact with the PR URL, branch, head SHA, diff summary, reviewer note, worktree path, and local test instructions
- moves the task to `human_review`

The task detail page shows the PR metadata plus the human-review packet so the
human reviewer can:

- open the PR and inspect the exact changes
- approve the PR in GitHub when the change is acceptable
- test the preserved local worktree directly, or fetch the branch from `origin`

The packet always includes explicit local instructions such as:

```text
cd <worktree_path>
Run: <acceptance.success_test>
```

or, when no local worktree is available:

```text
git fetch origin <branch>
git switch --track origin/<branch>
```

Prerequisites for this flow:

- the repo has an `origin` remote hosted on GitHub
- `gh` is installed and authenticated where the dashboard or managed runner executes
- the target base branch is `main`

## Managed Merger

GitHub PR approval is the human approval gate. After the PR is approved, a
managed `merger` agent promotes the task into `merging`, rebases onto
`origin/main`, and merges the PR.

If the rebase conflicts, approval is dismissed after the rebase, or GitHub
blocks the merge, DeltaPilot sends the task back to `human_review` and writes
an English `merge_report` artifact explaining what blocked the merge.

## Auth

The dashboard supports optional HTTP Basic Auth:

```bash
node apps/dashboard/dist/cli.js \
  --repo /abs/path/to/repo \
  --host 0.0.0.0 \
  --port 3000 \
  --username admin \
  --password 'choose-a-long-random-secret'
```

Equivalent environment variables:

```bash
export DP_DASHBOARD_USERNAME=admin
export DP_DASHBOARD_PASSWORD='choose-a-long-random-secret'
```

## EC2 Notes

- Listen on `0.0.0.0` so the instance can accept traffic from outside the host.
- Put the dashboard behind a reverse proxy or load balancer with TLS.
- Restrict the EC2 security group; do not expose the raw port publicly unless you intend to.
- The dashboard has no multi-user model. Anyone who can reach it and authenticate can create/cancel/review tasks.
- MCP and dashboard can safely point at the same repo and DB file.

## Health Check

The server exposes:

```text
GET /api/health
```

which returns:

```json
{ "ok": true }
```
