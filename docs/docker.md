# Docker

DeltaPilot now ships with a single Docker image that can run either:

- the dashboard HTTP server
- the MCP stdio server
- the local demo script

## Build

From the repo root:

```bash
pnpm docker:build
```

Equivalent:

```bash
docker build -t deltapilot:local .
```

## Dashboard

Run the dashboard against a mounted target repo:

```bash
docker run --rm \
  -p 3000:3000 \
  -e DP_DASHBOARD_USERNAME=admin \
  -e DP_DASHBOARD_PASSWORD='choose-a-long-random-secret' \
  -v /srv/deltapilot/repo:/workspace/repo \
  deltapilot:local \
  dashboard --repo /workspace/repo --host 0.0.0.0 --port 3000
```

## MCP

The MCP server is a stdio process. It is not exposed over HTTP. Run it only
when another process will speak MCP over stdin/stdout:

```bash
docker run --rm -i \
  -v /srv/deltapilot/repo:/workspace/repo \
  deltapilot:local \
  mcp --repo /workspace/repo --agent-id <agent-uuid>
```

Typical deployment model:

- dashboard runs as a long-lived container on EC2
- agents run on the same EC2 and spawn the MCP process directly, or start the
  MCP container interactively when needed

## Compose

An example stack is in [docker-compose.yml](/Users/davidepizzo/DeltaPilot/docker-compose.yml:1).

The `dashboard` service is the normal long-running service.

The `mcp` service is behind the `mcp` profile because it is not a network
daemon.

## EC2 Notes

- Mount a real git repository into the container. DeltaPilot needs `.git`,
  branches, and worktrees.
- Persist the mounted repo on EBS, not inside the container filesystem.
- Put the dashboard behind HTTPS with Nginx, Caddy, or an ALB.
- Keep dashboard auth enabled if the port is reachable from outside your VPC.
