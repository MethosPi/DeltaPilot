#!/usr/bin/env sh
set -eu

mode="${1:-dashboard}"

case "$mode" in
  dashboard)
    shift
    exec node /app/apps/dashboard/dist/cli.js "$@"
    ;;
  mcp)
    shift
    exec node /app/packages/mcp-server/dist/cli.js "$@"
    ;;
  demo)
    shift
    exec node /app/scripts/demo.ts "$@"
    ;;
  sh|bash)
    exec "$@"
    ;;
  *)
    exec "$@"
    ;;
esac
