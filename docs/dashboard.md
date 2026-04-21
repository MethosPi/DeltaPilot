# Dashboard

DeltaPilot's dashboard is a lightweight HTTP server that reads the same SQLite
database as the MCP server and exposes:

- a Kanban-style board by task status
- task detail with events, artifacts, and handoffs
- agent activity and recent handoffs
- manual task creation and review actions (`ready`, `approve`, `bounce`, `cancel`)

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
- The dashboard has no multi-user model. Anyone who can reach it and authenticate can create/cancel/approve tasks.
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
