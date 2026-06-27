#!/usr/bin/env bash
#
# Local development for aliad (a Cloudflare Workers app).
#
# This is a *Workers* app, so the frontend and the API are served by the SAME
# process: `wrangler dev` serves the built `dist/` (via the ASSETS binding) AND
# the /api/* routes (lookup, closure, anthropic, fetch-page). Plain `vite`
# (port 5173) serves the frontend but has NO /api/*, so lookups don't work there.
#
# This script ties the pieces together so you only run one command:
#   1. applies the local D1 migrations (idempotent — a no-op after the first run)
#   2. builds the frontend once in DEV mode (includes the dev-probe + example btn)
#   3. rebuilds automatically on every frontend change (vite --watch)
#   4. runs the Worker dev server
#
# Open  http://localhost:8787   (NOT 5173 — the API only exists on 8787).
# After a frontend change just refresh the browser; the rebuild is automatic.
# Stop everything with Ctrl-C.
#
# Usage:  npm run dev      (aliases: npm run dev:local, or: bash scripts/dev.sh)

set -euo pipefail
cd "$(dirname "$0")/.."

echo "→ Applying local D1 migrations (idempotent)…"
npx wrangler d1 migrations apply aliad-graph --local

echo "→ Initial dev build…"
npx vite build --mode development

echo "→ Watching frontend for changes…"
npx vite build --mode development --watch &
VITE_PID=$!

# Kill the background watcher whenever this script exits (e.g. Ctrl-C).
trap 'kill "$VITE_PID" 2>/dev/null || true' EXIT

echo "→ Starting Worker dev server on http://localhost:8787 …"
npx wrangler dev
